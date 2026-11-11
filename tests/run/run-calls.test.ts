import { describe, expect, it } from 'vitest';
import { oneCallPerMessage, preview, splitCalls } from '../../src/run/run-calls.ts';
import { FUNCTION_TOOL, REASONING_CONTENT, Role } from '../../src/wire/wire.ts';
import { assistant, type Message, pairsByPosition, singleCallRefusal, user } from '../helpers.ts';

describe('preview', () => {
  it('cuts long text and says how long it was', () => {
    expect(preview('abc', 5)).toBe('abc');
    expect(preview('abcdefgh', 5)).toBe('abcde… (8 chars)');
  });
});

/** A call under an id, of a tool named the same. */
const call = (id: string) => ({ id, type: FUNCTION_TOOL, function: { name: id, arguments: '{}' } });
/** A tool's answer to one call. */
const answer = (id: string): Message => ({ role: Role.Tool, tool_call_id: id, content: `${id} ran` });
/** An assistant message making these calls, with something said and thought beside them. */
const asking = (...ids: string[]) => ({
  role: Role.Assistant,
  content: 'Reading both.',
  [REASONING_CONTENT]: 'both files',
  tool_calls: ids.map(call),
});

describe('splitCalls', () => {
  it('writes one message per call, keeping the text and the scratchpad on the first', () => {
    expect(splitCalls(asking('a', 'b'))).toEqual([
      { role: Role.Assistant, content: 'Reading both.', [REASONING_CONTENT]: 'both files', tool_calls: [call('a')] },
      { role: Role.Assistant, content: null, tool_calls: [call('b')] },
    ]);
  });

  it('hands back a message with one call or none as it is', () => {
    const one = asking('a');
    expect(splitCalls(one)).toEqual([one]);
    expect(splitCalls(one)[0]).toBe(one);
  });
});

describe('oneCallPerMessage', () => {
  it('replays a message of two calls as two pairs that a single-call template renders', () => {
    const transcript = [user('read a and b'), asking('a', 'b'), answer('a'), answer('b'), assistant('done')];
    expect(singleCallRefusal(transcript)).toBe('This model only supports single tool-calls at once!');
    const split = oneCallPerMessage(transcript);
    expect(singleCallRefusal(split)).toBeUndefined();
    expect(pairsByPosition(split)).toBe(true);
    expect(
      split.map((message) => (message.role === Role.Tool ? `tool ${message.tool_call_id}` : message.role)),
    ).toEqual(['user', 'assistant', 'tool a', 'assistant', 'tool b', 'assistant']);
    // Every message the split did not touch is the same object, in the same place.
    expect(split[0]).toBe(transcript[0]);
    expect(split[5]).toBe(transcript[4]);
  });

  it('pairs each result with its call by id, whatever order the results were written in', () => {
    const split = oneCallPerMessage([user('go'), asking('a', 'b', 'c'), answer('c'), answer('a'), answer('b')]);
    expect(pairsByPosition(split)).toBe(true);
  });

  it('keeps a result that answers none of the calls, after the last pair', () => {
    const stray = answer('x');
    const split = oneCallPerMessage([user('go'), asking('a', 'b'), answer('a'), stray, answer('b')]);
    expect(split.at(-1)).toBe(stray);
    expect(split).toHaveLength(6);
  });

  it('hands back the transcript itself when nothing needs splitting, and a split one unchanged', () => {
    const transcript = [user('go'), asking('a'), answer('a'), assistant('done')];
    expect(oneCallPerMessage(transcript)).toBe(transcript);
    const split = oneCallPerMessage([user('go'), asking('a', 'b'), answer('a'), answer('b')]);
    expect(oneCallPerMessage(split)).toBe(split);
  });
});
