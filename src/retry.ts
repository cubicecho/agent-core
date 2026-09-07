import OpenAI from "openai";
import { estimateTokens } from "./tokens.ts";

/**
 * Everything about a request failing that is not about what the request said.
 *
 * A run makes a request per tool iteration against an endpoint that may be a laptop's llama.cpp
 * or a hosted API, and the two fail in different ways for different reasons. This is the part
 * of the loop with nothing to do with the model's answer: whether the request was lost, whether
 * it was too big to have been sent at all, and how long to wait before sending it again.
 */

/** The endpoint stopped answering mid-request. Its own class so the retry can recognise it. */
export class EndpointSilent extends Error {
  override readonly name = "EndpointSilent";
}

/**
 * The request was bigger than the model will read. Its own class so nothing retries it: sending
 * the same too-large request again is the same refusal, one round trip later.
 */
export class ContextOverflow extends Error {
  override readonly name = "ContextOverflow";
}

/**
 * 1234 → "1.2k". The numbers in an overflow message are large and nobody reads the units digit.
 *
 * @param tokens The count to render.
 */
export const compact = (tokens: number) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

/** What `{"role":"","content":""},` costs around a message's own text, in characters. */
const ENVELOPE = 25;

/** The same for `{"id":"","type":"function","function":{"name":"","arguments":""}},` in a call. */
const CALL_ENVELOPE = 66;

/** The divisor behind `estimateTokens`, applied here to a character count rather than a string. */
const CHARS_PER_TOKEN = 4;

/** How many characters one message is worth, whichever of the shapes its content is in. */
function messageChars(message: OpenAI.ChatCompletionMessageParam): number {
  let chars = message.role.length + ENVELOPE;
  const { content } = message;
  if (typeof content === "string") chars += content.length;
  else if (Array.isArray(content))
    for (const part of content) {
      // Text and refusal parts carry their own strings; an image or an audio part carries a URL
      // or a blob, and neither is priced by its length anyway.
      if (part.type === "text") chars += part.text.length;
      else if (part.type === "refusal") chars += part.refusal.length;
    }

  if ("name" in message && typeof message.name === "string") chars += message.name.length;
  if ("tool_call_id" in message && typeof message.tool_call_id === "string")
    chars += message.tool_call_id.length;
  if ("tool_calls" in message && Array.isArray(message.tool_calls))
    for (const call of message.tool_calls) {
      chars += CALL_ENVELOPE + call.id.length;
      if (call.type === "function")
        chars += call.function.name.length + call.function.arguments.length;
    }
  return chars;
}

/**
 * The tools half, cached against the array.
 *
 * Serialising two dozen JSON schemas to measure them, on every turn, to get the same number every
 * time, was the more expensive half of this function.
 *
 * The array is the key, so this pays only a caller that hands the same one back. That is not what
 * a turn built through `sanitizeTools` or `relaxTools` does — both are a `map`, so each build
 * allocates a fresh array however stable the tools inside it are, and those builds miss here every
 * time. It is not free to change: keying on the tools instead would hit for them, at the cost of
 * the array-level memoisation `tests/retry.test.ts` pins, which deliberately holds a mutated array
 * to its first reading. Sizing happens once per turn either way, so the miss costs one walk of the
 * schemas rather than a walk per attempt.
 */
const toolTokens = new WeakMap<OpenAI.ChatCompletionTool[], number>();

function toolsCost(tools: OpenAI.ChatCompletionTool[]): number {
  const hit = toolTokens.get(tools);
  if (hit !== undefined) return hit;
  // Schemas are arbitrarily shaped, so this one really is a serialisation — but it happens once
  // per tool array rather than once per turn.
  const cost = estimateTokens(JSON.stringify(tools));
  toolTokens.set(tools, cost);
  return cost;
}

/**
 * What this request will cost the window, in tokens, near enough.
 *
 * See `estimateTokens` for why it is characters over four and which way it is wrong on purpose.
 *
 * Summed by walking the body rather than by serialising it. `JSON.stringify` on the messages
 * built the entire transcript into a string on every call and threw it away having read nothing
 * but its `.length` — against a transcript that grows by a turn each turn, and one the SDK is
 * about to serialise again to send. What the walk misses is JSON's own punctuation and the keys,
 * which `ENVELOPE` puts back approximately; the difference is a rounding error against an
 * estimate that is already characters over four.
 *
 * @param body The request as it will be sent, tools included.
 */
export const requestTokens = (body: OpenAI.ChatCompletionCreateParamsStreaming) => {
  // Characters first and the division once at the end, rather than a rounded count per message:
  // `Math.ceil` on every one of a few hundred messages is a few hundred tokens of pure rounding.
  let chars = 0;
  for (const message of body.messages) chars += messageChars(message);
  return Math.ceil(chars / CHARS_PER_TOKEN) + (body.tools?.length ? toolsCost(body.tools) : 0);
};

/**
 * Servers refuse an over-long request in their own words; these are the ones worth reading as
 * that rather than as a broken request. Matched loosely — every one of them is some
 * arrangement of "context" and "too long", and the arrangement is the part that varies.
 */
const OVERFLOW = [
  /context (size|length|window)/i,
  /exceeds? the (available|maximum)/i,
  /too (long|large) for/i,
  /reduce the length/i,
];

/**
 * A rate limit says the same words and means the opposite thing.
 *
 * OpenAI refuses a request over the per-minute token budget with "Request too large for gpt-4o
 * ... on tokens per min (TPM)", which is "too large for" beside "tokens" — both halves of the
 * test below. That is a 429, which `isTransient` accepts and which succeeds on the next attempt;
 * reading it as an overflow turned it into a `ContextOverflow`, whose whole purpose is that
 * nothing retries it. The two classifiers in this file disagreed about one error.
 */
const RATE_LIMITED = /per (min|hour|day)|rate.?limit|\b[tr]pm\b|quota/i;

/**
 * Whether a refusal means the request was too big, rather than merely refused.
 *
 * Rate limits are ruled out first: they borrow the same words and mean the opposite, being worth
 * another attempt where an overflow never is.
 *
 * @param detail The endpoint's own message.
 */
export const isOverflow = (detail: string) =>
  !RATE_LIMITED.test(detail) &&
  OVERFLOW.some((pattern) => pattern.test(detail)) &&
  /token|context/i.test(detail);

/**
 * The smallest window worth believing in, and the floor under `runTurn`'s guard.
 *
 * `runTurn`'s `contextLimit` reads it as a sanity check on a number it was handed: below this,
 * the limit is taken for a placeholder — an unset column, a listing that said nothing — rather
 * than a window worth refusing a run over. That is the whole of what reads it; `contextLimitFor`
 * asks the endpoint whatever the number, and `client.ts` does not import this file.
 *
 * A model in a window smaller than this exists, and the reason not to refuse a run over one is
 * that the number far more often came from a caller threading a placeholder through than from
 * such a model. A request that really does overrun a tiny window is left to the endpoint's own
 * complaint, which `isOverflow` reads properly either way — so what the floor costs is a round
 * trip on the runs it declines to guard, and what it saves is refusing the ones it would have
 * guarded wrongly.
 */
export const SMALLEST_LIKELY_WINDOW = 8192;

/**
 * Whether a failed request is worth trying again.
 *
 * The question is whether the request was *refused or lost*, rather than answered with a
 * complaint about its contents: a connection that never landed, a server too busy or too broken
 * to answer, an endpoint that went quiet. A 400 for a malformed tool schema would fail exactly
 * the same way on every attempt, and the two capability cases below are negotiated rather than
 * retried blindly.
 *
 * @param error The rejection, as caught. What is not an SDK error is not transient.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof EndpointSilent) return true;
  if (error instanceof OpenAI.APIConnectionError) return true;
  if (!(error instanceof OpenAI.APIError)) return false;
  const { status } = error;
  return status === 408 || status === 409 || status === 429 || (status ?? 0) >= 500;
}

/**
 * Exponential, with jitter so several tasks failing at once do not return in lockstep.
 *
 * @param attempt Zero-based. Doubles from 500ms to a ceiling of eight seconds, before jitter.
 */
export const backoffMs = (attempt: number) =>
  Math.min(8000, 2 ** attempt * 500) * (0.5 + Math.random() / 2);

/**
 * A delay an abort cuts short, rejecting rather than resolving early.
 *
 * @param ms How long to wait.
 * @param signal Abandons the wait. One already aborted rejects without waiting at all.
 */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
