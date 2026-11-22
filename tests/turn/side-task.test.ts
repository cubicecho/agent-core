import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, resetCapabilities } from '../../src/endpoint/capabilities.ts';
import { NO_KEY } from '../../src/endpoint/client.ts';
import { AGENT_SPEC, type AgentSpec, parseSpec, resolveAgentSpec } from '../../src/spec/spec.ts';
import { clean, listLines, parseJson, type SideTask, taskCall, tryAsk } from '../../src/turn/side-task.ts';
import { sleep } from '../../src/wire/retry.ts';
import { estimateTokens } from '../../src/wire/tokens.ts';

describe('clean', () => {
  it('strips the decoration models put around a short answer', () => {
    expect(clean('  "Python Subprocess Pipe Hang."  ')).toBe('Python Subprocess Pipe Hang');
    expect(clean('- try the other approach')).toBe('try the other approach');
    expect(clean('2. second suggestion')).toBe('second suggestion');
    expect(clean('`code`')).toBe('code');
  });

  it('leaves an already-clean line alone', () => {
    expect(clean('Mutex vs Semaphore Differences')).toBe('Mutex vs Semaphore Differences');
  });
});

describe('parseJson', () => {
  it('reads a bare array', () => {
    expect(parseJson<string[]>('["a", "b"]')).toEqual(['a', 'b']);
  });

  it('reads a fenced block', () => {
    expect(parseJson<string[]>('```json\n["a"]\n```')).toEqual(['a']);
  });

  it('reads an array a model wrapped in prose', () => {
    expect(parseJson<string[]>('Sure! Here you go:\n["a", "b"]\nHope that helps.')).toEqual(['a', 'b']);
  });

  it('reads an object', () => {
    expect(parseJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it('gives up rather than throwing', () => {
    expect(parseJson('no json here')).toBeUndefined();
    expect(parseJson('[unterminated')).toBeUndefined();
    expect(parseJson('[one, two] or {maybe}')).toBeUndefined();
  });

  it('reads what it pulled out as looseJson does, repairs included', () => {
    expect(parseJson("Here:\n```json\n{'tools': ['read'], strict: True,}\n```")).toEqual({
      tools: ['read'],
      strict: true,
    });
  });
});

describe('estimateTokens', () => {
  it('approximates four characters to the token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(4000))).toBe(1000);
  });
});

describe('listLines', () => {
  it('strips the bullets and quotes a model decorates a list with', () => {
    const text = `1. "How do I update statistics?"\n- What is selectivity?\n* Can I force an index scan?`;
    expect(listLines(text, 3, 80)).toEqual([
      'How do I update statistics?',
      'What is selectivity?',
      'Can I force an index scan?',
    ]);
  });

  it('drops blank lines and anything too long to read at a glance', () => {
    const text = `Short one\n\n${'x'.repeat(90)}\nAlso short`;
    expect(listLines(text, 5, 80)).toEqual(['Short one', 'Also short']);
  });

  it('keeps at most the requested number', () => {
    expect(listLines('a\nb\nc\nd', 2, 80)).toEqual(['a', 'b']);
  });
});

describe('tryAsk', () => {
  it('reports a throwable that is not an Error', async () => {
    const notices: string[] = [];
    const onNotice = (message: string) => notices.push(message);
    expect(await tryAsk('naming', () => Promise.reject('just a string'), { onNotice })).toBeUndefined();
    expect(notices).toEqual(['naming: just a string']);
  });

  it('says nothing at all when nobody asked to be told', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await tryAsk('naming', () => Promise.reject(new Error('nope')))).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('lets a cancelled run through instead of reporting it as a failed side task', async () => {
    const abort = new OpenAI.APIUserAbortError();
    await expect(tryAsk('naming', () => Promise.reject(abort))).rejects.toBe(abort);
  });

  it("lets through an abort that landed between attempts, which is the signal's own error", async () => {
    const controller = new AbortController();
    controller.abort();
    const notices: string[] = [];
    const waiting = tryAsk('naming', () => sleep(1000, controller.signal), {
      onNotice: (message) => notices.push(message),
    });
    await expect(waiting).rejects.toBe(controller.signal.reason);
    expect(notices).toEqual([]);
  });

  it("lets through an abort whose reason is the caller's own, which no error class names", async () => {
    const controller = new AbortController();
    const reason = new Error('the user closed the tab');
    controller.abort(reason);
    const notices: string[] = [];
    const waiting = tryAsk('naming', () => sleep(1000, controller.signal), {
      onNotice: (message) => notices.push(message),
      signal: controller.signal,
    });
    await expect(waiting).rejects.toBe(reason);
    expect(notices).toEqual([]);
  });

  it('lets through whatever a cancelled call threw, since the cancel is why it threw', async () => {
    const controller = new AbortController();
    controller.abort();
    const cut = new Error('socket hang up');
    await expect(tryAsk('naming', () => Promise.reject(cut), { signal: controller.signal })).rejects.toBe(cut);
  });

  it('still reports a failure while the signal it was handed has not aborted', async () => {
    const notices: string[] = [];
    const got = await tryAsk('naming', () => Promise.reject(new Error('nope')), {
      onNotice: (message) => notices.push(message),
      signal: new AbortController().signal,
    });
    expect(got).toBeUndefined();
    expect(notices).toEqual(['naming: nope']);
  });
});

/** An agent whose own sampling is nothing a side task should pick up. */
const agent = (tasks: Record<string, unknown>) => {
  const { spec, errors } = parseSpec({
    spec: AGENT_SPEC,
    endpoint: { baseUrl: 'http://main/v1' },
    model: { model: 'big', temperature: 1, maxTokens: 4096, reasoningEffort: 'high' },
    tasks,
  });
  expect(errors).toEqual([]);
  return resolveAgentSpec([spec as AgentSpec]);
};

afterEach(() => resetCapabilities());

describe('taskCall', () => {
  const endpoint = { baseUrl: 'http://side/v1', apiKey: '' };

  it("hands back the task's own settings over the host's, and the host's where it has none", () => {
    const signal = new AbortController().signal;
    const task: SideTask = { model: 'small', endpoint, temperature: 0, reasoningEffort: 'low' };
    const call = taskCall(task, { signal, maxTokens: 64, temperature: 0.9 });
    expect(call.model).toBe('small');
    expect(call.endpoint).toBe(endpoint);
    expect(call.options).toEqual({ signal, maxTokens: 64, temperature: 0, reasoningEffort: 'low' });
  });

  it("leaves out what neither states, so the entry point's default is what applies", () => {
    const call = taskCall({ model: 'small', endpoint });
    expect(call.options).toEqual({});
    // Zero is a value: no ceiling, and deterministic.
    expect(taskCall({ model: 'small', endpoint, maxTokens: 0, temperature: 0 }).options).toEqual({
      maxTokens: 0,
      temperature: 0,
    });
  });

  it("lays a task's extraBody over the host's key by key", () => {
    const task: SideTask = { model: 'small', endpoint, extraBody: { top_k: 20, top_p: 0.8 } };
    const call = taskCall(task, { extraBody: { top_p: 0.95, min_p: 0.05 } });
    expect(call.options.extraBody).toEqual({ top_p: 0.8, min_p: 0.05, top_k: 20 });
    // A task with none leaves the host's as it was given.
    const host = { extraBody: { min_p: 0.05 } };
    expect(taskCall({ model: 'small', endpoint }, host).options.extraBody).toBe(host.extraBody);
  });

  it('takes a resolved task as it comes', () => {
    const { tasks } = agent({ title: { model: 'tiny', maxTokens: 32 } });
    const call = taskCall(tasks.title);
    expect(call).toEqual({
      endpoint: { baseUrl: 'http://main/v1', apiKey: '' },
      model: 'tiny',
      options: { maxTokens: 32 },
    });
  });

  it("keys a task on the agent's endpoint as the agent is keyed", () => {
    const main = { baseUrl: 'http://main/v1', apiKey: 'sk-main' };
    // The trailing slash is the same endpoint to a person and a different one to a cache.
    const same = taskCall({ model: 'tiny', endpoint: { baseUrl: 'http://main/v1/', apiKey: '' } }, {}, main);
    expect(same.endpoint).toEqual({ baseUrl: 'http://main/v1', apiKey: 'sk-main' });
    // One entry for the endpoint, so a refusal the main turn learned is known to the side task.
    expect(capabilitiesFor(same.endpoint)).toBe(capabilitiesFor(main));
    // Without the agent the endpoint is sent as it stands, and that is a second entry.
    const alone = taskCall({ model: 'tiny', endpoint: { baseUrl: 'http://main/v1', apiKey: '' } });
    expect(capabilitiesFor(alone.endpoint)).not.toBe(capabilitiesFor(main));
  });

  it("never sends the agent's key to another endpoint, and keeps a key the task has", () => {
    const main = { baseUrl: 'http://main/v1', apiKey: 'sk-main' };
    const elsewhere = taskCall({ model: 'tiny', endpoint }, {}, main);
    expect(elsewhere.endpoint).toEqual({ baseUrl: 'http://side/v1', apiKey: NO_KEY });
    const keyed = taskCall({ model: 'tiny', endpoint: { baseUrl: 'http://main/v1', apiKey: 'sk-own' } }, {}, main);
    expect(keyed.endpoint.apiKey).toBe('sk-own');
  });

  it("carries the endpoint's timeouts through", () => {
    const slow = { baseUrl: 'http://side/v1', apiKey: '', requestTimeoutSeconds: 90 };
    const call = taskCall({ model: 'tiny', endpoint: slow }, {}, { baseUrl: 'http://main/v1' });
    expect(call.endpoint).toEqual({ ...slow, apiKey: NO_KEY });
  });

  it("gives the agent's fetch to a task on the agent's endpoint, as it gives the key", () => {
    const fetch = async () => new Response('{}');
    const main = { baseUrl: 'http://main/v1', apiKey: 'sk-main', fetch };
    // A resolved task on the agent's own endpoint, which names no function.
    const { tasks } = agent({ title: { model: 'tiny' } });
    expect(taskCall(tasks.title, {}, main).endpoint).toEqual(main);
  });

  it("never gives the agent's fetch to another endpoint, and keeps a fetch the task has", () => {
    const agentFetch = async () => new Response('{}');
    const taskFetch = async () => new Response('{}');
    const main = { baseUrl: 'http://main/v1', apiKey: 'sk-main', fetch: agentFetch };
    expect(taskCall({ model: 'tiny', endpoint }, {}, main).endpoint).toEqual({ ...endpoint, apiKey: NO_KEY });
    const own = { ...endpoint, fetch: taskFetch };
    expect(taskCall({ model: 'tiny', endpoint: own }, {}, main).endpoint.fetch).toBe(taskFetch);
    const sameOwn = { baseUrl: 'http://main/v1', apiKey: '', fetch: taskFetch };
    expect(taskCall({ model: 'tiny', endpoint: sameOwn }, {}, main).endpoint.fetch).toBe(taskFetch);
  });
});
