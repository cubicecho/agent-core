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
 */
const clients = new Map<string, OpenAI>();

/**
 * The client for an endpoint, built once and kept.
 *
 * Pooled on the three fields that change how a request is sent, so agents sharing a server share
 * a connection and agents on different servers never share a client.
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
  if (existing) return existing;
  const client = new OpenAI({ baseURL: config.baseUrl, apiKey, timeout, maxRetries: 0 });
  clients.set(key, client);
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
 * Keyed the same way the clients are, because two endpoints are two different sets of models
 * and one of them having answered says nothing about the other. It is only ever a cache of
 * something asked for anyway, and a listing that fails leaves whatever was there rather than
 * emptying it.
 */
const listings = new Map<string, ModelInfo[]>();

const endpointKey = (config: Endpoint) => JSON.stringify([config.baseUrl, config.apiKey || NO_KEY]);

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
  // The listing is asked for again when it does not name this model, rather than only when
  // there is no listing at all. Models arrive after a process starts — an `ollama pull` on a
  // box that has been up a week, a worker added to a router, a name the operator has only just
  // typed into settings — and a cache keyed on "we have asked once" answers zero for every one
  // of them until a restart. Zero means "nobody knows", so what the operator loses is the
  // context meter and, in a consumer that compacts on it, compaction: the session then runs at
  // the window instead of under it and fails against the endpoint's own refusal.
  //
  // The cost of asking again is one listing per call while the model really is absent, which
  // is exactly the case where the cached answer would have been wrong.
  if (!listings.get(key)?.some((model) => model.id === config.model)) {
    // A failure is not remembered: an endpoint that was down when the last run started is not
    // an endpoint with no models, and a window nobody could ask about is not a failed run.
    try {
      await listModels(config);
    } catch {
      return 0;
    }
  }
  const listed = listings.get(key) ?? [];
  return listed.find((model) => model.id === config.model)?.contextLength ?? 0;
}

/** Forgets every cached client and listing. For tests, and for a settings change under test. */
export function resetClients() {
  clients.clear();
  listings.clear();
}
