import { afterEach, describe, expect, it } from 'vitest';
import { resetAll } from '../../src/runtime/reset.ts';
import { ask, askJson, askReply, tryAsk } from '../../src/turn/side-task.ts';
import { HttpStatus, SchemaType } from '../../src/wire/wire.ts';
import { answeredBy, respond, respondAsAsked } from '../helpers.ts';

/**
 * What a side task promises whichever way it is sent, seen from the model server's side: the
 * requests are answered by an `Endpoint.fetch`, through the real client.
 */

/** A request's body as it reached the model server. */
type Sent = { max_tokens?: number; temperature?: number; stream?: boolean };

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

afterEach(() => resetAll());

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
