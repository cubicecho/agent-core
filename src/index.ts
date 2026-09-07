/**
 * The endpoint-agnostic half of an OpenAI-compatible agent loop.
 *
 * What is here is everything that does not know what the agent is *for*: making a tool schema
 * a strict server will accept, getting tool definitions in front of a model without paying for
 * all of them, reading one streamed turn back into a message, answering an endpoint that
 * refuses one of those, one-shot calls that support a run, the event bus a watcher reads, a
 * pooled client, and the rules about retrying. What is not here is the work — orchestration,
 * prompts, and whatever the run is about — because that is the caller's, and it is the part
 * that differs between one server and the next.
 */

export {
  type Capabilities,
  capabilitiesFor,
  type ModelCapabilities,
  modelCapabilitiesFor,
  type NegotiateOptions,
  negotiate,
  resetCapabilities,
} from "./capabilities.ts";
export type { CatalogServer } from "./catalog.ts";
export {
  contextLimitFor,
  getClient,
  listModels,
  type ModelInfo,
  NO_KEY,
  resetClients,
  timeoutMs,
} from "./client.ts";
export type {
  AgentConfig,
  Endpoint,
  ModelParams,
  RetryPolicy,
  ToolPolicy,
} from "./config.ts";
export { errorMessage } from "./errors.ts";
export {
  emit,
  endRun,
  fold,
  history,
  type RunEvent,
  type RunEventInput,
  type RunEventKind,
  type RunUsage,
  resetEvents,
  watch,
} from "./events.ts";
export { resetAll } from "./reset.ts";
export {
  backoffMs,
  ContextOverflow,
  compact,
  EndpointSilent,
  isOverflow,
  isTransient,
  requestTokens,
  SMALLEST_LIKELY_WINDOW,
  sleep,
} from "./retry.ts";
export { type RunTurnOptions, runTurn } from "./run-turn.ts";
export { isGrammarError, relaxTools, sanitizeTools } from "./schema-compat.ts";
export {
  ask,
  clean,
  listLines,
  parseJson,
  resetHints,
  type SideTaskOptions,
  tryAsk,
} from "./side-task.ts";
export {
  type Produced,
  type StreamTurnOptions,
  streamTurn,
  type Turn,
  type TurnUsage,
} from "./stream.ts";
export { estimateTokens } from "./tokens.ts";
export {
  carryOver,
  catalogList,
  catalogPrompt,
  expandNames,
  inCatalog,
  LOAD_TOOLS,
  LOAD_TOOLS_DEFINITION,
  loadResult,
  MAX_CARRIED,
  MAX_PER_LOAD,
  PRESELECT_SYSTEM,
  preselectInput,
  preselection,
  requestedNames,
} from "./tool-loading.ts";
