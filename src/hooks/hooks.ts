import type OpenAI from 'openai';
import { digestOf } from '../core/digest.ts';
import { isPositive } from '../core/guards.ts';
import { assignSettings, scoped } from '../core/scope.ts';
import { errorMessage } from '../wire/errors.ts';
import { attribute, textOf } from '../wire/text.ts';
import { clipToTokens, estimateTokens } from '../wire/tokens.ts';
import { PartType, Role } from '../wire/wire.ts';
import { type HookEvent, INJECT_EVENTS } from './hook-events.ts';

/**
 * Lifecycle hooks, from the app's side: what a session looks like to them, where their context
 * lands in a request, and what is said about each one.
 *
 * Running a hook is not here. What a hook *is* — an MCP tool call in `@cubicecho/agent-mcp-pool`,
 * something else in another app — is the runner's business, and this takes the runner as a
 * function. The types are the pool's shapes restated rather than imported, so the pool's
 * `runHooks` is a runner as it stands and its outcomes pass straight through, without this
 * package depending on it.
 */

/**
 * One message of a session as a hook is handed it. The shape a memory server's `remember` takes,
 * so a template can pass an exchange straight through.
 */
export interface HookMessage {
  speaker: string;
  text: string;
  /** Stable across retries, so a server that dedups on it files a re-sent message once. */
  uuid: string;
}

/**
 * What an app knows at an event. Every field but `session` is optional because no event carries
 * all of them.
 */
export interface HookContext {
  session: { id: string };
  /** Which program is running the session, for a hook shared by several. */
  host?: string;
  /** ISO 8601. */
  now?: string;
  /** The user's message this exchange, or the session's opening one. */
  prompt?: string;
  /** The assistant's final text. */
  reply?: string;
  turn?: {
    /** Which exchange of the session this is, from 0. See `turnIndex`. */
    index: number;
    /** The exchange's user and assistant text, tool traffic left out. See `turnMessages`. */
    messages?: HookMessage[];
  };
  /** The messages about to be summarised away. */
  compacting?: HookMessage[];
  /** Message indexes of that range, `through` exclusive. */
  range?: { from: number; through: number };
  /** How the exchange ended. */
  status?: 'ok' | 'stopped' | 'error';
  /** The app's own extras — a card id, a task stage. */
  vars?: Record<string, unknown>;
}

/** What one hook did. A runner returns one per hook it considered, in configuration order. */
export interface HookOutcome {
  /** Whatever the hook belongs to — for the pool, the server row. Together with `hookId`, unique. */
  serverId: string;
  /** What an injected block and a note call it. */
  label: string;
  hookId: string;
  event: HookEvent;
  /** The hook ran and did not report an error. */
  ok: boolean;
  /** What it returned. Absent when it returned nothing, and when it failed. */
  text?: string;
  /** Why it failed or was skipped. */
  error?: string;
  /** Set when the hook never ran. */
  skipped?: boolean;
  /** Wall time, dispatch to answer. */
  ms: number;
  /** Hand `text` to the model. Only honoured on `INJECT_EVENTS`. */
  inject: boolean;
  /** The most of `text` that is injected, in estimated tokens. */
  maxTokens: number;
  /**
   * Asks that what the event announces not happen. Only a `beforeCompact` hook's is read, and
   * only by an app that waits for it — see `consult` — and never on an outcome that is not `ok`,
   * since a hook that crashed has not said anything.
   */
  veto?: boolean;
}

/** Hears each `HookNote` as it is made, the one signature every function that raises them takes. */
export type OnNote = (note: HookNote) => void;

/**
 * One hook's line for whoever is watching: the context it added, or why it added none. A hook
 * that worked and added nothing gets no note — a remember that succeeded is not news.
 */
export interface HookNote {
  event: HookEvent;
  /** The outcome's `label`. */
  source: string;
  hookId: string;
  /** Estimated tokens of context it added to the request. */
  tokens?: number;
  /** The context it added, as the model read it: after the cap, without the `<context>` tags. */
  text?: string;
  /** Why it added nothing: it failed, timed out, or never ran. */
  error?: string;
  /** Set when the hook vetoed what the event announced, and was waited for. See `consult`. */
  veto?: true;
}

/**
 * Runs one event's hooks. Should resolve rather than reject — a hook failing is an outcome — but
 * `gather` and `notify` survive one that does not.
 *
 * @remarks
 * The pool's `runHooks` fits as it is; wrap it to pass its scope or `onNotice`.
 */
export type HookRunner = (
  event: HookEvent,
  context: HookContext,
  options: { signal?: AbortSignal },
) => Promise<readonly HookOutcome[]>;

/** The context a set of outcomes adds to a request, and a note for each hook worth mentioning. */
export interface Gathered {
  /** The `<context>` blocks, blank-line separated, or empty when no hook added anything. */
  context: string;
  notes: HookNote[];
}

/**
 * The most context all of a request's hooks add between them by default, in estimated tokens.
 *
 * @remarks
 * Enough for a handful of recalled memories, and small against any context window worth running an
 * agent in. The point is that a generous hook cannot crowd out the conversation it was meant to
 * inform. `configureHooks` moves it for a process, and `gather` and `assembleContext` for
 * one request.
 */
export const HOOK_CONTEXT_TOKENS = 2000;

/**
 * Said once, above the blocks, so the model reads them as background rather than instructions.
 * Names no app; `configureHooks` sets another for a process that wants to, and `withContext`
 * for one request.
 */
export const HOOK_PREFACE =
  "The <context> blocks below were added for this message by the host's hooks. They are " +
  "background the user did not write and may not be relevant. The user's message follows them.";

/** What hooks are held to across a process. Every field optional; see `configureHooks`. */
export interface HookOptions {
  /**
   * The budget every injecting hook shares, when a call does not give its own. Each hook is still
   * held to its own `maxTokens` inside it.
   */
  contextTokens?: number;
  /**
   * Said above the context blocks, when a call does not give its own. Empty says nothing, and the
   * blocks lead the question on their own.
   */
  preface?: string;
}

/** The settings this module was written with. */
const HOOK_DEFAULTS: Required<HookOptions> = {
  contextTokens: HOOK_CONTEXT_TOKENS,
  preface: HOOK_PREFACE,
};

/** What is in force now. Read where it is used, so a change applies from the next request. */
const hookSettings = scoped((): Required<HookOptions> => ({ ...HOOK_DEFAULTS }));

/**
 * The check each hook setting's value must pass, one for every member of `HookOptions`.
 *
 * @remarks
 * A map rather than an object, because the key is whatever a caller's config held and an object
 * would look `constructor` up on its prototype.
 */
const USABLE_BY_SETTING: ReadonlyMap<string, (value: unknown) => boolean> = new Map(
  Object.entries({
    contextTokens: isPositive,
    preface: (value: unknown) => typeof value === 'string',
  } satisfies Record<keyof HookOptions, (value: unknown) => boolean>),
);

/**
 * Whether a value may be a hook setting: a budget above zero, or a preface that is a string.
 *
 * @param value - What a caller gave for the setting, of any type.
 * @param name - Which setting it was given for. One that is neither `preface` nor `contextTokens`
 * is never usable.
 * @returns `true` when the value may be written under that name. `Infinity` is a usable budget and
 * an empty string a usable preface.
 */
const usableHookSetting = (value: unknown, name: string) => USABLE_BY_SETTING.get(name)?.(value) ?? false;

/**
 * Changes what hooks are held to, for a process whose context windows are not the size these
 * defaults were chosen for, or whose app wants its own name above the context.
 *
 * @param [options] - The settings to change. A field left out keeps what it has, and so does one given
 * the wrong kind of value — `contextTokens` anything but a number above zero, `preface` anything
 * but a string — so a half-built config narrows nothing. `Infinity` is a number above zero, and
 * lifts the shared budget entirely. An empty `preface` is a string, and turns the preface off.
 * @returns Everything in force afterwards, including what this call did not change.
 *
 * @remarks
 * One setting per runtime for the same reason `configureEvents` is: a budget and a preface are a
 * deployment's settings, said once at startup. A caller that sizes the budget per model or per
 * agent — a 128k context window can afford more recall than an 8k one — passes `maxTokens` to
 * `gather` instead, and a `preface` passed to `withContext` or `runAgentLoop`'s hooks wins over
 * this one the same way.
 */
export function configureHooks(options: HookOptions = {}): Required<HookOptions> {
  return assignSettings(hookSettings(), options, usableHookSetting);
}

/**
 * Test seam: puts `configureHooks` back to the defaults, so one test's budget or preface is not the
 * next's.
 * `resetAll` calls it.
 */
export const resetHooks = () => {
  hookSettings.reset();
};

/**
 * The budget a call is held to: its own when it gave a usable one, the process's otherwise.
 *
 * @param [given] - The call's own budget, in estimated tokens. Absent, zero, negative or `NaN` is
 * no opinion.
 * @returns `given` when it is a number above zero, `Infinity` included, otherwise what
 * `configureHooks` last set.
 *
 * @remarks
 * The same rule `configureHooks` applies, so a `0` threaded through for "no opinion" does not
 * quietly turn every hook's context off.
 */
const budget = (given?: number) => (isPositive(given) ? given : hookSettings().contextTokens);

/**
 * What every note about an outcome opens with: which hook it was, and on which event.
 *
 * @param outcome - The outcome the note is about. Read, not kept.
 * @returns A new object holding `event`, `source` — the outcome's `label` — and `hookId`, for the
 * caller to spread the rest of the note onto.
 */
const noteOf = (outcome: HookOutcome) => ({
  event: outcome.event,
  source: outcome.label,
  hookId: outcome.hookId,
});

/**
 * The note a failed outcome leaves, the same whichever of the three callers reports it.
 *
 * @param outcome - An outcome that is not `ok`. That is the caller's to have checked; nothing here
 * does.
 * @returns The note, its `error` the outcome's own, or `failed` where it gave none.
 */
const failureNote = (outcome: HookOutcome): HookNote => ({
  ...noteOf(outcome),
  error: outcome.error ?? 'failed',
});

/**
 * Builds the context a set of outcomes adds and the notes that go with it.
 *
 * @param outcomes - What the runners returned. An injecting outcome on an event that cannot inject
 * adds nothing; a failed one is noted wherever it falls, including past the budget.
 * @param [maxTokens] - The budget every block shares. Absent, or not a number above zero, is what
 * `configureHooks` last set — `HOOK_CONTEXT_TOKENS` unless something moved it.
 * @returns The blocks joined by a blank line — an empty string when nothing was injected — and the
 * notes in the order of `outcomes`.
 *
 * @remarks
 * Each injected outcome is wrapped in `<context source="…">` naming its label, so a model reading
 * a recalled line can tell it is a memory rather than something the user said. Each is held to
 * its own `maxTokens` and the whole to `maxTokens` here, and a block past the total is dropped
 * whole rather than cut to a stub. For any hooks the pool's `validateHooks` accepts, the text is
 * what its `contextBlocks` builds from the same outcomes, character for character, so an app
 * moving between the two sends the same request.
 *
 * The note keeps each hook's text as it was cut, so an app can show exactly what the model was
 * given without re-deriving the caps or parsing the wrapper back off.
 */
export function assembleContext(outcomes: readonly HookOutcome[], maxTokens?: number): Gathered {
  const blocks: string[] = [];
  const notes: HookNote[] = [];
  let remaining = budget(maxTokens);
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      notes.push(failureNote(outcome));
      continue;
    }
    if (!outcome.inject || !INJECT_EVENTS.has(outcome.event)) {
      continue;
    }
    let text = outcome.text?.trim();
    if (!text) {
      continue;
    }
    const cap = Math.min(outcome.maxTokens, remaining);
    if (cap <= 0) {
      continue;
    }
    if (estimateTokens(text) > cap) {
      text = clipToTokens(text, cap);
    }
    const tokens = estimateTokens(text);
    remaining -= tokens;
    blocks.push(`<context source="${attribute(outcome.label)}">\n${text}\n</context>`);
    notes.push({ ...noteOf(outcome), tokens, text });
  }
  return { context: blocks.join('\n\n'), notes };
}

/**
 * The request, with the hooks' context added to this exchange's question.
 *
 * @param history - The request's messages. Neither the array nor any message in it is changed.
 * @param index - Where the question sits in `history` — which is not where it sits in the
 * session once a compaction has replaced the head with a summary. Anything but a user message there
 * leaves the request as it was.
 * @param context - What `assembleContext` built, this exchange or the one the question was asked
 * in. Empty returns `history` itself.
 * @param [preface] - Said above the blocks. Empty says nothing, rather than leaving a blank line
 * where it was.
 * @returns `history` when there was nothing to add or nowhere to add it, otherwise a new array.
 *
 * @remarks
 * It goes on the question and not in the system prompt, because it is about the question — and a
 * system prompt that changed with every question would miss the prompt cache every time. Nothing is
 * written back: an app that stores what the user typed never remembers the context as something
 * they said.
 *
 * A question keeps its context for as long as it is sent. An app stores `context`, and the preface
 * it was said under, beside the question and calls this for each stored one on every later request
 * — a question sent with its blocks one request and bare the next is a different prompt from that
 * message on, and loses the server's prefix cache behind it.
 */
export function withContext(
  history: OpenAI.ChatCompletionMessageParam[],
  index: number,
  context: string,
  preface = hookSettings().preface,
): OpenAI.ChatCompletionMessageParam[] {
  const message = history[index];
  if (!context || message?.role !== Role.User) {
    return history;
  }
  const lead = preface ? `${preface}\n\n${context}\n\n` : `${context}\n\n`;
  const content: OpenAI.ChatCompletionUserMessageParam['content'] =
    typeof message.content === 'string'
      ? `${lead}${message.content}`
      : [{ type: PartType.Text, text: lead }, ...message.content];
  return history.map((item, at) => (at === index ? { ...message, content } : item));
}

/** How much of a message's digest its uuid carries: enough to tell two texts at one position apart. */
const UUID_DIGEST_CHARS = 12;

/**
 * A stretch of a transcript as a hook reads it: what the user and the assistant said, and nothing
 * else.
 *
 * @param sessionId - Prefixes every uuid, so two sessions never share one.
 * @param messages - The transcript, in whatever shape the app stores it, so long as each message
 * has an OpenAI-style `role` and `content`.
 * @param from - The first index, inclusive. Below zero reads from the start.
 * @param [to] - The end, exclusive. Absent, or past the end, reads to the end.
 * @param [options] - `offset` is what the array's first message is numbered as in the uuids — the
 * stored index of `messages[0]`, when `messages` is a request a compaction has shifted. Zero
 * numbers by position. `from` and `to` stay array indexes either way.
 * @returns One entry per user or assistant message in the range that has text once trimmed, in
 * transcript order. Empty when there is none.
 *
 * @remarks
 * Tool calls and their results are left out: they are the model's working and most of the
 * characters, and a memory server filing them would recall a directory listing ahead of the
 * decision it led to. The uuid is the session, the position and a digest of the text, so an answer
 * a retry replaced at the same index is a new memory, two identical "ok"s are two, and the same
 * message sent twice is one. The position is the array's, so once a compaction has shifted a
 * request, `offset` puts the numbering back on the app's own indexes.
 */
export function turnMessages(
  sessionId: string,
  messages: readonly { role: string; content?: unknown }[],
  from: number,
  to?: number,
  { offset = 0 }: { offset?: number } = {},
): HookMessage[] {
  const end = Math.min(to ?? messages.length, messages.length);
  const out: HookMessage[] = [];
  for (let at = Math.max(0, from); at < end; at++) {
    const message = messages[at];
    if (message.role !== Role.User && message.role !== Role.Assistant) {
      continue;
    }
    const text = textOf(message.content).trim();
    if (!text) {
      continue;
    }
    const digest = digestOf(`${message.role}\0${text}`);
    out.push({
      speaker: message.role,
      text,
      uuid: `${sessionId}:${at + offset}:${digest.slice(0, UUID_DIGEST_CHARS)}`,
    });
  }
  return out;
}

/**
 * Which exchange of a session begins at a point, from 0: the user messages ahead of it.
 *
 * @param messages - The transcript.
 * @param [before] - Where the exchange begins.
 * @param [offset] - Exchanges already compacted away and so not in `messages`.
 * @returns `offset` plus the count of user messages before `before`.
 *
 * @remarks
 * Counted over what it is given, which is the session only while nothing has been compacted away
 * — a compacted request has lost the questions the summary now stands for, and exchange eleven
 * counting itself as exchange two is the kind of thing a hook writes into a memory. Count over the
 * stored transcript, or add what the compaction took as `offset`. The compaction's own summary is a
 * user message too, and is counted like one.
 */
export const turnIndex = (messages: readonly { role: string }[], before = messages.length, offset = 0) =>
  offset + messages.slice(0, before).filter((message) => message.role === Role.User).length;

/**
 * A runner that rejected, as the one outcome its event can still be noted by.
 *
 * @param event - The event the runner was running.
 * @param error - What it threw or rejected with. An `Error` gives its message, anything else its
 * string form.
 * @returns An outcome that is not `ok` and injects nothing, with `serverId`, `label` and `hookId`
 * all empty, since no one hook is to blame.
 */
const rejected = (event: HookEvent, error: unknown): HookOutcome => ({
  serverId: '',
  label: '',
  hookId: '',
  event,
  ok: false,
  error: errorMessage(error),
  ms: 0,
  inject: false,
  maxTokens: 0,
});

/**
 * Runs one event's hooks through a runner that may not keep its word about resolving.
 *
 * @param run - The runner. Called inside the chain, so one that throws before returning a promise
 * is caught the same as one that rejects.
 * @param event - The event to run.
 * @param context - What the hooks are told.
 * @param [signal] - Handed to the runner as it is. Absent leaves the runner nothing to stop on.
 * @returns A promise that never rejects: the runner's outcomes, or the single `rejected` outcome
 * when it threw or rejected.
 */
const runSafely = (run: HookRunner, event: HookEvent, context: HookContext, signal?: AbortSignal) =>
  Promise.resolve()
    .then(() => run(event, context, { signal }))
    .catch((error: unknown) => [rejected(event, error)]);

/**
 * Hands each note to an app's `onNote`, for the callers that promise never to reject.
 *
 * @param notes - What to tell, in order.
 * @param [onNote] - The app's listener. A throw on one note is dropped, and the next note is still told.
 */
const tellSafely = (notes: readonly HookNote[], onNote?: OnNote) => {
  for (const note of notes) {
    // The listener is the only place a failure here could be reported, so it goes unsaid.
    try {
      onNote?.(note);
    } catch {}
  }
};

/**
 * Runs the hooks ahead of a request and builds what they add to it.
 *
 * @param run - Runs one event's hooks.
 * @param events - Which to run: `["beforeExchange"]` ordinarily, and `sessionStart` ahead of it on a
 * session's first exchange. The outcomes are assembled in this order, so it is also the order the
 * budget is spent in.
 * @param context - What the hooks are told.
 * @param [options] - `signal` is handed to the runner, and should be the exchange's own: a user
 * who stopped the exchange stopped its recall. `onNote` hears each note as the whole is assembled,
 * and one it throws on is dropped.
 * `maxTokens` is the shared budget for this request, read as `assembleContext` reads it: absent
 * or unusable is the process's, from `configureHooks`.
 * @returns What `assembleContext` built from every event's outcomes together. Does not reject for a
 * runner or an `onNote` that did.
 *
 * @remarks
 * This is on the path of the first token, so the events run together rather than one after the
 * other, and a hook that fails costs the exchange its context and never the exchange — a runner
 * that rejects outright is noted once for its event, with an empty `hookId` and `source`, and the
 * rest go ahead. Bounding each hook's time is the runner's job; `signal` is how the exchange ends
 * all of them.
 */
export async function gather(
  run: HookRunner,
  events: readonly HookEvent[],
  context: HookContext,
  { signal, onNote, maxTokens }: { signal?: AbortSignal; onNote?: OnNote; maxTokens?: number } = {},
): Promise<Gathered> {
  const outcomes = await Promise.all(events.map((event) => runSafely(run, event, context, signal)));
  const gathered = assembleContext(outcomes.flat(), maxTokens);
  tellSafely(gathered.notes, onNote);
  return gathered;
}

/**
 * Runs the hooks for an event that reads what happened and adds nothing to a request. Never
 * rejects, so an app can fire it without awaiting it.
 *
 * @param run - Runs the event's hooks.
 * @param event - `afterExchange`, `beforeCompact`, `sessionEnd` or `sessionDelete`. An injecting event
 * works too, but what its hooks return is dropped, since there is no request here to add it to.
 * @param context - What the hooks are told.
 * @param [onNote] - Hears each note — which, with nothing injected, is only ever a failure. One it
 * throws on is dropped.
 * @returns The same notes.
 *
 * @remarks
 * No signal: these run once the exchange has been answered, and a reader who stops listening at
 * that point has not asked for the exchange not to be remembered. Nor is a `veto` read, since
 * whatever it would stop is already under way; `consult` is the one that waits for it.
 */
export async function notify(
  run: HookRunner,
  event: HookEvent,
  context: HookContext,
  onNote?: OnNote,
): Promise<HookNote[]> {
  const outcomes = await runSafely(run, event, context);
  const notes = outcomes.filter((outcome) => !outcome.ok).map(failureNote);
  tellSafely(notes, onNote);
  return notes;
}

/**
 * Runs an event's hooks and waits for their say, for an app that will hold off when one of them
 * vetoes.
 *
 * @param run - Runs the event's hooks.
 * @param event - What is about to happen. Only `beforeCompact` has anything a veto can stop.
 * @param context - What the hooks are told.
 * @param [onNote] - Hears each note: every failure, and every veto, naming the hook that made it. One
 * it throws on is dropped.
 * @returns The same notes, and `vetoed` when any `ok` outcome carried `veto`.
 *
 * @remarks
 * `notify` runs beside the thing it announces and cannot stop it; this runs ahead of it, so each
 * hook's time is added to whatever waits on the answer. An app that does not mean to act on a
 * veto should call `notify` instead. Never rejects: a runner that throws is noted as a failure,
 * and a failure is not a veto — a memory server that is down has not asked for anything.
 */
export async function consult(
  run: HookRunner,
  event: HookEvent,
  context: HookContext,
  onNote?: OnNote,
): Promise<{ notes: HookNote[]; vetoed: boolean }> {
  const outcomes = await runSafely(run, event, context);
  const notes: HookNote[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      notes.push(failureNote(outcome));
    } else if (outcome.veto === true) {
      notes.push({ ...noteOf(outcome), veto: true });
    }
  }
  tellSafely(notes, onNote);
  return { notes, vetoed: notes.some((note) => note.veto) };
}
