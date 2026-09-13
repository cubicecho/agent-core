import { createHash } from "node:crypto";
import type OpenAI from "openai";
import { errorMessage } from "./errors.ts";
import { estimateTokens } from "./tokens.ts";

/**
 * Lifecycle hooks, from the host's side: what a session looks like to them, where their context
 * lands in a request, and what is said about each one.
 *
 * Running a hook is not here. What a hook *is* — an MCP tool call in `@cubicecho/agent-mcp-pool`,
 * something else in another host — is the runner's business, and this takes the runner as a
 * function. The types are the pool's shapes restated rather than imported, so the pool's
 * `runHooks` is a runner as it stands and its outcomes pass straight through, without this
 * package depending on it.
 */

/**
 * A point in a session a hook can be bound to. Named after Claude Code's hooks of the same shape
 * — `sessionStart` (SessionStart), `beforeTurn` (UserPromptSubmit), `afterTurn` (Stop),
 * `beforeCompact` (PreCompact), `sessionEnd` (SessionEnd) — plus `sessionDelete`, for when the host
 * deletes a session's record.
 */
export type HookEvent =
  | "sessionStart"
  | "beforeTurn"
  | "afterTurn"
  | "beforeCompact"
  | "sessionEnd"
  | "sessionDelete";

/** Every event a hook can be bound to, in the order a session meets them. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "sessionStart",
  "beforeTurn",
  "afterTurn",
  "beforeCompact",
  "sessionEnd",
  "sessionDelete",
];

/**
 * The events whose hooks run before a request, and so the only ones whose output can reach it.
 * Anything later runs once the model has already answered.
 */
export const INJECT_EVENTS: ReadonlySet<HookEvent> = new Set(["sessionStart", "beforeTurn"]);

/**
 * One message of a session as a hook is handed it. The shape a memory server's `remember` takes,
 * so a template can pass a turn straight through.
 */
export interface HookMessage {
  speaker: string;
  text: string;
  /** Stable across retries, so a server that dedups on it files a re-sent turn once. */
  uuid: string;
}

/**
 * What a host knows at an event. Every field but `session` is optional because no event carries
 * all of them.
 */
export interface HookContext {
  session: { id: string };
  /** Which program is running the session, for a hook shared by several. */
  host?: string;
  /** ISO 8601. */
  now?: string;
  /** The user's message this turn, or the session's opening one. */
  prompt?: string;
  /** The assistant's final text. */
  reply?: string;
  turn?: {
    /** Which turn of the session this is, from 0. See `turnIndex`. */
    index: number;
    /** The turn's user and assistant text, tool traffic left out. See `turnMessages`. */
    messages?: HookMessage[];
  };
  /** The messages about to be summarised away. */
  compacting?: HookMessage[];
  /** Message indexes of that range, `through` exclusive. */
  range?: { from: number; through: number };
  /** How a run ended. */
  status?: "ok" | "stopped" | "error";
  /** The host's own extras — a card id, a task step. */
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
}

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
}

/**
 * Runs one event's hooks. Should resolve rather than reject — a hook failing is an outcome — but
 * `gather` and `notify` survive one that does not.
 *
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
 * Enough for a handful of recalled memories, and small against any window worth running an agent
 * in. The point is that a generous hook cannot crowd out the conversation it was meant to inform.
 * `configureHooks` moves it for a process, and `gather` and `assembleContext` for one request.
 */
export const HOOK_CONTEXT_TOKENS = 2000;

/** What hooks are held to across a process. Every field optional; see `configureHooks`. */
export interface HookOptions {
  /**
   * The budget every injecting hook shares, when a call does not give its own. Each hook is still
   * held to its own `maxTokens` inside it.
   */
  contextTokens?: number;
}

/** The numbers this module was written with. */
const HOOK_DEFAULTS: Required<HookOptions> = { contextTokens: HOOK_CONTEXT_TOKENS };

/** What is in force now. Read where it is used, so a change applies from the next request. */
let hookLimits: Required<HookOptions> = { ...HOOK_DEFAULTS };

/**
 * Changes what hooks are held to, for a process whose windows are not the size these defaults
 * were chosen for.
 *
 * Module-level for the same reason `configureEvents` is: a budget is a deployment's setting, said
 * once at startup. A caller that sizes it per model or per agent — a 128k window can afford more
 * recall than an 8k one — passes `maxTokens` to `gather` instead, which wins over this.
 *
 * @param options The limits to change. A field left out — or given anything that is not a number
 * above zero — keeps what it has, so a half-built config narrows nothing. `Infinity` is a number
 * above zero, and lifts the shared budget entirely.
 * @returns Everything in force afterwards, including what this call did not change.
 */
export function configureHooks(options: HookOptions = {}): Required<HookOptions> {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value === "number" && value > 0) hookLimits[name as keyof HookOptions] = value;
  }
  return { ...hookLimits };
}

/**
 * Test seam: puts `configureHooks` back to the defaults, so one test's budget is not the next's.
 * `resetAll` calls it.
 */
export const resetHooks = () => {
  hookLimits = { ...HOOK_DEFAULTS };
};

/**
 * The budget a call is held to: its own when it gave a usable one, the process's otherwise. The
 * same rule `configureHooks` applies, so a `0` threaded through for "no opinion" does not quietly
 * turn every hook's context off.
 */
const budget = (given?: number) =>
  typeof given === "number" && given > 0 ? given : hookLimits.contextTokens;

/**
 * Said once, above the blocks, so the model reads them as background rather than instructions.
 * Names no host; `withContext` takes another for one that wants to.
 */
export const HOOK_PREFACE =
  "The <context> blocks below were added for this message by the host's hooks. They are " +
  "background the user did not write and may not be relevant. The user's message follows them.";

const attribute = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/**
 * Builds the context a set of outcomes adds and the notes that go with it.
 *
 * Each injected outcome is wrapped in `<context source="…">` naming its label, so a model reading
 * a recalled line can tell it is a memory rather than something the user said. Each is held to
 * its own `maxTokens` and the whole to `maxTokens` here, and a block past the total is dropped
 * whole rather than cut to a stub. For any hooks the pool's `validateHooks` accepts, the text is
 * what its `contextBlocks` builds from the same outcomes, character for character, so a host
 * moving between the two sends the same request.
 *
 * The note keeps each hook's text as it was cut, so a host can show exactly what the model was
 * given without re-deriving the caps or parsing the wrapper back off.
 *
 * @param outcomes What the runners returned. An injecting outcome on an event that cannot inject
 * adds nothing; a failed one is noted wherever it falls, including past the budget.
 * @param maxTokens The budget every block shares. Absent, or not a number above zero, is what
 * `configureHooks` last set — `HOOK_CONTEXT_TOKENS` unless something moved it.
 */
export function assembleContext(outcomes: readonly HookOutcome[], maxTokens?: number): Gathered {
  const blocks: string[] = [];
  const notes: HookNote[] = [];
  let remaining = budget(maxTokens);
  for (const outcome of outcomes) {
    const base = { event: outcome.event, source: outcome.label, hookId: outcome.hookId };
    if (!outcome.ok) {
      notes.push({ ...base, error: outcome.error ?? "failed" });
      continue;
    }
    if (!outcome.inject || !INJECT_EVENTS.has(outcome.event)) continue;
    let text = outcome.text?.trim();
    if (!text) continue;
    const cap = Math.min(outcome.maxTokens, remaining);
    if (cap <= 0) continue;
    if (estimateTokens(text) > cap) text = `${text.slice(0, cap * 4 - 1).trimEnd()}…`;
    const tokens = estimateTokens(text);
    remaining -= tokens;
    blocks.push(`<context source="${attribute(outcome.label)}">\n${text}\n</context>`);
    notes.push({ ...base, tokens, text });
  }
  return { context: blocks.join("\n\n"), notes };
}

/**
 * The request, with the hooks' context added to this turn's question.
 *
 * It goes on the question and not in the system prompt, because it is about the question — and a
 * system prompt that changed every turn would miss the prompt cache every turn. Nothing is written
 * back: a host that stores what the user typed never remembers the context as something they said.
 *
 * @param history The request's messages. Neither the array nor any message in it is changed.
 * @param index Where this turn's question sits in `history` — which is not where it sits in the
 * session once a compaction has folded the head into a summary. Anything but a user message there
 * leaves the request as it was.
 * @param context What `assembleContext` built. Empty returns `history` itself.
 * @param preface Said above the blocks. Defaults to `HOOK_PREFACE`.
 * @returns `history` when there was nothing to add or nowhere to add it, otherwise a new array.
 */
export function withContext(
  history: OpenAI.ChatCompletionMessageParam[],
  index: number,
  context: string,
  preface = HOOK_PREFACE,
): OpenAI.ChatCompletionMessageParam[] {
  const message = history[index];
  if (!context || message?.role !== "user") return history;
  const lead = `${preface}\n\n${context}\n\n`;
  const content: OpenAI.ChatCompletionUserMessageParam["content"] =
    typeof message.content === "string"
      ? `${lead}${message.content}`
      : [{ type: "text", text: lead }, ...message.content];
  return history.map((item, at) => (at === index ? { ...message, content } : item));
}

/** A message's text, whether its content is a string or a list of parts. */
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" && part.type !== "refusal" ? part.text : ""))
    .join("");
};

/**
 * A stretch of a transcript as a hook reads it: what the user and the assistant said, and nothing
 * else.
 *
 * Tool calls and their results are left out. They are the model's working rather than the
 * conversation, and most of a transcript's characters; a memory server that filed them would
 * recall a directory listing ahead of the decision it led to.
 *
 * The uuid is the session, the position and a digest of what was said. Position alone is not
 * stable — a retry cuts the transcript back and writes a new answer at the same index, and a
 * server deduping on it would keep the answer that was thrown away — and text alone would make
 * two identical "ok"s one memory. The same message sent twice, after its turn and again when it
 * is compacted, is one.
 *
 * @param sessionId Prefixes every uuid, so two sessions never share one.
 * @param messages The transcript, in whatever shape the host stores it, so long as each message
 * has an OpenAI-style `role` and `content`.
 * @param from The first index, inclusive. Below zero reads from the start.
 * @param to The end, exclusive. Absent, or past the end, reads to the end.
 */
export function turnMessages(
  sessionId: string,
  messages: readonly { role: string; content?: unknown }[],
  from: number,
  to?: number,
): HookMessage[] {
  const end = Math.min(to ?? messages.length, messages.length);
  const out: HookMessage[] = [];
  for (let at = Math.max(0, from); at < end; at++) {
    const message = messages[at];
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textOf(message.content).trim();
    if (!text) continue;
    const digest = createHash("sha256").update(`${message.role}\0${text}`).digest("hex");
    out.push({ speaker: message.role, text, uuid: `${sessionId}:${at}:${digest.slice(0, 12)}` });
  }
  return out;
}

/**
 * Which turn of a session begins at a point, from 0: the user messages ahead of it.
 *
 * @param messages The transcript.
 * @param before Where the turn begins. Absent is the end, which is the index of a turn whose
 * question has not been appended yet.
 */
export const turnIndex = (messages: readonly { role: string }[], before = messages.length) =>
  messages.slice(0, before).filter((message) => message.role === "user").length;

/** A runner that rejected, as the one outcome its event can still be noted by. */
const rejected = (event: HookEvent, error: unknown): HookOutcome => ({
  serverId: "",
  label: "",
  hookId: "",
  event,
  ok: false,
  error: errorMessage(error),
  ms: 0,
  inject: false,
  maxTokens: 0,
});

const runSafely = (run: HookRunner, event: HookEvent, context: HookContext, signal?: AbortSignal) =>
  Promise.resolve()
    .then(() => run(event, context, { signal }))
    .catch((error: unknown) => [rejected(event, error)]);

/**
 * Runs the hooks ahead of a request and builds what they add to it.
 *
 * This is on the path of the first token, so the events run together rather than one after the
 * other, and a hook that fails costs the turn its context and never the turn — a runner that
 * rejects outright is noted once for its event, with an empty `hookId` and `source`, and the rest
 * go ahead. Bounding each hook's time is the runner's job; `signal` is how the turn ends all of
 * them.
 *
 * @param run Runs one event's hooks.
 * @param events Which to run: `["beforeTurn"]` ordinarily, and `sessionStart` ahead of it on a
 * session's first turn. The outcomes are assembled in this order, so it is also the order the
 * budget is spent in.
 * @param context What the hooks are told.
 * @param options `signal` is handed to the runner, and should be the turn's own: a user who
 * stopped the turn stopped its recall. `onNote` hears each note as the whole is assembled.
 * `maxTokens` is the shared budget for this request, read as `assembleContext` reads it: absent
 * or unusable is the process's, from `configureHooks`.
 */
export async function gather(
  run: HookRunner,
  events: readonly HookEvent[],
  context: HookContext,
  {
    signal,
    onNote,
    maxTokens,
  }: { signal?: AbortSignal; onNote?: (note: HookNote) => void; maxTokens?: number } = {},
): Promise<Gathered> {
  const outcomes = await Promise.all(events.map((event) => runSafely(run, event, context, signal)));
  const gathered = assembleContext(outcomes.flat(), maxTokens);
  for (const note of gathered.notes) onNote?.(note);
  return gathered;
}

/**
 * Runs the hooks for an event that reads what happened and adds nothing to a request. Never
 * rejects, so a host can fire it without awaiting it.
 *
 * No signal: these run once the turn has been answered, and a reader who stops listening at that
 * point has not asked for the turn not to be remembered.
 *
 * @param run Runs the event's hooks.
 * @param event `afterTurn`, `beforeCompact`, `sessionEnd` or `sessionDelete`. An injecting event
 * works too, but what its hooks return is dropped, since there is no request here to add it to.
 * @param context What the hooks are told.
 * @param onNote Hears each note — which, with nothing injected, is only ever a failure.
 * @returns The same notes.
 */
export async function notify(
  run: HookRunner,
  event: HookEvent,
  context: HookContext,
  onNote?: (note: HookNote) => void,
): Promise<HookNote[]> {
  const outcomes = await runSafely(run, event, context);
  const notes = outcomes
    .filter((outcome) => !outcome.ok)
    .map((outcome) => assembleContext([outcome]).notes[0]);
  for (const note of notes) onNote?.(note);
  return notes;
}
