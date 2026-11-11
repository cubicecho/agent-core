/**
 * What this package needs to know about a caller's configuration.
 *
 * Deliberately not one interface. The three servers that consume this each hold their settings
 * in a different shape — a resolved agent row, a settings row read straight from the database,
 * a zod-inferred config object — and they do not all carry the same fields: `task_server`'s
 * settings row has no `contextLength`, and `min-agent` spells it `contextLimit` and has no
 * timeout or retry budget at all.
 *
 * So every function here asks for the narrowest thing it actually reads, and a caller satisfies
 * it structurally. Nothing imports a config *type* from a consumer, and no consumer has to grow
 * a field it has no use for in order to call `getClient`.
 */

/** Where to send a request and how long to wait. Everything that talks to a server needs this. */
export interface Endpoint {
  /** Any OpenAI-compatible base URL: OpenAI, Ollama, LM Studio, vLLM, OpenRouter, ... */
  baseUrl: string;
  /** Empty is normal — a local server ignores it. See `getClient` for what is sent instead. */
  apiKey: string;
  /**
   * How long an endpoint may go quiet. Zero, less, or absent means no limit — what a local model
   * answering slowly needs.
   *
   * @remarks
   * Not the whole request, which may take as long as the model keeps talking. On a streamed turn
   * it is the silence allowed between chunks, the idle watchdog; the wait for the first chunk is
   * `firstTokenSeconds`. On a call that does not stream, a side task or a model listing, it is
   * the SDK's timer, which runs until the response headers arrive.
   *
   * Optional because a consumer that has no timeout to give should not have to invent one. Two
   * of the three servers this was extracted from carry no such field, and requiring it made
   * them write `requestTimeoutSeconds: 0` to mean "I have no opinion", which is a made-up
   * number standing in for an absent one.
   */
  requestTimeoutSeconds?: number;
  /**
   * How long a streamed turn may wait for its first chunk. Zero or less is no limit.
   *
   * @defaultValue Five times `requestTimeoutSeconds`
   *
   * @remarks
   * Its own number because the first wait is prefill, and on a local server prefill of a long
   * prompt is tens of seconds on a GPU and minutes on a CPU, where the gap between tokens is a
   * fraction of a second. A server loading the model on demand, Ollama after `keep_alive` or LM
   * Studio just in time, holds the request open for the same reason. One number for both waits
   * was either too slow to notice a wedged stream or tight enough to abandon a prefill, and a
   * retry pays for that prefill again from nothing.
   */
  firstTokenSeconds?: number;
}

/**
 * What makes an endpoint the one it is: where it lives and whose key reaches it.
 *
 * @remarks
 * The narrow half of `Endpoint`, for everything that only has to tell two endpoints apart — the
 * client pool, the capability latches, a side task borrowing the agent's key. The timeouts are
 * not in it, since a different patience is not a different server.
 */
export interface EndpointIdentity {
  /**
   * The base URL as given. Compared as `baseUrlKey` has it, so a trailing slash, a host's case and
   * a default port are the same endpoint, and a path's case and a `/v1` are not.
   */
  baseUrl: string;
  /** Absent and empty mean the same: no key, which `endpointKey` reads as `NO_KEY`. */
  apiKey?: string;
}

/**
 * A base URL worth storing: http or https, no credentials, query or fragment, no trailing slash.
 *
 * @param raw - The URL as typed. Surrounding whitespace is trimmed.
 * @returns The URL as the WHATWG parser writes it, less its trailing slashes — scheme and host in
 * lower case, a default port dropped — or `null` for anything that is not such a URL.
 *
 * @remarks
 * One rule for every host, because "a stored key only goes to its own endpoint" is decided by
 * comparing two of these, and four hosts writing four rules had begun to disagree about it. A key
 * in the URL is a credential nobody meant to store; a query or a fragment is one more thing two
 * copies of the same endpoint could differ in, and the SDK appends its paths after it.
 *
 * A host that stores a base URL stores this, and a form that refuses one refuses on `null`, so what
 * is saved is already in the form every comparison here reads.
 */
export function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) {
    return null;
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * A base URL in the form two of them are compared in, valid or not.
 *
 * @param raw - The URL as configured.
 * @returns `normalizeBaseUrl`'s answer where it has one, and otherwise the URL trimmed of
 * whitespace and trailing slashes, which is the rule every comparison here used before.
 *
 * @remarks
 * A URL the normaliser refuses is still somebody's endpoint — an old settings row, a key written
 * into the URL — and it still has to equal itself, so it falls back to the older, looser rule
 * rather than to "unequal to everything".
 */
export const baseUrlKey = (raw: string): string => normalizeBaseUrl(raw) ?? raw.trim().replace(/\/+$/, '');

/**
 * The request fields `extraBody` may not set, because the loop's request is built around them.
 *
 * @remarks
 * Here beside `extraBody` rather than with `buildBody`, which is what enforces it, because `spec`
 * says so on import as well and has to stay loadable in a browser.
 */
export const RESERVED_BODY_FIELDS: readonly string[] = ['model', 'messages', 'stream', 'tools'];

/** What to ask the model for. */
export interface ModelParams {
  model: string;
  /** The reply's ceiling. Zero or less sends none, leaving it to the server. */
  maxTokens: number;
  temperature: number;
  /**
   * `reasoning_effort` for a model that deliberates. Absent or `"off"` sends none, which is the
   * only value a server that has never heard of reasoning accepts — a setting that means "leave
   * the field out" rather than a level to ask for.
   */
  reasoningEffort?: string;
  /**
   * Request fields this interface cannot spell, merged into the body last by `buildBody`.
   *
   * @remarks
   * What a model card asks for and nothing here names: `top_k`, `min_p`, `repeat_penalty` —
   * what actually stops a small model looping — and a server's own fields, such as llama.cpp's
   * `id_slot`, which pins a session to one slot of a `--parallel` server so its KV cache is
   * still warm on the next turn — `runAgentLoop`'s `session` picks one itself. A local server ignores a field it does not know; OpenAI refuses
   * one by name, and `negotiate` drops that name for the model and sends the request again.
   * `model`, `messages`, `stream` and `tools` are the loop's and are not overridden from here.
   * Ollama's `options` object is not read on its `/v1` route, so sampling there has to go in as
   * top-level fields like any other.
   */
  extraBody?: Record<string, unknown>;
}

/** How tool definitions reach the model. See `tool-loading.ts`. */
export const ToolDiscovery = {
  /** Every tool definition, on every request. */
  Eager: 'eager',
  /** A name-only catalogue, from which the model pulls in the schemas it needs. */
  OnDemand: 'ondemand',
  /**
   * The same catalogue behind a tool array that never changes — `load_tools` and `call_tool` —
   * for a server whose prompt cache a growing tool array throws away.
   */
  Proxy: 'proxy',
} as const;

/** Any one of the modes in `ToolDiscovery`. */
export type ToolDiscovery = (typeof ToolDiscovery)[keyof typeof ToolDiscovery];

/** How tools reach the model, and how long it may keep calling them. */
export interface ToolPolicy {
  /** How tool definitions reach the model. */
  toolDiscovery: ToolDiscovery;
  /**
   * The model that does the preselection pass. Empty means don't preselect, to `preselect` itself;
   * `runAgentLoop`, asked to preselect, reads empty as the run's own `model`.
   */
  toolSelectModel: string;
  /** Hard stop on runaway tool loops. */
  maxToolIterations: number;
}

/** How many times a lost or refused request is worth sending again. See `retry.ts`. */
export interface RetryPolicy {
  maxRetries: number;
  /**
   * How long to wait for a local server that says it is still loading the model, absent two
   * minutes and zero not at all. Separate from `maxRetries`, which is sized for a request that
   * was lost rather than for weights being read off a disk. See `isModelLoading`.
   */
  loadingTimeoutSeconds?: number;
}

/**
 * A whole agent configuration — every part, plus the two fields that belong to no group.
 *
 * @remarks
 * Provided for callers that want one name for the lot. No function in this package asks for it:
 * they take the parts, so a caller missing `contextLength` can still use all of them bar the
 * window guard. `ResolvedAgent` extends it, which is how a resolved spec satisfies every one.
 */
export interface AgentConfig extends Endpoint, ModelParams, ToolPolicy, RetryPolicy {
  /** The agent's own standing instruction, if it has one. */
  systemPrompt: string;
  /** What the operator says this model reads, in tokens. Zero means ask the endpoint. */
  contextLength: number;
}
