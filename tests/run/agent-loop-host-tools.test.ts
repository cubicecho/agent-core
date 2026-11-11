import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDiscovery } from '../../src/core/config.ts';
import { FinishReason, Role } from '../../src/wire/wire.ts';
import { type Body, chunks, config, type Message, says, tool } from '../helpers.ts';

const create = vi.fn();
/** Only the SDK-touching half is replaced; the rest of the client module is pure. */
vi.mock('../../src/endpoint/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/endpoint/client.ts')>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { runAgentLoop } = await import('../../src/run/agent-loop.ts');
const { resetCapabilities } = await import('../../src/endpoint/capabilities.ts');
const { CALL_TOOL, LOAD_TOOLS } = await import('../../src/tools/tool-loading.ts');

type ToolCallRequest = import('../../src/wire/tool-calls.ts').ToolCallRequest;

/** A turn that asks for these calls. */
const calls = (...list: [name: string, args: string][]) =>
  chunks({
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

const question: Message[] = [{ role: Role.User, content: 'hi' }];
const bodies = () => create.mock.calls.map(([body]) => body as Body);
/** What each request was sent, by the name of every tool it declared. */
const declared = () =>
  bodies().map((body) => (body.tools ?? []).map((t) => (t as OpenAI.ChatCompletionFunctionTool).function.name));
const results = (messages: Message[]) =>
  messages.flatMap((message) => (message.role === Role.Tool ? [String(message.content)] : []));

/** A catalogue that also lists the host's `ask_person`, which the loop must not. */
const catalog = [
  {
    id: 's',
    label: 'S',
    tools: [
      { name: 's__read', description: 'reads' },
      { name: 's__write', description: 'writes' },
      { name: 'ask_person', description: 'asks a person' },
    ],
  },
];
const tools = [tool('s__read'), tool('s__write')];
const hostTools = [tool('ask_person')];
const onDemand = { ...config, toolDiscovery: ToolDiscovery.OnDemand };
const proxied = { ...config, toolDiscovery: ToolDiscovery.Proxy };

beforeEach(() => create.mockReset());
afterEach(() => resetCapabilities());

describe('hostTools', () => {
  it('are declared after the tools in eager mode, and dispatched like them', async () => {
    create.mockReturnValueOnce(calls(['ask_person', '{}'])).mockReturnValueOnce(says('done'));
    const dispatch = vi.fn(async (_call: ToolCallRequest) => 'yes');
    const result = await runAgentLoop({
      config,
      messages: question,
      tools,
      hostTools,
      toolOrder: false,
      dispatch,
    });
    expect(declared()).toEqual([
      ['s__read', 's__write', 'ask_person'],
      ['s__read', 's__write', 'ask_person'],
    ]);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ name: 'ask_person', args: {} });
    expect(result.used).toEqual(['ask_person']);
  });

  it('sit after `load_tools` on demand, ahead of every load, and are never counted as loads', async () => {
    create
      .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__write"]}']))
      .mockReturnValueOnce(calls(['ask_person', '{}']))
      .mockReturnValueOnce(says('done'));
    const dispatch = vi.fn(async (_call: ToolCallRequest) => 'yes');
    const result = await runAgentLoop({
      config: onDemand,
      system: 'sys',
      messages: question,
      tools,
      catalog,
      hostTools,
      loaded: ['s__read', 'ask_person'],
      toolOrder: false,
      dispatch,
    });
    // The carried `ask_person` is dropped rather than loaded, and a load appends after the host's tools.
    expect(declared()).toEqual([
      [LOAD_TOOLS, 'ask_person', 's__read'],
      [LOAD_TOOLS, 'ask_person', 's__read', 's__write'],
      [LOAD_TOOLS, 'ask_person', 's__read', 's__write'],
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ name: 'ask_person' });
    expect(result.loaded).toEqual(['s__read', 's__write']);
    expect(result.metrics).toMatchObject({ loadCalls: 1, toolsLoaded: 1, redundantLoads: 0 });
    // Listed by the catalogue the host passed, but not by the one the model is shown.
    const system = String(bodies()[0].messages[0].content);
    expect(system).toContain('s__read');
    expect(system).not.toContain('ask_person');
  });

  it('cannot be loaded on demand, and a load naming one is told it is not in the catalogue', async () => {
    create.mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["ask_person"]}'])).mockReturnValueOnce(says('done'));
    const result = await runAgentLoop({
      config: onDemand,
      messages: question,
      tools: [...tools, ...hostTools],
      catalog,
      hostTools,
      dispatch: async () => 'ok',
    });
    expect(declared()[1]).toEqual(['ask_person', LOAD_TOOLS]);
    expect(result.loaded).toEqual([]);
    expect(result.metrics).toMatchObject({ toolsLoaded: 0, unknownToolNames: 1 });
  });

  it('are declared after `PROXY_TOOLS` on every step proxied, the same array each time', async () => {
    create
      .mockReturnValueOnce(calls([LOAD_TOOLS, '{"names":["s__read"]}']))
      .mockReturnValueOnce(calls(['ask_person', '{}'], [CALL_TOOL, '{"name":"s__read","arguments":{}}']))
      .mockReturnValueOnce(says('done'));
    const dispatch = vi.fn(async (call: ToolCallRequest) => `${call.name} answered`);
    const result = await runAgentLoop({
      config: proxied,
      messages: question,
      tools,
      catalog,
      hostTools,
      toolOrder: false,
      dispatch,
    });
    expect(declared()).toEqual([
      [LOAD_TOOLS, CALL_TOOL, 'ask_person'],
      [LOAD_TOOLS, CALL_TOOL, 'ask_person'],
      [LOAD_TOOLS, CALL_TOOL, 'ask_person'],
    ]);
    const [first, , last] = bodies();
    expect(JSON.stringify(last.tools)).toBe(JSON.stringify(first.tools));
    // The host's tool natively, the catalogued one through `call_tool`: both reach `dispatch`.
    expect(dispatch.mock.calls.map(([call]) => call.name)).toEqual(['ask_person', 's__read']);
    expect(result.used).toEqual(['ask_person', 's__read']);
    expect(result.metrics).toMatchObject({ loadCalls: 1, toolsLoaded: 1 });
    expect(String(first.messages[0].content)).not.toContain('ask_person');
  });

  it('are sorted in with `PROXY_TOOLS` under toolOrder, and stay put from step to step', async () => {
    create.mockReturnValueOnce(calls(['ask_person', '{}'])).mockReturnValueOnce(says('done'));
    await runAgentLoop({
      config: proxied,
      messages: question,
      tools,
      catalog,
      hostTools,
      dispatch: async () => 'ok',
    });
    expect(declared()).toEqual([
      ['ask_person', CALL_TOOL, LOAD_TOOLS],
      ['ask_person', CALL_TOOL, LOAD_TOOLS],
    ]);
  });

  it('cannot be reached through `call_tool`, and the refusal says to call it directly', async () => {
    create
      .mockReturnValueOnce(calls([CALL_TOOL, '{"name":"ask_person","arguments":{}}']))
      .mockReturnValueOnce(says('done'));
    const dispatch = vi.fn(async () => 'yes');
    const result = await runAgentLoop({
      config: proxied,
      messages: question,
      tools,
      catalog,
      hostTools,
      dispatch,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(results(result.messages)).toEqual([
      'ask_person is not in the catalogue; call it directly, not through call_tool.',
    ]);
    expect(result.toolCalls).toEqual([{ id: 'c0', name: 'ask_person', ok: false }]);
  });

  it('are left out of a proxied preselection, which writes only the catalogued tools', async () => {
    create.mockReturnValueOnce(says('done'));
    const result = await runAgentLoop({
      config: proxied,
      messages: question,
      tools: [...tools, ...hostTools],
      catalog,
      hostTools,
      preselected: ['ask_person', 's__read'],
      dispatch: async () => 'ok',
    });
    expect(result.preselected).toEqual(['s__read']);
    const exchange = result.messages[1] as OpenAI.ChatCompletionAssistantMessageParam;
    expect(exchange.tool_calls?.[0]).toMatchObject({ function: { arguments: '{"names":["s__read"]}' } });
    expect(result.metrics).toMatchObject({ toolsLoaded: 1 });
  });

  it('go beside the shortlist on a preselected first step', async () => {
    create.mockReturnValueOnce(says('done'));
    await runAgentLoop({
      config: onDemand,
      messages: question,
      tools,
      catalog,
      hostTools,
      preselected: ['s__read'],
      toolOrder: false,
      dispatch: async () => 'ok',
    });
    expect(declared()).toEqual([['s__read', 'ask_person']]);
  });

  it('are declared once where `tools` has one of the same name, or the host gave it twice', async () => {
    create.mockReturnValueOnce(says('done'));
    await runAgentLoop({
      config,
      messages: question,
      tools: [...tools, tool('ask_person')],
      hostTools: [tool('ask_person'), tool('ask_person')],
      dispatch: async () => 'ok',
    });
    expect(declared()).toEqual([['ask_person', 's__read', 's__write']]);
  });

  it('may be called when the model writes the call as text', async () => {
    create
      .mockReturnValueOnce(says('<tool_call>{"name":"ask_person","arguments":{}}</tool_call>'))
      .mockReturnValueOnce(says('done'));
    const dispatch = vi.fn(async () => 'yes');
    await runAgentLoop({ config, messages: question, hostTools, dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
