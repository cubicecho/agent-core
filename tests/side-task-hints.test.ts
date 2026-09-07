import OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("../src/client.ts", () => ({
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { ask, resetHints } = await import("../src/side-task.ts");

const reply = { choices: [{ message: { content: "ok" } }] };
const endpoint = (baseUrl: string) => ({ baseUrl, apiKey: "", requestTimeoutSeconds: 60 });
const call = (config: ReturnType<typeof endpoint>, model = "m") =>
  ask(config, model, "system", "user");
/** Whether the hints rode along on the nth call. */
const sentHints = (nth: number) => "reasoning_effort" in create.mock.calls[nth][0];

const apiError = (status: number) =>
  new OpenAI.APIError(status, { error: {} }, "rejected", undefined);

describe("no-thinking hints", () => {
  // The latch outlives a test as surely as the mock does. Without this the suite only passed
  // because every test had been handed a hostname of its own.
  beforeEach(() => {
    create.mockReset();
    resetHints();
  });

  it("stops offering them to a server that answered 4xx", async () => {
    create.mockRejectedValueOnce(apiError(400)).mockResolvedValue(reply);
    await call(endpoint("http://picky/v1"));
    expect(sentHints(0)).toBe(true);
    expect(sentHints(1)).toBe(false);

    await call(endpoint("http://picky/v1"));
    expect(create).toHaveBeenCalledTimes(3);
    expect(sentHints(2)).toBe(false);
  });

  it("keeps offering them after a failure that says nothing about the request", async () => {
    // A timeout, an aborted call or a 500 is the server failing to answer, not refusing the
    // fields — latching on one of those cost every later side task its whole budget.
    create.mockRejectedValueOnce(apiError(503));
    await expect(call(endpoint("http://flaky/v1"))).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);

    create.mockResolvedValue(reply);
    await call(endpoint("http://flaky/v1"));
    expect(sentHints(1)).toBe(true);
  });

  it("keeps one endpoint's refusal off another's calls", async () => {
    create.mockRejectedValueOnce(apiError(422)).mockResolvedValue(reply);
    await call(endpoint("http://local/v1"));

    await call(endpoint("http://cloud/v1"));
    expect(sentHints(2)).toBe(true);
  });

  it("keeps one model's refusal off another model on the same host", async () => {
    // One base URL is routinely many models — a router, or vLLM serving several. Whether the
    // hints are understood belongs to the model, not to the route.
    create.mockRejectedValueOnce(apiError(400)).mockResolvedValue(reply);
    await call(endpoint("http://router/v1"), "picky-model");
    expect(sentHints(1)).toBe(false);

    await call(endpoint("http://router/v1"), "other-model");
    expect(sentHints(2)).toBe(true);
  });

  it("does not latch on a rate limit, or answer one by sending it again", async () => {
    // 429 is a 4xx that says nothing about the fields, and `isTransient` accepts it. Retrying
    // it here doubled the request rate against a server that had just asked for less.
    create.mockRejectedValueOnce(apiError(429));
    await expect(call(endpoint("http://busy/v1"))).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);

    create.mockResolvedValue(reply);
    await call(endpoint("http://busy/v1"));
    expect(sentHints(1)).toBe(true);
  });

  it("does not latch on a bad key or a missing model", async () => {
    for (const status of [401, 404]) {
      resetHints();
      create.mockReset();
      create.mockRejectedValueOnce(apiError(status));
      await expect(call(endpoint("http://auth/v1"))).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it("does not return a scratchpad that ran out of budget as the answer", async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: "<think>weighing it up and then the budget ran" } }],
    });
    expect(await call(endpoint("http://reasoner/v1"))).toBe("");
  });

  it("falls back to reasoning_content when the content is all scratchpad", async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: "", reasoning_content: "deliberation — the answer" } }],
    });
    expect(await call(endpoint("http://split/v1"))).toBe("deliberation — the answer");
  });
});
