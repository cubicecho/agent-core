import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDiscovery } from '../../src/core/config.ts';
import { RunEventKind } from '../../src/run/events.ts';
import { FinishReason, Role } from '../../src/wire/wire.ts';
import { apiError, type Body, chunks, config, type Message, says, text, tool } from '../helpers.ts';

const create = vi.fn();
/** Only the SDK-touching half is replaced; the rest of the client module is pure. */
vi.mock('../../src/endpoint/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/endpoint/client.ts')>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { runAgentLoop } = await import('../../src/run/agent-loop.ts');
const { AgentLoopError, AgentLoopOverflow, failedRun, ToolIterationLimit } = await import('../../src/wire/errors.ts');
const { ContextOverflow } = await import('../../src/wire/retry.ts');
const { resetCapabilities } = await import('../../src/endpoint/capabilities.ts');
const { CALL_TOOL, LOAD_TOOLS } = await import('../../src/tools/tool-loading.ts');

type Turn = import('../../src/wire/stream.ts').Turn;
type ToolCallRequest = import('../../src/wire/tool-calls.ts').ToolCallRequest;

/** A turn that asks for these calls, thinking first where told to, and reports what it cost. */
const calls = (list: [name: string, args: string][], reasoning = '') =>
  chunks(
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
          finish_reason: FinishReason.ToolCalls,
        },
      ],
    },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  );

const question: Message[] = [{ role: Role.User, content: 'hi' }];
/** A transcript as role and content, with a tool result's call id in front. */
const outline = (messages: Message[]) =>
  messages.map((message) =>
    message.role === Role.Tool
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
      if (message.role === Role.Tool) {
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
    const refused = apiError(401, 'no such key');
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
    expect(overflow.messages.map((message) => message.role)).toEqual([Role.User, Role.Assistant, Role.Tool]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('says what was loaded and used when it failed', async () => {
    const catalog = [{ id: 's', label: 'S', tools: [{ name: 's__read', description: 'reads' }] }];
    create
      .mockReturnValueOnce(calls([[LOAD_TOOLS, '{"names":["s__read"]}']]))
      .mockReturnValueOnce(calls([['s__read', '{}']]))
      .mockRejectedValueOnce(apiError(401, 'no such key'));
    const error = await thrown(
      runAgentLoop({
        config: { ...config, toolDiscovery: ToolDiscovery.OnDemand },
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
    const down = apiError(401, 'no such key');
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

/** A stream that hands over its chunks and then waits for the stop, ending as an aborted one does. */
const stalls = (signal: AbortSignal, ...list: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* list;
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        return resolve();
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
});

/** A stream that hands over its chunks and then breaks, as a dropped connection does. */
const breaks = (...list: unknown[]) => breaksWith(new Error('the connection dropped'), ...list);

/** A stream that hands over its chunks and then throws this. */
const breaksWith = (error: unknown, ...list: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* list;
    throw error;
  },
});

describe('the request in flight', () => {
  it('is kept on a stop mid-stream, with its reasoning, and not in the transcript', async () => {
    const controller = new AbortController();
    create.mockImplementationOnce((_body: Body, { signal }: { signal: AbortSignal }) =>
      stalls(
        signal,
        { choices: [{ delta: { reasoning_content: 'sky, light' } }] },
        { choices: [{ delta: { content: 'The sky is ' } }] },
        {
          choices: [{ delta: { content: 'blue because' } }],
        },
      ),
    );
    const error = await thrown(
      runAgentLoop({
        config,
        messages: question,
        dispatch: async () => '',
        signal: controller.signal,
        onEvent: (event) => {
          if (event.kind === RunEventKind.Output && event.text?.includes('because')) {
            controller.abort();
          }
        },
      }),
    );
    const run = failedRun(error);
    expect(run?.partial).toEqual({ content: 'The sky is blue because', reasoning: 'sky, light' });
    expect(run?.messages).toEqual(question);
  });

  it('has no partial where the request failed before its first token', async () => {
    create.mockReturnValueOnce(breaks({ choices: [{ delta: { role: Role.Assistant } }] }));
    const error = await thrown(runAgentLoop({ config, messages: question, dispatch: async () => '' }));
    expect(failedRun(error)).toBeDefined();
    expect(failedRun(error)?.partial).toBeUndefined();
  });

  it('keeps the calls a broken stream had begun, as they were assembled', async () => {
    create.mockReturnValueOnce(
      breaks({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'a', arguments: '{"x":' } }] } }],
      }),
    );
    const error = await thrown(
      runAgentLoop({ config, messages: question, tools: [tool('a')], dispatch: async () => '' }),
    );
    expect(failedRun(error)?.partial).toEqual({
      content: '',
      toolCalls: [{ id: 'c0', type: 'function', function: { name: 'a', arguments: '{"x":' } }],
    });
  });

  it("reads the latest attempt's reply after a retry", async () => {
    create
      .mockReturnValueOnce(breaksWith(apiError(503, 'busy'), { choices: [{ delta: { role: Role.Assistant } }] }))
      .mockReturnValueOnce(breaks(text('second')));
    const error = await thrown(
      runAgentLoop({ config: { ...config, maxRetries: 1 }, messages: question, dispatch: async () => '' }),
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(failedRun(error)?.partial).toEqual({ content: 'second' });
  });

  it('joins a continuation in flight onto the answer it was continuing', async () => {
    const controller = new AbortController();
    create
      .mockReturnValueOnce(says('The sky is', FinishReason.Length))
      .mockImplementationOnce((_body: Body, { signal }: { signal: AbortSignal }) => {
        queueMicrotask(() => controller.abort());
        return stalls(signal, text(' blue'));
      });
    const error = await thrown(
      runAgentLoop({
        config,
        messages: question,
        dispatch: async () => '',
        maxContinuations: 1,
        signal: controller.signal,
      }),
    );
    expect(failedRun(error)?.partial).toEqual({ content: 'The sky is blue' });
  });

  it('is gone once its turn is in the transcript', async () => {
    create.mockReturnValueOnce(calls([['a', '{}']]));
    const error = await thrown(
      runAgentLoop({
        config,
        messages: question,
        tools: [tool('a')],
        dispatch: async () => 'ok',
        onMessage: (message) => {
          if (message.role === Role.Tool) {
            throw new Error('the host fell over');
          }
        },
      }),
    );
    expect((error as Error).message).toBe('the host fell over');
    expect(failedRun(error)?.messages.map((message) => message.role)).toContain(Role.Assistant);
    expect(failedRun(error)?.partial).toBeUndefined();
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
      messages: [...kept, { role: Role.User, content: 'go on' }],
      tools: [tool('a'), tool('b')],
      dispatch: async () => '',
    });
    const replayed = (create.mock.calls[1][0] as Body).messages;
    const asked = replayed.flatMap((message) =>
      message.role === Role.Assistant ? (message.tool_calls ?? []).map((call) => call.id) : [],
    );
    const answered = replayed.flatMap((message) => (message.role === Role.Tool ? [message.tool_call_id] : []));
    expect(answered).toEqual(asked);
  });
});

describe('a proxied run', () => {
  const catalog = [{ id: 's', label: 'S', tools: [{ name: 's__read', description: 'reads' }] }];
  const proxied = { ...config, toolDiscovery: ToolDiscovery.Proxy };

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
    expect(heard.map(({ message }) => message.role)).toEqual([Role.Assistant, Role.Tool, Role.Assistant]);
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
    expect(failure.messages.map((message) => message.role)).toEqual([Role.User, Role.Assistant, Role.Tool]);
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

describe('prune', () => {
  /** Four thousand characters, a thousand tokens at the default ratio. */
  const long = 'x'.repeat(4000);
  /** Every request's messages, as they were sent. */
  const sentMessages = () => create.mock.calls.map(([body]) => (body as Body).messages.map((m) => JSON.stringify(m)));
  /** A run of `steps` calls, each answered with a long result, then an answer. */
  const toolRun = (steps: number) => {
    for (let step = 0; step < steps; step++) {
      create.mockReturnValueOnce(calls([['read', '{}']]));
    }
    create.mockReturnValueOnce(says('done'));
  };

  it('keeps each request an extension of the last until the boundary moves, and says each move', async () => {
    toolRun(7);
    const notices: string[] = [];
    const result = await runAgentLoop({
      config: { ...config, maxToolIterations: 10, contextLength: 10_000 },
      messages: question,
      tools: [tool('read')],
      dispatch: async () => long,
      // Two results are worth a move and one is not, and the window need not be filling.
      prune: { at: 0, minShare: 0.19, keepLast: 2 },
      onEvent: (event) => {
        if (event.kind === RunEventKind.Notice) {
          notices.push(event.text ?? '');
        }
      },
    });
    const sent = sentMessages();
    const extensions = sent.slice(1).map((request, index) => {
      const previous = sent[index];
      return request.slice(0, previous.length).every((message, at) => message === previous[at]);
    });
    // Moves before the fifth and seventh requests, each clearing the two results behind the kept two.
    expect(extensions).toEqual([true, true, true, false, true, false, true]);
    expect(notices.filter((text) => text.startsWith('cleared'))).toEqual([
      expect.stringMatching(/^cleared 2 old tool results \(~\d[\d,]* tokens\) as the window filled$/),
      expect.stringMatching(/^cleared 2 old tool results \(~\d[\d,]* tokens\) as the window filled$/),
    ]);
    // The stubs are in what the run hands back, as a fold would be.
    const cleared = result.messages.filter((m) => m.role === Role.Tool && String(m.content).startsWith('[result'));
    expect(cleared).toHaveLength(4);
  });

  it('prunes nothing without a window, and nothing when it is off', async () => {
    toolRun(7);
    await runAgentLoop({
      config: { ...config, maxToolIterations: 10 },
      messages: question,
      tools: [tool('read')],
      dispatch: async () => long,
      prune: { at: 0, minShare: 0 },
    });
    toolRun(7);
    await runAgentLoop({
      config: { ...config, maxToolIterations: 10, contextLength: 10_000 },
      messages: question,
      tools: [tool('read')],
      dispatch: async () => long,
    });
    expect(
      sentMessages()
        .flat()
        .some((message) => message.includes('[result cleared')),
    ).toBe(false);
  });

  it('runs after `beforeStep`, on what that returned, and starts the boundary again after a rewrite', async () => {
    toolRun(3);
    const handed: number[] = [];
    await runAgentLoop({
      config: { ...config, maxToolIterations: 10, contextLength: 10_000 },
      messages: question,
      tools: [tool('read')],
      dispatch: async () => long,
      prune: { at: 0, minShare: 0, keepLast: 1 },
      beforeStep: (messages) => {
        handed.push(messages.filter((m) => String(m.content).startsWith('[result')).length);
        return [...messages];
      },
    });
    // The first move is on the third step, after its `beforeStep`; the fourth is handed its stub.
    expect(handed).toEqual([0, 0, 0, 1]);
  });
});
