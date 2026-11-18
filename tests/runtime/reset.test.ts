import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunEventKind } from '../../src/run/events.ts';
import { Role } from '../../src/wire/wire.ts';
import { type Create, endpoint, reply } from '../helpers.ts';

const list = vi.fn();
const create = vi.fn<Create>();
/**
 * The SDK's transport, replaced. Its statics come along because two modules under test
 * classify failures with `instanceof OpenAI.APIError`, and a fake class has no such thing.
 */
vi.mock('openai', async () => {
  const actual = await vi.importActual<typeof import('openai')>('openai');
  class Fake {
    models = { list };
    chat = { completions: { create } };
  }
  return { default: Object.assign(Fake, actual.default) };
});

const OpenAI = (await import('openai')).default;
const { configureClients, getClient } = await import('../../src/endpoint/client.ts');
const { capabilitiesFor } = await import('../../src/endpoint/capabilities.ts');
const { emit, history } = await import('../../src/run/events.ts');
const { configureHooks, HOOK_PREFACE } = await import('../../src/hooks/hooks.ts');
const { ask } = await import('../../src/turn/side-task.ts');
const { resetAll } = await import('../../src/runtime/reset.ts');
const { calibrate, charsPerTokenFor } = await import('../../src/endpoint/calibration.ts');
const { slotAllocator } = await import('../../src/endpoint/slots.ts');

/** Whether the no-thinking hints rode along on the nth call. */
const sentHints = (nth: number) => 'chat_template_kwargs' in create.mock.calls[nth][0];

/** Teaches the process one latched refusal per module, so there is something to forget. */
const latchEverything = async () => {
  // The no-thinking hints refused by name. Built here, since this file mocks the SDK whole.
  const refusal = new OpenAI.APIError(
    400,
    { message: 'Unrecognized request argument supplied: chat_template_kwargs' },
    undefined,
    undefined,
  );
  create.mockRejectedValueOnce(refusal).mockResolvedValue(reply);
  await ask(endpoint, 'qwen', 'system', 'user');
  capabilitiesFor(endpoint).usageInStream = false;
  emit('run-a', { kind: RunEventKind.Output, text: 'one' });
  return getClient(endpoint);
};

describe('resetAll', () => {
  beforeEach(() => {
    create.mockReset();
    list.mockReset();
    resetAll();
  });

  it('forgets the pooled clients', async () => {
    const before = await latchEverything();
    expect(getClient(endpoint)).toBe(before);
    resetAll();
    expect(getClient(endpoint)).not.toBe(before);
  });

  it('forgets what an endpoint was found not to support', async () => {
    await latchEverything();
    expect(capabilitiesFor(endpoint).usageInStream).toBe(false);
    resetAll();
    expect(capabilitiesFor(endpoint).usageInStream).toBe(true);
  });

  it('forgets which models refused the no-thinking hints', async () => {
    await latchEverything();
    // Two calls so far: the one that was refused, and its retry without the hints.
    expect(create).toHaveBeenCalledTimes(2);
    resetAll();
    await ask(endpoint, 'qwen', 'system', 'user');
    // Offered again, because nothing here knows any more that they were ever refused.
    expect(sentHints(2)).toBe(true);
  });

  it("forgets what each model's characters per token were measured at", () => {
    const supports = capabilitiesFor(endpoint);
    const body = {
      model: 'm',
      stream: true as const,
      messages: [{ role: Role.User, content: 'x'.repeat(2000) }],
    };
    calibrate(supports, body, 1000);
    expect(charsPerTokenFor(supports, 'm')).not.toBe(4);
    resetAll();
    // The same endpoint object, so it is the readings that were dropped and not only the latches.
    expect(charsPerTokenFor(supports, 'm')).toBe(4);
  });

  it('forgets the runs on the bus', async () => {
    await latchEverything();
    expect(history('run-a')).toHaveLength(1);
    resetAll();
    expect(history('run-a')).toEqual([]);
  });

  it('forgets which session holds which slot', () => {
    slotAllocator(endpoint, 'm', 1).acquire('a');
    expect(slotAllocator(endpoint, 'm', 1).acquire('b')).toBeUndefined();
    resetAll();
    expect(slotAllocator(endpoint, 'm', 1).acquire('b')).toBe(0);
  });

  it("puts the client pool's bounds back", () => {
    configureClients({ maxClients: 1, listingMissMs: 1, lookupTimeoutMs: 1 });
    resetAll();
    expect(configureClients()).toEqual({ maxClients: 32, listingMissMs: 30_000, lookupTimeoutMs: 10_000 });
  });

  it("puts the hooks' budget and preface back", () => {
    configureHooks({ contextTokens: 10, preface: '' });
    resetAll();
    expect(configureHooks()).toEqual({ contextTokens: 2000, preface: HOOK_PREFACE });
  });
});
