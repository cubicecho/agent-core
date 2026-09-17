import type OpenAI from "openai";
import type { Endpoint } from "./config.ts";
import {
  consult,
  type HookContext,
  type HookNote,
  type HookRunner,
  notify,
  turnMessages,
} from "./hooks.ts";
import { messageTokens } from "./retry.ts";
import { ask, type SideTaskOptions } from "./side-task.ts";

/**
 * Keeping a long run inside its window: stale tool results cleared, and the oldest stretch folded
 * into a summary the model writes itself.
 *
 * Both rewrite the transcript's prefix, and a prefix that changes is a prompt cache that misses —
 * on a local server that is the whole prompt processed again, every token of it. So neither is
 * meant to run a little on every turn: run them rarely, and together, at the point
 * `planCompaction` says the window is filling, and the cache is paid for once rather than on
 * every step.
 */

type Message = OpenAI.ChatCompletionMessageParam;

/** The fraction of the window in use before a summary is worth its own round trip. */
export const COMPACT_AT = 0.75;

/** The fraction of the window the kept tail may fill, leaving room for the run to grow again. */
export const KEEP_RATIO = 0.35;

/** How much of any one message the summariser is shown. A pasted file is not worth it whole. */
const SUMMARY_SLICE = 4000;

/**
 * The summariser's instruction when the caller gives none.
 *
 * Asks for notes rather than a retelling, because what the summary replaces is the model's only
 * record of what was decided, and a narrative spends its words on the order things happened in.
 */
export const SUMMARY_PROMPT =
  "You maintain the running memory of a long conversation. Rewrite the exchange below as " +
  "notes the assistant can rely on after the original messages are gone. Keep decisions, " +
  "facts, file paths, names, numbers, and anything still unresolved. Drop pleasantries and " +
  "anything already superseded. Write compact prose or bullets — no preamble, no sign-off.";

/**
 * How a summary message opens, which is also how `planCompaction` knows one from a system prompt.
 */
export const SUMMARY_LEAD =
  "Summary of the earlier part of this conversation, which is no longer shown in full:\n\n";

/** A message's content as plain text: parts joined, anything but text left out. */
const textOf = (content: Message["content"]): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => ("text" in part ? part.text : "")).join(" ")
      : "";

/** What the summariser reads for one message: its text and the calls it made. */
const messageText = (message: Message): string => {
  const calls =
    "tool_calls" in message && message.tool_calls
      ? message.tool_calls
          .map((call) =>
            call.type === "function" ? `${call.function.name}(${call.function.arguments})` : "",
          )
          .join(" ")
      : "";
  return `${textOf(message.content)} ${calls}`.trim();
};

const isSummary = (message: Message) =>
  message.role === "system" && textOf(message.content).startsWith(SUMMARY_LEAD);

/** The summary as it sits in a transcript, which is the one shape `isSummary` recognises again. */
const summaryMessage = (summary: string): Message => ({
  role: "system",
  content: `${SUMMARY_LEAD}${summary.trim()}`,
});

/**
 * The leading system messages a fold never touches, and the summary an earlier one left among
 * them. What a caller who keeps its system prompt out of the array knows already, and passes.
 */
const systemHead = (messages: Message[]): { from: number; previous?: string } => {
  let from = 0;
  let previous: string | undefined;
  while (from < messages.length && messages[from].role === "system") {
    if (isSummary(messages[from]))
      previous = textOf(messages[from].content).slice(SUMMARY_LEAD.length);
    from++;
  }
  return { from, previous };
};

/** What `pruneToolResults` takes. */
export interface PruneOptions {
  /** How many of the latest tool results are left whole, 5 by default. */
  keepLast?: number;
  /** A result this long or shorter is left whole wherever it is, 256 characters by default. */
  maxChars?: number;
}

/**
 * The transcript with every tool result but the latest few replaced by a one-line stub.
 *
 * The cheap half of compaction. A `read_file` of a 40k-character file is 10k tokens on every turn
 * after it, and by then the model has usually taken what it wanted from it; the stub keeps the
 * call answered — a call with no result is a malformed transcript — and says how much was there,
 * so a model that does need it again knows to ask. Short results are kept, since a stub saves
 * nothing on them. Returns the same array when there was nothing to clear. Rewrites the prefix;
 * see the module comment on when to run it.
 *
 * @param messages The transcript. Not written to.
 * @param options How many results to keep and how long one must be to clear.
 */
export function pruneToolResults(
  messages: Message[],
  { keepLast = 5, maxChars = 256 }: PruneOptions = {},
): Message[] {
  let kept = 0;
  let out: Message[] | undefined;
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at];
    if (message.role !== "tool") continue;
    if (kept++ < keepLast) continue;
    const text = textOf(message.content);
    if (text.length <= maxChars || text.startsWith("[result cleared")) continue;
    out ??= [...messages];
    out[at] = {
      ...message,
      content: `[result cleared, ${text.length.toLocaleString("en-US")} chars]`,
    };
  }
  return out ?? messages;
}

/** What `planCompaction` takes. */
export interface CompactionOptions {
  /** The model's window, in tokens. Zero or less never compacts. */
  limit: number;
  /**
   * What the transcript costs now. The last turn's reported prompt tokens are the best number;
   * absent is the estimate of the whole transcript.
   */
  used?: number;
  /** The fraction of `limit` in use before compacting. `COMPACT_AT` by default. */
  compactAt?: number;
  /** The fraction of `limit` the kept tail may fill. `KEEP_RATIO` by default. */
  keepRatio?: number;
  /** One message's tokens. `messageTokens` by default, divided by `charsPerToken`. */
  estimate?: (message: Message) => number;
  /**
   * The divisor the default `estimate` uses — `charsPerTokenFor` the model, for a transcript
   * weighed the way `runTurn` sizes its requests. `CHARS_PER_TOKEN` when absent; ignored beside
   * an `estimate` of the caller's own.
   */
  charsPerToken?: number;
  /**
   * The first message that may be folded. Absent, the leading `system` messages are skipped and
   * the fold starts after them.
   */
  from?: number;
  /**
   * The summary an earlier fold left, which this one continues. Absent, it is recovered from a
   * `SUMMARY_LEAD` system message at the head, if there is one.
   */
  previous?: string;
}

/** Where to cut, as `compactTranscript` takes it. */
export interface CompactionPlan {
  /** The first message folded away. Everything before it is a system prompt and stays. */
  from: number;
  /** The first message kept whole, always a user message. */
  cut: number;
  /** The messages from `from` to `cut`, the ones the summary replaces. */
  toSummarise: Message[];
  /** The summary an earlier compaction left, which this one continues. */
  previous?: string;
}

/**
 * Where to fold a transcript that has grown into its window, or `undefined` when it should not be.
 *
 * The kept tail is walked back from the end until it fills `keepRatio` of the window, then moved
 * forward onto a user message: a transcript resuming mid-exchange — a tool result with no call
 * before it, a reply with no question — is malformed and servers refuse it. The system prompts at
 * the head are never folded, and a summary an earlier compaction left there is continued rather
 * than summarised as if it were conversation. No plan comes back when the window is not full
 * enough, or when the only legal cut folds too little to pay for the summary.
 *
 * Both of those are recovered by reading the transcript, which is what a host whose array holds
 * everything it sends has to do. A host that keeps its fold as a record beside an append-only
 * transcript — its system prompt a separate argument, no summary message in the array at all —
 * knows them exactly, and passes `from` and `previous` instead of hoping the scan agrees.
 *
 * @param messages The transcript, system prompts included if the caller keeps them in it.
 * @param options The window, what is in use, the ratios, and where the last fold ended. See
 * `CompactionOptions`.
 */
export function planCompaction(
  messages: Message[],
  {
    limit,
    used,
    compactAt = COMPACT_AT,
    keepRatio = KEEP_RATIO,
    charsPerToken,
    estimate = (message) => messageTokens(message, { charsPerToken }),
    from: givenFrom,
    previous: givenPrevious,
  }: CompactionOptions,
): CompactionPlan | undefined {
  if (!(limit > 0)) return undefined;
  const cost = used ?? messages.reduce((total, message) => total + estimate(message), 0);
  if (cost < limit * compactAt) return undefined;

  const head = systemHead(messages);
  const from = Math.min(Math.max(givenFrom ?? head.from, 0), messages.length);
  const previous = givenPrevious ?? head.previous;

  const budget = limit * keepRatio;
  let kept = 0;
  let cut = messages.length;
  for (let at = messages.length - 1; at > from; at--) {
    kept += estimate(messages[at]);
    if (kept > budget) break;
    cut = at;
  }
  while (cut < messages.length && messages[cut].role !== "user") cut++;

  if (cut >= messages.length || cut - from < 2) return undefined;
  return { from, cut, toSummarise: messages.slice(from, cut), ...(previous ? { previous } : {}) };
}

/**
 * What the summariser is handed for a plan: the earlier summary if there was one, then each
 * message as its role and at most 4000 characters of its text.
 *
 * @param plan What `planCompaction` returned.
 */
export function summaryInput(plan: CompactionPlan): string {
  const transcript = plan.toSummarise
    .map((message) => {
      const text = messageText(message);
      return text ? `${message.role}: ${text.slice(0, SUMMARY_SLICE)}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return plan.previous
    ? `Notes so far:\n${plan.previous}\n\nContinue them with this exchange:\n\n${transcript}`
    : transcript;
}

/**
 * A summariser that asks `model` with `SUMMARY_PROMPT`, for `compactTranscript`.
 *
 * @param config The endpoint the summary is written through.
 * @param model The model to write it, which may be a smaller one than the run's.
 * @param options Cancellation and notices; the ceiling is 1024 and the instruction
 * `SUMMARY_PROMPT` unless given.
 */
export const summariser =
  (
    config: Endpoint,
    model: string,
    {
      system = SUMMARY_PROMPT,
      maxTokens = 1024,
      ...options
    }: SideTaskOptions & { system?: string } = {},
  ) =>
  (text: string) =>
    ask(config, model, system, text, { maxTokens, ...options });

/**
 * One fold, as a host that keeps its transcript append-only stores it.
 *
 * The other half of `compactTranscript`: the same work, recorded rather than applied. A host that
 * persists this beside an untouched transcript still shows the user every message, can undo a fold
 * by dropping one row, and rebuilds the request with `applyCompaction` — where a host that keeps
 * only the rewritten array has thrown the originals away.
 */
export interface CompactionRecord {
  /** The model's notes on everything before `through`. Trimmed, and never empty. */
  summary: string;
  /** Index into the transcript the plan was made for: the first message still sent whole. */
  through: number;
  /** ISO 8601, so the chat can show where history was folded and how stale the notes are. */
  at: string;
}

/** What `runCompaction` and `compactTranscript` take beside the plan. */
export interface CompactionRunOptions {
  /**
   * Hooks to tell. `context` is extended with `compacting` and `range`, whose indexes are the
   * plan's — and so the host's own, for a plan made over a stored transcript. `honourVeto` waits
   * for the hooks and lets one stop the compaction; off by default, which adds no latency.
   */
  hooks?: {
    run: HookRunner;
    context: HookContext;
    onNote?: (note: HookNote) => void;
    honourVeto?: boolean;
  };
  /**
   * The window is already exceeded — the caller caught a `ContextOverflow`, or is compacting to
   * make a refused request fit — which overrides `honourVeto`.
   */
  forced?: boolean;
}

/**
 * The hooks and the summariser for a plan, as a record to store rather than a transcript to send.
 *
 * What `compactTranscript` does before it rewrites anything, which is all a host needs when the
 * fold lives on the session row and the messages stay where they are. Nothing here is persisted or
 * logged — that is the host's, and so is deciding what to do with a fold that did not happen.
 *
 * @param messages The transcript the plan was made for. Read only, and only for the hooks.
 * @param plan What `planCompaction` returned for it.
 * @param summarise Writes the summary from `summaryInput`'s text. See `summariser`. Not called
 * when a hook vetoes.
 * @param options Hooks to tell and whether the window is already past. See `CompactionRunOptions`.
 * @returns `undefined` when nothing was folded — a hook vetoed, or the summary came back empty —
 * so the caller stores nothing and the transcript is still whole.
 */
export async function runCompaction(
  messages: Message[],
  plan: CompactionPlan,
  summarise: (text: string) => Promise<string>,
  { hooks, forced = false }: CompactionRunOptions = {},
): Promise<CompactionRecord | undefined> {
  const context: HookContext | undefined = hooks && {
    ...hooks.context,
    compacting: turnMessages(hooks.context.session.id, messages, plan.from, plan.cut),
    range: { from: plan.from, through: plan.cut },
  };
  let summary: string;
  if (hooks && context && hooks.honourVeto && !forced) {
    const { vetoed } = await consult(hooks.run, "beforeCompact", context, hooks.onNote);
    if (vetoed) return undefined;
    summary = await summarise(summaryInput(plan));
  } else {
    [summary] = await Promise.all([
      summarise(summaryInput(plan)),
      hooks && context && notify(hooks.run, "beforeCompact", context, hooks.onNote),
    ]);
  }
  if (!summary.trim()) return undefined;
  return { summary: summary.trim(), through: plan.cut, at: new Date().toISOString() };
}

/**
 * The transcript as the server should see it: the folded head replaced by its summary.
 *
 * The inverse of storing a `CompactionRecord`, and the shape `planCompaction` expects to meet
 * again — the same `SUMMARY_LEAD`, in a `system` message at the same place — so the next fold
 * continues these notes rather than summarising them a second time. Any earlier summary message in
 * the kept head is dropped, since the record's already contains it.
 *
 * @param messages The stored transcript, whole. Not written to.
 * @param record The fold, or `undefined` for a session that has not been compacted, which hands
 * back `messages` itself.
 * @param options `from` is the first message the fold was allowed to take — the plan's, for a host
 * that keeps its system prompts in the array; everything before it is kept ahead of the summary.
 * Absent, the leading `system` messages are found by scanning, and zero of them is the ordinary
 * case for a host whose system prompt is a separate argument.
 */
export function applyCompaction(
  messages: Message[],
  record?: Pick<CompactionRecord, "summary" | "through">,
  { from }: { from?: number } = {},
): Message[] {
  if (!record?.summary.trim()) return messages;
  const head = Math.min(Math.max(from ?? systemHead(messages).from, 0), record.through);
  return [
    ...messages.slice(0, head).filter((message) => !isSummary(message)),
    summaryMessage(record.summary),
    ...messages.slice(record.through),
  ];
}

/**
 * Where a stored index sits in the request `applyCompaction` builds, once a fold has shifted
 * everything after it.
 *
 * A transcript that stays append-only and a request that does not are two numberings of the same
 * conversation, and anything that names a position — `withContext`'s index, a range handed to a
 * hook — has to say which it is in. An index inside the folded stretch answers with the summary
 * message that now stands for it.
 *
 * @param index The position in the stored transcript.
 * @param record The fold in force, or `undefined` for a session that has none, which hands the
 * index straight back.
 * @param head How many messages the request keeps ahead of the summary — the leading system
 * prompts, when the host keeps them in the array. Zero, the default, is the stored-fold case,
 * where the summary is the request's first message.
 */
export const requestIndex = (
  index: number,
  record?: Pick<CompactionRecord, "through">,
  head = 0,
): number => {
  if (!record) return index;
  return index < record.through ? head : index - record.through + head + 1;
};

/**
 * The transcript with the plan's stretch replaced by one system message holding its summary.
 *
 * `beforeCompact` is told what is being folded while the summary is written, beside it rather
 * than ahead of it — a memory server filing it is not a rescue worth making the run wait for, and
 * `notify` never rejects. A host that wants its hooks able to stop a compaction sets
 * `honourVeto`, and then they run first and the summary waits on them: any `ok` outcome carrying
 * `veto` leaves the transcript as it was, and each vetoing hook is noted by name. A `forced`
 * compaction ignores a veto and runs the hooks beside the summary as before, because a run already
 * past its window has no better option — a veto there only trades the summary for a
 * `ContextOverflow`. An empty summary folds nothing either. Rewrites the prefix; see the module
 * comment on when to run it.
 *
 * `runCompaction` and `applyCompaction` are its two halves, and it is nothing but the two in
 * order, so a host that stores the fold instead of the array gets the same summary at the same
 * cut rather than a second implementation that drifts from this one.
 *
 * @param messages The transcript the plan was made for. Not written to.
 * @param plan What `planCompaction` returned for it.
 * @param summarise Writes the summary from `summaryInput`'s text. See `summariser`. Not called
 * when a hook vetoes.
 * @param options Hooks to tell and whether the window is already past. See
 * `CompactionRunOptions`.
 * @returns `messages` itself when nothing was folded — a veto or an empty summary — otherwise a
 * new array.
 */
export async function compactTranscript(
  messages: Message[],
  plan: CompactionPlan,
  summarise: (text: string) => Promise<string>,
  options: CompactionRunOptions = {},
): Promise<Message[]> {
  const record = await runCompaction(messages, plan, summarise, options);
  if (!record) return messages;
  return applyCompaction(messages, record, { from: plan.from });
}
