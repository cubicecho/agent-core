import type OpenAI from 'openai';
import {
  type CompactionOptions,
  compactTranscript,
  isSummary,
  type PrunePlanOptions,
  planCompaction,
  planPrune,
  pruneNotice,
  pruneThrough,
  summariser,
} from '../context/compaction.ts';
import {
  cacheDiagnosis,
  type LedgerRequest,
  rebaseLedger,
  recordRequest,
  type SentRequest,
  sameMessage,
  type TokenLedger,
} from '../context/ledger.ts';
import type { Endpoint, ModelParams, RemoteAgentParams, RetryPolicy, ToolPolicy } from '../core/config.ts';
import { ReasoningReplay } from '../core/config.ts';
import { counted } from '../core/guards.ts';
import { charsPerTokenFor } from '../endpoint/calibration.ts';
import {
  type Capabilities,
  capabilitiesFor,
  type ModelCapabilities,
  modelCapabilitiesFor,
  type OnNotice,
} from '../endpoint/capabilities.ts';
import { firstTokenMs, getClient, loadingMs, timeoutMs } from '../endpoint/client.ts';
import { pinSession, type SessionPin, SLOT_FIELD } from '../endpoint/slots.ts';
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
import { discoverTools } from '../tools/discovery.ts';
import { type ServerInstructionsOptions, serverInstructionsPrompt } from '../tools/instructions.ts';
import type { KeywordPreselectOptions } from '../tools/preselect.ts';
import {
  CALL_TOOL,
  catalogPrompt,
  definedNames,
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
import { type CallIdMinter, CallIds, mintCallId as defaultMinter, distinctCallIds } from '../wire/call-ids.ts';
import { errorMessage } from '../wire/errors.ts';
import { ContextOverflow } from '../wire/retry.ts';
import {
  addCounts,
  type InFlight,
  type LoopUsage,
  loopUsage,
  noUsage,
  reportsCache,
  type Turn,
} from '../wire/stream.ts';
import { textOf } from '../wire/text.ts';
import { contextTokens, toolsChars } from '../wire/tokens.ts';
import { recoverToolCalls, type ToolCall } from '../wire/tool-calls.ts';
import { FinishReason, PARALLEL_TOOL_CALLS, Role } from '../wire/wire.ts';
import { type ArtifactOptions, RECORD_ARTIFACT_TOOL, RunArtifacts } from './artifacts.ts';
import type { EndedBy, RunArtifact, ToolCallOutcome, ToolCallRequest, ToolCallResult } from './dispatch.ts';
import {
  endingOf,
  type RunEvent,
  type RunEventInput,
  RunEventKind,
  type RunMetrics,
  RunOutcome,
  runMetrics,
  stamp,
} from './events.ts';
import { AgentLoopError, type AgentLoopFailure, AgentLoopOverflow, ToolIterationLimit } from './failure.ts';
import { asRemoteAgent, remoteRun, remoteRunOf } from './remote.ts';
import { buildBody, singleCalls, singleSystem } from './request-body.ts';
import {
  assistantMessage,
  type Calling,
  formatToolError as defaultToolError,
  definedAs,
  dropReasoning,
  loadShortlist,
  readCalls,
  replaysReasoning,
  replyMessages,
  runCalls,
  splitHandedBack,
  type ToolDispatch,
  type TurnOutcome,
  writtenMessage,
} from './run-calls.ts';

/**
 * The loop above a turn: send, run the tools the model asked for, send again, until it stops
 * asking.
 *
 * What is here is the part of an exchange that does not know what it is for; the prompts, the
 * tools and what a run means stay with the app.
 */

/**
 * What `onMessage` is handed beside an assistant message the model wrote: that message as the model
 * produced it.
 *
 * @remarks
 * The message `onMessage` is handed is what later requests replay — arguments repaired, `{}` for
 * none, recovered calls taken out of the text and made calls — which is right to send and quietly
 * wrong to show as the model's. Absent for a message the loop wrote itself, such as a proxied
 * exchange's preselected load.
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
 * One turn's request as `onRequest` is handed it: what the model is about to read.
 *
 * @remarks
 * The loop assembles this and nothing else sees it — the system prompt with the catalogue on it,
 * the hooks' context on the question, the tool array ordered and sanitised as it is sent — so an
 * app that wants to say what is filling the context window has nothing to measure without it.
 */
export interface AgentLoopRequest {
  /** The messages as sent, system prompt first. The request's own array, not a copy. */
  messages: readonly OpenAI.ChatCompletionMessageParam[];
  /**
   * The tools as sent: ordered, sanitised, relaxed where the model server needs it. Empty for none.
   */
  tools: readonly OpenAI.ChatCompletionTool[];
  /** Which turn of the exchange this is, from zero, as `beforeTurn` and `onTurn` count them. */
  turn: number;
}

/**
 * The hooks a loop runs around one question. See `hooks.ts`.
 *
 * @remarks
 * The loop gathers before its first request, beside its own preselection where it was asked for
 * one, and nothing else runs beside the two. An app with work of its own before the exchange to
 * overlap with the hooks — a compaction — calls `gather` itself, puts the context on with
 * `withContext`, and hands `preselectQuery` the question as it was written. It still passes
 * `hooks`, with `fire` leaving out what it fires itself:
 * `[HookEvent.BeforeCompact, HookEvent.AfterTurn]` has the loop compact for it and tell the
 * answer, with `question`, `turnBase` and `offset` saying what the transcript it handed over does
 * not — the question as typed, and where the app's numbering starts.
 */
export interface AgentLoopHooks {
  run: HookRunner;
  /**
   * What the hooks are told. `reply` and `turn` are filled in for `afterTurn`, and `prompt` from
   * `question` where it has none.
   */
  context: HookContext;
  /**
   * The events the loop fires, and the only ones: `sessionStart` and `beforeTurn` gathered before
   * the first request, in the order listed; `beforeCompact` beside each compaction `compact` makes;
   * and `afterTurn` once the exchange has its answer. `sessionEnd` and `sessionDelete` are the
   * app's, since the loop has no point that is either, and are ignored here.
   *
   * @defaultValue `events`, then `afterTurn` and `beforeCompact` — everything the loop has a point
   * for, as it fired before this existed.
   *
   * @remarks
   * For an app that fires some of them around the loop rather than inside it: one that tells
   * `beforeTurn` and `afterTurn` around a whole stage of its own, and wants only compaction's
   * `beforeCompact` from the loop, passes `[HookEvent.BeforeCompact]`. With `afterTurn` left out the
   * result's `afterTurn` is resolved and empty, and `notes` and `context` are empty with no
   * injecting event listed — the app's own `gather` and `notify` hold those instead.
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
   * What the exchange's first message is numbered as in the uuids hooks are told — the app's stored
   * index of `messages[0]`, for an app that numbers messages across exchanges or runs. Read for
   * `beforeCompact`'s `compacting` and `afterTurn`'s `turn`. See `turnMessages`.
   *
   * @defaultValue `0`
   */
  offset?: number;
  /**
   * The question as it was asked, for `afterTurn`: the text its `turn.messages` gives the
   * question, and the `prompt` it is told where `context` has none.
   *
   * @defaultValue The question as the transcript holds it.
   *
   * @remarks
   * For an app that put gathered context on the question before the loop saw it, so a memory
   * server files what was asked rather than what it recalled. Only the text is replaced: where the
   * question is is still read off the transcript, and its uuid's position with it.
   */
  question?: string;
  /**
   * The user messages of the app's transcript that `messages` does not hold, added to the
   * `turn.index` `afterTurn` is told — `turnIndex`'s `offset`. An app that hands the loop a
   * compacted transcript passes those the compaction took and did not send again; one that runs
   * each exchange from a transcript of its own passes how many exchanges came before it.
   *
   * @defaultValue `0`
   */
  turnBase?: number;
}

/** How full the context window is as a turn is about to be sent, as `beforeTurn` is told it. */
export interface TurnWindow {
  /**
   * The prompt tokens this exchange's last request reported. Absent before the first turn — an
   * earlier exchange's figure is the app's to vouch for, since the transcript may have been
   * compacted since — and where that request reported none. It does not count the reply and tool
   * results added since.
   */
  used?: number;
  /**
   * The model's context window, `config.contextLength`. Zero where the config names none, and on a
   * remote agent.
   */
  limit: number;
  /** The exchange's ledger so far, indexed into the transcript `beforeTurn` is handed beside it. */
  ledger: TokenLedger;
}

/**
 * The old name of `TurnWindow`.
 *
 * @deprecated Use `TurnWindow`.
 */
export type StepWindow = TurnWindow;

/** The `preselectRouting` that sends the first turn the shortlist alone. */
export const PRESELECT_EXCLUSIVE = 'exclusive' as const;

/** The `preselectRouting` that loads the shortlist after what was carried, and sends the first turn like any other. */
export const PRESELECT_APPEND = 'append' as const;

/** What `runAgentLoop` takes. */
export interface AgentLoopOptions {
  /**
   * The model server, what to ask the model for, and how long it may keep calling tools.
   * `toolDiscovery` absent is eager, `maxRetries` absent is none, and `contextLength` is handed to
   * `runTurn` as `contextLimit`, which sizes each request against the context window before
   * sending. `"proxy"` is on-demand loading behind a tool array that never changes; see
   * `PROXY_TOOLS`.
   *
   * @remarks
   * `tasks` is a resolved agent's, and is read only for the side tasks the loop was asked to run:
   * `tasks.toolSelect` under `preselect` and `tasks.compaction` under `compact`. `toolSelectModel`
   * is the flattened spelling of the first, for an app that is not on the spec. With neither
   * naming a model, `preselect` asks `model` itself; `compact` never does.
   *
   * `remoteAgent: true` (`RemoteAgentParams`) says the model is a remote agent, which runs its own
   * loop, and `contextLength` is then read as zero: see `runAgentLoop`.
   */
  config: Endpoint &
    (ModelParams | RemoteAgentParams) &
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
   * Every tool this exchange may reach. Eager mode sends all of them; on-demand mode sends the ones
   * loaded so far, by name; proxied mode declares none, and answers a load with them instead.
   */
  tools?: OpenAI.ChatCompletionTool[];
  /**
   * The app's own tools — a question for a person, a resource read — declared on every turn in
   * every discovery mode and dispatched like any other call, but never catalogued, loaded, or
   * reached through `call_tool`.
   *
   * @remarks
   * Each sits after the loop's own definitions: after `PROXY_TOOLS` proxied, after `load_tools` and
   * ahead of anything loaded on demand, after `tools` in eager mode, and after the shortlist on a
   * preselected first turn; `toolOrder` then orders the array as it always does. Proxied and eager,
   * the array is one set for the whole exchange, so the cache holds in either order; on demand,
   * `toolOrder: false` keeps them in the prefix every load appends after.
   *
   * A name of one is taken out of `catalog`, `loaded` and `preselected` before the exchange starts,
   * is never counted as a load, and is declared once where `tools` or the loop has it too. A
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
   * catalogue, as `serverInstructionsPrompt` writes them. Off by default, so no app's prompt
   * changes on upgrade.
   *
   * @defaultValue `false`
   *
   * @remarks
   * Read from `catalog` in every mode, eager included, so an app that wants them passes one either
   * way. The block is built once, from the catalogue rather than from what is loaded, so it is the
   * same text on every turn and covers a server none of whose tools is loaded; the preselected
   * first turn keeps it too, which leaves that turn's system prompt a prefix of the next one's.
   * `true` cuts each server's text at `SERVER_INSTRUCTION_TOKENS`; an object moves the budget.
   */
  serverInstructions?: boolean | ServerInstructionsOptions;
  /**
   * How the declared tools are ordered before each request. By name unless told otherwise, so an
   * exchange whose tool array was assembled in a different order than last time still meets its
   * cache. `false` sends them as given. See `orderTools`.
   */
  toolOrder?: ToolOrder;
  /**
   * What `preselect` picked. The first turn is sent these and nothing else — no catalogue, no
   * `load_tools` — because a model with the menu still in front of it shops: it reloads what it
   * has or picks a sibling. Everything comes back on the turn after. `preselectRouting` trades
   * that for a first turn shaped like the rest.
   *
   * @remarks
   * Proxied, the tool array is fixed and there is no such turn. The shortlist is written into the
   * transcript instead, after the question, as a `load_tools` call the model did not make and the
   * result that call would have had — an assistant message and a tool message, handed back in
   * `messages` like any other, reported as a `tool-call` and a `tool-result` event and told to
   * `onToolCall` and `onToolResult`. Names with no definition in `tools`, or outside the
   * catalogue, are left out, and with none left nothing is written.
   */
  preselected?: readonly string[];
  /**
   * What a preselection does to the first turn. `"exclusive"` is the shortlist alone
   * as `preselected` describes — and a system prompt and tool array unlike the last request's and
   * unlike the next turn's, so a prompt cache misses the whole transcript on the first turn and
   * again on the second. `"append"` loads the shortlist as a `load_tools` call would have and
   * sends the first turn like any other: the catalogue, `load_tools`, what `loaded` carried, then
   * the shortlist after it, with a name already carried left where it is. The price is the menu
   * back in front of the model. Which costs more has not been measured, which is why the default
   * has not moved.
   *
   * @defaultValue `PRESELECT_EXCLUSIVE`
   *
   * @remarks
   * Appended is before `toolOrder` has its say: sorted, a preselected tool lands at its name's
   * place and moves every definition after it, so only `toolOrder: false` keeps a carried array
   * a strict prefix. Either way the first turn's system prompt is the second's, and so is its
   * tool array until something else is loaded. Nothing to do without a preselection, in eager
   * mode, or proxied, where no turn is routed either way.
   */
  preselectRouting?: typeof PRESELECT_EXCLUSIVE | typeof PRESELECT_APPEND;
  /**
   * Has the loop make the preselection itself, before its first request, with the preselector
   * the config names. Opt-in, so that an app that passes a resolved agent and calls `preselect`
   * on its own is not sent a second one.
   *
   * @defaultValue `false`
   *
   * @remarks
   * The preselector is `config.tasks.toolSelect` with everything it states — its model server,
   * model, ceiling, temperature and reasoning effort, keyed as `taskCall` keys a task against
   * `config` — and otherwise `config.toolSelectModel` on the config's own model server at
   * `preselect`'s defaults. With neither naming a model it is `config.model` itself, on the same
   * terms as `toolSelectModel`: an app that opted in has asked for a preselection, and an empty
   * name is a setting nobody filled in rather than a refusal. An app that wants none passes no
   * `preselect`.
   *
   * What it is asked about is `preselectQuery`, and otherwise the text of the last user message as
   * the app gave it — the hooks' context is put on the request, never on `messages`, so the
   * tools are picked on what was asked rather than on what was recalled. Nothing is asked in eager
   * mode, with no question, or when `preselected` is given — an empty one included, which is how
   * an app says it has already decided.
   *
   * `true` takes `preselect`'s defaults; an object passes `keywords` and `maxPerLoad` through.
   * Its notices arrive as `notice` events, and a preselection that fails picks nothing rather
   * than ending the exchange. What it picked is a notice too, `PRESELECTED_NOTICE` and the names,
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
   * For an app that gathered its hooks itself and sent the question with `withContext` already on
   * it: the loop cannot tell the context from the question, and a preselector shown both picks
   * tools for whatever memory recalled. Blank asks nothing, as a blank question does.
   */
  preselectQuery?: string;
  /**
   * Has the loop compact the transcript itself before a turn, once `planCompaction` says the
   * context window is filling, with the summary written by `config.tasks.compaction` on its own
   * settings. Off by default, and nothing is compacted without that task — there is no falling back
   * to the main model — or without a `config.contextLength` to plan against.
   *
   * @remarks
   * It runs after `beforeTurn`, on what that returned, and is `compactTranscript` and nothing
   * more: the plan is made from the last request's reported prompt, or an estimate before the
   * first turn and after a `beforeTurn` rewrite; `hooks`, when given, are told `beforeCompact`
   * beside the summary; and a compaction is said as a `notice` event. A summary that fails is a
   * notice too and compacts nothing. Tool results are not pruned by this — `prune` is.
   *
   * The result's `messages` then open with the summary in place of what was compacted, so an app
   * that keeps its transcript append-only wants `runCompaction` and a stored compaction instead.
   * `true` plans by `planCompaction`'s defaults; an object moves its thresholds.
   */
  compact?: boolean | Pick<CompactionOptions, 'compactAt' | 'keepRatio' | 'target'>;
  /**
   * Has the loop stub old tool results itself before a turn, at a boundary `planPrune` moves, so
   * the prompt cache is lost once per move rather than once per tool call. Off by default, and
   * nothing moves without a `config.contextLength` — except alongside a compaction.
   *
   * @remarks
   * It runs after `beforeTurn`, on what that returned, and before `compact`, which then plans from
   * what is left: a prune that brings the exchange back under the line spares it the summary's
   * round trip. Where it compacts anyway, the boundary is moved again after it with `compacted`,
   * since the cache is already lost. Each move is said as a `notice` event, with
   * `pruneNotice`'s counts.
   *
   * The stubs are in the result's `messages`, as a summary is, so an app that keeps its transcript
   * whole calls `planPrune` and `pruneThrough` in its own `beforeTurn` and stores the boundary
   * instead. `true` plans by `planPrune`'s defaults — past `COMPACT_AT` of the context window, and
   * only for at least `PRUNE_SHARE` of it; an object moves the gate and what is kept.
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
   * ends the exchange once the turn's calls are answered; see `AgentLoopResult.ended`.
   */
  dispatch: ToolDispatch;
  /**
   * What the model reads for a call whose `dispatch` threw.
   *
   * @defaultValue `formatToolError`: the error's message behind `Error: `, unless it opens with
   * `error` already, and `Error: (no output)` for an empty one
   *
   * @remarks
   * Chat completions has no `is_error` field, so the text is the only place a model learns the
   * call failed; `ok: false` reaches the events and `onToolResult` either way. Not asked of the
   * refusals the loop writes itself — arguments it could not read, a `call_tool` outside the
   * catalogue, a call the exchange was stopped during — which keep their own words. An empty answer
   * from either path, a successful one included, is written as `(no output)`.
   */
  formatToolError?: (error: unknown) => string;
  /**
   * Runs a turn's calls together rather than one after another, or — given a predicate — runs
   * together the consecutive calls it passes, and each one it fails alone, in the order asked.
   *
   * @defaultValue `false`
   *
   * @remarks
   * Results go into the transcript in the order the model asked, whichever way they ran. See
   * `dedupeToolCalls`, which applies either way. Under `singleCallMessages`, or once the model has
   * refused several calls in one message, a turn's calls run one at a time whatever this says.
   *
   * A predicate is how an app runs reads together while its writes keep their order: a call it
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
   * Answers an identical repeat of a call — the same name, and the same arguments once read and
   * written back as JSON — within one turn from the first one, rather than dispatching it again.
   *
   * @defaultValue `true`
   *
   * @remarks
   * It holds whether or not the calls run in `parallel`: a model that asks the same
   * question twice in one reply gets one answer, and two that are still in flight share the
   * request. A call that threw is not an answer and is made again. The scope is the turn and not
   * the exchange, because between turns other tools have run and the file the model read may be the
   * file it has since written. Whitespace and a repaired argument do not tell two calls apart, but
   * the order of their keys does.
   *
   * `false` dispatches every call. A predicate is asked per call and is how a tool that does
   * something rather than reads something opts out — `send_email` twice is two emails, and this
   * package cannot tell which tools those are. A pool that reads the MCP `readOnlyHint` and
   * `idempotentHint` annotations can answer it; nothing in an OpenAI tool definition can.
   */
  dedupeToolCalls?: boolean | ((call: ToolCallRequest) => boolean);
  /**
   * Leaves calls for the app to answer later rather than dispatching them: the turn's other calls
   * run, and the exchange stops after the turn, waiting, with the calls in the result's `pending`.
   * `true` hands back every call to one of `hostTools`; a predicate is asked of every call that
   * would reach `dispatch`, by the name and arguments it would be dispatched with.
   *
   * @defaultValue `false`
   *
   * @remarks
   * For a call only something outside the exchange can answer — an app's own tool, a person's
   * approval — where ending the exchange would lose it. The transcript holds the turn's calls with
   * the handed-back ones last, so tool messages appended in `pending` order answer them in the
   * order of the call. A handed-back call is never deduplicated nor put to `parallel`, and a call
   * of the same turn that ends the exchange wins: see `AgentLoopResult.pending`.
   */
  handBack?: boolean | ((call: ToolCallRequest) => boolean);
  /**
   * Collects artifacts from the two sources that take a guess, beside the `links` every exchange
   * keeps: `declare` has the model name them through `record_artifact`, and `detect` reads each
   * successful call for the shape of a write. Both off by default.
   *
   * @remarks
   * For servers that never send a `resource_link`, which is the source to rely on. One artifact per
   * location either way: a later write moves `action` on, a declaration over a detection fills in
   * the title and description and takes the `source` over, and a link over either takes over too.
   *
   * `record_artifact` is declared beside `hostTools`, in every mode, and answered by the loop
   * without `dispatch` seeing it. A declaration is believed only where some successful call in the
   * exchange was given or answered with the location, and is otherwise refused for the model to
   * read; run in a batch, it waits for the batch's other calls. `onToolCall` and `onToolResult`
   * hear it as they hear `load_tools`, and it counts in `toolCalls` but not in `used`.
   */
  artifacts?: ArtifactOptions;
  /**
   * Told of every call the model made, as it starts — the ones `dispatch` never sees included:
   * `load_tools`, an identical repeat answered from the first, and a call whose arguments could
   * not be read, which arrives with empty `args` and the model's own text in `raw`.
   *
   * @remarks
   * For an app that shows each call as it is made and fills it in when its result lands, which
   * `dispatch` alone cannot do for those three. A handed-back call is told at the end of its turn;
   * one handed back in a turn another call ended, and one the turn never got to, are not told.
   * Not awaited: a promise it returns is dropped.
   */
  onToolCall?: (call: ToolCallRequest) => void;
  /**
   * Told of every call's answer as it lands, whole, under the id `onToolCall` announced it by.
   *
   * @remarks
   * One per call that came back: a deduplicated repeat gets its own, carrying the answer it shares
   * with the first. A handed-back call gets none, and neither does a call stopped part-way or never
   * run. With `parallel` they arrive as the calls finish, which need not be the order they were
   * made in; the transcript and the result's `toolCalls` keep that order.
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
   * the app's to send again: keep the result's `context` and `preface` beside the question, and
   * put them back with `withContext` on every later call. A question sent bare that was first
   * sent with context is a different prompt from that message on, and the server's prefix cache
   * is lost behind it on every turn.
   */
  hooks?: AgentLoopHooks;
  /**
   * Called before each turn with the transcript, and what it returns replaces it — the point to
   * compact or prune an exchange that has grown into its context window. Returning nothing keeps
   * it. `window` is what `planCompaction` wants to know, so an app need not track usage itself to
   * compact mid-exchange.
   */
  beforeTurn?: (
    messages: readonly OpenAI.ChatCompletionMessageParam[],
    turn: number,
    window: TurnWindow,
  ) => OpenAI.ChatCompletionMessageParam[] | undefined | Promise<OpenAI.ChatCompletionMessageParam[] | undefined>;
  /**
   * The old name of `beforeTurn`, called only where `beforeTurn` is not given.
   *
   * @deprecated Use `beforeTurn`, which is handed the same arguments.
   */
  beforeStep?: AgentLoopOptions['beforeTurn'];
  /**
   * Asked for input that arrived while the exchange was going — a person steering it — which the
   * exchange then goes on with as a user message.
   *
   * @remarks
   * Asked at the top of every turn, once the last turn's calls have all answered, and once more
   * when the model answers without calls, where input keeps the exchange going for another turn if
   * one is left. What it returns is appended, told to `onMessage` and as an `input` event, before
   * `beforeTurn` is handed the transcript. Input it still holds when the exchange returns is
   * the app's.
   */
  takeInput?: () =>
    | OpenAI.ChatCompletionUserMessageParam
    | undefined
    | Promise<OpenAI.ChatCompletionUserMessageParam | undefined>;
  /**
   * The ledger an earlier exchange handed back for this transcript, to be continued. Its indexes
   * have to be into `messages` as given here — see `rebaseLedger` for a transcript rewritten since.
   * This exchange's requests start a new epoch, because the loop cannot see whether the request
   * before its first one had the same system prompt and tools. Absent starts an empty one.
   *
   * @remarks
   * An exchange resumed after `pending` passes the waiting exchange's ledger as it came back: the
   * answers appended to its `messages` sit after every index in it, so it needs no rebase.
   */
  ledger?: TokenLedger;
  /** Stops the exchange: the request in flight, and between turns and calls. */
  signal?: AbortSignal;
  /**
   * The session's own key — a run id, a conversation id — which keeps its prompt cache warm across
   * turns and beside other sessions. Every request carries it as `SESSION_HEADER`, for a router's
   * sticky affinity.
   *
   * @remarks
   * On a llama.cpp server that reports `total_slots`, the exchange also holds one slot from its
   * first request to its return or throw, sent as `id_slot` with `cache_prompt: true`, and a notice
   * says which. The slot is the one this key held last where it is free; with every slot held, or
   * one held by this key already, the exchange goes unpinned. An `extraBody` naming `id_slot` is
   * the app pinning for itself and is left alone, and a server that refuses the field is latched
   * off it.
   */
  session?: string;
  /**
   * Told what the exchange is doing, as the events a watcher reads.
   *
   * @remarks
   * On a `remoteAgent` config, the server's events arrive whole, under its run id and numbering
   * (`'seq' in event` tells them apart). `emit` files one under the app's run and numbering, and
   * keeps its `at`.
   */
  onEvent?: (event: RunEventInput | RunEvent) => void;
  /**
   * Takes tool calls a model wrote into its reply as text and runs them as calls, with a notice
   * saying so. A server whose tool-call parser does not match the model's template otherwise ends
   * the exchange on a reply that is only a call nobody made. Off leaves such a reply as the answer,
   * and so does a `remoteAgent` config whatever this says. See `recoverToolCalls`.
   *
   * @defaultValue `true`
   */
  recoverToolCalls?: boolean;
  /**
   * Makes up the id of a call nobody gave one: a streamed call the server sent without an id, a
   * call recovered from text, and a proxied exchange's preselected load. A server's id is kept as
   * sent unless the transcript already uses it, and always on a remote agent.
   *
   * @defaultValue `mintCallId`, nine random characters from `[A-Za-z0-9]`
   *
   * @remarks
   * Whatever it returns is checked against every id in the transcript, the app's history
   * included, and asked again on a clash, so an id answers for one call across the exchange. Pass
   * `callIdMinter(seed)` for ids a test can predict. See `distinctCallIds`.
   */
  mintCallId?: CallIdMinter;
  /**
   * Whose ids the model's calls go under: the server's wherever the transcript has not used them,
   * or `minted`, an id from `mintCallId` for every call.
   *
   * @defaultValue `kept`
   *
   * @remarks
   * An id is unique within its own transcript either way. `minted` is for an app that matches
   * answers to calls across exchanges — one that hands calls back to another app and resumes
   * whichever exchange is waiting on the id that comes back — since many servers count ids from
   * zero on every turn. The id is given before the assistant message is stored, so the transcript,
   * the `tool-call` and `tool-result` events, `onToolCall`, `onToolResult` and `toolCalls` all
   * carry it. Ignored on a `remoteAgent` config, whose ids are kept as sent because the server
   * resumes its run by them.
   */
  callIds?: CallIds;
  /**
   * Each turn's request as first built, before it goes out — for measuring what was sent, not for
   * changing it, which is `beforeTurn`'s.
   *
   * @remarks
   * Called once a turn, synchronously, and what it throws ends the exchange. It is not called again
   * for what `runTurn` sends after that: a retry sends the same request, but a refusal is answered
   * with a lesser body — relaxed schemas, a field dropped — and a continuation with the reply so
   * far on the end, and neither is reported.
   */
  onRequest?: (request: AgentLoopRequest) => void;
  /** Each reply as it comes back, before its tools run. Recovered calls are in it as calls. */
  onTurn?: (reply: Turn, turn: number) => void;
  /**
   * Each message as the loop appends it to the transcript, in transcript order, and awaited before
   * the loop goes on — so an app that stores its transcript has written the assistant message
   * before its tools run, and every tool result before the next request is sent.
   *
   * @remarks
   * The assistant message is the one replayed on later requests — arguments repaired, recovered
   * calls folded in, the scratchpad on it where `reasoningReplay` says — and comes with its
   * `reply`, as `onTurn` was handed it. Under `tool-loop` the result's `messages` drop that field
   * once the answer is written, so an app storing these rows drops it too (`dropReasoning`).
   * A tool result comes without one, and so do the two messages
   * a proxied exchange writes for its `preselected` shortlist, told as turn zero's before any
   * request. What it returns is ignored: `beforeTurn` is the one way to rewrite the transcript.
   * What it throws ends the exchange, and it is not called again for that exchange.
   *
   * Beside an assistant message the model wrote comes `written`, whose `raw` is the message as the
   * model produced it, for an app that shows or stores what was said rather than what is replayed.
   * See `WrittenMessage`.
   */
  onMessage?: (
    message: OpenAI.ChatCompletionMessageParam,
    turn: number,
    reply?: Turn,
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
   * The last reply, as `onTurn` was handed it: the one that asked for no tools, or — where a call
   * `ended` the exchange, or calls are `pending` — the one that made those calls.
   *
   * @remarks
   * Ended by a call, its `content` is what the model wrote beside its calls, which is often
   * nothing, and its `toolCalls` are not empty. The exchange's answer is then whatever the ending
   * tool took — the question it asked, the work it handed off — and not this text.
   */
  turn: Turn;
  /**
   * The call whose answer said `end`, where one did: the first in the order the model asked, once
   * every call of its turn was answered. Absent where the exchange ended on a reply that asked for
   * no tools.
   *
   * @remarks
   * Every other field is as a finished exchange has it: `messages` close on the turn's tool results
   * with no assistant message after them, the hooks are told `afterTurn` with `turn.content`, and
   * `metrics.outcome` is `ended`. No `beforeTurn` or `compact` runs after the end, since no request
   * follows it. An app saying `done` passes the call on it — `id` the call, `name` the tool, `text`
   * the reason — which is how `runMetrics` reads the same outcome off the events.
   */
  ended?: EndedBy;
  /**
   * The calls `handBack` left for the app, in the order asked, where the exchange stopped to wait
   * for them: each by id, the name it was shown as, and its arguments. Absent where the exchange
   * answered or ended.
   *
   * @remarks
   * `messages` then end in the turn's assistant message and the results of the calls the loop ran,
   * with no result for these; `turn` is the reply that made them, `metrics.outcome` is `waiting`, a
   * `wait` event was emitted, and the `afterTurn` hooks were not told. To go on, the app calls the
   * loop again with `messages` and one tool message per call appended in this order, and with
   * `ledger` and `loaded` from this result. A call of the same turn that ended the exchange wins:
   * the calls that would have been handed back are answered as not run, and none is pending.
   */
  pending?: ToolCallRequest[];
  /**
   * The transcript, with every assistant message and tool result the exchange added. No
   * system prompt.
   * Under `tool-loop`, no assistant message from the question on carries a scratchpad.
   */
  messages: OpenAI.ChatCompletionMessageParam[];
  /**
   * Summed over every turn of the exchange, in the spelling the `usage` events use, with whether
   * any turn reported a cache count. The four counts are also under their older names.
   */
  usage: LoopUsage;
  /**
   * Every call that was run, `load_tools` included, in the order they were made, each under its
   * call id — a proxied preselection's among them, first. A handed-back call is not in it: one
   * still waiting is in `pending`.
   */
  toolCalls: ToolCallOutcome[];
  /**
   * What the exchange's calls linked to, one per uri in the order first seen, each with the call
   * and turn that first linked to it and how many calls did. Empty where `dispatch` answered with
   * strings only and `artifacts` collected nothing else.
   */
  artifacts: RunArtifact[];
  /**
   * What is loaded at the end, for `carryOver`. Empty in eager mode, and in proxied mode: a
   * definition loaded there is already in the history, and one a compaction removed has to be
   * loadable again rather than answered "already loaded".
   */
  loaded: string[];
  /** The tools the model actually called, `load_tools` excluded and `call_tool` looked through. */
  used: string[];
  /**
   * The shortlist the exchange opened with, as the app's `preselected` gave it or the loop's own
   * preselection picked it. Empty in eager mode, and where nothing was picked.
   */
  preselected: string[];
  /** The hooks' notes from before the first request. Empty where `fire` lists no injecting event. */
  notes: HookNote[];
  /**
   * The `<context>` blocks the hooks added to this question, as `withContext` takes them. Empty
   * when no hook added any, without `hooks`, and where `fire` lists no injecting event. Not in
   * `messages`, so an app that wants the next exchange's requests to begin with this one's stores
   * it beside the question; see `hooks`.
   */
  context: string;
  /**
   * What was said above `context`: the hooks' own `preface`, or what `configureHooks` had set when
   * the exchange began. Handed back because the second is not the app's to know later — with it,
   * `withContext(messages, at, context, preface)` is the question as it was sent, whatever the
   * process's preface has since become. Empty when the preface was turned off; with no `context`
   * nothing was said either way, and `withContext` adds nothing.
   */
  preface: string;
  /**
   * The `afterTurn` hooks' notes, once they have run — failures only, as `notify` returns them. The
   * loop does not wait for it, so the answer is never held for a hook; an app that stores the notes
   * with the exchange, or must not exit before the exchange is remembered, awaits it. Each note
   * reaches `onNote` as well. Already resolved and empty without `hooks`, and where `fire` leaves
   * `afterTurn` out — an app that tells it itself has the notes from its own `notify`. Never
   * rejects: a note `onNote` throws on is dropped.
   */
  afterTurn: Promise<HookNote[]>;
  /**
   * The exchange summed and derived: what `runMetrics` makes of the events this loop emitted, with
   * the `load_tools` counts at zero rather than absent in an exchange on demand, `wallMs` from the
   * call to the return, and `outcome`. An app running several exchanges for one run gets its counts
   * from `runMetrics` over all their events, without these results beside it.
   */
  metrics: RunMetrics;
  /**
   * What each turn's request reported its prompt as, indexed into `messages` above, for
   * `tokensBetween` and `estimateFrom`. The entries of a `ledger` passed in come first. A turn
   * whose prompt was not reported has no entry.
   */
  ledger: TokenLedger;
  /**
   * The remote agent's own run id, as its progress events named it, for a `remoteAgent` config —
   * the run a router's `GET /runs/<id>` reads. Absent elsewhere, and where no event arrived.
   */
  remoteRunId?: string;
}

/**
 * How `runAgentLoop` reads the exchange as it stands, from outside the turns that are building it.
 */
interface Standing {
  read: () => AgentLoopFailure;
}

/**
 * Runs a question to its answer: one `runTurn` per turn, the tools it asks for between them, until
 * a reply asks for none or a call's answer ends the exchange. Throws when `maxToolIterations` is
 * spent, when stopped, and on whatever `runTurn` throws — `ContextOverflow` among them, however it
 * was found out.
 *
 * @param options - The config, transcript, tools and dispatcher, plus the optional hooks, events
 * and cancellation. See `AgentLoopOptions`.
 * @returns The reply that asked for no tools — or made the call that ended the exchange, with
 * `ended` naming it, or the calls it waits on, in `pending` — and the exchange around it: the
 * transcript with what the exchange added, usage, every call, what is loaded and used, the hooks'
 * notes and context, metrics and the ledger. See `AgentLoopResult`.
 *
 * @remarks
 * What it throws carries the exchange as it stood — `messages`, `usage`, `toolCalls`, `loaded`,
 * `used`, `preselected` and `ledger` — because the turns before a failure were real and an app that
 * stores its transcript has nothing else to store them from. What the request in flight had said
 * is on it as `partial`, and not in `messages`. A spent budget is a `ToolIterationLimit`, an
 * overflow is an `AgentLoopOverflow`, which is still a `ContextOverflow`, and anything else is an
 * `AgentLoopError` with what was caught as its `cause` and its message as its own; `failedRun`
 * reads the exchange off any of the three. A failure while a turn's tools run leaves the transcript
 * well-formed: the results that came back are kept, and each call without one is answered with a
 * line saying it was stopped or never run, since a call with no result is refused on replay.
 *
 * A tool that finishes the job — a hand-off, a question for a person — ends the exchange with a
 * `ToolAnswer` whose `end` is set, rather than by aborting it: the turn's calls are all run and
 * answered, no further request is sent, and the loop resolves with `ended`. An end in the last turn
 * `maxToolIterations` allows resolves too, since nothing was left undone.
 *
 * A call only the app can answer later — one of its own tools — is left unanswered with `handBack`:
 * the turn's other calls run, a `wait` event is emitted, and the loop resolves with the call in
 * `pending`. The run goes on when the app calls the loop again with the answers appended; see
 * `AgentLoopResult.pending`.
 *
 * On-demand loading is handled here, `load_tools` and all: the catalogue rides on the system prompt
 * unchanged from turn to turn, a load adds to the tool array — which every request sends in the
 * stable order `toolOrder` asks for — and a catalogued tool called without being loaded is loaded
 * and run rather than refused, and a preselection shapes the first turn unless `preselectRouting`
 * says to append it. A reply cut off at `maxTokens` is said so as a notice, because it otherwise
 * reads exactly like a finished one — or, given `maxContinuations`, is continued first. Every turn
 * ends in a `usage` event carrying the turn's own report, with the cache compared against the
 * request before it and the request broken down by what filled it; see `TurnUsage` and
 * `runMetrics`.
 *
 * Each turn's reported prompt goes on a token ledger, in the same epoch as the turn before where
 * the request only appended to it and in a new one where it did not — a `beforeTurn` that rewrote
 * the transcript, a tool array a load grew — so that what the messages between two turns cost can
 * be read back as a subtraction. The prompt recorded is the first request's, before any
 * continuation, and a turn that reported none, or reported a cache count above its prompt, is not
 * recorded. The ledger comes back in the result and on every `usage` event; see `tokensBetween`.
 *
 * Proxied discovery is the same catalogue behind a tool array that never moves: every turn declares
 * `PROXY_TOOLS` and nothing else, a load answers with the definitions themselves, and a `call_tool`
 * is dispatched, counted and reported as the tool it names. A preselection has no tool array to go
 * into, so it is written into the transcript as a `load_tools` call and its result after the
 * question. `call_tool` is honoured on demand too, unless the app has a tool of that name — a
 * session switched out of proxied mode still has it in its history, and the model copies it. The
 * app's own `hostTools` are declared beside whatever the mode sends, in every mode, and are
 * never catalogued.
 *
 * Neither side task is run unless asked for. `preselect` has the loop make the preselection and
 * `compact` has it compact the transcript, each by the task `config.tasks` carries for it and on
 * that task's own settings — a setting the task leaves out is the side task's default, never the
 * exchange's `temperature` or `maxTokens`.
 *
 * On a `remoteAgent` config the model runs its own loop, and this one is a plain tool loop around
 * it: every request declares `tools` and `hostTools`, `dispatch` answers the calls the server hands
 * back, and the next request resumes the server's run by the ids it sent, which are kept as sent.
 * Only the sampling the config sets is sent, and the server's own work — compaction, pruning,
 * preselection, on-demand loading, continuations, the context-window guard — is left to it
 * (`asRemoteAgent`). Its progress is asked for and its events forwarded to `onEvent` in place of
 * the loop's own for its turns, and each turn carries one `IDEMPOTENCY_HEADER` across its retries
 * (`remoteRun`).
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  let pin: SessionPin | undefined;
  // Until the turns have set themselves up there is only what the caller handed over.
  const standing: Standing = {
    read: () => ({
      messages: [...options.messages],
      usage: loopUsage(noUsage(), false),
      toolCalls: [],
      artifacts: [],
      loaded: [],
      used: [],
      preselected: [],
      ledger: options.ledger ?? [],
    }),
  };
  let result: AgentLoopResult | undefined;
  const apart = hostToolsApart(withRecordTool(asRemoteAgent(options)));
  try {
    pin = await pinSession(apart.config, apart.session, {
      signal: apart.signal,
      // A remote agent's server picks the slots of the models it runs itself.
      serverPins: apart.config.remoteAgent === true,
      onNotice: (text) => apart.onEvent?.({ kind: RunEventKind.Notice, text }),
    });
    result = await runTurns(apart, standing, pin);
  } catch (error) {
    // Wrapped rather than annotated: an abort's reason is one object shared by every exchange under
    // the signal, so the exchange cannot be hung on the error itself. An overflow keeps its class,
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

/**
 * The loop's own summariser, which is the compaction task's or nothing: a summary the main model
 * writes is a second full-price request the operator did not ask for.
 *
 * @param options - The exchange's options. Read for `compact`, `config.tasks.compaction` and
 * the signal.
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
  // A summary that fails compacts nothing, and the turn goes out as it was.
  return async (text: string) => (await tryAsk('compaction', () => write(text), { onNotice: notice, signal })) ?? '';
}

/**
 * A turn's transcript with the loop's prune boundary moved, where a move was due.
 *
 * @param transcript - The turn's messages. Not written to.
 * @param through - The boundary in force, which only ever moves forward.
 * @param context - The exchange's options, read for `prune`'s gate and the context window; what
 * the last request reported, where it still describes `transcript`; the characters per token an
 * estimate is made at; whether a compaction was just made; and `notice`, told of a move.
 * @returns `transcript` itself and the boundary unmoved where nothing was due, otherwise the
 * stubbed array, the new boundary and what it won back.
 */
function pruneBeforeTurn(
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
 * A turn's transcript after the loop's own compaction: compacted where compaction was due and its
 * summary came back, and otherwise the array it was given.
 *
 * @param transcript - The turn's messages, after `beforeTurn`. Not written to.
 * @param reported - The last request's prompt tokens as `used`, where they still describe this
 * transcript. Empty plans from an estimate instead.
 * @param summarise - Writes the summary. Not called where no compaction is due.
 * @param context - The exchange's options, read for `compact`'s thresholds, the context window,
 * the compaction task's ceiling and the hooks; the characters per token an estimate is made at;
 * and `notice`, told of a compaction.
 * @returns `transcript` itself where nothing was compacted, otherwise a new array with the
 * compacted stretch replaced by its summary.
 */
async function foldBeforeTurn(
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
 * @param hooks - The exchange's hooks.
 * @returns The events to gather before the first request, and whether `afterTurn` and
 * `beforeCompact` are the loop's to fire.
 *
 * @remarks
 * Without `fire`, `events` goes to `gather` as it was given, unfiltered, so an app that had put
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
 * Tells the `afterTurn` hooks what was answered, with the exchange it closed where the question is
 * still in the transcript.
 *
 * @param hooks - The exchange's hooks: the runner, the context the hooks are told, who hears a
 * note, and the `question`, `turnBase` and `offset` that put the exchange in the app's terms.
 * @param messages - The transcript as the exchange ended, the answer on the end.
 * @param at - Where the question is in `messages`. Negative — there was none, or it has been
 * compacted away — tells the hooks the reply and no `turn`.
 * @param reply - The answer's text.
 * @returns A promise of their notes — failures only, as `notify` returns them.
 */
const tellAfterTurn = (
  hooks: NonNullable<AgentLoopOptions['hooks']>,
  messages: OpenAI.ChatCompletionMessageParam[],
  at: number,
  reply: string,
): Promise<HookNote[]> => {
  const { question, turnBase = 0 } = hooks;
  // At the question's own position, so its uuid is the one the app's stored question has.
  const told = question === undefined || at < 0 ? messages : messages.with(at, { role: Role.User, content: question });
  const prompt = hooks.context.prompt ?? question;
  return notify(
    hooks.run,
    HookEvent.AfterTurn,
    {
      ...hooks.context,
      ...(prompt === undefined ? {} : { prompt }),
      reply,
      ...(at >= 0
        ? {
            turn: {
              // A compaction's summary is a user message that stands for exchanges, not one of them.
              index: turnIndex(told, at, turnBase) - told.slice(0, at).filter(isSummary).length,
              messages: turnMessages(hooks.context.session.id, told, at, undefined, { offset: hooks.offset }),
            },
          }
        : {}),
    },
    hooks.onNote,
  );
};

/**
 * Whether a message is a question: a user message that is not a compaction's summary.
 *
 * @param message - One message of the transcript.
 * @returns True of a `user` message `isSummary` does not claim.
 */
const isQuestion = (message: OpenAI.ChatCompletionMessageParam) =>
  message.role === Role.User && isSummary(message) === false;

/**
 * The loop's own record of what it emitted, less the token deltas, for `runMetrics` at the end.
 *
 * @param heard - The app's `onEvent`, still told of every event, deltas included. Absent records
 * all the same.
 * @returns `recorded`, the array each event is added to as it is emitted, and `onEvent`, which the
 * loop emits through in place of the app's.
 *
 * @remarks
 * Stamped here rather than by the bus, which the loop does not know about.
 */
function recorder(heard: AgentLoopOptions['onEvent']) {
  const recorded: RunEvent[] = [];
  const onEvent = (input: RunEventInput | RunEvent) => {
    if (input.kind !== RunEventKind.Thinking && input.kind !== RunEventKind.Output) {
      recorded.push(stamp(input, '', recorded.length + 1, Date.now()));
    }
    heard?.(input);
  };
  return { recorded, onEvent };
}

/**
 * The names of the app's own tools.
 *
 * @param [tools] - The app's definitions. One that is not a function has no name, and is left out.
 * @returns A new set, empty where there are none.
 */
const hostToolNames = (tools: readonly OpenAI.ChatCompletionTool[] = []) =>
  new Set(tools.flatMap((tool) => toolName(tool) ?? []));

/**
 * The exchange's options with the app's own tools kept out of discovery: off the catalogue, and out
 * of what was carried and what was picked.
 *
 * @param options - What `runAgentLoop` was given. Not written to.
 * @returns `options` itself where there are no app tools, and otherwise a copy with `catalog`,
 * `loaded` and `preselected` filtered, a server that offers none of them kept as it was.
 *
 * @remarks
 * Done once, here, so that preselection, `load_tools`, `call_tool` and the catalogue prompt all
 * read one catalogue, and an app tool is never loadable however a name of one reaches the loop.
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
    // Undefined stays undefined: an empty shortlist is an app saying it has already decided.
    ...(preselected ? { preselected: preselected.filter(isCatalogued) } : {}),
  };
}

/**
 * The exchange's options with `record_artifact` among the app's tools, where the exchange declares.
 *
 * @param options - What `runAgentLoop` was given. Not written to.
 * @returns `options` itself where `artifacts.declare` is off, and otherwise a copy whose `hostTools`
 * open with the loop's definition, which an app tool of the same name does not displace.
 *
 * @remarks
 * An app tool in all but who answers it, so it is declared in every mode, kept off the catalogue,
 * recoverable from text, and refused through `call_tool` exactly as the app's own are.
 */
function withRecordTool(options: AgentLoopOptions): AgentLoopOptions {
  if (options.artifacts?.declare !== true) {
    return options;
  }
  return { ...options, hostTools: loadedTools([RECORD_ARTIFACT_TOOL], options.hostTools ?? []) };
}

/**
 * Forgets each proxied load whose definition is no longer anywhere in the transcript.
 *
 * @param loaded - What the exchange has put a definition in the history for. Written to: a name
 * with no definition left in `messages` is taken out.
 * @param messages - The transcript a `beforeTurn`, a prune or compaction has just handed the turn.
 *
 * @remarks
 * Read from the tool results' text rather than from which array or message objects survived, so an
 * app that rebuilds its transcript from a store each turn keeps what it still sends.
 */
function forgetFolded(loaded: Set<string>, messages: readonly OpenAI.ChatCompletionMessageParam[]): void {
  const present = new Set(
    messages.flatMap((message) => (message.role === Role.Tool ? definedNames(textOf(message.content)) : [])),
  );
  for (const name of loaded) {
    if (present.has(name) === false) {
      loaded.delete(name);
    }
  }
}

/**
 * The app's definitions by name, the first kept where two share one.
 *
 * @param tools - Every definition the app gave. One that is not a function has no name and is
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
 * Offers each message written into the transcript to the app.
 *
 * @param onMessage - The app's callback, awaited. Absent offers nothing.
 * @returns The offer, taking a message, its turn, the reply it came with and what the model wrote:
 * it resolves once the app has taken the message, and rejects with what the app threw — once.
 *
 * @remarks
 * Once `onMessage` has thrown the exchange is ending on that, and the results still to be written
 * are not offered to an app that has just failed to take one.
 */
function announcer(onMessage: AgentLoopOptions['onMessage']) {
  let heard = true;
  return async (message: OpenAI.ChatCompletionMessageParam, turn: number, reply?: Turn, written?: WrittenMessage) => {
    if (!onMessage || !heard) {
      return;
    }
    try {
      await onMessage(message, turn, reply, written);
    } catch (error) {
      heard = false;
      throw error;
    }
  };
}

/**
 * The `usage` event a turn ends in: the exchange's totals so far, and the turn's own report.
 *
 * @param usage - The exchange's totals, this turn's already added.
 * @param turn - The reply just finished, read for its usage and why it ended.
 * @param ledger - The ledger as it stands. Carried on the event as it is, not copied.
 * @param [contextLength] - The context window the turn was served. Absent or zero reports none.
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
 * The calls a reply made and the answer beside them, with calls the model wrote as text taken out
 * of the answer and counted as calls.
 *
 * @param turn - The reply as it came back. Not written to.
 * @param recoverable - The names a call written as text may use. Absent recovers nothing, and
 * nothing is looked for in a reply that made a named call of its own or has no text.
 * @param notice - Told when calls were recovered, and how many.
 * @param mint - Where a recovered call's id comes from.
 * @returns `calls`, the reply's own less any with no name, and `content`, its text as it was — or,
 * where calls were recovered, those calls and the text without them, and `recovered` true.
 */
function turnCalls(turn: Turn, recoverable: string[] | undefined, notice: OnNotice, mint: CallIdMinter) {
  // A call with no name is a fragment the server never finished sending: nothing to run, and
  // an assistant message naming it would be answered by nothing.
  const calls: ToolCall[] = turn.toolCalls.filter((call) => call.function.name);
  if (!recoverable || calls.length || !turn.content) {
    return { calls, content: turn.content, recovered: false };
  }
  const recovered = recoverToolCalls(turn.content, { names: recoverable, mintCallId: mint });
  if (!recovered.toolCalls.length) {
    return { calls, content: turn.content, recovered: false };
  }
  notice(
    `recovered ${counted(recovered.toolCalls.length, 'tool call')} the model wrote as text; the server's tool-call parser does not match this model's template`,
  );
  return { calls: recovered.toolCalls, content: recovered.content, recovered: true };
}

/**
 * Which calls an exchange hands back, as `handBack` says it.
 *
 * @param handBack - The option as given.
 * @param hostNames - The app's own tools by name, which `true` hands back.
 * @returns The predicate, or `undefined` where nothing is handed back.
 */
function handsBackFor(
  handBack: NonNullable<AgentLoopOptions['handBack']>,
  hostNames: ReadonlySet<string>,
): ((call: ToolCallRequest) => boolean) | undefined {
  if (handBack === true) {
    return (call) => hostNames.has(call.name);
  }
  return handBack === false ? undefined : handBack;
}

/**
 * How an exchange that stops after this turn ended.
 *
 * @param reply - The turn's reply, read for its finish reason.
 * @param settled - What its calls came to.
 * @returns `ended` where a call ended it, `waiting` where calls were handed back, and otherwise
 * what the finish reason says.
 */
function exchangeOutcome(reply: Turn, { ended, pending }: TurnOutcome): RunOutcome {
  if (ended) {
    return RunOutcome.Ended;
  }
  if (pending.length > 0) {
    return RunOutcome.Waiting;
  }
  return endingOf(reply.finishReason);
}

/**
 * The turns of `runAgentLoop`, throwing what they caught as it was caught.
 *
 * @param options - What `runAgentLoop` was given.
 * @param standing - Written to: once the turns have set themselves up, its `read` is theirs, so the
 * caller can read the exchange as it stands whether they return or throw.
 * @param [pin] - What the exchange's session adds to each request. Absent adds nothing.
 * @returns The result of the turn that asked for no tools, whose calls ended the exchange, or whose
 * calls were handed back, or `undefined` when `maxToolIterations` is spent.
 */
async function runTurns(
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
    // The deprecated name is read only where the new one is not given.
    beforeTurn = options.beforeStep,
    takeInput,
    parallel = false,
    formatToolError = defaultToolError,
    recoverToolCalls: recover = true,
    mintCallId = defaultMinter,
    callIds = CallIds.Kept,
    maxContinuations = 0,
    toolOrder = true,
    dedupeToolCalls = true,
    handBack = false,
    preselectRouting = PRESELECT_EXCLUSIVE,
    serverInstructions = false,
    artifacts: collecting = {},
  } = options;
  const dedupable = typeof dedupeToolCalls === 'function' ? dedupeToolCalls : () => dedupeToolCalls;
  const started = Date.now();
  const { recorded, onEvent: told } = recorder(options.onEvent);
  const remote =
    config.remoteAgent === true ? remoteRun(config.extraBody, told, { field: config.progressField }) : undefined;
  const onEvent = remote?.emit ?? told;
  const client = getClient(config);
  const supports = capabilitiesFor(config.baseUrl, config.apiKey);
  const maxRetries = Math.max(0, Number(config.maxRetries) || 0);
  const notice = (text: string) => onEvent({ kind: RunEventKind.Notice, text });
  // The app's own fields win over the pin's, so an explicit `cache_prompt: false` stays false.
  const ownBody = remote?.extraBody ?? config.extraBody;
  const extraBody = pin ? { ...pin.fields, ...ownBody } : ownBody;
  const sending = { ...config, extraBody };
  const reasoningReplay = config.reasoningReplay ?? ReasoningReplay.All;

  // Started before the preselection rather than after it: neither reads the other, and in a row
  // they cost the first request two round trips where one will do. A failing runner is a note, but
  // an app's `onNote` that throws rejects the gather, perhaps while the preselection is still out:
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
  const { proxied, onDemand, loaded, preselected } = await discoverTools(options, notice);
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
  // After the head the mode declares, which an app tool of the same name does not displace.
  const withHost = (head: OpenAI.ChatCompletionTool[]) => (hostTools.length ? loadedTools(head, hostTools) : head);
  // Looked through unless the app has a tool by that name, which is then the app's to answer.
  const proxies = onDemand && !definitions.has(CALL_TOOL) && !hostNames.has(CALL_TOOL);
  // What a call the model wrote as text may name: the app's tools, and the loop's own on demand.
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
  // A box per request, emptied once its reply is in `messages`: a failure while the tools run had
  // no request in flight.
  let inFlight: InFlight = {};
  // Declared before `standing.read`, which a failure in the hooks' gather already reads.
  let ledger: TokenLedger = options.ledger ?? [];
  // The exchange as it stands, which a failure and a result both carry: written once so they
  // cannot drift.
  const runSoFar = () => ({
    messages,
    usage: loopUsage(usage, cacheReported),
    toolCalls,
    artifacts: artifacts.list(),
    // Proxied, nothing is loaded that the history does not hold.
    loaded: proxied ? [] : [...loaded],
    used: [...used],
    preselected: [...preselected],
    ledger,
    ...remoteRunOf(remote),
  });
  standing.read = () => {
    const partial = inFlight.read?.();
    return { ...runSoFar(), ...(partial ? { partial } : {}) };
  };
  const announce = announcer(onMessage);
  // What `takeInput` handed over, which are user messages the question has to be told apart from.
  const admitted: OpenAI.ChatCompletionMessageParam[] = [];
  const isAdmitted = (message: OpenAI.ChatCompletionMessageParam) =>
    admitted.some((input) => sameMessage(input, message));
  const admit = async (input: OpenAI.ChatCompletionUserMessageParam, turn: number) => {
    messages.push(input);
    admitted.push(input);
    onEvent({ kind: RunEventKind.Input, text: textOf(input.content) });
    await announce(input, turn);
  };
  // Held by reference, so a `beforeTurn` that compacts the head into a summary moves the question
  // without losing it, and found again by role where an app rebuilt the transcript and the object
  // went with it: the only user messages the loop writes are its input, so the question is the
  // last other one that is not a summary. One that summarises the question away took every user
  // message before it too, and the hooks' context goes with it, which is right.
  const question = messages.findLast(isQuestion);
  const questionAt = () => {
    const at = question ? messages.indexOf(question) : -1;
    const isFound = at >= 0 || question === undefined;
    return isFound ? at : messages.findLastIndex((message) => isQuestion(message) && isAdmitted(message) === false);
  };
  const gathered = await gathering;
  // Read once, so what the result hands back is what every turn of this exchange said.
  const preface = hooks?.preface ?? configureHooks().preface;

  const loads = { toolsLoaded: 0, redundantLoads: 0, unknownToolNames: 0 };
  let previous: SentRequest | undefined;
  // The loop's prune boundary. Its stubs stay in `messages`, so between moves each request only
  // extends the last; a rewrite or a compaction renumbers the transcript, and it starts again
  // from zero.
  let pruneBoundary = 0;
  // The request the ledger's last entry came from, which is what the next one is measured against.
  // Nothing before this exchange's first: an earlier exchange's head is not something the loop
  // can see.
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
    handsBack: handsBackFor(handBack, hostNames),
    dispatch,
    formatToolError,
    parallel,
    signal,
    onEvent,
    onToolCall,
    onToolResult,
    announce,
    mintCallId,
  };

  if (shortlist.length) {
    await loadShortlist(calling, shortlist, messages);
  }

  // Whether the turn before this one said it was calling tools and sent none, and was asked again.
  let askedAgain = false;

  for (let turn = 0; turn < config.maxToolIterations; turn++) {
    // A stop aborts the request in flight, but a tool call already handed off runs to its own
    // end — so the signal is read between turns as well.
    signal?.throwIfAborted();
    const input = await takeInput?.();
    if (input) {
      await admit(input, turn);
    }
    const before = messages;
    const reported = previous && previous.prompt > 0 ? { used: previous.prompt } : {};
    const rewritten = await beforeTurn?.(messages, turn, {
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
      ? pruneBeforeTurn(given, pruneBoundary, { options, used: ownUsed, charsPerToken: planRatio, notice })
      : { messages: given, through: pruneBoundary, tokens: 0 };
    pruneBoundary = trimmed.through;
    const foldUsed = ownUsed === undefined ? {} : { used: Math.max(0, ownUsed - trimmed.tokens) };
    let next = summarise
      ? await foldBeforeTurn(trimmed.messages, foldUsed, summarise, { options, charsPerToken: planRatio, notice })
      : trimmed.messages;
    if (options.prune && next !== trimmed.messages) {
      const after = pruneBeforeTurn(next, 0, { options, charsPerToken: planRatio, compacted: true, notice });
      next = after.messages;
      pruneBoundary = after.through;
    }
    // A rewrite may have compacted a definition away, and a load answered "already loaded" would
    // then point at nothing. Only those are forgotten: a copy, or a prune that stubbed other
    // results, left every definition where it was, and sending one again costs its tokens twice.
    if (proxied && next !== messages) {
      forgetFolded(loaded, next);
    }
    messages = next;
    ledger = rebaseLedger(ledger, before, messages);
    onEvent({ kind: RunEventKind.Turn, text: `turn ${turn + 1}` });

    // Appended, the shortlist is already in `loaded` — after what was carried, and once — so the
    // first turn needs nothing of its own. Proxied, it is in the history.
    const routed = !proxied && preselectRouting !== PRESELECT_APPEND && preselected.length > 0 && turn === 0;
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
    // Unmarked, so the system prompt is the same text on every turn and a load does not throw
    // away the cache for the whole transcript. What is loaded is said in `declared` and in the
    // `load_tools` result instead. The preselected first turn is the one exception, by design,
    // and `preselectRouting: "append"` is the way out of it.
    const catalogue = proxied ? proxyCatalogPrompt(catalog) : catalogPrompt(catalog);
    const catalogued = onDemand && !routed;
    const sections = [instructions, catalogued ? catalogue : ''].filter((text) => text !== '');
    // `system` as it was given when nothing is added, so an app with neither sees no change.
    const isBare = catalogued === false && sections.length === 0;
    const prompt = isBare ? system : [system, ...sections].join('\n\n').trim();
    const request = singleSystem([
      ...(prompt ? [{ role: Role.System, content: prompt }] : []),
      ...withContext(messages, questionAt(), gathered.context, preface),
    ]);

    const build = (supported: Capabilities, refused: ModelCapabilities | undefined) =>
      buildBody(sending, supported, refused, request, declared, toolOrder);
    inFlight = {};
    const turnOptions = {
      model: config.model,
      inFlight,
      // `parallel_tool_calls` too, which `buildBody` adds for a model sent one call at a time.
      droppable: [...Object.keys(extraBody ?? {}), PARALLEL_TOOL_CALLS],
      ...(pin || remote ? { headers: { ...pin?.headers, ...remote?.turnHeaders() } } : {}),
      ...(remote ? { onChunk: remote.onChunk } : {}),
      maxRetries,
      loadingTimeoutMs: loadingMs(config),
      contextLimit: config.contextLength ?? 0,
      signal,
      idleMs: timeoutMs(config),
      firstChunkMs: firstTokenMs(config) ?? 0,
      onNotice: notice,
      mintCallId,
      onThinking: (text: string) => onEvent({ kind: RunEventKind.Thinking, text }),
      onOutput: (text: string) => onEvent({ kind: RunEventKind.Output, text }),
    };
    // Built the way `negotiate` is about to build the first attempt — the same flags, the same
    // model's refusals — so what the app is told is what is sent unless something is refused.
    if (onRequest) {
      const opening = build(supports, modelCapabilitiesFor(supports, config.model));
      onRequest({ messages: opening.messages, tools: opening.tools ?? [], turn });
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
    const reply =
      maxContinuations > 0
        ? await continueTurn(client, supports, build, first, {
            ...turnOptions,
            maxContinuations,
            replayReasoning: reasoningReplay !== ReasoningReplay.None,
          })
        : first;
    inFlight = {};
    previous = {
      messages: request,
      tools: names,
      prompt: firstPrompt,
      completion: reply.usage.completion,
    };
    usage = addCounts(usage, reply.usage);
    cacheReported ||= reportsCache(reply.usage);
    onEvent(usageEvent(loopUsage(usage, cacheReported), reply, ledger, config.contextLength));
    if (reply.finishReason === FinishReason.Length) {
      const ceiling = config.maxTokens === undefined ? '' : ` (${config.maxTokens})`;
      notice(`the model stopped at maxTokens${ceiling}; this turn is cut short`);
    } else if (reply.finishReason === FinishReason.ContentFilter) {
      notice("the provider's content filter withheld the reply");
    }
    const canRecover = recover && (tools.length > 0 || hostTools.length > 0 || onDemand);
    const read = turnCalls(reply, canRecover ? recoverable : undefined, notice, mintCallId);
    const { content, recovered } = read;
    // Once, before the message is stored: every later request replays these ids, and each tool
    // result answers one of them. A remote agent's are kept as sent, since it resumes by them,
    // whatever `callIds` says.
    const calls = remote ? read.calls : distinctCallIds(read.calls, messages, mintCallId, callIds);
    const shown: Turn = { ...reply, content, toolCalls: calls };
    onTurn?.(shown, turn);

    // Calls are run from their presence, never from the finish reason. A `tool_calls` finish with
    // none assembled is a reply that went wrong on the way — a parser that missed the model's
    // template, a stream cut between the reason and the calls — and not an answer, so with nothing
    // said either the same request is sent once more, unwritten, while a turn is left to send it.
    const isCallless = reply.finishReason === FinishReason.ToolCalls && calls.length === 0;
    const isSilent = content.trim() === '';
    if (isCallless) {
      const canAskAgain = isSilent && askedAgain === false && turn + 1 < config.maxToolIterations;
      if (canAskAgain) {
        notice('the model said it was calling tools but sent none; asking again');
        askedAgain = true;
        continue;
      }
      notice('the model said it was calling tools but sent none; taking its reply as the answer');
    } else if (isSilent && calls.length === 0 && reply.finishReason !== FinishReason.ContentFilter) {
      // Kept as the answer, written as `""`, so a stored transcript stays sendable: the app
      // is told.
      notice('the model ended its turn with no answer');
    }
    askedAgain = false;

    // Read before the assistant message is written, so what is replayed on every later request
    // is the repaired JSON.
    const parsed = readCalls(calls, reply.finishReason, recovered);
    const isAnswer = calls.length === 0;
    const replayed = replaysReasoning(reasoningReplay, !isAnswer)
      ? { reasoning: reply.reasoning, field: reply.reasoningField, details: reply.reasoningDetails }
      : undefined;
    // The handed-back calls go last, so the answers an app appends follow the results in
    // call order.
    const split = splitHandedBack(calling, parsed);
    const assistant = assistantMessage(content, [...split.run, ...split.back.map(({ entry }) => entry)], replayed);
    // Split as it is written rather than only as it is sent, so the result's `messages` and the
    // app's stored rows are a transcript the model can be sent, and every later request replays
    // the same messages byte for byte. Read per turn: the latch may have flipped on this request.
    const isSingle = singleCalls(config, modelCapabilitiesFor(supports, config.model));
    const pieces = replyMessages(assistant, split.back.length, isSingle);
    messages.push(pieces[0]);
    // Recovered calls were never calls on the wire: what the model said is the text they came from.
    await announce(pieces[0], turn, shown, { raw: writtenMessage(reply.content, recovered ? [] : calls, replayed) });
    // The rest are the loop's rewriting of that one reply, so they come without the reply, whose
    // whole message the first piece's `raw` already is.
    const opens =
      pieces.length > 1
        ? async (at: number) => {
            messages.push(pieces[at]);
            await announce(pieces[at], turn);
          }
        : undefined;

    const settled: TurnOutcome = isAnswer ? { pending: [] } : await runCalls(calling, split, messages, turn, opens);
    const { ended, pending } = settled;
    if (ended) {
      const by = ended.reason ? `: ${ended.reason}` : '';
      notice(`${ended.name} ended the run${by}`);
    }
    const isWaiting = pending.length > 0;
    if (isWaiting) {
      onEvent({ kind: RunEventKind.Wait, text: `waiting for the host to answer ${counted(pending.length, 'call')}` });
    }
    // Written while the model was answering, it is answered too, while a turn is left to do it in.
    const hasTurnLeft = turn + 1 < config.maxToolIterations;
    const late = isAnswer && hasTurnLeft ? await takeInput?.() : undefined;
    if (late) {
      await admit(late, turn + 1);
      continue;
    }
    if (isAnswer || ended || isWaiting) {
      // A waiting exchange's tool loop goes on when the app answers, so it keeps its scratchpads
      // and tells `afterTurn` nothing until then.
      const isOver = isWaiting === false;
      // The tool loop is over, so its scratchpads go; what came before the question is the app's.
      if (reasoningReplay === ReasoningReplay.ToolLoop && isOver) {
        messages = dropReasoning(messages, questionAt());
      }
      // Not awaited: the answer is ready, and remembering it is not something to hold it for.
      // Handed back instead, for an app that wants its notes.
      const afterTurn =
        hooks && fired?.afterTurn && isOver
          ? tellAfterTurn(hooks, messages, questionAt(), reply.content)
          : Promise.resolve([]);
      const metrics = runMetrics(recorded, { contextLength: config.contextLength });
      return {
        turn: shown,
        ...(ended ? { ended } : {}),
        ...(isWaiting ? { pending } : {}),
        ...runSoFar(),
        notes: gathered.notes,
        context: gathered.context,
        preface,
        afterTurn,
        metrics: {
          ...metrics,
          ...(onDemand ? loads : {}),
          wallMs: Date.now() - started,
          outcome: exchangeOutcome(reply, settled),
        },
      };
    }
  }

  return undefined;
}
