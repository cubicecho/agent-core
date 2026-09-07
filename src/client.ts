import OpenAI from "openai";
import type { Endpoint } from "./config.ts";

/**
 * The SDK insists on a non-empty key even where the server will not look at it. This is what it
 * gets. It also reads as "this endpoint has no key" at a call site, which an empty string does
 * not — a caller must not let a local endpoint silently borrow the key meant for a paid one.
 */
export const NO_KEY = "agent-core";

/** Zero or less means no limit, which the SDK spells as `undefined`. */
export const timeoutMs = (config: Pick<Endpoint, "requestTimeoutSeconds">): number | undefined =>
  config.requestTimeoutSeconds > 0 ? config.requestTimeoutSeconds * 1000 : undefined;

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
 * something asked for anyway: nothing here refreshes it, and a listing that fails leaves
 * whatever was there rather than emptying it.
 */
const listings = new Map<string, ModelInfo[]>();

const endpointKey = (config: Endpoint) => JSON.stringify([config.baseUrl, config.apiKey || NO_KEY]);

/** Asks an endpoint what it serves, and remembers the answer. */
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
 * Otherwise the listing is asked, once per endpoint. A server that will not list models still
 * has to be able to run a turn: a failure here is an unknown window, not a failed run.
 */
export async function contextLimitFor(
  config: Endpoint & { model: string },
  declared = 0,
): Promise<number> {
  if (declared > 0) return declared;
  // A failure is not remembered: an endpoint that was down when the last run started is not an
  // endpoint with no models, and the one listing this costs is nothing beside the run itself.
  if (!listings.has(endpointKey(config))) {
    try {
      await listModels(config);
    } catch {
      return 0;
    }
  }
  const listed = listings.get(endpointKey(config)) ?? [];
  return listed.find((model) => model.id === config.model)?.contextLength ?? 0;
}

/** Forgets every cached client and listing. For tests, and for a settings change under test. */
export function resetClients() {
  clients.clear();
  listings.clear();
}
