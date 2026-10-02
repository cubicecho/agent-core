import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunEventKind } from '../src/run/events.ts';
import { Role } from '../src/wire/wire.ts';
import { endpoint, reply, says } from './helpers.ts';

const list = vi.fn();
const create = vi.fn();
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
const { configureClients, getClient } = await import('../src/endpoint/client.ts');
const { capabilitiesFor } = await import('../src/endpoint/capabilities.ts');
const { configureEvents, emit, history } = await import('../src/run/events.ts');
const { configureHooks, HOOK_PREFACE, withContext } = await import('../src/hooks/hooks.ts');
const { ask } = await import('../src/turn/side-task.ts');
const { resetAll } = await import('../src/runtime/reset.ts');
const { charsPerTokenFor } = await import('../src/endpoint/calibration.ts');
const { createRuntime, defaultRuntime } = await import('../src/runtime/runtime.ts');

const refusal = () => new OpenAI.APIError(400, { error: {} }, 'rejected', undefined);
/** Whether the no-thinking hints rode along on the nth call. */
const sentHints = (nth: number) => 'chat_template_kwargs' in create.mock.calls[nth][0];
const body = {
  model: 'm',
  stream: true as const,
  messages: [{ role: Role.User, content: 'x'.repeat(2000) }],
};

beforeEach(() => {
  create.mockReset();
  list.mockReset();
  resetAll();
});

describe('createRuntime', () => {
  it('keeps a client pool of its own', () => {
    const one = createRuntime();
    const two = createRuntime();
    expect(one.getClient(endpoint)).toBe(one.getClient(endpoint));
    expect(one.getClient(endpoint)).not.toBe(two.getClient(endpoint));
    expect(one.getClient(endpoint)).not.toBe(getClient(endpoint));
  });

  it('keeps what an endpoint refused to itself', () => {
    const one = createRuntime();
    const two = createRuntime();
    one.capabilitiesFor(endpoint.baseUrl).usageInStream = false;
    expect(one.capabilitiesFor(endpoint.baseUrl).usageInStream).toBe(false);
    expect(two.capabilitiesFor(endpoint.baseUrl).usageInStream).toBe(true);
    expect(capabilitiesFor(endpoint.baseUrl).usageInStream).toBe(true);
  });

  it("latches the no-thinking hints for itself alone, across the retry's awaits", async () => {
    const one = createRuntime();
    const two = createRuntime();
    create.mockRejectedValueOnce(refusal()).mockResolvedValue(reply);
    await one.ask(endpoint, 'qwen', 'system', 'user');
    // The refused call and its retry. The latch was written after an `await`, in `one`.
    expect(create).toHaveBeenCalledTimes(2);
    await one.ask(endpoint, 'qwen', 'system', 'user');
    expect(sentHints(2)).toBe(false);
    await two.ask(endpoint, 'qwen', 'system', 'user');
    expect(sentHints(3)).toBe(true);
    await ask(endpoint, 'qwen', 'system', 'user');
    expect(sentHints(4)).toBe(true);
  });

  it('measures characters per token for itself alone', () => {
    const one = createRuntime();
    // One capabilities object, so it is the readings that are apart and not only the endpoints.
    const supports = capabilitiesFor(endpoint.baseUrl);
    one.calibrate(supports, body, 1000);
    expect(one.charsPerTokenFor(supports, 'm')).not.toBe(4);
    expect(charsPerTokenFor(supports, 'm')).toBe(4);
  });

  it('keeps an event bus of its own', () => {
    const one = createRuntime();
    const two = createRuntime();
    one.emit('run', { kind: RunEventKind.Output, text: "one's" });
    expect(one.history('run').map((event) => event.text)).toEqual(["one's"]);
    expect(two.history('run')).toEqual([]);
    expect(history('run')).toEqual([]);
  });

  it('starts from what it was given, and from the defaults for the rest', () => {
    configureClients({ maxClients: 2 });
    configureEvents({ maxEvents: 5 });
    configureHooks({ preface: "the process's" });
    const runtime = createRuntime({
      clients: { maxClients: 7 },
      hooks: { contextTokens: 50 },
    });
    // Not inherited from the default runtime: the part left out is the package's default.
    expect(runtime.configureClients()).toEqual({ maxClients: 7, listingMissMs: 30_000 });
    expect(runtime.configureEvents().maxEvents).toBe(1000);
    expect(runtime.configureHooks()).toEqual({ contextTokens: 50, preface: HOOK_PREFACE });
    // And nothing it was given reached the process.
    expect(configureClients().maxClients).toBe(2);
    expect(configureHooks()).toEqual({ contextTokens: 2000, preface: "the process's" });
  });

  it('reads its own settings where a function takes its default from them', () => {
    const runtime = createRuntime({ hooks: { preface: 'Runtime notes:' } });
    const messages = [{ role: Role.User, content: 'hi' }];
    const text = (built: typeof messages) => String(built[0].content);
    expect(text(runtime.withContext(messages, 0, 'a note') as typeof messages)).toContain('Runtime notes:');
    expect(text(withContext(messages, 0, 'a note') as typeof messages)).not.toContain('Runtime notes:');
  });

  it('resets itself without touching the process, and the other way round', () => {
    const runtime = createRuntime({ clients: { maxClients: 7 } });
    const mine = runtime.getClient(endpoint);
    const shared = getClient(endpoint);
    runtime.emit('run', { kind: RunEventKind.Output, text: 'kept' });
    emit('run', { kind: RunEventKind.Output, text: 'shared' });

    resetAll();
    expect(getClient(endpoint)).not.toBe(shared);
    expect(history('run')).toEqual([]);
    expect(runtime.getClient(endpoint)).toBe(mine);
    expect(runtime.history('run')).toHaveLength(1);
    expect(runtime.configureClients().maxClients).toBe(7);

    const again = getClient(endpoint);
    emit('run', { kind: RunEventKind.Output, text: 'shared' });
    runtime.resetAll();
    expect(runtime.getClient(endpoint)).not.toBe(mine);
    expect(runtime.history('run')).toEqual([]);
    expect(runtime.configureClients().maxClients).toBe(32);
    expect(getClient(endpoint)).toBe(again);
    expect(history('run')).toHaveLength(1);
  });
});

describe("a runtime's context", () => {
  it('is what a top-level function uses inside `run`, after an await and in a timer', async () => {
    const runtime = createRuntime();
    await runtime.run(async () => {
      emit('run', { kind: RunEventKind.Output, text: 'at once' });
      await Promise.resolve();
      emit('run', { kind: RunEventKind.Output, text: 'after an await' });
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          emit('run', { kind: RunEventKind.Output, text: 'in a timer' });
          resolve();
        }, 0),
      );
    });
    expect(runtime.history('run').map((event) => event.text)).toEqual(['at once', 'after an await', 'in a timer']);
    expect(history('run')).toEqual([]);
    // And not once `run` has returned.
    emit('run', { kind: RunEventKind.Output, text: 'outside' });
    expect(runtime.history('run')).toHaveLength(3);
  });

  it("reaches the host's callbacks under `runAgentLoop`", async () => {
    const runtime = createRuntime();
    create.mockReturnValueOnce(says('done'));
    const result = await runtime.runAgentLoop({
      config: { ...endpoint, model: 'm', maxTokens: 100, temperature: 0.2, maxToolIterations: 4 },
      messages: [{ role: Role.User, content: 'hi' }],
      dispatch: async () => '',
      // The top-level function, as a host that knows nothing of the runtime would call it.
      onEvent: (event) => emit('run', event),
    });
    expect(result.turn.content).toBe('done');
    expect(runtime.history('run').length).toBeGreaterThan(0);
    expect(history('run')).toEqual([]);
    // The loop's client came from the runtime's pool, and the process's is still empty.
    expect(runtime.capabilitiesFor(endpoint.baseUrl)).not.toBe(capabilitiesFor(endpoint.baseUrl));
  });

  it('keeps two runtimes apart while their calls interleave', async () => {
    const one = createRuntime();
    const two = createRuntime();
    const talk = (name: string) => async () => {
      for (const text of ['a', 'b', 'c']) {
        emit('run', { kind: RunEventKind.Output, text: `${name} ${text}` });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    await Promise.all([one.run(talk('one')), two.run(talk('two'))]);
    expect(one.history('run').map((event) => event.text)).toEqual(['one a', 'one b', 'one c']);
    expect(two.history('run').map((event) => event.text)).toEqual(['two a', 'two b', 'two c']);
  });

  it('stays with a watcher that is read from outside the runtime', async () => {
    const runtime = createRuntime();
    // Opened through the runtime and read here, where the top-level `watch` would read the
    // process's bus: the generator's body does not run until the first event is asked for.
    const events = runtime.watch('run');
    const seen: string[] = [];
    const reading = (async () => {
      for await (const event of events) {
        seen.push(event.text);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    emit('run', { kind: RunEventKind.Output, text: "the process's" });
    runtime.emit('run', { kind: RunEventKind.Output, text: "the runtime's" });
    runtime.emit('run', { kind: RunEventKind.Done, ok: true });
    await reading;
    expect(seen).toEqual(["the runtime's", '']);
  });

  it('stays with a summariser that is called from outside the runtime', async () => {
    const runtime = createRuntime();
    create.mockRejectedValueOnce(refusal()).mockResolvedValue(reply);
    const summarise = runtime.summariser(endpoint, 'qwen');
    expect(await summarise('a transcript')).toBe('ok');
    // The refusal was latched where the summariser was made, not where it was called.
    await runtime.ask(endpoint, 'qwen', 'system', 'user');
    expect(sentHints(2)).toBe(false);
    await ask(endpoint, 'qwen', 'system', 'user');
    expect(sentHints(3)).toBe(true);
  });

  it("is left for the process's by `defaultRuntime`, even inside another", () => {
    const runtime = createRuntime();
    runtime.run(() => {
      defaultRuntime.emit('run', { kind: RunEventKind.Output, text: 'shared' });
    });
    expect(history('run')).toHaveLength(1);
    expect(runtime.history('run')).toEqual([]);
    expect(defaultRuntime.getClient(endpoint)).toBe(getClient(endpoint));
  });
});
