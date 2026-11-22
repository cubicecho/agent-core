import { describe, expect, it } from 'vitest';
import { dropReasoning, formatToolError, oneCallPerMessage, preview, splitCalls } from '../../src/run/run-calls.ts';
import { REASONING_CONTENT, Role } from '../../src/wire/wire.ts';
import { assistant, pairsByPosition, result, singleCallRefusal, toolCall, user } from '../helpers.ts';

describe('preview', () => {
  it('cuts long text and says how long it was', () => {
    expect(preview('abc', 5)).toBe('abc');
    expect(preview('abcdefgh', 5)).toBe('abcde… (8 chars)');
  });
});

describe('formatToolError', () => {
  it('opens a failure with Error: so it cannot read as an answer', () => {
    expect(formatToolError(new Error('42'))).toBe('Error: 42');
    expect(formatToolError('no rows')).toBe('Error: no rows');
  });

  it('leaves a message that already opens with error as it was', () => {
    expect(formatToolError(new Error('Error: disk full'))).toBe('Error: disk full');
    expect(formatToolError(new Error('error 404 from upstream'))).toBe('error 404 from upstream');
    expect(formatToolError(new Error('Errors were found'))).toBe('Error: Errors were found');
  });

  it('says a failure that gave no message failed all the same', () => {
    expect(formatToolError(new Error(''))).toBe('Error: (no output)');
    expect(formatToolError(new Error('  \n'))).toBe('Error: (no output)');
  });
});

/** An assistant message making these calls, with something said and thought beside them. */
const asking = (...ids: string[]) => ({
  role: Role.Assistant,
  content: 'Reading both.',
  [REASONING_CONTENT]: 'both files',
  tool_calls: ids.map((id) => toolCall(id)),
});

describe('splitCalls', () => {
  it('writes one message per call, keeping the text and the scratchpad on the first', () => {
    expect(splitCalls(asking('a', 'b'))).toEqual([
      {
        role: Role.Assistant,
        content: 'Reading both.',
        [REASONING_CONTENT]: 'both files',
        tool_calls: [toolCall('a')],
      },
      { role: Role.Assistant, content: null, tool_calls: [toolCall('b')] },
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
    const transcript = [
      user('read a and b'),
      asking('a', 'b'),
      result('a ran', 'a'),
      result('b ran', 'b'),
      assistant('done'),
    ];
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
    const split = oneCallPerMessage([
      user('go'),
      asking('a', 'b', 'c'),
      result('c ran', 'c'),
      result('a ran', 'a'),
      result('b ran', 'b'),
    ]);
    expect(pairsByPosition(split)).toBe(true);
  });

  it('keeps a result that answers none of the calls, after the last pair', () => {
    const stray = result('x ran', 'x');
    const split = oneCallPerMessage([user('go'), asking('a', 'b'), result('a ran', 'a'), stray, result('b ran', 'b')]);
    expect(split.at(-1)).toBe(stray);
    expect(split).toHaveLength(6);
  });

  it('hands back the transcript itself when nothing needs splitting, and a split one unchanged', () => {
    const transcript = [user('go'), asking('a'), result('a ran', 'a'), assistant('done')];
    expect(oneCallPerMessage(transcript)).toBe(transcript);
    const split = oneCallPerMessage([user('go'), asking('a', 'b'), result('a ran', 'a'), result('b ran', 'b')]);
    expect(oneCallPerMessage(split)).toBe(split);
  });
});

describe('dropReasoning', () => {
  it('copies only the messages that carry a scratchpad, and hands back a transcript with none as it is', () => {
    const transcript = [user('go'), asking('a'), result('a ran', 'a')];
    const dropped = dropReasoning(transcript);
    expect(dropped[1]).not.toHaveProperty(REASONING_CONTENT);
    expect(dropped[2]).toBe(transcript[2]);
    expect(dropReasoning(dropped)).toBe(dropped);
  });
});
