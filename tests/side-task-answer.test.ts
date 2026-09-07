import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("../src/client.ts", () => ({
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { ask } = await import("../src/side-task.ts");

const endpoint = { baseUrl: "http://local/v1", apiKey: "", requestTimeoutSeconds: 60 };
/** What the caller gets back when the model replies with this content. */
const answerTo = (content: string) => {
  create.mockResolvedValue({ choices: [{ message: { content } }] });
  return ask(endpoint, "m", "system", "user");
};

describe("the scratchpad a reasoning model fences off", () => {
  beforeEach(() => create.mockReset());

  it("drops a fence that closes", async () => {
    expect(await answerTo("<think>weighing it up</think>Real Answer")).toBe("Real Answer");
  });

  it("drops a fence that never closes", async () => {
    // Cut off mid-deliberation by `max_tokens`, so there is no answer to find.
    expect(await answerTo("<think>weighing it up and running out of")).toBe("");
  });

  it("drops a fence that never opens", async () => {
    // The opening tag was put at the end of the prompt by the chat template rather than written
    // by the model, so only the close comes back. This used to return the whole deliberation as
    // the answer, and a session title or a suggestion list was made out of it.
    expect(await answerTo("weighing it up</think>Real Answer")).toBe("Real Answer");
  });

  it("leaves an answer that has no fence in it alone", async () => {
    expect(await answerTo("Real Answer")).toBe("Real Answer");
  });

  it("keeps what sits either side of a fence in the middle", async () => {
    // The close here is the one its own open paired off with, not an orphan, so the rule for
    // the never-opened fence must not reach back and eat `before`.
    expect(await answerTo("before<think>weighing it up</think>after")).toBe("beforeafter");
  });
});
