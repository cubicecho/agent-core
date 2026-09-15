import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("../src/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client.ts")>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { capabilitiesFor, modelCapabilitiesFor } = await import("../src/capabilities.ts");
const { endpointId } = await import("../src/client.ts");
const { resetAll } = await import("../src/reset.ts");
const { ask } = await import("../src/side-task.ts");
const { CAPABILITY_SNAPSHOT_VERSION, exportCapabilities, importCapabilities } = await import(
  "../src/snapshot.ts"
);

const config = { baseUrl: "http://box/v1", apiKey: "sk-secret", requestTimeoutSeconds: 60 };
const reply = { choices: [{ message: { content: "ok" } }] };
const refuseHints = new OpenAI.APIError(400, { error: { message: "no" } }, "no", undefined);

afterEach(() => {
  create.mockReset();
  resetAll();
});

describe("capability snapshots", () => {
  it("holds nothing for a process that met no refusals", () => {
    capabilitiesFor(config.baseUrl, config.apiKey);
    const snapshot = exportCapabilities();
    expect(snapshot.version).toBe(CAPABILITY_SNAPSHOT_VERSION);
    expect(Number.isNaN(Date.parse(snapshot.savedAt))).toBe(false);
    expect(snapshot.endpoints).toEqual({});
  });

  it("carries every latch across a restart, without the key", async () => {
    const supports = capabilitiesFor(config.baseUrl, config.apiKey);
    supports.strictSchemas = false;
    const model = modelCapabilitiesFor(supports, "big");
    model.legacyTokenLimit = false;
    model.refusedFields.add("min_p");
    create.mockRejectedValueOnce(refuseHints).mockResolvedValue(reply);
    await ask(config, "small", "system", "user");

    const stored = JSON.stringify(exportCapabilities());
    expect(stored).not.toContain("sk-secret");
    expect(stored).not.toContain("http://box");
    expect(JSON.parse(stored).endpoints).toEqual({
      [endpointId(config)]: {
        strictSchemas: false,
        usageInStream: true,
        models: {
          big: {
            reasoningEffort: true,
            legacyTokenLimit: false,
            chosenTemperature: true,
            refusedFields: ["min_p"],
            structuredOutput: true,
            thinkingHints: true,
          },
          small: {
            reasoningEffort: true,
            legacyTokenLimit: true,
            chosenTemperature: true,
            refusedFields: [],
            structuredOutput: true,
            thinkingHints: false,
          },
        },
      },
    });

    resetAll();
    create.mockReset();
    expect(importCapabilities(JSON.parse(stored))).toBe(true);
    const restored = capabilitiesFor(config.baseUrl, config.apiKey);
    expect(restored.strictSchemas).toBe(false);
    expect(modelCapabilitiesFor(restored, "big")).toMatchObject({ legacyTokenLimit: false });
    expect([...modelCapabilitiesFor(restored, "big").refusedFields]).toEqual(["min_p"]);
    create.mockResolvedValue(reply);
    await ask(config, "small", "system", "user");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).not.toHaveProperty("chat_template_kwargs");
  });

  it("only latches off, whatever the snapshot says", () => {
    const supports = capabilitiesFor(config.baseUrl, config.apiKey);
    supports.usageInStream = false;
    const id = endpointId(config);
    importCapabilities({
      version: CAPABILITY_SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      endpoints: { [id]: { strictSchemas: true, usageInStream: true, models: {} } },
    });
    expect(supports.usageInStream).toBe(false);
    expect(capabilitiesFor(config.baseUrl, config.apiKey)).toBe(supports);
  });

  it("ignores another version, and anything that is not a snapshot", () => {
    const id = endpointId(config);
    const endpoints = { [id]: { strictSchemas: false, usageInStream: false, models: {} } };
    expect(importCapabilities({ version: 0, savedAt: "", endpoints })).toBe(false);
    expect(importCapabilities(null)).toBe(false);
    expect(importCapabilities("nope")).toBe(false);
    expect(capabilitiesFor(config.baseUrl, config.apiKey).strictSchemas).toBe(true);
    expect(
      importCapabilities({
        version: CAPABILITY_SNAPSHOT_VERSION,
        endpoints: { [id]: { models: { m: { refusedFields: [1, "top_k"] } } } },
      }),
    ).toBe(true);
    const model = modelCapabilitiesFor(capabilitiesFor(config.baseUrl, config.apiKey), "m");
    expect([...model.refusedFields]).toEqual(["top_k"]);
    expect(model.reasoningEffort).toBe(true);
  });
});
