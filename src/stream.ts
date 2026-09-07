import type OpenAI from "openai";
import { EndpointSilent } from "./retry.ts";

/**
 * Reading one streamed turn back into a message.
 *
 * The rest of a request is the caller's — which model, which tools, which transcript — but the
 * reading of the answer is the same everywhere, and it is fiddly in ways the API does not
 * advertise: tool calls arrive in pieces, an aborted stream ends rather than throws, reasoning
 * has two spellings and is in no published type, and an endpoint that stops answering mid-stream
 * hangs the turn until somebody presses stop. `EndpointSilent` and `timeoutMs` were exported for
 * this loop long before the loop itself was.
 */

/** What a turn cost. Zero throughout means the server did not say. */
export interface TurnUsage {
  prompt: number;
  completion: number;
  total: number;
}

/** One streamed turn, put back together into the shape a loop and a transcript work with. */
export interface Turn {
  content: string;
  toolCalls: OpenAI.ChatCompletionMessageToolCall[];
  usage: TurnUsage;
}

/**
 * Reasoning deltas are not in the OpenAI types and have two spellings in the wild:
 * `reasoning_content` is llama.cpp, vLLM and DeepSeek, `reasoning` is OpenRouter's.
 */
type ReasoningDelta = OpenAI.ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null;
  reasoning?: string | null;
};

/**
 * Whether the model has said anything a second attempt would say twice.
 *
 * A box rather than a return value because it has to be readable *while* the request is in
 * flight: the rules in `retry.ts` are built on the premise that a stream which has already
 * emitted tokens must never be replayed, and by the time a rejected promise is in hand the turn
 * is over. There is one of these per attempt, shared by everything that has a say in whether
 * the attempt is repeated. See `negotiate`.
 *
 * What sets it is a chunk that carried something — text, reasoning, or a piece of a tool call —
 * rather than a chunk arriving. Those read as the same sentence until a server puts an empty
 * chunk between them, and most of them do: a stream usually opens with a content-free
 * `{"role":"assistant"}` that shows nobody anything, and a turn that latched on it could never
 * be retried however early it then died.
 */
export interface Produced {
  any: boolean;
}

/** What `streamTurn` takes besides the request body. */
export interface StreamTurnOptions {
  /** Cancels the request and the stream being read from it. */
  signal?: AbortSignal;
  /**
   * Silence allowed before the request is given up on. Zero or undefined waits forever, which
   * is what `timeoutMs` means by a timeout of zero and what a local model answering slowly
   * needs.
   */
  idleMs?: number;
  /** Set by the first chunk that carries anything, so a failed call knows if it can be retried. */
  produced?: Produced;
  /** The model's scratchpad, as it arrives. */
  onThinking?: (delta: string) => void;
  /** The model's answer, as it arrives. */
  onOutput?: (delta: string) => void;
}

/**
 * Runs one turn as a stream, reporting tokens as they arrive and assembling them back into a
 * message.
 *
 * Streaming buys no speed — nothing waits on the reply but the loop itself. It is what makes a
 * run watchable: a run that stalls, loops, or reaches for the wrong tool says so while it is
 * happening instead of only in the row it leaves behind.
 *
 * Two token callbacks rather than an event input, because a turn does not know which step of
 * which run it is: `step` is the caller's flow concept, and wrapping these into an `emit` is one
 * line at the call site.
 *
 * @param client The pooled client for this endpoint.
 * @param body The request, which must set `stream: true`.
 * @param options Cancellation, the idle watchdog, and the token callbacks.
 */
export async function streamTurn(
  client: OpenAI,
  body: OpenAI.ChatCompletionCreateParamsStreaming,
  { signal, idleMs, produced, onThinking, onOutput }: StreamTurnOptions = {},
): Promise<Turn> {
  // Silence, not duration: the timer is rearmed on every chunk, so a model that is still
  // talking is never cut off however long it takes, and one that has stopped talking does not
  // hang the run until someone notices. A request that never answers at all is the same case
  // with no chunks in it, which is why the first arming happens before the request is sent.
  const watchdog = new AbortController();
  const linked = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const rearm = () => {
    if (!idleMs) return;
    clearTimeout(idle);
    idle = setTimeout(() => watchdog.abort(), idleMs);
  };

  try {
    rearm();
    return await collect();
  } catch (error) {
    // The caller's own stop has to stay distinguishable from ours: one is a run that was called
    // off, the other is an endpoint that stopped answering and may be worth retrying. Getting
    // this backwards records a stopped run as an endpoint fault, which nobody notices until
    // they read the row and disbelieve it.
    if (watchdog.signal.aborted && !signal?.aborted) {
      throw new EndpointSilent(`the model endpoint sent nothing for ${(idleMs ?? 0) / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(idle);
  }

  async function collect(): Promise<Turn> {
    const stream = await client.chat.completions.create(body, { signal: linked });
    const content: string[] = [];
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    const usage: TurnUsage = { prompt: 0, completion: 0, total: 0 };

    for await (const chunk of stream) {
      // Rearmed on every chunk, latched below on only some: a priming chunk is the endpoint
      // being alive, which is all the watchdog is asking about.
      rearm();
      // Assigned rather than accumulated. `stream_options.include_usage` sends one final chunk
      // and the two agree there, but a server that reports cumulatively per chunk makes a sum
      // of sums out of an accumulator — and a token count wrong by a factor of the chunk count
      // is not a number anyone would attribute to the stream reader.
      if (chunk.usage) {
        usage.prompt = chunk.usage.prompt_tokens ?? 0;
        usage.completion = chunk.usage.completion_tokens ?? 0;
        usage.total = chunk.usage.total_tokens ?? 0;
      }
      const delta = chunk.choices[0]?.delta as ReasoningDelta | undefined;
      if (!delta) continue;

      const thinking = delta.reasoning_content || delta.reasoning || "";
      // Latched on what the chunk carried, not on its having arrived. Most OpenAI-compatible
      // servers open a stream with a content-free `{"role":"assistant"}` before the first
      // token; latching on that made an endpoint that primes and then wedges unrepeatable,
      // which is exactly the case the watchdog raises `EndpointSilent` for. Tool-call
      // fragments count even though no callback reports them: a partial call is state the turn
      // has accumulated, and losing a retry is the safer half of that trade. Set before the
      // callbacks, so a watcher that throws mid-token cannot be told the same token twice.
      if (produced && (thinking || delta.content || delta.tool_calls?.length)) produced.any = true;
      if (thinking) onThinking?.(thinking);
      if (delta.content) {
        content.push(delta.content);
        onOutput?.(delta.content);
      }
      // Tool calls arrive in pieces, keyed by position: the id in one chunk, the name in
      // another, the arguments spread across the next several.
      for (const part of delta.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
        calls.set(part.index, call);
      }
    }

    // An aborted stream ends its iteration rather than throwing, so without this a turn cut off
    // halfway — by the watchdog or by someone stopping the run — comes back looking like a
    // complete one, and a truncated answer is recorded as the output. Nothing about the API
    // says you have to know this.
    linked.throwIfAborted();

    return {
      content: content.join(""),
      toolCalls: [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({
          // A server that streams a call without an id still needs one for the result to answer.
          id: call.id || `call_${index}`,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      usage,
    };
  }
}
