import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESELECT_APPEND } from '../src/agent-loop.ts';
import { ToolDiscovery } from '../src/config.ts';
import { RunEventKind, RunOutcome } from '../src/events.ts';
import { HookEvent } from '../src/hook-events.ts';
import {
  FinishReason,
  FUNCTION_TOOL,
  HttpStatus,
  JSON_SCHEMA_FORMAT,
  PartType,
  Role,
  SchemaType,
} from '../src/wire.ts';

const create = vi.fn();
/** Only the SDK-touching half is replaced; the rest of the client module is pure. */
vi.mock('../src/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client.ts')>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { runAgentLoop } = await import('../src/agent-loop.ts');
const { buildBody } = await import('../src/request-body.ts');
const { preselect } = await import('../src/preselect.ts');
const { preview } = await import('../src/run-calls.ts');
const { resolveApiKey } = await import('../src/client.ts');
const { capabilitiesFor, modelCapabilitiesFor, resetCapabilities } = await import('../src/capabilities.ts');
const { CALL_TOOL, LOAD_TOOLS } = await import('../src/tool-loading.ts');
const { configureHooks, resetHooks, withContext } = await import('../src/hooks.ts');
const { tokensBetween } = await import('../src/ledger.ts');

type Message = OpenAI.ChatCompletionMessageParam;
type Turn = import('../src/stream.ts').Turn;
type ToolCall = import('../src/tool-calls.ts').ToolCall;
type ToolCallRequest = import('../src/tool-calls.ts').ToolCallRequest;
type AgentLoopRequest = import('../src/agent-loop.ts').AgentLoopRequest;
type ToolCallResult = import('../src/tool-calls.ts').ToolCallResult;
type RunEventInput = import('../src/events.ts').RunEventInput;
type RunUsage = import('../src/events.ts').RunUsage;
type Body = OpenAI.ChatCompletionCreateParamsStreaming;

const stream = (...list: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* list as OpenAI.ChatCompletionChunk[];
  },
});
/** A turn that answers in words. */
const says = (content: string, finish: FinishReason = FinishReason.Stop) =>
  stream(
    { choices: [{ delta: { content } }] },
    { choices: [{ delta: {}, finish_reason: finish }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  );
/** A turn that asks for these calls. */
const calls = (...list: [name: string, args: string][]) =>
  stream({
    choices: [
      {
        delta: {
          tool_calls: list.map(([name, args], index) => ({
            index,
            id: `c${index}`,
            function: { name, arguments: args },
          })),
        },
        finish_reason: FinishReason.ToolCalls,
      },
    ],
  });

/** A turn that makes these deltas and reports this prompt, with a cache count, and ten tokens out. */
const reported = (
  prompt: number,
  cached: number,
  delta: Record<string, unknown>,
  finish: FinishReason = FinishReason.Stop,
) =>
  stream(
    { choices: [{ delta, finish_reason: finish }] },
    {
      choices: [],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: 10,
        total_tokens: prompt + 10,
        prompt_tokens_details: { cached_tokens: cached },
      },
    },
  );
/** The same, asking for one call. */
const reportedCall = (prompt: number, cached: number, name: string, args = '{}') =>
  reported(
    prompt,
    cached,
    { tool_calls: [{ index: 0, id: 'c0', function: { name, arguments: args } }] },
    FinishReason.ToolCalls,
  );

const tool = (name: string): OpenAI.ChatCompletionTool => ({
  type: FUNCTION_TOOL,
  function: { name, description: name, parameters: { type: SchemaType.Object, properties: {} } },
});

const config = {
  baseUrl: 'http://local/v1',
  apiKey: '',
  model: 'm',
  maxTokens: 100,
  temperature: 0.2,
  maxToolIterations: 4,
};
const question: Message[] = [{ role: Role.User, content: 'hi' }];
/** What each request was sent, by the name of every tool it declared. */
const declared = () =>
  create.mock.calls.map(([body]) =>
    ((body as Body).tools ?? []).map((t) => (t as OpenAI.ChatCompletionFunctionTool).function.name),
  );

beforeEach(() => create.mockReset());
afterEach(() => resetCapabilities());

describe('buildBody', () => {
  const messages: Message[] = [{ role: Role.User, content: 'hi' }];

  it('sends what a fresh endpoint and model have not refused', () => {
    const supports = capabilitiesFor('https://api.openai.com/v1');
    const body = buildBody({ ...config, reasoningEffort: 'low' }, supports, undefined, messages, [tool('a')]);
    expect(body).toMatchObject({
      model: 'm',
      max_tokens: 100,
      temperature: 0.2,
      reasoning_effort: 'low',
      stream: true,
      stream_options: { include_usage: true },
      messages,
    });
    expect(body.tools).toHaveLength(1);
  });

  it('spells the ceiling, drops the temperature and effort the model refused', () => {
    const supports = capabilitiesFor('https://api.openai.com/v1');
    const refused = modelCapabilitiesFor(supports, 'm');
    Object.assign(refused, {
      legacyTokenLimit: false,
      chosenTemperature: false,
      reasoningEffort: false,
    });
    const body = buildBody({ ...config, reasoningEffort: 'high' }, supports, refused, messages);
    expect(body).toMatchObject({ max_completion_tokens: 100 });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('tools');
  });

  it('steps an effort the model refused by value up to one it takes', () => {
    // The refusal that means the opposite of the one above: the model reasons, it just does not
    // reason at `none`. Sending nothing would run at its own default, which is neither what the
    // config asks for nor anything an operator reading the settings row can see.
    const supports = capabilitiesFor('https://api.openai.com/v1');
    const refused = modelCapabilitiesFor(supports, 'm');
    refused.refusedEfforts.add('none');
    refused.supportedEfforts = ['minimal', 'low', 'medium', 'high'];
    const body = buildBody({ ...config, reasoningEffort: 'none' }, supports, refused, messages);
    expect(body).toMatchObject({ reasoning_effort: 'minimal' });
    // Anything the model does list goes out as asked.
    expect(buildBody({ ...config, reasoningEffort: 'high' }, supports, refused, messages)).toMatchObject({
      reasoning_effort: 'high',
    });
  });

  it('sends no ceiling at zero and no effort at off', () => {
    const body = buildBody(
      { ...config, maxTokens: 0, reasoningEffort: 'off' },
      capabilitiesFor('http://local/v1'),
      undefined,
      messages,
    );
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it("merges extraBody last, less the refused fields and the loop's own", () => {
    const supports = capabilitiesFor('http://local/v1');
    const refused = modelCapabilitiesFor(supports, 'm');
    refused.refusedFields.add('min_p');
    const body = buildBody(
      {
        ...config,
        extraBody: { id_slot: 2, min_p: 0.1, temperature: 0.9, model: 'x', stream: false },
      },
      supports,
      refused,
      messages,
    );
    expect(body).toMatchObject({ id_slot: 2, temperature: 0.9, model: 'm', stream: true });
    expect(body).not.toHaveProperty('min_p');
  });

  it('relaxes schemas where the endpoint could not build a grammar', () => {
    const supports = capabilitiesFor('http://local/v1');
    supports.strictSchemas = false;
    const pattern: OpenAI.ChatCompletionTool = {
      type: FUNCTION_TOOL,
      function: {
        name: 'p',
        parameters: { type: SchemaType.Object, properties: { s: { type: SchemaType.String, pattern: '^a$' } } },
      },
    };
    const body = buildBody(config, supports, undefined, messages, [pattern]);
    expect(JSON.stringify(body.tools)).not.toContain('pattern');
  });

  /** The names a built body declares, in the order it declares them. */
  const names = (body: Body) => (body.tools ?? []).map((t) => (t as OpenAI.ChatCompletionFunctionTool).function.name);

  it('declares the same set in the same order however the caller built the array', () => {
    const supports = capabilitiesFor('http://local/v1');
    const one = buildBody(config, supports, undefined, messages, [tool('b__x'), tool('a__y'), tool('a__x')]);
    const other = buildBody(config, supports, undefined, messages, [tool('a__x'), tool('b__x'), tool('a__y')]);
    expect(names(one)).toEqual(['a__x', 'a__y', 'b__x']);
    expect(names(other)).toEqual(names(one));
  });

  it("sends the caller's own order when told to", () => {
    const supports = capabilitiesFor('http://local/v1');
    const body = buildBody(config, supports, undefined, messages, [tool('b'), tool('a')], false);
    expect(names(body)).toEqual(['b', 'a']);
  });

  it("orders by a comparator of the caller's", () => {
    const supports = capabilitiesFor('http://local/v1');
    const body = buildBody(config, supports, undefined, messages, [tool('a'), tool('b'), tool('c')], (a, b) =>
      b.localeCompare(a),
    );
    expect(names(body)).toEqual(['c', 'b', 'a']);
  });
});

describe('resolveApiKey', () => {
  const env = { OPENAI_API_KEY: 'env-key' };

  it("prefers the endpoint's own key", () => {
    expect(resolveApiKey({ apiKey: 'own', baseUrl: 'http://x' }, { baseUrl: 'http://y' }, env)).toBe('own');
  });

  it('sends no inherited key to an endpoint the settings did not name', () => {
    expect(
      resolveApiKey({ baseUrl: 'http://friend/v1' }, { baseUrl: 'https://api.openai.com/v1', apiKey: 'k' }, env),
    ).toBe('agent-core');
  });

  it('inherits on the same endpoint, however the URL is written', () => {
    expect(resolveApiKey({ baseUrl: ' http://x/v1/ ' }, { baseUrl: 'http://x/v1', apiKey: 'k' }, env)).toBe('k');
    expect(resolveApiKey({}, { baseUrl: 'http://x/v1' }, env)).toBe('env-key');
    expect(resolveApiKey({}, undefined, {})).toBe('agent-core');
  });
});

describe('preview', () => {
  it('cuts long text and says how long it was', () => {
    expect(preview('abc', 5)).toBe('abc');
    expect(preview('abcdefgh', 5)).toBe('abcde… (8 chars)');
  });
});

describe('preselect', () => {
  const catalog = [{ id: 's', label: 'S', tools: [{ name: 's__read', description: 'reads' }] }];

  it('hands back the catalogued names the small model picked', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: '["s__read", "nope"]' } }] });
    expect(await preselect(config, 'small', catalog, 'read it')).toEqual(['s__read']);
    expect(create.mock.calls[0][0]).toMatchObject({
      response_format: { type: JSON_SCHEMA_FORMAT, json_schema: { name: 'preselection' } },
    });
    create.mockResolvedValue({ choices: [{ message: { content: '{"tools": ["s__read"]}' } }] });
    expect(await preselect(config, 'small', catalog, 'read it')).toEqual(['s__read']);
  });

  it('picks nothing without a model, and nothing when the call fails', async () => {
    expect(await preselect(config, '', catalog, 'read it')).toEqual([]);
    const notices: string[] = [];
    create.mockRejectedValueOnce(new Error('boom'));
    const got = await preselect(config, 'small', catalog, 'x', {
      onNotice: (n) => notices.push(n),
    });
    expect(got).toEqual([]);
    expect(notices).toEqual([expect.stringContaining('boom')]);
  });

  it("spends no round trip when the request's own words name the tool", async () => {
    // A catalogue with something to discriminate between: a term is only distinctive against
    // other terms, so one tool alone can never be a confident match, and does not need to be.
    const desks = [
      { id: 's', label: 'S', tools: [{ name: 's__read', description: 'Read a file' }] },
      { id: 'd', label: 'D', tools: [{ name: 'd__query', description: 'Query the database' }] },
      { id: 'c', label: 'C', tools: [{ name: 'c__event', description: 'Add a calendar event' }] },
      { id: 'w', label: 'W', tools: [{ name: 'w__fetch', description: 'Fetch a URL' }] },
    ];
    const notices: string[] = [];
    const got = await preselect(config, 'small', desks, 'read the file', {
      keywords: true,
      onNotice: (n) => notices.push(n),
    });
    expect(got).toEqual(['s__read']);
    // The whole point: the model was never asked.
    expect(create).not.toHaveBeenCalled();
    expect(notices).toEqual([expect.stringContaining('by name')]);
  });

  it('falls through to the model when the words settle nothing', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: '{"tools": ["s__read"]}' } }] });
    expect(await preselect(config, 'small', catalog, 'sing me a song', { keywords: true })).toEqual(['s__read']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('asks for no preselection at all without a model, words or not', async () => {
    // `toolSelectModel: ""` means don't preselect, and the cheap path does not reinterpret it.
    expect(await preselect(config, '', catalog, 'read the file', { keywords: true })).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('runAgentLoop', () => {
  it('runs the tools between turns and hands back the transcript', async () => {
    create.mockReturnValueOnce(calls(['a', '{"x":1}'], ['b', ''])).mockReturnValueOnce(says('done'));
    const dispatch = vi.fn(async ({ name, args }: { name: string; args: unknown }) => {
      if (name === 'b') {
        throw new Error('b broke');
      }
      return JSON.stringify(args);
    });
    const events: { kind: string }[] = [];
    const result = await runAgentLoop({
      config,
      system: 'be brief',
      messages: question,
      tools: [tool('a'), tool('b')],
      dispatch,
      onEvent: (event) => events.push(event),
    });
    expect(result.turn.content).toBe('done');
    expect(result.toolCalls).toEqual([
      { id: 'c0', name: 'a', ok: true },
      { id: 'c1', name: 'b', ok: false },
    ]);
    expect(result.messages.map((m) => m.role)).toEqual([
      Role.User,
      Role.Assistant,
      Role.Tool,
      Role.Tool,
      Role.Assistant,
    ]);
    expect(result.messages[3]).toMatchObject({ content: 'b broke' });
    // Stored as `{}` so a server that parses the replayed call does not refuse an empty one.
    expect(JSON.stringify(result.messages[1])).toContain('"arguments":"{}"');
    expect(question).toHaveLength(1);
    expect((create.mock.calls[0][0] as Body).messages[0]).toEqual({
      role: Role.System,
      content: 'be brief',
    });
    expect(result.usage).toEqual({ prompt: 10, completion: 2, total: 12, cached: 0 });
    expect(events.map((e) => e.kind)).toEqual([
      RunEventKind.Turn,
      RunEventKind.Usage,
      RunEventKind.ToolCall,
      RunEventKind.ToolResult,
      RunEventKind.ToolCall,
      RunEventKind.ToolResult,
      RunEventKind.Turn,
      RunEventKind.Output,
      RunEventKind.Usage,
    ]);
  });

  it('stops when the tool budget is spent', async () => {
    create.mockImplementation(() => calls(['a', '{}']));
    await expect(
      runAgentLoop({
        config: { ...config, maxToolIterations: 2 },
        messages: question,
        tools: [tool('a')],
        dispatch: async () => 'ok',
      }),
    ).rejects.toThrow('Stopped after 2 tool iterations.');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('reports every turn on its own usage event, with the cache weighed against the last request', async () => {
    create.mockReturnValueOnce(reportedCall(100, 0, 'a')).mockReturnValueOnce(reported(130, 108, { content: 'done' }));
    const reports: RunUsage[] = [];
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      dispatch: async () => 'ok',
      onEvent: (event) => event.kind === RunEventKind.Usage && event.usage && reports.push(event.usage),
    });
    expect(reports).toHaveLength(2);
    expect(reports[0].turn).toMatchObject({
      prompt: 100,
      cached: 0,
      uncached: 100,
      finishReason: FinishReason.ToolCalls,
      toolsDeclared: 1,
      retries: 0,
    });
    expect(reports[0].turn?.toolSchemaTokens).toBeGreaterThan(0);
    // Nothing before the first request to weigh it against.
    expect(reports[0].turn).not.toHaveProperty('cacheExpected');
    expect(reports[1]).toMatchObject({ promptTokens: 230, cachedTokens: 108 });
    expect(reports[1].turn).toMatchObject({
      cacheExpected: 110,
      cacheBroken: false,
      finishReason: FinishReason.Stop,
    });
    expect(reports[1].turn).not.toHaveProperty('cacheBreakReason');
    expect(result.metrics).toMatchObject({
      turns: 2,
      requests: 2,
      toolCalls: 1,
      promptTokens: 230,
      cachedTokens: 108,
      cacheBreaks: 0,
      outcome: RunOutcome.Answered,
    });
    expect(result.metrics.wallMs).toBeGreaterThanOrEqual(0);
    // Loads are only counted where tools load on demand.
    expect(result.metrics).not.toHaveProperty('toolsLoaded');
  });

  it('names what broke the cache: a rewritten history, or nothing it knows of', async () => {
    const reasons = async (beforeStep?: (m: readonly Message[], step: number) => Message[] | undefined) => {
      create
        .mockReset()
        .mockReturnValueOnce(reportedCall(100, 0, 'a'))
        .mockReturnValueOnce(reported(130, 4, { content: 'done' }));
      const turns: RunUsage['turn'][] = [];
      const result = await runAgentLoop({
        config,
        messages: question,
        tools: [tool('a')],
        dispatch: async () => 'ok',
        beforeStep,
        onEvent: (event) => event.kind === RunEventKind.Usage && turns.push(event.usage?.turn),
      });
      expect(result.metrics.cacheBreaks).toBe(1);
      expect(turns[1]?.cacheBroken).toBe(true);
      return turns[1]?.cacheBreakReason;
    };
    expect(await reasons()).toBe('none-known');
    expect(
      await reasons((messages, step) =>
        step === 1 ? [{ role: Role.User, content: 'shorter' }, ...messages.slice(1)] : undefined,
      ),
    ).toBe('history-rewritten');
  });

  it('says nothing of a break where the endpoint reported no cache count', async () => {
    create.mockReturnValueOnce(calls(['a', '{}'])).mockReturnValueOnce(says('done'));
    const turns: RunUsage['turn'][] = [];
    await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      dispatch: async () => 'ok',
      onEvent: (event) => event.kind === RunEventKind.Usage && turns.push(event.usage?.turn),
    });
    // The first turn reported no prompt, so there is nothing for the second to be weighed against.
    expect(turns[1]).not.toHaveProperty('cacheExpected');
    expect(turns[1]).not.toHaveProperty('cacheBroken');
  });

  it('continues an answer cut off at the ceiling when asked to, as one turn', async () => {
    create.mockReturnValueOnce(says('half', FinishReason.Length)).mockReturnValueOnce(says(' and the rest'));
    const notices: string[] = [];
    const result = await runAgentLoop({
      config,
      messages: question,
      dispatch: async () => '',
      maxContinuations: 2,
      onEvent: (event) => event.kind === RunEventKind.Notice && notices.push(event.text ?? ''),
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[1][0] as Body).messages.at(-1)).toEqual({
      role: Role.Assistant,
      content: 'half',
    });
    expect(result.messages.at(-1)).toMatchObject({
      role: Role.Assistant,
      content: 'half and the rest',
    });
    expect(notices).toEqual([]);
    expect(result.usage).toMatchObject({ prompt: 20, completion: 4 });
    expect(result.metrics).toMatchObject({
      turns: 1,
      requests: 2,
      truncatedTurns: 0,
      outcome: RunOutcome.Answered,
    });
  });

  it('does not continue a cut-off answer unless asked to', async () => {
    create.mockReturnValueOnce(says('half', FinishReason.Length));
    const result = await runAgentLoop({ config, messages: question, dispatch: async () => '' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.metrics).toMatchObject({ truncatedTurns: 1, outcome: RunOutcome.Truncated });
  });

  it('says when a turn was cut off at the ceiling', async () => {
    create.mockReturnValueOnce(says('half', FinishReason.Length));
    const notices: string[] = [];
    await runAgentLoop({
      config,
      messages: question,
      dispatch: async () => '',
      onEvent: (event) => event.kind === RunEventKind.Notice && notices.push(event.text ?? ''),
    });
    expect(notices).toEqual(['the model stopped at maxTokens (100); this turn is cut short']);
  });

  it('drops a call that never got a name', async () => {
    create.mockReturnValueOnce(calls(['', '{}']));
    const dispatch = vi.fn();
    const result = await runAgentLoop({ config, messages: question, dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.messages.at(-1)).not.toHaveProperty('tool_calls');
  });

  it('hands the tool repaired arguments and replays them as JSON', async () => {
    create.mockReturnValueOnce(calls(['a', "{'x': True,}"], ['a', '{nope'])).mockReturnValueOnce(says('done'));
    const dispatch = vi.fn(async (_call: ToolCallRequest) => 'ok');
    const result = await runAgentLoop({ config, messages: question, tools: [tool('a')], dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ args: { x: true }, raw: "{'x': True,}" });
    const replayed = (result.messages[1] as OpenAI.ChatCompletionAssistantMessageParam).tool_calls;
    expect(replayed?.map((c) => (c as ToolCall).function.arguments)).toEqual(['{"x":true}', '{}']);
    expect(result.messages[3]).toMatchObject({ content: expect.stringContaining('invalid tool') });
    expect(result.toolCalls).toEqual([
      { id: 'c0', name: 'a', ok: true },
      { id: 'c1', name: 'a', ok: false },
    ]);
  });

  it('names each call by id on its events, so two calls to one tool can be told apart', async () => {
    create.mockReturnValueOnce(calls(['a', '{"n":1}'], ['a', '{"n":2}'])).mockReturnValueOnce(says('done'));
    // The first call is held until the second has answered, so the results land out of order.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: RunEventInput[] = [];
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      parallel: true,
      dispatch: async ({ args }) => {
        if (args.n === 1) {
          await held;
        } else {
          release();
        }
        return `answer ${args.n}`;
      },
      onEvent: (event) => events.push(event),
    });
    const tools = events.filter((e) => e.kind === RunEventKind.ToolCall || e.kind === RunEventKind.ToolResult);
    expect(tools.map((e) => [e.kind, e.id, e.text])).toEqual([
      [RunEventKind.ToolCall, 'c0', '{"n":1}'],
      [RunEventKind.ToolCall, 'c1', '{"n":2}'],
      [RunEventKind.ToolResult, 'c1', 'answer 2'],
      [RunEventKind.ToolResult, 'c0', 'answer 1'],
    ]);
    // Only the tool kinds carry one.
    expect(events.filter((e) => 'id' in e)).toHaveLength(4);
    expect(result.toolCalls).toEqual([
      { id: 'c0', name: 'a', ok: true },
      { id: 'c1', name: 'a', ok: true },
    ]);
  });

  it('hands a host every call and its whole result, dispatched or not', async () => {
    const long = 'x'.repeat(5000);
    create
      .mockReturnValueOnce(calls(['a', "{'x': True,}"], ['a', '{"x":true}'], ['a', '{nope']))
      .mockReturnValueOnce(says('done'));
    const dispatch = vi.fn(async (_call: ToolCallRequest) => long);
    const asked: ToolCallRequest[] = [];
    const answered: ToolCallResult[] = [];
    const events: RunEventInput[] = [];
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      dispatch,
      onToolCall: (call) => asked.push(call),
      onToolResult: (answer) => answered.push(answer),
      onEvent: (event) => events.push(event),
    });
    // One dispatch: the second call repeats the first, and the third could not be read.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([
      { id: 'c0', name: 'a', args: { x: true }, raw: "{'x': True,}" },
      { id: 'c1', name: 'a', args: { x: true }, raw: '{"x":true}' },
      { id: 'c2', name: 'a', args: {}, raw: '{nope' },
    ]);
    // The repeat gets a result of its own, carrying the answer it shares with the first.
    expect(answered).toEqual([
      { id: 'c0', name: 'a', ok: true, content: long },
      { id: 'c1', name: 'a', ok: true, content: long },
      { id: 'c2', name: 'a', ok: false, content: expect.stringContaining('invalid tool') },
    ]);
    // What the callback was handed is what the model reads; the event is still the preview.
    expect(answered.map((a) => a.content)).toEqual(
      result.messages.flatMap((m) => (m.role === Role.Tool ? [m.content] : [])),
    );
    const shown = events.filter((e) => e.kind === RunEventKind.ToolResult);
    expect(shown.map((e) => e.id)).toEqual(['c0', 'c1', 'c2']);
    expect(shown[0].text).toBe(preview(long));
    expect(shown[0].text).not.toBe(long);
  });

  it('tells a call cut off at the ceiling to raise maxTokens', async () => {
    create
      .mockReturnValueOnce(
        stream({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'c0', function: { name: 'a', arguments: '{"x": "lo' } }],
              },
              finish_reason: FinishReason.Length,
            },
          ],
        }),
      )
      .mockReturnValueOnce(says('done'));
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      dispatch: async () => 'ok',
    });
    expect(result.messages[2]).toMatchObject({
      content: expect.stringContaining('raise maxTokens'),
    });
  });

  it('runs tool calls written as text, and says the parser does not match', async () => {
    create
      .mockReturnValueOnce(says('Checking.\n<tool_call>\n{"name": "a", "arguments": {"x": 1}}\n</tool_call>'))
      .mockReturnValueOnce(says('done'));
    const dispatch = vi.fn(async (_call: ToolCallRequest) => 'ok');
    const notices: string[] = [];
    const turns: Turn[] = [];
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      dispatch,
      onTurn: (turn) => turns.push(turn),
      onEvent: (event) => event.kind === RunEventKind.Notice && notices.push(event.text ?? ''),
    });
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      id: 'call_recovered_0',
      name: 'a',
      args: { x: 1 },
    });
    expect(result.messages[1]).toMatchObject({ role: Role.Assistant, content: 'Checking.' });
    expect(result.messages[2]).toMatchObject({ role: Role.Tool, tool_call_id: 'call_recovered_0' });
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(notices[0]).toContain('recovered 1 tool call the model wrote as text');
  });

  it('leaves a call written as text alone when recovery is off, or no tools exist', async () => {
    const text = '{"name": "a", "arguments": {}}';
    create.mockReturnValueOnce(says(text)).mockReturnValueOnce(says(`<tool_call>${text}</tool_call>`));
    const dispatch = vi.fn();
    const off = await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      dispatch,
      recoverToolCalls: false,
    });
    expect(off.turn.content).toBe(text);
    const bare = await runAgentLoop({ config, messages: question, dispatch });
    expect(bare.turn.toolCalls).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('stops between calls once aborted', async () => {
    const controller = new AbortController();
    create.mockReturnValueOnce(calls(['a', '{}'], ['a', '{"n":2}']));
    const dispatch = vi.fn(async () => {
      controller.abort();
      return 'ok';
    });
    await expect(
      runAgentLoop({
        config,
        messages: question,
        tools: [tool('a')],
        dispatch,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("runs a step's calls together, and an identical call once", async () => {
    create.mockReturnValueOnce(calls(['a', '{}'], ['a', '{}'], ['a', '{"n":1}'])).mockReturnValueOnce(says('done'));
    let running = 0;
    let most = 0;
    const dispatch = vi.fn(async () => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return 'ok';
    });
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      dispatch,
      parallel: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(most).toBe(2);
    expect(result.messages.filter((m) => m.role === Role.Tool)).toHaveLength(3);
  });

  it('makes a failed identical call again rather than replaying the failure', async () => {
    create
      .mockReturnValueOnce(calls(['a', '{}']))
      .mockReturnValueOnce(calls(['a', '{}']))
      .mockReturnValueOnce(says('done'));
    const dispatch = vi.fn().mockRejectedValueOnce(new Error('flaky')).mockResolvedValue('ok');
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      dispatch,
      parallel: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toEqual([
      { id: 'c0', name: 'a', ok: false },
      { id: 'c0', name: 'a', ok: true },
    ]);
  });

  it('declares the tools in name order, and as the host built them when told to', async () => {
    const tools = [tool('z'), tool('a')];
    create.mockReturnValueOnce(says('done'));
    await runAgentLoop({ config, messages: question, tools, dispatch: async () => 'ok' });
    create.mockReturnValueOnce(says('done'));
    await runAgentLoop({
      config,
      messages: question,
      tools,
      toolOrder: false,
      dispatch: async () => 'ok',
    });
    expect(declared()).toEqual([
      ['a', 'z'],
      ['z', 'a'],
    ]);
    // The host's array is read, never rearranged in place.
    expect(tools.map((t) => (t as OpenAI.ChatCompletionFunctionTool).function.name)).toEqual(['z', 'a']);
  });

  it('answers an identical call once when the calls run one after another too', async () => {
    create
      .mockReturnValueOnce(calls(['a', '{}'], ['a', '{"n": 1}'], ['a', '{"n":1}']))
      .mockReturnValueOnce(says('done'));
    const dispatch = vi.fn(async () => 'ok');
    const result = await runAgentLoop({ config, messages: question, tools: [tool('a')], dispatch });
    // Three calls, two questions: the repeat is the repaired arguments matching, not the text.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.messages.filter((m) => m.role === Role.Tool)).toHaveLength(3);
  });

  it('asks again in a later step, where the tools between may have moved the world', async () => {
    create
      .mockReturnValueOnce(calls(['a', '{}']))
      .mockReturnValueOnce(calls(['a', '{}']))
      .mockReturnValueOnce(says('done'));
    const dispatch = vi.fn(async () => 'ok');
    await runAgentLoop({ config, messages: question, tools: [tool('a')], dispatch });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('dispatches every call where the host turned deduping off', async () => {
    create.mockReturnValueOnce(calls(['a', '{}'], ['a', '{}'])).mockReturnValueOnce(says('done'));
    const dispatch = vi.fn(async () => 'ok');
    await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      dispatch,
      dedupeToolCalls: false,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('lets a tool that does something rather than reads something opt out', async () => {
    create
      .mockReturnValueOnce(calls(['send', '{}'], ['send', '{}'], ['read', '{}'], ['read', '{}']))
      .mockReturnValueOnce(says('done'));
    const dispatched: string[] = [];
    const dispatch = vi.fn(async (call: ToolCallRequest) => {
      dispatched.push(call.name);
      return 'ok';
    });
    await runAgentLoop({
      config,
      messages: question,
      tools: [tool('send'), tool('read')],
      dispatch,
      dedupeToolCalls: (call) => call.name !== 'send',
    });
    // Two emails, one read.
    expect(dispatched).toEqual(['send', 'send', 'read']);
  });

  describe('on demand', () => {
    const catalog = [
      {
        id: 's',
        label: 'S',
        tools: [
          { name: 's__read', description: 'reads' },
          { name: 's__write', description: 'writes' },
        ],
      },
    ];
    const tools = [tool('s__read'), tool('s__write')];
    const onDemand = { ...config, toolDiscovery: ToolDiscovery.OnDemand };

    it('loads what the model asks for and declares it on the next step', async () => {
      create
        .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__read"]}']))
        .mockReturnValueOnce(calls(['s__read', '{}']))
        .mockReturnValueOnce(says('done'));
      const dispatch = vi.fn(async () => 'contents');
      const result = await runAgentLoop({
        config: onDemand,
        system: 'sys',
        messages: question,
        tools,
        catalog,
        dispatch,
      });
      expect(declared()).toEqual([[LOAD_TOOLS], [LOAD_TOOLS, 's__read'], [LOAD_TOOLS, 's__read']]);
      const systems = create.mock.calls.map(([body]) => (body as Body).messages[0].content);
      expect(systems[0]).toContain('sys');
      // The head of the prompt does not move when a tool is loaded, so the cache survives it.
      expect(new Set(systems).size).toBe(1);
      expect(systems[0]).not.toContain('(loaded)');
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(result.loaded).toEqual(['s__read']);
      expect(result.used).toEqual(['s__read']);
    });

    it('announces load_tools like any other call, with the whole answer', async () => {
      create
        .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__read"]}'], [LOAD_TOOLS, '{}']))
        .mockReturnValueOnce(says('done'));
      const dispatch = vi.fn(async () => 'contents');
      const asked: ToolCallRequest[] = [];
      const answered: ToolCallResult[] = [];
      const events: RunEventInput[] = [];
      const result = await runAgentLoop({
        config: onDemand,
        messages: question,
        tools,
        catalog,
        dispatch,
        onToolCall: (call) => asked.push(call),
        onToolResult: (answer) => answered.push(answer),
        onEvent: (event) => events.push(event),
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(asked).toEqual([
        { id: 'c0', name: LOAD_TOOLS, args: { names: ['s__read'] }, raw: '{"names":["s__read"]}' },
        { id: 'c1', name: LOAD_TOOLS, args: {}, raw: '{}' },
      ]);
      const stored = result.messages.flatMap((m) => (m.role === Role.Tool ? [m.content] : []));
      expect(answered).toEqual([
        { id: 'c0', name: LOAD_TOOLS, ok: true, content: stored[0] },
        // A load that named nothing loaded nothing, and says so under its own id.
        { id: 'c1', name: LOAD_TOOLS, ok: false, content: stored[1] },
      ]);
      expect(answered[0].content).toContain('s__read');
      const pairs = events.filter((e) => e.kind === RunEventKind.ToolCall || e.kind === RunEventKind.ToolResult);
      expect(pairs.map((e) => [e.kind, e.id])).toEqual([
        [RunEventKind.ToolCall, 'c0'],
        [RunEventKind.ToolResult, 'c0'],
        [RunEventKind.ToolCall, 'c1'],
        [RunEventKind.ToolResult, 'c1'],
      ]);
      expect(result.toolCalls).toEqual([
        { id: 'c0', name: LOAD_TOOLS, ok: true },
        { id: 'c1', name: LOAD_TOOLS, ok: false },
      ]);
    });

    it('counts what the model loaded, and calls a load that moved the tools a cache break', async () => {
      create
        .mockReturnValueOnce(reportedCall(100, 0, LOAD_TOOLS, '{"names":["s__read","nope"]}'))
        .mockReturnValueOnce(reportedCall(160, 0, LOAD_TOOLS, '{"names":["s__read"]}'))
        .mockReturnValueOnce(reported(190, 170, { content: 'done' }));
      const result = await runAgentLoop({
        config: onDemand,
        messages: question,
        tools,
        catalog,
        dispatch: async () => 'ok',
      });
      expect(result.metrics).toMatchObject({
        loadCalls: 2,
        toolsLoaded: 1,
        redundantLoads: 1,
        unknownToolNames: 1,
        cacheBreaks: 1,
        cacheBreakReasons: { 'tools-changed': 1 },
      });
    });

    it('declares loads in name order however they happened, and answers a repeat load', async () => {
      create
        .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__write"]}']))
        .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__read","s__write"]}']))
        .mockReturnValueOnce(says('done'));
      const result = await runAgentLoop({
        config: onDemand,
        messages: question,
        tools,
        catalog,
        dispatch: async () => 'ok',
      });
      // `s__write` was loaded first and is still declared second: the array a request sends is
      // decided by the names in it, not by the order the loads happened in, so the same pair
      // renders the same way in a run that loaded them the other way round.
      expect(declared()).toEqual([[LOAD_TOOLS], [LOAD_TOOLS, 's__write'], [LOAD_TOOLS, 's__read', 's__write']]);
      const second = result.messages.filter((message) => message.role === Role.Tool)[1];
      expect(second.content).toContain('Loaded 1 tool(s)');
      expect(second.content).toContain('Already loaded and in your tool list: s__write');
    });

    it('loads and runs a catalogued tool called without loading it', async () => {
      create.mockReturnValueOnce(calls(['s__write', '{}'])).mockReturnValueOnce(says('done'));
      const dispatch = vi.fn(async () => 'written');
      const result = await runAgentLoop({
        config: onDemand,
        messages: question,
        tools,
        catalog,
        dispatch,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(result.loaded).toEqual(['s__write']);
      expect(declared()[1]).toEqual([LOAD_TOOLS, 's__write']);
    });

    it('opens a preselected run with those tools alone, and the catalogue after', async () => {
      create.mockReturnValueOnce(calls(['s__read', '{}'])).mockReturnValueOnce(says('done'));
      await runAgentLoop({
        config: onDemand,
        system: 'sys',
        messages: question,
        tools,
        catalog,
        preselected: ['s__read'],
        dispatch: async () => 'ok',
      });
      expect(declared()).toEqual([['s__read'], [LOAD_TOOLS, 's__read']]);
      expect((create.mock.calls[0][0] as Body).messages[0].content).toBe('sys');
      expect((create.mock.calls[1][0] as Body).messages[0].content).toContain('Tool catalogue');
    });

    describe('with the preselection appended', () => {
      const wide = [
        {
          id: 's',
          label: 'S',
          tools: ['s__list', 's__read', 's__write'].map((name) => ({ name, description: name })),
        },
      ];
      const all = [tool('s__list'), tool('s__read'), tool('s__write')];
      const bodies = () => create.mock.calls.map(([body]) => body as Body);

      it('sends the first step the head of every other step', async () => {
        create.mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__write"]}'])).mockReturnValueOnce(says('done'));
        const result = await runAgentLoop({
          config: onDemand,
          system: 'sys',
          messages: question,
          tools: all,
          catalog: wide,
          preselected: ['s__list'],
          preselectRouting: PRESELECT_APPEND,
          toolOrder: false,
          dispatch: async () => 'ok',
        });
        const [first, second] = bodies();
        expect(first.messages[0].content).toContain('Tool catalogue');
        expect(first.messages[0]).toEqual(second.messages[0]);
        expect(declared()[0]).toEqual([LOAD_TOOLS, 's__list']);
        // What step 0 declared is the start of what step 1 declares, definition for definition.
        expect(second.tools?.slice(0, first.tools?.length)).toEqual(first.tools);
        expect(declared()[1]).toEqual([LOAD_TOOLS, 's__list', 's__write']);
        expect(result.loaded).toEqual(['s__list', 's__write']);
      });

      it('puts the shortlist after what was carried, and declares a carried name once', async () => {
        create.mockReturnValueOnce(says('done'));
        const result = await runAgentLoop({
          config: onDemand,
          messages: question,
          tools: all,
          catalog: wide,
          loaded: ['s__write', 's__read'],
          preselected: ['s__read', 's__list'],
          preselectRouting: PRESELECT_APPEND,
          toolOrder: false,
          dispatch: async () => 'ok',
        });
        // The carried pair is where the last turn's request had it, so that request's tool array
        // is a prefix of this one's; `s__read` is not declared a second time for being picked.
        expect(declared()).toEqual([[LOAD_TOOLS, 's__write', 's__read', 's__list']]);
        expect(result.loaded).toEqual(['s__write', 's__read', 's__list']);
      });

      it('sorts the shortlist in under toolOrder, which moves what sorts after it', async () => {
        create.mockReturnValueOnce(calls(['s__list', '{}'])).mockReturnValueOnce(says('done'));
        await runAgentLoop({
          config: onDemand,
          system: 'sys',
          messages: question,
          tools: all,
          catalog: wide,
          loaded: ['s__write'],
          preselected: ['s__list'],
          preselectRouting: PRESELECT_APPEND,
          dispatch: async () => 'ok',
        });
        // The last turn ended on [load_tools, s__write]; `s__list` lands between them, not after.
        expect(declared()).toEqual([
          [LOAD_TOOLS, 's__list', 's__write'],
          [LOAD_TOOLS, 's__list', 's__write'],
        ]);
        const [first, second] = bodies();
        expect(first.messages[0]).toEqual(second.messages[0]);
        expect(first.tools).toEqual(second.tools);
      });

      it("leaves the second step's head as the first's, where exclusive moves the tools", async () => {
        const run = async (preselectRouting?: 'exclusive' | 'append') => {
          create
            .mockReturnValueOnce(reportedCall(100, 0, 's__read'))
            .mockReturnValueOnce(reported(130, 0, { content: 'done' }));
          const { metrics } = await runAgentLoop({
            config: onDemand,
            system: 'sys',
            messages: question,
            tools: all,
            catalog: wide,
            preselected: ['s__read'],
            ...(preselectRouting ? { preselectRouting } : {}),
            dispatch: async () => 'ok',
          });
          return metrics;
        };
        // The server reports the same miss both times; the loop's own comparison of the two
        // requests finds nothing that moved when appended, and the tool array when not.
        expect(await run(PRESELECT_APPEND)).toMatchObject({ cacheBreakReasons: { 'none-known': 1 } });
        // Absent is exclusive: the first step's tools are not the second's.
        expect(await run()).toMatchObject({
          cacheBreaks: 1,
          cacheBreakReasons: { 'tools-changed': 1 },
        });
        expect(declared().slice(2)).toEqual([['s__read'], [LOAD_TOOLS, 's__read']]);
      });

      it('changes nothing in eager mode or without a preselection', async () => {
        create.mockReturnValueOnce(says('done')).mockReturnValueOnce(says('done'));
        await runAgentLoop({
          config,
          messages: question,
          tools: all,
          catalog: wide,
          preselected: ['s__read'],
          preselectRouting: PRESELECT_APPEND,
          dispatch: async () => 'ok',
        });
        await runAgentLoop({
          config: onDemand,
          messages: question,
          tools: all,
          catalog: wide,
          preselectRouting: PRESELECT_APPEND,
          dispatch: async () => 'ok',
        });
        expect(declared()).toEqual([['s__list', 's__read', 's__write'], [LOAD_TOOLS]]);
      });
    });

    it('runs a `call_tool` left in the history as the tool it names, and loads it', async () => {
      create
        .mockReturnValueOnce(calls([CALL_TOOL, '{"name":"s__read","arguments":{"path":"a"}}']))
        .mockReturnValueOnce(says('done'));
      const dispatch = vi.fn(async (_call: ToolCallRequest) => 'contents');
      const result = await runAgentLoop({
        config: onDemand,
        messages: question,
        tools,
        catalog,
        dispatch,
      });
      expect(dispatch.mock.calls[0][0]).toMatchObject({ name: 's__read', args: { path: 'a' } });
      expect(result.used).toEqual(['s__read']);
      // On demand a called tool is a declared one, so the model's next call can be a native one.
      expect(declared()).toEqual([[LOAD_TOOLS], [LOAD_TOOLS, 's__read']]);
    });

    it("leaves a host's own `call_tool` to the host", async () => {
      create
        .mockReturnValueOnce(calls([CALL_TOOL, '{"name":"s__read","arguments":{}}']))
        .mockReturnValueOnce(says('done'));
      const dispatch = vi.fn(async (_call: ToolCallRequest) => "the host's answer");
      await runAgentLoop({
        config: onDemand,
        messages: question,
        tools: [...tools, tool(CALL_TOOL)],
        catalog: [...catalog, { id: 'h', label: 'H', tools: [{ name: CALL_TOOL, description: "the host's" }] }],
        dispatch,
      });
      expect(dispatch.mock.calls[0][0]).toMatchObject({
        name: CALL_TOOL,
        args: { name: 's__read', arguments: {} },
      });
    });
  });

  describe('proxied', () => {
    const catalog = [
      {
        id: 's',
        label: 'S',
        tools: [
          { name: 's__read', description: 'reads' },
          { name: 's__write', description: 'writes' },
        ],
      },
    ];
    const read: OpenAI.ChatCompletionFunctionTool = {
      type: FUNCTION_TOOL,
      function: {
        name: 's__read',
        description: 'Reads a file.',
        parameters: {
          type: SchemaType.Object,
          properties: { path: { type: SchemaType.String } },
          required: ['path'],
        },
      },
    };
    const tools = [read, tool('s__write')];
    const proxied = { ...config, toolDiscovery: ToolDiscovery.Proxy };
    /** What a proxied load of `s__read` answers with: the definition as one line of JSON. */
    const definition = `Loaded 1 tool(s). Run them with \`call_tool\`.\n\n${JSON.stringify({
      name: read.function.name,
      description: read.function.description,
      parameters: read.function.parameters,
    })}`;
    const results = (messages: Message[]) =>
      messages.flatMap((message) => (message.role === Role.Tool ? [String(message.content)] : []));

    it('declares `load_tools` and `call_tool` on every step, whatever is loaded', async () => {
      create
        .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__read"]}']))
        .mockReturnValueOnce(calls([CALL_TOOL, '{"name":"s__read","arguments":{"path":"a"}}']))
        .mockReturnValueOnce(says('done'));
      const dispatch = vi.fn(async (_call: ToolCallRequest) => 'contents');
      const result = await runAgentLoop({
        config: proxied,
        system: 'sys',
        messages: question,
        tools,
        catalog,
        loaded: ['s__write'],
        dispatch,
      });
      // Name order, like any other tool array, and the same two on all three requests.
      expect(declared()).toEqual([
        [CALL_TOOL, LOAD_TOOLS],
        [CALL_TOOL, LOAD_TOOLS],
        [CALL_TOOL, LOAD_TOOLS],
      ]);
      const bodies = create.mock.calls.map(([body]) => body as Body);
      expect(JSON.stringify(bodies[2].tools)).toBe(JSON.stringify(bodies[0].tools));
      const systems = bodies.map((body) => body.messages[0].content);
      expect(new Set(systems).size).toBe(1);
      expect(systems[0]).toContain('sys');
      expect(systems[0]).toContain('run them with `call_tool`');
      expect(systems[0]).not.toContain('tool list');

      // The load's result is the definition, since no request will ever declare it.
      expect(results(result.messages)).toEqual([definition, 'contents']);
      // The dispatcher is handed the tool the model meant, exactly as a native call would be.
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0][0]).toEqual({
        id: 'c0',
        name: 's__read',
        args: { path: 'a' },
        raw: '{"path":"a"}',
      });
      expect(result.used).toEqual(['s__read']);
      // Nothing carries: neither what was handed in nor what this run loaded.
      expect(result.loaded).toEqual([]);
      expect(result.toolCalls).toEqual([
        { id: 'c0', name: LOAD_TOOLS, ok: true },
        { id: 'c0', name: 's__read', ok: true },
      ]);
      expect(result.metrics).toMatchObject({ loadCalls: 1, toolsLoaded: 1, toolCalls: 2 });
      // The transcript keeps the call the model wrote, which the next request has to repeat.
      const written = result.messages[3] as OpenAI.ChatCompletionAssistantMessageParam;
      expect(written.tool_calls?.[0]).toMatchObject({
        function: { name: CALL_TOOL, arguments: '{"name":"s__read","arguments":{"path":"a"}}' },
      });
    });

    it('sends `call_tool` a schema that still lets the model pass an argument', async () => {
      create.mockReturnValueOnce(says('done'));
      await runAgentLoop({
        config: proxied,
        messages: question,
        tools,
        catalog,
        dispatch: async () => 'ok',
      });
      const sent = (create.mock.calls[0][0] as Body).tools as OpenAI.ChatCompletionFunctionTool[];
      const call = sent.find((entry) => entry.function.name === CALL_TOOL);
      // Sanitising gives the object an empty property list; without the keyword beside it a
      // grammar-constrained server compiles that to `{}`.
      expect(call?.function.parameters?.properties).toMatchObject({
        arguments: { type: SchemaType.Object, properties: {}, additionalProperties: true },
      });
    });

    it('reports a `call_tool` to a watcher as the tool it ran', async () => {
      create
        .mockReturnValueOnce(calls([CALL_TOOL, '{"name":"s__write","arguments":{"text":"x"}}']))
        .mockReturnValueOnce(says('done'));
      const events: { kind: string; name?: string; text?: string }[] = [];
      await runAgentLoop({
        config: proxied,
        messages: question,
        tools,
        catalog,
        dispatch: async () => 'written',
        onEvent: (event) => events.push(event),
      });
      expect(events.filter((event) => event.kind.startsWith('tool-'))).toMatchObject([
        { kind: RunEventKind.ToolCall, name: 's__write', text: '{"text":"x"}' },
        { kind: RunEventKind.ToolResult, name: 's__write', ok: true, text: 'written' },
      ]);
    });

    it('takes `arguments` as a JSON string, and refuses a name outside the catalogue', async () => {
      create
        .mockReturnValueOnce(
          calls(
            [CALL_TOOL, JSON.stringify({ name: 's__read', arguments: '{"path":"b"}' })],
            [CALL_TOOL, '{"name":"rm_rf","arguments":{}}'],
            [CALL_TOOL, '{"arguments":{}}'],
            [CALL_TOOL, '{"name":"s__read","arguments":[1]}'],
            [CALL_TOOL, '{"name":"s__read","arguments":"{not json"}'],
            [CALL_TOOL, '{"name":"load_tools","arguments":{"names":["s__read"]}}'],
          ),
        )
        .mockReturnValueOnce(says('done'));
      const dispatch = vi.fn(async (_call: ToolCallRequest) => 'contents');
      const result = await runAgentLoop({
        config: proxied,
        messages: question,
        tools,
        catalog,
        dispatch,
      });
      // One call reached the dispatcher: the string was read as the arguments it spells.
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0][0]).toMatchObject({
        name: 's__read',
        args: { path: 'b' },
        raw: '{"path":"b"}',
      });
      const answers = results(result.messages);
      expect(answers[0]).toBe('contents');
      expect(answers[1]).toContain('Not in the catalogue: rm_rf. Check the name and try again.');
      expect(answers[2]).toContain('call_tool needs a name; pass one from the tool catalogue.');
      expect(answers[3]).toContain('call_tool arguments for s__read must be an object.');
      expect(answers[4]).toContain('call_tool arguments for s__read are not valid JSON');
      // `load_tools` is not in the catalogue either, so it cannot be reached through the proxy.
      expect(answers[5]).toContain('Not in the catalogue: load_tools.');
      expect(result.toolCalls.map((call) => call.ok)).toEqual([true, false, false, false, false, false]);
      expect(result.used).toEqual(['s__read']);
    });

    it('answers a repeat load with a pointer back, not the definition a second time', async () => {
      create
        .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__read"]}']))
        .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__read","s__write","nope"]}']))
        .mockReturnValueOnce(says('done'));
      const result = await runAgentLoop({
        config: proxied,
        messages: question,
        tools,
        catalog,
        dispatch: async () => 'ok',
      });
      const second = results(result.messages)[1];
      expect(second).toContain('Loaded 1 tool(s). Run them with `call_tool`.');
      expect(second).toContain('"name":"s__write"');
      expect(second).not.toContain('"name":"s__read"');
      expect(second).toContain('Already loaded earlier in this conversation: s__read.');
      expect(second).toContain('Not in the catalogue: nope.');
      expect(result.metrics).toMatchObject({
        loadCalls: 2,
        toolsLoaded: 2,
        redundantLoads: 1,
        unknownToolNames: 1,
      });
    });

    it('sends the definition again once the transcript has been rewritten under it', async () => {
      create
        .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__read"]}']))
        .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__read"]}']))
        .mockReturnValueOnce(says('done'));
      const result = await runAgentLoop({
        config: proxied,
        messages: question,
        tools,
        catalog,
        dispatch: async () => 'ok',
        // A fold that took the first load with it: only the question is left.
        beforeStep: (messages, step) => (step === 1 ? messages.slice(0, 1) : undefined),
      });
      expect(results(result.messages)).toEqual([definition]);
    });

    it('writes a preselection into the transcript as a load the model did not make', async () => {
      create
        .mockReturnValueOnce(calls([CALL_TOOL, '{"name":"s__read","arguments":{"path":"a"}}']))
        .mockReturnValueOnce(says('done'));
      const history: Message[] = [
        { role: Role.User, content: 'earlier' },
        { role: Role.Assistant, content: 'answered' },
        { role: Role.User, content: 'read a' },
      ];
      const events: { kind: string; name?: string; text?: string; ok?: boolean | null }[] = [];
      const result = await runAgentLoop({
        config: proxied,
        system: 'sys',
        messages: history,
        tools,
        catalog,
        // One the host has no definition for and one that is in no catalogue are left out.
        preselected: ['s__read', 's__read', 'gone', 's__ghost'],
        dispatch: async () => 'contents',
        onEvent: (event) => events.push(event),
      });

      const exchange: Message[] = [
        {
          role: Role.Assistant,
          content: null,
          tool_calls: [
            {
              id: 'preselect-3',
              type: FUNCTION_TOOL,
              function: { name: LOAD_TOOLS, arguments: '{"names":["s__read"]}' },
            },
          ],
        },
        { role: Role.Tool, tool_call_id: 'preselect-3', content: definition },
      ];
      // After the question, ahead of anything the model does, and handed back like any other.
      expect(result.messages.slice(0, 5)).toEqual([...history, ...exchange]);
      expect(result.messages).toHaveLength(8);
      // The caller's array is not written to.
      expect(history).toHaveLength(3);

      // The first request already carries it: same head as every later step, no step of its own.
      const first = create.mock.calls[0][0] as Body;
      expect(first.messages).toEqual([
        { role: Role.System, content: expect.stringContaining('# Tool catalogue') },
        ...history,
        ...exchange,
      ]);
      expect(declared()).toEqual([
        [CALL_TOOL, LOAD_TOOLS],
        [CALL_TOOL, LOAD_TOOLS],
      ]);
      const second = create.mock.calls[1][0] as Body;
      expect(second.messages.slice(0, 6)).toEqual(first.messages);

      // A watcher sees the exchange the transcript holds, before the first turn.
      const tooling = events.filter((event) => event.kind.startsWith('tool-'));
      expect(tooling.slice(0, 2)).toMatchObject([
        { kind: RunEventKind.ToolCall, name: LOAD_TOOLS, text: '{"names":["s__read"]}' },
        { kind: RunEventKind.ToolResult, name: LOAD_TOOLS, ok: true, text: definition },
      ]);
      expect(events.findIndex((event) => event.kind === RunEventKind.ToolResult)).toBeLessThan(
        events.findIndex((event) => event.kind === RunEventKind.Turn),
      );
      expect(result.toolCalls).toEqual([
        { id: 'preselect-3', name: LOAD_TOOLS, ok: true },
        { id: 'c0', name: 's__read', ok: true },
      ]);
      expect(result.metrics).toMatchObject({ loadCalls: 1, toolsLoaded: 1, redundantLoads: 0 });
      expect(result.used).toEqual(['s__read']);
      expect(result.loaded).toEqual([]);
    });

    it("tells a host of a proxied call as the tool it names, and of a preselection's load", async () => {
      create
        .mockReturnValueOnce(
          calls(
            [CALL_TOOL, '{"name":"s__read","arguments":{"path":"a"}}'],
            [CALL_TOOL, '{"name":"s__ghost","arguments":{"path":"b"}}'],
          ),
        )
        .mockReturnValueOnce(says('done'));
      const asked: ToolCallRequest[] = [];
      const answers: ToolCallResult[] = [];
      const dispatch = vi.fn(async (_call: ToolCallRequest) => 'contents');
      await runAgentLoop({
        config: proxied,
        messages: question,
        tools,
        catalog,
        preselected: ['s__read'],
        dispatch,
        onToolCall: (call) => asked.push(call),
        onToolResult: (result) => answers.push(result),
      });
      // The shortlist's load first, under the id the transcript gives it; then each `call_tool`
      // under the inner name, with the inner arguments where the call was let through.
      expect(asked).toEqual([
        {
          id: 'preselect-1',
          name: LOAD_TOOLS,
          args: { names: ['s__read'] },
          raw: '{"names":["s__read"]}',
        },
        { id: 'c0', name: 's__read', args: { path: 'a' }, raw: '{"path":"a"}' },
        { id: 'c1', name: 's__ghost', args: {}, raw: '{"path":"b"}' },
      ]);
      // What `dispatch` runs is the object the host was told of.
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0][0]).toBe(asked[1]);
      expect(answers).toEqual([
        { id: 'preselect-1', name: LOAD_TOOLS, ok: true, content: definition },
        { id: 'c0', name: 's__read', ok: true, content: 'contents' },
        {
          id: 'c1',
          name: 's__ghost',
          ok: false,
          content: 'Not in the catalogue: s__ghost. Check the name and try again.',
        },
      ]);
    });

    it('answers a load of something preselected with a pointer back', async () => {
      create.mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__read"]}'])).mockReturnValueOnce(says('done'));
      const result = await runAgentLoop({
        config: proxied,
        messages: question,
        tools,
        catalog,
        preselected: ['s__read'],
        dispatch: async () => 'ok',
      });
      expect(results(result.messages)[1]).toBe(
        'Already loaded earlier in this conversation: s__read. Run them with `call_tool`; do not load them again.',
      );
    });

    it('writes no exchange for a preselection with nothing in it to define', async () => {
      create.mockReturnValueOnce(says('done'));
      const result = await runAgentLoop({
        config: proxied,
        messages: question,
        tools,
        catalog,
        preselected: ['gone'],
        dispatch: async () => 'ok',
      });
      expect(result.messages).toEqual([...question, { role: Role.Assistant, content: 'done' }]);
      expect(result.toolCalls).toEqual([]);
    });

    it('runs a catalogued tool called natively, without calling it loaded', async () => {
      create
        .mockReturnValueOnce(calls(['s__read', '{"path":"a"}']))
        .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__read"]}']))
        .mockReturnValueOnce(says('done'));
      const dispatch = vi.fn(async (_call: ToolCallRequest) => 'contents');
      const result = await runAgentLoop({
        config: proxied,
        messages: question,
        tools,
        catalog,
        dispatch,
      });
      expect(dispatch.mock.calls[0][0]).toMatchObject({ name: 's__read', args: { path: 'a' } });
      // The native call put no definition in the history, so the load that follows still does.
      expect(results(result.messages)[1]).toBe(definition);
    });

    it('shares one answer between a `call_tool` and the same call made natively', async () => {
      create
        .mockReturnValueOnce(
          calls([CALL_TOOL, '{"name":"s__read","arguments":{"path":"a"}}'], ['s__read', '{"path":"a"}']),
        )
        .mockReturnValueOnce(says('done'));
      const dispatch = vi.fn(async (_call: ToolCallRequest) => 'contents');
      await runAgentLoop({ config: proxied, messages: question, tools, catalog, dispatch });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('recovers a `call_tool` the model wrote as text', async () => {
      create
        .mockReturnValueOnce(
          says('<tool_call>{"name":"call_tool","arguments":{"name":"s__write","arguments":{}}}</tool_call>'),
        )
        .mockReturnValueOnce(says('done'));
      const dispatch = vi.fn(async (_call: ToolCallRequest) => 'written');
      await runAgentLoop({ config: proxied, messages: question, tools, catalog, dispatch });
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ name: 's__write', args: {} });
    });

    it('does not call a tool loaded when the host gave no definition for it', async () => {
      create.mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__write"]}'])).mockReturnValueOnce(says('done'));
      const result = await runAgentLoop({
        config: proxied,
        messages: question,
        tools: [read],
        catalog,
        dispatch: async () => 'ok',
      });
      expect(results(result.messages)).toEqual(['No definition is available for: s__write.']);
      expect(result.toolCalls).toEqual([{ id: 'c0', name: LOAD_TOOLS, ok: false }]);
      expect(result.metrics).toMatchObject({ loadCalls: 1, toolsLoaded: 0, redundantLoads: 0 });
    });

    it('is eager without a catalogue, like on-demand mode', async () => {
      create.mockReturnValueOnce(says('done'));
      await runAgentLoop({ config: proxied, messages: question, tools, dispatch: async () => '' });
      expect(declared()).toEqual([['s__read', 's__write']]);
    });
  });

  it("puts the hooks' context on the question, and tells them the reply", async () => {
    create.mockReturnValueOnce(calls(['a', '{}'])).mockReturnValueOnce(says('the answer'));
    const run = vi.fn(async (event: string) =>
      event === HookEvent.BeforeTurn
        ? [
            {
              serverId: 'm',
              label: 'memory',
              hookId: 'h',
              event,
              ok: true,
              text: 'you like tea',
              inject: true,
              maxTokens: 500,
            },
          ]
        : [],
    );
    const result = await runAgentLoop({
      config,
      messages: [
        { role: Role.User, content: 'earlier' },
        { role: Role.Assistant, content: 'sure' },
        { role: Role.User, content: 'what do I like?' },
      ],
      tools: [tool('a')],
      dispatch: async () => 'ok',
      hooks: { run: run as never, context: { session: { id: 's1' } } },
    });
    for (const [body] of create.mock.calls) {
      const sent = (body as Body).messages;
      expect(sent[2].content).toContain('you like tea');
      expect(sent[0].content).toBe('earlier');
    }
    // The transcript handed back is the one without the context; it was for the request only.
    expect(result.messages[2].content).toBe('what do I like?');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    const [event, context] = run.mock.calls[1] as unknown as [string, Record<string, unknown>];
    expect(event).toBe(HookEvent.AfterTurn);
    expect(context).toMatchObject({ reply: 'the answer', turn: { index: 1 } });
  });

  it("says configureHooks' preface above the hooks' context, unless the loop gives its own", async () => {
    const run = async (event: string) => [
      {
        serverId: 'm',
        label: 'memory',
        hookId: 'h',
        event,
        ok: true,
        text: 'you like tea',
        inject: true,
        maxTokens: 500,
      },
    ];
    const sentQuestion = async (preface?: string) => {
      create.mockReset().mockReturnValueOnce(says('ok'));
      await runAgentLoop({
        config,
        messages: question,
        dispatch: async () => 'ok',
        hooks: { run: run as never, context: { session: { id: 's1' } }, preface },
      });
      return (create.mock.calls[0][0] as Body).messages[0].content as string;
    };
    configureHooks({ preface: 'From min-agent:' });
    try {
      expect(await sentQuestion()).toMatch(/^From min-agent:\n\n<context source="memory">/);
      expect(await sentQuestion('From kanban:')).toMatch(/^From kanban:\n\n<context/);
      expect(await sentQuestion('')).toMatch(/^<context source="memory">/);
    } finally {
      resetHooks();
    }
  });

  describe("the hooks' context on past questions", () => {
    /** A runner whose `beforeTurn` hook recalls this, and whose other events do nothing. */
    const recalls = (text: string) => async (event: string) =>
      event === HookEvent.BeforeTurn
        ? [
            {
              serverId: 'm',
              label: 'memory',
              hookId: 'h',
              event,
              ok: true,
              text,
              inject: true,
              maxTokens: 500,
            },
          ]
        : [];
    const hooks = (text: string, preface?: string) => ({
      run: recalls(text) as never,
      context: { session: { id: 's1' } },
      preface,
    });
    const sent = (call: number) => (create.mock.calls[call][0] as Body).messages;

    it("hands back what it put on the question, so the next turn's request only appends", async () => {
      create
        .mockReturnValueOnce(calls(['a', '{}']))
        .mockReturnValueOnce(says('tea'))
        .mockReturnValueOnce(says('toast'));
      const first = await runAgentLoop({
        config,
        system: 'sys',
        messages: [{ role: Role.User, content: 'what do I like?' }],
        tools: [tool('a')],
        dispatch: async () => 'ok',
        hooks: hooks('you like tea'),
      });
      expect(first.context).toBe('<context source="memory">\nyou like tea\n</context>');
      // The host stores what the user typed, and beside it what the loop said above it.
      expect(first.messages[0].content).toBe('what do I like?');
      const stored = { at: 0, context: first.context, preface: first.preface };
      const history: Message[] = [...first.messages, { role: Role.User, content: 'and to eat?' }];

      await runAgentLoop({
        config,
        system: 'sys',
        messages: withContext(history, stored.at, stored.context, stored.preface),
        tools: [tool('a')],
        dispatch: async () => 'ok',
        hooks: hooks('you like toast'),
      });
      // Everything the last request of the first turn sent is the head of the next one, byte for
      // byte — the earlier question with its context still on it.
      const before = sent(1);
      const after = sent(2);
      expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
      expect(after[1].content).toContain('you like tea');
      expect(after.at(-1)?.content).toContain('you like toast');
      expect(after.at(-1)?.content).not.toContain('you like tea');
    });

    it('sends the earlier question bare when the host stores nothing, which is the rewrite', async () => {
      create.mockReturnValueOnce(says('tea')).mockReturnValueOnce(says('toast'));
      const first = await runAgentLoop({
        config,
        messages: [{ role: Role.User, content: 'what do I like?' }],
        dispatch: async () => 'ok',
        hooks: hooks('you like tea'),
      });
      await runAgentLoop({
        config,
        messages: [...first.messages, { role: Role.User, content: 'and to eat?' }],
        dispatch: async () => 'ok',
        hooks: hooks('you like toast'),
      });
      expect(sent(0)[0].content).toContain('you like tea');
      expect(sent(1)[0].content).toBe('what do I like?');
    });

    it('hands back the preface it said, so a stored question outlives a change of it', async () => {
      const parts = [{ type: PartType.Text, text: 'what do I like?' }];
      configureHooks({ preface: 'From min-agent:' });
      try {
        create.mockReturnValueOnce(says('tea')).mockReturnValueOnce(says('toast'));
        const first = await runAgentLoop({
          config,
          messages: [{ role: Role.User, content: parts }],
          dispatch: async () => 'ok',
          hooks: hooks('you like tea'),
        });
        expect(first.preface).toBe('From min-agent:');
        configureHooks({ preface: 'From kanban:' });
        const history: Message[] = [...first.messages, { role: Role.User, content: 'and to eat?' }];
        const second = await runAgentLoop({
          config,
          messages: withContext(history, 0, first.context, first.preface),
          dispatch: async () => 'ok',
          hooks: hooks('you like toast'),
        });
        expect(second.preface).toBe('From kanban:');
        expect(JSON.stringify(sent(1).slice(0, 1))).toBe(JSON.stringify(sent(0)));
        expect(sent(1).at(-1)?.content).toMatch(/^From kanban:\n\n<context/);
      } finally {
        resetHooks();
      }
    });

    it("hands back the loop's own preface over the process's, and an empty one as empty", async () => {
      for (const preface of ['From kanban:', '']) {
        create.mockReset().mockReturnValueOnce(says('tea'));
        const result = await runAgentLoop({
          config,
          messages: question,
          dispatch: async () => 'ok',
          hooks: hooks('you like tea', preface),
        });
        expect(result.preface).toBe(preface);
        expect(withContext(result.messages, 0, result.context, result.preface)[0]).toEqual(sent(0)[0]);
      }
    });

    it('hands back no context when no hook added any, or none was given', async () => {
      create.mockReturnValueOnce(says('one')).mockReturnValueOnce(says('two'));
      const quiet = await runAgentLoop({
        config,
        messages: question,
        dispatch: async () => 'ok',
        hooks: { run: async () => [], context: { session: { id: 's1' } } },
      });
      expect(quiet.context).toBe('');
      const bare = await runAgentLoop({ config, messages: question, dispatch: async () => 'ok' });
      expect(bare.context).toBe('');
      await expect(bare.afterTurn).resolves.toEqual([]);
    });

    it("hands back afterTurn's notes as a promise, without waiting for them itself", async () => {
      create.mockReturnValueOnce(says('the answer'));
      let finish: (outcomes: unknown[]) => void = () => {};
      const heard: unknown[] = [];
      const run = vi.fn((event: string) =>
        event === HookEvent.AfterTurn
          ? new Promise<unknown[]>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve([]),
      );
      const result = await runAgentLoop({
        config,
        messages: question,
        dispatch: async () => 'ok',
        hooks: {
          run: run as never,
          context: { session: { id: 's1' } },
          onNote: (note) => heard.push(note),
        },
      });
      // The loop is back and the hook is still running.
      expect(result.turn.content).toBe('the answer');
      expect(result.notes).toEqual([]);
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      expect(heard).toEqual([]);
      finish([
        {
          serverId: 'm',
          label: 'memory',
          hookId: 'h',
          event: HookEvent.AfterTurn,
          ok: false,
          error: 'down',
          ms: 1,
          inject: false,
          maxTokens: 0,
        },
      ]);
      const note = { event: HookEvent.AfterTurn, source: 'memory', hookId: 'h', error: 'down' };
      await expect(result.afterTurn).resolves.toEqual([note]);
      expect(heard).toEqual([note]);
    });
  });

  it('lets beforeStep replace the transcript', async () => {
    create.mockReturnValueOnce(calls(['a', '{}'])).mockReturnValueOnce(says('done'));
    const beforeStep = vi.fn((messages: readonly Message[], step: number) =>
      step === 1 ? [{ role: Role.User, content: 'shorter' }, ...messages.slice(1)] : undefined,
    );
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      dispatch: async () => 'ok',
      beforeStep,
    });
    expect(beforeStep).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[1][0] as Body).messages[0]).toEqual({
      role: Role.User,
      content: 'shorter',
    });
    expect(result.messages[0]).toEqual({ role: Role.User, content: 'shorter' });
  });

  it("keeps a ledger of each step's reported prompt, and tells beforeStep how full the window is", async () => {
    create
      .mockReturnValueOnce(reportedCall(100, 0, 'a'))
      .mockReturnValueOnce(reportedCall(160, 100, 'a'))
      .mockReturnValueOnce(reported(260, 160, { content: 'done' }));
    const windows: unknown[] = [];
    const ledgers: unknown[] = [];
    const earlier = [{ through: 0, prompt: 40, epoch: 3 }];
    const result = await runAgentLoop({
      config: { ...config, contextLength: 8000 },
      messages: [{ role: Role.User, content: 'before' }, { role: Role.Assistant, content: 'yes' }, ...question],
      tools: [tool('a')],
      dispatch: async () => 'ok',
      ledger: earlier,
      beforeStep: (_messages, _step, window) => {
        windows.push(window);
        return undefined;
      },
      onEvent: (event) => event.kind === RunEventKind.Usage && ledgers.push(event.usage?.ledger),
    });
    // The earlier run's entry stays, and this run's requests are an epoch of their own: one
    // through the question, then one through each step's tool result.
    expect(result.ledger).toEqual([
      { through: 0, prompt: 40, epoch: 3 },
      { through: 2, prompt: 100, epoch: 4 },
      { through: 4, prompt: 160, epoch: 4 },
      { through: 6, prompt: 260, epoch: 4 },
    ]);
    expect(earlier).toHaveLength(1);
    expect(ledgers).toEqual([result.ledger.slice(0, 2), result.ledger.slice(0, 3), result.ledger]);
    // Each step's call and result, read back as a subtraction — and nothing across the runs.
    const estimate = () => 7;
    expect(tokensBetween(result.ledger, 3, 5, result.messages, { estimate })).toBe(60);
    expect(tokensBetween(result.ledger, 5, 7, result.messages, { estimate })).toBe(100);
    expect(tokensBetween(result.ledger, 1, 3, result.messages, { estimate })).toBe(14);
    // No request of this run's has reported before its first step.
    expect(windows).toEqual([
      { limit: 8000, ledger: earlier },
      { used: 100, limit: 8000, ledger: result.ledger.slice(0, 2) },
      { used: 160, limit: 8000, ledger: result.ledger.slice(0, 3) },
    ]);
  });

  it('starts a new epoch when beforeStep rewrites the history, and records nothing unreported', async () => {
    create
      .mockReturnValueOnce(reportedCall(100, 0, 'a'))
      .mockReturnValueOnce(reportedCall(90, 0, 'a'))
      .mockReturnValueOnce(calls(['a', '{}']))
      .mockReturnValueOnce(reported(170, 0, { content: 'done' }));
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      dispatch: async () => 'ok',
      beforeStep: (messages, step) =>
        step === 1 ? [{ role: Role.User, content: 'shorter' }, ...messages.slice(1)] : undefined,
    });
    // The rewrite moved the first boundary to a later epoch and put the next request in another,
    // so 90 is not read against 100. The third request reported nothing and has no entry; the
    // fourth only appended to the second, and is measured against it across the gap.
    expect(result.ledger).toEqual([
      { through: 0, prompt: 100, epoch: 1 },
      { through: 2, prompt: 90, epoch: 2 },
      { through: 6, prompt: 170, epoch: 2 },
    ]);
    expect(tokensBetween(result.ledger, 3, 7, result.messages)).toBe(80);
  });

  it('does not record a prompt reported net of the cache', async () => {
    create.mockReturnValueOnce(reportedCall(100, 0, 'a')).mockReturnValueOnce(reported(30, 100, { content: 'done' }));
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      dispatch: async () => 'ok',
    });
    expect(result.ledger).toEqual([{ through: 0, prompt: 100, epoch: 0 }]);
  });

  it("hands the host each step's request, as the client is about to be sent it", async () => {
    const order: string[] = [];
    const replies = [calls([LOAD_TOOLS, '{"names":["s__read"]}']), says('done')];
    create.mockImplementation(() => {
      order.push('sent');
      return replies.shift();
    });
    const requests: AgentLoopRequest[] = [];
    await runAgentLoop({
      config: { ...config, toolDiscovery: ToolDiscovery.OnDemand },
      system: 'sys',
      messages: question,
      tools: [tool('s__read')],
      catalog: [{ id: 's', label: 'S', tools: [{ name: 's__read', description: 'reads' }] }],
      dispatch: async () => 'ok',
      onRequest: (request) => {
        order.push('told');
        requests.push(request);
      },
    });
    expect(order).toEqual(['told', 'sent', 'told', 'sent']);
    expect(requests.map((request) => request.step)).toEqual([0, 1]);
    for (const [at, [body]] of create.mock.calls.entries()) {
      // The array itself, catalogue and tool result and all, not a copy of it.
      expect(requests[at].messages).toBe((body as Body).messages);
      expect(requests[at].tools).toEqual((body as Body).tools);
    }
    expect(requests[0].messages[0].content).toContain('Tool catalogue');
    expect(requests[1].messages.at(-1)).toMatchObject({ role: Role.Tool });
    expect(requests[1].tools).toHaveLength(2);
  });

  it('hands over an empty tool list where the request declares none', async () => {
    create.mockReturnValueOnce(says('done'));
    const onRequest = vi.fn();
    await runAgentLoop({ config, messages: question, dispatch: async () => '', onRequest });
    expect(onRequest).toHaveBeenCalledExactlyOnceWith({ messages: question, tools: [], step: 0 });
    expect(create.mock.calls[0][0]).not.toHaveProperty('tools');
  });

  it('reports the request as first built, not what a refusal or a continuation sent after', async () => {
    const strict: OpenAI.ChatCompletionTool = {
      type: FUNCTION_TOOL,
      function: {
        name: 'a',
        parameters: { type: SchemaType.Object, properties: { id: { type: SchemaType.String, pattern: '^\\d+$' } } },
      },
    };
    create
      .mockRejectedValueOnce(new Error('Failed to initialize samplers: failed to parse grammar'))
      .mockReturnValueOnce(says('half', FinishReason.Length))
      .mockReturnValueOnce(says(' and the rest'));
    const requests: AgentLoopRequest[] = [];
    await runAgentLoop({
      config: { ...config, baseUrl: 'http://no-grammar/v1' },
      messages: question,
      tools: [strict],
      dispatch: async () => '',
      maxContinuations: 1,
      onRequest: (request) => requests.push(request),
    });
    // Three requests went out for the one step: the refused one, the relaxed one, the continuation.
    expect(create).toHaveBeenCalledTimes(3);
    expect(requests).toHaveLength(1);
    const [refused, relaxed, continued] = create.mock.calls.map(([body]) => body as Body);
    expect(requests[0].tools).toEqual(refused.tools);
    expect(requests[0].tools).not.toEqual(relaxed.tools);
    expect(requests[0].messages).toHaveLength(continued.messages.length - 1);
  });

  it('ends the run on what onRequest throws, before anything is sent', async () => {
    await expect(
      runAgentLoop({
        config,
        messages: question,
        dispatch: async () => '',
        onRequest: () => {
          throw new Error('host bug');
        },
      }),
    ).rejects.toThrow('host bug');
    expect(create).not.toHaveBeenCalled();
  });

  it("breaks each turn's request down by what filled it, on the usage event", async () => {
    create
      .mockReturnValueOnce(reportedCall(100, 0, 'a'))
      .mockReturnValueOnce(says('half', FinishReason.Length))
      .mockReturnValueOnce(says(' and the rest'));
    const turns: RunUsage['turn'][] = [];
    await runAgentLoop({
      config,
      system: 'sys',
      messages: question,
      tools: [tool('a')],
      dispatch: async () => 'a long result '.repeat(20),
      maxContinuations: 1,
      onEvent: (event) => event.kind === RunEventKind.Usage && turns.push(event.usage?.turn),
    });
    const [first, second] = turns.map((turn) => {
      if (!turn?.context) {
        throw new Error('a turn without a breakdown');
      }
      return turn.context;
    });
    // Shares of what the endpoint reported, adding up to it.
    expect(first.total).toBe(100);
    expect(first.system + first.tools + first.history + first.toolResults).toBe(100);
    expect(first.system).toBeGreaterThan(0);
    expect(first.tools).toBeGreaterThan(0);
    expect(first.toolResults).toBe(0);
    // The second step carries the result, which is most of it. Its total is the first request's
    // ten, though the continuation's ten were added to the turn's prompt.
    expect(turns[1]?.prompt).toBe(20);
    expect(second.total).toBe(10);
    expect(second.toolResults).toBeGreaterThan(second.history);
  });

  it('estimates the breakdown where no prompt was reported, agreeing with toolSchemaTokens', async () => {
    create.mockReturnValueOnce(calls(['a', '{}'])).mockReturnValueOnce(says('done'));
    const turns: RunUsage['turn'][] = [];
    await runAgentLoop({
      config,
      system: 'sys',
      messages: question,
      tools: [tool('a')],
      dispatch: async () => 'ok',
      onEvent: (event) => event.kind === RunEventKind.Usage && turns.push(event.usage?.turn),
    });
    expect(turns[0]?.prompt).toBe(0);
    expect(turns[0]?.context?.tools).toBe(turns[0]?.toolSchemaTokens);
    expect(turns[0]?.context?.total).toBeGreaterThan(turns[0]?.context?.tools ?? 0);
  });

  it('drops an extraBody field the model refuses, and keeps it dropped', async () => {
    const refusal = Object.assign(new Error('400 Unrecognized request argument supplied: id_slot'), {
      status: HttpStatus.BadRequest,
    });
    create.mockRejectedValueOnce(refusal).mockReturnValueOnce(says('done')).mockReturnValueOnce(says('again'));
    const withSlot = { ...config, extraBody: { id_slot: 1 } };
    await runAgentLoop({ config: withSlot, messages: question, dispatch: async () => '' });
    await runAgentLoop({ config: withSlot, messages: question, dispatch: async () => '' });
    expect(create.mock.calls.map(([body]) => 'id_slot' in (body as object))).toEqual([true, false, false]);
  });
});
