import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  contextLimitFor,
  endpointId,
  getClient,
  listModels,
  probeEndpoint,
  resetClients,
  servedSlots,
} from '../../src/endpoint/client.ts';
import { resetAll } from '../../src/runtime/reset.ts';
import { exportCapabilities } from '../../src/runtime/snapshot.ts';
import { ask } from '../../src/turn/side-task.ts';
import { HttpStatus } from '../../src/wire/wire.ts';
import { answer, answeredBy, respond, respondAsAsked } from '../helpers.ts';

/** An address only the function answers: nothing listens there, and no resolver knows the host. */
const internal = { baseUrl: 'http://router.internal/v1', apiKey: '' };

/**
 * A router's forwarding function: a listing that names `m` without a window, llama.cpp's `/props`
 * with the window and the slots, and a chat answer.
 *
 * @param window - The window `/props` reports, so two routers can be told apart.
 * @returns The function, a mock.
 */
const router = (window: number) =>
  answeredBy(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/models') {
      return respond({ data: [{ id: 'm' }] });
    }
    if (pathname === '/props') {
      return respond({ default_generation_settings: { n_ctx: window }, total_slots: 4 });
    }
    if (pathname === '/v1/chat/completions') {
      return respond(answer(`window ${window}`));
    }
    return respond({ error: 'no such route' }, HttpStatus.NotFound);
  });

/** The paths a function was asked for, in order, query included. */
const pathsOf = (fetch: ReturnType<typeof router>) =>
  fetch.mock.calls.map(([input]) => {
    const url = new URL(String(input));
    return `${url.pathname}${url.search}`;
  });

/** The global `fetch`, replaced so a test can say it was never reached. */
const global = vi.fn<typeof globalThis.fetch>(async () => {
  throw new Error('the global fetch was used');
});

beforeEach(() => {
  resetAll();
  global.mockClear();
  vi.stubGlobal('fetch', global);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('an endpoint answered by a function', () => {
  it('answers a chat call with no server on a port', async () => {
    const fetch = router(8192);
    const reply = await getClient({ ...internal, fetch }).chat.completions.create({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(reply.choices[0]?.message.content).toBe('window 8192');
    const [request] = fetch.mock.calls[0] ?? [];
    expect(String(request)).toBe('http://router.internal/v1/chat/completions');
    expect(global).not.toHaveBeenCalled();
  });

  it('lists, sizes the window and counts the slots through it', async () => {
    const fetch = router(8192);
    const endpoint = { ...internal, fetch, model: 'm' };
    expect(await listModels(endpoint)).toEqual([{ id: 'm', contextLength: 0 }]);
    expect(await contextLimitFor(endpoint)).toBe(8192);
    expect(await servedSlots(endpoint)).toBe(4);
    // The window lookup read the listing already taken, and the slots its `/props` answer.
    expect(pathsOf(fetch)).toEqual(['/v1/models', '/props?model=m']);
    expect(global).not.toHaveBeenCalled();
  });

  it('probes an endpoint nobody has saved through it', async () => {
    const fetch = answeredBy(async () => respond({ data: [{ id: 'b' }, { id: 'a', context_length: 4096 }] }));
    const models = await probeEndpoint({ ...internal, fetch });
    expect(models).toEqual([
      { id: 'a', contextLength: 4096 },
      { id: 'b', contextLength: 0 },
    ]);
    const [request, init] = fetch.mock.calls[0] ?? [];
    expect(String(request)).toBe('http://router.internal/v1/models');
    // The probe's own rules still hold: a redirect is the function's to answer, not to follow.
    expect(init?.redirect).toBe('manual');
    expect(global).not.toHaveBeenCalled();
  });
});

describe('two functions behind one URL', () => {
  it('never share a client, and one function keeps its own', () => {
    const a = router(8192);
    const b = router(4096);
    const client = getClient({ ...internal, fetch: a });
    expect(getClient({ ...internal, fetch: a })).toBe(client);
    expect(getClient({ ...internal, fetch: b })).not.toBe(client);
    expect(getClient(internal)).not.toBe(client);
    expect(getClient(internal)).not.toBe(getClient({ ...internal, fetch: b }));
  });

  it("never answer one function's lookup with another's, or with the global one's", async () => {
    const a = router(8192);
    const b = router(4096);
    expect(await contextLimitFor({ ...internal, fetch: a, model: 'm' })).toBe(8192);
    expect(await contextLimitFor({ ...internal, fetch: b, model: 'm' })).toBe(4096);
    // Asked again, each answers from its own memory and nobody is asked.
    expect(await contextLimitFor({ ...internal, fetch: a, model: 'm' })).toBe(8192);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
    // The global fetch has learned nothing either: it is asked, and it fails as it would.
    expect(await contextLimitFor({ ...internal, model: 'm' })).toBe(0);
    expect(global).toHaveBeenCalled();
  });

  it("never latch one function's missing routes for another", async () => {
    // A function whose server has neither native route, which is latched and not asked again.
    const bare = answeredBy(async (request) =>
      new URL(request.url).pathname === '/v1/models'
        ? respond({ data: [{ id: 'm' }] })
        : respond({ error: 'no such route' }, HttpStatus.NotFound),
    );
    expect(await contextLimitFor({ ...internal, fetch: bare, model: 'm' })).toBe(0);
    expect(await servedSlots({ ...internal, fetch: bare, model: 'm' })).toBe(0);
    expect(pathsOf(bare)).toEqual(['/v1/models', '/props?model=m', '/api/v0/models']);
    // The same URL through another function is still asked, and answers.
    const full = router(8192);
    expect(await contextLimitFor({ ...internal, fetch: full, model: 'm' })).toBe(8192);
    expect(await servedSlots({ ...internal, fetch: full, model: 'm' })).toBe(4);
  });

  it('are both forgotten by resetClients', async () => {
    const a = router(8192);
    await contextLimitFor({ ...internal, fetch: a, model: 'm' });
    const client = getClient({ ...internal, fetch: a });
    resetClients();
    expect(getClient({ ...internal, fetch: a })).not.toBe(client);
    await contextLimitFor({ ...internal, fetch: a, model: 'm' });
    expect(pathsOf(a).filter((path) => path === '/v1/models')).toHaveLength(2);
  });
});

describe('an endpoint answered by a function, written down', () => {
  it('is a snapshot entry under its URL and key, with no function in it', async () => {
    // Refuses the no-thinking hints once, so `ask` latches something worth exporting.
    const fetch = answeredBy(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      return 'chat_template_kwargs' in body
        ? respond(
            { error: { message: 'Unrecognized request argument supplied: chat_template_kwargs' } },
            HttpStatus.BadRequest,
          )
        : respondAsAsked(body, 'named');
    });
    const endpoint = { ...internal, apiKey: 'sk-router', fetch };
    expect(await ask(endpoint, 'm', 'Name this.', 'hi')).toBe('named');

    const snapshot = exportCapabilities();
    const id = endpointId({ baseUrl: internal.baseUrl, apiKey: 'sk-router' });
    expect(Object.keys(snapshot.endpoints)).toEqual([id]);
    expect(snapshot.endpoints[id].models.m.refusedFields).toEqual(['chat_template_kwargs']);
    // Survives JSON whole, so nothing in it was a function that JSON would have dropped.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain('fetch');
  });
});
