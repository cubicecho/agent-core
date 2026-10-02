import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDiscovery } from '../../src/core/config.ts';
import { RunEventKind } from '../../src/run/events.ts';
import { FinishReason, Role } from '../../src/wire/wire.ts';
import { answer, type Message, says, tool } from '../helpers.ts';

const create = vi.fn();
/** Every endpoint a client was asked for, in order, so a test can say where a request went. */
const reached: { baseUrl: string; apiKey: string }[] = [];
/** Only the SDK-touching half is replaced; the rest of the client module is pure. */
vi.mock('../../src/endpoint/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/endpoint/client.ts')>()),
  getClient: (config: { baseUrl: string; apiKey: string }) => {
    reached.push({ baseUrl: config.baseUrl, apiKey: config.apiKey });
    return { chat: { completions: { create } } };
  },
}));

const { runAgentLoop } = await import('../../src/run/agent-loop.ts');
const { preselect } = await import('../../src/tools/preselect.ts');
const { capabilitiesFor, resetCapabilities } = await import('../../src/endpoint/capabilities.ts');
const { NO_KEY } = await import('../../src/endpoint/client.ts');
const { SUMMARY_LEAD, summariser } = await import('../../src/context/compaction.ts');
const { ask, resetHints, taskCall } = await import('../../src/turn/side-task.ts');
const { AGENT_SPEC, parseSpec, resolveAgentSpec } = await import('../../src/spec/spec.ts');

type AgentSpec = import('../../src/spec/spec.ts').AgentSpec;
type SideTask = import('../../src/turn/side-task.ts').SideTask;
type RunEventInput = import('../../src/run/events.ts').RunEventInput;

/** A streamed turn that asks for one call. */
const calls = (name: string) => ({
  async *[Symbol.asyncIterator]() {
    yield {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: 'c0', function: { name, arguments: '{}' } }] },
          finish_reason: FinishReason.ToolCalls,
        },
      ],
    };
    yield { choices: [], usage: { prompt_tokens: 900, completion_tokens: 2, total_tokens: 902 } };
  },
});
/** What the nth request put in its body. */
const body = (nth: number) => create.mock.calls[nth][0] as Record<string, unknown>;

/** An agent whose own sampling is nothing a side task should pick up. */
const agent = (tasks: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const { spec, errors } = parseSpec({
    spec: AGENT_SPEC,
    endpoint: { baseUrl: 'http://main/v1' },
    model: { model: 'big', temperature: 1, maxTokens: 4096, reasoningEffort: 'high' },
    tasks,
    ...extra,
  });
  expect(errors).toEqual([]);
  return resolveAgentSpec([spec as AgentSpec]);
};

const catalog = [{ id: 's', label: 'S', tools: [{ name: 's__read', description: 'reads' }] }];

beforeEach(() => {
  create.mockReset();
  reached.length = 0;
});
afterEach(() => {
  resetCapabilities();
  resetHints();
});

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
    expect(capabilitiesFor(same.endpoint.baseUrl, same.endpoint.apiKey)).toBe(
      capabilitiesFor(main.baseUrl, main.apiKey),
    );
    // Without the agent the endpoint is sent as it stands, and that is a second entry.
    const alone = taskCall({ model: 'tiny', endpoint: { baseUrl: 'http://main/v1', apiKey: '' } });
    expect(capabilitiesFor(alone.endpoint.baseUrl, alone.endpoint.apiKey)).not.toBe(
      capabilitiesFor(main.baseUrl, main.apiKey),
    );
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
});

describe("a side task's own settings", () => {
  it("sends the side task's defaults, not the agent's, for what a task leaves out", async () => {
    // The agent runs at temperature 1, 4096 tokens and high effort. None of it is the titler's.
    const resolved = agent({
      title: { model: 'tiny' },
      compaction: { model: 'tiny' },
      toolSelect: { model: 'tiny' },
    });
    create.mockResolvedValue(answer('ok'));

    const title = taskCall(resolved.tasks.title, {}, resolved);
    await ask(title.endpoint, title.model, 'Name it.', 'a chat', title.options);
    expect(body(0)).toMatchObject({ model: 'tiny', temperature: 0.3, max_tokens: 512 });

    const compaction = taskCall(resolved.tasks.compaction, {}, resolved);
    await summariser(compaction.endpoint, compaction.model, compaction.options)('a transcript');
    expect(body(1)).toMatchObject({ model: 'tiny', temperature: 0.3, max_tokens: 1024 });

    const select = taskCall(resolved.tasks.toolSelect, {}, resolved);
    await preselect(select.endpoint, select.model, catalog, 'read it', select.options);
    expect(body(2)).toMatchObject({ model: 'tiny', temperature: 0.3, max_tokens: 256 });

    for (const nth of [0, 1, 2]) {
      // No effort was chosen for the task, so it is told not to think, whatever the agent does.
      expect(body(nth).reasoning_effort).toBe('none');
      expect(body(nth).chat_template_kwargs).toEqual({ enable_thinking: false });
    }
  });

  it('sends what a task states through every entry point', async () => {
    const stated = { model: 'tiny', temperature: 0, maxTokens: 64, reasoningEffort: 'low' };
    const resolved = agent({ title: stated, compaction: stated, toolSelect: stated });
    create.mockResolvedValue(answer('ok'));

    const title = taskCall(resolved.tasks.title, {}, resolved);
    await ask(title.endpoint, title.model, 'Name it.', 'a chat', title.options);
    const compaction = taskCall(resolved.tasks.compaction, {}, resolved);
    await summariser(compaction.endpoint, compaction.model, compaction.options)('a transcript');
    const select = taskCall(resolved.tasks.toolSelect, {}, resolved);
    await preselect(select.endpoint, select.model, catalog, 'read it', select.options);

    expect(create).toHaveBeenCalledTimes(3);
    for (const nth of [0, 1, 2]) {
      expect(body(nth)).toMatchObject({ temperature: 0, max_tokens: 64, reasoning_effort: 'low' });
      expect(body(nth)).not.toHaveProperty('chat_template_kwargs');
    }
  });

  it('lets preselect be given a temperature, and keeps 0.3 without one', async () => {
    create.mockResolvedValue(answer('["s__read"]'));
    const config = { baseUrl: 'http://local/v1', apiKey: '' };
    await preselect(config, 'small', catalog, 'read it', { temperature: 0 });
    await preselect(config, 'small', catalog, 'read it');
    expect(body(0).temperature).toBe(0);
    expect(body(1).temperature).toBe(0.3);
  });
});

describe("runAgentLoop with a resolved agent's tasks", () => {
  const question: Message[] = [{ role: Role.User, content: 'read it' }];
  const run = (config: Parameters<typeof runAgentLoop>[0]['config'], extra = {}) =>
    runAgentLoop({
      config,
      messages: question,
      tools: [tool('s__read')],
      catalog,
      dispatch: async () => 'done',
      ...extra,
    });
  const onDemand = (tasks: Record<string, unknown>) => ({
    ...agent(tasks, { tools: { discovery: ToolDiscovery.OnDemand } }),
    apiKey: 'sk-main',
  });
  /** The names of the tools the nth request declared. */
  const declared = (nth: number) =>
    ((body(nth).tools ?? []) as OpenAI.ChatCompletionFunctionTool[]).map((t) => t.function.name);

  it('runs neither side task unless asked to', async () => {
    create.mockResolvedValueOnce(says('hello'));
    await run({
      ...onDemand({ toolSelect: { model: 'tiny' }, compaction: { model: 'tiny' } }),
      contextLength: 100,
    });
    // One request, and it is the main turn's.
    expect(create).toHaveBeenCalledTimes(1);
    expect(body(0)).toMatchObject({ model: 'big', stream: true });
  });

  it("preselects by tasks.toolSelect on the task's own settings", async () => {
    const config = onDemand({
      toolSelect: {
        model: 'tiny',
        temperature: 0,
        maxTokens: 64,
        endpoint: { baseUrl: 'http://side/v1' },
      },
    });
    create.mockResolvedValueOnce(answer('["s__read"]')).mockResolvedValueOnce(says('hello'));
    await run(config, { preselect: true });
    expect(body(0)).toMatchObject({ model: 'tiny', temperature: 0, max_tokens: 64 });
    // On its own endpoint, and without the agent's key: that key was issued for another server.
    expect(reached).toContainEqual({ baseUrl: 'http://side/v1', apiKey: NO_KEY });
    // And the first step opens with what it picked.
    expect(body(1)).toMatchObject({ model: 'big', temperature: 1 });
    expect(declared(1)).toEqual(['s__read']);
  });

  it("gives a preselector on the agent's endpoint the agent's key and its own defaults", async () => {
    create.mockResolvedValueOnce(answer('["s__read"]')).mockResolvedValueOnce(says('hello'));
    await run(onDemand({ toolSelect: { model: 'tiny' } }), { preselect: true });
    expect(body(0)).toMatchObject({ model: 'tiny', temperature: 0.3, max_tokens: 256 });
    expect(new Set(reached.map((endpoint) => JSON.stringify(endpoint)))).toEqual(
      new Set([JSON.stringify({ baseUrl: 'http://main/v1', apiKey: 'sk-main' })]),
    );
  });

  it('falls back to toolSelectModel for a host that is not on the spec', async () => {
    const config = {
      baseUrl: 'http://local/v1',
      apiKey: '',
      model: 'm',
      maxTokens: 100,
      temperature: 0.9,
      maxToolIterations: 4,
      toolDiscovery: ToolDiscovery.OnDemand,
      toolSelectModel: 'small',
    };
    create.mockResolvedValueOnce(answer('["s__read"]')).mockResolvedValueOnce(says('hello'));
    await run(config, { preselect: true });
    expect(body(0)).toMatchObject({ model: 'small', temperature: 0.3, max_tokens: 256 });
    expect(declared(1)).toEqual(['s__read']);
  });

  it('asks nothing when the host has already decided, or no preselector is named', async () => {
    const config = onDemand({ toolSelect: { model: 'tiny' } });
    create.mockResolvedValue(says('hello'));
    // An empty list is a decision too.
    await run(config, { preselect: true, preselected: [] });
    await run(onDemand({}), { preselect: true });
    await run({ ...config, toolDiscovery: ToolDiscovery.Eager }, { preselect: true });
    expect(create).toHaveBeenCalledTimes(3);
    for (const nth of [0, 1, 2]) {
      expect(body(nth)).toMatchObject({ model: 'big', stream: true });
    }
  });

  it('reports a failed preselection as a notice and runs without one', async () => {
    const events: RunEventInput[] = [];
    create.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(says('hello'));
    const result = await run(onDemand({ toolSelect: { model: 'tiny' } }), {
      preselect: true,
      onEvent: (event: RunEventInput) => events.push(event),
    });
    expect(result.turn.content).toBe('hello');
    expect(events.filter((event) => event.kind === RunEventKind.Notice).map((event) => event.text)).toEqual([
      expect.stringContaining('boom'),
    ]);
  });

  /** A transcript long enough to fill a 1000-token window, with a second question to cut at. */
  const long: Message[] = [
    { role: Role.User, content: 'first '.repeat(300) },
    { role: Role.Assistant, content: 'answer '.repeat(300) },
    { role: Role.User, content: 'second '.repeat(40) },
  ];

  it("folds by tasks.compaction on the task's own settings", async () => {
    const config = {
      ...agent({
        compaction: { model: 'tiny', temperature: 0, endpoint: { baseUrl: 'http://side/v1' } },
      }),
      contextLength: 1000,
    };
    const events: RunEventInput[] = [];
    create.mockResolvedValueOnce(answer('what was said')).mockResolvedValueOnce(says('hello'));
    const result = await runAgentLoop({
      config,
      messages: long,
      dispatch: async () => 'done',
      compact: true,
      onEvent: (event) => events.push(event),
    });
    // The summary first: the task's model and temperature, and the summariser's own ceiling.
    expect(body(0)).toMatchObject({ model: 'tiny', temperature: 0, max_tokens: 1024 });
    expect(reached).toContainEqual({ baseUrl: 'http://side/v1', apiKey: NO_KEY });
    // Then the turn, on the folded transcript.
    expect(body(1)).toMatchObject({ model: 'big', temperature: 1 });
    expect(body(1).messages).toEqual([{ role: Role.System, content: `${SUMMARY_LEAD}what was said` }, long[2]]);
    expect(result.messages.slice(0, 2)).toEqual(body(1).messages);
    expect(events).toContainEqual({ kind: RunEventKind.Notice, text: 'compacted 2 messages into a summary' });
  });

  it('does not fold without the task, however full the window', async () => {
    create.mockResolvedValue(says('hello'));
    await runAgentLoop({
      config: { ...agent({ title: { model: 'tiny' } }), contextLength: 1000 },
      messages: long,
      dispatch: async () => 'done',
      compact: true,
    });
    // No falling back to the main model for the summary.
    expect(create).toHaveBeenCalledTimes(1);
    expect((body(0).messages as Message[]).length).toBe(3);
  });

  it('plans a later step from the prompt the last one reported', async () => {
    // Short by any estimate, but the server said 900 of 1000: tool schemas and a system prompt
    // are in the window too, and only the report counts them.
    const short: Message[] = [
      { role: Role.User, content: 'first' },
      { role: Role.Assistant, content: 'answer' },
      { role: Role.User, content: 'second' },
    ];
    create
      .mockResolvedValueOnce(calls('s__read'))
      .mockResolvedValueOnce(answer('what was said'))
      .mockResolvedValueOnce(says('hello'));
    await runAgentLoop({
      config: { ...agent({ compaction: { model: 'tiny' } }), contextLength: 1000 },
      messages: short,
      tools: [tool('s__read')],
      dispatch: async () => 'done',
      compact: { target: 0.5 },
    });
    expect(create).toHaveBeenCalledTimes(3);
    expect(body(1)).toMatchObject({ model: 'tiny', temperature: 0.3 });
    expect((body(2).messages as Message[])[0]).toEqual({
      role: Role.System,
      content: `${SUMMARY_LEAD}what was said`,
    });
  });

  it('leaves the transcript whole when the summary fails, and says so', async () => {
    const events: RunEventInput[] = [];
    create.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(says('hello'));
    const result = await runAgentLoop({
      config: { ...agent({ compaction: { model: 'tiny' } }), contextLength: 1000 },
      messages: long,
      dispatch: async () => 'done',
      compact: true,
      onEvent: (event) => events.push(event),
    });
    expect(result.turn.content).toBe('hello');
    expect((body(1).messages as Message[]).length).toBe(3);
    expect(events.filter((event) => event.kind === RunEventKind.Notice).map((event) => event.text)).toEqual([
      expect.stringContaining('boom'),
    ]);
  });
});
