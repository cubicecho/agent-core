/**
 * Every value in this package somebody chose, where a different choice would still be a working
 * program: a limit, a wait, a share of the context window, a retry count.
 *
 * A leaf with no imports, so the browser-safe `spec/` modules can read it too. Each group is named
 * for the concept it tunes, is frozen, and holds plain JSON values, so a group can be printed,
 * compared, or later filled from a host's own settings without touching the code that reads it.
 * The facts that could not be otherwise are in `consts.ts`.
 */

/** Waiting on a model server: for its first token, for its listing, and for a model to load. */
export interface ModelServerSettings {
  /**
   * How many idle windows (`requestTimeoutSeconds`) a streamed reply's first chunk is given, where
   * the endpoint names no `firstTokenSeconds` of its own. The first wait is prefill, or a model
   * loading on demand, and is routinely many times the gap between tokens.
   */
  firstTokenIdleWindows: number;
  /** How many models `probeEndpoint` hands back unless told otherwise: enough for any picker. */
  probeModelLimit: number;
  /** How long `runTurn` waits, in seconds, between asking a loading model server again. */
  loadingPollSeconds: number;
  /**
   * How long `runTurn` waits, in seconds, for a model to finish loading, where neither its
   * `loadingTimeoutMs` nor a `RetryPolicy.loadingTimeoutSeconds` says.
   */
  loadingTimeoutSeconds: number;
}

/** The waits the model server code was written with. */
export const MODEL_SERVER_DEFAULTS: Readonly<ModelServerSettings> = Object.freeze({
  firstTokenIdleWindows: 5,
  probeModelLimit: 500,
  loadingPollSeconds: 3,
  loadingTimeoutSeconds: 120,
});

/** Resending a request that was lost: how long to wait between attempts. */
export interface RetrySettings {
  /** The first backoff, in milliseconds, before jitter. */
  firstBackoffMs: number;
  /** The longest a backoff grows to, in milliseconds, before jitter. */
  maxBackoffMs: number;
  /** What each attempt after the first multiplies the backoff by. */
  growthPerAttempt: number;
  /**
   * The least of a backoff that jitter leaves: a wait is somewhere between this share of it and
   * all of it, so several tasks failing at once do not return in lockstep.
   */
  jitterFloorShare: number;
}

/** The backoff `backoffMs` was written with. */
export const RETRY_DEFAULTS: Readonly<RetrySettings> = Object.freeze({
  firstBackoffMs: 500,
  maxBackoffMs: 8000,
  growthPerAttempt: 2,
  jitterFloorShare: 0.5,
});
