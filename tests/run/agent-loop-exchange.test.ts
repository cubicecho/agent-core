import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExchangeOutcome, type RunEventInput, RunEventKind } from '../../src/run/events.ts';
import { FinishReason, Role } from '../../src/wire/wire.ts';
import { apiError, type Create, chunks, config, type Message, says, tool } from '../helpers.ts';

const create = vi.fn<Create>();
/** Only the SDK-touching half is replaced; the rest of the client module is pure. */
vi.mock('../../src/endpoint/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/endpoint/client.ts')>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { runAgentLoop } = await import('../../src/run/agent-loop.ts');
const { resetCapabilities } = await import('../../src/endpoint/capabilities.ts');

type AgentLoopOptions = import('../../src/run/agent-loop.ts').AgentLoopOptions;

/** A turn that asks for one call to `name`, id `c0`. */
const asks = (name: string) =>
  chunks({
    choices: [
      {
        delta: { tool_calls: [{ index: 0, id: 'c0', function: { name, arguments: '{}' } }] },
        finish_reason: FinishReason.ToolCalls,
      },
    ],
  });

const question: Message[] = [{ role: Role.User, content: 'hi' }];

/**
 * Runs one exchange, keeping every event it emits.
 *
 * @param [more] - Options over a plain exchange with one tool, `read`.
 * @returns The result or what was thrown, and the events.
 */
async function exchange(more: Partial<AgentLoopOptions> = {}) {
  const events: RunEventInput[] = [];
  const settled = await runAgentLoop({
    config,
    messages: question,
    tools: [tool('read')],
    dispatch: async () => 'read',
    onEvent: (event) => events.push(event),
    ...more,
  }).catch((caught: unknown) => caught);
  return { settled, events };
}

/** The last event, which an exchange's end always is. */
const last = (events: RunEventInput[]) => events[events.length - 1];

/** What a thrown error said, or `undefined` where nothing was thrown. */
const thrown = (settled: unknown) => (settled instanceof Error ? settled.message : undefined);

beforeEach(() => create.mockReset());
afterEach(() => resetCapabilities());

describe("an exchange's start and end events", () => {
  it('opens with an exchange event and closes with its end, the outcome on it', async () => {
    create.mockReturnValueOnce(asks('read')).mockReturnValueOnce(says('done'));
    const { settled, events } = await exchange();

    expect(events[0]).toEqual({ kind: RunEventKind.Exchange, name: '' });
    expect(last(events)).toEqual({ kind: RunEventKind.ExchangeEnd, outcome: ExchangeOutcome.Answered, ok: true });
    expect(events.filter((event) => event.kind === RunEventKind.Exchange)).toHaveLength(1);
    expect(settled).toMatchObject({ metrics: { exchanges: 1, outcome: ExchangeOutcome.Answered } });
  });

  it('names the exchange on its start and on every event it emits', async () => {
    create.mockReturnValueOnce(asks('read')).mockReturnValueOnce(says('done'));
    const { events } = await exchange({ exchange: 'triage' });

    expect(events[0]).toEqual({ kind: RunEventKind.Exchange, name: 'triage', exchange: 'triage' });
    expect(events.every((event) => event.exchange === 'triage')).toBe(true);
  });

  it('carries the call that ended the exchange, and why', async () => {
    create.mockReturnValueOnce(asks('hand_off'));
    const { settled, events } = await exchange({
      tools: [tool('hand_off')],
      dispatch: async () => ({ text: 'handed off', end: { reason: 'needs a person' } }),
    });

    expect(last(events)).toEqual({
      kind: RunEventKind.ExchangeEnd,
      outcome: ExchangeOutcome.Ended,
      ok: true,
      id: 'c0',
      name: 'hand_off',
      text: 'needs a person',
    });
    expect(settled).toMatchObject({ metrics: { outcome: ExchangeOutcome.Ended } });
  });

  it('lists the calls a waiting exchange handed back, after its wait', async () => {
    create.mockReturnValueOnce(asks('ask_person'));
    const { events } = await exchange({ tools: [], hostTools: [tool('ask_person')], handBack: true });

    expect(events.slice(-2).map((event) => event.kind)).toEqual([RunEventKind.Wait, RunEventKind.ExchangeEnd]);
    expect(last(events)).toEqual({
      kind: RunEventKind.ExchangeEnd,
      outcome: ExchangeOutcome.Waiting,
      ok: true,
      pending: ['c0'],
    });
  });

  it('ends a failed exchange before it throws, with what went wrong', async () => {
    create.mockRejectedValueOnce(apiError(401, 'no such key'));
    const { settled, events } = await exchange({ config: { ...config, maxRetries: 0 } });

    expect(thrown(settled)).toContain('no such key');
    expect(last(events)).toEqual({
      kind: RunEventKind.ExchangeEnd,
      outcome: ExchangeOutcome.Failed,
      ok: false,
      text: thrown(settled),
    });
  });

  it('ends an exchange whose turns ran out as failed', async () => {
    create.mockReturnValue(asks('read'));
    const { settled, events } = await exchange({ config: { ...config, maxToolIterations: 1 } });

    expect(thrown(settled)).toContain('tool iterations');
    expect(last(events)).toMatchObject({
      kind: RunEventKind.ExchangeEnd,
      outcome: ExchangeOutcome.Failed,
      ok: false,
      text: thrown(settled),
    });
  });

  it("ends an exchange the app's signal stopped as stopped", async () => {
    const controller = new AbortController();
    create.mockReturnValueOnce(asks('read'));
    const { settled, events } = await exchange({
      signal: controller.signal,
      dispatch: async () => {
        controller.abort();
        return 'read';
      },
    });

    expect(settled).toBeInstanceOf(Error);
    expect(last(events)).toMatchObject({ kind: RunEventKind.ExchangeEnd, outcome: ExchangeOutcome.Stopped, ok: false });
  });

  it('sends one end, and throws what the exchange failed with, where the app hears the end and throws', async () => {
    create.mockReturnValueOnce(says('done'));
    const ends: RunEventInput[] = [];
    const settled = await runAgentLoop({
      config,
      messages: question,
      dispatch: async () => '',
      onEvent: (event) => {
        if (event.kind === RunEventKind.ExchangeEnd) {
          ends.push(event);
          throw new Error('the store is down');
        }
      },
    }).catch((caught: unknown) => caught);

    expect(thrown(settled)).toBe('the store is down');
    expect(ends).toHaveLength(1);
  });
});
