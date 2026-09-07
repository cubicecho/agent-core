import OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("../src/client.ts", () => ({
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { ask } = await import("../src/side-task.ts");

const reply = { choices: [{ message: { content: "ok" } }] };
const endpoint = (baseUrl: string) => ({ baseUrl, apiKey: "", requestTimeoutSeconds: 60 });
const call = (config: ReturnType<typeof endpoint>) => ask(config, "m", "system", "user");
/** Whether the hints rode along on the nth call. */
const sentHints = (nth: number) => "reasoning_effort" in create.mock.calls[nth][0];

const apiError = (status: number) =>
  new OpenAI.APIError(status, { error: {} }, "rejected", undefined);

describe("no-thinking hints", () => {
  beforeEach(() => create.mockReset());

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
});
