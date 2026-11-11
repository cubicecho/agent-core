import { describe, expect, it } from 'vitest';
import { callIdMinter, callIdsIn, distinctCallIds, freshCallId, mintCallId } from '../../src/wire/call-ids.ts';
import type { ToolCall } from '../../src/wire/tool-calls.ts';
import { FUNCTION_TOOL, Role } from '../../src/wire/wire.ts';
import { type Message, MINTED_ID } from '../helpers.ts';

/** A call to `t` under this id. */
const call = (id: string): ToolCall => ({ id, type: FUNCTION_TOOL, function: { name: 't', arguments: '{}' } });

describe('callIdMinter', () => {
  it('gives nine alphanumerics every time, and ten thousand of them are all different', () => {
    const ids = Array.from({ length: 10_000 }, () => mintCallId());
    expect(ids.every((id) => MINTED_ID.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives one sequence for one seed, and another for another', () => {
    const run = (seed: number) => {
      const mint = callIdMinter(seed);
      return Array.from({ length: 5 }, () => mint());
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
    expect(run(42).every((id) => MINTED_ID.test(id))).toBe(true);
  });
});

describe('distinctCallIds', () => {
  const history: Message[] = [
    { role: Role.User, content: 'hi' },
    { role: Role.Assistant, content: null, tool_calls: [call('c0')] },
    { role: Role.Tool, tool_call_id: 'c0', content: 'ok' },
    // A result whose call a host trimmed away still holds its id.
    { role: Role.Tool, tool_call_id: 'orphan', content: 'ok' },
  ];

  it('reads the ids of both calls and results', () => {
    expect(callIdsIn(history)).toEqual(new Set(['c0', 'orphan']));
  });

  it("keeps a server's id that is free as sent, whatever its shape", () => {
    const calls = [call('chatcmpl-tool-0123456789abcdef'), call('call_x')];
    const kept = distinctCallIds(calls, history);
    expect(kept[0]).toBe(calls[0]);
    expect(kept[1]).toBe(calls[1]);
  });

  it('replaces an empty id, one the transcript uses, and one an earlier call in the turn has', () => {
    const calls = [call(''), call('c0'), call('orphan'), call('dup'), call('dup')];
    const ids = distinctCallIds(calls, history).map(({ id }) => id);
    expect(ids[3]).toBe('dup');
    for (const at of [0, 1, 2, 4]) {
      expect(ids[at]).toMatch(MINTED_ID);
    }
    expect(new Set([...ids, 'c0', 'orphan']).size).toBe(ids.length + 2);
    // Copies: the turn as the server sent it is left as it was.
    expect(calls.map(({ id }) => id)).toEqual(['', 'c0', 'orphan', 'dup', 'dup']);
  });

  it('asks again where the minter gives an id already taken', () => {
    const given = ['c0', 'c0', 'fresh0001'];
    const mint = () => given.shift() ?? 'unused000';
    expect(distinctCallIds([call('')], history, mint)[0]?.id).toBe('fresh0001');
  });

  it('gives up on a minter that only repeats itself', () => {
    expect(() => freshCallId(new Set(['same00000']), () => 'same00000')).toThrow(/already uses/);
  });
});
