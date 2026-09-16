import type OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("../src/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client.ts")>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { ask, askJson } = await import("../src/side-task.ts");
const { resetAll } = await import("../src/reset.ts");

const config = { baseUrl: "http://box/v1", apiKey: "", requestTimeoutSeconds: 60 };
const answer = (content: string) => ({ choices: [{ message: { content } }] });
const body = (nth: number) => create.mock.calls[nth][0] as Record<string, unknown>;
const userMessage = (nth: number) => (body(nth).messages as OpenAI.ChatCompletionMessageParam[])[1];

const page: OpenAI.ChatCompletionContentPart[] = [
  { type: "text", text: "Transcribe this page." },
  { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
];

afterEach(() => {
  create.mockReset();
  resetAll();
});

describe("a side task shown an image", () => {
  it("hands the content parts to the SDK as given", async () => {
    create.mockResolvedValue(answer("INVOICE 41"));
    const reply = await ask(config, "m", "You are an OCR engine.", page);

    expect(reply).toBe("INVOICE 41");
    // Unchanged, not re-wrapped: nothing in side-task reads the parts, and a part it rebuilt
    // would be a part it could get wrong for a server whose spelling differs.
    expect(userMessage(0)).toEqual({ role: "user", content: page });
  });

  it("still sends a string as a string", async () => {
    create.mockResolvedValue(answer("ok"));
    await ask(config, "m", "s", "plain text");
    expect(userMessage(0)).toEqual({ role: "user", content: "plain text" });
  });

  it("carries the parts through askJson alongside the schema", async () => {
    create.mockResolvedValue(answer('{"text": "INVOICE 41"}'));
    const schema = {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    };
    const reply = await askJson<{ text: string }>(config, "m", "Transcribe.", page, schema, {
      name: "page",
    });

    expect(reply).toEqual({ text: "INVOICE 41" });
    expect(userMessage(0)).toEqual({ role: "user", content: page });
    // The schema still rides on the system prompt, which is where a refusal of `response_format`
    // leaves it — an image changes the user turn and nothing else about the request.
    expect(body(0).response_format).toMatchObject({ type: "json_schema" });
  });
});
