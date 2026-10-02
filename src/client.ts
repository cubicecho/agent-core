import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { Endpoint, EndpointIdentity, RetryPolicy } from "./config.ts";
import { isPositive } from "./guards.ts";
import { assignSettings, scoped } from "./scope.ts";

/**
 * The SDK insists on a non-empty key even where the server will not look at it. This is what it
 * gets. It also reads as "this endpoint has no key" at a call site, which an empty string does
 * not — a caller must not let a local endpoint silently borrow the key meant for a paid one.
 */
export const NO_KEY = "agent-core";

/** A wait in the SDK's spelling: milliseconds, and `undefined` where zero or less means no limit. */
const limitMs = (seconds: number) => (seconds > 0 ? seconds * 1000 : undefined);

/**
 * Zero, less, or absent means no limit, which the SDK spells as `undefined`.
 *
 * @param config Read for `requestTimeoutSeconds` alone.
 */
export const timeoutMs = (config: Pick<Endpoint, "requestTimeoutSeconds">): number | undefined =>
  limitMs(config.requestTimeoutSeconds ?? 0);

/**
 * How long to wait out a model that is still loading, in milliseconds — `undefined` where the
 * config has no opinion, and zero where it says not to wait at all.
 *
 * Zero rather than the SDK's `undefined` for "no wait", because here absent already means
 * something else: `runTurn`'s own default.
 *
 * @param config Read for `loadingTimeoutSeconds` alone. Zero or less is no wait.
 */
export const loadingMs = (
  config: Pick<RetryPolicy, "loadingTimeoutSeconds">,
): number | undefined =>
  config.loadingTimeoutSeconds === undefined
    ? undefined
    : (limitMs(config.loadingTimeoutSeconds) ?? 0);

/**
 * A client per endpoint, made once and kept.
 *
 * The SDK holds its own connection pool, and a run makes a request per tool iteration on top of
 * whatever side tasks it asks for — building a fresh client for each of them throws that pool
 * away every time. A map rather than the single slot it would otherwise be, because agents each
 * name their own endpoint: two running side by side on different servers would evict each
 * other's client on every request.
 *
 * `maxRetries: 0` turns the SDK's own retrying off. Streaming is what this is for, and a stream
 * that has already emitted tokens must not be replayed from the top — the caller knows whether
 * anything has been produced yet and the SDK does not. See `retry.ts`.
 *
 * Bounded, because a cache is only a cache while its keys are. Insertion order is the whole of
 * the eviction: a `Map` iterates oldest-first, and `getClient` re-inserts on a hit.
 */
const clients = scoped(() => new Map<string, OpenAI>());

/**
 * How many endpoints' clients are kept at once, until `configureClients` moves it.
 *
 * This is a backstop rather than a design. The key includes the API key, and every argument in
 * this file for what bounds these caches is "a settings row's worth" — true of the deployments
 * this was written for, and false the moment a consumer mints a key per *user*, where the map
 * grows one client and one connection pool per tenant for the life of the process with
 * `resetClients` as the only release.
 *
 * Thirty-two is far more endpoints than a settings table holds, so a deployment-shaped consumer
 * never reaches it, and an evicted client costs its connection pool and nothing else — the next
 * request through that endpoint builds another. See `getClient` for the constraint stated as a
 * constraint.
 */
const MAX_CLIENTS = 32;

/** How long a model an endpoint did not list stays unlisted before it is asked about again. */
const LISTING_MISS_MS = 30_000;

/** What the client pool is held to across a process. Every field optional; see `configureClients`. */
export interface ClientPoolOptions {
  /** How many endpoints' clients are kept at once. The least recently asked for goes first. */
  maxClients?: number;
  /**
   * How long, in milliseconds, a model an endpoint did not list — or a server that answered
   * without a served window, or whose `/api/v0/models` answered with an error other than a
   * missing route — is taken at its word before the endpoint is asked again.
   */
  listingMissMs?: number;
}

/** The numbers this module was written with. */
const CLIENT_DEFAULTS: Required<ClientPoolOptions> = {
  maxClients: MAX_CLIENTS,
  listingMissMs: LISTING_MISS_MS,
};

/** What is in force now. Read where it is used, so a change applies from the next call. */
const poolLimits = scoped((): Required<ClientPoolOptions> => ({ ...CLIENT_DEFAULTS }));

/**
 * Drops the least recently asked-for clients until the pool fits. Nothing is closed on the way
 * out: the SDK holds no handle a caller can release, and an evicted client is garbage once
 * whatever request is still in flight on it has finished — dropping the reference is the whole
 * of the eviction.
 */
const evict = () => {
  for (const oldest of clients().keys()) {
    if (clients().size <= poolLimits().maxClients) break;
    clients().delete(oldest);
  }
};

/**
 * Changes what the client pool is held to, for a process whose endpoints are not shaped like the
 * deployments these defaults were chosen for.
 *
 * One setting per runtime for the same reason `configureEvents` is: the pool is one thing per
 * runtime, and its size is a deployment's setting, said once at startup. A multi-tenant host
 * keying on a key per user raises `maxClients` so its tenants stop evicting each other's
 * connection pools, or gives each tenant a `createRuntime` of its own; a dev box shortens
 * `listingMissMs` so a model it has just pulled is seen sooner.
 *
 * A `maxClients` below the pool's current size evicts down to it at once, least recently asked
 * for first, as the next `getClient` would have. A shorter `listingMissMs` applies to misses
 * already remembered, since each is a timestamp compared against it when read.
 *
 * @param options The bounds to change. A field left out — or given anything that is not a number
 * above zero — keeps what it has, so a half-built config narrows nothing. `Infinity` is a number
 * above zero: as `maxClients` it lifts the bound, and as `listingMissMs` a miss is never asked
 * about again until `resetClients`.
 * @returns Everything in force afterwards, including what this call did not change.
 */
export function configureClients(options: ClientPoolOptions = {}): Required<ClientPoolOptions> {
  const inForce = assignSettings(poolLimits(), options);
  evict();
  return inForce;
}

/** How many idle windows the first chunk gets when `firstTokenSeconds` is not given. */
export const FIRST_TOKEN_FACTOR = 5;

/**
 * The wait for a streamed turn's first chunk, in the SDK's spelling: `undefined` is no limit.
 *
 * @param config Read for `firstTokenSeconds`, and `requestTimeoutSeconds` where that is absent.
 */
export const firstTokenMs = (
  config: Pick<Endpoint, "requestTimeoutSeconds" | "firstTokenSeconds">,
): number | undefined => {
  if (config.firstTokenSeconds === undefined) {
    const idle = timeoutMs(config);
    return idle === undefined ? undefined : idle * FIRST_TOKEN_FACTOR;
  }
  return limitMs(config.firstTokenSeconds);
};

/**
 * The client for an endpoint, built once and kept.
 *
 * Pooled on the three fields that change how a request is sent, so agents sharing a server share
 * a connection and agents on different servers never share a client.
 *
 * The pool is per *deployment*, not per request: what belongs in this map is an endpoint an
 * operator configured, and everything cached in this package is bounded on that reading. A
 * consumer that mints an API key per user still gets a working client, but it is churning
 * connection pools rather than sharing them and holding every one of them — `maxClients` keeps
 * that from being unbounded, and it is the point at which a client of your own, built and held
 * per tenant, is the better answer than this.
 *
 * @param config Where to send requests and how long to wait. An absent `apiKey` becomes `NO_KEY`.
 */
export function getClient(config: Endpoint): OpenAI {
  const apiKey = config.apiKey || NO_KEY;
  const timeout = timeoutMs(config);
  // Stringified rather than joined on a separator: no character is impossible in a URL or a
  // key, and two different endpoints must never resolve to the same cached client.
  const key = JSON.stringify([config.baseUrl, apiKey, timeout]);
  const existing = clients().get(key);
  if (existing) {
    // Re-inserted so it counts as the youngest. A `Map` keeps insertion order and hands the
    // oldest key over first, which is the whole of the LRU below.
    clients().delete(key);
    clients().set(key, existing);
    return existing;
  }
  const client = new OpenAI({ baseURL: config.baseUrl, apiKey, timeout, maxRetries: 0 });
  clients().set(key, client);
  evict();
  return client;
}

/**
 * The context window, spelled every way a server spells it at the top of a listing entry.
 *
 * None of these is in the OpenAI listing schema, so every server that says anything says it as
 * an extra key of its own: `max_model_len` is vLLM, `context_length` OpenRouter, `n_ctx` the raw
 * llama bindings. Whichever turns up first is taken — a server reporting two of them is
 * reporting the same number twice. llama.cpp puts its number under `meta` instead, and LM Studio
 * and Ollama put none on this route at all; see `servedWindow`.
 */
const CONTEXT_KEYS = [
  "context_length",
  "max_context_window",
  "max_model_len",
  "context_window",
  "n_ctx",
];

const positive = (value: unknown) => (isPositive(value) ? value : 0);

/**
 * A listing entry's window, and whether it is only the one the model was trained with.
 *
 * The two are told apart because they are trusted differently: a top-level key is taken as the
 * window being served and settles the lookup, and a trained one is a ceiling the server may be
 * running well under, so `contextLimitFor` still asks the native routes before settling for it.
 */
function contextLengthOf(model: object): { contextLength: number; trained: boolean } {
  const record = model as Record<string, unknown>;
  for (const key of CONTEXT_KEYS) {
    const value = positive(record[key]);
    if (value) return { contextLength: value, trained: false };
  }
  // llama.cpp's, and the window the model was trained with rather than the one it is served in:
  // a 256k model started at `-c 16384` lists 262144 here. Better than nothing, and why the
  // served window is still asked for after it. `meta` is `null` while the model loads.
  const meta = record.meta as Record<string, unknown> | null | undefined;
  const contextLength = positive(meta?.n_ctx_train);
  return { contextLength, trained: contextLength > 0 };
}

/**
 * A model an endpoint offers, and what it says the model will read. Zero means it did not say.
 *
 * The number is whatever the listing carried, which from llama.cpp is the trained window rather
 * than the served one; `contextLimitFor` is the lookup that knows the difference.
 */
export interface ModelInfo {
  id: string;
  contextLength: number;
}

/**
 * The last listing from each endpoint, so a run can size its window without a round trip.
 *
 * Keyed by `endpointKey`, because two endpoints are two different sets of models and one of
 * them having answered says nothing about the other — and because a key can be the difference
 * between what a router will show one caller and another.
 *
 * The timeout is deliberately not in it, which is where this key parts company with the
 * clients'. Which models a server offers has nothing to do with how long we are willing to wait
 * for it, so two settings rows differing only there ask once between them rather than twice.
 *
 * It is only ever a cache of something asked for anyway, and a listing that fails leaves
 * whatever was there rather than emptying it.
 */
const listings = scoped(() => new Map<string, ModelInfo[]>());

/**
 * The models in each endpoint's last listing whose window is only the trained one, by id.
 *
 * Kept beside `listings` rather than on `ModelInfo`, so what `listModels` hands back is the shape
 * it has always been. Replaced with each listing that lands, and left alone by one that fails.
 */
const trainedOnly = scoped(() => new Map<string, Set<string>>());

/**
 * When an endpoint was last asked about a model it did not name, keyed on the two together.
 *
 * `contextLimitFor` asks again whenever the listing does not hold the model, which is right for
 * a model that arrives late and wrong for one that is never coming. The second is the ordinary
 * case rather than the exotic one — a llama.cpp box served under a `-a` alias that does not
 * match the configured name, an OpenRouter `:free` suffix, a typo in a settings row — and there
 * every call fetches the listing, re-reads it, finds the same absence and answers the same zero.
 *
 * Remembering the miss for a moment answers both: within `listingMissMs` nobody is asked, and
 * after it the endpoint is asked again, so an `ollama pull` on a box that has been up a week is
 * picked up within the minute instead of at the next restart. Bounded by the (endpoint, model)
 * pairs actually asked about, which is the bound the listings themselves have.
 */
const misses = scoped(() => new Map<string, number>());

/**
 * What counts as one endpoint, everywhere in this package that has to remember something about
 * one — the model listings, `capabilities`, and the no-thinking hints in `side-task`.
 *
 * The URL and the key together, because the key is part of what is on the other end rather than
 * only how it is paid for: a router is free to send two keys to two different backends, and then
 * what one of them refused is not a fact about the other. Absent reads as `NO_KEY`, so an
 * endpoint with no key and one that passes `undefined` are one entry rather than two.
 *
 * Stringified rather than joined on a separator, for the reason `getClient` gives: no character
 * is impossible in a URL or a key, and two endpoints must never collide on one entry. A host
 * keeping its own per-endpoint state keys it on this rather than on a copy of it, so the two
 * cannot drift apart. It holds the key in the clear; `endpointId` is the one to write down.
 *
 * @param config Read for `baseUrl` and `apiKey` alone, and the key is optional here where
 * `Endpoint` requires it — `capabilitiesFor` is handed a URL and maybe a key rather than a whole
 * config, and absent and empty already mean the same thing. The timeout is deliberately not in
 * it; see `listings`.
 */
export const endpointKey = (config: EndpointIdentity) =>
  JSON.stringify([config.baseUrl, config.apiKey || NO_KEY]);

/**
 * One model on one endpoint, as every per-model cache keys it: stringified, so neither half runs
 * into the other.
 *
 * @param endpoint Whatever the cache names an endpoint by — `endpointKey` here, `endpointId`
 * where the key may be written down.
 * @param model The model's name as the endpoint knows it.
 */
export const modelKey = (endpoint: string, model: string) => JSON.stringify([endpoint, model]);

/**
 * `endpointKey` hashed, for the remembered facts that can leave the process.
 *
 * What an endpoint refused is exported by `exportCapabilities` to be written into a settings row
 * or a file, and a key inside that blob is a credential copied somewhere nobody meant to keep one.
 * A digest identifies the same endpoint on the next boot without saying what the key was, and it
 * is how a host finds its own endpoint's entry in a `CapabilitySnapshot`.
 *
 * @param config Read for `baseUrl` and `apiKey` alone, as `endpointKey` reads it.
 */
export const endpointId = (config: EndpointIdentity) =>
  createHash("sha256").update(endpointKey(config)).digest("hex");

/**
 * Served windows found by asking a server's own API, keyed on endpoint and model together.
 *
 * A model's entry stays until `resetClients`, like a listing; a server that answered without one
 * is asked again after `listingMissMs`, like a listing that did not name the model.
 */
const served = scoped(() => new Map<string, { window: number; at: number }>());

/** Endpoints with neither native route, which are not asked for either again. */
const unserved = scoped(() => new Set<string>());

/**
 * Endpoints whose `/api/v0/models` answered with an error, and when.
 *
 * `gone` is a route the server does not have (`NOT_THERE`), which is a fact about the server and
 * stands until `resetClients`. Any other error stands for `listingMissMs` only, because it may be
 * one the server gets over, and LM Studio latched for good on a passing 5xx would have no window
 * at all until the process restarted, its listing carrying none.
 *
 * Per endpoint and on its own, whatever `/props` said: a server whose `/props` answers without a
 * window is never `unserved`, and without this its missing route was asked again with every miss.
 */
const refusals = scoped(() => new Map<string, { at: number; gone: boolean }>());

/** Whether `/api/v0/models` is to be left alone on this endpoint for now. */
const refused = (endpoint: string) => {
  const refusal = refusals().get(endpoint);
  return (
    refusal !== undefined && (refusal.gone || Date.now() - refusal.at < poolLimits().listingMissMs)
  );
};

/** How long a probe may take before the window is taken from the listing instead. */
const PROBE_TIMEOUT_MS = 10_000;

/** The server root behind an OpenAI-compatible base URL, which is where the native APIs live. */
const rootOf = (baseUrl: string) => baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

/** A route this server does not have, rather than one that failed to answer. */
const NOT_THERE = new Set([404, 405, 501]);

/**
 * Asks one native endpoint. `failed` is any answer that was not a 2xx and `missing` the ones among
 * them that mean a server without the route; `body` is absent for both, and for a 2xx that was not
 * JSON. A server that could not be reached throws.
 */
async function probe(
  config: Endpoint,
  path: string,
): Promise<{ failed: boolean; missing: boolean; body?: unknown }> {
  const apiKey = config.apiKey || undefined;
  const response = await fetch(`${rootOf(config.baseUrl)}${path}`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(timeoutMs(config) ?? PROBE_TIMEOUT_MS),
  });
  if (!response.ok) return { failed: true, missing: NOT_THERE.has(response.status) };
  try {
    return { failed: false, missing: false, body: await response.json() };
  } catch {
    return { failed: false, missing: false };
  }
}

/**
 * The window a local server's own API says it is serving a model in, for the servers whose
 * listing does not say.
 *
 * llama.cpp reports it on `/props` as `default_generation_settings.n_ctx`, per slot, and LM
 * Studio on `/api/v0/models` as `loaded_context_length` while the model is loaded. Both differ
 * from the trained window in the case that matters, a model started in a smaller one than it was
 * built for, and reading the trained one lets an overflow through the guard meant to catch it.
 * Ollama reports nothing on either; an operator there has to declare the window.
 *
 * Zero where no answer was found, which is remembered for `listingMissMs`. A server without
 * either route is latched and not asked again. `/api/v0/models` is also dropped on its own: until
 * `resetClients` once it answers as a route that is not there, and for `listingMissMs` after any
 * other error. A server that could not be reached is not remembered at all.
 *
 * The listing is not read here; `contextLimitFor` reads it first and comes here after.
 *
 * @param config The endpoint, plus the model whose window is wanted.
 */
export async function servedWindow(config: Endpoint & { model: string }): Promise<number> {
  const endpoint = endpointKey(config);
  if (unserved().has(endpoint)) return 0;
  const key = modelKey(endpoint, config.model);
  const known = served().get(key);
  if (known && (known.window > 0 || Date.now() - known.at < poolLimits().listingMissMs))
    return known.window;

  let window = 0;
  try {
    // Named, for a llama.cpp router serving several models; a single-model server ignores it.
    const props = await probe(config, `/props?model=${encodeURIComponent(config.model)}`);
    const settings = (props.body as { default_generation_settings?: { n_ctx?: unknown } })
      ?.default_generation_settings;
    window = positive(settings?.n_ctx);
    if (!window) {
      if (!refused(endpoint)) {
        const lmstudio = await probe(config, "/api/v0/models");
        if (lmstudio.failed) refusals().set(endpoint, { at: Date.now(), gone: lmstudio.missing });
        else refusals().delete(endpoint);
        const { data } = (lmstudio.body ?? {}) as { data?: unknown };
        const entry = Array.isArray(data)
          ? (data as { id?: unknown; loaded_context_length?: unknown }[]).find(
              (model) => model?.id === config.model,
            )
          : undefined;
        window = positive(entry?.loaded_context_length);
      }
      if (props.missing && refusals().get(endpoint)?.gone) {
        unserved().add(endpoint);
        return 0;
      }
    }
  } catch {
    return 0;
  }
  served().set(key, { window, at: Date.now() });
  return window;
}

/**
 * Asks an endpoint what it serves, and remembers the answer.
 *
 * @param config The endpoint to ask. Remembered per base URL and key, not per model.
 */
export async function listModels(config: Endpoint): Promise<ModelInfo[]> {
  const { data } = await getClient(config).models.list();
  const trained = new Set<string>();
  const models = data
    .map((model) => {
      const window = contextLengthOf(model);
      if (window.trained) trained.add(model.id);
      return { id: model.id, contextLength: window.contextLength };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const key = endpointKey(config);
  listings().set(key, models);
  trainedOnly().set(key, trained);
  return models;
}

/**
 * How much a model will read, in tokens. Zero means nobody knows.
 *
 * `declared` is the operator's own number, and it wins outright: an endpoint can report the
 * window a model was *built* with while serving it in a much smaller one — llama.cpp will
 * happily load a 256k model at `-c 16384` and go on listing it as 256k — and a run refused on
 * the honest-looking number is a run that fails at the endpoint instead.
 *
 * Otherwise the endpoint's listing — asked once, and again whenever it does not name this model,
 * since a model can arrive after the first listing was taken. A window stated at the top of the
 * model's entry is taken as the one being served, and nothing else is asked. Where the listing
 * did not settle it — no window, only llama.cpp's trained one, no entry, no listing — the
 * server's own API is asked (`servedWindow`), and what it says wins; the trained window is what
 * is left when it says nothing. A server that will not list models still has to be able to run a
 * turn: a failure here is an unknown window, not a failed run.
 *
 * The listing goes first because it is the one route every server here has, and the native ones
 * are two more requests that a server stating its window in the listing never needed. Asked
 * first, they were also asked again every `listingMissMs` for the life of the process on a server
 * whose `/props` answers without a window, by any host that sizes the window per turn.
 *
 * @param config The endpoint, plus the model whose window is wanted.
 * @param declared The operator's own number. Above zero it wins and the endpoint is not asked.
 */
export async function contextLimitFor(
  config: Endpoint & { model: string },
  declared = 0,
): Promise<number> {
  if (declared > 0) return declared;
  const key = endpointKey(config);
  const listed = () =>
    listings()
      .get(key)
      ?.find((model) => model.id === config.model);
  // The listing is asked for again when it does not name this model, rather than only when
  // there is no listing at all. Models arrive after a process starts — an `ollama pull` on a
  // box that has been up a week, a worker added to a router, a name the operator has only just
  // typed into settings — and a cache keyed on "we have asked once" answers zero for every one
  // of them until a restart. Zero means "nobody knows", so what the operator loses is the
  // context meter and, in a consumer that compacts on it, compaction: the session then runs at
  // the window instead of under it and fails against the endpoint's own refusal.
  if (!listed()) {
    const missKey = modelKey(key, config.model);
    const asked = misses().get(missKey);
    // Asked again, but not on every call. A model that is never coming answers the same zero
    // however often the endpoint is asked, and a caller sizing a window per turn pays a round
    // trip for each of them; `listingMissMs` is how long that answer is allowed to stand.
    if (asked === undefined || Date.now() - asked >= poolLimits().listingMissMs) {
      // A failure is not remembered: an endpoint that was down when the last run started is not
      // an endpoint with no models, and a window nobody could ask about is not a failed run.
      const answered = await listModels(config).then(
        () => true,
        () => false,
      );
      // Recorded where the endpoint was actually asked, and only there. Stamping it on the calls
      // that skipped the request would push the deadline out ahead of any caller polling faster
      // than the interval, which is a memory that never expires rather than one that expires in
      // half a minute.
      if (answered) {
        if (listed()) misses().delete(missKey);
        else misses().set(missKey, Date.now());
      }
    }
  }
  const entry = listed();
  const fromListing = entry?.contextLength ?? 0;
  // A top-level key settles it. A trained window does not: llama.cpp lists the one the model was
  // built with, and taking it over what `/props` says lets an overflow through the guard.
  if (fromListing > 0 && !trainedOnly().get(key)?.has(config.model)) return fromListing;
  const window = await servedWindow(config);
  return window > 0 ? window : fromListing;
}

/**
 * Forgets every cached client and listing, and puts `configureClients` back to the defaults. For
 * tests, and for a settings change under test.
 */
export function resetClients() {
  poolLimits.reset();
  clients().clear();
  listings().clear();
  misses().clear();
  trainedOnly().clear();
  served().clear();
  unserved().clear();
  refusals().clear();
}

/** A base URL as two settings rows would agree on it: trimmed, without the trailing slash. */
export const sameUrl = (a: string, b: string) =>
  a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");

/**
 * The key to send, where an endpoint may inherit one from the settings it overrides.
 *
 * A credential issued for one endpoint has no business being posted to another. A profile that
 * names its own `baseUrl` and no key of its own is sent `NO_KEY` — not the operator's key, and
 * not `$OPENAI_API_KEY` — because "I pointed an agent at a friend's server and it sent my OpenAI
 * key" is not a mistake worth being able to make, and a local server wants no key anyway. One on
 * the same endpoint inherits the key as it inherits everything else, and the environment is the
 * last word on the endpoint that was configured rather than overridden.
 *
 * @param own The endpoint as the agent or profile states it. Its own key always wins. An empty or
 * absent `baseUrl` is one that inherits the endpoint too.
 * @param inherited The settings it overrides. Absent treats `own` as the configured endpoint, so
 * only its key and the environment's are in play.
 * @param env Where `OPENAI_API_KEY` is read from, `process.env` by default.
 */
export function resolveApiKey(
  own: { baseUrl?: string; apiKey?: string },
  inherited?: EndpointIdentity,
  env: Record<string, string | undefined> = process.env,
): string {
  if (own.apiKey) return own.apiKey;
  const baseUrl = own.baseUrl?.trim();
  if (inherited && baseUrl && !sameUrl(baseUrl, inherited.baseUrl)) return NO_KEY;
  return inherited?.apiKey || env.OPENAI_API_KEY || NO_KEY;
}
