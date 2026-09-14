/**
 * The endpoint-agnostic half of an OpenAI-compatible agent loop.
 *
 * What is here is everything that does not know what the agent is *for*: making a tool schema
 * a strict server will accept, getting tool definitions in front of a model without paying for
 * all of them, reading one streamed turn back into a message, answering an endpoint that
 * refuses one of those, one-shot calls that support a run, the host's side of lifecycle hooks,
 * the event bus a watcher reads, a pooled client, and the rules about retrying. What is not here is the work — orchestration,
 * prompts, and whatever the run is about — because that is the caller's, and it is the part
 * that differs between one server and the next.
 */

export {
  type AgentLoopHooks,
  type AgentLoopOptions,
  type AgentLoopResult,
  buildBody,
  parseToolArguments,
  preselect,
  preview,
  resolveApiKey,
  runAgentLoop,
  type ToolCallOutcome,
  type ToolCallRequest,
} from "./agent-loop.ts";
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
  FIRST_TOKEN_FACTOR,
  firstTokenMs,
  getClient,
  listModels,
  type ModelInfo,
  NO_KEY,
  resetClients,
  timeoutMs,
} from "./client.ts";
export {
  COMPACT_AT,
  type CompactionOptions,
  type CompactionPlan,
  compactTranscript,
  KEEP_RATIO,
  type PruneOptions,
  planCompaction,
  pruneToolResults,
  SUMMARY_LEAD,
  SUMMARY_PROMPT,
  summariser,
  summaryInput,
} from "./compaction.ts";
export type {
  AgentConfig,
  Endpoint,
  ModelParams,
  RetryPolicy,
  ToolPolicy,
} from "./config.ts";
export { errorMessage } from "./errors.ts";
export {
  configureEvents,
  type EventBusOptions,
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
export {
  assembleContext,
  configureHooks,
  type Gathered,
  gather,
  HOOK_CONTEXT_TOKENS,
  HOOK_EVENTS,
  HOOK_PREFACE,
  type HookContext,
  type HookEvent,
  type HookMessage,
  type HookNote,
  type HookOptions,
  type HookOutcome,
  type HookRunner,
  INJECT_EVENTS,
  notify,
  resetHooks,
  turnIndex,
  turnMessages,
  withContext,
} from "./hooks.ts";
export { resetAll } from "./reset.ts";
export {
  backoffMs,
  ContextOverflow,
  compact,
  EndpointSilent,
  isOverflow,
  isTransient,
  messageTokens,
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
  preselectSystem,
  requestedNames,
} from "./tool-loading.ts";
