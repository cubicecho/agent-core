import OpenAI from 'openai';
import {
  baseUrlKey,
  type Endpoint,
  type EndpointIdentity,
  normalizeBaseUrl,
  type RetryPolicy,
} from '../core/config.ts';
import { digestOf } from '../core/digest.ts';
import { byCodeUnit, getOrCreate, isPositive } from '../core/guards.ts';
import { MS_PER_SECOND } from '../core/platform.ts';
import { assignSettings, scoped } from '../core/scope.ts';
import { HttpStatus } from '../wire/wire.ts';

/**
 * The SDK insists on a non-empty key even where the server will not look at it. This is what it
 * gets. It also reads as "this model server has no key" at a call site, which an empty string does
 * not — a caller must not let a local model server silently borrow the key meant for a paid one.
 */
export const NO_KEY = 'agent-core';

/**
 * A wait in the SDK's spelling: milliseconds, and `undefined` where zero or less means no limit.
 *
 * @param seconds - The wait as a config states it.
 * @returns Milliseconds, or `undefined` for zero or less.
 */
const limitMs = (seconds: number) => (seconds > 0 ? seconds * MS_PER_SECOND : undefined);

/**
 * A model server's idle timeout, `requestTimeoutSeconds`, in the SDK's spelling: milliseconds,
 * `undefined` for no limit.
 *
 * @param config - Read for `requestTimeoutSeconds` alone. Zero, less, or absent means no limit.
 * @returns The idle timeout in milliseconds, or `undefined` for no limit.
 */
export const idleTimeoutMs = (config: Pick<Endpoint, 'requestTimeoutSeconds'>): number | undefined =>
  limitMs(config.requestTimeoutSeconds ?? 0);

/**
 * How long to wait out a model that is still loading, in milliseconds — `undefined` where the
 * config has no opinion, and zero where it says not to wait at all.
 *
 * @param config - Read for `loadingTimeoutSeconds` alone. Zero or less is no wait.
 * @returns Milliseconds: `undefined` only where the field is absent, and zero where it is zero or
 * less.
 *
 * @remarks
 * Zero rather than the SDK's `undefined` for "no wait", because here absent already means
 * something else: `runTurn`'s own default.
 */
export const loadingMs = (config: Pick<RetryPolicy, 'loadingTimeoutSeconds'>): number | undefined =>
  config.loadingTimeoutSeconds === undefined ? undefined : (limitMs(config.loadingTimeoutSeconds) ?? 0);

/** The function a model server's requests go through: `Endpoint.fetch`, or the global one. */
type Fetch = typeof globalThis.fetch;

/**
 * One cache, held once for the global `fetch` and once for each function an app gave a
 * model server.
 */
export interface PerFetch<T extends {}> {
  /**
   * The copy for the model servers that send through `fetch`, absent being the global one, made on
   * first use.
   */
  (fetch: Fetch | undefined): T;
  /** The current scope's copies: the global one's first, then those of the functions still held. */
  copies(): T[];
  /** Drops the current scope's copies: the global one's and every function's. */
  reset(): void;
}

/** One scope's copies for the app's functions, and a weak reference to each so they can be walked. */
interface HostCopies<T extends {}> {
  byFetch: WeakMap<Fetch, T>;
  live: Set<WeakRef<T>>;
}

/**
 * Declares a cache that keeps what was found through one `fetch` apart from what any other found.
 *
 * @typeParam T - The cache.
 * @param create - Builds a fresh, empty copy. Called once per function per scope, and again after `reset`.
 * @returns The reader, with `copies` and `reset` on it, all acting on the scope current when called.
 *
 * @remarks
 * This is half of what one model server is: `endpointKey` is the other half, the key inside each
 * copy. Two model servers with one URL and key and different functions may reach two different
 * servers, so nothing found through one function may answer for another, or for the global `fetch`.
 * A function's copy lives in a `WeakMap` under the function itself, and is walked through a
 * `WeakRef`, so it goes when the app drops the function: an app making one per exchange would
 * otherwise leave a copy behind for every exchange it ever made.
 */
export function perFetch<T extends {}>(create: () => T): PerFetch<T> {
  const own = scoped(create);
  const hosts = scoped((): HostCopies<T> => ({ byFetch: new WeakMap(), live: new Set() }));
  // Drops a copy's reference from the walk once the copy itself has gone with its function.
  const forget = new FinalizationRegistry<{ live: Set<WeakRef<T>>; ref: WeakRef<T> }>(({ live, ref }) =>
    live.delete(ref),
  );
  const hostCopy = (fetch: Fetch) => {
    const held = hosts();
    return getOrCreate(held.byFetch, fetch, () => {
      const copy = create();
      const ref = new WeakRef(copy);
      held.live.add(ref);
      forget.register(copy, { live: held.live, ref });
      return copy;
    });
  };
  const read = (fetch: Fetch | undefined) => (fetch ? hostCopy(fetch) : own());
  return Object.assign(read, {
    copies: () => {
      const held = [...hosts().live].map((ref) => ref.deref());
      return [own(), ...held.filter((copy) => copy !== undefined)];
    },
    reset: () => {
      own.reset();
      hosts.reset();
    },
  });
}

/**
 * The function a model server's requests are sent through.
 *
 * @param config - Read for `fetch` alone.
 * @returns The model server's own function, or the global `fetch` as it is at the time of the call.
 *
 * @remarks
 * The global is read per call rather than once, so a test that stubs it is heard.
 */
const sender = (config: Pick<Endpoint, 'fetch'>): Fetch => config.fetch ?? globalThis.fetch;

/**
 * A client per model server, made once and kept.
 *
 * @remarks
 * The SDK holds its own connection pool, which a client per request would throw away, and agents
 * on different servers side by side would evict each other's client from a single slot.
 * `maxRetries: 0` turns the SDK's own retrying off, since a stream that has emitted tokens must not
 * be replayed and only the caller knows whether it has (`retry.ts`). Bounded to `maxClients` per
 * `fetch` (`perFetch`), oldest first: a `Map` iterates in insertion order and `getClient`
 * re-inserts on a hit.
 */
const clients = perFetch(() => new Map<string, OpenAI>());

/**
 * How many model servers' clients are kept at once, until `configureClients` moves it.
 *
 * @remarks
 * This is a backstop rather than a design. The key includes the API key, and every argument in
 * this file for what bounds these caches is "a settings row's worth" — true of the deployments
 * this was written for, and false the moment a consumer mints a key per *user*, where the map
 * grows one client and one connection pool per tenant for the life of the process with
 * `resetClients` as the only release.
 *
 * Thirty-two is far more model servers than a settings table holds, so a deployment-shaped consumer
 * never reaches it, and an evicted client costs its connection pool and nothing else — the next
 * request through that model server builds another. See `getClient` for the constraint stated as a
 * constraint.
 */
const MAX_CLIENTS = 32;

/** How long a model missing from a listing stays unlisted before the server is asked again. */
const LISTING_MISS_MS = 30_000;

/**
 * How long a context window lookup may take in all, until `configureClients` moves it.
 *
 * @remarks
 * Its own number because `requestTimeoutSeconds` is how long to wait for a model to speak, and a
 * listing that has not answered in ten seconds is not going to.
 */
const LOOKUP_TIMEOUT_MS = 10_000;

/** What the client pool is held to across a process. Every field optional; see `configureClients`. */
export interface ClientPoolOptions {
  /** How many model servers' clients are kept at once. The least recently asked for goes first. */
  maxClients?: number;
  /**
   * How long, in milliseconds, a model missing from a server's listing — or a served context window
   * or slot count a server's own API gave, or an error other than a missing route from its
   * `/api/v0/models` — is taken at its word before the model server is asked again.
   */
  listingMissMs?: number;
  /**
   * How long, in milliseconds, one `contextLimitFor`, `servedWindow` or `listModels` may take over
   * all of its requests. A model server's own request timeout still applies where it is shorter.
   */
  lookupTimeoutMs?: number;
}

/** The numbers this module was written with. */
const CLIENT_DEFAULTS: Required<ClientPoolOptions> = {
  maxClients: MAX_CLIENTS,
  listingMissMs: LISTING_MISS_MS,
  lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
};

/** What is in force now. Read where it is used, so a change applies from the next call. */
const poolLimits = scoped((): Required<ClientPoolOptions> => ({ ...CLIENT_DEFAULTS }));

/**
 * Drops the least recently asked-for clients until the pool fits. Nothing is closed on the way
 * out: the SDK holds no handle a caller can release, and an evicted client is garbage once
 * whatever request is still in flight on it has finished — dropping the reference is the whole
 * of the eviction.
 *
 * @param pool - The clients of one `fetch`, as `clients` holds them. Written to.
 */
const evict = (pool: Map<string, OpenAI>) => {
  for (const oldest of pool.keys()) {
    if (pool.size <= poolLimits().maxClients) {
      break;
    }
    pool.delete(oldest);
  }
};

/**
 * Changes what the client pool is held to, for a process whose model servers are not shaped like
 * the deployments these defaults were chosen for.
 *
 * @param [options] - The bounds to change. A field left out — or given anything that is not a number
 * above zero — keeps what it has, so a half-built config narrows nothing. `Infinity` is a number
 * above zero: as `maxClients` it lifts the bound, as `listingMissMs` a miss is never asked about
 * again until `resetClients`, and as `lookupTimeoutMs` a lookup waits out the request timeout.
 * @returns Everything in force afterwards, including what this call did not change.
 *
 * @remarks
 * One setting per runtime for the same reason `configureEvents` is: the pool is one thing per
 * runtime, and its size is a deployment's setting, said once at startup. A multi-tenant app
 * keying on a key per user raises `maxClients` so its tenants stop evicting each other's
 * connection pools, or gives each tenant a `createRuntime` of its own; a dev box shortens
 * `listingMissMs` so a model it has just pulled is seen sooner.
 *
 * A `maxClients` below the pool's current size evicts down to it at once, least recently asked
 * for first, as the next `getClient` would have; the pool of an app's `fetch` is evicted at its
 * next `getClient`. A shorter `listingMissMs` applies to misses already remembered, since each is
 * a timestamp compared against it when read.
 */
export function configureClients(options: ClientPoolOptions = {}): Required<ClientPoolOptions> {
  const inForce = assignSettings(poolLimits(), options);
  evict(clients(undefined));
  return inForce;
}

/** How many idle windows the first chunk gets when `firstTokenSeconds` is not given. */
const FIRST_TOKEN_FACTOR = 5;

/**
 * The wait for a streamed reply's first chunk, in the SDK's spelling: `undefined` is no limit.
 *
 * @param config - Read for `firstTokenSeconds`, and `requestTimeoutSeconds` where that is absent.
 * @returns Milliseconds. `firstTokenSeconds` where it is given, zero or less being no limit;
 * otherwise five request timeouts, and no limit where the request has none.
 */
export const firstTokenLimitMs = (
  config: Pick<Endpoint, 'requestTimeoutSeconds' | 'firstTokenSeconds'>,
): number | undefined => {
  if (config.firstTokenSeconds === undefined) {
    const idle = idleTimeoutMs(config);
    return idle === undefined ? undefined : idle * FIRST_TOKEN_FACTOR;
  }
  return limitMs(config.firstTokenSeconds);
};

/**
 * The client for a model server, built once and kept.
 *
 * @param config - Where to send requests and how long to wait. An absent `apiKey` becomes `NO_KEY`,
 * and a `fetch` is what the client sends through.
 * @returns The pooled client: the same object for the same model server and timeout, until it is
 * evicted or `resetClients` runs. Asking for it makes it the last in line to be evicted.
 *
 * @remarks
 * Pooled on the model server, as `endpointKey` and the `fetch` tell one apart, and on the timeout,
 * so agents sharing a server share a connection and agents on different servers never share a
 * client. Four spellings of one URL are one client, sent to the URL as `baseUrlKey` writes it.
 *
 * The pool is per *deployment*, not per request: what belongs in this map is a model server an
 * operator configured, and everything cached in this package is bounded on that reading. A
 * consumer that mints an API key per user still gets a working client, but it is churning
 * connection pools rather than sharing them and holding every one of them — `maxClients` keeps
 * that from being unbounded, and it is the point at which a client of your own, built and held
 * per tenant, is the better answer than this.
 */
export function getClient(config: Endpoint): OpenAI {
  const apiKey = config.apiKey || NO_KEY;
  const timeout = idleTimeoutMs(config);
  const key = JSON.stringify([endpointKey(config), timeout]);
  const pool = clients(config.fetch);
  const existing = pool.get(key);
  if (existing) {
    // Re-inserted so it counts as the youngest. A `Map` keeps insertion order and hands the
    // oldest key over first, which is the whole of the LRU below.
    pool.delete(key);
    pool.set(key, existing);
    return existing;
  }
  const client = new OpenAI({
    baseURL: baseUrlKey(config.baseUrl),
    apiKey,
    timeout,
    maxRetries: 0,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  pool.set(key, client);
  evict(pool);
  return client;
}

/**
 * The context window, spelled every way a server spells it at the top of a listing entry.
 *
 * @remarks
 * None of these is in the OpenAI listing schema, so every server that says anything says it as
 * an extra key of its own: `max_model_len` is vLLM, `context_length` OpenRouter, `n_ctx` the raw
 * llama bindings. Whichever turns up first is taken — a server reporting two of them is
 * reporting the same number twice. llama.cpp puts its number under `meta` instead, and LM Studio
 * and Ollama put none on this route at all; see `servedWindow`.
 */
const CONTEXT_KEYS = [
  'context_length',
  'max_context_length',
  'max_context_window',
  'max_model_len',
  'context_window',
  'n_ctx',
];

/**
 * A number above zero as itself and anything else as zero, which here means "not stated".
 *
 * @param value - Whatever a server put under a key. Absent, a string and a negative all read as
 * zero.
 * @returns The number, or 0.
 */
const positive = (value: unknown) => (isPositive(value) ? value : 0);

/**
 * A listing entry's context window, and whether it is only the one the model was trained with.
 *
 * @param model - A listing entry as the server sent it, extra keys included. Not written to.
 * @returns The context window in tokens, and `trained` where it came from `meta.n_ctx_train`. An
 * entry that states neither answers zero and `false`.
 *
 * @remarks
 * The two are told apart because they are trusted differently: a top-level key is taken as the
 * context window being served and settles the lookup, and a trained one is a ceiling the server may
 * be running well under, so `contextLimitFor` still asks the native routes before settling for it.
 */
function contextLengthOf(model: object): { contextLength: number; trained: boolean } {
  const record = model as Record<string, unknown>;
  for (const key of CONTEXT_KEYS) {
    const value = positive(record[key]);
    if (value) {
      return { contextLength: value, trained: false };
    }
  }
  // llama.cpp's, and the context window the model was trained with rather than the one it is served
  // in: a 256k model started at `-c 16384` lists 262144 here. Better than nothing, and why the
  // served context window is still asked for after it. `meta` is `null` while the model loads.
  const meta = record.meta as Record<string, unknown> | null | undefined;
  const contextLength = positive(meta?.n_ctx_train);
  return { contextLength, trained: contextLength > 0 };
}

/**
 * A model a server lists, and what it says the model will read. Zero means it did not say.
 *
 * @remarks
 * The number is whatever the listing carried, which from llama.cpp is the trained context window
 * rather than the served one; `contextLimitFor` is the lookup that knows the difference.
 */
export interface ModelInfo {
  id: string;
  contextLength: number;
}

/**
 * The last listing from each model server, so an exchange can size its context window without a
 * round trip.
 *
 * @remarks
 * Keyed by `endpointKey` in the copy of the model server's `fetch`, because two model servers are
 * two different sets of models and one of them having answered says nothing about the other.
 *
 * The timeout is deliberately not in it, which is where this key parts company with the
 * clients'. Which models a server offers has nothing to do with how long we are willing to wait
 * for it, so two settings rows differing only there ask once between them rather than twice.
 *
 * It is only ever a cache of something asked for anyway, and a listing that fails leaves
 * whatever was there rather than emptying it.
 */
const listings = perFetch(() => new Map<string, ModelInfo[]>());

/**
 * Per model server, the models whose last listing gave only the trained context window, by id.
 *
 * @remarks
 * Kept beside `listings` rather than on `ModelInfo`, so what `listModels` hands back is the shape
 * it has always been. Replaced with each listing that lands, and left alone by one that fails.
 */
const trainedOnly = perFetch(() => new Map<string, Set<string>>());

/**
 * When a model server was last asked about a model it did not name, keyed on the two together.
 *
 * @remarks
 * `contextLimitFor` asks again whenever the listing does not hold the model, which is right for
 * a model that arrives late and wrong for one that is never coming. The second is the ordinary
 * case rather than the exotic one — a llama.cpp box served under a `-a` alias that does not
 * match the configured name, an OpenRouter `:free` suffix, a typo in a settings row — and there
 * every call fetches the listing, re-reads it, finds the same absence and answers the same zero.
 *
 * Remembering the miss for a moment answers both: within `listingMissMs` nobody is asked, and
 * after it the model server is asked again, so an `ollama pull` on a box that has been up a week is
 * picked up within the minute instead of at the next restart. Bounded by the (model server, model)
 * pairs actually asked about, which is the bound the listings themselves have.
 */
const misses = perFetch(() => new Map<string, number>());

/**
 * What counts as one model server inside each `perFetch` copy, everywhere in this package that
 * remembers something about one: the clients, the listings and served windows, and, through its
 * digest `endpointId`, the capability latches and calibration.
 *
 * @param config - Read for `baseUrl` and `apiKey` alone, and the key is optional here where
 * `Endpoint` requires it: absent and empty already mean the same thing. The `fetch` picks the copy
 * this is looked up in, and the timeout is not part of the model server.
 * @returns The URL as `baseUrlKey` writes it and the key, as one JSON string, the key in the clear.
 *
 * @remarks
 * The URL and the key together, because the key is part of what is on the other end rather than
 * only how it is paid for: a router is free to send two keys to two different backends. Absent
 * reads as `NO_KEY`, and the URL is normalised, so `…/v1/` and `…/v1` are one entry rather than
 * two. Stringified rather than joined on a separator, since no character is impossible in a URL
 * or a key; `endpointId` is the one to write down.
 */
export const endpointKey = (config: EndpointIdentity) =>
  JSON.stringify([baseUrlKey(config.baseUrl), config.apiKey || NO_KEY]);

/**
 * One model on one model server, as every per-model cache keys it: stringified, so neither half
 * runs into the other.
 *
 * @param endpoint - Whatever the cache names a model server by — `endpointKey` here,
 * `endpointId` where the key may be written down.
 * @param model - The model's name as the model server knows it.
 * @returns The pair as a JSON array, which `JSON.parse` takes apart again.
 */
export const modelKey = (endpoint: string, model: string) => JSON.stringify([endpoint, model]);

/**
 * `endpointKey` hashed, for the remembered facts that can leave the process.
 *
 * @param config - Read for `baseUrl` and `apiKey` alone, as `endpointKey` reads it.
 * @returns The digest of that model server's `endpointKey`: the same for the same URL and key in
 * any process, and no key to be read out of it.
 *
 * @remarks
 * What a model server refused is exported by `exportCapabilities` to be written into a settings row
 * or a file, and a key inside that blob is a credential copied somewhere nobody meant to keep one.
 * A digest identifies the same model server on the next boot without saying what the key was, and
 * it is how an app finds its own model server's entry in a `CapabilitySnapshot`.
 */
export const endpointId = (config: EndpointIdentity) => digestOf(endpointKey(config));

/**
 * Served context windows found by asking a server's own API, keyed on model server and model.
 *
 * @remarks
 * Every answer, a window included, stands for `listingMissMs`, the timer the slot count read from
 * the same `/props` answer is on: a server restarted with another `-c` must not be sized by its
 * old window for the life of the process.
 */
const served = perFetch(() => new Map<string, { window: number; at: number }>());

/**
 * Slot counts read off llama.cpp's `/props`, keyed on model server and model as `served` is.
 *
 * @remarks
 * `gone` is a server without the route, which is not asked again until `resetClients`. Any other
 * answer, a count included, stands for `listingMissMs`: a server restarted with another
 * `--parallel` must not be sent a slot it no longer has for the life of the process.
 */
const slotCounts = perFetch(() => new Map<string, { slots: number; at: number; gone: boolean }>());

/**
 * Remembers what a `/props` answer said of its slots.
 *
 * @param config - Read for `fetch` alone, which picks the copy of `slotCounts` written to.
 * @param key - The model server and model, by `modelKey`.
 * @param props - How `/props` answered, as `probe` hands it over.
 */
function noteSlots(config: Pick<Endpoint, 'fetch'>, key: string, props: { missing: boolean; body?: unknown }) {
  const { total_slots } = (props.body ?? {}) as { total_slots?: unknown };
  slotCounts(config.fetch).set(key, { slots: positive(total_slots), at: Date.now(), gone: props.missing });
}

/**
 * The path `/props` is asked on, naming the model for a llama.cpp router serving several.
 *
 * @param model - The model's name as the model server knows it.
 * @returns The path and its query. A single-model server ignores the query.
 */
const propsPath = (model: string) => `/props?model=${encodeURIComponent(model)}`;

/** Model servers with neither native route, which are not asked for either again. */
const unserved = perFetch(() => new Set<string>());

/**
 * Model servers whose `/api/v0/models` answered with an error, and when.
 *
 * @remarks
 * `gone` is a route the server does not have (`NOT_THERE`), which is a fact about the server and
 * stands until `resetClients`. Any other error stands for `listingMissMs` only, because it may be
 * one the server gets over, and LM Studio latched for good on a passing 5xx would have no context
 * window at all until the process restarted, its listing carrying none.
 *
 * Per model server and on its own, whatever `/props` said: a server whose `/props` answers without
 * a context window is never `unserved`, and without this its missing route was asked again with
 * every miss.
 */
const refusals = perFetch(() => new Map<string, { at: number; gone: boolean }>());

/**
 * Whether an answer a model server gave still stands, which it does for `listingMissMs`.
 *
 * @param at - When the answer was given, in ms since the epoch.
 * @returns `true` inside `listingMissMs` of `at`, and `false` once it has passed.
 */
const isAnswerFresh = (at: number) => Date.now() - at < poolLimits().listingMissMs;

/**
 * Whether `/api/v0/models` is to be left alone on this model server for now.
 *
 * @param config - Read for `fetch` alone, which picks the copy of `refusals` read.
 * @param endpoint - The model server, by `endpointKey`.
 * @returns `true` where the route last answered as one the server does not have, or with any other
 * error inside `listingMissMs`; `false` for a model server with no error on record.
 */
const refused = (config: Pick<Endpoint, 'fetch'>, endpoint: string) => {
  const refusal = refusals(config.fetch).get(endpoint);
  return refusal !== undefined && (refusal.gone || isAnswerFresh(refusal.at));
};

/**
 * The signal every request of one lookup is made under, so the lookup is bounded as a whole.
 *
 * @param config - Read for `requestTimeoutSeconds`, which bounds the lookup where it is shorter
 * than `lookupTimeoutMs`.
 * @param [signal] - The caller's own, which aborts the lookup with its reason.
 * @returns A signal that fires with a `TimeoutError` at the bound or with the caller's reason,
 * whichever is first. Never fires where neither is set.
 */
const lookupSignal = (config: Pick<Endpoint, 'requestTimeoutSeconds'>, signal?: AbortSignal): AbortSignal => {
  const boundMs = Math.min(idleTimeoutMs(config) ?? Number.POSITIVE_INFINITY, poolLimits().lookupTimeoutMs);
  const bound = Number.isFinite(boundMs) ? [AbortSignal.timeout(boundMs)] : [];
  return AbortSignal.any([...bound, ...(signal ? [signal] : [])]);
};

/**
 * The server root behind an OpenAI-compatible base URL, which is where the native APIs live.
 *
 * @param baseUrl - The base URL as configured. Not trimmed of whitespace.
 * @returns The URL less its trailing slashes and then one trailing `/v1`; one that ends in neither
 * comes back as given.
 */
const rootOf = (baseUrl: string) => baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');

/** A route this server does not have, rather than one that failed to answer. */
const NOT_THERE: ReadonlySet<number> = new Set([
  HttpStatus.NotFound,
  HttpStatus.MethodNotAllowed,
  HttpStatus.NotImplemented,
]);

/**
 * The headers that carry a model server's key, and none where it has none.
 *
 * @param apiKey - The key as configured. Empty, absent and `NO_KEY` all mean there is none.
 * @returns A bearer `authorization` header, or no headers at all.
 *
 * @remarks
 * `NO_KEY` is the SDK's placeholder, not a credential, and a request made outside the SDK has no
 * reason to send it: a server that checks keys refuses `Bearer agent-core` as it refuses a wrong
 * one, where it might have answered an unauthenticated route.
 */
const authHeaders = (apiKey?: string): Record<string, string> =>
  apiKey && apiKey !== NO_KEY ? { authorization: `Bearer ${apiKey}` } : {};

/**
 * Asks one native endpoint.
 *
 * @param config - The model server. Its key goes as a bearer token where it has one other than
 * `NO_KEY`.
 * @param path - The route and its query, from the server root rather than from the base URL.
 * @param within - The lookup's signal. Fired, the request throws as an unreachable server does.
 * @returns How the server answered, with `body` only for a 2xx that parsed as JSON.
 *
 * @remarks
 * `failed` is any answer that was not a 2xx, or was not JSON, and `missing` the ones among them
 * that mean a server without the route; `body` is absent for all of them. A server that could not
 * be reached throws.
 *
 * A 2xx that is not JSON is a missing route rather than a route with nothing to say. It is what a
 * proxy with a web app of its own answers on every path it does not route — llm-router serves its
 * `index.html` for `/props` with a 200 — and read as "no context window" it was asked again every
 * `listingMissMs` instead of being latched as a server without the route.
 */
async function probe(
  config: Endpoint,
  path: string,
  within: AbortSignal,
): Promise<{ failed: boolean; missing: boolean; body?: unknown }> {
  const response = await sender(config)(`${rootOf(config.baseUrl)}${path}`, {
    headers: authHeaders(config.apiKey),
    signal: within,
  });
  if (!response.ok) {
    return { failed: true, missing: NOT_THERE.has(response.status) };
  }
  try {
    return { failed: false, missing: false, body: await response.json() };
  } catch {
    // A fired signal surfaces here too, mid-body, and is a server that stopped answering.
    within.throwIfAborted();
    return { failed: true, missing: true };
  }
}

/** What a lookup takes besides the server: `listModels`, `servedWindow` and `contextLimitFor`. */
export interface LookupOptions {
  /** Abandons the lookup, which then rejects with the signal's reason and remembers nothing. */
  signal?: AbortSignal;
}

/**
 * The context window a local server's own API says it is serving a model in, for the servers whose
 * listing does not say.
 *
 * @param config - The model server, plus the model whose context window is wanted.
 * @param [options] - Cancellation. See `LookupOptions`.
 * @returns The context window in tokens, or zero where none was found. Rejects only with the reason
 * of `options.signal`: a server that could not be reached answers zero too.
 *
 * @remarks
 * llama.cpp reports it on `/props` as `default_generation_settings.n_ctx`, and LM Studio on
 * `/api/v0/models` as `loaded_context_length`; either can be smaller than the trained context
 * window, which would let an overflow through the guard. What it answers, zero included, is
 * remembered for `listingMissMs`, a server without either route is latched, and one that could not
 * be reached is not remembered (README, "Sizing a request before sending it"). The listing is not
 * read here: `contextLimitFor` reads it first.
 */
export async function servedWindow(
  config: Endpoint & { model: string },
  { signal }: LookupOptions = {},
): Promise<number> {
  const window = await readServed(config, lookupSignal(config, signal));
  signal?.throwIfAborted();
  return window;
}

/**
 * `servedWindow` under a lookup's signal, which `contextLimitFor` shares with its listing.
 *
 * @param config - The model server, plus the model whose context window is wanted.
 * @param within - The lookup's signal. Fired, the answer is zero and nothing is remembered.
 * @returns The context window in tokens, or zero where none was found. Never rejects.
 */
async function readServed(config: Endpoint & { model: string }, within: AbortSignal): Promise<number> {
  const endpoint = endpointKey(config);
  if (unserved(config.fetch).has(endpoint)) {
    return 0;
  }
  const key = modelKey(endpoint, config.model);
  const known = served(config.fetch).get(key);
  if (known && isAnswerFresh(known.at)) {
    return known.window;
  }

  let window = 0;
  try {
    const props = await probe(config, propsPath(config.model), within);
    noteSlots(config, key, props);
    const settings = (props.body as { default_generation_settings?: { n_ctx?: unknown } })?.default_generation_settings;
    window = positive(settings?.n_ctx);
    if (!window) {
      if (!refused(config, endpoint)) {
        const lmstudio = await probe(config, '/api/v0/models', within);
        if (lmstudio.failed) {
          refusals(config.fetch).set(endpoint, { at: Date.now(), gone: lmstudio.missing });
        } else {
          refusals(config.fetch).delete(endpoint);
        }
        const { data } = (lmstudio.body ?? {}) as { data?: unknown };
        const entry = Array.isArray(data)
          ? (data as { id?: unknown; loaded_context_length?: unknown }[]).find((model) => model?.id === config.model)
          : undefined;
        window = positive(entry?.loaded_context_length);
      }
      if (props.missing && refusals(config.fetch).get(endpoint)?.gone) {
        unserved(config.fetch).add(endpoint);
        return 0;
      }
    }
  } catch {
    return 0;
  }
  served(config.fetch).set(key, { window, at: Date.now() });
  return window;
}

/**
 * How many slots a llama.cpp server runs a model in, for pinning a session to one of them.
 *
 * @param config - The model server, plus the model the requests will name.
 * @param [options] - Cancellation. See `LookupOptions`.
 * @returns `total_slots` from `/props`, or zero where the server has no such route or did not say.
 * Rejects only with the reason of `options.signal`: a server that could not be reached answers zero.
 *
 * @remarks
 * The same request `servedWindow` makes, so an exchange that has sized its context window has the
 * count without a second one. A count stands for `listingMissMs`, and a server without `/props` is
 * not asked again until `resetClients`. Zero is what every server but llama.cpp answers, and leaves
 * an exchange unpinned.
 */
export async function servedSlots(
  config: Endpoint & { model: string },
  { signal }: LookupOptions = {},
): Promise<number> {
  const slots = await readSlots(config, lookupSignal(config, signal));
  signal?.throwIfAborted();
  return slots;
}

/**
 * `servedSlots` under a lookup's signal.
 *
 * @param config - The model server, plus the model the requests will name.
 * @param within - The lookup's signal. Fired, the answer is zero and nothing is remembered.
 * @returns The slot count, or zero. Never rejects.
 */
async function readSlots(config: Endpoint & { model: string }, within: AbortSignal): Promise<number> {
  const endpoint = endpointKey(config);
  if (unserved(config.fetch).has(endpoint)) {
    return 0;
  }
  const key = modelKey(endpoint, config.model);
  const known = slotCounts(config.fetch).get(key);
  const answerStands = known && (known.gone || isAnswerFresh(known.at));
  if (answerStands) {
    return known.slots;
  }
  try {
    noteSlots(config, key, await probe(config, propsPath(config.model), within));
  } catch {
    return 0;
  }
  return slotCounts(config.fetch).get(key)?.slots ?? 0;
}

/**
 * Asks a model server what it serves, and remembers the answer.
 *
 * @param config - The model server to ask. Remembered per base URL and key, not per model.
 * @param [options] - Cancellation. See `LookupOptions`.
 * @returns The models in order of id, whatever order the model server listed them in. Rejects with
 * the reason of `options.signal` where that stopped it, a `TimeoutError` at `lookupTimeoutMs`, and
 * the request's own error otherwise.
 */
export function listModels(config: Endpoint, { signal }: LookupOptions = {}): Promise<ModelInfo[]> {
  return readListing(config, lookupSignal(config, signal));
}

/**
 * `listModels` under a lookup's signal, which `contextLimitFor` shares with the native routes.
 *
 * @param config - The model server to ask.
 * @param within - The lookup's signal. Fired, the listing rejects with its reason.
 * @returns The models in order of id. A listing that fails leaves the last one remembered.
 */
async function readListing(config: Endpoint, within: AbortSignal): Promise<ModelInfo[]> {
  const { data } = await getClient(config)
    .models.list({ signal: within })
    .catch((error: unknown) => {
      // The SDK throws an abort error of its own, whatever the signal's reason was.
      within.throwIfAborted();
      throw error;
    });
  const trained = new Set<string>();
  const models: ModelInfo[] = [];
  for (const model of data) {
    const window = contextLengthOf(model);
    if (window.trained) {
      trained.add(model.id);
    }
    models.push({ id: model.id, contextLength: window.contextLength });
  }
  models.sort((a, b) => byCodeUnit(a.id, b.id));
  const key = endpointKey(config);
  listings(config.fetch).set(key, models);
  trainedOnly(config.fetch).set(key, trained);
  return models;
}

/** Why `probeEndpoint` could not list a model server's models, in words a form can branch on. */
export const ProbeFailure = {
  /** Not an http or https URL, or one with credentials, a query or a fragment in it. */
  InvalidUrl: 'invalid-url',
  /** Nothing answered: no such host, a refused connection, a TLS failure. */
  Unreachable: 'unreachable',
  /** Something answered, but not inside the lookup's bound. */
  Timeout: 'timeout',
  /** A 401 or a 403: the key is wrong, or one is needed. */
  Unauthorized: 'unauthorized',
  /** A redirect, which is not followed, so the key is never carried to a host nobody typed. */
  Redirected: 'redirected',
  /** An answer that is not a model listing: no such route, a web page, JSON of another shape. */
  NotOpenAi: 'not-openai',
  /** Any other error status, which is on the error as `status`. */
  Failed: 'failed',
} as const;
export type ProbeFailure = (typeof ProbeFailure)[keyof typeof ProbeFailure];

/**
 * `probeEndpoint` could not list a model server's models; `kind` says why.
 *
 * @remarks
 * The message is a sentence for a person, naming the model server by its origin only, so it can go
 * under a form field as it is. `kind` is for a form that words it itself.
 */
export class EndpointProbeError extends Error {
  override readonly name: string = 'EndpointProbeError';
  readonly kind: ProbeFailure;
  /** The HTTP status, where the model server answered with one. */
  readonly status?: number;

  /**
   * @param kind - Why the listing failed.
   * @param message - The same, as a sentence.
   * @param [status] - The status the model server answered with, where it answered.
   */
  constructor(kind: ProbeFailure, message: string, status?: number) {
    super(message);
    this.kind = kind;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

/** What `probeEndpoint` takes besides the model server. */
export interface ProbeOptions extends LookupOptions {
  /** How many models come back at most, the first by id. Defaults to `PROBE_MODEL_LIMIT`. */
  limit?: number;
}

/** How many models `probeEndpoint` hands back unless told otherwise: enough for any picker. */
const PROBE_MODEL_LIMIT = 500;

/** The statuses that mean the key, not the server, is what is wrong. */
const UNAUTHORIZED: ReadonlySet<number> = new Set([HttpStatus.Unauthorized, HttpStatus.Forbidden]);

/** The range a redirect is answered in. */
const REDIRECT_MIN = 300;
const REDIRECT_MAX = 399;

/**
 * Asks a model server nobody has saved yet which models it serves, for a form a person is typing it
 * into.
 *
 * @param endpoint - The model server as typed. Its key goes as a bearer token where it has one
 * other than `NO_KEY`; its `requestTimeoutSeconds` bounds the request where that is shorter than
 * `lookupTimeoutMs`; its `fetch`, where it has one, sends the request.
 * @param [options] - Cancellation, and how many models to hand back. See `ProbeOptions`.
 * @returns The models in order of id, one entry per id, at most `options.limit` of them. Rejects
 * with the reason of `options.signal` where that stopped it, and with an `EndpointProbeError`
 * for every other failure.
 *
 * @remarks
 * `listModels` is for a model server that is configured: it pools a client per URL and remembers
 * the listing, and a form asking at every keystroke would leave a client and a listing behind for
 * each half-typed URL. This makes one plain request and remembers nothing, so asking again asks
 * again.
 *
 * Redirects are not followed, so a typed key is never carried on to a host nobody typed. Both
 * listing shapes are read: OpenAI's `{ data: [...] }` by `id`, and Ollama's native
 * `{ models: [...] }` by `name` where an entry has no `id`. A context window is read from the keys
 * `contextLimitFor` reads, and an id listed twice keeps the one of its entries stated.
 */
export async function probeEndpoint(
  endpoint: EndpointIdentity & Pick<Endpoint, 'requestTimeoutSeconds' | 'fetch'>,
  { signal, limit = PROBE_MODEL_LIMIT }: ProbeOptions = {},
): Promise<ModelInfo[]> {
  const baseUrl = normalizeBaseUrl(endpoint.baseUrl);
  if (baseUrl === null) {
    throw new EndpointProbeError(
      ProbeFailure.InvalidUrl,
      'A base URL is http:// or https://, with no credentials, query or fragment in it.',
    );
  }
  const url = new URL(`${baseUrl}/models`);
  const within = lookupSignal(endpoint, signal);
  /** The failure for a request that threw: the caller's stop, the bound, or no answer at all. */
  const thrown = () => {
    signal?.throwIfAborted();
    return within.aborted
      ? new EndpointProbeError(ProbeFailure.Timeout, `${url.origin} did not answer in time.`)
      : new EndpointProbeError(ProbeFailure.Unreachable, `Could not reach ${url.origin}.`);
  };

  let response: Response;
  try {
    response = await sender(endpoint)(url, {
      headers: authHeaders(endpoint.apiKey),
      signal: within,
      redirect: 'manual',
    });
  } catch {
    throw thrown();
  }
  const { status } = response;
  // A browser hands a refused redirect back as an opaque response with status zero.
  const isRedirect = response.type === 'opaqueredirect' || (status >= REDIRECT_MIN && status <= REDIRECT_MAX);
  if (isRedirect) {
    const location = response.headers.get('location');
    throw new EndpointProbeError(
      ProbeFailure.Redirected,
      `${url.origin} redirected the request${location ? ` to ${location}` : ''}; use the URL it redirects to.`,
      status || undefined,
    );
  }
  if (UNAUTHORIZED.has(status)) {
    throw new EndpointProbeError(ProbeFailure.Unauthorized, `${url.origin} refused the key (${status}).`, status);
  }
  if (NOT_THERE.has(status)) {
    throw new EndpointProbeError(
      ProbeFailure.NotOpenAi,
      `${url.origin} has no model listing there (${status}); is the base URL missing a /v1?`,
      status,
    );
  }
  const requestFailed = response.ok === false;
  if (requestFailed) {
    throw new EndpointProbeError(
      ProbeFailure.Failed,
      `${url.origin} answered ${status} when asked for its models.`,
      status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (within.aborted) {
      throw thrown();
    }
    body = undefined;
  }
  const { data, models } = (body ?? {}) as { data?: unknown; models?: unknown };
  const rows = Array.isArray(data) ? data : Array.isArray(models) ? models : undefined;
  if (rows === undefined) {
    throw new EndpointProbeError(ProbeFailure.NotOpenAi, `${url.origin} did not answer with a list of models.`);
  }

  const found = new Map<string, ModelInfo>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') {
      continue;
    }
    const entry = row as { id?: unknown; name?: unknown };
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : '';
    if (id === '') {
      continue;
    }
    const { contextLength } = contextLengthOf(row);
    found.set(id, { id, contextLength: contextLength || (found.get(id)?.contextLength ?? 0) });
  }
  return [...found.values()].sort((a, b) => byCodeUnit(a.id, b.id)).slice(0, limit);
}

/**
 * How much a model will read, in tokens. Zero means nobody knows.
 *
 * @param config - The model server, plus the model whose context window is wanted.
 * @param [declared] - The operator's own number. Above zero it wins and the server is not asked.
 * @param [options] - Cancellation. See `LookupOptions`.
 * @returns The context window in tokens, or zero. Rejects only with the reason of `options.signal`:
 * a listing or a native route that failed, or the lookup running out of `lookupTimeoutMs`, is an
 * unknown context window.
 *
 * @remarks
 * `declared` wins outright, because a server can list the context window a model was built with
 * while serving it in a much smaller one. Otherwise the listing goes first, as the one route every
 * server has, and the server's own API (`servedWindow`) is asked only where it did not settle the
 * question (README, "Sizing a request before sending it").
 */
export async function contextLimitFor(
  config: Endpoint & { model: string },
  declared = 0,
  { signal }: LookupOptions = {},
): Promise<number> {
  if (declared > 0) {
    return declared;
  }
  const key = endpointKey(config);
  // One signal for the listing and the native routes, so three silent requests wait once.
  const within = lookupSignal(config, signal);
  const listed = () =>
    listings(config.fetch)
      .get(key)
      ?.find((model) => model.id === config.model);
  // Asked again when the listing does not name this model, not only when there is none: models
  // arrive after a process starts, and a zero cached until a restart costs the meter and compaction.
  if (!listed()) {
    const missKey = modelKey(key, config.model);
    const asked = misses(config.fetch).get(missKey);
    // Asked again, but not on every call. A model that is never coming answers the same zero
    // however often the model server is asked, and a caller sizing a context window per turn pays a
    // round trip for each of them; `listingMissMs` is how long that answer is allowed to stand.
    const shouldAskAgain = asked === undefined || isAnswerFresh(asked) === false;
    if (shouldAskAgain) {
      // A failure is not remembered: a model server that was down when the last exchange started is
      // not a model server with no models, and a context window nobody could ask about is not a
      // failed exchange.
      const answered = await readListing(config, within).then(
        () => true,
        () => false,
      );
      signal?.throwIfAborted();
      // Recorded where the model server was actually asked, and only there. Stamping it on the
      // calls that skipped the request would push the deadline out ahead of any caller polling
      // faster than the interval, which is a memory that never expires rather than one that expires
      // in half a minute.
      if (answered) {
        if (listed()) {
          misses(config.fetch).delete(missKey);
        } else {
          misses(config.fetch).set(missKey, Date.now());
        }
      }
    }
  }
  const entry = listed();
  const fromListing = entry?.contextLength ?? 0;
  // A top-level key settles it. A trained context window does not: llama.cpp lists the one the
  // model was built with, and taking it over what `/props` says lets an overflow through the guard.
  if (fromListing > 0 && !trainedOnly(config.fetch).get(key)?.has(config.model)) {
    return fromListing;
  }
  const window = await readServed(config, within);
  signal?.throwIfAborted();
  return window > 0 ? window : fromListing;
}

/**
 * Forgets every cached client, model listing and answer from a server's own routes, and puts
 * `configureClients` back to the defaults.
 *
 * @remarks
 * The answers are the served context windows, the slot counts, and the routes that failed or are
 * not there. For tests, and for a settings change under test.
 */
export function resetClients() {
  poolLimits.reset();
  clients.reset();
  listings.reset();
  misses.reset();
  trainedOnly.reset();
  served.reset();
  slotCounts.reset();
  unserved.reset();
  refusals.reset();
}

/**
 * Whether two base URLs are one model server, by `baseUrlKey`.
 *
 * @param a - The URL as one row has it.
 * @param b - The URL as the other has it.
 * @returns `true` where the two differ in nothing but surrounding whitespace, trailing slashes, the
 * case of the scheme and host, and a default port. A path's case counts, and so does a `/v1`.
 */
export const sameUrl = (a: string, b: string) => baseUrlKey(a) === baseUrlKey(b);

/**
 * The key to send, where a model server may inherit one from the settings it overrides.
 *
 * @param own - The model server as the agent or profile states it. Its own key always wins. An
 * empty or absent `baseUrl` is one that inherits the model server too.
 * @param [inherited] - The settings it overrides. Absent treats `own` as the configured model
 * server, so only its key and the environment's are in play.
 * @param [env] - Where `OPENAI_API_KEY` is read from.
 * @returns The key, never empty: `own`'s, else `NO_KEY` for a model server other than the inherited
 * one, else the inherited key, then the environment's, then `NO_KEY`.
 *
 * @remarks
 * A credential issued for one model server has no business being posted to another. A profile that
 * names its own `baseUrl` and no key of its own is sent `NO_KEY` — not the operator's key, and
 * not `$OPENAI_API_KEY` — because "I pointed an agent at a friend's server and it sent my OpenAI
 * key" is not a mistake worth being able to make, and a local server wants no key anyway. One on
 * the same model server inherits the key as it inherits everything else, and the environment is the
 * last word on the model server that was configured rather than overridden.
 */
export function resolveApiKey(
  own: { baseUrl?: string; apiKey?: string },
  inherited?: EndpointIdentity,
  env: Record<string, string | undefined> = process.env,
): string {
  if (own.apiKey) {
    return own.apiKey;
  }
  const baseUrl = own.baseUrl?.trim();
  const isOtherServer = inherited && baseUrl && sameUrl(baseUrl, inherited.baseUrl) === false;
  if (isOtherServer) {
    return NO_KEY;
  }
  return inherited?.apiKey || env.OPENAI_API_KEY || NO_KEY;
}
