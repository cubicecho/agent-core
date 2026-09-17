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
        since: expect.any(Number),
        models: {
          big: {
            reasoningEffort: true,
            legacyTokenLimit: false,
            chosenTemperature: true,
            refusedEfforts: [],
            refusedFields: ["min_p"],
            structuredOutput: true,
            assistantPrefill: true,
            thinkingHints: true,
          },
          small: {
            reasoningEffort: true,
            legacyTokenLimit: true,
            chosenTemperature: true,
            refusedEfforts: [],
            refusedFields: [],
            structuredOutput: true,
            assistantPrefill: true,
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

  it("carries which efforts a model refused, and the list it published", () => {
    // Otherwise every restart spends a request per rung walking the same ladder, which is the
    // whole reason the snapshot exists.
    const supports = capabilitiesFor(config.baseUrl, config.apiKey);
    const refused = modelCapabilitiesFor(supports, "big");
    refused.refusedEfforts.add("none");
    refused.supportedEfforts = ["minimal", "low", "medium", "high"];
    const stored = JSON.parse(JSON.stringify(exportCapabilities()));
    resetAll();
    expect(importCapabilities(stored)).toBe(true);
    const back = modelCapabilitiesFor(capabilitiesFor(config.baseUrl, config.apiKey), "big");
    expect([...back.refusedEfforts]).toEqual(["none"]);
    expect(back.supportedEfforts).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("carries a model's refusal of a trailing assistant message", () => {
    const supports = capabilitiesFor(config.baseUrl, config.apiKey);
    modelCapabilitiesFor(supports, "big").assistantPrefill = false;
    const stored = JSON.parse(JSON.stringify(exportCapabilities()));
    expect(stored.endpoints[endpointId(config)].models.big.assistantPrefill).toBe(false);
    resetAll();
    expect(importCapabilities(stored)).toBe(true);
    const restored = capabilitiesFor(config.baseUrl, config.apiKey);
    expect(modelCapabilitiesFor(restored, "big").assistantPrefill).toBe(false);
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

  it("keeps the older age, so importing never makes a latch young again", () => {
    // Otherwise a consumer that stores a snapshot and reads it back on every boot has an entry
    // that is permanently minutes old, and `expireCapabilities` never reaches it.
    const supports = capabilitiesFor(config.baseUrl, config.apiKey);
    supports.strictSchemas = false;
    const stored = JSON.parse(JSON.stringify(exportCapabilities()));
    const id = endpointId(config);
    expect(stored.endpoints[id].since).toBe(supports.since);

    resetAll();
    expect(importCapabilities(stored)).toBe(true);
    expect(capabilitiesFor(config.baseUrl, config.apiKey).since).toBe(stored.endpoints[id].since);

    // And a second import of a newer snapshot of the same endpoint does not undo that.
    const fresh = {
      ...stored,
      endpoints: { [id]: { ...stored.endpoints[id], since: Date.now() } },
    };
    expect(importCapabilities(fresh)).toBe(true);
    expect(capabilitiesFor(config.baseUrl, config.apiKey).since).toBe(stored.endpoints[id].since);
  });

  it("treats a snapshot from before ages were written as met now", () => {
    const id = endpointId(config);
    const at = Date.now();
    expect(
      importCapabilities({
        version: CAPABILITY_SNAPSHOT_VERSION,
        savedAt: new Date().toISOString(),
        endpoints: { [id]: { strictSchemas: false, usageInStream: true, models: {} } },
      }),
    ).toBe(true);
    const restored = capabilitiesFor(config.baseUrl, config.apiKey);
    expect(restored.strictSchemas).toBe(false);
    expect(restored.since).toBeGreaterThanOrEqual(at);
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
