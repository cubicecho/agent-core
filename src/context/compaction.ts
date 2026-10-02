import type OpenAI from 'openai';
import type { Endpoint } from '../core/config.ts';
import { HookEvent } from '../hooks/hook-events.ts';
import {
  consult,
  type HookContext,
  type HookRunner,
  notify,
  type OnNote,
  textOf,
  turnMessages,
} from '../hooks/hooks.ts';
import { holdsDefinitions } from '../tools/tool-loading.ts';
import { ask, type SideTaskOptions } from '../turn/side-task.ts';
import { messageTokens } from '../wire/tokens.ts';
import { FUNCTION_TOOL, Role } from '../wire/wire.ts';

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

/** The ceiling `summariser` gives a summary, and what `planCompaction` assumes one will cost. */
const SUMMARY_TOKENS = 1024;

/** How much of any one message the summariser is shown. A pasted file is not worth it whole. */
const SUMMARY_SLICE = 4000;

/** The fewest messages worth folding: a summary of one costs a round trip and saves nothing. */
const FEWEST_FOLDED = 2;

/** The locale a cleared result's length is written in, so the stub reads the same on every host. */
const COUNT_LOCALE = 'en-US';

/**
 * The summariser's instruction when the caller gives none.
 *
 * @remarks
 * Asks for notes rather than a retelling, because what the summary replaces is the model's only
 * record of what was decided, and a narrative spends its words on the order things happened in.
 */
export const SUMMARY_PROMPT =
  'You maintain the running memory of a long conversation. Rewrite the exchange below as ' +
  'notes the assistant can rely on after the original messages are gone. Keep decisions, ' +
  'facts, file paths, names, numbers, and anything still unresolved. Drop pleasantries and ' +
  'anything already superseded. Write compact prose or bullets — no preamble, no sign-off.';

/**
 * How a summary message opens, which is also how `planCompaction` knows one from a system prompt.
 */
export const SUMMARY_LEAD = 'Summary of the earlier part of this conversation, which is no longer shown in full:\n\n';

/**
 * What the summariser reads for one message: its text and the calls it made.
 *
 * @param message - Any message of the transcript. Only its function calls are written out.
 * @returns The text, then each call as `name(arguments)`, space-separated and trimmed. Empty for a
 * message with neither. Not cut to length; `summaryInput` does that.
 */
const messageText = (message: Message): string => {
  const calls =
    'tool_calls' in message && message.tool_calls
      ? message.tool_calls
          .map((call) => (call.type === FUNCTION_TOOL ? `${call.function.name}(${call.function.arguments})` : ''))
          .join(' ')
      : '';
  return `${textOf(message.content)} ${calls}`.trim();
};

/**
 * Whether a message is a summary an earlier fold left, rather than a system prompt.
 *
 * @param message - Any message of the transcript.
 * @returns `true` for a `system` message whose text opens with `SUMMARY_LEAD`, which is what
 * `summaryMessage` writes.
 */
const isSummary = (message: Message) =>
  message.role === Role.System && textOf(message.content).startsWith(SUMMARY_LEAD);

/**
 * The summary as it sits in a transcript, which is the one shape `isSummary` recognises again.
 *
 * @param summary - The notes, without the lead. Trimmed here.
 * @returns A new `system` message: `SUMMARY_LEAD`, then the notes.
 */
const summaryMessage = (summary: string): Message => ({
  role: Role.System,
  content: `${SUMMARY_LEAD}${summary.trim()}`,
});

/**
 * The leading system messages a fold never touches, and the summary an earlier one left among
 * them.
 *
 * @param messages - The transcript. Not written to.
 * @returns `from` is the index of the first message that is not `system` — the length when all of
 * them are. `previous` is the text of the last summary among those ahead of it, lead removed, and
 * absent when there is none.
 *
 * @remarks
 * What a caller who keeps its system prompt out of the array knows already, and passes.
 */
const systemHead = (messages: Message[]): { from: number; previous?: string } => {
  let from = 0;
  let previous: string | undefined;
  while (from < messages.length && messages[from].role === Role.System) {
    if (isSummary(messages[from])) {
      previous = textOf(messages[from].content).slice(SUMMARY_LEAD.length);
    }
    from++;
  }
  return { from, previous };
};

/** What `pruneToolResults` takes. */
export interface PruneOptions {
  /**
   * How many of the latest tool results are left whole.
   *
   * @defaultValue `5`
   */
  keepLast?: number;
  /**
   * A result this long or shorter, in characters, is left whole wherever it is.
   *
   * @defaultValue `256`
   */
  maxChars?: number;
}

/**
 * The transcript with every tool result but the latest few replaced by a one-line stub.
 *
 * @param messages - The transcript. Not written to.
 * @param [options] - How many results to keep and how long one must be to clear.
 * @returns `messages` itself when nothing was cleared, otherwise a new array in which each cleared
 * result is a new message and every other one the same object.
 *
 * @remarks
 * The cheap half of compaction. A `read_file` of a 40k-character file is 10k tokens on every turn
 * after it, and by then the model has usually taken what it wanted from it; the stub keeps the
 * call answered — a call with no result is a malformed transcript — and says how much was there,
 * so a model that does need it again knows to ask. Short results are kept, since a stub saves
 * nothing on them, and so is a proxied `load_tools` result carrying definitions, which is the
 * only copy of them the model has (`holdsDefinitions`); either still counts as one of the latest
 * few. Returns the same array when there was nothing to clear. Rewrites the prefix;
 * see the module comment on when to run it.
 */
export function pruneToolResults(messages: Message[], { keepLast = 5, maxChars = 256 }: PruneOptions = {}): Message[] {
  let kept = 0;
  let out: Message[] | undefined;
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at];
    if (message.role !== Role.Tool) {
      continue;
    }
    if (kept++ < keepLast) {
      continue;
    }
    const text = textOf(message.content);
    if (text.length <= maxChars || text.startsWith('[result cleared')) {
      continue;
    }
    // A proxied load's result is the schema itself; stubbed, the tool is one the model can still
    // name and no longer call correctly.
    if (holdsDefinitions(text)) {
      continue;
    }
    out ??= [...messages];
    out[at] = {
      ...message,
      content: `[result cleared, ${text.length.toLocaleString(COUNT_LOCALE)} chars]`,
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
  /**
   * The fraction of `limit` in use before compacting.
   *
   * @defaultValue `COMPACT_AT`
   */
  compactAt?: number;
  /**
   * The fraction of `limit` the kept tail may fill.
   *
   * @defaultValue `KEEP_RATIO`
   */
  keepRatio?: number;
  /**
   * The fraction of `limit` the whole request should come down to, in place of `keepRatio`: the
   * cut is the earliest that leaves `used`, less what is folded, plus `summaryTokens`, at or under
   * it. Absent, or not above zero, plans by `keepRatio` as before.
   */
  target?: number;
  /**
   * What the summary is assumed to cost when planning to a `target` — the ceiling its writer is
   * held to, since the plan is made before it is written.
   *
   * @defaultValue `1024`, which is `summariser`'s ceiling
   */
  summaryTokens?: number;
  /**
   * One message's tokens.
   *
   * @defaultValue `messageTokens` divided by `charsPerToken`
   */
  estimate?: (message: Message) => number;
  /**
   * The divisor the default `estimate` uses — `charsPerTokenFor` the model, for a transcript
   * weighed the way `runTurn` sizes its requests. Ignored beside an `estimate` of the caller's own.
   *
   * @defaultValue `4`
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
  /**
   * What the request is expected to cost once folded, in tokens: what was in use, less what is
   * summarised, plus the summary's ceiling. Only on a plan made to a `target`, and above the
   * target where no legal cut reaches it.
   */
  after?: number;
}

/**
 * An index held between the start of the transcript and `most`, for a caller's `from` that is
 * neither.
 *
 * @param index - The index as it was given, which may be negative or past the end.
 * @param most - The highest index allowed, itself included.
 * @returns `index` where it lies from zero to `most`, otherwise the nearer of the two.
 */
const clamp = (index: number, most: number) => Math.min(Math.max(index, 0), most);

/**
 * Where to fold a transcript that has grown into its window, or `undefined` when it should not be.
 *
 * @param messages - The transcript, system prompts included if the caller keeps them in it.
 * @param options - The window, what is in use, the ratios, and where the last fold ended. See
 * `CompactionOptions`.
 * @returns The plan, its `toSummarise` a new array of the same message objects, or `undefined` when
 * there is nothing to fold. `messages` is not written to.
 *
 * @remarks
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
 * `keepRatio` bounds the kept tail alone, and the system prompt, the tool schemas and the summary
 * sit in the window on top of it uncounted. Given a `target` the plan is made against what the
 * request will be afterwards instead: the cut is the first user message at which `used`, less the
 * folded messages, plus the summary's ceiling, is at or under that share of the window. Where no
 * cut gets there the plan folds up to the last user message, which is as near as a legal one
 * comes, and `after` says how far short it fell. An earlier summary the new one replaces is not
 * credited, so `after` errs high by at most that much. It is only as good as `estimate` — see
 * `estimateFrom` for one that is measured.
 */
export function planCompaction(
  messages: Message[],
  {
    limit,
    used,
    compactAt = COMPACT_AT,
    keepRatio = KEEP_RATIO,
    target,
    summaryTokens = SUMMARY_TOKENS,
    charsPerToken,
    estimate = (message) => messageTokens(message, { charsPerToken }),
    from: givenFrom,
    previous: givenPrevious,
  }: CompactionOptions,
): CompactionPlan | undefined {
  if (!(limit > 0)) {
    return undefined;
  }
  const cost = used ?? messages.reduce((total, message) => total + estimate(message), 0);
  if (cost < limit * compactAt) {
    return undefined;
  }

  const head = systemHead(messages);
  const from = clamp(givenFrom ?? head.from, messages.length);
  const previous = givenPrevious ?? head.previous;

  let cut = messages.length;
  let after: number | undefined;
  if (target !== undefined && target > 0) {
    // Forward from the head, so the first cut that reaches the target is the one that folds least.
    let folded = 0;
    for (let at = from; at < messages.length; at++) {
      if (messages[at].role === Role.User) {
        cut = at;
        after = cost - folded + summaryTokens;
        if (after <= limit * target) {
          break;
        }
      }
      folded += estimate(messages[at]);
    }
  } else {
    const budget = limit * keepRatio;
    let kept = 0;
    for (let at = messages.length - 1; at > from; at--) {
      kept += estimate(messages[at]);
      if (kept > budget) {
        break;
      }
      cut = at;
    }
    while (cut < messages.length && messages[cut].role !== Role.User) {
      cut++;
    }
  }

  if (cut >= messages.length || cut - from < FEWEST_FOLDED) {
    return undefined;
  }
  return {
    from,
    cut,
    toSummarise: messages.slice(from, cut),
    ...(previous ? { previous } : {}),
    ...(after === undefined ? {} : { after: Math.round(after) }),
  };
}

/**
 * What the summariser is handed for a plan: the earlier summary if there was one, then each
 * message as its role and at most 4000 characters of its text.
 *
 * @param plan - What `planCompaction` returned.
 * @returns The text for the summariser, messages a blank line apart. A message with neither text
 * nor calls is left out, and a plan with a `previous` opens with it under `Notes so far:`.
 */
export function summaryInput(plan: CompactionPlan): string {
  const transcript = plan.toSummarise
    .map((message) => {
      const text = messageText(message);
      return text ? `${message.role}: ${text.slice(0, SUMMARY_SLICE)}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
  return plan.previous
    ? `Notes so far:\n${plan.previous}\n\nContinue them with this exchange:\n\n${transcript}`
    : transcript;
}

/**
 * A summariser that asks `model` with `SUMMARY_PROMPT`, for `compactTranscript`.
 *
 * @param config - The endpoint the summary is written through.
 * @param model - The model to write it, which may be a smaller one than the run's.
 * @param [options] - Cancellation and notices, and the instruction and ceiling the summary is
 * written under.
 * @returns A function from the text of what is being folded to the summary. It rejects as `ask` does, and
 * resolves with an empty string where the model wrote nothing.
 */
export const summariser =
  (
    config: Endpoint,
    model: string,
    { system = SUMMARY_PROMPT, maxTokens = SUMMARY_TOKENS, ...options }: SideTaskOptions & { system?: string } = {},
  ) =>
  (text: string) =>
    ask(config, model, system, text, { maxTokens, ...options });

/**
 * One fold, as a host that keeps its transcript append-only stores it.
 *
 * @remarks
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
   * for the hooks and lets one stop the compaction; without it they add no latency.
   */
  hooks?: {
    run: HookRunner;
    context: HookContext;
    onNote?: OnNote;
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
 * @param messages - The transcript the plan was made for. Read only, and only for the hooks.
 * @param plan - What `planCompaction` returned for it.
 * @param summarise - Writes the summary from the text it is handed. See `summariser`. Not called
 * when a hook vetoes.
 * @param [options] - Hooks to tell and whether the window is already past. See `CompactionRunOptions`.
 * @returns `undefined` when nothing was folded — a hook vetoed, or the summary came back empty —
 * so the caller stores nothing and the transcript is still whole.
 *
 * @remarks
 * What `compactTranscript` does before it rewrites anything, which is all a host needs when the
 * fold lives on the session row and the messages stay where they are. Nothing here is persisted or
 * logged — that is the host's, and so is deciding what to do with a fold that did not happen.
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
    const { vetoed } = await consult(hooks.run, HookEvent.BeforeCompact, context, hooks.onNote);
    if (vetoed) {
      return undefined;
    }
    summary = await summarise(summaryInput(plan));
  } else {
    [summary] = await Promise.all([
      summarise(summaryInput(plan)),
      hooks && context && notify(hooks.run, HookEvent.BeforeCompact, context, hooks.onNote),
    ]);
  }
  if (!summary.trim()) {
    return undefined;
  }
  return { summary: summary.trim(), through: plan.cut, at: new Date().toISOString() };
}

/**
 * The transcript as the server should see it: the folded head replaced by its summary.
 *
 * @param messages - The stored transcript, whole. Not written to.
 * @param [record] - The fold, or `undefined` for a session that has not been compacted, which hands
 * back `messages` itself.
 * @param [options] - `from` is the first message the fold was allowed to take — the plan's, for a host
 * that keeps its system prompts in the array; everything before it is kept ahead of the summary.
 * Absent, the leading `system` messages are found by scanning, and zero of them is the ordinary
 * case for a host whose system prompt is a separate argument.
 * @returns `messages` itself when there is no record or its summary is blank, otherwise a new
 * array: the kept head, one summary message, then everything from the record's `through` on.
 *
 * @remarks
 * The inverse of storing a `CompactionRecord`, and the shape `planCompaction` expects to meet
 * again — the same `SUMMARY_LEAD`, in a `system` message at the same place — so the next fold
 * continues these notes rather than summarising them a second time. Any earlier summary message in
 * the kept head is dropped, since the record's already contains it.
 */
export function applyCompaction(
  messages: Message[],
  record?: Pick<CompactionRecord, 'summary' | 'through'>,
  { from }: { from?: number } = {},
): Message[] {
  if (!record?.summary.trim()) {
    return messages;
  }
  const head = clamp(from ?? systemHead(messages).from, record.through);
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
 * @param index - The position in the stored transcript.
 * @param [record] - The fold in force, or `undefined` for a session that has none, which hands the
 * index straight back.
 * @param [head] - How many messages the request keeps ahead of the summary — the leading system
 * prompts, when the host keeps them in the array. Zero is the stored-fold case,
 * where the summary is the request's first message.
 * @returns The index in the request. One before the record's `through` gives `head`, where the
 * summary sits — an index among the kept head messages themselves included.
 *
 * @remarks
 * A transcript that stays append-only and a request that does not are two numberings of the same
 * conversation, and anything that names a position — `withContext`'s index, a range handed to a
 * hook — has to say which it is in. An index inside the folded stretch answers with the summary
 * message that now stands for it.
 */
export const requestIndex = (index: number, record?: Pick<CompactionRecord, 'through'>, head = 0): number => {
  if (!record) {
    return index;
  }
  return index < record.through ? head : index - record.through + head + 1;
};

/**
 * The transcript with the plan's stretch replaced by one system message holding its summary.
 *
 * @param messages - The transcript the plan was made for. Not written to.
 * @param plan - What `planCompaction` returned for it.
 * @param summarise - Writes the summary from the text it is handed. See `summariser`. Not called
 * when a hook vetoes.
 * @param [options] - Hooks to tell and whether the window is already past. See
 * `CompactionRunOptions`.
 * @returns `messages` itself when nothing was folded — a veto or an empty summary — otherwise a
 * new array.
 *
 * @remarks
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
 */
export async function compactTranscript(
  messages: Message[],
  plan: CompactionPlan,
  summarise: (text: string) => Promise<string>,
  options: CompactionRunOptions = {},
): Promise<Message[]> {
  const record = await runCompaction(messages, plan, summarise, options);
  if (!record) {
    return messages;
  }
  return applyCompaction(messages, record, { from: plan.from });
}
