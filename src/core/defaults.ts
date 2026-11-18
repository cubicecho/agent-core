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

/** Sizing a request against the context window, with no tokenizer to hand. */
export interface RequestSizeSettings {
  /**
   * The characters one token is taken to be, where nothing has measured it.
   *
   * @remarks
   * The fallback, not the rule: once a reply has come back with a reported prompt count, `runTurn`
   * divides by what the model on that model server was measured at instead. See
   * `charsPerTokenFor`.
   */
  charsPerToken: number;
  /** How many of a model's latest readings `charsPerTokenFor` takes its ratio over. */
  calibrationReadings: number;
  /**
   * The fewest characters per token a whole request can measure and still be believed. Below it is
   * a request whose tokens are mostly somewhere the characters do not count — an image.
   */
  minPlausibleCharsPerToken: number;
  /**
   * The most characters per token a whole request can measure and still be believed. Far above
   * `charsPerToken` is a server that reported the uncached part of the prompt as all of it.
   */
  maxPlausibleCharsPerToken: number;
}

/** The ratio a request is sized by, and the bounds a measured one is held to. */
export const REQUEST_SIZE_DEFAULTS: Readonly<RequestSizeSettings> = Object.freeze({
  charsPerToken: 4,
  calibrationReadings: 4,
  minPlausibleCharsPerToken: 1,
  maxPlausibleCharsPerToken: 8,
});

/** Carrying on a reply that stopped at its ceiling mid-answer. */
export interface ContinuationSettings {
  /**
   * How many more requests `continueTurn` gives one answer. The cap is what stops a model that
   * never reaches a stop token from looping on the ceiling.
   */
  maxContinuations: number;
  /** How much of the answer's opening, in characters, a continuation has to repeat to have started over. */
  restartProbeChars: number;
  /** The shortest opening, in characters, worth testing for a restart; shorter ones are repeated by chance. */
  restartMinChars: number;
}

/** How far `continueTurn` carries an answer on, and how it tells a server that started over. */
export const CONTINUATION_DEFAULTS: Readonly<ContinuationSettings> = Object.freeze({
  maxContinuations: 1,
  restartProbeChars: 40,
  restartMinChars: 12,
});

/** Reading a model's tool calls, and reporting them to a watcher. */
export interface ToolCallSettings {
  /** How much of a call's unreadable arguments, in characters, an error quotes back. */
  argumentPreviewChars: number;
  /**
   * How much of a long tool argument or result, in characters, `preview` keeps for an event. The
   * transcript always carries the whole of it.
   */
  eventPreviewChars: number;
  /** How many times a minter is asked for an id not already taken before it is given up on. */
  mintAttempts: number;
}

/** How much of a call is quoted back, and how hard an unused id is looked for. */
export const TOOL_CALL_DEFAULTS: Readonly<ToolCallSettings> = Object.freeze({
  argumentPreviewChars: 200,
  eventPreviewChars: 2000,
  mintAttempts: 32,
});

/** A side task: one short call that supports an exchange without being one. */
export interface SideTaskSettings {
  /** The reply's ceiling, in tokens. These answers are meant to be short. */
  maxTokens: number;
  /**
   * Sampling temperature. Naming and classifying want the same answer twice, so it is the side
   * task's own and never the agent's.
   */
  temperature: number;
  /**
   * How many times a lost request is sent again.
   *
   * @remarks
   * Not the exchange's `maxRetries`, which defaults to none: a side task is small, and a lost one
   * that is not sent again costs the exchange a title or a shortlist for one dropped connection.
   */
  maxRetries: number;
}

/** What `ask`, `askJson` and the side tasks built on them send where their caller does not say. */
export const SIDE_TASK_DEFAULTS: Readonly<SideTaskSettings> = Object.freeze({
  maxTokens: 512,
  temperature: 0.3,
  maxRetries: 2,
});

/** Choosing an exchange's tools before it starts, by a small model or by the request's own words. */
export interface PreselectSettings {
  /** The preselector's reply ceiling, in tokens: a short JSON list of names. */
  maxTokens: number;
  /**
   * Where a request is cut for the preselector, in characters.
   *
   * @remarks
   * A tool choice is made on what the work is, which is the top of a request rather than all of
   * it — and the whole of a long one is paid for again in the preselection call.
   */
  maxPromptChars: number;
  /**
   * The least BM25 score a best match may have and still be acted on without a model.
   *
   * @remarks
   * A score, so it is read against the shape of the corpus rather than as a percentage: a query
   * term carried by half the catalogue is worth about 0.7, and one carried by a single tool about
   * 3. One at this floor is therefore "something more distinctive than a word every other tool
   * uses", which is the weakest evidence worth skipping a round trip on. A catalogue of three or
   * four tools rarely clears it, which is right: one that small is not worth choosing from.
   */
  keywordMinScore: number;
  /**
   * How far below the last picked tool the best unpicked one must score, as a share of it, for the
   * cut to count as clean.
   *
   * @remarks
   * The cap is the only reason a hit is dropped, so a hit just under it scoring nearly as much as
   * one just above means the ranking chose arbitrarily, which is the case a model is for.
   */
  keywordDropoffShare: number;
  /**
   * BM25's term saturation, Robertson's usual value.
   *
   * @remarks
   * Not tuned for this corpus, because tuning against a catalogue of forty short documents would be
   * fitting noise. `keywordDropoffShare` and `keywordMinScore` are the knobs worth turning.
   */
  bm25K1: number;
  /** BM25's length normalisation, Robertson's usual value; see `bm25K1`. */
  bm25B: number;
  /** The longest word, in characters, the keyword match leaves its trailing `s` on: `bus` and `was` are not plurals. */
  shortestPluralChars: number;
}

/** How `preselect` and `preselectByKeywords` choose, where their caller does not say. */
export const PRESELECT_DEFAULTS: Readonly<PreselectSettings> = Object.freeze({
  maxTokens: 256,
  maxPromptChars: 2000,
  keywordMinScore: 1,
  keywordDropoffShare: 0.5,
  bm25K1: 1.2,
  bm25B: 0.75,
  shortestPluralChars: 3,
});

/** The tools the model is shown: how many it may pull in, keep, and read about. */
export interface ToolDiscoverySettings {
  /**
   * The most a single `load_tools` call may pull in, and the most a preselection may name.
   *
   * @remarks
   * A wildcard like `gmail__*` matches 33 tools, and loading them all puts the model right back in
   * the position on-demand loading exists to avoid — a tool array too large to choose from.
   * Over-broad requests are refused with the matching names listed, so the next call can be
   * precise. Twelve is what a small model chooses well from; a caller running a large one against
   * a large context window can say otherwise to `expandNames`, `preselection` and
   * `preselectSystem`.
   */
  maxPerLoad: number;
  /**
   * The most tools a conversation carries between exchanges. Bounds the tool array no matter how
   * long the conversation runs; past it, the earliest-declared names this exchange did not use fall
   * off first. `carryOver` takes a cap of its own as `max`.
   */
  maxCarried: number;
}

/** The caps on-demand tool loading was written with. */
export const TOOL_DISCOVERY_DEFAULTS: Readonly<ToolDiscoverySettings> = Object.freeze({
  maxPerLoad: 12,
  maxCarried: 16,
});

/** Compaction: the oldest stretch of a transcript folded into a summary the model writes itself. */
export interface CompactionSettings {
  /**
   * The summary's ceiling, in tokens, as `summariser` asks for it, and what `planCompaction`
   * assumes a summary will cost when it plans to a `target`.
   */
  summaryTokens: number;
  /** How much of any one message, in characters, the summariser is shown. A pasted file is not worth it whole. */
  summaryMessageChars: number;
  /** The fewest messages worth compacting: a summary of one costs a round trip and saves nothing. */
  fewestCompactedMessages: number;
}

/** When and how far a transcript is compacted, where the caller does not say. */
export const COMPACTION_DEFAULTS: Readonly<CompactionSettings> = Object.freeze({
  summaryTokens: 1024,
  summaryMessageChars: 4000,
  fewestCompactedMessages: 2,
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
