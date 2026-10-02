import type OpenAI from 'openai';
import type { TurnUsage } from './stream.ts';
import { messageChars, messageTokens, type TokenEstimateOptions } from './tokens.ts';

/**
 * What stretches of a transcript cost, read off the prompt counts the server already reported.
 *
 * A calibrated divisor fixes the average and nothing else: a transcript is tool results, JSON
 * arguments, code and prose, each at its own ratio, plus whatever the chat template adds per
 * message. But a request that only appended to the one before it differs from it by exactly the
 * cost of what was appended, so two reported prompts and a subtraction say what no estimate can —
 * the template's tokens and a tool result's real density included, and reasoning, which is never
 * replayed, left out.
 *
 * Everything here is a pure function over a plain array, so a host with its own loop keeps a ledger
 * the same way `runAgentLoop` does, and stores it however it stores the transcript.
 */

type Message = OpenAI.ChatCompletionMessageParam;

/**
 * One request's reported prompt, and how far into the transcript that request reached.
 *
 * Three numbers and nothing else, so it serialises as it is: a host that stores a row per message
 * keeps `prompt` and `epoch` in two columns on the row `through` names, and one that stores a
 * session keeps the array beside it.
 */
export interface LedgerEntry {
  /**
   * The index, in the host's transcript, of the last message the request carried. A system prompt
   * the host keeps outside the transcript is not counted, and −1 is a request that carried none of
   * the transcript at all.
   */
  through: number;
  /** The prompt tokens the endpoint reported for that request, everything ahead of it included. */
  prompt: number;
  /**
   * Which unbroken run of appending the request belongs to. Two entries with the same epoch shared
   * everything up to the earlier one's last message, so their prompts subtract; two with different
   * epochs did not, and the difference between them means nothing.
   */
  epoch: number;
}

/** A transcript's entries in the order their requests were sent, which is also by `through`. */
export type TokenLedger = LedgerEntry[];

/** The part of a request that decides whether the next one only appended to it. */
export interface RequestShape {
  /** The messages as they were sent, a system prompt and any context a hook added included. */
  messages: Message[];
  /** The names of the tools declared, in the order they were sent. Absent is none. */
  tools?: readonly string[];
}

/** What `recordRequest` needs to know of one request. */
export interface LedgerRequest extends RequestShape {
  /** The prompt tokens the endpoint reported. Zero or less is no report, and records nothing. */
  prompt: number;
  /** The index, in the host's transcript, of the last message the request carried. */
  through: number;
}

/** What `tokensBetween` and `estimateFrom` take besides the ledger and the transcript. */
export interface LedgerEstimateOptions extends TokenEstimateOptions {
  /**
   * One unmeasured message's tokens. `messageTokens` by default, divided by `charsPerToken` — the
   * calibrated estimate, given `charsPerTokenFor` the model.
   */
  estimate?: (message: Message) => number;
}

/** Whether two messages say the same thing, by identity first since most of a transcript is. */
const sameMessage = (a: Message, b: Message) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Whether two requests declared the same tools in the same order. */
const sameTools = (previous: RequestShape, next: RequestShape) => {
  const before = previous.tools ?? [];
  const now = next.tools ?? [];
  return before.length === now.length && before.every((name, at) => name === now[at]);
};

/** Whether a request sent every message the one before it did, in the same place. */
const keptMessages = (previous: Message[], next: Message[]) =>
  previous.length <= next.length && previous.every((message, at) => sameMessage(message, next[at]));

/** Whether a request sent everything the one before it did, in the same place, and then more. */
const appended = (previous: RequestShape, next: RequestShape) =>
  sameTools(previous, next) && keptMessages(previous.messages, next.messages);

/** The system messages a request opens with, which a template renders ahead of the history. */
const leadingSystem = (messages: Message[]) => {
  const end = messages.findIndex((message) => message.role !== 'system');
  return messages.slice(0, end === -1 ? messages.length : end);
};

/**
 * Where a request stopped matching the one before it, earliest in the rendered prompt first — the
 * tool block, then the system prompt, then the history — or `none-known` where it only appended.
 *
 * Beside `recordRequest` because it is the same comparison asked for a different reason: that one
 * wants to know whether two prompts subtract, and this one why a cache that should have held
 * did not.
 *
 * @param previous The request before, as it was sent.
 * @param next The request being explained.
 */
export function breakReason(previous: RequestShape, next: RequestShape): NonNullable<TurnUsage['cacheBreakReason']> {
  if (!sameTools(previous, next)) {
    return 'tools-changed';
  }
  const before = leadingSystem(previous.messages);
  const now = leadingSystem(next.messages);
  const systemKept = before.length === now.length && keptMessages(before, now);
  if (!systemKept) {
    return 'system-changed';
  }
  if (!keptMessages(previous.messages, next.messages)) {
    return 'history-rewritten';
  }
  return 'none-known';
}

/**
 * The ledger with one more request on it, in the epoch the request before it says it belongs to.
 *
 * The epoch carries on only where the new request declared the same tools in the same order and
 * sent every earlier message unchanged — the case in which the two prompts subtract. Anything else
 * starts a new one: a fold, a prune, a system prompt that moved, and a tool array that grew, whose
 * schema would otherwise be counted as the cost of the messages beside it. A request that reported
 * no prompt records nothing, and neither does one that reaches no further than the last entry in
 * the same epoch, so a retry or a continuation leaves the first reading standing.
 *
 * @param ledger The ledger so far. Not written to; handed back as it is when nothing is recorded.
 * @param previous The request the ledger's last entry was recorded from — not merely the last one
 * sent, so that a request which reported nothing is skipped over rather than compared against.
 * `undefined` where that is not known, which starts a new epoch.
 * @param next The request just answered.
 */
export function recordRequest(
  ledger: TokenLedger,
  previous: LedgerRequest | undefined,
  next: LedgerRequest,
): TokenLedger {
  if (!(next.prompt > 0)) {
    return ledger;
  }
  const last = ledger.at(-1);
  if (last && previous && appended(previous, next)) {
    if (next.through <= last.through) {
      return ledger;
    }
    return [...ledger, { through: next.through, prompt: next.prompt, epoch: last.epoch }];
  }
  return [...ledger, { through: next.through, prompt: next.prompt, epoch: last ? last.epoch + 1 : 0 }];
}

/**
 * The ledger for a transcript that has been rewritten, keeping the boundaries the rewrite left
 * standing.
 *
 * A difference inside an epoch stays true after the epoch ends, since the prefix the two requests
 * shared cancels whatever became of it. So the entries that fall in the part of the transcript
 * still at its head keep their place, the ones in the part still at its tail move with it, and
 * only the ones in between — the messages a fold removed or a prune stubbed — are dropped. The
 * tail's entries move to a later epoch as well, so no difference is read across the rewrite.
 *
 * @param ledger The ledger for `before`. Not written to.
 * @param before The transcript the ledger's indexes are in.
 * @param after The transcript that replaces it. One that only appended to `before`, or is the same
 * array, hands the ledger back as it is.
 */
export function rebaseLedger(ledger: TokenLedger, before: readonly Message[], after: readonly Message[]): TokenLedger {
  if (before === after) {
    return ledger;
  }
  const shortest = Math.min(before.length, after.length);
  let head = 0;
  while (head < shortest && sameMessage(before[head], after[head])) {
    head++;
  }
  if (head === before.length) {
    return ledger;
  }
  let tail = 0;
  while (tail < shortest - head && sameMessage(before[before.length - 1 - tail], after[after.length - 1 - tail])) {
    tail++;
  }
  // The boundary just ahead of a kept tail stands too: what follows it is all still there. With
  // no tail kept there is nothing left for it to be the start of.
  const start = tail > 0 ? before.length - tail - 1 : before.length;
  const shift = after.length - before.length;
  const rebased: LedgerEntry[] = [];
  for (const entry of ledger) {
    if (entry.through < head) {
      rebased.push(entry);
    } else if (entry.through >= start) {
      rebased.push({ ...entry, through: entry.through + shift, epoch: entry.epoch + 1 });
    }
  }
  return rebased;
}

/**
 * Each measured message's share of its group's cost, by index. A group is the messages between two
 * neighbouring entries of one epoch, and is left out — for the estimate to answer — where the
 * difference is not above zero, where the entries are out of order, or where the transcript does
 * not reach its end.
 */
function shares(ledger: TokenLedger, messages: readonly Message[]): Map<number, number> {
  const out = new Map<number, number>();
  let floor = 0;
  for (let at = 1; at < ledger.length; at++) {
    const from = ledger[at - 1];
    const to = ledger[at];
    const tokens = to.prompt - from.prompt;
    const start = from.through + 1;
    const end = to.through + 1;
    if (from.epoch !== to.epoch || !(tokens > 0)) {
      continue;
    }
    if (start < floor || end <= start || end > messages.length) {
      continue;
    }
    floor = end;
    const chars: number[] = [];
    let total = 0;
    for (let index = start; index < end; index++) {
      chars.push(messageChars(messages[index]));
      total += chars[index - start];
    }
    for (let index = start; index < end; index++) {
      out.set(index, (tokens * chars[index - start]) / total);
    }
  }
  return out;
}

/** The estimate for a message nothing measured, as the options ask for it. */
const fallback = ({ charsPerToken, estimate }: LedgerEstimateOptions) =>
  estimate ?? ((message: Message) => messageTokens(message, { charsPerToken }));

/**
 * What the messages from `from` up to, not including, `to` cost the window, measured where the
 * ledger can say and estimated where it cannot.
 *
 * Between two boundaries recorded in one epoch it is a subtraction and exact. A boundary falls
 * after a question and after each step's tool results, never after an assistant message, so a
 * stretch that starts or ends inside a group is given that group's measured total divided by
 * character share — the way `contextTokens` divides a reported prompt — and messages no pair of
 * entries covers fall back to the estimate: the ones before the first entry, the group either side
 * of an epoch's end, and whatever has not been sent yet.
 *
 * A difference of zero or less is not trusted and is estimated instead. That is how a server
 * reporting `prompt_tokens` net of its cache would show up, though one whose net counts still
 * happened to rise would not be caught by it.
 *
 * @param ledger The ledger kept for `messages`.
 * @param from The first message counted. Below zero counts from the start.
 * @param to The first message not counted, as `slice` takes it. Past the end counts to the end.
 * @param messages The transcript the ledger's indexes are in.
 * @param options The estimate for what is not measured: a divisor, or a function of the caller's.
 * @returns Whole tokens, rounded once over the stretch rather than per message.
 */
export function tokensBetween(
  ledger: TokenLedger,
  from: number,
  to: number,
  messages: readonly Message[],
  options: LedgerEstimateOptions = {},
): number {
  const measured = shares(ledger, messages);
  const estimate = fallback(options);
  let total = 0;
  for (let at = Math.max(0, from); at < Math.min(to, messages.length); at++) {
    total += measured.get(at) ?? estimate(messages[at]);
  }
  return Math.round(total);
}

/**
 * A per-message cost for `planCompaction`'s `estimate`: the measured share where the ledger covers
 * the message, the calibrated estimate where it does not.
 *
 * The planner asks about one message at a time, and nothing reports anything that fine, so a
 * measured message is given its group's total by character share. The shares are not rounded,
 * which is what makes a whole group of them add back up to the difference the server reported.
 *
 * @param ledger The ledger kept for `messages`.
 * @param messages The transcript the plan will be made for. The function it returns knows a
 * message by identity, so it has to be asked about these objects and not copies of them; one it
 * does not know is estimated.
 * @param options The estimate for what is not measured: a divisor, or a function of the caller's.
 */
export function estimateFrom(
  ledger: TokenLedger,
  messages: readonly Message[],
  options: LedgerEstimateOptions = {},
): (message: Message) => number {
  const estimate = fallback(options);
  const measured = new Map<Message, number>();
  for (const [at, tokens] of shares(ledger, messages)) {
    measured.set(messages[at], tokens);
  }
  return (message) => measured.get(message) ?? estimate(message);
}
