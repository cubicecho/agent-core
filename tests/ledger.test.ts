import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { planCompaction } from '../src/compaction.ts';
import {
  estimateFrom,
  type LedgerRequest,
  rebaseLedger,
  recordRequest,
  type TokenLedger,
  tokensBetween,
} from '../src/ledger.ts';
import { messageChars } from '../src/tokens.ts';

type Message = OpenAI.ChatCompletionMessageParam;

const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string): Message => ({ role: 'assistant', content });
const result = (content: string): Message => ({ role: 'tool', tool_call_id: 'c', content });
/** Every unmeasured message costs seven, so an estimate is easy to tell from a measurement. */
const estimate = () => 7;

/**
 * A question, two steps of tools, the answer, and the next question. Requests ended at 0, 2 and 5,
 * so the measured groups are [1, 2] and [3, 4, 5]; 6 and 7 have not been sent.
 */
const transcript: Message[] = [
  user('q1'),
  assistant('call'),
  result('one'),
  assistant('xx'),
  assistant('xx'),
  assistant('xx'),
  assistant('answer'),
  user('q2'),
];
const ledger: TokenLedger = [
  { through: 0, prompt: 100, epoch: 0 },
  { through: 2, prompt: 160, epoch: 0 },
  { through: 5, prompt: 400, epoch: 0 },
];

describe('recordRequest', () => {
  const first: LedgerRequest = { messages: [user('q')], tools: ['a'], prompt: 100, through: 0 };
  const second: LedgerRequest = {
    messages: [...first.messages, assistant('call'), result('ok')],
    tools: ['a'],
    prompt: 130,
    through: 2,
  };

  it('starts an epoch with nothing before it, and keeps it while requests only append', () => {
    const one = recordRequest([], undefined, first);
    expect(one).toEqual([{ through: 0, prompt: 100, epoch: 0 }]);
    expect(recordRequest(one, first, second)).toEqual([
      { through: 0, prompt: 100, epoch: 0 },
      { through: 2, prompt: 130, epoch: 0 },
    ]);
    // Not written to.
    expect(one).toHaveLength(1);
  });

  it('starts a new epoch where the history was rewritten, the head moved, or the tools grew', () => {
    const one = recordRequest([], undefined, first);
    const epochOf = (next: LedgerRequest) => recordRequest(one, first, next).at(-1)?.epoch;
    expect(epochOf({ ...second, messages: [user('shorter'), ...second.messages.slice(1)] })).toBe(1);
    expect(epochOf({ ...second, messages: [{ role: 'system', content: 's' }, ...second.messages] })).toBe(1);
    expect(epochOf({ ...second, tools: ['a', 'b'] })).toBe(1);
    // And where the request before is not known, which is every run's first.
    expect(recordRequest(one, undefined, second).at(-1)?.epoch).toBe(1);
  });

  it('records nothing for a request that reported no prompt', () => {
    const one = recordRequest([], undefined, first);
    expect(recordRequest(one, first, { ...second, prompt: 0 })).toBe(one);
  });

  it('measures across a request that reported nothing, against the last one that did', () => {
    const one = recordRequest([], undefined, first);
    const third: LedgerRequest = {
      messages: [...second.messages, assistant('again'), result('ok')],
      tools: ['a'],
      prompt: 190,
      through: 4,
    };
    const skipped = recordRequest(one, first, { ...second, prompt: 0 });
    expect(recordRequest(skipped, first, third)).toEqual([
      { through: 0, prompt: 100, epoch: 0 },
      { through: 4, prompt: 190, epoch: 0 },
    ]);
  });

  it('leaves the first reading standing when the same request is sent again', () => {
    const one = recordRequest([], undefined, first);
    expect(recordRequest(one, first, { ...first, prompt: 140 })).toBe(one);
  });
});

describe('tokensBetween', () => {
  it('subtracts between two recorded boundaries, exactly', () => {
    expect(tokensBetween(ledger, 1, 3, transcript, { estimate })).toBe(60);
    expect(tokensBetween(ledger, 3, 6, transcript, { estimate })).toBe(240);
    expect(tokensBetween(ledger, 1, 6, transcript, { estimate })).toBe(300);
  });

  it("divides a group's total by character share for a stretch that ends or starts inside it", () => {
    // Three messages of the same size share 240 evenly.
    expect(tokensBetween(ledger, 3, 4, transcript, { estimate })).toBe(80);
    expect(tokensBetween(ledger, 4, 6, transcript, { estimate })).toBe(160);
    // From inside one group to inside the next: a share of each.
    const [call, one] = [messageChars(transcript[1]), messageChars(transcript[2])];
    expect(tokensBetween(ledger, 2, 5, transcript, { estimate })).toBe(Math.round((60 * one) / (call + one) + 160));
    expect(tokensBetween(ledger, 1, 2, transcript) + tokensBetween(ledger, 2, 3, transcript)).toBe(60);
  });

  it('estimates what nothing measured: before the first entry, and what has not been sent', () => {
    expect(tokensBetween(ledger, 0, 1, transcript, { estimate })).toBe(7);
    expect(tokensBetween(ledger, 6, 8, transcript, { estimate })).toBe(14);
    expect(tokensBetween(ledger, 0, 8, transcript, { estimate })).toBe(7 + 300 + 14);
    expect(tokensBetween([], 0, 8, transcript, { estimate })).toBe(56);
    // The default estimate is the calibrated one, at the divisor given.
    expect(tokensBetween([], 0, 1, transcript, { charsPerToken: 2 })).toBe(Math.ceil(messageChars(transcript[0]) / 2));
  });

  it('clamps a range that runs off either end, and counts nothing for an empty one', () => {
    expect(tokensBetween(ledger, -5, 99, transcript, { estimate })).toBe(321);
    expect(tokensBetween(ledger, 4, 4, transcript, { estimate })).toBe(0);
  });

  it('does not subtract across an epoch, and still does inside the ones either side', () => {
    const crossed: TokenLedger = [
      { through: 0, prompt: 100, epoch: 0 },
      { through: 2, prompt: 160, epoch: 0 },
      // The prefix was rewritten here, so 90 against 160 says nothing about messages 3 to 5.
      { through: 5, prompt: 90, epoch: 1 },
      { through: 7, prompt: 150, epoch: 1 },
    ];
    expect(tokensBetween(crossed, 1, 3, transcript, { estimate })).toBe(60);
    expect(tokensBetween(crossed, 3, 6, transcript, { estimate })).toBe(21);
    expect(tokensBetween(crossed, 6, 8, transcript, { estimate })).toBe(60);
    // A rise across the boundary is no more trustworthy than a fall.
    const rising = crossed.map((entry) => (entry.epoch ? { ...entry, prompt: 500 } : entry));
    expect(tokensBetween(rising, 3, 6, transcript, { estimate })).toBe(21);
  });

  it('does not trust a difference of zero or less', () => {
    const flat: TokenLedger = [
      { through: 0, prompt: 100, epoch: 0 },
      { through: 2, prompt: 100, epoch: 0 },
      { through: 5, prompt: 40, epoch: 0 },
    ];
    expect(tokensBetween(flat, 1, 3, transcript, { estimate })).toBe(14);
    expect(tokensBetween(flat, 3, 6, transcript, { estimate })).toBe(21);
  });

  it('estimates a group the transcript does not reach the end of', () => {
    expect(tokensBetween(ledger, 3, 5, transcript.slice(0, 5), { estimate })).toBe(14);
  });
});

describe('estimateFrom', () => {
  it('answers a measured message with its share, and any other with the estimate', () => {
    const cost = estimateFrom(ledger, transcript, { estimate });
    expect(cost(transcript[3])).toBe(80);
    expect(cost(transcript[1]) + cost(transcript[2])).toBeCloseTo(60);
    expect(cost(transcript[0])).toBe(7);
    expect(cost(transcript[7])).toBe(7);
    // Known by identity: a copy is a message it has not seen.
    expect(cost({ ...transcript[3] })).toBe(7);
  });

  it('is the per-message function planCompaction already takes', () => {
    const messages = [user('1'), assistant('a'), user('2'), assistant('b'), user('3')];
    const measured: TokenLedger = [
      { through: 0, prompt: 100, epoch: 0 },
      { through: 2, prompt: 3000, epoch: 0 },
      { through: 4, prompt: 3020, epoch: 0 },
    ];
    const window = { limit: 4000, used: 3200, keepRatio: 0.1 };
    // By the estimate every message is seven and the whole tail fits, so the cut is the earliest
    // legal one. Measured, the first exchange is 2900 of the 3020 and does not fit in a tenth of
    // the window, so the kept tail starts at the last question.
    expect(planCompaction(messages, { ...window, estimate })).toMatchObject({ cut: 2 });
    const plan = planCompaction(messages, {
      ...window,
      estimate: estimateFrom(measured, messages, { estimate }),
    });
    expect(plan).toMatchObject({ from: 0, cut: 4 });
  });
});

describe('rebaseLedger', () => {
  const before = [
    user('q1'),
    assistant('a1'),
    user('q2'),
    assistant('call'),
    result('x'.repeat(50)),
    assistant('call'),
    result('y'),
  ];
  const kept: TokenLedger = [
    { through: 2, prompt: 100, epoch: 0 },
    { through: 4, prompt: 150, epoch: 0 },
    { through: 6, prompt: 230, epoch: 0 },
  ];

  it('hands the ledger back for a transcript that only grew, or is the same array', () => {
    expect(rebaseLedger(kept, before, before)).toBe(kept);
    expect(rebaseLedger(kept, before, [...before, assistant('more')])).toBe(kept);
  });

  it("moves the kept tail's boundaries with it when the head is folded", () => {
    const after = [{ role: 'system', content: 'summary' } as Message, ...before.slice(2)];
    const moved = rebaseLedger(kept, before, after);
    expect(moved).toEqual([
      { through: 1, prompt: 100, epoch: 1 },
      { through: 3, prompt: 150, epoch: 1 },
      { through: 5, prompt: 230, epoch: 1 },
    ]);
    // What the two steps cost is still a subtraction, at their new indexes.
    expect(tokensBetween(moved, 2, 4, after, { estimate })).toBe(50);
    expect(tokensBetween(moved, 4, 6, after, { estimate })).toBe(80);
  });

  it('drops only the group a prune touched', () => {
    const after = before.map((message, at) => (at === 4 ? result('[result cleared]') : message));
    const moved = rebaseLedger(kept, before, after);
    expect(moved).toEqual([
      { through: 2, prompt: 100, epoch: 0 },
      { through: 4, prompt: 150, epoch: 1 },
      { through: 6, prompt: 230, epoch: 1 },
    ]);
    // The stubbed result's group is estimated; the one after it is still measured.
    expect(tokensBetween(moved, 3, 5, after, { estimate })).toBe(14);
    expect(tokensBetween(moved, 5, 7, after, { estimate })).toBe(80);
  });

  it('keeps nothing of a transcript replaced outright', () => {
    expect(rebaseLedger(kept, before, [user('new')])).toEqual([]);
  });
});
