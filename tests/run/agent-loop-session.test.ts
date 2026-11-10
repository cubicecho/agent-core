import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpStatus, Role } from '../../src/wire/wire.ts';
import { apiError, type Body, config, type Message, says } from '../helpers.ts';

const create = vi.fn();
/** Only the SDK-touching half is replaced; `/props` is a stubbed `fetch`. */
vi.mock('../../src/endpoint/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/endpoint/client.ts')>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { runAgentLoop } = await import('../../src/run/agent-loop.ts');
const { resetAll } = await import('../../src/runtime/reset.ts');
const { SESSION_HEADER } = await import('../../src/endpoint/slots.ts');

type RunEventInput = import('../../src/run/events.ts').RunEventInput;

const question: Message[] = [{ role: Role.User, content: 'hi' }];

/** A llama.cpp server with this many slots, or a server without `/props` given none. */
const server = (slots?: number) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      slots === undefined
        ? new Response('not found', { status: HttpStatus.NotFound })
        : new Response(JSON.stringify({ total_slots: slots }), { status: HttpStatus.Ok }),
    ),
  );

/** What each request was sent, read for the two pinning fields. */
const pins = () =>
  create.mock.calls.map(([body]) => {
    const { id_slot, cache_prompt } = body as Body & { id_slot?: number; cache_prompt?: boolean };
    return { id_slot, cache_prompt };
  });

/** The headers each request was sent with. */
const headers = () => create.mock.calls.map(([, options]) => (options as { headers?: Record<string, string> }).headers);

/** Runs a one-turn loop under a session, with its events collected. */
const run = async (session: string | undefined, extra: Partial<typeof config> & Record<string, unknown> = {}) => {
  const events: RunEventInput[] = [];
  const result = await runAgentLoop({
    config: { ...config, ...extra },
    messages: question,
    dispatch: async () => '',
    session,
    onEvent: (event) => events.push(event),
  });
  return { result, events, notices: events.flatMap((event) => (event.kind === 'notice' ? [event.text] : [])) };
};

beforeEach(() => {
  create.mockReset();
  create.mockImplementation(() => says('done'));
});
afterEach(() => {
  resetAll();
  vi.unstubAllGlobals();
});

describe('runAgentLoop with a session', () => {
  it('pins the run to a slot, asks for its cached prompt, and says so', async () => {
    server(4);
    const { notices, result } = await run('run-1');
    expect(pins()).toEqual([{ id_slot: 0, cache_prompt: true }]);
    expect(notices).toContain('pinned to slot 0 of 4');
    expect(result.turn.usage.pinned).toBe(true);
    expect(result.metrics.unpinnedTurns).toBe(0);
  });

  it('sends the session as a header on every endpoint, slots or none', async () => {
    server();
    await run('run-1');
    expect(headers()).toEqual([{ [SESSION_HEADER]: 'run-1' }]);
    expect(pins()).toEqual([{ id_slot: undefined, cache_prompt: undefined }]);
  });

  it('is inert on a server without total_slots: no pin, no notice, no pinned report', async () => {
    server();
    const { notices, result } = await run('run-1');
    expect(notices).toEqual([]);
    expect(result.turn.usage.pinned).toBeUndefined();
    expect(result.metrics.unpinnedTurns).toBeUndefined();
  });

  it('sends nothing of the kind without a session', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await run(undefined);
    expect(fetch).not.toHaveBeenCalled();
    expect(headers()).toEqual([undefined]);
    expect(pins()).toEqual([{ id_slot: undefined, cache_prompt: undefined }]);
  });

  it('keeps concurrent runs on slots of their own', async () => {
    server(2);
    const answers: (() => void)[] = [];
    create.mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(() => resolve(says('done')));
        }),
    );
    const first = run('a');
    const second = run('b');
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    for (const answer of answers) {
      answer();
    }
    await Promise.all([first, second]);
    expect(pins().map(({ id_slot }) => id_slot)).toEqual([0, 1]);
  });

  it('runs unpinned when every slot is held, and counts the turn', async () => {
    server(1);
    let answer: () => void = () => {};
    create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(says('done'));
        }),
    );
    const holder = run('a');
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const { notices, result } = await run('b');
    answer();
    await holder;
    expect(pins()[1]).toEqual({ id_slot: undefined, cache_prompt: undefined });
    expect(notices).toContain('no free slot of 1 for this session; running unpinned');
    expect(result.turn.usage.pinned).toBe(false);
    expect(result.metrics.unpinnedTurns).toBe(1);
  });

  it('releases the slot when the run returns, and when it throws', async () => {
    server(1);
    await run('a');
    create.mockImplementationOnce(() => Promise.reject(new Error('the endpoint fell over')));
    await expect(run('b')).rejects.toThrow('the endpoint fell over');
    await run('c');
    expect(pins().map(({ id_slot }) => id_slot)).toEqual([0, 0, 0]);
  });

  it('gives a session back its slot on its next loop, so its steps share one cache', async () => {
    server(2);
    await run('a');
    await run('b');
    await run('a');
    expect(pins().map(({ id_slot }) => id_slot)).toEqual([0, 1, 0]);
  });

  it('latches a server that refuses id_slot, and sends it none again', async () => {
    server(2);
    create.mockReset();
    create
      .mockRejectedValueOnce(apiError(400, 'Unrecognized request argument supplied: id_slot'))
      .mockImplementation(() => says('done'));
    const first = await run('a');
    const second = await run('a');
    expect(pins().map(({ id_slot }) => id_slot)).toEqual([0, undefined, undefined]);
    expect(first.result.turn.usage.pinned).toBe(false);
    expect(second.notices).not.toContain('pinned to slot 0 of 2');
    expect(second.result.metrics.unpinnedTurns).toBe(1);
  });

  it('leaves a host that names its own id_slot alone', async () => {
    server(4);
    const { notices } = await run('a', { extraBody: { id_slot: 3 } });
    expect(pins()).toEqual([{ id_slot: 3, cache_prompt: undefined }]);
    expect(notices).toEqual([]);
  });

  it("lets the host's cache_prompt win over the pin's", async () => {
    server(4);
    await run('a', { extraBody: { cache_prompt: false } });
    expect(pins()).toEqual([{ id_slot: 0, cache_prompt: false }]);
  });
});
