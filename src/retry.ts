import OpenAI from "openai";
import { estimateTokens } from "./side-task.ts";

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

/** 1234 → "1.2k". The numbers in an overflow message are large and nobody reads the units digit. */
export const compact = (tokens: number) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

/**
 * What this request will cost the window, in tokens, near enough.
 *
 * Characters over four, because there is no tokenizer here and there is not going to be one:
 * a server that will not say how big its window is will not lend us its vocabulary either.
 * The estimate runs low on tool schemas — JSON packs more tokens into a character than prose
 * does — and that is the side to be wrong on, since the cost of guessing high is a run refused
 * that would have worked, and the cost of guessing low is the endpoint's own refusal, which is
 * where we were before this existed.
 */
export const requestTokens = (body: OpenAI.ChatCompletionCreateParamsStreaming) =>
  estimateTokens(JSON.stringify(body.messages)) +
  (body.tools?.length ? estimateTokens(JSON.stringify(body.tools)) : 0);

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

export const isOverflow = (detail: string) =>
  OVERFLOW.some((pattern) => pattern.test(detail)) && /token|context/i.test(detail);

/**
 * Below this, the window is nobody's business and is not asked for.
 *
 * Finding out what a model reads costs a listing against its endpoint, and a run whose whole
 * request is a few thousand tokens fits anything anyone serves — spending a round trip to
 * confirm that, on every run of every card, would be the cost of the guard falling on the
 * runs that never needed it. A model in a window smaller than this exists, and a request that
 * overruns one is left to the endpoint's own complaint, which reads properly now either way.
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
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof EndpointSilent) return true;
  if (error instanceof OpenAI.APIConnectionError) return true;
  if (!(error instanceof OpenAI.APIError)) return false;
  const { status } = error;
  return status === 408 || status === 409 || status === 429 || (status ?? 0) >= 500;
}

/** Exponential, with jitter so several tasks failing at once do not return in lockstep. */
export const backoffMs = (attempt: number) =>
  Math.min(8000, 2 ** attempt * 500) * (0.5 + Math.random() / 2);

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
