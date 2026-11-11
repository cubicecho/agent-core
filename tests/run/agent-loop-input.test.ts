import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookEvent } from '../../src/hooks/hook-events.ts';
import type { HookRunner } from '../../src/hooks/hooks.ts';
import { RunEventKind } from '../../src/run/events.ts';
import { FinishReason, Role } from '../../src/wire/wire.ts';
import { type Body, chunks, config, type Message, outcome, says, tool, user } from '../helpers.ts';

const create = vi.fn();
/** Only the SDK-touching half is replaced; the rest of the client module is pure. */
vi.mock('../../src/endpoint/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/endpoint/client.ts')>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { runAgentLoop } = await import('../../src/run/agent-loop.ts');
const { resetCapabilities } = await import('../../src/endpoint/capabilities.ts');

/** A turn that asks for one call of `name`, with no arguments. */
const calls = (name: string) =>
  chunks(
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: 'c0', function: { name, arguments: '{}' } }] },
          finish_reason: FinishReason.ToolCalls,
        },
      ],
    },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  );

/** A transcript as role and content. */
const outline = (messages: readonly Message[]) =>
  messages.map((message) => `${message.role}: ${String(message.content)}`);

/** The messages the request at `at` sent, the system prompt left out. */
const sent = (at: number) =>
  outline((create.mock.calls[at][0] as Body).messages.filter((message) => message.role !== Role.System));

/** A `takeInput` that hands over `text` on its `on`th ask, counting from one, and nothing otherwise. */
const inputOn = (on: number, text: string) => {
  let asked = 0;
  return vi.fn((): OpenAI.ChatCompletionUserMessageParam | undefined => {
    asked++;
    return asked === on ? { role: Role.User, content: text } : undefined;
  });
};

beforeEach(() => create.mockReset());
afterEach(() => resetCapabilities());

describe('takeInput', () => {
  it("goes on with input once the step's calls have answered, before the next request", async () => {
    create.mockReturnValueOnce(calls('a')).mockReturnValueOnce(says('done'));
    const heard: { message: Message; step: number }[] = [];
    const events: string[] = [];
    const result = await runAgentLoop({
      config,
      messages: [user('hi')],
      tools: [tool('a')],
      dispatch: async () => 'a ran',
      // The first ask is before the first request; the second is once `a` has answered.
      takeInput: inputOn(2, 'use b instead'),
      onMessage: (message, step) => {
        heard.push({ message, step });
      },
      onEvent: (event) => {
        if (event.kind === RunEventKind.Input) {
          events.push(event.text ?? '');
        }
      },
    });
    expect(sent(1)).toEqual(['user: hi', 'assistant: null', 'tool: a ran', 'user: use b instead']);
    expect(outline(result.messages)).toEqual([...sent(1), 'assistant: done']);
    expect(heard.map(({ message, step }) => `${step} ${message.role}`)).toEqual([
      '0 assistant',
      '0 tool',
      '1 user',
      '1 assistant',
    ]);
    expect(events).toEqual(['use b instead']);
  });

  it('sends input that arrived before the first request with it', async () => {
    create.mockReturnValueOnce(says('done'));
    await runAgentLoop({ config, messages: [user('hi')], dispatch: async () => '', takeInput: inputOn(1, 'and bye') });
    expect(sent(0)).toEqual(['user: hi', 'user: and bye']);
  });

  it('answers input written while the model was answering, in another step', async () => {
    create.mockReturnValueOnce(says('first')).mockReturnValueOnce(says('second'));
    const takeInput = inputOn(2, 'one more thing');
    const result = await runAgentLoop({ config, messages: [user('hi')], dispatch: async () => '', takeInput });
    expect(sent(1)).toEqual(['user: hi', 'assistant: first', 'user: one more thing']);
    expect(result.turn.content).toBe('second');
    expect(outline(result.messages)).toEqual([...sent(1), 'assistant: second']);
    // At the top of each step, and after each answer.
    expect(takeInput).toHaveBeenCalledTimes(4);
  });

  it('leaves input to the host where no step is left to answer it in', async () => {
    create.mockReturnValueOnce(says('done'));
    const takeInput = vi.fn(() => undefined);
    const result = await runAgentLoop({
      config: { ...config, maxToolIterations: 1 },
      messages: [user('hi')],
      dispatch: async () => '',
      takeInput,
    });
    expect(result.turn.content).toBe('done');
    expect(takeInput).toHaveBeenCalledTimes(1);
  });

  it('is not asked after a call that ended the run', async () => {
    create.mockReturnValueOnce(calls('hand_off'));
    const takeInput = vi.fn(() => undefined);
    const result = await runAgentLoop({
      config,
      messages: [user('hi')],
      tools: [tool('hand_off')],
      dispatch: async () => ({ text: 'handed off', end: true }),
      takeInput,
    });
    expect(result.ended?.name).toBe('hand_off');
    expect(takeInput).toHaveBeenCalledTimes(1);
  });

  it('keeps the hooks on the question where a host rebuilds the transcript each step', async () => {
    create.mockReturnValueOnce(calls('a')).mockReturnValueOnce(says('done'));
    const run = vi.fn<HookRunner>(async (event) =>
      event === HookEvent.BeforeTurn ? [outcome({ event, text: 'you like tea', inject: true, maxTokens: 500 })] : [],
    );
    await runAgentLoop({
      config,
      messages: [user('hi')],
      tools: [tool('a')],
      dispatch: async () => 'a ran',
      takeInput: inputOn(2, 'use b instead'),
      // New message objects every step, as a host reading its store would hand back.
      beforeStep: (messages) => messages.map((message) => ({ ...message }) as Message),
      hooks: { run, context: { session: { id: 's1' } } },
    });
    const [question, , , input] = sent(1);
    expect(question).toContain('you like tea');
    expect(question).toContain('hi');
    expect(input).toBe('user: use b instead');
  });
});
