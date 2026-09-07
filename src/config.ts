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
  /** Zero or less means no limit. */
  requestTimeoutSeconds: number;
}

/** What to ask the model for. */
export interface ModelParams {
  model: string;
  maxTokens: number;
  temperature: number;
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
