import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
const create = vi.fn();
/**
 * The SDK's transport, replaced. Its statics come along because two modules under test
 * classify failures with `instanceof OpenAI.APIError`, and a fake class has no such thing.
 */
vi.mock("openai", async () => {
  const actual = await vi.importActual<typeof import("openai")>("openai");
  class Fake {
    models = { list };
    chat = { completions: { create } };
  }
  return { default: Object.assign(Fake, actual.default) };
});

const OpenAI = (await import("openai")).default;
const { getClient } = await import("../src/client.ts");
const { capabilitiesFor } = await import("../src/capabilities.ts");
const { emit, history } = await import("../src/events.ts");
const { ask } = await import("../src/side-task.ts");
const { resetAll } = await import("../src/reset.ts");

const endpoint = { baseUrl: "http://local/v1", apiKey: "", requestTimeoutSeconds: 60 };
const reply = { choices: [{ message: { content: "ok" } }] };
/** Whether the no-thinking hints rode along on the nth call. */
const sentHints = (nth: number) => "reasoning_effort" in create.mock.calls[nth][0];

/** Teaches the process one latched refusal per module, so there is something to forget. */
const latchEverything = async () => {
  create
    .mockRejectedValueOnce(new OpenAI.APIError(400, { error: {} }, "rejected", undefined))
    .mockResolvedValue(reply);
  await ask(endpoint, "qwen", "system", "user");
  capabilitiesFor(endpoint.baseUrl).usageInStream = false;
  emit("run-a", { kind: "output", text: "one" });
  return getClient(endpoint);
};

describe("resetAll", () => {
  beforeEach(() => {
    create.mockReset();
    list.mockReset();
    resetAll();
  });

  it("forgets the pooled clients", async () => {
    const before = await latchEverything();
    expect(getClient(endpoint)).toBe(before);
    resetAll();
    expect(getClient(endpoint)).not.toBe(before);
  });

  it("forgets what an endpoint was found not to support", async () => {
    await latchEverything();
    expect(capabilitiesFor(endpoint.baseUrl).usageInStream).toBe(false);
    resetAll();
    expect(capabilitiesFor(endpoint.baseUrl).usageInStream).toBe(true);
  });

  it("forgets which models refused the no-thinking hints", async () => {
    await latchEverything();
    // Two calls so far: the one that was refused, and its retry without the hints.
    expect(create).toHaveBeenCalledTimes(2);
    resetAll();
    await ask(endpoint, "qwen", "system", "user");
    // Offered again, because nothing here knows any more that they were ever refused.
    expect(sentHints(2)).toBe(true);
  });

  it("forgets the runs on the bus", async () => {
    await latchEverything();
    expect(history("run-a")).toHaveLength(1);
    resetAll();
    expect(history("run-a")).toEqual([]);
  });
});
