import OpenAI from 'openai';
import { ABORT_ERROR, ABORT_EVENT } from './platform.ts';
import { HttpStatus } from './wire.ts';

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
 * @remarks
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
 * @remarks
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
 * @param detail - The endpoint's own message.
 * @returns `true` for an overflow: one of the over-long wordings, beside `token` or `context`.
 * `false` for anything that reads as a rate limit, whatever else it says.
 *
 * @remarks
 * Rate limits are ruled out first: they borrow the same words and mean the opposite, being worth
 * another attempt where an overflow never is.
 */
export const isOverflow = (detail: string) =>
  !RATE_LIMITED.test(detail) && OVERFLOW.some((pattern) => pattern.test(detail)) && /token|context/i.test(detail);

/**
 * The smallest window worth believing in, and the floor under `runTurn`'s guard.
 *
 * @remarks
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

/** The statuses below 500 that say "not now" rather than "not this": a timeout, a conflict, a rate limit. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([
  HttpStatus.RequestTimeout,
  HttpStatus.Conflict,
  HttpStatus.TooManyRequests,
]);

/**
 * Whether a failed request is worth trying again.
 *
 * @param error - The rejection, as caught. What is not an SDK error is not transient.
 * @returns `true` for an `EndpointSilent`, a connection error, a 408, 409 or 429, and any status
 * of 500 or above; `false` for any other SDK error, one with no status included.
 *
 * @remarks
 * The question is whether the request was *refused or lost*, rather than answered with a
 * complaint about its contents: a connection that never landed, a server too busy or too broken
 * to answer, an endpoint that went quiet. A 400 for a malformed tool schema would fail exactly
 * the same way on every attempt, and the two capability cases below are negotiated rather than
 * retried blindly.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof EndpointSilent) {
    return true;
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return true;
  }
  if (!(error instanceof OpenAI.APIError)) {
    return false;
  }
  const { status } = error;
  return status !== undefined && (TRANSIENT_STATUSES.has(status) || status >= HttpStatus.InternalServerError);
}

/**
 * Whether a failure is the endpoint refusing the request as written, rather than losing it.
 *
 * @param error - The rejection, as caught. What is not an SDK error refuses nothing.
 * @returns `true` for an SDK error whose status is 400 or 422, and for nothing else.
 *
 * @remarks
 * 400 and 422 are what a server says when it read the body and disliked it, which makes them the
 * only statuses worth answering by sending something different. Any 4xx is too wide: 401, 404 and
 * 429 are 4xx and none of them is about the fields, and a 429 is one `isTransient` accepts — a
 * caller that re-sent on it at once doubled the rate against a server that had just asked for less.
 * Catching everything is wider still, since an abort or a connection that never landed then
 * latches off whatever the re-send left out.
 */
export const refusesRequest = (error: unknown) =>
  error instanceof OpenAI.APIError &&
  (error.status === HttpStatus.BadRequest || error.status === HttpStatus.UnprocessableEntity);

/**
 * Whether a failure is the caller cancelling, rather than anything going wrong.
 *
 * @param error - The rejection, as caught.
 * @returns `true` for the SDK's `APIUserAbortError` and for any error named `AbortError`, which is
 * what an aborted signal gives as its reason; `false` for everything else, a timeout included.
 *
 * @remarks
 * An abort reaches a catch in two shapes. The SDK raises its own class when a request in flight is
 * cancelled, and `sleep` rejects with the signal's reason when the cancel lands between attempts.
 * A catch that knew only the first reported the second as a failure. A signal aborted with a
 * reason of the caller's own making is not recognised, since only the error is looked at: a
 * catch that holds the signal asks it as well, as `tryAsk` does.
 */
export const isAbort = (error: unknown) =>
  error instanceof OpenAI.APIUserAbortError || (error instanceof Error && error.name === ABORT_ERROR);

/** The error type llama.cpp gives a request it cannot serve yet. */
const UNAVAILABLE_ERROR = 'unavailable_error';

/**
 * Whether a failure is a local server still loading the model, rather than one failing to serve.
 *
 * @param error - The rejection, as caught.
 * @returns `true` for a 503 whose body is of type `unavailable_error`, or whose message says the
 * model is loading; `false` for any other status and for what is not an SDK error.
 *
 * @remarks
 * llama.cpp answers 503 `Loading model` with type `unavailable_error` from the moment it starts
 * until the weights are mapped, and a router build says the same while it swaps models. That is
 * thirty to ninety seconds for a large model from a cold page cache, and `backoffMs` gives up
 * inside fifteen: sized for a busy host, not for one reading a file. A plain 503 is not this.
 */
export function isModelLoading(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError) || error.status !== HttpStatus.ServiceUnavailable) {
    return false;
  }
  const body = error.error as { type?: unknown; message?: unknown } | undefined;
  return (
    body?.type === UNAVAILABLE_ERROR ||
    /loading model|model is loading|unavailable_error/i.test(`${error.message} ${body?.message ?? ''}`)
  );
}

/** How long to wait between asking a loading server again. */
export const LOADING_POLL_MS = 3000;

/** How long `runTurn` waits for a model to load unless told otherwise. */
export const LOADING_TIMEOUT_MS = 120_000;

/** The first backoff, before jitter, which each attempt after it doubles. */
const BACKOFF_BASE_MS = 500;

/** The longest a backoff grows to, before jitter. */
const BACKOFF_CEILING_MS = 8000;

/** The least of a backoff that jitter leaves: a wait is somewhere between this share of it and all of it. */
const JITTER_FLOOR = 0.5;

/**
 * How long to wait before a retry: exponential, with jitter so several tasks failing at once do
 * not return in lockstep.
 *
 * @param attempt - Zero-based. Doubles from 500ms to a ceiling of eight seconds, before jitter.
 * @returns Milliseconds, somewhere between half of that wait and all of it, and not a whole number.
 */
export const backoffMs = (attempt: number) =>
  Math.min(BACKOFF_CEILING_MS, 2 ** attempt * BACKOFF_BASE_MS) * (JITTER_FLOOR + Math.random() * (1 - JITTER_FLOOR));

/**
 * A delay an abort cuts short, rejecting rather than resolving early.
 *
 * @param ms - How long to wait.
 * @param [signal] - Abandons the wait. One already aborted rejects without waiting at all.
 * @returns A promise that resolves once `ms` has passed, or rejects with the signal's reason — an
 * `Error` of its own where the signal carries none.
 */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener(ABORT_EVENT, onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    if (signal?.aborted) {
      return onAbort();
    }
    signal?.addEventListener(ABORT_EVENT, onAbort, { once: true });
  });
