import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDiscovery } from '../../src/core/config.ts';
import { HookEvent } from '../../src/hooks/hook-events.ts';
import type { HookRunner } from '../../src/hooks/hooks.ts';
import { RunEventKind, RunOutcome } from '../../src/run/events.ts';
import { FinishReason, Role } from '../../src/wire/wire.ts';
import { type Create, chunks, config, type Message, pairsByPosition, says, tool } from '../helpers.ts';

const create = vi.fn<Create>();
/** Only the SDK-touching half is replaced; the rest of the client module is pure. */
vi.mock('../../src/endpoint/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/endpoint/client.ts')>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { runAgentLoop } = await import('../../src/run/agent-loop.ts');
const { oneCallPerMessage } = await import('../../src/run/run-calls.ts');
const { runMetrics, stamp } = await import('../../src/run/events.ts');
const { resetCapabilities } = await import('../../src/endpoint/capabilities.ts');
const { LOAD_TOOLS } = await import('../../src/tools/tool-loading.ts');
const { failedRun } = await import('../../src/run/failure.ts');

type ToolCallRequest = import('../../src/run/dispatch.ts').ToolCallRequest;
type RunEventInput = import('../../src/run/events.ts').RunEventInput;

/** A turn that asks for these calls, ids `c0` on, reporting `prompt` tokens where given. */
const calls = (list: [name: string, args: string][], prompt?: number) =>
  chunks(
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
    ...(prompt === undefined
      ? []
      : [{ choices: [], usage: { prompt_tokens: prompt, completion_tokens: 5, total_tokens: prompt + 5 } }]),
  );

const question: Message[] = [{ role: Role.User, content: 'hi' }];
const tools = [tool('s__read'), tool('s__write')];
const hostTools = [tool('ask_person')];
const bodies = () => create.mock.calls.map(([body]) => body);
/** The ids of an assistant message's calls, in the order the transcript holds them. */
const callIds = (message: Message | undefined) =>
  message?.role === Role.Assistant ? (message.tool_calls ?? []).map((call) => call.id) : [];
/** What the tool messages answer, in transcript order. */
const answered = (messages: Message[]) =>
  messages.flatMap((message) => (message.role === Role.Tool ? [message.tool_call_id] : []));
/** The tool message a host appends for a call it was handed. */
const answer = (id: string, content: string): Message => ({ role: Role.Tool, tool_call_id: id, content });

/** A dispatcher that answers every call with its tool's name. */
const named = () => vi.fn(async ({ name }: ToolCallRequest) => `${name} ran`);

beforeEach(() => create.mockReset());
afterEach(() => resetCapabilities());

describe('handBack', () => {
  it("runs the loop's own calls, then stops after the turn with the host's calls pending", async () => {
    create.mockReturnValueOnce(
      calls([
        ['s__read', '{"path":"a"}'],
        ['ask_person', '{"question":"which?"}'],
        ['s__write', '{"path":"b"}'],
      ]),
    );
    const dispatch = named();
    const events: RunEventInput[] = [];
    const result = await runAgentLoop({
      config,
      messages: question,
      tools,
      hostTools,
      handBack: true,
      dispatch,
      onEvent: (event) => events.push(event),
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls.map(([call]) => call.name)).toEqual(['s__read', 's__write']);
    expect(result.pending).toEqual([
      { id: 'c1', name: 'ask_person', args: { question: 'which?' }, raw: '{"question":"which?"}', repaired: false },
    ]);
    expect(result).not.toHaveProperty('ended');
    expect(result.metrics.outcome).toBe(RunOutcome.Waiting);
    // The handed-back call last, with no result: the loop's own two are answered in call order.
    expect(result.messages).toHaveLength(4);
    expect(callIds(result.messages[1])).toEqual(['c0', 'c2', 'c1']);
    expect(answered(result.messages)).toEqual(['c0', 'c2']);
    expect(result.toolCalls.map((call) => call.id)).toEqual(['c0', 'c2']);
    // Only what the loop dispatched: the handed-back call is the host's to run.
    expect(result.used).toEqual(['s__read', 's__write']);
    expect(result.turn.toolCalls.map((call) => call.id)).toEqual(['c0', 'c1', 'c2']);
  });

  it('tells the handed-back call as a `tool-call`, never a `tool-result`, then `wait`, and says nothing ended', async () => {
    create.mockReturnValueOnce(
      calls([
        ['ask_person', '{}'],
        ['s__read', '{}'],
      ]),
    );
    const events: RunEventInput[] = [];
    const heard: string[] = [];
    await runAgentLoop({
      config,
      messages: question,
      tools,
      hostTools,
      handBack: true,
      dispatch: named(),
      onEvent: (event) => events.push(event),
      onToolCall: (call) => heard.push(`call ${call.id}`),
      onToolResult: (result) => heard.push(`result ${result.id}`),
    });
    const told = events
      .filter((event) => event.kind !== RunEventKind.Notice && event.kind !== RunEventKind.Usage)
      .filter((event) => event.kind !== RunEventKind.Turn)
      .map((event) => `${event.kind} ${event.id ?? event.text}`);
    expect(told).toEqual([
      'tool-call c1',
      'tool-result c1',
      'tool-call c0',
      'wait waiting for the host to answer 1 call',
    ]);
    expect(heard).toEqual(['call c1', 'result c1', 'call c0']);
    const notices = events.filter((event) => event.kind === RunEventKind.Notice).map((event) => event.text);
    expect(notices.some((text) => text?.includes('ended the run'))).toBe(false);
  });

  it('takes a predicate, asked by the name and arguments a call would be dispatched with', async () => {
    create.mockReturnValueOnce(
      calls([
        ['s__write', '{"path":"keep"}'],
        ['s__write', '{"path":"secret"}'],
      ]),
    );
    const asked: ToolCallRequest[] = [];
    const result = await runAgentLoop({
      config,
      messages: question,
      tools,
      handBack: (call) => {
        asked.push(call);
        return call.args.path === 'secret';
      },
      dispatch: named(),
    });
    expect(asked.map((call) => call.args)).toEqual([{ path: 'keep' }, { path: 'secret' }]);
    expect(result.pending?.map((call) => call.id)).toEqual(['c1']);
  });

  it('answers a call whose arguments do not parse itself, rather than handing it back', async () => {
    create.mockReturnValueOnce(calls([['ask_person', '{not json']])).mockReturnValueOnce(says('fixed'));
    const handBack = vi.fn(() => true);
    const result = await runAgentLoop({ config, messages: question, hostTools, handBack, dispatch: named() });
    expect(handBack).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('pending');
    expect(result.turn.content).toBe('fixed');
  });

  it('is off by default: a host tool is dispatched and the transcript keeps the order asked', async () => {
    create
      .mockReturnValueOnce(
        calls([
          ['ask_person', '{}'],
          ['s__read', '{}'],
        ]),
      )
      .mockReturnValueOnce(says('done'));
    const dispatch = named();
    const events: RunEventInput[] = [];
    const result = await runAgentLoop({
      config,
      messages: question,
      tools,
      hostTools,
      dispatch,
      onEvent: (event) => events.push(event),
    });
    expect(dispatch.mock.calls.map(([call]) => call.name)).toEqual(['ask_person', 's__read']);
    expect(callIds(result.messages[1])).toEqual(['c0', 'c1']);
    expect(result).not.toHaveProperty('pending');
    expect(result.metrics.outcome).toBe(RunOutcome.Answered);
    expect(events.some((event) => event.kind === RunEventKind.Wait)).toBe(false);
  });

  it('waits in the last turn `maxToolIterations` allows, rather than throwing', async () => {
    create.mockReturnValueOnce(calls([['ask_person', '{}']]));
    const result = await runAgentLoop({
      config: { ...config, maxToolIterations: 1 },
      messages: question,
      hostTools,
      handBack: true,
      dispatch: named(),
    });
    expect(result.pending?.map((call) => call.name)).toEqual(['ask_person']);
  });

  it('keeps the scratchpads under `tool-loop`, and tells `afterTurn` nothing, until the run answers', async () => {
    create.mockReturnValueOnce(
      chunks({
        choices: [
          {
            delta: {
              reasoning_content: 'ask first',
              tool_calls: [{ index: 0, id: 'c0', function: { name: 'ask_person', arguments: '{}' } }],
            },
            finish_reason: FinishReason.ToolCalls,
          },
        ],
      }),
    );
    const run = vi.fn<HookRunner>(async () => []);
    const result = await runAgentLoop({
      config: { ...config, reasoningReplay: 'tool-loop' },
      messages: question,
      hostTools,
      handBack: true,
      dispatch: named(),
      hooks: { run, context: { session: { id: 's' } }, fire: [HookEvent.AfterTurn] },
    });
    expect(await result.afterTurn).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(result.messages[1]).toMatchObject({ reasoning_content: 'ask first' });
  });

  describe('beside the other options', () => {
    it('never puts a handed-back call to `parallel`, and runs the rest in their batches', async () => {
      create.mockReturnValueOnce(
        calls([
          ['s__read', '{}'],
          ['ask_person', '{}'],
          ['s__read', '{"again":true}'],
        ]),
      );
      const parallel = vi.fn((_call: ToolCallRequest) => true);
      let running = 0;
      let together = 0;
      const dispatch = vi.fn(async ({ name }: ToolCallRequest) => {
        running++;
        together = Math.max(together, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running--;
        return name;
      });
      const result = await runAgentLoop({
        config,
        messages: question,
        tools,
        hostTools,
        handBack: true,
        parallel,
        dispatch,
      });
      expect(parallel.mock.calls.map(([call]) => call.name)).toEqual(['s__read', 's__read']);
      expect(together).toBe(2);
      expect(result.pending?.map((call) => call.id)).toEqual(['c1']);
    });

    it('hands back each of two identical calls, and asks `dedupeToolCalls` of neither', async () => {
      create.mockReturnValueOnce(
        calls([
          ['ask_person', '{"q":1}'],
          ['ask_person', '{"q":1}'],
        ]),
      );
      const dedupeToolCalls = vi.fn(() => true);
      const result = await runAgentLoop({
        config,
        messages: question,
        hostTools,
        handBack: true,
        dedupeToolCalls,
        dispatch: named(),
      });
      expect(dedupeToolCalls).not.toHaveBeenCalled();
      expect(result.pending?.map((call) => call.id)).toEqual(['c0', 'c1']);
    });

    it('lets a call that ends the run win: the handed-back calls are answered as not run', async () => {
      create.mockReturnValueOnce(
        calls([
          ['ask_person', '{}'],
          ['s__write', '{}'],
        ]),
      );
      const dispatch = vi.fn(async ({ name }: ToolCallRequest) => ({
        text: `${name} ran`,
        end: { reason: 'handed off' },
      }));
      const events: RunEventInput[] = [];
      const result = await runAgentLoop({
        config,
        messages: question,
        tools,
        hostTools,
        handBack: true,
        dispatch,
        onEvent: (event) => events.push(event),
      });
      expect(dispatch.mock.calls.map(([call]) => call.name)).toEqual(['s__write']);
      expect(result.ended).toEqual({ callId: 'c1', name: 's__write', reason: 'handed off' });
      expect(result).not.toHaveProperty('pending');
      expect(result.metrics.outcome).toBe(RunOutcome.Ended);
      expect(answered(result.messages)).toEqual(['c1', 'c0']);
      expect(result.messages.at(-1)).toMatchObject({ content: 'Not run: the run ended first.' });
      expect(pairsByPosition(result.messages)).toBe(true);
      expect(events.some((event) => event.kind === RunEventKind.Wait)).toBe(false);
    });

    it('answers a handed-back call as not run where the run fails part-way, so the transcript stays sendable', async () => {
      create.mockReturnValueOnce(
        calls([
          ['s__read', '{}'],
          ['ask_person', '{}'],
        ]),
      );
      const stop = new AbortController();
      const failure = await runAgentLoop({
        config,
        messages: question,
        tools,
        hostTools,
        handBack: true,
        signal: stop.signal,
        dispatch: async () => {
          stop.abort();
          throw new Error('stopped');
        },
      }).catch((error: unknown) => error);
      const messages = failedRun(failure)?.messages ?? [];
      expect(answered(messages)).toEqual(['c0', 'c1']);
      expect(messages.at(-1)).toMatchObject({ content: 'Not run: the run stopped first.' });
    });

    it('writes the handed-back calls together after the pairs, for a model sent one call a message', async () => {
      create.mockReturnValueOnce(
        calls([
          ['ask_person', '{"n":1}'],
          ['s__read', '{}'],
          ['ask_person', '{"n":2}'],
        ]),
      );
      const written: Message[] = [];
      const result = await runAgentLoop({
        config: { ...config, singleCallMessages: true },
        messages: question,
        tools,
        hostTools,
        handBack: true,
        dispatch: named(),
        onMessage: (message) => {
          written.push(message);
        },
      });
      const added = result.messages.slice(1);
      expect(added.map((message) => [message.role, ...callIds(message)])).toEqual([
        [Role.Assistant, 'c1'],
        [Role.Tool],
        [Role.Assistant, 'c0', 'c2'],
      ]);
      expect(written).toEqual(added);
      // Answered in `pending` order, the request pairs each call with its answer by position.
      const resumed = [...result.messages, answer('c0', 'one'), answer('c2', 'two')];
      expect(pairsByPosition(oneCallPerMessage(resumed))).toBe(true);
    });
  });

  describe('resuming', () => {
    it('goes on from the transcript with the answers appended, carrying the ledger', async () => {
      create
        .mockReturnValueOnce(
          calls(
            [
              ['s__read', '{}'],
              ['ask_person', '{}'],
            ],
            100,
          ),
        )
        .mockReturnValueOnce(says('thanks'));
      const first = await runAgentLoop({
        config,
        messages: question,
        tools,
        hostTools,
        handBack: true,
        dispatch: named(),
      });
      expect(first.ledger).toEqual([{ through: 0, prompt: 100, epoch: 0 }]);

      const pendingIds = first.pending?.map((call) => call.id) ?? [];
      const answers = pendingIds.map((id) => answer(id, 'the blue one'));
      const windows: { used?: number; ledger: unknown }[] = [];
      const second = await runAgentLoop({
        config,
        messages: [...first.messages, ...answers],
        tools,
        hostTools,
        handBack: true,
        loaded: first.loaded,
        ledger: first.ledger,
        dispatch: named(),
        beforeTurn: (_messages, _turn, window) => {
          windows.push({ ...window, ledger: [...window.ledger] });
          return undefined;
        },
      });

      expect(second.turn.content).toBe('thanks');
      expect(second).not.toHaveProperty('pending');
      const sent = bodies()[1].messages;
      expect(sent.at(-1)).toEqual(answer('c1', 'the blue one'));
      expect(pairsByPosition(sent)).toBe(true);
      // The first run's entry is where it was, and the second's request is measured after it.
      expect(windows[0].ledger).toEqual(first.ledger);
      expect(second.ledger[0]).toEqual(first.ledger[0]);
      expect(second.ledger).toHaveLength(2);
      expect(second.ledger[1].through).toBe(3);
    });

    it('carries what was loaded on demand, so the resumed turn declares it', async () => {
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
      create
        .mockReturnValueOnce(calls([[LOAD_TOOLS, '{"names":["s__write"]}']]))
        .mockReturnValueOnce(calls([['ask_person', '{}']]))
        .mockReturnValueOnce(says('done'));
      const onDemand = { ...config, toolDiscovery: ToolDiscovery.OnDemand };
      const first = await runAgentLoop({
        config: onDemand,
        messages: question,
        tools,
        catalog,
        hostTools,
        handBack: true,
        dispatch: named(),
      });
      expect(first.loaded).toEqual(['s__write']);
      await runAgentLoop({
        config: onDemand,
        messages: [...first.messages, answer(first.pending?.[0]?.id ?? '', 'yes')],
        tools,
        catalog,
        hostTools,
        handBack: true,
        loaded: first.loaded,
        dispatch: named(),
      });
      const names = (bodies()[2].tools ?? []).map((t) => (t as OpenAI.ChatCompletionFunctionTool).function.name);
      expect(names).toContain('s__write');
    });
  });
});

describe('runMetrics', () => {
  const at = (kind: RunEventInput['kind'], seq: number) => stamp({ kind }, 'r', seq, seq);

  it('reads a run whose last stretch stopped on `wait` as waiting', () => {
    expect(runMetrics([at(RunEventKind.Turn, 1), at(RunEventKind.Wait, 2)]).outcome).toBe(RunOutcome.Waiting);
  });

  it('reads a run that went on after its `wait` as not done, and by its `done` once it is', () => {
    const resumed = [at(RunEventKind.Turn, 1), at(RunEventKind.Wait, 2), at(RunEventKind.Turn, 3)];
    expect(runMetrics(resumed).outcome).toBeUndefined();
    expect(runMetrics([...resumed, at(RunEventKind.Done, 4)]).outcome).toBe(RunOutcome.Answered);
  });
});
