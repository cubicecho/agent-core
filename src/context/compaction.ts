import type OpenAI from 'openai';
import type { Endpoint } from '../core/config.ts';
import { isPositive } from '../core/guards.ts';
import { HookEvent } from '../hooks/hook-events.ts';
import { consult, type HookContext, type HookRunner, notify, type OnNote, turnMessages } from '../hooks/hooks.ts';
import { holdsDefinitions } from '../tools/tool-loading.ts';
import { ask, type SideTaskOptions } from '../turn/side-task.ts';
import { textOf } from '../wire/text.ts';
import { messageTokens } from '../wire/tokens.ts';
import { FUNCTION_TOOL, Role } from '../wire/wire.ts';

/**
 * Keeping a long exchange inside its context window: stale tool results cleared, and the oldest
 * stretch compacted into a summary the model writes itself.
 *
 * Both rewrite the transcript's prefix, and a prefix that changes is a prompt cache that misses —
 * on a local server that is the whole prompt processed again, every token of it. So neither is
 * meant to run a little on every turn: run them rarely, and together, at the point
 * `planCompaction` says the context window is filling, and the cache is paid for once rather than
 * on every turn.
 */

type Message = OpenAI.ChatCompletionMessageParam;

/** The fraction of the context window in use before a summary is worth its own round trip. */
export const COMPACT_AT = 0.75;

/**
 * The fraction of the context window the kept tail may fill, leaving room for the exchange to
 * grow again.
 */
export const KEEP_RATIO = 0.35;

/** The ceiling `summariser` gives a summary, and what `planCompaction` assumes one will cost. */
const SUMMARY_TOKENS = 1024;

/** How much of any one message the summariser is shown. A pasted file is not worth it whole. */
const SUMMARY_SLICE = 4000;

/** The fewest messages worth compacting: a summary of one costs a round trip and saves nothing. */
const FEWEST_FOLDED = 2;

/** How many of the latest tool results a prune leaves whole when the caller does not say. */
const KEEP_LAST = 5;

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
 * How a summary message opens, which is also how `planCompaction` knows one from the conversation.
 */
export const SUMMARY_LEAD = 'Summary of the earlier part of this conversation, which is no longer shown in full:\n\n';

/**
 * The assistant's reply to a summary, which closes the pair `applyCompaction` writes.
 *
 * @remarks
 * There so the conversation still alternates. A summary followed straight by the kept question is
 * two user messages in a row, and the templates that insist on user and assistant taking turns
 * (Mistral's v0.3 among them) refuse that as firmly as Qwen3.5 refuses a second system message.
 */
export const SUMMARY_ACK = 'Understood. I will continue from these notes.';

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
 * Whether a message is a summary an earlier compaction left, rather than a system prompt or
 * a question.
 *
 * @param message - Any message of the transcript.
 * @returns `true` for a `user` message whose text opens with `SUMMARY_LEAD`, which is what
 * `summaryMessages` writes, and for a `system` one, which is what earlier versions wrote and what
 * an app may still have stored.
 */
export const isSummary = (message: Message) =>
  (message.role === Role.User || message.role === Role.System) && textOf(message.content).startsWith(SUMMARY_LEAD);

/**
 * Whether a message is the reply that closes a summary pair.
 *
 * @param message - Any message of the transcript.
 * @returns `true` for an `assistant` message that is `SUMMARY_ACK` and calls nothing.
 */
const isAck = (message: Message) => {
  const calls = 'tool_calls' in message ? (message.tool_calls?.length ?? 0) : 0;
  return message.role === Role.Assistant && calls === 0 && textOf(message.content) === SUMMARY_ACK;
};

/**
 * The summary as it sits in a transcript, which is the one shape `isSummary` recognises again.
 *
 * @param summary - The notes, without the lead. Trimmed here.
 * @returns A `user` message, `SUMMARY_LEAD` then the notes, and the `assistant` reply
 * `SUMMARY_ACK`.
 *
 * @remarks
 * Conversation rather than a second system message, because the Qwen3.5 and later templates, and
 * Devstral's, raise on any `system` message that is not the first — and the loop puts its own
 * system prompt ahead of this one. The exchange's system prompt then stays the same text across a
 * compaction, so the prefix a server cached for it, and for the tool block rendered beside it,
 * still matches.
 */
const summaryMessages = (summary: string): Message[] => [
  { role: Role.User, content: `${SUMMARY_LEAD}${summary.trim()}` },
  { role: Role.Assistant, content: SUMMARY_ACK },
];

/** How many messages a summary takes in a transcript, which every index after it is moved by. */
const SUMMARY_SIZE = summaryMessages('').length;

/**
 * The head of a transcript a compaction never takes: its leading system messages, and the summary
 * an earlier compaction left after them.
 *
 * @param messages - The transcript. Not written to.
 * @returns `from` is the index of the first message after the leading `system` messages and the
 * summary pair behind them — the length when there is nothing else. `previous` is the text of the
 * last summary there, lead removed, and absent when there is none.
 *
 * @remarks
 * What a caller who keeps its system prompt out of the array knows already, and passes.
 */
const systemHead = (messages: Message[]): { from: number; previous?: string } => {
  let from = 0;
  let previous: string | undefined;
  const readSummary = () => {
    previous = textOf(messages[from].content).slice(SUMMARY_LEAD.length);
    from++;
  };
  while (from < messages.length && messages[from].role === Role.System) {
    if (isSummary(messages[from])) {
      readSummary();
    } else {
      from++;
    }
  }
  const opensWithSummary = from < messages.length && isSummary(messages[from]);
  if (opensWithSummary) {
    readSummary();
    const isAcked = from < messages.length && isAck(messages[from]);
    if (isAcked) {
      from++;
    }
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

/** How a pruned tool result's stub opens, which is also how a prune knows not to clear it again. */
const PRUNED_LEAD = '[result cleared';

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
export function pruneToolResults(
  messages: Message[],
  { keepLast = KEEP_LAST, maxChars = 256 }: PruneOptions = {},
): Message[] {
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
    if (text.length <= maxChars || text.startsWith(PRUNED_LEAD)) {
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
      content: `${PRUNED_LEAD}, ${text.length.toLocaleString(COUNT_LOCALE)} chars]`,
    };
  }
  return out ?? messages;
}

/**
 * The share of the context window a prune has to win back on its own before it is worth the prompt
 * cache it costs. Below it the request after a prune is barely smaller than the one before, and
 * every token of it is processed again anyway.
 */
export const PRUNE_SHARE = 0.1;

/** What `planPrune` takes beside the transcript and the context window. */
export interface PrunePlanOptions extends PruneOptions {
  /**
   * The boundary in force: results before it are already sent as stubs. A plan only ever moves it
   * forward.
   *
   * @defaultValue `0`
   */
  through?: number;
  /**
   * The share of the context window a move has to clear, in tokens, to be made on its own. Zero
   * makes any move that clears something.
   *
   * @defaultValue `PRUNE_SHARE`
   */
  minShare?: number;
  /**
   * The share of the context window in use before a move is considered at all. Zero considers one
   * on every turn, and the hysteresis is `minShare`'s alone.
   *
   * @defaultValue `COMPACT_AT`, so a prune is paid for when a compaction would be
   */
  at?: number;
  /**
   * What the transcript costs now — the last request's reported prompt tokens. The fill weighed
   * against `at` is the larger of it and the estimate, since a report does not count the results
   * that arrived after it, which are what fills a context window.
   */
  used?: number;
  /**
   * The first message still sent. Results before it were compacted into a summary and are no saving
   * of this one, so they are not counted.
   *
   * @defaultValue `0`
   */
  from?: number;
  /**
   * The head of the request was rewritten on this turn anyway — a compaction was just stored — so
   * the cache is lost whatever a move does: `at` and `minShare` are not asked, and a move that
   * clears anything is made, with a context window known or not.
   *
   * @defaultValue `false`
   */
  compacted?: boolean;
  /**
   * One message's tokens.
   *
   * @defaultValue `messageTokens` divided by `charsPerToken`
   */
  estimate?: (message: Message) => number;
  /**
   * The divisor the default `estimate` uses. Ignored beside an `estimate` of the caller's own.
   *
   * @defaultValue `4`
   */
  charsPerToken?: number;
}

/** Where `planPrune` puts the boundary, and what moving it there clears. */
export interface PrunePlan {
  /**
   * The new boundary: tool results before it are sent as stubs (`pruneThrough`), results at or
   * after it whole. Always greater than the one in force. An index into the transcript the plan
   * was made for, which the app stores.
   */
  through: number;
  /** How many results the move stubs that were being sent whole. */
  cleared: number;
  /** Their estimated tokens, less the stubs', rounded. */
  tokens: number;
}

/**
 * The transcript with every tool result before `through` replaced by a stub.
 *
 * @param messages - The transcript. Not written to.
 * @param through - The boundary, as a `PrunePlan` has it. Clamped to the transcript, so one left
 * past its end cannot reach messages not yet written.
 * @param [options] - `maxChars`, as `pruneToolResults` reads it.
 * @returns `messages` itself when nothing was cleared, otherwise a new array of the same length in
 * which each cleared result is a new message and every other one the same object.
 *
 * @remarks
 * `pruneToolResults` over the head, keeping none of it — so a result that is short or carries
 * definitions stays whole here as it does there. A function of the messages before `through` and
 * nothing else: while the boundary stays put, what this sends for them does not change however
 * many results arrive after it, which is what keeps the prompt cache.
 */
export function pruneThrough(
  messages: Message[],
  through: number,
  { maxChars }: Pick<PruneOptions, 'maxChars'> = {},
): Message[] {
  const end = clamp(through, messages.length);
  if (end <= 0) {
    return messages;
  }
  const head = messages.slice(0, end);
  const stubbed = pruneToolResults(head, { keepLast: 0, ...(maxChars === undefined ? {} : { maxChars }) });
  return stubbed === head ? messages : [...stubbed, ...messages.slice(end)];
}

/**
 * Where the latest `keepLast` tool results begin, which is where a move puts the boundary.
 *
 * @param messages - The transcript.
 * @param keepLast - How many of the latest results stay whole.
 * @returns The index of the earliest of them; the length when `keepLast` is zero; and zero when
 * there are not that many results, which is nowhere.
 */
const keepBoundary = (messages: Message[], keepLast: number): number => {
  if (keepLast <= 0) {
    return messages.length;
  }
  let kept = 0;
  for (let at = messages.length - 1; at >= 0; at--) {
    if (messages[at].role === Role.Tool && ++kept === keepLast) {
      return at;
    }
  }
  return 0;
};

/**
 * Where to move the prune boundary, or `undefined` when it should stay where it is.
 *
 * @param messages - The transcript as the app keeps it — whole, or with earlier stubs in it.
 * @param window - The model's context window, in tokens. Zero or less moves nothing on its own.
 * @param [options] - The boundary in force, the gate, what to keep, and how to weigh a message.
 * See `PrunePlanOptions`.
 * @returns The plan, or `undefined`. `messages` is not written to.
 *
 * @remarks
 * `pruneToolResults` keeps a sliding window of results: applied on every turn, each new result
 * pushes an older one out, rewrites a message in the middle of the history and loses the prompt
 * cache from there on, once per tool call. A plan is a boundary instead. The app stores
 * `through` and sends `pruneThrough(messages, through)` on every request, and between moves a
 * request is the one before it with only its tail added.
 *
 * The rule, in the order it is asked:
 *
 * - **Never backwards, and never for nothing.** The target is the earliest of the latest
 *   `keepLast` results. If that is not past `through`, or moving there would clear nothing still
 *   being sent, there is no plan.
 * - **With a compaction, for free.** Given `compacted`, the move is made.
 * - **Otherwise once the context window is filling**, past `at` of it, and only when what it clears
 *   is at least `minShare` of it. An exchange sitting just over the line would otherwise slide the
 *   boundary forward and lose the cache on every turn for a few hundred tokens each time.
 *
 * What is weighed is what the move would *clear*, by `estimate`: a short result and a proxied
 * load's definitions stay whole wherever the boundary is, a stub is not cleared twice, and a
 * result before `from` is not being sent.
 */
export function planPrune(
  messages: Message[],
  window: number,
  {
    through = 0,
    minShare = PRUNE_SHARE,
    at = COMPACT_AT,
    used,
    from = 0,
    compacted = false,
    keepLast = KEEP_LAST,
    maxChars,
    charsPerToken,
    estimate = (message) => messageTokens(message, { charsPerToken }),
  }: PrunePlanOptions = {},
): PrunePlan | undefined {
  const hasWindow = window > 0;
  if (hasWindow === false && compacted === false) {
    return undefined;
  }
  if (compacted === false) {
    const estimated = messages.reduce((total, message) => total + estimate(message), 0);
    const isFilling = Math.max(used ?? 0, estimated) >= window * at;
    if (isFilling === false) {
      return undefined;
    }
  }
  const current = clamp(through, messages.length);
  const target = keepBoundary(messages, keepLast);
  if (target <= current) {
    return undefined;
  }
  const sent = pruneThrough(messages, target, { maxChars });
  let cleared = 0;
  let tokens = 0;
  for (let index = Math.max(current, from); index < target; index++) {
    if (sent[index] !== messages[index]) {
      cleared++;
      tokens += estimate(messages[index]) - estimate(sent[index]);
    }
  }
  if (cleared === 0) {
    return undefined;
  }
  const isWorthIt = compacted || tokens >= window * minShare;
  return isWorthIt ? { through: target, cleared, tokens: Math.round(tokens) } : undefined;
}

/**
 * What an app says when a plan is applied, so every app says it the same way.
 *
 * @param plan - The plan that was applied.
 * @param [compacted] - Whether it was made alongside a compaction rather than because the context
 * window filled.
 * @returns One line with the counts: `cleared 3 old tool results (~12,345 tokens) as the context
 * window filled`.
 */
export function pruneNotice({ cleared, tokens }: PrunePlan, compacted = false): string {
  const results = cleared === 1 ? 'result' : 'results';
  const why = compacted ? 'alongside a compaction' : 'as the context window filled';
  return `cleared ${cleared} old tool ${results} (~${tokens.toLocaleString(COUNT_LOCALE)} tokens) ${why}`;
}

/** What `planCompaction` takes. */
export interface CompactionOptions {
  /** The model's context window, in tokens. Zero or less never compacts. */
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
   * cut is the earliest that leaves `used`, less what is summarised, plus `summaryTokens`, at or
   * under it. Absent, or not above zero, plans by `keepRatio` as before.
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
   * The first message that may be compacted. Absent, the leading `system` messages are skipped and
   * the compaction starts after them.
   */
  from?: number;
  /**
   * The summary an earlier compaction left, which this one continues. Absent, it is recovered from
   * a `SUMMARY_LEAD` message at the head, if there is one.
   */
  previous?: string;
}

/** Where to cut, as `compactTranscript` takes it. */
export interface CompactionPlan {
  /**
   * The first message summarised away. Everything before it is a system prompt and stays,
   * apart from an earlier summary, which the new one replaces.
   */
  from: number;
  /**
   * The first message kept whole: a user message, or an assistant message on a compaction made
   * inside one question's tool loop (see `question`).
   */
  cut: number;
  /**
   * The user message kept whole between the summary and `cut`, on a compaction made inside its tool
   * loop. Absent on a compaction that cuts at a user message.
   */
  question?: number;
  /** The messages from `from` to `cut`, `question` left out: the ones the summary replaces. */
  toSummarise: Message[];
  /** The summary an earlier compaction left, which this one continues. */
  previous?: string;
  /**
   * What the request is expected to cost once compacted, in tokens: what was in use, less what is
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

/** What `findCut` weighs a transcript by, which `planCompaction` has already worked out. */
interface CutSearch {
  /** The first message that may be compacted. */
  from: number;
  /** What the transcript costs now. */
  cost: number;
  /** The context window, in tokens. */
  limit: number;
  /** The share of `limit` the kept tail may fill, where there is no `target`. */
  keepRatio: number;
  /** The share of `limit` the whole request should come down to. */
  target?: number;
  /** What the summary is assumed to cost. */
  summaryTokens: number;
  /** One message's tokens. */
  estimate: (message: Message) => number;
  /** Whether the kept tail may start at this index. */
  isCut: (at: number) => boolean;
  /** An index that is kept rather than summarised, wherever the cut lands: the question. */
  kept?: number;
}

/**
 * Where to cut, by `target` when there is one and by `keepRatio` otherwise, among the indexes
 * `isCut` allows.
 *
 * @param messages - The transcript. Not written to.
 * @param search - The weights, the bounds and which indexes are legal cuts. See `CutSearch`.
 * @returns `cut`, the length of `messages` when no legal cut was found, and on a plan made to a
 * `target` the cost it leaves as `after`.
 */
const findCut = (
  messages: Message[],
  { from, cost, limit, keepRatio, target, summaryTokens, estimate, isCut, kept }: CutSearch,
): { cut: number; after?: number } => {
  let cut = messages.length;
  let after: number | undefined;
  if (isPositive(target)) {
    // Forward from the head, so the first cut that reaches the target is the one that summarises least.
    let folded = 0;
    for (let at = from; at < messages.length; at++) {
      if (isCut(at)) {
        cut = at;
        after = cost - folded + summaryTokens;
        if (after <= limit * target) {
          break;
        }
      }
      if (at !== kept) {
        folded += estimate(messages[at]);
      }
    }
    return { cut, after };
  }
  const budget = limit * keepRatio;
  let tail = 0;
  for (let at = messages.length - 1; at > from; at--) {
    tail += estimate(messages[at]);
    if (tail > budget) {
      break;
    }
    cut = at;
  }
  while (cut < messages.length && isCut(cut) === false) {
    cut++;
  }
  return { cut };
};

/**
 * The index of the last user message in a transcript.
 *
 * @param messages - The transcript.
 * @returns The index, or `-1` when there is none.
 */
const lastUser = (messages: Message[]): number => messages.findLastIndex((message) => message.role === Role.User);

/**
 * Where to compact a transcript that has grown into its context window, or `undefined` when it
 * should not be.
 *
 * @param messages - The transcript, system prompts included if the caller keeps them in it.
 * @param options - The context window, what is in use, the ratios, and where the last compaction
 * ended. See `CompactionOptions`.
 * @returns The plan, its `toSummarise` a new array of the same message objects, or `undefined` when
 * there is nothing to compact. `messages` is not written to.
 *
 * @remarks
 * The kept tail is walked back from the end until it fills `keepRatio` of the context window, then
 * moved forward onto a user message: a transcript resuming mid-exchange — a tool result with no
 * call before it, a reply with no question — is malformed and servers refuse it. The system prompts
 * at the head are never compacted, and a summary an earlier compaction left there is continued
 * rather than summarised as if it were conversation. No plan comes back when the context window is
 * not full enough, or when the only legal cut summarises too little to pay for the summary.
 *
 * A transcript that is one question and a long tool loop has no user message to cut at, so where
 * no user cut summarises anything the plan cuts inside the last question's loop instead: the question
 * is kept whole as `question`, the assistant and tool messages after it are summarised up to an
 * assistant message, and the tail resumes there — every tool result in it still follows its call.
 * `applyCompaction` sends the question after the summary. A transcript with a user cut is planned
 * exactly as it was.
 *
 * Both of those are recovered by reading the transcript, which is what an app whose array holds
 * everything it sends has to do. An app that keeps its compaction as a record beside an append-only
 * transcript — its system prompt a separate argument, no summary message in the array at all —
 * knows them exactly, and passes `from` and `previous` instead of hoping the scan agrees.
 *
 * `keepRatio` bounds the kept tail alone, and the system prompt, the tool schemas and the summary
 * sit in the context window on top of it uncounted. Given a `target` the plan is made against what
 * the request will be afterwards instead: the cut is the first user message at which `used`, less
 * the summarised messages, plus the summary's ceiling, is at or under that share of the context
 * window. Where no cut gets there the plan summarises up to the last user message, which is as near
 * as a legal one comes, and `after` says how far short it fell. An earlier summary the new one
 * replaces is not credited, so `after` errs high by at most that much. It is only as good as
 * `estimate` — see `estimateFrom` for one that is measured.
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

  const search = { from, cost, limit, keepRatio, target, summaryTokens, estimate };
  const atUser = findCut(messages, { ...search, isCut: (at) => messages[at].role === Role.User });
  const foldsAtUser = atUser.cut < messages.length && atUser.cut - from >= FEWEST_FOLDED;
  if (foldsAtUser) {
    return planFor(messages, from, atUser.cut, previous, atUser.after);
  }
  // A cut that summarises too little but already reaches the target means there is nothing to compact.
  const reachesTarget = target !== undefined && atUser.after !== undefined && atUser.after <= limit * target;
  if (reachesTarget) {
    return undefined;
  }

  // No user message to cut at: compact inside the last question's tool loop, keeping the question.
  const question = lastUser(messages);
  if (question < 0) {
    return undefined;
  }
  const inLoop = findCut(messages, {
    ...search,
    isCut: (at) => at > question && messages[at].role === Role.Assistant,
    kept: question,
  });
  if (inLoop.cut >= messages.length) {
    return undefined;
  }
  const folded = planFor(messages, from, inLoop.cut, previous, inLoop.after, question);
  return folded.toSummarise.length >= FEWEST_FOLDED ? folded : undefined;
}

/**
 * A plan for a cut `planCompaction` has chosen.
 *
 * @param messages - The transcript. Not written to.
 * @param from - The first message summarised.
 * @param cut - The first message kept whole.
 * @param [previous] - The summary this one continues.
 * @param [after] - What the request is expected to cost once compacted, on a plan made to a target.
 * @param [question] - The user message kept whole ahead of `cut`, on a compaction inside its tool
 * loop. Left out of `toSummarise` where it lies between `from` and `cut`.
 * @returns The plan, `toSummarise` a new array of the same message objects.
 */
const planFor = (
  messages: Message[],
  from: number,
  cut: number,
  previous?: string,
  after?: number,
  question?: number,
): CompactionPlan => ({
  from,
  cut,
  ...(question === undefined ? {} : { question }),
  toSummarise: messages.slice(from, cut).filter((_, at) => at + from !== question),
  ...(previous ? { previous } : {}),
  ...(after === undefined ? {} : { after: Math.round(after) }),
});

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
 * @param config - The model server the summary is written through.
 * @param model - The model to write it, which may be a smaller one than the exchange's.
 * @param [options] - Cancellation and notices, and the instruction and ceiling the summary is
 * written under.
 * @returns A function from the text of what is being compacted to the summary. It rejects as `ask`
 * does, and resolves with an empty string where the model wrote nothing.
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
 * One compaction, as an app that keeps its transcript append-only stores it.
 *
 * @remarks
 * The other half of `compactTranscript`: the same work, recorded rather than applied. An app that
 * persists this beside an untouched transcript still shows the user every message, can undo a
 * compaction by dropping one row, and rebuilds the request with `applyCompaction` — where an app
 * that keeps only the rewritten array has thrown the originals away.
 */
export interface CompactionRecord {
  /** The model's notes on everything before `through`. Trimmed, and never empty. */
  summary: string;
  /** Index into the transcript the plan was made for: the first message still sent whole. */
  through: number;
  /**
   * The user message sent whole after the summary and ahead of `through`, on a compaction made
   * inside that question's tool loop. Absent on a compaction that cut at a user message.
   */
  question?: number;
  /** ISO 8601, so the chat can show where history was compacted and how stale the notes are. */
  at: string;
}

/** What `runCompaction` and `compactTranscript` take beside the plan. */
export interface CompactionRunOptions {
  /**
   * Hooks to tell. `context` is extended with `compacting` and `range`, whose indexes are the
   * plan's — and so the app's own, for a plan made over a stored transcript. `compacting` leaves
   * out a `question` the compaction keeps. `honourVeto` waits
   * for the hooks and lets one stop the compaction; without it they add no latency.
   */
  hooks?: {
    run: HookRunner;
    context: HookContext;
    onNote?: OnNote;
    honourVeto?: boolean;
    /**
     * What the transcript's first message is numbered as in the `compacting` uuids: the app's
     * stored index of `messages[0]`, for an app that numbers messages across exchanges or requests.
     * See `turnMessages`.
     *
     * @defaultValue `0`
     */
    offset?: number;
  };
  /**
   * The context window is already exceeded — the caller caught a `ContextOverflow`, or is
   * compacting to make a refused request fit — which overrides `honourVeto`.
   */
  forced?: boolean;
}

/**
 * What `beforeCompact` hooks are told is going: the plan's stretch as `turnMessages` reads it,
 * less the question the compaction keeps.
 *
 * @param sessionId - Prefixes every uuid.
 * @param messages - The transcript the plan was made for.
 * @param plan - What `planCompaction` returned for it.
 * @param [offset] - What `messages[0]` is numbered as in the uuids.
 * @returns The user and assistant text from `plan.from` to `plan.cut`, `plan.question` left out.
 */
const foldedMessages = (sessionId: string, messages: Message[], plan: CompactionPlan, offset = 0) => {
  const { from, cut, question } = plan;
  const read = (start: number, end: number) => turnMessages(sessionId, messages, start, end, { offset });
  const splitsAtQuestion = question !== undefined && question >= from && question < cut;
  return splitsAtQuestion ? [...read(from, question), ...read(question + 1, cut)] : read(from, cut);
};

/**
 * The hooks and the summariser for a plan, as a record to store rather than a transcript to send.
 *
 * @param messages - The transcript the plan was made for. Read only, and only for the hooks.
 * @param plan - What `planCompaction` returned for it.
 * @param summarise - Writes the summary from the text it is handed. See `summariser`. Not called
 * when a hook vetoes.
 * @param [options] - Hooks to tell and whether the context window is already past. See
 * `CompactionRunOptions`.
 * @returns `undefined` when nothing was compacted — a hook vetoed, or the summary came back empty —
 * so the caller stores nothing and the transcript is still whole.
 *
 * @remarks
 * What `compactTranscript` does before it rewrites anything, which is all an app needs when the
 * compaction lives on the session row and the messages stay where they are. Nothing here is
 * persisted or logged — that is the app's, and so is deciding what to do with a compaction that did
 * not happen.
 */
export async function runCompaction(
  messages: Message[],
  plan: CompactionPlan,
  summarise: (text: string) => Promise<string>,
  { hooks, forced = false }: CompactionRunOptions = {},
): Promise<CompactionRecord | undefined> {
  const context: HookContext | undefined = hooks && {
    ...hooks.context,
    compacting: foldedMessages(hooks.context.session.id, messages, plan, hooks.offset),
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
  return {
    summary: summary.trim(),
    through: plan.cut,
    ...(plan.question === undefined ? {} : { question: plan.question }),
    at: new Date().toISOString(),
  };
}

/**
 * The transcript as the model server should see it: the compacted head replaced by its summary.
 *
 * @param messages - The stored transcript, whole. Not written to.
 * @param [record] - The compaction, or `undefined` for a session that has not been compacted, which
 * hands back `messages` itself.
 * @param [options] - `from` is the first message the compaction was allowed to take — the plan's,
 * for an app that keeps its system prompts in the array; everything before it is kept ahead of the
 * summary. Absent, the leading `system` messages are found by scanning, and zero of them is the
 * ordinary case for an app whose system prompt is a separate argument.
 * @returns `messages` itself when there is no record or its summary is blank, otherwise a new
 * array: the kept head, the summary as a `user` message and its `assistant` reply `SUMMARY_ACK`,
 * the record's `question` when it has one and the head does not already hold it, then everything
 * from the record's `through` on.
 *
 * @remarks
 * The inverse of storing a `CompactionRecord`, and the shape `planCompaction` expects to meet
 * again — the same `SUMMARY_LEAD`, in a `user` message straight after the system prompts — so the
 * next compaction continues these notes rather than summarising them a second time. Any earlier
 * summary in the kept head is dropped, since the record's already contains it.
 *
 * Nothing it writes is a `system` message, so a request that puts one system prompt ahead of it has
 * exactly one, at index 0, which is all the Qwen3.5 and later templates accept. The summary sits
 * before the question, never after it, because those templates also take the last user message as
 * the query their scratchpad is kept for.
 */
export function applyCompaction(
  messages: Message[],
  record?: Pick<CompactionRecord, 'summary' | 'through' | 'question'>,
  { from }: { from?: number } = {},
): Message[] {
  if (!record?.summary.trim()) {
    return messages;
  }
  const head = clamp(from ?? systemHead(messages).from, record.through);
  const question = keptQuestion(record, head);
  return [
    ...messages.slice(0, head).filter((message) => isSummary(message) === false && isAck(message) === false),
    ...summaryMessages(record.summary),
    ...(question === undefined ? [] : [messages[question]]),
    ...messages.slice(record.through),
  ];
}

/**
 * The question a compaction sends after its summary, unless the kept head already holds it.
 *
 * @param record - The compaction.
 * @param head - How many messages are kept ahead of the summary.
 * @returns `record.question` where it lies from `head` up to `through`, otherwise `undefined`.
 */
const keptQuestion = ({ question, through }: Pick<CompactionRecord, 'through' | 'question'>, head: number) =>
  question !== undefined && question >= head && question < through ? question : undefined;

/**
 * Where a stored index sits in the request `applyCompaction` builds, once a compaction has shifted
 * everything after it.
 *
 * @param index - The position in the stored transcript.
 * @param [record] - The compaction in force, or `undefined` for a session that has none, which
 * hands the index straight back.
 * @param [head] - How many messages the request keeps ahead of the summary — the leading system
 * prompts, when the app keeps them in the array. Zero is the stored-compaction case,
 * where the summary is the request's first message.
 * @returns The index in the request. One before the record's `through` gives `head`, where the
 * summary sits — an index among the kept head messages themselves included — except the record's
 * `question`, which is sent whole right after the summary and its reply.
 *
 * @remarks
 * A transcript that stays append-only and a request that does not are two numberings of the same
 * conversation, and anything that names a position — `withContext`'s index, a range handed to a
 * hook — has to say which it is in. An index inside the compacted stretch answers with the summary
 * message that now stands for it.
 */
export const requestIndex = (
  index: number,
  record?: Pick<CompactionRecord, 'through' | 'question'>,
  head = 0,
): number => {
  if (!record) {
    return index;
  }
  const question = keptQuestion(record, head);
  if (index === question) {
    return head + SUMMARY_SIZE;
  }
  const afterSummary = question === undefined ? SUMMARY_SIZE : SUMMARY_SIZE + 1;
  return index < record.through ? head : index - record.through + head + afterSummary;
};

/**
 * The transcript with the plan's stretch replaced by its summary, as `applyCompaction` writes it.
 *
 * @param messages - The transcript the plan was made for. Not written to.
 * @param plan - What `planCompaction` returned for it.
 * @param summarise - Writes the summary from the text it is handed. See `summariser`. Not called
 * when a hook vetoes.
 * @param [options] - Hooks to tell and whether the context window is already past. See
 * `CompactionRunOptions`.
 * @returns `messages` itself when nothing was compacted — a veto or an empty summary — otherwise a
 * new array.
 *
 * @remarks
 * `beforeCompact` is told what is being compacted while the summary is written, beside it rather
 * than ahead of it — a memory server filing it is not a rescue worth making the exchange wait for,
 * and `notify` never rejects. An app that wants its hooks able to stop a compaction sets
 * `honourVeto`, and then they run first and the summary waits on them: any `ok` outcome carrying
 * `veto` leaves the transcript as it was, and each vetoing hook is noted by name. A `forced`
 * compaction ignores a veto and runs the hooks beside the summary as before, because an exchange
 * already past its context window has no better option — a veto there only trades the summary for
 * a `ContextOverflow`. An empty summary compacts nothing either. Rewrites the prefix; see the
 * module comment on when to run it.
 *
 * `runCompaction` and `applyCompaction` are its two halves, and it is nothing but the two in
 * order, so an app that stores the compaction instead of the array gets the same summary at the
 * same cut rather than a second implementation that drifts from this one.
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
