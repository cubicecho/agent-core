import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilitiesFor, modelCapabilitiesFor, resetCapabilities } from "../src/capabilities.ts";
import { ContextOverflow } from "../src/retry.ts";
import { runTurn } from "../src/run-turn.ts";

type Chunk = OpenAI.ChatCompletionChunk;
/** Hand-written chunks carry only the fields under test; the SDK's Choice wants more. */
const chunk = (partial: unknown) => partial as Chunk;
const text = (content: string): Chunk => chunk({ choices: [{ delta: { content } }] });
const chunks = (...list: Chunk[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* list;
  },
});

const clientOf = (create: (body: unknown, options: { signal: AbortSignal }) => unknown) =>
  ({ chat: { completions: { create } } }) as unknown as OpenAI;
/** The SDK builds the message from the body, not from its own `message` argument. */
const apiError = (status: number, message: string) =>
  new OpenAI.APIError(status, { error: { message } }, undefined, undefined);
/** Lost rather than refused: nothing about the request, and the only thing worth waiting out. */
const lost = () => new OpenAI.APIConnectionError({ message: "socket hang up" });

const body = (supports: { usageInStream: boolean }) =>
  ({
    model: "m",
    messages: [],
    stream: true,
    ...(supports.usageInStream ? { stream_options: { include_usage: true } } : {}),
  }) as OpenAI.ChatCompletionCreateParamsStreaming;

/** Runs everything the backoff sleeps through, however many attempts it takes. */
const runOutTheClock = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(8000);
};

afterEach(() => {
  vi.useRealTimers();
  resetCapabilities();
});

describe("runTurn", () => {
  const supports = () => capabilitiesFor("http://local/v1");

  it("hands back the turn the endpoint answered", async () => {
    const notices: string[] = [];
    const create = vi.fn(() => chunks(text("hel"), text("lo")));
    const turn = await runTurn(clientOf(create), supports(), body, {
      onNotice: (n) => notices.push(n),
    });
    expect(turn.content).toBe("hello");
    expect(create).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it("sends the same request again when it was lost, and says so", async () => {
    vi.useFakeTimers();
    const notices: string[] = [];
    const create = vi
      .fn()
      .mockRejectedValueOnce(lost())
      .mockReturnValue(chunks(text("second")));
    const turn = runTurn(clientOf(create), supports(), body, {
      maxRetries: 2,
      onNotice: (n) => notices.push(n),
    });
    await runOutTheClock();
    await expect(turn).resolves.toMatchObject({ content: "second" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(notices).toEqual([expect.stringContaining("socket hang up")]);
    expect(notices[0]).toContain("(1/2)");
  });

  it("gives up when the budget is spent", async () => {
    vi.useFakeTimers();
    const create = vi.fn().mockRejectedValue(lost());
    const turn = runTurn(clientOf(create), supports(), body, { maxRetries: 2 });
    const settled = expect(turn).rejects.toThrow("socket hang up");
    await runOutTheClock();
    await settled;
    // Three attempts for a budget of two: the first send is not a retry.
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("does not send a refusal again", async () => {
    // A 400 for something the negotiation cannot answer fails the same way every time, and
    // waiting out a server that read the request and disliked it is a wasted round trip.
    const create = vi.fn().mockRejectedValue(apiError(400, "unknown model"));
    await expect(runTurn(clientOf(create), supports(), body, { maxRetries: 3 })).rejects.toThrow(
      "unknown model",
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not send a turn again once the tokens are out", async () => {
    // The rule both layers are bounded by. A watcher has already seen "half an ", and a second
    // attempt would say it again — so a failure after the first chunk is the run's failure.
    const seen: string[] = [];
    const create = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield text("half an ");
        throw lost();
      },
    }));
    await expect(
      runTurn(clientOf(create), supports(), body, {
        maxRetries: 3,
        onOutput: (delta) => seen.push(delta),
      }),
    ).rejects.toThrow("socket hang up");
    expect(create).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["half an "]);
  });

  it("does not bring back a run whose operator stopped it", async () => {
    // The trap this loop is easiest to get wrong at. A stop can land while a request is failing
    // for the endpoint's own reasons, and a 503 is transient — so classifying before reading the
    // signal spends a backoff and sends a stopped run's request a second time.
    vi.useFakeTimers();
    const notices: string[] = [];
    const stop = new AbortController();
    const create = vi.fn().mockImplementation(() => {
      stop.abort(new Error("stopped by the operator"));
      return Promise.reject(apiError(503, "service unavailable"));
    });
    const turn = runTurn(clientOf(create), supports(), body, {
      maxRetries: 3,
      signal: stop.signal,
      onNotice: (n) => notices.push(n),
    });
    const settled = expect(turn).rejects.toThrow("service unavailable");
    await runOutTheClock();
    await settled;
    expect(create).toHaveBeenCalledTimes(1);
    // Not even announced: nobody is waiting for this run to come back.
    expect(notices).toEqual([]);
  });

  it("answers a refused capability without spending an attempt", async () => {
    // A downgrade is a different request, not the same one again, so it is not the retry
    // budget's business. With no budget at all this still has to converge.
    const notices: string[] = [];
    const create = vi
      .fn()
      .mockRejectedValueOnce(apiError(400, "unknown field: stream_options"))
      .mockReturnValue(chunks(text("counted nothing")));
    const known = supports();
    const turn = await runTurn(clientOf(create), known, body, {
      maxRetries: 0,
      onNotice: (n) => notices.push(n),
    });
    expect(turn.content).toBe("counted nothing");
    expect(create).toHaveBeenCalledTimes(2);
    expect(known.usageInStream).toBe(false);
    expect(notices).toEqual([expect.stringContaining("stream_options")]);
  });

  it("rebuilds the request from what the last attempt gave up on", async () => {
    // Why `request` is a callback: the second send is not the first send again.
    const create = vi
      .fn()
      .mockRejectedValueOnce(apiError(400, "unknown field: stream_options"))
      .mockReturnValue(chunks(text("ok")));
    await runTurn(clientOf(create), supports(), body);
    expect(create.mock.calls[0][0]).toHaveProperty("stream_options");
    expect(create.mock.calls[1][0]).not.toHaveProperty("stream_options");
  });

  it("rebuilds the request from what the model gave up on, not only the endpoint", async () => {
    // The refusal is about the model rather than the server, so the answer has to be per model
    // — and `request` has to see it, since the body it builds is what changes.
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        apiError(
          400,
          "Unsupported parameter: 'max_tokens' is not supported with this model. " +
            "Use 'max_completion_tokens' instead.",
        ),
      )
      .mockReturnValue(chunks(text("ok")));
    const known = supports();
    const turn = await runTurn(
      clientOf(create),
      known,
      (_supports, model) =>
        ({
          model: "gpt-5",
          messages: [],
          stream: true,
          ...(model?.legacyTokenLimit ? { max_tokens: 256 } : { max_completion_tokens: 256 }),
        }) as OpenAI.ChatCompletionCreateParamsStreaming,
      { model: "gpt-5" },
    );

    expect(turn.content).toBe("ok");
    expect(create.mock.calls[0][0]).toHaveProperty("max_tokens");
    expect(create.mock.calls[1][0]).toHaveProperty("max_completion_tokens");
    expect(modelCapabilitiesFor(known, "gpt-5").legacyTokenLimit).toBe(false);
  });

  it("waits out a lost request that arrives in the middle of a negotiation", async () => {
    vi.useFakeTimers();
    const create = vi
      .fn()
      .mockRejectedValueOnce(apiError(400, "unknown field: stream_options"))
      .mockRejectedValueOnce(lost())
      .mockReturnValue(chunks(text("at last")));
    const known = supports();
    const turn = runTurn(clientOf(create), known, body, { maxRetries: 1 });
    await runOutTheClock();
    await expect(turn).resolves.toMatchObject({ content: "at last" });
    // The downgrade is still latched on the attempt that came after it.
    expect(known.usageInStream).toBe(false);
    expect(create.mock.calls[2][0]).not.toHaveProperty("stream_options");
  });
});

describe("contextLimit", () => {
  const supports = () => capabilitiesFor("http://local/v1");
  /** A body whose transcript is comfortably over any limit worth setting. */
  const big = () =>
    ({
      model: "m",
      messages: [{ role: "user", content: "x".repeat(200_000) }],
      stream: true,
    }) as OpenAI.ChatCompletionCreateParamsStreaming;

  it("refuses a request too big for the window before it is sent", async () => {
    const create = vi.fn();
    await expect(
      runTurn(clientOf(create), supports(), big, { contextLimit: 8192 }),
    ).rejects.toThrow(ContextOverflow);
    // The point of the guard: not one round trip was spent finding this out.
    expect(create).not.toHaveBeenCalled();
  });

  it("does not spend a retry on a request that will never fit", async () => {
    const create = vi.fn();
    await expect(
      runTurn(clientOf(create), supports(), big, { contextLimit: 8192, maxRetries: 3 }),
    ).rejects.toThrow(ContextOverflow);
    expect(create).not.toHaveBeenCalled();
  });

  it("sends a request that fits", async () => {
    const create = vi.fn().mockReturnValue(chunks(text("ok")));
    await expect(
      runTurn(clientOf(create), supports(), body, { contextLimit: 8192 }),
    ).resolves.toMatchObject({ content: "ok" });
  });

  it("sends whatever it is given when no limit was set", async () => {
    const create = vi.fn().mockReturnValue(chunks(text("ok")));
    await expect(runTurn(clientOf(create), supports(), big)).resolves.toMatchObject({
      content: "ok",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not believe a limit no model could have", async () => {
    // A caller threading a placeholder through — an unset column, a listing that said nothing —
    // is not a reason to refuse a run that would have worked.
    const create = vi.fn().mockReturnValue(chunks(text("ok")));
    await expect(
      runTurn(clientOf(create), supports(), big, { contextLimit: 64 }),
    ).resolves.toMatchObject({ content: "ok" });
  });

  it("sizes the body once rather than once per attempt", async () => {
    vi.useFakeTimers();
    const build = vi.fn(body);
    const create = vi
      .fn()
      .mockRejectedValueOnce(lost())
      .mockReturnValue(chunks(text("at last")));
    const turn = runTurn(clientOf(create), supports(), build, {
      contextLimit: 8192,
      maxRetries: 1,
    });
    await runOutTheClock();
    await expect(turn).resolves.toMatchObject({ content: "at last" });
    expect(build).toHaveBeenCalledTimes(2);
  });
});
