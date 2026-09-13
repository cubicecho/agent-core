import OpenAI from "openai";
import type { Endpoint } from "./config.ts";

/**
 * The SDK insists on a non-empty key even where the server will not look at it. This is what it
 * gets. It also reads as "this endpoint has no key" at a call site, which an empty string does
 * not — a caller must not let a local endpoint silently borrow the key meant for a paid one.
 */
export const NO_KEY = "agent-core";

/**
 * Zero, less, or absent means no limit, which the SDK spells as `undefined`.
 *
 * @param config Read for `requestTimeoutSeconds` alone.
 */
export const timeoutMs = (config: Pick<Endpoint, "requestTimeoutSeconds">): number | undefined => {
  const seconds = config.requestTimeoutSeconds ?? 0;
  return seconds > 0 ? seconds * 1000 : undefined;
};

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
const clients = new Map<string, OpenAI>();

/**
 * How many endpoints' clients are kept at once.
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

/**
 * The client for an endpoint, built once and kept.
 *
 * Pooled on the three fields that change how a request is sent, so agents sharing a server share
 * a connection and agents on different servers never share a client.
 *
 * The pool is per *deployment*, not per request: what belongs in this map is an endpoint an
 * operator configured, and everything cached in this package is bounded on that reading. A
 * consumer that mints an API key per user still gets a working client, but it is churning
 * connection pools rather than sharing them and holding every one of them — `MAX_CLIENTS` keeps
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
  const existing = clients.get(key);
  if (existing) {
    // Re-inserted so it counts as the youngest. A `Map` keeps insertion order and hands the
    // oldest key over first, which is the whole of the LRU below.
    clients.delete(key);
    clients.set(key, existing);
    return existing;
  }
  const client = new OpenAI({ baseURL: config.baseUrl, apiKey, timeout, maxRetries: 0 });
  clients.set(key, client);
  // Nothing is closed on the way out. The SDK holds no handle a caller can release, and an
  // evicted client is garbage once whatever request is still in flight on it has finished —
  // dropping the reference is the whole of the eviction.
  for (const oldest of clients.keys()) {
    if (clients.size <= MAX_CLIENTS) break;
    clients.delete(oldest);
  }
  return client;
}

/**
 * The context window, spelled every way a server spells it.
 *
 * None of these is in the OpenAI listing schema, so every server that says anything says it as
 * an extra key of its own: `context_length` is llama.cpp and LM Studio, `max_model_len` vLLM,
 * `n_ctx` the raw llama bindings. Whichever turns up first is taken — a server reporting two
 * of them is reporting the same number twice.
 */
const CONTEXT_KEYS = [
  "context_length",
  "max_context_window",
  "max_model_len",
  "context_window",
  "n_ctx",
];

function contextLengthOf(model: object): number {
  const record = model as Record<string, unknown>;
  for (const key of CONTEXT_KEYS) {
    const value = record[key];
    if (typeof value === "number" && value > 0) return value;
  }
  return 0;
}

/** A model an endpoint offers, and what it says the model will read. Zero means it did not say. */
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
const listings = new Map<string, ModelInfo[]>();

/**
 * When an endpoint was last asked about a model it did not name, keyed on the two together.
 *
 * `contextLimitFor` asks again whenever the listing does not hold the model, which is right for
 * a model that arrives late and wrong for one that is never coming. The second is the ordinary
 * case rather than the exotic one — a llama.cpp box served under a `-a` alias that does not
 * match the configured name, an OpenRouter `:free` suffix, a typo in a settings row — and there
 * every call fetches the listing, re-reads it, finds the same absence and answers the same zero.
 *
 * Remembering the miss for a moment answers both: within `LISTING_MISS_MS` nobody is asked, and
 * after it the endpoint is asked again, so an `ollama pull` on a box that has been up a week is
 * picked up within the minute instead of at the next restart. Bounded by the (endpoint, model)
 * pairs actually asked about, which is the bound the listings themselves have.
 */
const misses = new Map<string, number>();

/** How long a model an endpoint did not list stays unlisted before it is asked about again. */
const LISTING_MISS_MS = 30_000;

/**
 * What counts as one endpoint, everywhere in this package that has to remember something about
 * one — this file's listings, `capabilities`, and the no-thinking hints in `side-task`.
 *
 * The URL and the key together, because the key is part of what is on the other end rather than
 * only how it is paid for: a router is free to send two keys to two different backends, and then
 * what one of them refused is not a fact about the other. Absent reads as `NO_KEY`, so an
 * endpoint with no key and one that passes `undefined` are one entry rather than two.
 *
 * Stringified rather than joined on a separator, for the reason `getClient` gives: no character
 * is impossible in a URL or a key, and two endpoints must never collide on one entry.
 *
 * @param config Read for `baseUrl` and `apiKey` alone, and the key is optional here where
 * `Endpoint` requires it — `capabilitiesFor` is handed a URL and maybe a key rather than a whole
 * config, and absent and empty already mean the same thing. The timeout is deliberately not in
 * it; see `listings`.
 */
export const endpointKey = (config: { baseUrl: string; apiKey?: string }) =>
  JSON.stringify([config.baseUrl, config.apiKey || NO_KEY]);

/**
 * Asks an endpoint what it serves, and remembers the answer.
 *
 * @param config The endpoint to ask. Remembered per base URL and key, not per model.
 */
export async function listModels(config: Endpoint): Promise<ModelInfo[]> {
  const { data } = await getClient(config).models.list();
  const models = data
    .map((model) => ({ id: model.id, contextLength: contextLengthOf(model) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  listings.set(endpointKey(config), models);
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
 * Otherwise the endpoint's listing is asked — once, and again whenever it does not name this
 * model, since a model can arrive after the first listing was taken. A server that will not
 * list models still has to be able to run a turn: a failure here is an unknown window, not a
 * failed run.
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
  const listed = () => listings.get(key)?.find((model) => model.id === config.model);
  // The listing is asked for again when it does not name this model, rather than only when
  // there is no listing at all. Models arrive after a process starts — an `ollama pull` on a
  // box that has been up a week, a worker added to a router, a name the operator has only just
  // typed into settings — and a cache keyed on "we have asked once" answers zero for every one
  // of them until a restart. Zero means "nobody knows", so what the operator loses is the
  // context meter and, in a consumer that compacts on it, compaction: the session then runs at
  // the window instead of under it and fails against the endpoint's own refusal.
  if (!listed()) {
    const missKey = JSON.stringify([key, config.model]);
    const asked = misses.get(missKey);
    // Asked again, but not on every call. A model that is never coming answers the same zero
    // however often the endpoint is asked, and a caller sizing a window per turn pays a round
    // trip for each of them; `LISTING_MISS_MS` is how long that answer is allowed to stand.
    if (asked !== undefined && Date.now() - asked < LISTING_MISS_MS) return 0;
    // A failure is not remembered: an endpoint that was down when the last run started is not
    // an endpoint with no models, and a window nobody could ask about is not a failed run.
    try {
      await listModels(config);
    } catch {
      return 0;
    }
    // Recorded where the endpoint was actually asked, and only there. Stamping it on the calls
    // that skipped the request would push the deadline out ahead of any caller polling faster
    // than the interval, which is a memory that never expires rather than one that expires in
    // half a minute.
    if (listed()) misses.delete(missKey);
    else misses.set(missKey, Date.now());
  }
  return listed()?.contextLength ?? 0;
}

/** Forgets every cached client and listing. For tests, and for a settings change under test. */
export function resetClients() {
  clients.clear();
  listings.clear();
  misses.clear();
}
