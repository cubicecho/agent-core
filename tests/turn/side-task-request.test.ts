import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAll } from '../../src/runtime/reset.ts';
import { ask, askJson, askReply, tryAsk } from '../../src/turn/side-task.ts';
import { HttpStatus, SchemaType } from '../../src/wire/wire.ts';
import { answeredBy, respond, respondAsAsked } from '../helpers.ts';

/**
 * What a side task promises whichever way it is sent, seen from the model server's side: the
 * requests are answered by an `Endpoint.fetch`, through the real client.
 */

/** A request's body as it reached the model server. */
type Sent = { max_tokens?: number; temperature?: number; stream?: boolean; stream_options?: unknown };

/**
 * A model server that answers every request in words, and keeps what each one sent.
 *
 * @param content - What the model says.
 * @returns The endpoint, and the bodies it was sent in order.
 */
const answering = (content: string) => {
  const bodies: Sent[] = [];
  const fetch = answeredBy(async (request) => {
    const body = (await request.json()) as Sent;
    bodies.push(body);
    return respondAsAsked(body, content);
  });
  return { config: { baseUrl: 'http://side/v1', apiKey: '', requestTimeoutSeconds: 60, fetch }, bodies };
};

/**
 * A model server that never answers, and says when each request it was sent was given up on.
 *
 * @param [onGiveUp] - Told each time a request is abandoned.
 * @returns The fetch function, and how long each abandoned request had been out, in milliseconds.
 */
const unanswered = (onGiveUp: () => void = () => {}) => {
  const waited: number[] = [];
  const fetch = answeredBy(
    (request) =>
      new Promise<Response>((_, reject) => {
        const sent = Date.now();
        request.signal.addEventListener('abort', () => {
          waited.push(Date.now() - sent);
          onGiveUp();
          reject(request.signal.reason);
        });
      }),
  );
  return { fetch, waited };
};

const schema = {
  type: SchemaType.Object,
  properties: { name: { type: SchemaType.String } },
  required: ['name'],
  additionalProperties: false,
};

/**
 * A model server that fails each request with this answer until it has failed `times` of them,
 * then answers in words.
 *
 * @param times - How many requests fail. `Infinity` fails them all.
 * @param status - The status each failure is sent with.
 * @param error - The body's `error`, as the server words it.
 * @returns The endpoint, whose `fetch` is a mock that counts the requests.
 */
const failing = (times: number, status: number, error: Record<string, unknown>) => {
  let failed = 0;
  const fetch = answeredBy(async (request) => {
    const body = (await request.json()) as Sent;
    if (failed < times) {
      failed++;
      return respond({ error }, status);
    }
    return respondAsAsked(body, 'ok');
  });
  return { baseUrl: 'http://busy/v1', apiKey: '', requestTimeoutSeconds: 60, fetch };
};

/** Runs out every backoff and loading poll a side task sleeps through. */
const runOutTheClock = async () => {
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(8000);
  }
};

afterEach(() => {
  vi.useRealTimers();
  resetAll();
});

describe('a side task told nothing', () => {
  it('asks for 512 tokens at 0.3 through every entry point', async () => {
    const { config, bodies } = answering('{"name": "x"}');
    await ask(config, 'm', 'system', 'user');
    await askReply(config, 'm', 'system', 'user');
    await askJson(config, 'm', 'system', 'user', schema);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body).toMatchObject({ max_tokens: 512, temperature: 0.3 });
    }
  });

  it('gives up on a reply that has not started within requestTimeoutSeconds', async () => {
    // The caller cancels once the first request is given up on, so what is measured is that
    // request's wait and not any that follow it.
    const controller = new AbortController();
    const { fetch, waited } = unanswered(() => controller.abort());
    const config = { baseUrl: 'http://silent/v1', apiKey: '', requestTimeoutSeconds: 0.05, fetch };
    await expect(ask(config, 'm', 'system', 'user', { signal: controller.signal })).rejects.toThrow();
    expect(waited[0]).toBeGreaterThanOrEqual(40);
    expect(waited[0]).toBeLessThan(1000);
  });
});

describe('tryAsk around a side task', () => {
  it('turns a request the server refuses into no answer and one notice', async () => {
    const fetch = answeredBy(async () =>
      respond({ error: { message: 'something about the request' } }, HttpStatus.BadRequest),
    );
    const config = { baseUrl: 'http://refusing/v1', apiKey: '', requestTimeoutSeconds: 60, fetch };
    const notices: string[] = [];
    const got = await tryAsk('title', () => ask(config, 'm', 'system', 'user'), {
      onNotice: (message) => notices.push(message),
    });
    expect(got).toBeUndefined();
    expect(notices).toEqual([expect.stringContaining('title: ')]);
    expect(notices[0]).toContain('something about the request');
  });

  it('throws a cancelled side task on, and tells nobody', async () => {
    const controller = new AbortController();
    const { fetch } = unanswered();
    const config = { baseUrl: 'http://slow/v1', apiKey: '', requestTimeoutSeconds: 60, fetch };
    const notices: string[] = [];
    const { signal } = controller;
    const asking = tryAsk('title', () => ask(config, 'm', 'system', 'user', { signal }), {
      onNotice: (message) => notices.push(message),
      signal,
    });
    await expect.poll(() => fetch.mock.calls.length).toBe(1);
    controller.abort();
    await expect(asking).rejects.toThrow();
    expect(notices).toEqual([]);
  });
});

describe("a side task sent as an exchange's turn is", () => {
  it('streams, and asks for the usage where the server gives it', async () => {
    const { config, bodies } = answering('ok');
    await ask(config, 'm', 'system', 'user');
    expect(bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('sends a lost request again, twice unless told otherwise, and says so', async () => {
    vi.useFakeTimers();
    const config = failing(Number.POSITIVE_INFINITY, HttpStatus.InternalServerError, {
      message: 'the server fell over',
    });
    const notices: string[] = [];
    const asking = expect(
      ask(config, 'm', 'system', 'user', { onNotice: (message) => notices.push(message) }),
    ).rejects.toThrow('the server fell over');
    await runOutTheClock();
    await asking;
    expect(config.fetch).toHaveBeenCalledTimes(3);
    expect(notices).toEqual([expect.stringContaining('(1/2)'), expect.stringContaining('(2/2)')]);
  });

  it('answers once the lost request gets through, and sends none again at maxRetries 0', async () => {
    vi.useFakeTimers();
    const config = failing(1, HttpStatus.InternalServerError, { message: 'the server fell over' });
    const asking = ask(config, 'm', 'system', 'user');
    await runOutTheClock();
    await expect(asking).resolves.toBe('ok');

    const once = failing(1, HttpStatus.InternalServerError, { message: 'the server fell over' });
    await expect(ask(once, 'm', 'system', 'user', { maxRetries: 0 })).rejects.toThrow('the server fell over');
    expect(once.fetch).toHaveBeenCalledTimes(1);
  });

  it('waits for a model that is still loading, without spending a retry', async () => {
    vi.useFakeTimers();
    const config = failing(3, HttpStatus.ServiceUnavailable, { message: 'Loading model', type: 'unavailable_error' });
    const notices: string[] = [];
    const asking = ask(config, 'qwen', 'system', 'user', {
      maxRetries: 0,
      onNotice: (message) => notices.push(message),
    });
    await runOutTheClock();
    await expect(asking).resolves.toBe('ok');
    expect(config.fetch).toHaveBeenCalledTimes(4);
    expect(notices).toEqual(['qwen is still loading — waiting up to 120s']);
  });
});
