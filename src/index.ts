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
  type AgentLoopRequest,
  type AgentLoopResult,
  runAgentLoop,
  type StepWindow,
} from "./agent-loop.ts";
export { calibrate, charsPerTokenFor, resetCalibration } from "./calibration.ts";
export {
  type Capabilities,
  capabilitiesFor,
  EFFORT_LADDER,
  effortFor,
  expireCapabilities,
  type ModelCapabilities,
  modelCapabilitiesFor,
  type NegotiateOptions,
  negotiate,
  resetCapabilities,
} from "./capabilities.ts";
export type { CatalogServer } from "./catalog.ts";
export {
  type ClientPoolOptions,
  configureClients,
  contextLimitFor,
  endpointId,
  endpointKey,
  FIRST_TOKEN_FACTOR,
  firstTokenMs,
  getClient,
  listModels,
  type ModelInfo,
  NO_KEY,
  resetClients,
  resolveApiKey,
  servedWindow,
  timeoutMs,
} from "./client.ts";
export {
  applyCompaction,
  COMPACT_AT,
  type CompactionOptions,
  type CompactionPlan,
  type CompactionRecord,
  type CompactionRunOptions,
  compactTranscript,
  KEEP_RATIO,
  type PruneOptions,
  planCompaction,
  pruneToolResults,
  requestIndex,
  runCompaction,
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
export {
  type ContinueTurnOptions,
  continueTurn,
  isContinuable,
} from "./continuation.ts";
export {
  AgentLoopError,
  type AgentLoopFailure,
  AgentLoopOverflow,
  errorMessage,
  failedRun,
  ToolIterationLimit,
} from "./errors.ts";
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
  type RunMetrics,
  type RunMetricsOptions,
  type RunUsage,
  resetEvents,
  runMetrics,
  type TurnReport,
  watch,
} from "./events.ts";
export { HOOK_EVENTS, type HookEvent, INJECT_EVENTS } from "./hook-events.ts";
export {
  assembleContext,
  configureHooks,
  consult,
  type Gathered,
  gather,
  HOOK_CONTEXT_TOKENS,
  HOOK_PREFACE,
  type HookContext,
  type HookMessage,
  type HookNote,
  type HookOptions,
  type HookOutcome,
  type HookRunner,
  notify,
  resetHooks,
  turnIndex,
  turnMessages,
  UNTRUSTED_PREFACE,
  untrusted,
  withContext,
} from "./hooks.ts";
export {
  estimateFrom,
  type LedgerEntry,
  type LedgerEstimateOptions,
  type LedgerRequest,
  rebaseLedger,
  recordRequest,
  type TokenLedger,
  tokensBetween,
} from "./ledger.ts";
export {
  KEYWORD_DROPOFF,
  KEYWORD_MIN_SCORE,
  type KeywordPreselection,
  type KeywordPreselectOptions,
  PRESELECT_SCHEMA,
  PRESELECT_SYSTEM,
  preselect,
  preselectByKeywords,
  preselectInput,
  preselection,
  preselectSystem,
  type ToolMatch,
} from "./preselect.ts";
export { buildBody } from "./request-body.ts";
export { resetAll } from "./reset.ts";
export {
  backoffMs,
  ContextOverflow,
  EndpointSilent,
  isModelLoading,
  isOverflow,
  isTransient,
  LOADING_POLL_MS,
  LOADING_TIMEOUT_MS,
  SMALLEST_LIKELY_WINDOW,
  sleep,
} from "./retry.ts";
export { preview } from "./run-calls.ts";
export { type RunTurnOptions, runTurn } from "./run-turn.ts";
export { createRuntime, defaultRuntime, type Runtime, type RuntimeOptions } from "./runtime.ts";
export {
  isGrammarError,
  relaxSchema,
  relaxTools,
  sanitizeSchema,
  sanitizeTools,
} from "./schema-compat.ts";
export {
  type AskJsonOptions,
  ask,
  askJson,
  clean,
  listLines,
  parseJson,
  resetHints,
  type SideTask,
  type SideTaskInput,
  type SideTaskOptions,
  taskCall,
  tryAsk,
} from "./side-task.ts";
export {
  CAPABILITY_SNAPSHOT_VERSION,
  type CapabilitySnapshot,
  type EndpointSnapshot,
  exportCapabilities,
  importCapabilities,
  type ModelSnapshot,
} from "./snapshot.ts";
export {
  AGENT_SPEC,
  AGENT_SPEC_VERSION,
  AGENT_TASKS,
  type AgentHook,
  type AgentSpec,
  type EndpointSpec,
  type ExportSpecOptions,
  exportSpec,
  type ModelSpec,
  type ParsedSpec,
  type ParseSpecOptions,
  type PromptPart,
  parseSpec,
  RESOLVED_DEFAULTS,
  type ResolvedAgent,
  type ResolvedTask,
  type RetrySpec,
  resolveAgentSpec,
  SPEC_EVENTS,
  type SpecBundle,
  type SpecServer,
  type TaskSpec,
  type ToolsSpec,
} from "./spec.ts";
export {
  type Produced,
  type StreamTurnOptions,
  streamTurn,
  type Turn,
  type TurnUsage,
} from "./stream.ts";
export {
  ALL_FENCES,
  DEFAULT_FENCES,
  type Fence,
  FenceSplitter,
  type FenceSplitterOptions,
  type Split,
  stripThinking,
  THINK_FENCE,
} from "./thinking.ts";
export {
  CHARS_PER_TOKEN,
  type ContextBreakdown,
  type ContextBreakdownOptions,
  compact,
  contextChars,
  contextTokens,
  estimateTokens,
  messageTokens,
  requestChars,
  requestTokens,
  type TokenEstimateOptions,
  toolsChars,
} from "./tokens.ts";
export {
  parseToolArguments,
  recoverToolCalls,
  ToolArgumentsError,
  type ToolCall,
  type ToolCallOutcome,
  type ToolCallRequest,
  type ToolCallResult,
} from "./tool-calls.ts";
export {
  CALL_TOOL,
  carryOver,
  catalogList,
  catalogPrompt,
  expandNames,
  holdsDefinitions,
  inCatalog,
  LOAD_TOOLS,
  LOAD_TOOLS_DEFINITION,
  loadedTools,
  loadResult,
  MAX_CARRIED,
  MAX_PER_LOAD,
  orderTools,
  PROXY_TOOLS,
  proxiedCall,
  proxyCatalogPrompt,
  proxyLoadResult,
  requestedNames,
  shownCall,
  type ToolOrder,
} from "./tool-loading.ts";
