import { describe, expect, it } from 'vitest';
import {
  AgentLoopError,
  type AgentLoopFailure,
  AgentLoopOverflow,
  errorMessage,
  failedRun,
  ToolIterationLimit,
} from '../../src/wire/errors.ts';
import { ContextOverflow } from '../../src/wire/retry.ts';
import { loopUsage } from '../../src/wire/stream.ts';
import { assistant, user } from '../helpers.ts';

/** A run with every field of `AgentLoopFailure` set, each to something it can be told apart by. */
const whole = (): Required<AgentLoopFailure> => ({
  messages: [user('hi'), assistant('hello')],
  partial: { content: 'half an answer', reasoning: 'thinking' },
  usage: loopUsage({ prompt: 10, completion: 2, total: 12, cached: 4 }, true),
  toolCalls: [{ id: 'c1', name: 'read', ok: true }],
  artifacts: [{ link: { uri: 'file:///a.md', name: 'a.md' }, callId: 'c1', tool: 'read', step: 0, count: 1 }],
  loaded: ['read'],
  used: ['read'],
  preselected: ['read', 'write'],
  ledger: [{ through: 1, prompt: 10, epoch: 0 }],
  remoteRunId: 'remote-1',
});

/** The same run with every optional field left out. */
const bare = (): AgentLoopFailure => ({
  messages: [user('hi')],
  usage: loopUsage({ prompt: 0, completion: 0, total: 0, cached: 0 }, false),
  toolCalls: [],
  loaded: [],
  used: [],
  preselected: [],
});

/** The two classes that carry a run, built the same way. */
const carriers = [
  ['AgentLoopError', AgentLoopError],
  ['ToolIterationLimit', ToolIterationLimit],
  ['AgentLoopOverflow', AgentLoopOverflow],
] as const;

describe.each(carriers)('%s', (name, Carrier) => {
  it('holds every field of the run it is given, the same objects', () => {
    const run = whole();
    const error = new Carrier('went wrong', run);
    expect(error.messages).toBe(run.messages);
    expect(error.partial).toBe(run.partial);
    expect(error.usage).toBe(run.usage);
    expect(error.toolCalls).toBe(run.toolCalls);
    expect(error.artifacts).toBe(run.artifacts);
    expect(error.loaded).toBe(run.loaded);
    expect(error.used).toBe(run.used);
    expect(error.preselected).toBe(run.preselected);
    expect(error.ledger).toBe(run.ledger);
    expect(error.remoteRunId).toBe(run.remoteRunId);
  });

  it('fills an absent artifacts and ledger with empty lists, and leaves partial and remoteRunId undefined', () => {
    const error = new Carrier('went wrong', bare());
    expect(error.artifacts).toEqual([]);
    expect(error.ledger).toEqual([]);
    expect(error.partial).toBeUndefined();
    expect(error.remoteRunId).toBeUndefined();
  });

  it('keeps the message and the cause it is given', () => {
    const cause = new Error('underneath');
    const error = new Carrier('went wrong', bare(), { cause });
    expect(error.message).toBe('went wrong');
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });

  it('is read back by failedRun as itself', () => {
    const error = new Carrier('went wrong', whole());
    expect(failedRun(error)).toBe(error);
  });

  it('is named for its class', () => {
    const expected = name === 'AgentLoopOverflow' ? 'ContextOverflow' : name;
    expect(new Carrier('went wrong', bare()).name).toBe(expected);
  });
});

describe('ToolIterationLimit', () => {
  it('is an AgentLoopError', () => {
    expect(new ToolIterationLimit('spent', bare())).toBeInstanceOf(AgentLoopError);
  });
});

describe('AgentLoopOverflow', () => {
  it('stays a ContextOverflow, and is not an AgentLoopError', () => {
    const error = new AgentLoopOverflow('too long', bare());
    expect(error).toBeInstanceOf(ContextOverflow);
    expect(error).not.toBeInstanceOf(AgentLoopError);
  });
});

describe('failedRun', () => {
  it('answers undefined for anything the loop did not throw', () => {
    expect(failedRun(new Error('plain'))).toBeUndefined();
    expect(failedRun(new ContextOverflow('too long'))).toBeUndefined();
    expect(failedRun('a string')).toBeUndefined();
    expect(failedRun(undefined)).toBeUndefined();
    // Shaped like a run, but not one of the classes that carry it.
    expect(failedRun(whole())).toBeUndefined();
  });
});

describe('errorMessage', () => {
  it("reads an Error's message as it is, empty included", () => {
    expect(errorMessage(new Error('broke'))).toBe('broke');
    expect(errorMessage(new Error(''))).toBe('');
  });

  it('stringifies anything that is not an Error', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage({ message: 'not an error' })).toBe('[object Object]');
  });
});
