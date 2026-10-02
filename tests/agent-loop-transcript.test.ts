import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
/** Only the SDK-touching half is replaced; the rest of the client module is pure. */
vi.mock('../src/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client.ts')>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { runAgentLoop } = await import('../src/agent-loop.ts');
const { AgentLoopError, AgentLoopOverflow, failedRun, ToolIterationLimit } = await import('../src/errors.ts');
const { ContextOverflow } = await import('../src/retry.ts');
const { resetCapabilities } = await import('../src/capabilities.ts');
const { CALL_TOOL, LOAD_TOOLS } = await import('../src/tool-loading.ts');

type Message = OpenAI.ChatCompletionMessageParam;
type Turn = import('../src/stream.ts').Turn;
type ToolCallRequest = import('../src/tool-calls.ts').ToolCallRequest;
type Body = OpenAI.ChatCompletionCreateParamsStreaming;

const stream = (...list: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* list as OpenAI.ChatCompletionChunk[];
  },
});
/** A turn that answers in words. */
const says = (content: string) =>
  stream(
    { choices: [{ delta: { content } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  );
/** A turn that asks for these calls, thinking first where told to, and reports what it cost. */
const calls = (list: [name: string, args: string][], reasoning = '') =>
  stream(
    ...(reasoning ? [{ choices: [{ delta: { reasoning_content: reasoning } }] }] : []),
    {
      choices: [
        {
          delta: {
            tool_calls: list.map(([name, args], index) => ({
              index,
              id: `c${index}`,
              function: { name, arguments: args },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  );

const tool = (name: string): OpenAI.ChatCompletionTool => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
});

const config = {
  baseUrl: 'http://local/v1',
  apiKey: '',
  model: 'm',
  maxTokens: 100,
  temperature: 0.2,
  maxToolIterations: 4,
};
const question: Message[] = [{ role: 'user', content: 'hi' }];
/** A transcript as role and content, with a tool result's call id in front. */
const outline = (messages: Message[]) =>
  messages.map((message) =>
    message.role === 'tool'
      ? `tool ${message.tool_call_id}: ${String(message.content)}`
      : `${message.role}: ${String(message.content)}`,
  );
/** What a run rejected with, or a failure if it did not reject. */
const thrown = async (run: Promise<unknown>): Promise<unknown> => {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('the run did not throw');
};

beforeEach(() => create.mockReset());
afterEach(() => resetCapabilities());

describe('onMessage', () => {
  it("hears each message in transcript order, the assistant's with its turn", async () => {
    create
      .mockReturnValueOnce(
        calls(
          [
            ['a', "{'x': 1}"],
            ['b', '{}'],
          ],
          'hmm',
        ),
      )
      .mockReturnValueOnce(says('done'));
    const heard: { message: Message; step: number; turn?: Turn }[] = [];
    const result = await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a'), tool('b')],
      dispatch: async ({ name }) => `${name} ran`,
      onMessage: (message, step, turn) => {
        heard.push({ message, step, turn });
      },
    });
    // Everything the run added, and nothing it was handed.
    expect(heard.map((entry) => entry.message)).toEqual(result.messages.slice(1));
    expect(heard.map((entry) => entry.step)).toEqual([0, 0, 0, 1]);
    expect(outline(heard.map((entry) => entry.message))).toEqual([
      'assistant: null',
      'tool c0: a ran',
      'tool c1: b ran',
      'assistant: done',
    ]);
    // The message as it is replayed, not as the model wrote it.
    expect(JSON.stringify(heard[0].message)).toContain('"arguments":"{\\"x\\":1}"');
    expect(heard[0].turn?.reasoning).toBe('hmm');
    expect(heard[0].turn?.toolCalls).toHaveLength(2);
    expect(heard[1].turn).toBeUndefined();
    expect(heard[2].turn).toBeUndefined();
    expect(heard[3].turn).toBe(result.turn);
  });

  it('is awaited before the tools run and before the next request is sent', async () => {
    create
      .mockImplementationOnce(() => {
        order.push('request');
        return calls([['a', '{}']]);
      })
      .mockImplementationOnce(() => {
        order.push('request');
        return says('done');
      });
    const order: string[] = [];
    await runAgentLoop({
      config,
      messages: question,
      tools: [tool('a')],
      dispatch: async () => {
        order.push('dispatch');
        return 'ok';
      },
      onMessage: async (message) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`stored ${message.role}`);
      },
    });
    expect(order).toEqual(['request', 'stored assistant', 'dispatch', 'stored tool', 'request', 'stored assistant']);
  });

  it('ends the run when it throws, with the transcript whole and without being asked again', async () => {
    create.mockReturnValueOnce(
      calls([
        ['a', '{}'],
        ['a', '{"n":2}'],
      ]),
    );
    const full = new Error('disk full');
    const onMessage = vi.fn(async (message: Message) => {
      if (message.role === 'tool') {
        throw full;
      }
    });
    const error = await thrown(
      runAgentLoop({
        config,
        messages: question,
        tools: [tool('a')],
        dispatch: async () => 'ok',
        onMessage,
      }),
    );
    expect(error).toBeInstanceOf(AgentLoopError);
    expect((error as Error).cause).toBe(full);
    // The assistant message and the result that could not be stored; the second call's is not
    // offered to a host that has just failed to take one.
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(outline(failedRun(error)?.messages ?? [])).toEqual([
      'user: hi',
      'assistant: null',
      'tool c0: ok',
      'tool c1: Not run: the run stopped first.',
    ]);
  });
});

describe('a run that throws', () => {
  it('names a spent tool budget, and carries the run as it stood', async () => {
    create.mockImplementation(() => calls([['a', '{}']]));
    const error = await thrown(
      runAgentLoop({
        config: { ...config, maxToolIterations: 2 },
        messages: question,
        tools: [tool('a')],
        dispatch: async () => 'ok',
      }),
    );
    expect(error).toBeInstanceOf(ToolIterationLimit);
    expect(error).toBeInstanceOf(AgentLoopError);
    const limit = error as InstanceType<typeof ToolIterationLimit>;
    expect(limit.name).toBe('ToolIterationLimit');
    expect(limit.message).toBe('Stopped after 2 tool iterations.');
    expect(limit.cause).toBeUndefined();
    expect(outline(limit.messages)).toEqual([
      'user: hi',
      'assistant: null',
      'tool c0: ok',
      'assistant: null',
      'tool c0: ok',
    ]);
    expect(limit.usage).toEqual({ prompt: 20, completion: 4, total: 24, cached: 0 });
    expect(limit.toolCalls).toEqual([
      { id: 'c0', name: 'a', ok: true },
      { id: 'c0', name: 'a', ok: true },
    ]);
    expect(limit.used).toEqual(['a']);
    expect(limit.loaded).toEqual([]);
    expect(question).toHaveLength(1);
  });

  it('wraps what a request threw, keeping its message and the steps before it', async () => {
    const refused = Object.assign(new Error('401 no such key'), { status: 401 });
    create.mockReturnValueOnce(calls([['a', '{}']])).mockRejectedValueOnce(refused);
    const error = await thrown(
      runAgentLoop({
        config,
        messages: question,
        tools: [tool('a')],
        dispatch: async () => 'ok',
      }),
    );
    expect(error).toBeInstanceOf(AgentLoopError);
    expect(error).not.toBeInstanceOf(ToolIterationLimit);
    const failure = error as InstanceType<typeof AgentLoopError>;
    expect(failure.name).toBe('AgentLoopError');
    expect(failure.message).toBe('401 no such key');
    expect(failure.cause).toBe(refused);
    expect(outline(failure.messages)).toEqual(['user: hi', 'assistant: null', 'tool c0: ok']);
    expect(failure.usage).toEqual({ prompt: 10, completion: 2, total: 12, cached: 0 });
    expect(failure.toolCalls).toEqual([{ id: 'c0', name: 'a', ok: true }]);
  });

  it('keeps an overflow a ContextOverflow, with the run on it', async () => {
    create.mockReturnValueOnce(calls([['a', '{}']]));
    const error = await thrown(
      runAgentLoop({
        config: { ...config, contextLength: 8192 },
        messages: question,
        tools: [tool('a')],
        // Bigger than the window, so the second request is refused before it is sent.
        dispatch: async () => 'x'.repeat(100_000),
      }),
    );
    expect(error).toBeInstanceOf(ContextOverflow);
    expect(error).toBeInstanceOf(AgentLoopOverflow);
    expect(error).not.toBeInstanceOf(AgentLoopError);
    const overflow = error as InstanceType<typeof AgentLoopOverflow>;
    expect(overflow.name).toBe('ContextOverflow');
    expect(overflow.cause).toBeInstanceOf(ContextOverflow);
    expect(overflow.message).toBe((overflow.cause as Error).message);
    expect(failedRun(error)).toBe(error);
    expect(overflow.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('says what was loaded and used when it failed', async () => {
    const catalog = [{ id: 's', label: 'S', tools: [{ name: 's__read', description: 'reads' }] }];
    create
      .mockReturnValueOnce(calls([[LOAD_TOOLS, '{"names":["s__read"]}']]))
      .mockReturnValueOnce(calls([['s__read', '{}']]))
      .mockRejectedValueOnce(Object.assign(new Error('401 no such key'), { status: 401 }));
    const error = await thrown(
      runAgentLoop({
        config: { ...config, toolDiscovery: 'ondemand' as const },
        messages: question,
        tools: [tool('s__read')],
        catalog,
        dispatch: async () => 'contents',
      }),
    );
    expect(failedRun(error)?.loaded).toEqual(['s__read']);
    expect(failedRun(error)?.used).toEqual(['s__read']);
    expect(failedRun(error)?.toolCalls).toEqual([
      { id: 'c0', name: LOAD_TOOLS, ok: true },
      { id: 'c0', name: 's__read', ok: true },
    ]);
  });

  it('hands back the transcript it was given when it fails before the first reply', async () => {
    const down = Object.assign(new Error('401 no such key'), { status: 401 });
    create.mockRejectedValueOnce(down);
    const error = await thrown(runAgentLoop({ config, messages: question, dispatch: async () => '' }));
    const run = failedRun(error);
    expect(run?.messages).toEqual(question);
    expect(run?.messages).not.toBe(question);
    expect(run?.usage).toEqual({ prompt: 0, completion: 0, total: 0, cached: 0 });
  });

  it('reads no run off an error the loop did not throw', () => {
    expect(failedRun(new Error('something else'))).toBeUndefined();
    expect(failedRun(new ContextOverflow('too big'))).toBeUndefined();
    expect(failedRun(undefined)).toBeUndefined();
  });
});

describe('a stop while the tools run', () => {
  it('keeps the results that came back and answers the rest, one after another', async () => {
    const controller = new AbortController();
    create.mockReturnValueOnce(
      calls([
        ['a', '{}'],
        ['b', '{}'],
        ['c', '{}'],
      ]),
    );
    const stopped = new Error('b was stopped');
    const dispatch = vi.fn(async ({ name }: ToolCallRequest) => {
      if (name !== 'b') {
        return `${name} ran`;
      }
      controller.abort();
      throw stopped;
    });
    const heard: Message[] = [];
    const error = await thrown(
      runAgentLoop({
        config,
        messages: question,
        tools: [tool('a'), tool('b'), tool('c')],
        dispatch,
        signal: controller.signal,
        onMessage: (message) => {
          heard.push(message);
        },
      }),
    );
    expect(error).toBeInstanceOf(AgentLoopError);
    const failure = error as InstanceType<typeof AgentLoopError>;
    expect(failure.cause).toBe(stopped);
    expect(controller.signal.aborted).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(outline(failure.messages)).toEqual([
      'user: hi',
      'assistant: null',
      'tool c0: a ran',
      'tool c1: Stopped before this call finished.',
      'tool c2: Not run: the run stopped first.',
    ]);
    // Announced like any other, so a host that stores per message stores a transcript that can
    // be replayed.
    expect(heard).toEqual(failure.messages.slice(1));
    // The call that never ran was never made.
    expect(failure.toolCalls).toEqual([
      { id: 'c0', name: 'a', ok: true },
      { id: 'c1', name: 'b', ok: false },
    ]);
    expect(failure.used).toEqual(['a', 'b']);
  });

  it('keeps what finished when the calls run together', async () => {
    const controller = new AbortController();
    create.mockReturnValueOnce(
      calls([
        ['a', '{}'],
        ['b', '{}'],
        ['c', '{}'],
      ]),
    );
    const dispatch = async ({ name }: ToolCallRequest, signal?: AbortSignal) => {
      if (name === 'a') {
        return 'a ran';
      }
      if (name === 'b') {
        // After `a` has come back, and with `c` still out.
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.abort();
        return signal?.throwIfAborted() ?? '';
      }
      return new Promise<string>(() => {});
    };
    const error = await thrown(
      runAgentLoop({
        config,
        messages: question,
        tools: [tool('a'), tool('b'), tool('c')],
        dispatch,
        parallel: true,
        signal: controller.signal,
      }),
    );
    expect(error).toBeInstanceOf(AgentLoopError);
    const failure = error as InstanceType<typeof AgentLoopError>;
    // What the signal was aborted with is still what the host can reach.
    expect(failure.cause).toBe(controller.signal.reason);
    expect(outline(failure.messages)).toEqual([
      'user: hi',
      'assistant: null',
      'tool c0: a ran',
      'tool c1: Stopped before this call finished.',
      'tool c2: Stopped before this call finished.',
    ]);
    expect(failure.toolCalls).toEqual([
      { id: 'c0', name: 'a', ok: true },
      { id: 'c1', name: 'b', ok: false },
      { id: 'c2', name: 'c', ok: false },
    ]);
  });

  it('answers the calls it never got to when stopped between two', async () => {
    const controller = new AbortController();
    create.mockReturnValueOnce(
      calls([
        ['a', '{}'],
        ['a', '{"n":2}'],
      ]),
    );
    const error = await thrown(
      runAgentLoop({
        config,
        messages: question,
        tools: [tool('a')],
        dispatch: async () => {
          controller.abort();
          return 'ok';
        },
        signal: controller.signal,
      }),
    );
    expect((error as Error).cause).toBe(controller.signal.reason);
    expect(outline(failedRun(error)?.messages ?? [])).toEqual([
      'user: hi',
      'assistant: null',
      'tool c0: ok',
      'tool c1: Not run: the run stopped first.',
    ]);
    expect(failedRun(error)?.toolCalls).toEqual([{ id: 'c0', name: 'a', ok: true }]);
  });

  it('sends a transcript the next request can replay', async () => {
    const controller = new AbortController();
    create
      .mockReturnValueOnce(
        calls([
          ['a', '{}'],
          ['b', '{}'],
        ]),
      )
      .mockReturnValueOnce(says('picked up'));
    const error = await thrown(
      runAgentLoop({
        config,
        messages: question,
        tools: [tool('a'), tool('b')],
        dispatch: async () => {
          controller.abort();
          throw new Error('stopped');
        },
        signal: controller.signal,
      }),
    );
    const kept = failedRun(error)?.messages ?? [];
    await runAgentLoop({
      config,
      messages: [...kept, { role: 'user', content: 'go on' }],
      tools: [tool('a'), tool('b')],
      dispatch: async () => '',
    });
    const replayed = (create.mock.calls[1][0] as Body).messages;
    const asked = replayed.flatMap((message) =>
      message.role === 'assistant' ? (message.tool_calls ?? []).map((call) => call.id) : [],
    );
    const answered = replayed.flatMap((message) => (message.role === 'tool' ? [message.tool_call_id] : []));
    expect(answered).toEqual(asked);
  });
});

describe('a proxied run', () => {
  const catalog = [{ id: 's', label: 'S', tools: [{ name: 's__read', description: 'reads' }] }];
  const proxied = { ...config, toolDiscovery: 'proxy' as const };

  it('tells onMessage of the load it writes for a preselection, before any request', async () => {
    create.mockReturnValueOnce(says('done'));
    const heard: { message: Message; step: number; turn?: Turn; sent: number }[] = [];
    const result = await runAgentLoop({
      config: proxied,
      messages: question,
      tools: [tool('s__read')],
      catalog,
      preselected: ['s__read'],
      dispatch: async () => 'contents',
      onMessage: (message, step, turn) => {
        heard.push({ message, step, turn, sent: create.mock.calls.length });
      },
    });
    expect(heard.map(({ message }) => message)).toEqual(result.messages.slice(1));
    expect(heard.map(({ message }) => message.role)).toEqual(['assistant', 'tool', 'assistant']);
    // The pair no model wrote: step zero's, with no turn, and heard before the request went out.
    expect(heard.slice(0, 2).map(({ step, turn, sent }) => ({ step, turn, sent }))).toEqual([
      { step: 0, turn: undefined, sent: 0 },
      { step: 0, turn: undefined, sent: 0 },
    ]);
    expect(heard[2].turn?.content).toBe('done');
  });

  it("leaves the preselection's call with its result when onMessage throws on it", async () => {
    const refused = new Error('the store is down');
    const error = await thrown(
      runAgentLoop({
        config: proxied,
        messages: question,
        tools: [tool('s__read')],
        catalog,
        preselected: ['s__read'],
        dispatch: async () => 'contents',
        onMessage: () => {
          throw refused;
        },
      }),
    );
    expect(error).toBeInstanceOf(AgentLoopError);
    const failure = error as InstanceType<typeof AgentLoopError>;
    expect(failure.cause).toBe(refused);
    expect(failure.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(failure.toolCalls).toEqual([{ id: 'preselect-1', name: LOAD_TOOLS, ok: true }]);
    // As a result says it: proxied, the definitions are in the history and nothing is carried.
    expect(failure.loaded).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('counts a `call_tool` the run was stopped during as the tool it names', async () => {
    const controller = new AbortController();
    create.mockReturnValueOnce(calls([[CALL_TOOL, '{"name":"s__read","arguments":{"path":"a"}}']]));
    const stopped = new Error('stopped');
    const error = await thrown(
      runAgentLoop({
        config: proxied,
        messages: question,
        tools: [tool('s__read')],
        catalog,
        dispatch: async () => {
          controller.abort();
          throw stopped;
        },
        signal: controller.signal,
      }),
    );
    const failure = failedRun(error);
    expect(failure?.toolCalls).toEqual([{ id: 'c0', name: 's__read', ok: false }]);
    expect(outline(failure?.messages ?? [])).toEqual([
      'user: hi',
      'assistant: null',
      'tool c0: Stopped before this call finished.',
    ]);
  });
});
