import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilitiesFor, modelCapabilitiesFor, resetCapabilities } from "../src/capabilities.ts";
import { continueTurn, isContinuable } from "../src/continuation.ts";
import type { Turn } from "../src/stream.ts";

type Body = OpenAI.ChatCompletionCreateParamsStreaming;

const chunks = (...list: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* list as OpenAI.ChatCompletionChunk[];
  },
});
/** A reply that says this, stops for this reason, and reports these counts and timings. */
const reply = (content: string, finish = "stop", timings?: Record<string, number>) =>
  chunks(
    { choices: [{ delta: { content }, finish_reason: finish }] },
    {
      choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      ...(timings ? { timings } : {}),
    },
  );
const clientOf = (create: (body: Body) => unknown) =>
  ({ chat: { completions: { create } } }) as unknown as OpenAI;
const apiError = (status: number, message: string) =>
  new OpenAI.APIError(status, { error: { message } }, undefined, undefined);

const question: Body = { model: "m", stream: true, messages: [{ role: "user", content: "why" }] };
const request = () => question;

/** A turn the ceiling cut off, with an answer begun. */
const cut = (content = "The sky is blue because", extra: Partial<Turn> = {}): Turn => ({
  content,
  reasoning: "thought",
  toolCalls: [],
  finishReason: "length",
  usage: { prompt: 40, completion: 100, total: 140, cached: 30 },
  ...extra,
});

const supports = () => capabilitiesFor("http://local/v1");

afterEach(() => resetCapabilities());

describe("isContinuable", () => {
  it("takes only an answer begun and cut off, with no call in it", () => {
    expect(isContinuable(cut())).toBe(true);
    expect(isContinuable(cut("done", { finishReason: "stop" }))).toBe(false);
    expect(isContinuable(cut("  "))).toBe(false);
    const call = {
      id: "c",
      type: "function" as const,
      function: { name: "t", arguments: '{"a":' },
    };
    expect(isContinuable(cut("calling", { toolCalls: [call] }))).toBe(false);
  });
});

describe("continueTurn", () => {
  it("sends the answer so far as a prefill and joins what comes back onto it", async () => {
    const create = vi.fn().mockReturnValue(reply(" of the way light scatters.", "stop"));
    const turn = await continueTurn(clientOf(create), supports(), request, cut(), {
      model: "m",
      startInReasoning: true,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0][0] as Body).messages).toEqual([
      ...question.messages,
      { role: "assistant", content: "The sky is blue because" },
    ]);
    // Read as answer even though the fresh reply started in a scratchpad.
    expect(turn.content).toBe("The sky is blue because of the way light scatters.");
    expect(turn.reasoning).toBe("thought");
    expect(turn.finishReason).toBe("stop");
    expect(turn.usage).toMatchObject({
      prompt: 90,
      completion: 110,
      total: 200,
      cached: 30,
      continuations: 1,
    });
  });

  it("drops a field only one request reported, and weights the rates by the time they held", async () => {
    const create = vi
      .fn()
      .mockReturnValue(reply(" more", "stop", { predicted_ms: 3000, predicted_per_second: 40 }));
    const first = cut();
    first.usage = { ...first.usage, predictedMs: 1000, tokensPerSecond: 80, wallMs: 5 };
    const turn = await continueTurn(clientOf(create), supports(), request, first, { model: "m" });
    expect(turn.usage.predictedMs).toBe(4000);
    expect(turn.usage.tokensPerSecond).toBe(50);
    // The continuation's own runTurn measured a wall time too, so that one is summed.
    expect(turn.usage.wallMs).toBeGreaterThanOrEqual(5);
    expect(turn.usage).not.toHaveProperty("promptMs");
  });

  it("leaves a turn it cannot continue as it was, without a request", async () => {
    const create = vi.fn();
    const finished = cut("done", { finishReason: "stop" });
    expect(await continueTurn(clientOf(create), supports(), request, finished)).toBe(finished);
    const empty = cut("");
    expect(await continueTurn(clientOf(create), supports(), request, empty)).toBe(empty);
    expect(
      await continueTurn(clientOf(create), supports(), request, cut(), { maxContinuations: 0 }),
    ).toMatchObject({ finishReason: "length" });
    expect(create).not.toHaveBeenCalled();
  });

  it("stops at the cap on a model that never reaches a stop", async () => {
    const create = vi.fn(() => reply(" and on", "length"));
    const once = await continueTurn(clientOf(create), supports(), request, cut());
    expect(create).toHaveBeenCalledTimes(1);
    expect(once.finishReason).toBe("length");
    create.mockClear();
    const thrice = await continueTurn(clientOf(create), supports(), request, cut(), {
      maxContinuations: 3,
    });
    expect(create).toHaveBeenCalledTimes(3);
    expect(thrice.content).toBe("The sky is blue because and on and on and on");
    expect(thrice.usage.continuations).toBe(3);
  });

  it("latches the prefill off for the model when the endpoint refuses one", async () => {
    const notices: string[] = [];
    const create = vi
      .fn()
      .mockRejectedValue(
        apiError(400, "Assistant response prefill is incompatible with enable_thinking."),
      );
    const turn = await continueTurn(clientOf(create), supports(), request, cut(), {
      model: "m",
      onNotice: (n) => notices.push(n),
    });
    expect(turn.content).toBe("The sky is blue because");
    expect(turn.finishReason).toBe("length");
    expect(modelCapabilitiesFor(supports(), "m").assistantPrefill).toBe(false);
    expect(notices.at(-1)).toContain("refused a trailing assistant message");
    create.mockClear();
    await continueTurn(clientOf(create), supports(), request, cut(), { model: "m" });
    expect(create).not.toHaveBeenCalled();
  });

  it("latches it off when the model answers afresh instead, and keeps the first answer", async () => {
    const notices: string[] = [];
    const create = vi.fn(() => reply("The sky is blue because of Rayleigh scattering."));
    const turn = await continueTurn(clientOf(create), supports(), request, cut(), {
      model: "m",
      onNotice: (n) => notices.push(n),
    });
    expect(turn.content).toBe("The sky is blue because");
    expect(modelCapabilitiesFor(supports(), "m").assistantPrefill).toBe(false);
    expect(notices).toEqual([expect.stringContaining("answered afresh")]);
  });

  it("keeps the cut-off answer when there is no room to continue it", async () => {
    const notices: string[] = [];
    const create = vi
      .fn()
      .mockRejectedValue(apiError(400, "the request exceeds the available context size, tokens"));
    const turn = await continueTurn(clientOf(create), supports(), request, cut(), {
      model: "m",
      onNotice: (n) => notices.push(n),
    });
    expect(turn.content).toBe("The sky is blue because");
    // No room is not a refusal of the prefill, so the next turn may still be continued.
    expect(modelCapabilitiesFor(supports(), "m").assistantPrefill).toBe(true);
    expect(notices).toEqual([expect.stringContaining("no room")]);
  });

  it("throws a stop rather than keeping the answer", async () => {
    const controller = new AbortController();
    const create = vi.fn(() => {
      controller.abort();
      throw new OpenAI.APIUserAbortError();
    });
    await expect(
      continueTurn(clientOf(create), supports(), request, cut(), { signal: controller.signal }),
    ).rejects.toThrow();
  });
});
