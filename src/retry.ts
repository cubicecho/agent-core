import OpenAI from 'openai';

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
  override readonly name = 'EndpointSilent';
}

/**
 * The request was bigger than the model will read. Its own class so nothing retries it: sending
 * the same too-large request again is the same refusal, one round trip later.
 *
 * `runTurn` raises it from either side of the round trip — its own pre-flight guard, or the
 * endpoint's refusal read back through `isOverflow` — so a caller has one thing to catch whether
 * or not it gave a `contextLimit`. The second carries the endpoint's own message, and the error
 * it was built from as `cause`.
 */
export class ContextOverflow extends Error {
  override readonly name = 'ContextOverflow';
}

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
  !RATE_LIMITED.test(detail) && OVERFLOW.some((pattern) => pattern.test(detail)) && /token|context/i.test(detail);

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
 * Whether a failure is the endpoint refusing the request as written, rather than losing it.
 *
 * 400 and 422 are what a server says when it read the body and disliked it, which makes them the
 * only statuses worth answering by sending something different. Any 4xx is too wide: 401, 404 and
 * 429 are 4xx and none of them is about the fields, and a 429 is one `isTransient` accepts — a
 * caller that re-sent on it at once doubled the rate against a server that had just asked for less.
 * Catching everything is wider still, since an abort or a connection that never landed then
 * latches off whatever the re-send left out.
 *
 * @param error The rejection, as caught. What is not an SDK error refuses nothing.
 */
export const refusesRequest = (error: unknown) =>
  error instanceof OpenAI.APIError && (error.status === 400 || error.status === 422);

/**
 * Whether a failure is a local server still loading the model, rather than one failing to serve.
 *
 * llama.cpp answers 503 `Loading model` with type `unavailable_error` from the moment it starts
 * until the weights are mapped, and a router build says the same while it swaps models. That is
 * thirty to ninety seconds for a large model from a cold page cache, and `backoffMs` gives up
 * inside fifteen: sized for a busy host, not for one reading a file. A plain 503 is not this.
 *
 * @param error The rejection, as caught.
 */
export function isModelLoading(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError) || error.status !== 503) return false;
  const body = error.error as { type?: unknown; message?: unknown } | undefined;
  return (
    body?.type === 'unavailable_error' ||
    /loading model|model is loading|unavailable_error/i.test(`${error.message} ${body?.message ?? ''}`)
  );
}

/** How long to wait between asking a loading server again. */
export const LOADING_POLL_MS = 3000;

/** How long `runTurn` waits for a model to load unless told otherwise. */
export const LOADING_TIMEOUT_MS = 120_000;

/**
 * Exponential, with jitter so several tasks failing at once do not return in lockstep.
 *
 * @param attempt Zero-based. Doubles from 500ms to a ceiling of eight seconds, before jitter.
 */
export const backoffMs = (attempt: number) => Math.min(8000, 2 ** attempt * 500) * (0.5 + Math.random() / 2);

/**
 * A delay an abort cuts short, rejecting rather than resolving early.
 *
 * @param ms How long to wait.
 * @param signal Abandons the wait. One already aborted rejects without waiting at all.
 */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
