import type OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EndpointSilent } from "../src/retry.ts";
import { streamTurn } from "../src/stream.ts";

type Chunk = OpenAI.ChatCompletionChunk;
/** Hand-written chunks carry only the fields under test; the SDK's Choice wants more. */
const chunk = (partial: unknown) => partial as Chunk;

/** A stream that hands over its chunks and ends, the way a request that answered does. */
const chunks = (...list: Chunk[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* list;
  },
});

/**
 * A stream that yields what it has and then stops answering, the way an endpoint that dies
 * mid-turn does: iteration parks forever unless the request's own signal ends it.
 */
const stalls = (signal: AbortSignal, ...list: Chunk[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* list;
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // An aborted stream ends its iteration rather than throwing — the SDK's own behaviour, and
    // the reason `streamTurn` has to check the signal after the loop.
  },
});

const clientOf = (create: (body: unknown, options: { signal: AbortSignal }) => unknown) =>
  ({ chat: { completions: { create } } }) as unknown as OpenAI;
const body = {
  model: "m",
  messages: [],
  stream: true,
} as OpenAI.ChatCompletionCreateParamsStreaming;
const text = (content: string): Chunk => chunk({ choices: [{ delta: { content } }] });

afterEach(() => vi.useRealTimers());

describe("streamTurn", () => {
  it("assembles the answer and reports it as it arrives", async () => {
    const output: string[] = [];
    const turn = await streamTurn(
      clientOf(() => chunks(text("hel"), text("lo"))),
      body,
      {
        onOutput: (delta) => output.push(delta),
      },
    );
    expect(turn.content).toBe("hello");
    expect(output).toEqual(["hel", "lo"]);
  });

  it("reads reasoning under either spelling", async () => {
    const thinking: string[] = [];
    const turn = await streamTurn(
      clientOf(() =>
        chunks(
          chunk({ choices: [{ delta: { reasoning_content: "hmm " } }] }),
          chunk({ choices: [{ delta: { reasoning: "so" } }] }),
          text("answer"),
        ),
      ),
      body,
      { onThinking: (delta) => thinking.push(delta) },
    );
    expect(thinking).toEqual(["hmm ", "so"]);
    // The scratchpad is reported, never assembled into the answer.
    expect(turn.content).toBe("answer");
    // But kept beside it, for the models that want it passed back behind a tool call.
    expect(turn.reasoning).toBe("hmm so");
  });

  it("routes a scratchpad fenced in content to thinking, not to the answer", async () => {
    const thinking: string[] = [];
    const output: string[] = [];
    const turn = await streamTurn(
      clientOf(() => chunks(text("<thi"), text("nk>hmm</th"), text("ink>ans"), text("wer"))),
      body,
      { onThinking: (delta) => thinking.push(delta), onOutput: (delta) => output.push(delta) },
    );
    expect(turn.content).toBe("answer");
    expect(turn.reasoning).toBe("hmm");
    expect(thinking.join("")).toBe("hmm");
    expect(output.join("")).toBe("answer");
  });

  it("keeps a scratchpad cut off at the ceiling out of the answer", async () => {
    const turn = await streamTurn(
      clientOf(() =>
        chunks(
          text("<think>still weighing"),
          chunk({ choices: [{ delta: {}, finish_reason: "length" }] }),
        ),
      ),
      body,
    );
    expect(turn).toMatchObject({
      content: "",
      reasoning: "still weighing",
      finishReason: "length",
    });
  });

  it("starts in the scratchpad when the template opened the fence", async () => {
    const output: string[] = [];
    const turn = await streamTurn(
      clientOf(() => chunks(text("hmm</think>"), text("answer"))),
      body,
      {
        startInReasoning: true,
        onOutput: (delta) => output.push(delta),
      },
    );
    expect(turn).toMatchObject({ content: "answer", reasoning: "hmm" });
    expect(output).toEqual(["answer"]);
  });

  it("reads content as all answer when given no fences", async () => {
    const turn = await streamTurn(
      clientOf(() => chunks(text("<think>x</think>y"))),
      body,
      {
        fences: [],
      },
    );
    expect(turn.content).toBe("<think>x</think>y");
  });

  it("reassembles tool calls arriving in pieces, in index order", async () => {
    const call = (index: number, part: Record<string, unknown>): Chunk =>
      chunk({ choices: [{ delta: { tool_calls: [{ index, ...part }] } }] });
    const turn = await streamTurn(
      clientOf(() =>
        chunks(
          call(1, { id: "b", function: { name: "second" } }),
          call(0, { id: "a", function: { name: "fi" } }),
          call(0, { function: { name: "rst", arguments: '{"x"' } }),
          call(1, { function: { arguments: "{}" } }),
          call(0, { function: { arguments: ":1}" } }),
        ),
      ),
      body,
    );
    expect(turn.toolCalls).toEqual([
      { id: "a", type: "function", function: { name: "first", arguments: '{"x":1}' } },
      { id: "b", type: "function", function: { name: "second", arguments: "{}" } },
    ]);
  });

  it("keeps calls apart on a server that sends no index", async () => {
    // The SDK types `index` as required; a compat layer that leaves it out used to have every
    // call put back together as one, names and arguments run together.
    const part = (fields: Record<string, unknown>): Chunk =>
      chunk({ choices: [{ delta: { tool_calls: [fields] } }] });
    const turn = await streamTurn(
      clientOf(() =>
        chunks(
          part({ id: "a", function: { name: "first" } }),
          part({ function: { arguments: '{"x":' } }),
          part({ function: { arguments: "1}" } }),
          part({ function: { name: "second", arguments: "{}" } }),
          part({ id: "c", function: { name: "third" } }),
          part({ id: "c", function: { arguments: "{}" } }),
        ),
      ),
      body,
    );
    expect(turn.toolCalls.map((call) => [call.function.name, call.function.arguments])).toEqual([
      ["first", '{"x":1}'],
      ["second", "{}"],
      ["third", "{}"],
    ]);
    expect(new Set(turn.toolCalls.map((call) => call.id)).size).toBe(3);
  });

  it("keeps whole calls apart when a server sends every one at index 0", async () => {
    const whole = (fields: Record<string, unknown>): Chunk =>
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, ...fields }] } }] });
    const turn = await streamTurn(
      clientOf(() =>
        chunks(
          whole({ id: "a", function: { name: "first", arguments: "{}" } }),
          whole({ id: "b", function: { name: "second", arguments: "{}" } }),
          whole({ function: { name: "third", arguments: "{}" } }),
        ),
      ),
      body,
    );
    expect(turn.toolCalls.map((call) => call.function.name)).toEqual(["first", "second", "third"]);
    expect(new Set(turn.toolCalls.map((call) => call.id)).size).toBe(3);
  });

  it("mints an id for a server that streams a call without one", async () => {
    const turn = await streamTurn(
      clientOf(() =>
        chunks(
          chunk({ choices: [{ delta: { tool_calls: [{ index: 3, function: { name: "t" } }] } }] }),
        ),
      ),
      body,
    );
    expect(turn.toolCalls[0]?.id).toBe("call_3");
  });

  it("takes the last usage report rather than a sum of them", async () => {
    // A server that reports cumulatively per chunk — which llama.cpp does — makes a sum of sums
    // out of an accumulator. Against `stream_options.include_usage`, which sends one final
    // chunk, the two agree, which is why only one of the copies this came from had it right.
    const usage = (prompt: number, completion: number): Chunk =>
      chunk({
        choices: [],
        usage: {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
        },
      });
    const turn = await streamTurn(
      clientOf(() => chunks(usage(10, 1), usage(10, 2), usage(10, 3))),
      body,
    );
    expect(turn.usage).toEqual({ prompt: 10, completion: 3, total: 13, cached: 0 });
  });

  it("reports zero usage from a server that never sends any", async () => {
    const turn = await streamTurn(
      clientOf(() => chunks(text("hi"))),
      body,
    );
    expect(turn.usage).toEqual({ prompt: 0, completion: 0, total: 0, cached: 0 });
  });

  it("reads a cache hit in either spelling", async () => {
    const report = (extra: Record<string, unknown>): Chunk =>
      chunk({
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, ...extra },
      } as Partial<Chunk>);
    const openai = await streamTurn(
      clientOf(() => chunks(report({ prompt_tokens_details: { cached_tokens: 80 } }))),
      body,
    );
    expect(openai.usage.cached).toBe(80);
    const deepseek = await streamTurn(
      clientOf(() => chunks(report({ prompt_cache_hit_tokens: 64 }))),
      body,
    );
    expect(deepseek.usage.cached).toBe(64);
  });

  it("sets produced once the model has said something, and not before", async () => {
    const produced = { any: false };
    await expect(
      streamTurn(
        clientOf(() => Promise.reject(new Error("connection refused"))),
        body,
        { produced },
      ),
    ).rejects.toThrow("connection refused");
    expect(produced.any).toBe(false);

    await streamTurn(
      clientOf(() => chunks(text("hi"))),
      body,
      { produced },
    );
    expect(produced.any).toBe(true);
  });

  it("is not made unrepeatable by the empty chunk a stream opens with", async () => {
    // Most OpenAI-compatible servers prime a stream with `{"role":"assistant"}` before the
    // first token. It shows nobody anything, and latching `produced` on its arrival made an
    // endpoint that primes and then wedges unretryable — which is the case the watchdog raises
    // `EndpointSilent` for, and which `retry.ts` calls transient precisely so it is sent again.
    const priming = chunk({ choices: [{ delta: { role: "assistant" } }] });
    const shown: string[] = [];
    const produced = { any: false };

    vi.useFakeTimers();
    const turn = streamTurn(
      clientOf((_, { signal }) => stalls(signal, priming)),
      body,
      { produced, idleMs: 30_000, onOutput: (delta) => shown.push(delta), onThinking: () => {} },
    );
    const settled = expect(turn).rejects.toThrow(EndpointSilent);
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;

    expect(shown).toEqual([]);
    expect(produced.any).toBe(false);
  });

  it("latches on reasoning and on a tool-call fragment, not only on output", async () => {
    // Reasoning has reached a watcher, so a re-send would print it twice. A tool-call fragment
    // reaches no callback at all, but it is state this turn has accumulated — and losing a
    // retry is the safer half of that trade.
    const latched = async (delta: unknown) => {
      const produced = { any: false };
      await streamTurn(
        clientOf(() => chunks(chunk({ choices: [{ delta }] }))),
        body,
        { produced },
      );
      return produced.any;
    };
    expect(await latched({ reasoning_content: "hmm" })).toBe(true);
    expect(await latched({ reasoning: "hmm" })).toBe(true);
    expect(await latched({ tool_calls: [{ index: 0, function: { name: "t" } }] })).toBe(true);
    // An empty tool-call list is the same nothing as an empty delta.
    expect(await latched({ role: "assistant", content: "", tool_calls: [] })).toBe(false);
  });

  it("gives up on an endpoint that goes quiet mid-turn", async () => {
    vi.useFakeTimers();
    const turn = streamTurn(
      clientOf((_, { signal }) => stalls(signal, text("half an ans"))),
      body,
      { idleMs: 30_000 },
    );
    const settled = expect(turn).rejects.toThrow(EndpointSilent);
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
  });

  it("gives up on a request that never answers at all", async () => {
    // The same case as a stream going quiet, with no chunks in it — which is why the watchdog
    // is armed before the request is sent rather than on the first chunk.
    vi.useFakeTimers();
    const turn = streamTurn(
      // What the SDK does with a signal it never gets to answer: the request rejects on abort.
      clientOf(
        (_, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
      body,
      { idleMs: 30_000 },
    );
    const settled = expect(turn).rejects.toThrow(EndpointSilent);
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
  });

  it("gives the first token its own allowance, and the idle one after it", async () => {
    // Prefill of a long prompt on a local server is many times the gap between tokens.
    vi.useFakeTimers();
    const options: { timeout?: number }[] = [];
    const turn = streamTurn(
      clientOf((_, requestOptions) => {
        options.push(requestOptions as { timeout?: number });
        return {
          async *[Symbol.asyncIterator]() {
            yield chunk({ choices: [{ delta: { role: "assistant" } }] });
            await new Promise((resolve) => setTimeout(resolve, 100_000));
            yield* stalls(requestOptions.signal, text("after prefill"));
          },
        };
      }),
      body,
      { idleMs: 30_000, firstChunkMs: 150_000 },
    );
    const settled = expect(turn).rejects.toThrow("the model endpoint sent nothing for 30s");
    await vi.advanceTimersByTimeAsync(100_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
    // The watchdog covers the wait the SDK's own timer would otherwise cut short at the idle number.
    expect(options[0]?.timeout).toBeGreaterThan(150_000);
  });

  it("says when it was the first token that never came", async () => {
    vi.useFakeTimers();
    const turn = streamTurn(
      clientOf((_, { signal }) => stalls(signal)),
      body,
      { idleMs: 30_000, firstChunkMs: 150_000 },
    );
    const settled = expect(turn).rejects.toThrow("nothing for 150s before its first token");
    await vi.advanceTimersByTimeAsync(150_000);
    await settled;
  });

  it("waits as long as a model needs when no idle budget is given", async () => {
    vi.useFakeTimers();
    let go = () => {};
    const turn = streamTurn(
      clientOf(() => ({
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            go = resolve;
          });
          yield text("worth the wait");
        },
      })),
      body,
    );
    await vi.advanceTimersByTimeAsync(600_000);
    go();
    await expect(turn).resolves.toMatchObject({ content: "worth the wait" });
  });

  it("rearms on every chunk, so a model that is still talking is never cut off", async () => {
    vi.useFakeTimers();
    const turn = streamTurn(
      clientOf(() => ({
        async *[Symbol.asyncIterator]() {
          for (const word of ["a ", "slow ", "answer"]) {
            await new Promise((resolve) => setTimeout(resolve, 20_000));
            yield text(word);
          }
        },
      })),
      body,
      { idleMs: 30_000 },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(turn).resolves.toMatchObject({ content: "a slow answer" });
  });

  it("reports a run the caller stopped as the caller's stop, not a silent endpoint", async () => {
    // The drift this extraction exists to stop: getting the attribution backwards records a
    // stopped run as an endpoint fault, and `isTransient` then says it is worth retrying.
    const stop = new AbortController();
    const turn = streamTurn(
      clientOf((_, { signal }) => stalls(signal, text("half"))),
      body,
      {
        signal: stop.signal,
        idleMs: 30_000,
      },
    );
    stop.abort(new Error("stopped by the operator"));
    await expect(turn).rejects.toThrow("stopped by the operator");
    await expect(turn).rejects.not.toThrow(EndpointSilent);
  });

  it("still blames the caller when the watchdog fires on the way out", async () => {
    // The drift, precisely: a stopped run whose stream takes a moment to end its iteration
    // trips the idle timer on the way out, so both signals are aborted by the time the error is
    // classified. Reading the watchdog alone records that run as an endpoint fault — and
    // `isTransient` says an endpoint fault is worth retrying, so the run comes back.
    vi.useFakeTimers();
    const stop = new AbortController();
    const turn = streamTurn(
      clientOf(() => ({
        async *[Symbol.asyncIterator]() {
          yield text("half");
          await new Promise((resolve) => setTimeout(resolve, 60_000));
        },
      })),
      body,
      { signal: stop.signal, idleMs: 30_000 },
    );
    const settled = expect(turn).rejects.toThrow("stopped by the operator");
    await vi.advanceTimersByTimeAsync(0);
    stop.abort(new Error("stopped by the operator"));
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
  });

  it("reports the reason the model stopped", async () => {
    const turn = await streamTurn(
      clientOf(() =>
        chunks(text("done"), chunk({ choices: [{ delta: {}, finish_reason: "stop" }] })),
      ),
      body,
    );
    expect(turn.finishReason).toBe("stop");
  });

  it("says a turn was cut off at the ceiling, which it otherwise comes back whole from", async () => {
    // The failure this is here for: a tool call truncated mid-JSON. Nothing about the turn says
    // so — the content is real, the call has an id and a name — and the caller meets a
    // `JSON.parse` failure with nothing to attribute it to.
    const turn = await streamTurn(
      clientOf(() =>
        chunks(
          chunk({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "c1", function: { name: "read", arguments: '{"pa' } },
                  ],
                },
              },
            ],
          }),
          chunk({ choices: [{ delta: {}, finish_reason: "length" }] }),
        ),
      ),
      body,
    );
    expect(turn.finishReason).toBe("length");
    expect(() => JSON.parse(turn.toolCalls[0].function.arguments)).toThrow();
  });

  it("reads the reason off a final chunk that carries no delta at all", async () => {
    // Some servers send the reason on its own, which the delta guard skips — so it is read off
    // the choice before that guard rather than beside the content.
    const turn = await streamTurn(
      clientOf(() => chunks(text("hi"), chunk({ choices: [{ finish_reason: "tool_calls" }] }))),
      body,
    );
    expect(turn.content).toBe("hi");
    expect(turn.finishReason).toBe("tool_calls");
  });

  it("says nothing about the reason where the endpoint said nothing", async () => {
    const turn = await streamTurn(
      clientOf(() => chunks(text("hi"))),
      body,
    );
    expect(turn.finishReason).toBe("");
  });

  it("does not return a turn that was cut off as though it were finished", async () => {
    // An aborted stream ends its iteration rather than throwing, so the check after the loop is
    // the only thing between a truncated answer and a recorded one.
    const stop = new AbortController();
    const turn = streamTurn(
      clientOf((_, { signal }) => stalls(signal, text("half an ans"))),
      body,
      {
        signal: stop.signal,
      },
    );
    stop.abort();
    await expect(turn).rejects.toThrow();
  });
});
