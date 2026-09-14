import type OpenAI from "openai";
import { EndpointSilent } from "./retry.ts";
import { DEFAULT_FENCES, type Fence, FenceSplitter, type Split } from "./thinking.ts";

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
  /**
   * How much of `prompt` came from the endpoint's prompt cache — a part of it, not in addition.
   *
   * The only way a caller can tell whether the prefix it is careful to keep still is actually
   * being reused: a prefix that stops hitting the cache otherwise shows up as a bill and nothing
   * else. Zero is also what a server that does not report it sends.
   */
  cached: number;
}

/**
 * The usage fields a cache report arrives in, none of them in every server's reply.
 *
 * `prompt_tokens_details.cached_tokens` is OpenAI's, and what OpenRouter, vLLM and recent
 * llama.cpp copy; `prompt_cache_hit_tokens` is DeepSeek's.
 */
type CacheUsage = OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number | null };

/** One streamed turn, put back together into the shape a loop and a transcript work with. */
export interface Turn {
  content: string;
  /**
   * The narrower of the SDK's two tool-call shapes, because it is the only one built here — a
   * streamed `tool_calls` delta carries a function and nothing else. Typed as the union it
   * belongs to, every caller had to narrow before it could read `.function`, to rule out a
   * custom call that this loop cannot produce. Still assignable wherever the union is wanted.
   */
  toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[];
  usage: TurnUsage;
  /**
   * Why the model stopped, in the endpoint's own words — `stop`, `length`, `tool_calls`, or `""`
   * where it never said.
   *
   * Reported because `length` is otherwise invisible. A turn cut off at the token ceiling comes
   * back as a well-formed `Turn` with truncated `content`, or with a tool call whose `arguments`
   * stop mid-JSON — so the caller meets a parse failure with nothing to attribute it to. Being
   * cut off looking whole is the same trap `throwIfAborted` below answers for the abort; this
   * half is not an error, because the tokens are real and a caller may still want them, so it is
   * handed over rather than raised.
   */
  finishReason: string;
  /**
   * The model's scratchpad, as `onThinking` was told it, `""` where it deliberated in silence or
   * not at all.
   *
   * Kept because some models want it back. gpt-oss and DeepSeek in thinking mode read the
   * analysis behind a tool call off the assistant message on the next request, so a caller
   * talking to one stores it as `reasoning_content` on that message for as long as the message
   * ends in a tool call, and drops it once the model has given a final answer. A model that
   * does not ask for it is better off without it: it is context, paid for on every turn.
   */
  reasoning: string;
}

/**
 * Reasoning deltas are not in the OpenAI types and have two spellings in the wild:
 * `reasoning_content` is llama.cpp, vLLM and DeepSeek, `reasoning` is OpenRouter's.
 */
type ReasoningDelta = OpenAI.ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null;
  reasoning?: string | null;
};

/** A tool call being put back together, under the index the server gave it if it gave one. */
interface PartialCall {
  index: number | undefined;
  id: string;
  name: string;
  arguments: string;
}

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
  /**
   * The fences that mark a scratchpad written into `content`, `DEFAULT_FENCES` unless given.
   *
   * Text inside one goes to `onThinking` and `reasoning` rather than `onOutput` and `content`.
   * `ALL_FENCES` adds `<thinking>` and `<reasoning>`, which a model can also be quoting; an
   * empty list reads `content` as all answer.
   */
  fences?: readonly Fence[];
  /**
   * The chat template opened the first fence in the prompt, so the reply starts inside it.
   * Without this the scratchpad is still moved out of `content` once the closing tag arrives,
   * but `onOutput` will have been told it first.
   */
  startInReasoning?: boolean;
  /** The model's scratchpad, as it arrives, from its own field or from a fence in `content`. */
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
  {
    signal,
    idleMs,
    produced,
    fences = DEFAULT_FENCES,
    startInReasoning,
    onThinking,
    onOutput,
  }: StreamTurnOptions = {},
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
    // The field's reasoning here, the fenced kind in the splitter, which can still move text
    // already read as answer into reasoning when a closing tag turns up with no opening one.
    const reasoning: string[] = [];
    const splitter = new FenceSplitter(fences, { startInside: startInReasoning });
    const report = (parts: Split[]) => {
      for (const part of parts) (part.kind === "reasoning" ? onThinking : onOutput)?.(part.text);
    };
    // In arrival order, sorted by index at the end; a call from a server that sent none keeps
    // its place in the order they arrived.
    const calls: PartialCall[] = [];
    const usage: TurnUsage = { prompt: 0, completion: 0, total: 0, cached: 0 };
    let finishReason = "";

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
        const reported = chunk.usage as CacheUsage;
        usage.cached =
          reported.prompt_tokens_details?.cached_tokens ?? reported.prompt_cache_hit_tokens ?? 0;
      }
      // One choice, because that is what an agent loop asks for. A body with `n` above one
      // keeps only the first; nothing here is built to reassemble several at once.
      const choice = chunk.choices[0];
      // Read before the delta guard rather than beside the content. The chunk that carries the
      // reason usually carries an empty delta, and some servers send it with no delta at all —
      // either of which the guard below skips, taking the reason with it.
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta as ReasoningDelta | undefined;
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
      if (thinking) {
        reasoning.push(thinking);
        onThinking?.(thinking);
      }
      if (delta.content) report(splitter.push(delta.content));
      // Tool calls arrive in pieces, keyed by position: the id in one chunk, the name in
      // another, the arguments spread across the next several.
      for (const part of delta.tool_calls ?? []) {
        const call = fragmentOf(part);
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
      }
    }

    /**
     * The call a fragment belongs to.
     *
     * By `index` where the server sent a number, which the SDK types as required and servers have
     * nonetheless left out: keyed on `undefined`, every call joined into one whose name and
     * arguments were all of theirs run together. Without one, by `id`; failing that, a fragment
     * naming a function opens a call and a bare run of arguments continues the latest. A server
     * that sends whole calls one per chunk at index `0` makes the same mistake the other way, so
     * a different id, or a name after arguments have begun, opens a new call under that index.
     */
    function fragmentOf(part: OpenAI.ChatCompletionChunk.Choice.Delta.ToolCall): PartialCall {
      const index = typeof part.index === "number" ? part.index : undefined;
      const name = part.function?.name;
      const known =
        index !== undefined
          ? calls.findLast((call) => call.index === index)
          : part.id
            ? calls.find((call) => call.id === part.id)
            : name
              ? undefined
              : calls.at(-1);
      const another =
        known && ((part.id && known.id && part.id !== known.id) || (name && known.arguments));
      if (known && !another) return known;
      const call: PartialCall = { index, id: "", name: "", arguments: "" };
      calls.push(call);
      return call;
    }

    // An aborted stream ends its iteration rather than throwing, so without this a turn cut off
    // halfway — by the watchdog or by someone stopping the run — comes back looking like a
    // complete one, and a truncated answer is recorded as the output. Nothing about the API
    // says you have to know this.
    linked.throwIfAborted();
    // What was held back as a possible tag. A reply that ended inside a fence stays reasoning:
    // cut off at the ceiling mid-scratchpad, it has no answer, and promoting the deliberation to
    // one is how a truncated turn gets recorded as output.
    report(splitter.finish());

    const minted = new Set<string>();
    return {
      content: splitter.output,
      toolCalls: calls
        .map((call, order) => ({ call, order }))
        .sort((a, b) => (a.call.index ?? a.order) - (b.call.index ?? b.order) || a.order - b.order)
        .map(({ call }, position) => {
          // A server that streams a call without an id still needs one for the result to answer,
          // and two calls it put under one index must not be answered as one.
          let id = call.id || `call_${call.index ?? position}`;
          if (minted.has(id)) id = `call_${position}_${minted.size}`;
          minted.add(id);
          return {
            id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          };
        }),
      usage,
      finishReason,
      reasoning: reasoning.join("") + splitter.reasoning,
    };
  }
}
