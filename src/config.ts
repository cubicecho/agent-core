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
   * How long a streamed turn may wait for its first chunk. Absent is five times
   * `requestTimeoutSeconds`; zero or less is no limit.
   *
   * Its own number because the first wait is prefill, and on a local server prefill of a long
   * prompt is tens of seconds on a GPU and minutes on a CPU, where the gap between tokens is a
   * fraction of a second. A server loading the model on demand, Ollama after `keep_alive` or LM
   * Studio just in time, holds the request open for the same reason. One number for both waits
   * was either too slow to notice a wedged stream or tight enough to abandon a prefill, and a
   * retry pays for that prefill again from nothing.
   */
  firstTokenSeconds?: number;
}

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
   * What a model card asks for and nothing here names: `top_k`, `min_p`, `repeat_penalty` —
   * what actually stops a small model looping — and a server's own fields, such as llama.cpp's
   * `id_slot`, which pins a session to one slot of a `--parallel` server so its KV cache is
   * still warm on the next turn. A local server ignores a field it does not know; OpenAI refuses
   * one by name, and `negotiate` drops that name for the model and sends the request again.
   * `model`, `messages`, `stream` and `tools` are the loop's and are not overridden from here.
   * Ollama's `options` object is not read on its `/v1` route, so sampling there has to go in as
   * top-level fields like any other.
   */
  extraBody?: Record<string, unknown>;
}

/** How tools reach the model, and how long it may keep calling them. */
export interface ToolPolicy {
  /**
   * "eager" sends every tool definition on every request. "ondemand" sends a name-only
   * catalogue and lets the model pull in the schemas it needs. See `tool-loading.ts`.
   */
  toolDiscovery: "eager" | "ondemand";
  /** The model that does the preselection pass. Empty means don't preselect. */
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
 * Provided for callers that want one name for the lot. Nothing in this package asks for it:
 * the functions take the parts, so a caller missing `contextLength` can still use all of them
 * bar the window guard.
 */
export interface AgentConfig extends Endpoint, ModelParams, ToolPolicy, RetryPolicy {
  /** The agent's own standing instruction, if it has one. */
  systemPrompt: string;
  /** What the operator says this model reads, in tokens. Zero means ask the endpoint. */
  contextLength: number;
}
