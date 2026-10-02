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
} from './context/compaction.ts';
export {
  estimateFrom,
  type LedgerEntry,
  type LedgerEstimateOptions,
  type LedgerRequest,
  rebaseLedger,
  recordRequest,
  type TokenLedger,
  tokensBetween,
} from './context/ledger.ts';
export {
  type AgentConfig,
  type Endpoint,
  type ModelParams,
  type RetryPolicy,
  ToolDiscovery,
  type ToolPolicy,
} from './core/config.ts';
export { calibrate, charsPerTokenFor, resetCalibration } from './endpoint/calibration.ts';
export {
  type Capabilities,
  capabilitiesFor,
  EFFORT_LADDER,
  EFFORT_NONE,
  EFFORT_OFF,
  effortFor,
  expireCapabilities,
  type ModelCapabilities,
  modelCapabilitiesFor,
  type NegotiateOptions,
  negotiate,
  resetCapabilities,
} from './endpoint/capabilities.ts';
export {
  type ClientPoolOptions,
  configureClients,
  contextLimitFor,
  endpointId,
  endpointKey,
  firstTokenMs,
  getClient,
  listModels,
  type ModelInfo,
  NO_KEY,
  resetClients,
  resolveApiKey,
  servedWindow,
  timeoutMs,
} from './endpoint/client.ts';
export {
  isGrammarError,
  relaxSchema,
  relaxTools,
  sanitizeSchema,
  sanitizeTools,
} from './endpoint/schema-compat.ts';
export { HOOK_EVENTS, HookEvent, INJECT_EVENTS } from './hooks/hook-events.ts';
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
} from './hooks/hooks.ts';
export {
  type AgentLoopHooks,
  type AgentLoopOptions,
  type AgentLoopRequest,
  type AgentLoopResult,
  PRESELECT_APPEND,
  PRESELECT_EXCLUSIVE,
  runAgentLoop,
  type StepWindow,
} from './run/agent-loop.ts';
export {
  configureEvents,
  type EventBusOptions,
  emit,
  endRun,
  fold,
  history,
  type RunEvent,
  type RunEventInput,
  RunEventKind,
  type RunMetrics,
  type RunMetricsOptions,
  RunOutcome,
  type RunUsage,
  resetEvents,
  runMetrics,
  type TurnReport,
  watch,
} from './run/events.ts';
export { buildBody } from './run/request-body.ts';
export { preview } from './run/run-calls.ts';
export { resetAll } from './runtime/reset.ts';
export { createRuntime, defaultRuntime, type Runtime, type RuntimeOptions } from './runtime/runtime.ts';
export {
  CAPABILITY_SNAPSHOT_VERSION,
  type CapabilitySnapshot,
  type EndpointSnapshot,
  exportCapabilities,
  importCapabilities,
  type ModelSnapshot,
} from './runtime/snapshot.ts';
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
  REF_FILE,
  REF_URL,
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
} from './spec/spec.ts';
export type { CatalogServer } from './tools/catalog.ts';
export {
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
} from './tools/preselect.ts';
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
  orderTools,
  PROXY_TOOLS,
  proxiedCall,
  proxyCatalogPrompt,
  proxyLoadResult,
  requestedNames,
  shownCall,
  type ToolOrder,
} from './tools/tool-loading.ts';
export {
  type ContinueTurnOptions,
  continueTurn,
} from './turn/continuation.ts';
export { type RunTurnOptions, runTurn } from './turn/run-turn.ts';
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
} from './turn/side-task.ts';
export {
  AgentLoopError,
  type AgentLoopFailure,
  AgentLoopOverflow,
  errorMessage,
  failedRun,
  ToolIterationLimit,
} from './wire/errors.ts';
export {
  backoffMs,
  ContextOverflow,
  EndpointSilent,
  isModelLoading,
  isOverflow,
  isTransient,
  SMALLEST_LIKELY_WINDOW,
} from './wire/retry.ts';
export {
  CacheBreakReason,
  type Produced,
  type StreamTurnOptions,
  streamTurn,
  type Turn,
  type TurnUsage,
} from './wire/stream.ts';
export {
  ALL_FENCES,
  DEFAULT_FENCES,
  type Fence,
  FenceSplitter,
  type FenceSplitterOptions,
  SPLIT_OUTPUT,
  SPLIT_REASONING,
  type Split,
  stripThinking,
  THINK_FENCE,
} from './wire/thinking.ts';
export {
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
} from './wire/tokens.ts';
export {
  ARGUMENTS_MALFORMED,
  ARGUMENTS_TRUNCATED,
  parseToolArguments,
  recoverToolCalls,
  ToolArgumentsError,
  type ToolCall,
  type ToolCallOutcome,
  type ToolCallRequest,
  type ToolCallResult,
} from './wire/tool-calls.ts';
export { FinishReason, FUNCTION_TOOL, JSON_SCHEMA_FORMAT, PartType, Role, SchemaType } from './wire/wire.ts';
