import type OpenAI from 'openai';
import {
  type CompactionOptions,
  compactTranscript,
  type PrunePlanOptions,
  planCompaction,
  planPrune,
  pruneNotice,
  pruneThrough,
  summariser,
} from '../context/compaction.ts';
import {
  breakReason,
  type LedgerRequest,
  type RequestShape,
  rebaseLedger,
  recordRequest,
  type TokenLedger,
} from '../context/ledger.ts';
import type { Endpoint, ModelParams, RetryPolicy, ToolPolicy } from '../core/config.ts';
import { ReasoningReplay, ToolDiscovery } from '../core/config.ts';
import { counted } from '../core/guards.ts';
import { charsPerTokenFor } from '../endpoint/calibration.ts';
import {
  type Capabilities,
  capabilitiesFor,
  type ModelCapabilities,
  modelCapabilitiesFor,
  type OnNotice,
} from '../endpoint/capabilities.ts';
import { firstTokenMs, getClient, loadingMs, servedSlots, timeoutMs } from '../endpoint/client.ts';
import { CACHE_PROMPT_FIELD, SESSION_HEADER, SLOT_FIELD, slotAllocator } from '../endpoint/slots.ts';
import { HookEvent, INJECT_EVENTS } from '../hooks/hook-events.ts';
import {
  configureHooks,
  type Gathered,
  gather,
  type HookContext,
  type HookNote,
  type HookRunner,
  notify,
  type OnNote,
  turnIndex,
  turnMessages,
  withContext,
} from '../hooks/hooks.ts';
import type { CatalogServer } from '../tools/catalog.ts';
import { type ServerInstructionsOptions, serverInstructionsPrompt } from '../tools/instructions.ts';
import { type KeywordPreselectOptions, preselect } from '../tools/preselect.ts';
import {
  CALL_TOOL,
  catalogPrompt,
  inCatalog,
  LOAD_TOOLS,
  LOAD_TOOLS_DEFINITION,
  loadedTools,
  orderTools,
  PROXY_TOOLS,
  proxyCatalogPrompt,
  type ToolOrder,
  toolName,
} from '../tools/tool-loading.ts';
import { continueTurn } from '../turn/continuation.ts';
import { runTurn } from '../turn/run-turn.ts';
import { type SideTask, taskCall, tryAsk } from '../turn/side-task.ts';
import {
  AgentLoopError,
  type AgentLoopFailure,
  AgentLoopOverflow,
  errorMessage,
  ToolIterationLimit,
} from '../wire/errors.ts';
import { ContextOverflow } from '../wire/retry.ts';
import {
  addCounts,
  type InFlight,
  type LoopUsage,
  loopUsage,
  noUsage,
  reportsCache,
  type Turn,
  type TurnUsage,
} from '../wire/stream.ts';
import { contextTokens, toolsChars } from '../wire/tokens.ts';
import {
  type EndedBy,
  type RunArtifact,
  recoverToolCalls,
  type ToolCall,
  type ToolCallOutcome,
  type ToolCallRequest,
  type ToolCallResult,
} from '../wire/tool-calls.ts';
import { FinishReason, PartType, Role } from '../wire/wire.ts';
import { type ArtifactOptions, RECORD_ARTIFACT_TOOL, RunArtifacts } from './artifacts.ts';
import {
  type RunEvent,
  type RunEventInput,
  RunEventKind,
  type RunMetrics,
  RunOutcome,
  runMetrics,
  stamp,
} from './events.ts';
import { buildBody } from './request-body.ts';
import {
  assistantMessage,
  type Calling,
  definedAs,
  dropReasoning,
  loadShortlist,
  readCalls,
  replaysReasoning,
  runCalls,
  type ToolDispatch,
  writtenMessage,
} from './run-calls.ts';

/**
 * The loop above a turn: send, run the tools the model asked for, send again, until it stops
 * asking.
 *
 * Three servers wrote this loop separately after `runTurn` had already been pulled in here, and
 * the copies drifted the way the turn's own had — one noticed a turn cut off at the ceiling and
 * two did not, one tested the ceiling's spelling the other way round, one sent a reasoning effort
 * and two never did. What is here is the part that does not know what the run is for; the
 * prompts, the tools and what a run means stay with the caller.
 */

/**
 * What `onMessage` is handed beside an assistant message the model wrote: that message as the model
 * produced it.
 *
 * @remarks
 * The message `onMessage` is handed is what later requests replay — arguments repaired, `{}` for
 * none, recovered calls taken out of the text and made calls — which is right to send and quietly
 * wrong to show as the model's. Absent for a message the loop wrote itself, such as a proxied
 * run's preselected load.
 */
export interface WrittenMessage {
  /**
   * The reply as it streamed: its text whole, a call written into it as text left there, and the
   * calls it sent as calls with their arguments as streamed. A call that never got a name is left
   * off, since nothing answers it. Ids are the turn's, so the tool results pair with either.
   */
  raw: OpenAI.ChatCompletionAssistantMessageParam;
}

/**
 * One step's request as `onRequest` is handed it: what the model is about to read.
 *
 * @remarks
 * The loop assembles this and nothing else sees it — the system prompt with the catalogue on it,
 * the hooks' context on the question, the tool array ordered and sanitised as it is sent — so a
 * host that wants to say what is filling the window has nothing to measure without it.
 */
export interface AgentLoopRequest {
  /** The messages as sent, system prompt first. The request's own array, not a copy. */
  messages: readonly OpenAI.ChatCompletionMessageParam[];
  /** The tools as sent: ordered, sanitised, relaxed where the endpoint needs it. Empty for none. */
  tools: readonly OpenAI.ChatCompletionTool[];
  /** Which step of the run this is, from zero, as `beforeStep` and `onTurn` count them. */
  step: number;
}

/**
 * The hooks a loop runs around one question. See `hooks.ts`.
 *
 * @remarks
 * The loop gathers before its first request, beside its own preselection where it was asked for
 * one, and nothing else runs beside the two. A host with pre-turn work of its own to overlap with
 * the hooks — a compaction — calls `gather` itself, puts the context on with `withContext`, calls
 * `notify` after, and hands `preselectQuery` the question as it was written. It still passes
 * `hooks` when the loop folds for it, with `fire` naming only `beforeCompact`, so what it fires
 * itself is not fired a second time.
 */
export interface AgentLoopHooks {
  run: HookRunner;
  /** What the hooks are told. `reply` and `turn` are filled in for `afterTurn`. */
  context: HookContext;
  /**
   * The events the loop fires, and the only ones: `sessionStart` and `beforeTurn` gathered before
   * the first request, in the order listed; `beforeCompact` beside each fold `compact` makes; and
   * `afterTurn` once the run has its answer. `sessionEnd` and `sessionDelete` are the host's, since
   * the loop has no point that is either, and are ignored here.
   *
   * @defaultValue `events`, then `afterTurn` and `beforeCompact` — everything the loop has a point
   * for, as it fired before this existed.
   *
   * @remarks
   * For a host that fires some of them around the loop rather than inside it: one that tells
   * `beforeTurn` and `afterTurn` around a whole step of its own, and wants only the fold's
   * `beforeCompact` from the loop, passes `[HookEvent.BeforeCompact]`. With `afterTurn` left out the
   * result's `afterTurn` is resolved and empty, and `notes` and `context` are empty with no
   * injecting event listed — the host's own `gather` and `notify` hold those instead.
   */
  fire?: readonly HookEvent[];
  /**
   * Run before the first request, when `fire` is not given. Ignored beside `fire`, which says the
   * same thing with the other events in it.
   *
   * @defaultValue `[HookEvent.BeforeTurn]`
   * @deprecated List them in `fire` instead, with `afterTurn` and `beforeCompact` where the loop
   * should fire those too.
   */
  events?: readonly HookEvent[];
  /**
   * The shared context budget.
   *
   * @defaultValue The budget `configureHooks` holds.
   */
  maxTokens?: number;
  /**
   * Said above the context blocks. Empty is none.
   *
   * @defaultValue The preface `configureHooks` holds.
   */
  preface?: string;
  /** Hears each note, from before the request, from `beforeCompact` and from `afterTurn`. */
  onNote?: OnNote;
  /**
   * What the run's first message is numbered as in the uuids hooks are told — the host's stored
   * index of `messages[0]`, for a host that numbers messages across steps or runs. Read for
   * `beforeCompact`'s `compacting` and `afterTurn`'s `turn`. See `turnMessages`.
   *
   * @defaultValue `0`
   */
  offset?: number;
}

/** How full the window is as a step is about to be sent, as `beforeStep` is told it. */
export interface StepWindow {
  /**
   * The prompt tokens this run's last request reported. Absent before the first step — an earlier
   * run's figure is the host's to vouch for, since the transcript may have been folded since —
   * and where that request reported none. It does not count the reply and tool results added
   * since.
   */
  used?: number;
  /** The model's window, `config.contextLength`. Zero where the config names none. */
  limit: number;
  /** The run's ledger so far, indexed into the transcript `beforeStep` is handed beside it. */
  ledger: TokenLedger;
}

/** The `preselectRouting` that sends the first step the shortlist alone. */
export const PRESELECT_EXCLUSIVE = 'exclusive' as const;

/** The `preselectRouting` that loads the shortlist after what was carried, and sends the first step like any other. */
export const PRESELECT_APPEND = 'append' as const;

/** What `runAgentLoop` takes. */
export interface AgentLoopOptions {
  /**
   * The endpoint, what to ask the model for, and how long it may keep calling tools.
   * `toolDiscovery` absent is eager, `maxRetries` absent is none, and `contextLength` is handed
   * to `runTurn` as `contextLimit`, which sizes each request against the window before sending.
   * `"proxy"` is on-demand loading behind a tool array that never changes; see `PROXY_TOOLS`.
   *
   * @remarks
   * `tasks` is a resolved agent's, and is read only for the side tasks the loop was asked to run:
   * `tasks.toolSelect` under `preselect` and `tasks.compaction` under `compact`. `toolSelectModel`
   * is the flattened spelling of the first, for a host that is not on the spec. With neither
   * naming a model, `preselect` asks `model` itself; `compact` never does.
   */
  config: Endpoint &
    ModelParams &
    Pick<ToolPolicy, 'maxToolIterations'> &
    Partial<Pick<ToolPolicy, 'toolDiscovery' | 'toolSelectModel'>> &
    Partial<RetryPolicy> & {
      contextLength?: number;
      tasks?: Readonly<Record<string, SideTask>>;
    };
  /**
   * The standing instruction, sent as the first message. On-demand and proxied modes append the
   * catalogue, each in its own wording, and `serverInstructions` puts the servers' own guidance
   * between the two.
   */
  system?: string;
  /** The transcript so far, ending in the question. Not written to; see the result's `messages`. */
  messages: OpenAI.ChatCompletionMessageParam[];
  /**
   * Every tool this run may reach. Eager mode sends all of them; on-demand mode sends the ones
   * loaded so far, by name; proxied mode declares none, and answers a load with them instead.
   */
  tools?: OpenAI.ChatCompletionTool[];
  /**
   * The host's own tools — a question for a person, a resource read — declared on every step in
   * every discovery mode and dispatched like any other call, but never catalogued, loaded, or
   * reached through `call_tool`.
   *
   * @remarks
   * Each sits after the loop's own definitions: after `PROXY_TOOLS` proxied, after `load_tools`
   * and ahead of anything loaded on demand, after `tools` in eager mode, and after the shortlist
   * on a preselected first step; `toolOrder` then orders the array as it always does. Proxied and
   * eager, the array is one set for the whole run, so the cache holds in either order; on demand,
   * `toolOrder: false` keeps them in the prefix every load appends after.
   *
   * A name of one is taken out of `catalog`, `loaded` and `preselected` before the run starts, is
   * never counted as a load, and is declared once where `tools` or the loop has it too. A
   * `call_tool` naming one is refused with a pointer to call it directly.
   */
  hostTools?: OpenAI.ChatCompletionTool[];
  /**
   * The same tools as a name-only catalogue. On-demand and proxied modes need it, and are eager
   * without it.
   */
  catalog?: CatalogServer[];
  /**
   * Puts the catalogue's `instructions` in the system prompt, after `system` and before the
   * catalogue, as `serverInstructionsPrompt` writes them. Off by default, so no host's prompt
   * changes on upgrade.
   *
   * @defaultValue `false`
   *
   * @remarks
   * Read from `catalog` in every mode, eager included, so a host that wants them passes one either
   * way. The block is built once, from the catalogue rather than from what is loaded, so it is the
   * same text on every step and covers a server none of whose tools is loaded; the preselected
   * first step keeps it too, which leaves that step's system prompt a prefix of the next one's.
   * `true` cuts each server's text at `SERVER_INSTRUCTION_TOKENS`; an object moves the budget.
   */
  serverInstructions?: boolean | ServerInstructionsOptions;
  /**
   * How the declared tools are ordered before each request. By name unless told otherwise, so a
   * run whose tool array was assembled in a different order than last time still meets its cache.
   * `false` sends them as given. See `orderTools`.
   */
  toolOrder?: ToolOrder;
  /**
   * What `preselect` picked. The first step is sent these and nothing else — no catalogue, no
   * `load_tools` — because a model with the menu still in front of it shops: it reloads what it
   * has or picks a sibling. Everything comes back on the step after. `preselectRouting` trades
   * that for a first step shaped like the rest.
   *
   * @remarks
   * Proxied, the tool array is fixed and there is no such step. The shortlist is written into the
   * transcript instead, after the question, as a `load_tools` call the model did not make and the
   * result that call would have had — an assistant message and a tool message, handed back in
   * `messages` like any other, reported as a `tool-call` and a `tool-result` event and told to
   * `onToolCall` and `onToolResult`. Names with no definition in `tools`, or outside the
   * catalogue, are left out, and none left is no exchange.
   */
  preselected?: readonly string[];
  /**
   * What a preselection does to the first step. `"exclusive"` is the shortlist alone
   * as `preselected` describes — and a system prompt and tool array unlike the last request's and
   * unlike the next step's, so a prompt cache misses the whole transcript on the first step and
   * again on the second. `"append"` loads the shortlist as a `load_tools` call would have and
   * sends the first step like any other: the catalogue, `load_tools`, what `loaded` carried, then
   * the shortlist after it, with a name already carried left where it is. The price is the menu
   * back in front of the model. Which costs more has not been measured, which is why the default
   * has not moved.
   *
   * @defaultValue `PRESELECT_EXCLUSIVE`
   *
   * @remarks
   * Appended is before `toolOrder` has its say: sorted, a preselected tool lands at its name's
   * place and moves every definition after it, so only `toolOrder: false` keeps a carried array
   * a strict prefix. Either way the first step's system prompt is the second's, and so is its
   * tool array until something else is loaded. Nothing to do without a preselection, in eager
   * mode, or proxied, where no step is routed either way.
   */
  preselectRouting?: typeof PRESELECT_EXCLUSIVE | typeof PRESELECT_APPEND;
  /**
   * Has the loop make the preselection itself, before its first request, with the preselector
   * the config names. Opt-in, so that a host that passes a resolved agent and calls `preselect`
   * on its own is not sent a second one.
   *
   * @defaultValue `false`
   *
   * @remarks
   * The preselector is `config.tasks.toolSelect` with everything it states — its endpoint, model,
   * ceiling, temperature and reasoning effort, keyed as `taskCall` keys a task against `config` —
   * and otherwise `config.toolSelectModel` on the config's own endpoint at `preselect`'s defaults.
   * With neither naming a model it is `config.model` itself, on the same terms as
   * `toolSelectModel`: a host that opted in has asked for a preselection, and an empty name is a
   * setting nobody filled in rather than a refusal. A host that wants none passes no `preselect`.
   *
   * What it is asked about is `preselectQuery`, and otherwise the text of the last user message as
   * the host gave it — the hooks' context is put on the request, never on `messages`, so the
   * tools are picked on what was asked rather than on what was recalled. Nothing is asked in eager
   * mode, with no question, or when `preselected` is given — an empty one included, which is how
   * a host says it has already decided.
   *
   * `true` takes `preselect`'s defaults; an object passes `keywords` and `maxPerLoad` through.
   * Its notices arrive as `notice` events, and a preselection that fails picks nothing rather
   * than ending the run. What it picked is a notice too, `PRESELECTED_NOTICE` and the names,
   * before the first `turn` event, and is the result's `preselected`. It runs beside the hooks'
   * `gather` rather than before it, since neither reads what the other returns, and the first
   * request waits for both.
   */
  preselect?: boolean | { keywords?: boolean | KeywordPreselectOptions; maxPerLoad?: number };
  /**
   * What the loop's own preselection is asked about, in place of the last user message's text.
   * Read only under `preselect`.
   *
   * @remarks
   * For a host that gathered its hooks itself and sent the question with `withContext` already on
   * it: the loop cannot tell the context from the question, and a preselector shown both picks
   * tools for whatever memory recalled. Blank asks nothing, as a blank question does.
   */
  preselectQuery?: string;
  /**
   * Has the loop fold the transcript itself before a step, once `planCompaction` says the window
   * is filling, with the summary written by `config.tasks.compaction` on its own settings. Off by
   * default, and nothing is folded without that task — there is no falling back to the main model
   * — or without a `config.contextLength` to plan against.
   *
   * @remarks
   * It runs after `beforeStep`, on what that returned, and is `compactTranscript` and nothing
   * more: the plan is made from the last request's reported prompt, or an estimate before the
   * first step and after a `beforeStep` rewrite; `hooks`, when given, are told `beforeCompact`
   * beside the summary; and a fold is said as a `notice` event. A summary that fails is a notice
   * too and folds nothing. Tool results are not pruned by this — `prune` is.
   *
   * The result's `messages` then open with the summary in place of what was folded, so a host
   * that keeps its transcript append-only wants `runCompaction` and a stored fold instead. `true`
   * plans by `planCompaction`'s defaults; an object moves its thresholds.
   */
  compact?: boolean | Pick<CompactionOptions, 'compactAt' | 'keepRatio' | 'target'>;
  /**
   * Has the loop stub old tool results itself before a step, at a boundary `planPrune` moves, so
   * the prompt cache is lost once per move rather than once per tool call. Off by default, and
   * nothing moves without a `config.contextLength` — except alongside a fold.
   *
   * @remarks
   * It runs after `beforeStep`, on what that returned, and before `compact`, which then plans from
   * what is left: a prune that brings the run back under the line spares it the summary's round
   * trip. Where a fold is made anyway, the boundary is moved again after it with `compacted`, since
   * the cache is already lost. Each move is said as a `notice` event, with `pruneNotice`'s counts.
   *
   * The stubs are in the result's `messages`, as a fold is, so a host that keeps its transcript
   * whole calls `planPrune` and `pruneThrough` in its own `beforeStep` and stores the boundary
   * instead. `true` plans by `planPrune`'s defaults — past `COMPACT_AT` of the window, and only for
   * at least `PRUNE_SHARE` of it; an object moves the gate and what is kept.
   */
  prune?: boolean | Pick<PrunePlanOptions, 'at' | 'minShare' | 'keepLast' | 'maxChars'>;
  /**
   * Tools already loaded, carried from an earlier question. See `carryOver`. Not read in proxied
   * mode, where a tool is loaded only while its definition is in the history.
   */
  loaded?: Iterable<string>;
  /**
   * Runs one tool call and returns what the model reads. What it throws, the model reads too.
   *
   * @remarks
   * A `ToolAnswer` in place of the string adds what the call produced: its `text` is the whole of
   * what goes into the transcript, and its `links` become the result's `artifacts`, an `artifact`
   * event the first time each uri is seen, and `links` on what `onToolResult` is handed. Its `end`
   * ends the run once the step's calls are answered; see `AgentLoopResult.ended`.
   */
  dispatch: ToolDispatch;
  /**
   * Runs a step's calls together rather than one after another, or — given a predicate — runs
   * together the consecutive calls it passes, and each one it fails alone, in the order asked.
   *
   * @defaultValue `false`
   *
   * @remarks
   * Results go into the transcript in the order the model asked, whichever way they ran. See
   * `dedupeToolCalls`, which applies either way.
   *
   * A predicate is how a host runs reads together while its writes keep their order: a call it
   * fails is a barrier, waiting for every call before it, and every call after waits for it. Read
   * A, read B, write C, read D, read E runs as `[A ‖ B] → C → [D ‖ E]`, so a read asked for after
   * a write sees what the write did. Calls the loop answers itself — `load_tools`, a call whose
   * arguments could not be read, an identical repeat `dedupeToolCalls` answers — are not put to
   * it, and count as reads. Inside a batch, `onToolResult` and the events arrive as calls finish.
   * A pool that reads the MCP `readOnlyHint` annotation can answer it; nothing in an OpenAI tool
   * definition can.
   */
  parallel?: boolean | ((call: ToolCallRequest) => boolean);
  /**
   * Answers an identical repeat of a call — the same name and the same arguments, word for word —
   * within one step from the first one, rather than dispatching it again.
   *
   * @defaultValue `true`
   *
   * @remarks
   * It holds whether or not the calls run in `parallel`: a model that asks the same
   * question twice in one reply gets one answer, and two that are still in flight share the
   * request. A call that threw is not an answer and is made again. The scope is the step and not
   * the run, because between steps other tools have run and the file the model read may be the
   * file it has since written.
   *
   * `false` dispatches every call. A predicate is asked per call and is how a tool that does
   * something rather than reads something opts out — `send_email` twice is two emails, and this
   * package cannot tell which tools those are. A pool that reads the MCP `readOnlyHint` and
   * `idempotentHint` annotations can answer it; nothing in an OpenAI tool definition can.
   */
  dedupeToolCalls?: boolean | ((call: ToolCallRequest) => boolean);
  /**
   * Collects artifacts from the two sources that take a guess, beside the `links` every run keeps:
   * `declare` has the model name them through `record_artifact`, and `detect` reads each successful
   * call for the shape of a write. Both off by default.
   *
   * @remarks
   * For servers that never send a `resource_link`, which is the source to rely on. One artifact per
   * location either way: a later write moves `action` on, a declaration over a detection fills in
   * the title and description and takes the `source` over, and a link over either takes over too.
   *
   * `record_artifact` is declared beside `hostTools`, in every mode, and answered by the loop
   * without `dispatch` seeing it. A declaration is believed only where some successful call in the
   * run was given or answered with the location, and is otherwise refused for the model to read;
   * run in a batch, it waits for the batch's other calls. `onToolCall` and `onToolResult` hear it
   * as they hear `load_tools`, and it counts in `toolCalls` but not in `used`.
   */
  artifacts?: ArtifactOptions;
  /**
   * Told of every call the model made, as it starts — the ones `dispatch` never sees included:
   * `load_tools`, an identical repeat answered from the first, and a call whose arguments could
   * not be read, which arrives with empty `args` and the model's own text in `raw`.
   *
   * @remarks
   * For a host that shows each call as it is made and fills it in when its result lands, which
   * `dispatch` alone cannot do for those three. Not awaited: a promise it returns is dropped.
   */
  onToolCall?: (call: ToolCallRequest) => void;
  /**
   * Told of every call's answer as it lands, whole, under the id `onToolCall` announced it by.
   *
   * @remarks
   * One per call the model made: a deduplicated repeat gets its own, carrying the answer it
   * shares with the first. With `parallel` they arrive as the calls finish, which need not be
   * the order they were made in; the transcript and the result's `toolCalls` keep that order.
   * Not awaited: a promise it returns is dropped.
   */
  onToolResult?: (result: ToolCallResult) => void;
  /**
   * Hooks gathered onto the question before the first request, and told the reply after — or
   * whichever of those `fire` names.
   *
   * @remarks
   * Only this question is touched — the last user message of `messages` — and the context is on
   * the request, never in the transcript handed back. An earlier question's context is therefore
   * the host's to send again: keep the result's `context` and `preface` beside the question, and
   * put them back with `withContext` on every later call. A question sent bare that was first
   * sent with context is a different prompt from that message on, and the server's prefix cache
   * is lost behind it on every turn.
   */
  hooks?: AgentLoopHooks;
  /**
   * Called before each step with the transcript, and what it returns replaces it — the point to
   * compact or prune a run that has grown into its window. Returning nothing keeps it. `window`
   * is what `planCompaction` wants to know, so a host need not track usage itself to compact
   * mid-run.
   */
  beforeStep?: (
    messages: readonly OpenAI.ChatCompletionMessageParam[],
    step: number,
    window: StepWindow,
  ) => OpenAI.ChatCompletionMessageParam[] | undefined | Promise<OpenAI.ChatCompletionMessageParam[] | undefined>;
  /**
   * The ledger an earlier run handed back for this transcript, to be continued. Its indexes have
   * to be into `messages` as given here — see `rebaseLedger` for a transcript rewritten since.
   * This run's requests start a new epoch, because the loop cannot see whether the request before
   * its first one had the same system prompt and tools. Absent starts an empty one.
   */
  ledger?: TokenLedger;
  /** Stops the run: the request in flight, and between steps and calls. */
  signal?: AbortSignal;
  /**
   * The run's own key — a run id, a conversation id — which keeps its prompt cache warm across
   * steps and beside other runs. Every request carries it as `SESSION_HEADER`, for a router's
   * sticky affinity.
   *
   * @remarks
   * On a llama.cpp server that reports `total_slots`, the run also holds one slot from its first
   * request to its return or throw, sent as `id_slot` with `cache_prompt: true`, and a notice says
   * which. The slot is the one this key held last where it is free; with every slot held, or one
   * held by this key already, the run goes unpinned. An `extraBody` naming `id_slot` is the host
   * pinning for itself and is left alone, and a server that refuses the field is latched off it.
   */
  session?: string;
  /** Told what the run is doing, as the events a watcher reads. */
  onEvent?: (event: RunEventInput) => void;
  /**
   * Takes tool calls a model wrote into its reply as text and runs them as calls, with a notice
   * saying so. A server whose tool-call parser does not match the model's template otherwise ends
   * the run on a reply that is only a call nobody made. Off leaves such a reply as the answer. See
   * `recoverToolCalls`.
   *
   * @defaultValue `true`
   */
  recoverToolCalls?: boolean;
  /**
   * Each step's request as first built, before it goes out — for measuring what was sent, not for
   * changing it, which is `beforeStep`'s.
   *
   * @remarks
   * Called once a step, synchronously, and what it throws ends the run. It is not called again
   * for what `runTurn` sends after that: a retry sends the same request, but a refusal is answered
   * with a lesser body — relaxed schemas, a field dropped — and a continuation with the reply so
   * far on the end, and neither is reported.
   */
  onRequest?: (request: AgentLoopRequest) => void;
  /** Each turn as it comes back, before its tools run. Recovered calls are in it as calls. */
  onTurn?: (turn: Turn, step: number) => void;
  /**
   * Each message as the loop appends it to the transcript, in transcript order, and awaited before
   * the loop goes on — so a host that stores its transcript has written the assistant message
   * before its tools run, and every tool result before the next request is sent.
   *
   * @remarks
   * The assistant message is the one replayed on later requests — arguments repaired, recovered
   * calls folded in, `reasoning_content` on it where `reasoningReplay` says — and comes with its
   * `turn`, as `onTurn` was handed it. Under `tool-loop` the result's `messages` drop that field
   * once the answer is written, so a host storing these rows drops it too (`dropReasoning`).
   * A tool result comes without one, and so do the two messages
   * a proxied run writes for its `preselected` shortlist, told as step zero's before any request.
   * What it returns is ignored: `beforeStep` is the one way to rewrite the transcript. What it
   * throws ends the run, and it is not called again for that run.
   *
   * Beside an assistant message the model wrote comes `written`, whose `raw` is the message as the
   * model produced it, for a host that shows or stores what was said rather than what is replayed.
   * See `WrittenMessage`.
   */
  onMessage?: (
    message: OpenAI.ChatCompletionMessageParam,
    step: number,
    turn?: Turn,
    written?: WrittenMessage,
  ) => void | Promise<void>;
  /**
   * How many times an answer cut off at `maxTokens` is continued, zero for never. Opt-in because
   * it spends another request, and on a server that does not continue a trailing assistant
   * message it spends one to find that out. See `continueTurn`.
   *
   * @defaultValue `0`
   */
  maxContinuations?: number;
}

/** What a finished loop hands back. */
export interface AgentLoopResult {
  /**
   * The last turn, as `onTurn` was handed it: the one that asked for no tools, or — where a call
   * `ended` the run — the one that made that call.
   *
   * @remarks
   * Ended by a call, its `content` is what the model wrote beside its calls, which is often
   * nothing, and its `toolCalls` are not empty. The run's answer is then whatever the ending tool
   * took — the question it asked, the work it handed off — and not this text.
   */
  turn: Turn;
  /**
   * The call whose answer said `end`, where one did: the first in the order the model asked, once
   * every call of its step was answered. Absent where the run ended on a turn that asked for no
   * tools.
   *
   * @remarks
   * Every other field is as a finished run has it: `messages` close on the step's tool results
   * with no assistant turn after them, the hooks are told `afterTurn` with `turn.content`, and
   * `metrics.outcome` is `ended`. No `beforeStep` or `compact` runs after the end, since no request
   * follows it. A host saying `done` passes the call on it — `id` the call, `name` the tool, `text`
   * the reason — which is how `runMetrics` reads the same outcome off the events.
   */
  ended?: EndedBy;
  /**
   * The transcript, with every assistant turn and tool result the run added. No system prompt.
   * Under `tool-loop`, no assistant message from the question on carries `reasoning_content`.
   */
  messages: OpenAI.ChatCompletionMessageParam[];
  /**
   * Summed over every turn of the run, in the spelling the `usage` events use, with whether any
   * turn reported a cache count. The four counts are also under their older names.
   */
  usage: LoopUsage;
  /**
   * Every call, `load_tools` included, in the order they were made, each under its call id — a
   * proxied preselection's among them, first.
   */
  toolCalls: ToolCallOutcome[];
  /**
   * What the run's calls linked to, one per uri in the order first seen, each with the call and
   * step that first linked to it and how many calls did. Empty where `dispatch` answered with
   * strings only and `artifacts` collected nothing else.
   */
  artifacts: RunArtifact[];
  /**
   * What is loaded at the end, for `carryOver`. Empty in eager mode, and in proxied mode: a
   * definition loaded there is already in the history, and one a compaction folded away has to be
   * loadable again rather than answered "already loaded".
   */
  loaded: string[];
  /** The tools the model actually called, `load_tools` excluded and `call_tool` looked through. */
  used: string[];
  /**
   * The shortlist the run opened with, as the host's `preselected` gave it or the loop's own
   * preselection picked it. Empty in eager mode, and where nothing was picked.
   */
  preselected: string[];
  /** The hooks' notes from before the first request. Empty where `fire` lists no injecting event. */
  notes: HookNote[];
  /**
   * The `<context>` blocks the hooks added to this question, as `withContext` takes them. Empty
   * when no hook added any, without `hooks`, and where `fire` lists no injecting event. Not in
   * `messages`, so a host that wants the next turn's request to begin with this one's stores it
   * beside the question; see `hooks`.
   */
  context: string;
  /**
   * What was said above `context`: the hooks' own `preface`, or what `configureHooks` had set when
   * the run began. Handed back because the second is not the host's to know later — with it,
   * `withContext(messages, at, context, preface)` is the question as it was sent, whatever the
   * process's preface has since become. Empty when the preface was turned off; with no `context`
   * nothing was said either way, and `withContext` adds nothing.
   */
  preface: string;
  /**
   * The `afterTurn` hooks' notes, once they have run — failures only, as `notify` returns them.
   * The loop does not wait for it, so the answer is never held for a hook; a host that stores the
   * notes with the turn, or must not exit before the turn is remembered, awaits it. Each note
   * reaches `onNote` as well. Already resolved and empty without `hooks`, and where `fire` leaves
   * `afterTurn` out — a host that tells it itself has the notes from its own `notify`. Rejects only
   * if `onNote` throws.
   */
  afterTurn: Promise<HookNote[]>;
  /**
   * The run summed and derived: what `runMetrics` makes of the events this loop emitted, with the
   * `load_tools` counts at zero rather than absent in a run on demand, `wallMs` from the call to
   * the return, and `outcome`. A host running several loops for one run gets its counts from
   * `runMetrics` over all their events, without these results beside it.
   */
  metrics: RunMetrics;
  /**
   * What each step's request reported its prompt as, indexed into `messages` above, for
   * `tokensBetween` and `estimateFrom`. The entries of a `ledger` passed in come first. A step
   * whose prompt was not reported has no entry.
   */
  ledger: TokenLedger;
}

/** What the loop remembers of one request, to explain the next one's cache. */
interface Sent extends RequestShape {
  /** The prompt the first request of the turn reported, before any continuation was joined. */
  prompt: number;
  /** The completion across the whole turn, continuations included. */
  completion: number;
}

/**
 * The share of the previous prompt a cache that kept its prefix reports as hit. Short of it by
 * more than this is a break, not the few tokens a template re-renders at the join.
 */
const CACHE_KEPT = 0.9;

/**
 * What one turn's cache should have been and whether it was, against the request before it.
 *
 * @param previous - The request before this one, with what it reported. Absent, or with no prompt
 * reported, diagnoses nothing.
 * @param next - The request this turn sent, read only to say why a broken cache broke.
 * @param usage - The turn's own report. Not written to. One with no `uncached` did not report its
 * cache, and is told what to expect without being judged.
 * @returns The fields to lay over the turn's usage: `cacheExpected`, the previous prompt plus its
 * completion; `cacheBroken` where the cache was reported; and `cacheBreakReason` where it broke.
 * Empty where nothing is diagnosed.
 *
 * @remarks
 * Nothing before the second request, or where the previous prompt was not reported.
 */
function cacheDiagnosis(previous: Sent | undefined, next: RequestShape, usage: TurnUsage): Partial<TurnUsage> {
  if (!previous || !(previous.prompt > 0)) {
    return {};
  }
  const found: Partial<TurnUsage> = { cacheExpected: previous.prompt + previous.completion };
  if (usage.uncached === undefined) {
    return found;
  }
  found.cacheBroken = usage.cached < previous.prompt * CACHE_KEPT;
  if (found.cacheBroken) {
    found.cacheBreakReason = breakReason(previous, next);
  }
  return found;
}

/** How `runAgentLoop` reads the run as it stands, from outside the steps that are building it. */
interface Standing {
  read: () => AgentLoopFailure;
}

/**
 * Runs a question to its answer: one `runTurn` per step, the tools it asks for between them,
 * until a turn asks for none or a call's answer ends the run. Throws when `maxToolIterations` is
 * spent, when stopped, and on whatever `runTurn` throws — `ContextOverflow` among them, however it
 * was found out.
 *
 * @param options - The config, transcript, tools and dispatcher, plus the optional hooks, events
 * and cancellation. See `AgentLoopOptions`.
 * @returns The turn that asked for no tools — or made the call that ended the run, with `ended`
 * naming it — and the run around it: the transcript with what the run added, usage, every call,
 * what is loaded and used, the hooks' notes and context, metrics and the ledger. See
 * `AgentLoopResult`.
 *
 * @remarks
 * What it throws carries the run as it stood — `messages`, `usage`, `toolCalls`, `loaded`, `used`
 * and `preselected` — because the steps before a failure were real and a host that stores its
 * transcript has nothing else to store them from. What the request in flight had said is on it
 * as `partial`, and not in `messages`. A spent budget is a `ToolIterationLimit`, an
 * overflow is an `AgentLoopOverflow`, which is still a `ContextOverflow`, and anything else is an
 * `AgentLoopError` with what was caught as its `cause` and its message as its own; `failedRun`
 * reads the run off any of the three. A failure while a step's tools run leaves the transcript
 * well-formed: the results that came back are kept, and each call without one is answered with a
 * line saying it was stopped or never run, since a call with no result is refused on replay.
 *
 * A tool that finishes the job — a hand-off, a question for a person — ends the run with a
 * `ToolAnswer` whose `end` is set, rather than by aborting it: the step's calls are all run and
 * answered, no further request is sent, and the loop resolves with `ended`. An end in the last step
 * `maxToolIterations` allows resolves too, since nothing was left undone.
 *
 * On-demand loading is handled here, `load_tools` and all: the catalogue rides on the system
 * prompt unchanged from step to step, a load adds to the tool array — which every request sends
 * in the stable order `toolOrder` asks for — and
 * a catalogued tool called without being loaded is loaded and run rather than refused, and a
 * preselection shapes the first step unless `preselectRouting` says to append it. A turn cut off
 * at `maxTokens` is said so as a notice, because it otherwise reads exactly like a finished one — or, given `maxContinuations`, is
 * continued first. Every turn ends in a `usage` event carrying the turn's own report, with the
 * cache compared against the request before it and the request broken down by what filled it; see
 * `TurnUsage` and `runMetrics`.
 *
 * Each step's reported prompt goes on a token ledger, in the same epoch as the step before where
 * the request only appended to it and in a new one where it did not — a `beforeStep` that rewrote
 * the transcript, a tool array a load grew — so that what the messages between two steps cost can
 * be read back as a subtraction. The prompt recorded is the first request's, before any
 * continuation, and a step that reported none, or reported a cache count above its prompt, is not
 * recorded. The ledger comes back in the result and on every `usage` event; see `tokensBetween`.
 *
 * Proxied discovery is the same catalogue behind a tool array that never moves: every step
 * declares `PROXY_TOOLS` and nothing else, a load answers with the definitions themselves, and a
 * `call_tool` is dispatched, counted and reported as the tool it names. A preselection has no
 * tool array to go into, so it is written into the transcript as a `load_tools` exchange after
 * the question. `call_tool` is honoured on demand too, unless the host has a tool of that name —
 * a session switched out of proxied mode still has it in its history, and the model copies it.
 * The host's own `hostTools` are declared beside whatever the mode sends, in every mode, and are
 * never catalogued.
 *
 * Neither side task is run unless asked for. `preselect` has the loop make the preselection and
 * `compact` has it fold the transcript, each by the task `config.tasks` carries for it and on
 * that task's own settings — a setting the task leaves out is the side task's default, never the
 * run's `temperature` or `maxTokens`.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  let pin: SessionPin | undefined;
  // Until the steps have set themselves up there is only what the caller handed over.
  const standing: Standing = {
    read: () => ({
      messages: [...options.messages],
      usage: loopUsage(noUsage(), false),
      toolCalls: [],
      artifacts: [],
      loaded: [],
      used: [],
      preselected: [],
    }),
  };
  let result: AgentLoopResult | undefined;
  const apart = hostToolsApart(withRecordTool(options));
  try {
    pin = await pinSession(apart);
    result = await runSteps(apart, standing, pin);
  } catch (error) {
    // Wrapped rather than annotated: an abort's reason is one object shared by every run under
    // the signal, so the run cannot be hung on the error itself. An overflow keeps its class,
    // because `instanceof ContextOverflow` is how a caller knows to compact and try again.
    throw error instanceof ContextOverflow
      ? new AgentLoopOverflow(error.message, standing.read(), { cause: error })
      : new AgentLoopError(errorMessage(error), standing.read(), { cause: error });
  } finally {
    pin?.release();
  }
  if (result) {
    return result;
  }
  throw new ToolIterationLimit(`Stopped after ${options.config.maxToolIterations} tool iterations.`, standing.read());
}

/** What a run's `session` adds to its requests, and the slot it holds while it runs. */
interface SessionPin {
  /** Laid under the config's `extraBody`: `id_slot` and `cache_prompt`, or nothing unpinned. */
  fields: Record<string, unknown>;
  /** Sent with every request: the session as `SESSION_HEADER`. */
  headers: Record<string, string>;
  /** The server reports slots, so each turn says whether it was `pinned`. */
  slotted: boolean;
  /** Frees the slot, where one is held. */
  release: () => void;
}

/**
 * Pins a run to a llama.cpp slot where it has a session and the server has slots to hand out.
 *
 * @param options - The run's options. Read for `session`, the config and the signal; a notice goes
 * to `onEvent`.
 * @returns The pin, unpinned on a server without slots, one that refused `id_slot` or whose slots
 * are all held. `undefined` without a session. Rejects only with the reason of `signal`.
 */
async function pinSession(options: AgentLoopOptions): Promise<SessionPin | undefined> {
  const { config, session, signal } = options;
  if (!session) {
    return undefined;
  }
  const headers = { [SESSION_HEADER]: session };
  const unpinned: SessionPin = { fields: {}, headers, slotted: false, release: () => {} };
  const pinsItself = config.extraBody !== undefined && SLOT_FIELD in config.extraBody;
  if (pinsItself) {
    return unpinned;
  }
  const total = await servedSlots(config, { signal });
  if (total === 0) {
    return unpinned;
  }
  const notice = (text: string) => options.onEvent?.({ kind: RunEventKind.Notice, text });
  const refused = modelCapabilitiesFor(capabilitiesFor(config.baseUrl, config.apiKey), config.model);
  if (refused.refusedFields.has(SLOT_FIELD)) {
    return { ...unpinned, slotted: true };
  }
  const slots = slotAllocator(config, config.model, total);
  const slot = slots.acquire(session);
  if (slot === undefined) {
    notice(`no free slot of ${total} for this session; running unpinned`);
    return { ...unpinned, slotted: true };
  }
  notice(`pinned to slot ${slot} of ${total}`);
  return {
    fields: { [SLOT_FIELD]: slot, [CACHE_PROMPT_FIELD]: true },
    headers,
    slotted: true,
    release: () => slots.release(session),
  };
}

/**
 * A message's words, as the preselector is asked about them: its string, or its text parts.
 *
 * @param message - The message to read. Absent, or with content that is neither a string nor
 * parts, reads as empty.
 * @returns The string as it is, or the text parts joined by newlines with parts of any other kind
 * left out. Not trimmed.
 */
const userText = (message: OpenAI.ChatCompletionMessageParam | undefined): string => {
  const content = message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.flatMap((part) => (part.type === PartType.Text ? part.text : [])).join('\n');
};

/**
 * The loop's own preselection: by the task where the config carries one, and by the flattened
 * name on its own endpoint where it does not.
 *
 * @param options - The run's options. Read for the config, the catalogue, the signal, what
 * `preselect` passes through, and `preselectQuery` or else the last user message, whose text is
 * what is asked about.
 * @param notice - Hears the preselector's notices, a failure among them.
 * @returns The names picked. Empty where the query is blank or there is no user message — nothing
 * is asked — and where the preselection picked nothing or failed. An aborted request still rejects.
 *
 * @remarks
 * With no preselector named the main model is asked, on the config's own endpoint.
 */
async function chooseTools(options: AgentLoopOptions, notice: OnNotice): Promise<string[]> {
  const { config, catalog = [], signal } = options;
  const prompt = options.preselectQuery ?? userText(options.messages.findLast((message) => message.role === Role.User));
  if (!prompt.trim()) {
    return [];
  }
  const asked = {
    ...(typeof options.preselect === 'object' ? options.preselect : {}),
    signal,
    onNotice: notice,
  };
  const selector = config.tasks?.toolSelect;
  if (!selector?.model) {
    return preselect(config, config.toolSelectModel || config.model, catalog, prompt, asked);
  }
  const call = taskCall(selector, asked, config);
  return preselect(call.endpoint, call.model, catalog, prompt, call.options);
}

/**
 * The loop's own summariser, which is the compaction task's or nothing: a summary the main model
 * writes is a second full-price request the operator did not ask for.
 *
 * @param options - The run's options. Read for `compact`, `config.tasks.compaction` and the signal.
 * @param notice - Hears the task's notices, and a summary that failed.
 * @returns A summariser resolving to the summary, or to an empty string where writing it failed —
 * an aborted request still rejects. `undefined` where `compact` is off or the task names no model.
 */
function ownSummariser(options: AgentLoopOptions, notice: OnNotice) {
  const { config, signal } = options;
  const compactor = options.compact ? config.tasks?.compaction : undefined;
  if (!compactor?.model) {
    return undefined;
  }
  const call = taskCall(compactor, { signal, onNotice: notice }, config);
  const write = summariser(call.endpoint, call.model, call.options);
  // A summary that fails folds nothing, and the step goes out as it was.
  return async (text: string) => (await tryAsk('compaction', () => write(text), { onNotice: notice, signal })) ?? '';
}

/**
 * A step's transcript with the loop's prune boundary moved, where a move was due.
 *
 * @param transcript - The step's messages. Not written to.
 * @param through - The boundary in force, which only ever moves forward.
 * @param context - The run's options, read for `prune`'s gate and the window; what the last
 * request reported, where it still describes `transcript`; the characters per token an estimate is
 * made at; whether a fold was just made; and `notice`, told of a move.
 * @returns `transcript` itself and the boundary unmoved where nothing was due, otherwise the
 * stubbed array, the new boundary and what it won back.
 */
function pruneBeforeStep(
  transcript: OpenAI.ChatCompletionMessageParam[],
  through: number,
  {
    options,
    used,
    charsPerToken,
    compacted = false,
    notice,
  }: { options: AgentLoopOptions; used?: number; charsPerToken: number; compacted?: boolean; notice: OnNotice },
): { messages: OpenAI.ChatCompletionMessageParam[]; through: number; tokens: number } {
  const gate = typeof options.prune === 'object' ? options.prune : {};
  const plan = planPrune(transcript, options.config.contextLength ?? 0, {
    ...gate,
    through,
    ...(used === undefined ? {} : { used }),
    charsPerToken,
    compacted,
  });
  if (!plan) {
    return { messages: transcript, through, tokens: 0 };
  }
  notice(pruneNotice(plan, compacted));
  return {
    messages: pruneThrough(transcript, plan.through, { maxChars: gate.maxChars }),
    through: plan.through,
    tokens: plan.tokens,
  };
}

/**
 * A step's transcript after the loop's own compaction: folded where a fold was due and its summary
 * came back, and otherwise the array it was given.
 *
 * @param transcript - The step's messages, after `beforeStep`. Not written to.
 * @param reported - The last request's prompt tokens as `used`, where they still describe this
 * transcript. Empty plans from an estimate instead.
 * @param summarise - Writes the summary. Not called where no fold is due.
 * @param context - The run's options, read for `compact`'s thresholds, the window, the compaction
 * task's ceiling and the hooks; the characters per token an estimate is made at; and `notice`,
 * told of a fold.
 * @returns `transcript` itself where nothing was folded, otherwise a new array with the folded
 * stretch replaced by its summary.
 */
async function foldBeforeStep(
  transcript: OpenAI.ChatCompletionMessageParam[],
  reported: { used?: number },
  summarise: (text: string) => Promise<string>,
  { options, charsPerToken, notice }: { options: AgentLoopOptions; charsPerToken: number; notice: OnNotice },
): Promise<OpenAI.ChatCompletionMessageParam[]> {
  const { config, hooks } = options;
  const told = hooks && firing(hooks).beforeCompact ? hooks : undefined;
  const compactor = config.tasks?.compaction;
  const plan = planCompaction(transcript, {
    ...(typeof options.compact === 'object' ? options.compact : {}),
    limit: config.contextLength ?? 0,
    ...reported,
    charsPerToken,
    ...((compactor?.maxTokens ?? 0) > 0 ? { summaryTokens: compactor?.maxTokens } : {}),
  });
  if (!plan) {
    return transcript;
  }
  const folded = await compactTranscript(transcript, plan, summarise, {
    ...(told ? { hooks: { run: told.run, context: told.context, onNote: told.onNote, offset: told.offset } } : {}),
  });
  if (folded !== transcript) {
    notice(`compacted ${plan.toSummarise.length} messages into a summary`);
  }
  return folded;
}

/**
 * Which events the loop fires for these hooks, read from `fire`, or from `events` without it.
 *
 * @param hooks - The run's hooks.
 * @returns The events to gather before the first request, and whether `afterTurn` and
 * `beforeCompact` are the loop's to fire.
 *
 * @remarks
 * Without `fire`, `events` goes to `gather` as it was given, unfiltered, so a host that had put
 * something odd in it sees what it saw before. With `fire`, only the injecting events are gathered:
 * a list that names every event is the whole of the loop's firing, and `afterTurn` gathered before
 * the request would be the hooks told a reply that does not exist yet.
 */
function firing(hooks: AgentLoopHooks): { before: readonly HookEvent[]; afterTurn: boolean; beforeCompact: boolean } {
  if (!hooks.fire) {
    return { before: hooks.events ?? [HookEvent.BeforeTurn], afterTurn: true, beforeCompact: true };
  }
  const fire = new Set(hooks.fire);
  return {
    before: [...fire].filter((event) => INJECT_EVENTS.has(event)),
    afterTurn: fire.has(HookEvent.AfterTurn),
    beforeCompact: fire.has(HookEvent.BeforeCompact),
  };
}

/**
 * Tells the `afterTurn` hooks what was answered, with the turn it closed where the question is
 * still in the transcript.
 *
 * @param hooks - The run's hooks: the runner, the context the hooks are told, and who hears a note.
 * @param messages - The transcript as the run ended, the answer on the end.
 * @param at - Where the question is in `messages`. Negative — there was none, or it has been
 * folded away — tells the hooks the reply and no `turn`.
 * @param reply - The answer's text.
 * @returns A promise of their notes — failures only, as `notify` returns them.
 */
const tellAfterTurn = (
  hooks: NonNullable<AgentLoopOptions['hooks']>,
  messages: OpenAI.ChatCompletionMessageParam[],
  at: number,
  reply: string,
): Promise<HookNote[]> =>
  notify(
    hooks.run,
    HookEvent.AfterTurn,
    {
      ...hooks.context,
      reply,
      ...(at >= 0
        ? {
            turn: {
              index: turnIndex(messages, at),
              messages: turnMessages(hooks.context.session.id, messages, at, undefined, { offset: hooks.offset }),
            },
          }
        : {}),
    },
    hooks.onNote,
  );

/**
 * The loop's own record of what it emitted, less the token deltas, for `runMetrics` at the end.
 *
 * @param heard - The host's `onEvent`, still told of every event, deltas included. Absent records
 * all the same.
 * @returns `recorded`, the array each event is added to as it is emitted, and `onEvent`, which the
 * loop emits through in place of the host's.
 *
 * @remarks
 * Stamped here rather than by the bus, which the loop does not know about.
 */
function recorder(heard: AgentLoopOptions['onEvent']) {
  const recorded: RunEvent[] = [];
  const onEvent = (input: RunEventInput) => {
    if (input.kind !== RunEventKind.Thinking && input.kind !== RunEventKind.Output) {
      recorded.push(stamp(input, '', recorded.length + 1, Date.now()));
    }
    heard?.(input);
  };
  return { recorded, onEvent };
}

/**
 * The names of the host's own tools.
 *
 * @param [tools] - The host's definitions. One that is not a function has no name, and is left out.
 * @returns A new set, empty where there are none.
 */
const hostToolNames = (tools: readonly OpenAI.ChatCompletionTool[] = []) =>
  new Set(tools.flatMap((tool) => toolName(tool) ?? []));

/**
 * The run's options with the host's own tools kept out of discovery: off the catalogue, and out of
 * what was carried and what was picked.
 *
 * @param options - What `runAgentLoop` was given. Not written to.
 * @returns `options` itself where there are no host tools, and otherwise a copy with `catalog`,
 * `loaded` and `preselected` filtered, a server that offers none of them kept as it was.
 *
 * @remarks
 * Done once, here, so that preselection, `load_tools`, `call_tool` and the catalogue prompt all
 * read one catalogue, and a host tool is never loadable however a name of one reaches the loop.
 */
function hostToolsApart(options: AgentLoopOptions): AgentLoopOptions {
  const own = hostToolNames(options.hostTools);
  if (own.size === 0) {
    return options;
  }
  const isCatalogued = (name: string) => own.has(name) === false;
  const { catalog, loaded, preselected } = options;
  const apart = (server: CatalogServer) =>
    server.tools.every((entry) => isCatalogued(entry.name))
      ? server
      : { ...server, tools: server.tools.filter((entry) => isCatalogued(entry.name)) };
  return {
    ...options,
    ...(catalog ? { catalog: catalog.map(apart) } : {}),
    ...(loaded ? { loaded: [...loaded].filter(isCatalogued) } : {}),
    // Undefined stays undefined: an empty shortlist is a host saying it has already decided.
    ...(preselected ? { preselected: preselected.filter(isCatalogued) } : {}),
  };
}

/**
 * The run's options with `record_artifact` among the host's tools, where the run declares.
 *
 * @param options - What `runAgentLoop` was given. Not written to.
 * @returns `options` itself where `artifacts.declare` is off, and otherwise a copy whose `hostTools`
 * open with the loop's definition, which a host tool of the same name does not displace.
 *
 * @remarks
 * A host tool in all but who answers it, so it is declared in every mode, kept off the catalogue,
 * recoverable from text, and refused through `call_tool` exactly as the host's own are.
 */
function withRecordTool(options: AgentLoopOptions): AgentLoopOptions {
  if (options.artifacts?.declare !== true) {
    return options;
  }
  return { ...options, hostTools: loadedTools([RECORD_ARTIFACT_TOOL], options.hostTools ?? []) };
}

/** What opens the notice naming the loop's own picks, ahead of the names. */
export const PRESELECTED_NOTICE = 'tools picked before the run: ';

/**
 * How this run finds its tools, and what it starts with in hand: the loop's own preselection
 * where it was asked for and the host has not already decided, and what an earlier question
 * carried over.
 *
 * @param options - The run's options. Read for the discovery mode, the catalogue, `loaded`,
 * `preselected` and `preselect`.
 * @param notice - Hears what the loop's own preselection has to say, and then what it picked,
 * by name. A shortlist the host gave is not told back to it.
 * @returns `proxied` and `onDemand`, the second true of both modes and both false where `catalog`
 * is empty; `preselected`, the shortlist, empty in eager mode; and `loaded`, a new set of what was
 * carried and then the shortlist — empty when eager or proxied.
 */
async function discovery(options: AgentLoopOptions, notice: OnNotice) {
  const { config, catalog = [] } = options;
  // On demand, but with a tool array that never changes: definitions come back as `load_tools`
  // results and run through `call_tool`. `onDemand` is true of both.
  const proxied = config.toolDiscovery === ToolDiscovery.Proxy && catalog.length > 0;
  const onDemand = proxied || (config.toolDiscovery === ToolDiscovery.OnDemand && catalog.length > 0);
  // Proxied, `loaded` is what this run has put a definition in the history for, and starts empty.
  const loaded = new Set(onDemand && !proxied ? (options.loaded ?? []) : []);
  const chooses = options.preselect && options.preselected === undefined;
  let preselected: string[] = [];
  if (onDemand && chooses) {
    preselected = await chooseTools(options, notice);
    if (preselected.length > 0) {
      notice(`${PRESELECTED_NOTICE}${preselected.join(', ')}`);
    }
  } else if (onDemand) {
    preselected = [...(options.preselected ?? [])];
  }
  if (!proxied) {
    for (const name of preselected) {
      loaded.add(name);
    }
  }
  return { proxied, onDemand, loaded, preselected };
}

/**
 * The host's definitions by name, the first kept where two share one.
 *
 * @param tools - Every definition the host gave. One that is not a function has no name and is
 * left out.
 * @returns A new map, in the order of `tools`, holding the definitions themselves.
 */
function definitionsByName(tools: OpenAI.ChatCompletionTool[]) {
  const definitions = new Map<string, OpenAI.ChatCompletionTool>();
  for (const tool of tools) {
    const name = toolName(tool);
    if (name !== undefined && !definitions.has(name)) {
      definitions.set(name, tool);
    }
  }
  return definitions;
}

/**
 * Offers each message written into the transcript to the host.
 *
 * @param onMessage - The host's callback, awaited. Absent offers nothing.
 * @returns The offer, taking a message, its step, the turn it came with and what the model wrote:
 * it resolves once the host has taken the message, and rejects with what the host threw — once.
 *
 * @remarks
 * Once `onMessage` has thrown the run is ending on that, and the results still to be written are
 * not offered to a host that has just failed to take one.
 */
function announcer(onMessage: AgentLoopOptions['onMessage']) {
  let heard = true;
  return async (message: OpenAI.ChatCompletionMessageParam, step: number, turn?: Turn, written?: WrittenMessage) => {
    if (!onMessage || !heard) {
      return;
    }
    try {
      await onMessage(message, step, turn, written);
    } catch (error) {
      heard = false;
      throw error;
    }
  };
}

/**
 * The `usage` event a turn ends in: the run's totals so far, and the turn's own report.
 *
 * @param usage - The run's totals, this turn's already added.
 * @param turn - The turn just finished, read for its usage and why it ended.
 * @param ledger - The ledger as it stands. Carried on the event as it is, not copied.
 * @param [contextLength] - The window the turn was served. Absent or zero leaves it off the report.
 * @returns The event, for the caller to emit.
 */
const usageEvent = (usage: LoopUsage, turn: Turn, ledger: TokenLedger, contextLength?: number): RunEventInput => {
  const { promptTokens, completionTokens, totalTokens, cachedTokens, cacheReported } = usage;
  const window = contextLength ? { contextLength } : {};
  return {
    kind: RunEventKind.Usage,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens,
      cacheReported,
      turn: { ...turn.usage, finishReason: turn.finishReason, ...window },
      ledger,
    },
  };
};

/**
 * The calls a turn made and the answer beside them, with calls the model wrote as text taken out
 * of the answer and counted as calls.
 *
 * @param turn - The turn as it came back. Not written to.
 * @param recoverable - The names a call written as text may use. Absent recovers nothing, and
 * nothing is looked for in a turn that made a named call of its own or has no text.
 * @param notice - Told when calls were recovered, and how many.
 * @returns `calls`, the turn's own less any with no name, and `content`, its text as it was — or,
 * where calls were recovered, those calls and the text without them, and `recovered` true.
 */
function turnCalls(turn: Turn, recoverable: string[] | undefined, notice: OnNotice) {
  // A call with no name is a fragment the server never finished sending: nothing to run, and
  // an assistant message naming it would be answered by nothing.
  const calls: ToolCall[] = turn.toolCalls.filter((call) => call.function.name);
  if (!recoverable || calls.length || !turn.content) {
    return { calls, content: turn.content, recovered: false };
  }
  const recovered = recoverToolCalls(turn.content, { names: recoverable });
  if (!recovered.toolCalls.length) {
    return { calls, content: turn.content, recovered: false };
  }
  notice(
    `recovered ${counted(recovered.toolCalls.length, 'tool call')} the model wrote as text; the server's tool-call parser does not match this model's template`,
  );
  return { calls: recovered.toolCalls, content: recovered.content, recovered: true };
}

/**
 * The steps of `runAgentLoop`, throwing what they caught as it was caught.
 *
 * @param options - What `runAgentLoop` was given.
 * @param standing - Written to: once the steps have set themselves up, its `read` is theirs, so the
 * caller can read the run as it stands whether they return or throw.
 * @param [pin] - What the run's session adds to each request. Absent adds nothing.
 * @returns The result of the turn that asked for no tools or whose calls ended the run, or
 * `undefined` when `maxToolIterations` is spent.
 */
async function runSteps(
  options: AgentLoopOptions,
  standing: Standing,
  pin?: SessionPin,
): Promise<AgentLoopResult | undefined> {
  const { config, system = '', tools = [], catalog = [], dispatch, hooks, signal } = options;
  const {
    onRequest,
    onTurn,
    onMessage,
    onToolCall,
    onToolResult,
    beforeStep,
    parallel = false,
    recoverToolCalls: recover = true,
    maxContinuations = 0,
    toolOrder = true,
    dedupeToolCalls = true,
    preselectRouting = PRESELECT_EXCLUSIVE,
    serverInstructions = false,
    artifacts: collecting = {},
  } = options;
  const dedupable = typeof dedupeToolCalls === 'function' ? dedupeToolCalls : () => dedupeToolCalls;
  const started = Date.now();
  const { recorded, onEvent } = recorder(options.onEvent);
  const client = getClient(config);
  const supports = capabilitiesFor(config.baseUrl, config.apiKey);
  const maxRetries = Math.max(0, Number(config.maxRetries) || 0);
  const notice = (text: string) => onEvent({ kind: RunEventKind.Notice, text });
  // The host's own fields win over the pin's, so an explicit `cache_prompt: false` stays false.
  const extraBody = pin ? { ...pin.fields, ...config.extraBody } : config.extraBody;
  const sending = { ...config, extraBody };
  const reasoningReplay = config.reasoningReplay ?? ReasoningReplay.ToolLoop;

  // Started before the preselection rather than after it: neither reads the other, and in a row
  // they cost the first request two round trips where one will do. A failing runner is a note, but
  // a host's `onNote` that throws rejects the gather, perhaps while the preselection is still out:
  // handled at once so that is no unhandled rejection, and still thrown below, where it always was.
  const fired = hooks && firing(hooks);
  const gathering: Promise<Gathered> = hooks
    ? gather(hooks.run, fired?.before ?? [], hooks.context, {
        signal,
        onNote: hooks.onNote,
        maxTokens: hooks.maxTokens,
      })
    : Promise.resolve({ context: '', notes: [] });
  gathering.catch(() => undefined);
  const { proxied, onDemand, loaded, preselected } = await discovery(options, notice);
  const instructions =
    serverInstructions === false
      ? ''
      : serverInstructionsPrompt(catalog, serverInstructions === true ? {} : serverInstructions);
  const summarise = ownSummariser(options, notice);
  const used = new Set<string>();
  const definitions = definitionsByName(tools);
  // Each once, by name, so one given twice is declared once.
  const hostTools = loadedTools([], options.hostTools ?? []);
  const hostNames = hostToolNames(hostTools);
  // After the head the mode declares, which a host tool of the same name does not displace.
  const withHost = (head: OpenAI.ChatCompletionTool[]) => (hostTools.length ? loadedTools(head, hostTools) : head);
  // Looked through unless the host has a tool by that name, which is then the host's to answer.
  const proxies = onDemand && !definitions.has(CALL_TOOL) && !hostNames.has(CALL_TOOL);
  // What a call the model wrote as text may name: the host's tools, and the loop's own on demand.
  const recoverable = [
    ...tools.map(toolName).filter((name) => name !== undefined),
    ...hostNames,
    ...(onDemand ? [LOAD_TOOLS, ...(proxies ? [CALL_TOOL] : [])] : []),
  ];
  // In the order the names are given, not the order of `tools`: `loaded` is a set, which iterates
  // in the order things were added, so a load appends and never reshuffles what went before.
  const byName = (names: Iterable<string>) => definedAs(definitions, names);

  let messages = [...options.messages];
  let usage = noUsage();
  let cacheReported = false;
  const toolCalls: ToolCallOutcome[] = [];
  const artifacts = new RunArtifacts();
  const { detect = false } = collecting;
  const detects = typeof detect === 'function' ? detect : detect ? () => true : undefined;
  // A box per request, emptied once its turn is in `messages`: a failure while the tools run had
  // no request in flight.
  let inFlight: InFlight = {};
  standing.read = () => {
    const partial = inFlight.read?.();
    return {
      messages,
      ...(partial ? { partial } : {}),
      usage: loopUsage(usage, cacheReported),
      toolCalls,
      artifacts: artifacts.list(),
      // As the result would have said it: proxied, nothing is loaded that the history does not hold.
      loaded: proxied ? [] : [...loaded],
      used: [...used],
      preselected: [...preselected],
    };
  };
  const announce = announcer(onMessage);
  // Held by reference rather than by index, so a `beforeStep` that folds the head into a summary
  // moves the question without losing it — and one that summarises the question away takes the
  // hooks' context with it, which is right.
  const question = messages.findLast((message) => message.role === Role.User);
  const questionAt = () => (question ? messages.indexOf(question) : -1);
  const gathered = await gathering;
  // Read once, so what the result hands back is what every step of this run said.
  const preface = hooks?.preface ?? configureHooks().preface;

  const loads = { toolsLoaded: 0, redundantLoads: 0, unknownToolNames: 0 };
  let previous: Sent | undefined;
  // The loop's prune boundary. Its stubs stay in `messages`, so between moves each request only
  // extends the last; a rewrite or a fold renumbers the transcript, and it starts again from zero.
  let pruneBoundary = 0;
  let ledger: TokenLedger = options.ledger ?? [];
  // The request the ledger's last entry came from, which is what the next one is measured against.
  // Nothing before this run's first: an earlier run's head is not something the loop can see.
  let measured: LedgerRequest | undefined;

  // Proxied, a shortlist has nowhere to go but the history, where its definitions sit after the
  // question.
  const shortlist = proxied
    ? byName(new Set(preselected)).filter((tool) => {
        const name = toolName(tool);
        return name !== undefined && inCatalog(catalog, name);
      })
    : [];
  const calling: Calling = {
    catalog,
    onDemand,
    proxied,
    proxies,
    definitions,
    hostNames,
    loaded,
    loads,
    used,
    toolCalls,
    artifacts,
    declares: collecting.declare === true,
    detects,
    dedupable,
    dispatch,
    parallel,
    signal,
    onEvent,
    onToolCall,
    onToolResult,
    announce,
  };

  if (shortlist.length) {
    await loadShortlist(calling, shortlist, messages);
  }

  for (let step = 0; step < config.maxToolIterations; step++) {
    // A stop aborts the request in flight, but a tool call already handed off runs to its own
    // end — so the signal is read between steps as well.
    signal?.throwIfAborted();
    const before = messages;
    const reported = previous && previous.prompt > 0 ? { used: previous.prompt } : {};
    const rewritten = await beforeStep?.(messages, step, {
      ...reported,
      limit: config.contextLength ?? 0,
      ledger,
    });
    const given = rewritten ?? messages;
    const isOwn = given === messages;
    if (isOwn === false) {
      pruneBoundary = 0;
    }
    // Read again after the turn: a reported prompt calibrates it.
    const planRatio = charsPerTokenFor(supports, config.model);
    // The last request's prompt describes this transcript only while nothing has rewritten it,
    // and less what a prune has just won back of it.
    const ownUsed = isOwn ? reported.used : undefined;
    const trimmed = options.prune
      ? pruneBeforeStep(given, pruneBoundary, { options, used: ownUsed, charsPerToken: planRatio, notice })
      : { messages: given, through: pruneBoundary, tokens: 0 };
    pruneBoundary = trimmed.through;
    const foldUsed = ownUsed === undefined ? {} : { used: Math.max(0, ownUsed - trimmed.tokens) };
    let next = summarise
      ? await foldBeforeStep(trimmed.messages, foldUsed, summarise, { options, charsPerToken: planRatio, notice })
      : trimmed.messages;
    if (options.prune && next !== trimmed.messages) {
      const after = pruneBeforeStep(next, 0, { options, charsPerToken: planRatio, compacted: true, notice });
      next = after.messages;
      pruneBoundary = after.through;
    }
    // A rewrite may have folded a definition away, and a load answered "already loaded" would
    // then point at nothing. Forgetting costs a definition sent twice at worst.
    if (proxied && next !== messages) {
      loaded.clear();
    }
    messages = next;
    ledger = rebaseLedger(ledger, before, messages);
    onEvent({ kind: RunEventKind.Turn, text: `turn ${step + 1}` });

    // Appended, the shortlist is already in `loaded` — after what was carried, and once — so the
    // first step needs nothing of its own. Proxied, it is in the history.
    const routed = !proxied && preselectRouting !== PRESELECT_APPEND && preselected.length > 0 && step === 0;
    // Ordered here rather than left to `buildBody`, so `names` below is what the request actually
    // declared — a diagnosis reading an order the server never saw calls an untouched tool array
    // `tools-changed`.
    let offered = withHost(tools);
    if (routed) {
      offered = withHost(byName(new Set(preselected)));
    } else if (proxied) {
      offered = withHost([...PROXY_TOOLS]);
    } else if (onDemand) {
      offered = loadedTools(withHost([LOAD_TOOLS_DEFINITION]), byName(loaded));
    }
    const declared = orderTools(offered, toolOrder);
    // Unmarked, so the system prompt is the same text on every step and a load does not throw
    // away the cache for the whole transcript. What is loaded is said in `declared` and in the
    // `load_tools` result instead. The preselected first step is the one exception, by design,
    // and `preselectRouting: "append"` is the way out of it.
    const catalogue = proxied ? proxyCatalogPrompt(catalog) : catalogPrompt(catalog);
    const catalogued = onDemand && !routed;
    const sections = [instructions, catalogued ? catalogue : ''].filter((text) => text !== '');
    // `system` as it was given when nothing is added, so a host with neither sees no change.
    const isBare = catalogued === false && sections.length === 0;
    const prompt = isBare ? system : [system, ...sections].join('\n\n').trim();
    const request: OpenAI.ChatCompletionMessageParam[] = [
      ...(prompt ? [{ role: Role.System, content: prompt }] : []),
      ...withContext(messages, questionAt(), gathered.context, preface),
    ];

    const build = (supported: Capabilities, refused: ModelCapabilities | undefined) =>
      buildBody(sending, supported, refused, request, declared, toolOrder);
    inFlight = {};
    const turnOptions = {
      model: config.model,
      inFlight,
      droppable: Object.keys(extraBody ?? {}),
      ...(pin ? { headers: pin.headers } : {}),
      maxRetries,
      loadingTimeoutMs: loadingMs(config),
      contextLimit: config.contextLength ?? 0,
      signal,
      idleMs: timeoutMs(config),
      firstChunkMs: firstTokenMs(config) ?? 0,
      onNotice: notice,
      onThinking: (text: string) => onEvent({ kind: RunEventKind.Thinking, text }),
      onOutput: (text: string) => onEvent({ kind: RunEventKind.Output, text }),
    };
    // Built the way `negotiate` is about to build the first attempt — the same flags, the same
    // model's refusals — so what the host is told is what is sent unless something is refused.
    if (onRequest) {
      const opening = build(supports, modelCapabilitiesFor(supports, config.model));
      onRequest({ messages: opening.messages, tools: opening.tools ?? [], step });
    }
    const first = await runTurn(client, supports, build, turnOptions);
    const names = declared.map((tool) => toolName(tool) ?? '');
    // Compared before any continuation is joined on: the cache a request meets is the one its own
    // prompt found, and a continuation's prompt is this request's plus the reply so far.
    // The breakdown measures the array `toolSchemaTokens` does, so where no prompt was reported
    // the two give one number for the tool block rather than two.
    const charsPerToken = charsPerTokenFor(supports, config.model);
    // Read after the turn, so a refusal answered by dropping `id_slot` counts this turn unpinned.
    const pinned = pin?.slotted
      ? {
          pinned:
            SLOT_FIELD in pin.fields && !modelCapabilitiesFor(supports, config.model).refusedFields.has(SLOT_FIELD),
        }
      : {};
    Object.assign(first.usage, cacheDiagnosis(previous, { messages: request, tools: names }, first.usage), pinned, {
      toolsDeclared: declared.length,
      toolSchemaTokens: Math.ceil(toolsChars(declared) / charsPerToken),
      context: contextTokens(
        { model: config.model, stream: true, messages: request, tools: declared },
        { charsPerToken, promptTokens: first.usage.prompt },
      ),
    });
    const firstPrompt = first.usage.prompt;
    // Recorded from the first request for the same reason. A cache count above the prompt is a
    // server reporting its prompt net of the cache, whose differences would measure nothing.
    const sent: LedgerRequest = {
      messages: request,
      tools: names,
      prompt: first.usage.cached > firstPrompt ? 0 : firstPrompt,
      through: messages.length - 1,
    };
    const entered = recordRequest(ledger, measured, sent);
    if (entered !== ledger) {
      measured = sent;
    }
    ledger = entered;
    const turn =
      maxContinuations > 0
        ? await continueTurn(client, supports, build, first, { ...turnOptions, maxContinuations })
        : first;
    inFlight = {};
    previous = {
      messages: request,
      tools: names,
      prompt: firstPrompt,
      completion: turn.usage.completion,
    };
    usage = addCounts(usage, turn.usage);
    cacheReported ||= reportsCache(turn.usage);
    onEvent(usageEvent(loopUsage(usage, cacheReported), turn, ledger, config.contextLength));
    if (turn.finishReason === FinishReason.Length) {
      notice(`the model stopped at maxTokens (${config.maxTokens}); this turn is cut short`);
    }
    const canRecover = recover && (tools.length > 0 || hostTools.length > 0 || onDemand);
    const { calls, content, recovered } = turnCalls(turn, canRecover ? recoverable : undefined, notice);
    const shown: Turn = { ...turn, content, toolCalls: calls };
    onTurn?.(shown, step);

    // Read before the assistant message is written, so what is replayed on every later request
    // is the repaired JSON.
    const parsed = readCalls(calls, turn.finishReason, recovered);
    const isAnswer = calls.length === 0;
    const replayed = replaysReasoning(reasoningReplay, !isAnswer) ? turn.reasoning : '';
    const assistant = assistantMessage(content, parsed, replayed);
    messages.push(assistant);
    // Recovered calls were never calls on the wire: what the model said is the text they came from.
    await announce(assistant, step, shown, { raw: writtenMessage(turn.content, recovered ? [] : calls, replayed) });

    const ended = isAnswer ? undefined : await runCalls(calling, parsed, messages, step);
    if (ended) {
      const by = ended.reason ? `: ${ended.reason}` : '';
      notice(`${ended.name} ended the run${by}`);
    }
    if (isAnswer || ended) {
      // The tool loop is over, so its scratchpads go; what came before the question is the host's.
      if (reasoningReplay === ReasoningReplay.ToolLoop) {
        messages = dropReasoning(messages, questionAt());
      }
      // Not awaited: the answer is ready, and remembering it is not something to hold it for.
      // Handed back instead, for a host that wants its notes.
      const afterTurn =
        hooks && fired?.afterTurn ? tellAfterTurn(hooks, messages, questionAt(), turn.content) : Promise.resolve([]);
      const metrics = runMetrics(recorded, { contextLength: config.contextLength });
      let outcome: RunOutcome = RunOutcome.Answered;
      if (ended) {
        outcome = RunOutcome.Ended;
      } else if (turn.finishReason === FinishReason.Length) {
        outcome = RunOutcome.Truncated;
      }
      return {
        turn: shown,
        ...(ended ? { ended } : {}),
        messages,
        usage: loopUsage(usage, cacheReported),
        toolCalls,
        artifacts: artifacts.list(),
        loaded: proxied ? [] : [...loaded],
        used: [...used],
        preselected: [...preselected],
        notes: gathered.notes,
        context: gathered.context,
        preface,
        afterTurn,
        metrics: {
          ...metrics,
          ...(onDemand ? loads : {}),
          wallMs: Date.now() - started,
          outcome,
        },
        ledger,
      };
    }
  }

  return undefined;
}
