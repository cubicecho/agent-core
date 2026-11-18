/**
 * Every value this package chose where another choice would still work, grouped by what it tunes.
 *
 * A limit, a wait, a share of the context window, a retry count: each is a member of one group.
 * A leaf with no imports, so the browser-safe `spec/` modules can read it too. Each group is named
 * for the concept it tunes, is frozen, and holds plain JSON values, so a group can be printed,
 * compared, or later filled from a host's own settings without touching the code that reads it.
 * The facts that could not be otherwise are in `consts.ts`.
 */

/**
 * The client pool: how many model servers' clients are kept, and how long what they said is
 * believed. Set for a process by `configureClients`, or a runtime's `clients`.
 */
export interface ClientPoolSettings {
  /**
   * How many model servers' clients are kept at once. The least recently asked for goes first.
   *
   * @remarks
   * A backstop rather than a design. The key includes the API key, and every argument for what
   * bounds the client caches is "a settings row's worth" — true of the deployments this was
   * written for, and false the moment a consumer mints a key per *user*, where the map grows one
   * client and one connection pool per tenant for the life of the process. Thirty-two is far more
   * model servers than a settings table holds, so a deployment-shaped consumer never reaches it,
   * and an evicted client costs its connection pool and nothing else. See `getClient`.
   */
  maxClients: number;
  /**
   * How long, in milliseconds, a model missing from a server's listing — or a served context window
   * or slot count a server's own API gave, or an error other than a missing route from its
   * `/api/v0/models` — is taken at its word before the model server is asked again.
   */
  listingMissMs: number;
  /**
   * How long, in milliseconds, one `contextLimitFor`, `servedWindow` or `listModels` may take over
   * all of its requests. A model server's own request timeout still applies where it is shorter.
   *
   * @remarks
   * Its own number because `requestTimeoutSeconds` is how long to wait for a model to speak, and a
   * listing that has not answered in ten seconds is not going to.
   */
  lookupTimeoutMs: number;
}

/** The bounds the client pool was written with, until `configureClients` moves them. */
export const CLIENT_POOL_DEFAULTS: Readonly<ClientPoolSettings> = Object.freeze({
  maxClients: 32,
  listingMissMs: 30_000,
  lookupTimeoutMs: 10_000,
});

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
  /**
   * The smallest context window, in tokens, worth believing in, and the floor under `runTurn`'s
   * guard.
   *
   * @remarks
   * `runTurn`'s `contextLimit` reads it as a sanity check on a number it was handed: below this,
   * the limit is taken for a placeholder — an unset column, a listing that said nothing — rather
   * than a context window worth refusing an exchange over. `contextLimitFor` asks the model server
   * whatever the number.
   *
   * A model with a context window smaller than this exists, and the reason not to refuse an
   * exchange over one is that the number far more often came from a caller threading a placeholder
   * through than from such a model. A request that really does overrun a tiny context window is
   * left to the model server's own complaint, which `isOverflow` reads properly either way — so
   * what the floor costs is a round trip on the exchanges it declines to guard, and what it saves
   * is refusing the ones it would have guarded wrongly.
   */
  smallestLikelyWindowTokens: number;
}

/** The ratio a request is sized by, and the bounds a measured one is held to. */
export const REQUEST_SIZE_DEFAULTS: Readonly<RequestSizeSettings> = Object.freeze({
  charsPerToken: 4,
  calibrationReadings: 4,
  minPlausibleCharsPerToken: 1,
  maxPlausibleCharsPerToken: 8,
  smallestLikelyWindowTokens: 8192,
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
  /**
   * The most of one server's instructions, in estimated tokens, `serverInstructionsPrompt` carries.
   *
   * @remarks
   * Most servers send a paragraph or two; this leaves room for a long one and stops a server that
   * pasted its README from crowding out the operator's prompt and the catalogue after it.
   */
  serverInstructionTokens: number;
}

/** The caps on-demand tool loading was written with. */
export const TOOL_DISCOVERY_DEFAULTS: Readonly<ToolDiscoverySettings> = Object.freeze({
  maxPerLoad: 12,
  maxCarried: 16,
  serverInstructionTokens: 1000,
});

/** Hooks: what the context they inject is held to. Set for a process by `configureHooks`. */
export interface HookSettings {
  /**
   * The most context, in estimated tokens, all of a request's injecting hooks add between them,
   * when a call does not give its own budget. Each hook is still held to its own `maxTokens` inside
   * it.
   *
   * @remarks
   * Enough for a handful of recalled memories, and small against any context window worth running
   * an agent in. The point is that a generous hook cannot crowd out the conversation it was meant
   * to inform. `gather` and `assembleContext` move it for one request.
   */
  contextTokens: number;
  /**
   * Said once above the context blocks, so the model reads them as background rather than
   * instructions, when a call does not give its own. Empty says nothing, and the blocks lead the
   * question on their own. Names no app; `withContext` sets another for one request.
   */
  preface: string;
}

/** The hook settings this package was written with, until `configureHooks` moves them. */
export const HOOK_DEFAULTS: Readonly<HookSettings> = Object.freeze({
  contextTokens: 2000,
  preface:
    "The <context> blocks below were added for this message by the host's hooks. They are " +
    "background the user did not write and may not be relevant. The user's message follows them.",
});

/** Compaction: the oldest stretch of a transcript folded into a summary the model writes itself. */
export interface CompactionSettings {
  /** The share of the context window in use before a summary is worth its own round trip. */
  compactAtShare: number;
  /**
   * The share of the context window the kept tail may fill, leaving room for the exchange to grow
   * again.
   */
  keepShare: number;
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
  compactAtShare: 0.75,
  keepShare: 0.35,
  summaryTokens: 1024,
  summaryMessageChars: 4000,
  fewestCompactedMessages: 2,
});

/** Pruning: old tool results in a transcript replaced by a one-line stub. */
export interface PruneSettings {
  /** How many of the latest tool results a prune leaves whole. */
  keepLastResults: number;
  /** A result this long or shorter, in characters, is left whole wherever it is: a stub would save nothing. */
  maxKeptChars: number;
  /**
   * The share of the context window a prune has to win back on its own before it is worth the
   * prompt cache it costs. Below it the request after a prune is barely smaller than the one
   * before, and every token of it is processed again anyway.
   */
  minShare: number;
}

/** What a prune leaves whole, where the caller does not say. */
export const PRUNE_DEFAULTS: Readonly<PruneSettings> = Object.freeze({
  keepLastResults: 5,
  maxKeptChars: 256,
  minShare: 0.1,
});

/** The token ledger: what each request cost, and whether its prompt cache held. */
export interface TokenLedgerSettings {
  /**
   * The share of the previous prompt a cache that kept its prefix reports as hit. Short of it by
   * more than this is a break, not the few tokens a template re-renders at the join.
   */
  cacheKeptShare: number;
}

/** How the ledger tells a kept cache from a broken one. */
export const TOKEN_LEDGER_DEFAULTS: Readonly<TokenLedgerSettings> = Object.freeze({
  cacheKeptShare: 0.9,
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

/**
 * The event bus: what it keeps of a run, and for how long. Set for a process by
 * `configureEvents`, or a runtime's `events`.
 */
export interface EventBusSettings {
  /** How many events one run keeps for a watcher that joins late. A chatty run loses its oldest. */
  maxEvents: number;
  /**
   * How far past the cap the backlog is allowed to run before it is trimmed.
   *
   * @remarks
   * Dropping the oldest event on every push means shifting a thousand-element array tens of
   * thousands of times over a reasoning run — the one thing in the bus that would ever show up in
   * a profile. Trimming in batches makes it a few dozen splices instead, at the cost of the backlog
   * sometimes being a little longer than the cap, which nothing depends on. The one field here
   * that is an implementation detail rather than a policy: raising it trades memory for fewer
   * splices, and there is no reason to lower it.
   */
  trimSlack: number;
  /** How long, in milliseconds, a finished run stays readable, for a watcher that arrives just after the end. */
  retainMs: number;
  /**
   * The same for a run that has not said `done`, which is a far more dangerous thing to drop.
   *
   * @remarks
   * `touched` only moves on `emit`, so a live run inside one slow tool call looks abandoned, and the
   * next `emit` after a reap restarts `seq` at zero, which a reconnecting client discards as events it
   * has seen. Anything shorter than the longest a tool call may take reaps a live run out from under
   * itself. The sweep still reaps these, as the backstop for a run killed or forgotten before `done`;
   * `endRun` is for a caller that knows. Thirty minutes.
   */
  retainUnendedMs: number;
  /**
   * The same for a run whose last event is `wait`: one that handed calls back and stopped until
   * they are answered, under the same id and the same numbering.
   *
   * @remarks
   * A wait is a planned silence as long as the person answering takes, and the client watching it
   * has usually gone by the time the run resumes. Reaping it on `retainUnendedMs` restarted `seq`,
   * so a client reconnecting across the wait discarded the resumed run's events, `done` included.
   * A day.
   */
  retainWaitingMs: number;
}

/** The numbers a run of the shape the bus was written for wants, until `configureEvents` moves them. */
export const EVENT_BUS_DEFAULTS: Readonly<EventBusSettings> = Object.freeze({
  maxEvents: 1000,
  trimSlack: 256,
  retainMs: 60_000,
  retainUnendedMs: 1_800_000,
  retainWaitingMs: 86_400_000,
});

/**
 * What an agent document falls back to where no layer said anything at all, as
 * `resolveAgentSpec` resolves it.
 *
 * @remarks
 * Not sentinels, and not invented: `toolDiscovery`, `maxRetries` and `contextLength` are the
 * "absent everywhere" column of the document's own table, and `temperature` and
 * `maxToolIterations` are what all three consumers store as their defaults. A field left out here
 * is left out of the resolved object too, which is how `requestTimeoutSeconds` keeps meaning "no
 * opinion".
 */
export interface AgentSettings {
  /** The main model's sampling temperature. */
  temperature: number;
  /** The reply's ceiling, in tokens. Zero sends none, leaving the reply's length to the model server. */
  maxTokens: number;
  /** The model's context window, in tokens. Zero is unknown, and is asked of the model server. */
  contextLength: number;
  /**
   * How tool definitions reach the model: one of `ToolDiscovery`, spelled out here because this
   * module imports nothing.
   */
  toolDiscovery: 'eager' | 'ondemand' | 'proxy';
  /** How many tool rounds one exchange may take before it is stopped. */
  maxToolIterations: number;
  /** Re-sends of a request lost before the model produced anything. Zero is none. */
  maxRetries: number;
}

/** What `resolveAgentSpec` gives a field no layer set. */
export const AGENT_DEFAULTS: Readonly<AgentSettings> = Object.freeze({
  temperature: 0.7,
  maxTokens: 0,
  contextLength: 0,
  toolDiscovery: 'eager',
  maxToolIterations: 20,
  maxRetries: 0,
});
