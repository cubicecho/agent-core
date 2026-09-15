import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("../src/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client.ts")>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { askJson } = await import("../src/side-task.ts");
const { capabilitiesFor, modelCapabilitiesFor } = await import("../src/capabilities.ts");
const { resetAll } = await import("../src/reset.ts");

const config = { baseUrl: "http://box/v1", apiKey: "", requestTimeoutSeconds: 60 };
const answer = (content: string) => ({ choices: [{ message: { content } }] });
const refusal = (message: string) =>
  new OpenAI.APIError(400, { error: { message } }, message, undefined);
const schema = {
  type: "object",
  properties: { tools: { type: "array", items: { type: "string", pattern: "^\\w+$" } } },
  required: ["tools"],
  additionalProperties: false,
};
const body = (nth: number) => create.mock.calls[nth][0] as Record<string, unknown>;

afterEach(() => {
  create.mockReset();
  resetAll();
});

describe("askJson", () => {
  it("holds the reply to the schema and parses it", async () => {
    create.mockResolvedValue(answer('{"tools": ["read"]}'));
    const reply = await askJson<{ tools: string[] }>(config, "m", "Pick.", "a request", schema, {
      name: "pick",
    });
    expect(reply).toEqual({ tools: ["read"] });
    expect(body(0).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "pick", strict: true, schema },
    });
    const [system] = body(0).messages as { content: string }[];
    expect(system.content).toContain("Pick.");
    expect(system.content).toContain('"required":["tools"]');
  });

  it("keeps the no-thinking hints", async () => {
    create.mockResolvedValue(answer("{}"));
    await askJson(config, "m", "s", "u", schema);
    expect(body(0)).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
  });

  it("asks in words once the model refuses response_format, and remembers", async () => {
    const notices: string[] = [];
    create
      .mockRejectedValueOnce(refusal("Unrecognized request argument supplied: response_format"))
      .mockResolvedValue(answer('Sure:\n```json\n{"tools": []}\n```'));
    const reply = await askJson(config, "m", "s", "u", schema, {
      onNotice: (text) => notices.push(text),
    });
    expect(reply).toEqual({ tools: [] });
    expect(body(1)).not.toHaveProperty("response_format");
    expect(notices).toEqual(["m does not take response_format; asking for JSON in words instead"]);
    const supports = capabilitiesFor(config.baseUrl, config.apiKey);
    expect(modelCapabilitiesFor(supports, "m").structuredOutput).toBe(false);
    expect(modelCapabilitiesFor(supports, "other").structuredOutput).toBe(true);

    await askJson(config, "m", "s", "u", schema);
    expect(create).toHaveBeenCalledTimes(3);
    expect(body(2)).not.toHaveProperty("response_format");
  });

  it("lets a schema the server found invalid out, rather than latching", async () => {
    create.mockRejectedValue(refusal("Invalid schema for response_format 'answer': bad"));
    await expect(askJson(config, "m", "s", "u", schema)).rejects.toThrow("Invalid schema");
    const supports = capabilitiesFor(config.baseUrl, config.apiKey);
    expect(modelCapabilitiesFor(supports, "m").structuredOutput).toBe(true);
  });

  it("relaxes the schema where the server could not build a grammar", async () => {
    capabilitiesFor(config.baseUrl, config.apiKey).strictSchemas = false;
    create.mockResolvedValue(answer('{"tools": []}'));
    await askJson(config, "m", "s", "u", schema);
    const sent = (body(0).response_format as { json_schema: { schema: unknown } }).json_schema;
    expect(JSON.stringify(sent.schema)).not.toContain("pattern");
  });

  it("normalises the root the way a tool's parameters are", async () => {
    create.mockResolvedValue(answer("no json here"));
    const reply = await askJson(config, "m", "s", "u", { properties: {} });
    expect(reply).toBeUndefined();
    const sent = (body(0).response_format as { json_schema: { schema: unknown } }).json_schema;
    expect(sent.schema).toMatchObject({ type: "object", properties: {} });
  });
});
