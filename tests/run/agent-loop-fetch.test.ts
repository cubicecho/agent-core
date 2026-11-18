import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDiscovery } from '../../src/core/config.ts';
import { runAgentLoop } from '../../src/run/agent-loop.ts';
import { resetAll } from '../../src/runtime/reset.ts';
import { AGENT_SPEC, type AgentSpec, parseSpec, type ResolvedAgent, resolveAgentSpec } from '../../src/spec/spec.ts';
import { FinishReason, Role } from '../../src/wire/wire.ts';
import { answeredBy, respondInWords, streamed, tool, user } from '../helpers.ts';

/**
 * A router's forwarding function, answering a preselection with `s__read` and a streamed turn in
 * words, whatever host the request names.
 */
const router = () =>
  answeredBy(async (request) => {
    const body = (await request.json()) as { response_format?: unknown };
    // The preselection is the request that asks for a schema.
    if (body.response_format) {
      return respondInWords('["s__read"]');
    }
    return streamed(
      { choices: [{ index: 0, delta: { content: 'hel' } }] },
      { choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: FinishReason.Stop }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    );
  });

/** Who a function was asked by: the host each request named, and the model. */
const requestsTo = (fetch: ReturnType<typeof router>) =>
  fetch.mock.calls.map(([input, init]) => {
    const { model } = JSON.parse(String(init?.body)) as { model: string };
    return { host: new URL(String(input)).host, model };
  });

/**
 * An agent on an address only the router answers, resolved from a document as a host has one.
 *
 * @param tasks - The document's `tasks`.
 * @returns The resolved agent, which carries no `fetch`: the host adds it.
 */
const agent = (tasks: Record<string, unknown>): ResolvedAgent => {
  const { spec, errors } = parseSpec({
    spec: AGENT_SPEC,
    endpoint: { baseUrl: 'http://router.internal/v1' },
    model: { model: 'big' },
    tools: { discovery: ToolDiscovery.OnDemand },
    tasks,
  });
  expect(errors).toEqual([]);
  return resolveAgentSpec([spec as AgentSpec]);
};

const catalog = [{ id: 's', label: 'S', tools: [{ name: 's__read', description: 'reads' }] }];

/**
 * Runs one question with the loop's own preselection on.
 *
 * @param config - The agent, as the host hands it to the loop.
 * @returns The run's result.
 */
const run = (config: Parameters<typeof runAgentLoop>[0]['config']) =>
  runAgentLoop({
    config,
    messages: [user('read it')],
    tools: [tool('s__read')],
    catalog,
    preselect: true,
    dispatch: async () => 'done',
  });

/** The global `fetch`, replaced so a test can say what reached it. */
const global = vi.fn<typeof globalThis.fetch>(async () => {
  throw new Error('the global fetch was used');
});

beforeEach(() => {
  resetAll();
  global.mockClear();
  vi.stubGlobal('fetch', global);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a run on an endpoint answered by a function', () => {
  it('streams its turn through the function, with no server on a port', async () => {
    const fetch = router();
    const result = await runAgentLoop({
      config: {
        baseUrl: 'http://router.internal/v1',
        apiKey: '',
        model: 'big',
        maxTokens: 0,
        temperature: 0.2,
        maxToolIterations: 2,
        fetch,
      },
      messages: [user('hi')],
      dispatch: async () => 'done',
    });
    expect(result.turn.content).toBe('hello');
    expect(result.messages.at(-1)).toMatchObject({ role: Role.Assistant, content: 'hello' });
    expect(requestsTo(fetch)).toEqual([{ host: 'router.internal', model: 'big' }]);
    expect(global).not.toHaveBeenCalled();
  });

  it("sends a side task on the agent's endpoint through the agent's function", async () => {
    const fetch = router();
    await run({ ...agent({ toolSelect: { model: 'tiny' } }), fetch });
    expect(requestsTo(fetch)).toEqual([
      { host: 'router.internal', model: 'tiny' },
      { host: 'router.internal', model: 'big' },
    ]);
    expect(global).not.toHaveBeenCalled();
  });

  it('sends a side task on its own endpoint through the function the host gives that endpoint', async () => {
    const fetch = router();
    const resolved = agent({ toolSelect: { model: 'tiny', endpoint: { baseUrl: 'http://side.internal/v1' } } });
    // What a host that answers every endpoint itself does: its function on each task's endpoint too.
    const tasks = Object.fromEntries(
      Object.entries(resolved.tasks).map(([key, task]) => [key, { ...task, endpoint: { ...task.endpoint, fetch } }]),
    );
    await run({ ...resolved, tasks, fetch });
    expect(requestsTo(fetch)).toEqual([
      { host: 'side.internal', model: 'tiny' },
      { host: 'router.internal', model: 'big' },
    ]);
    expect(global).not.toHaveBeenCalled();
  });

  it("never sends a side task on another endpoint through the agent's function", async () => {
    const fetch = router();
    const resolved = agent({ toolSelect: { model: 'tiny', endpoint: { baseUrl: 'http://side.internal/v1' } } });
    await run({ ...resolved, fetch });
    // The task's endpoint names no function, so it goes out through the global one, which fails
    // here and costs the run its preselection and nothing else.
    expect(String(global.mock.calls[0]?.[0])).toBe('http://side.internal/v1/chat/completions');
    expect(requestsTo(fetch)).toEqual([{ host: 'router.internal', model: 'big' }]);
  });
});
