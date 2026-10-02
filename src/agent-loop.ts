import type OpenAI from "openai";
import { charsPerTokenFor } from "./calibration.ts";
import {
  type Capabilities,
  capabilitiesFor,
  ceilingAndTemperature,
  effortFor,
  type ModelCapabilities,
  modelCapabilitiesFor,
} from "./capabilities.ts";
import type { CatalogServer } from "./catalog.ts";
import { firstTokenMs, getClient, NO_KEY, timeoutMs } from "./client.ts";
import {
  type CompactionOptions,
  compactTranscript,
  planCompaction,
  summariser,
} from "./compaction.ts";
import {
  type Endpoint,
  type ModelParams,
  RESERVED_BODY_FIELDS,
  type RetryPolicy,
  type ToolPolicy,
} from "./config.ts";
import { continueTurn } from "./continuation.ts";
import {
  AgentLoopError,
  type AgentLoopFailure,
  AgentLoopOverflow,
  errorMessage,
  ToolIterationLimit,
} from "./errors.ts";
import { type RunEvent, type RunEventInput, type RunMetrics, runMetrics, stamp } from "./events.ts";
import type { HookEvent } from "./hook-events.ts";
import {
  configureHooks,
  type Gathered,
  gather,
  type HookContext,
  type HookNote,
  type HookRunner,
  notify,
  turnIndex,
  turnMessages,
  withContext,
} from "./hooks.ts";
import { type LedgerRequest, rebaseLedger, recordRequest, type TokenLedger } from "./ledger.ts";
import { ContextOverflow, contextTokens, toolsChars } from "./retry.ts";
import { runTurn } from "./run-turn.ts";
import { relaxTools, sanitizeTools } from "./schema-compat.ts";
import { askJson, type SideTask, type SideTaskOptions, tryAsk } from "./side-task.ts";
import { addCounts, noUsage, type Turn, type TurnUsage } from "./stream.ts";
import { parseToolArguments, recoverToolCalls, type ToolCall } from "./tool-calls.ts";
import {
  CALL_TOOL,
  catalogPrompt,
  expandNames,
  inCatalog,
  type KeywordPreselectOptions,
  LOAD_TOOLS,
  LOAD_TOOLS_DEFINITION,
  loadedTools,
  loadResult,
  MAX_PER_LOAD,
  orderTools,
  PRESELECT_SCHEMA,
  PROXY_TOOLS,
  preselectByKeywords,
  preselectInput,
  preselection,
  preselectSystem,
  proxiedCall,
  proxyCatalogPrompt,
  proxyLoadResult,
  requestedNames,
  shownCall,
  type ToolOrder,
  toolName,
} from "./tool-loading.ts";

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
 * The one place a streamed request's body is decided from a config and what the endpoint and
 * the model have refused.
 *
 * Every field that negotiates lives here: the ceiling's two spellings, a temperature only a
 * model that takes ours is sent, a reasoning effort only one that takes it is, `stream_options`
 * only where the server has heard of it, relaxed schemas only where it could not build a grammar,
 * and `extraBody` last, less whatever the model refused by name. The ceiling is tested
 * `=== false` — `modelCapabilitiesFor` starts a model at `legacyTokenLimit: true` and an absent
 * one has to read the same — which is the test one of the three copies had inverted.
 *
 * @param config What to ask for. `maxTokens` of zero or less sends no ceiling; `reasoningEffort`
 * absent or `"off"` sends no effort, and one the model has refused by value is stepped up to the
 * cheapest it takes by `effortFor`.
 * @param supports What the endpoint has refused, as `negotiate` hands it to `send`.
 * @param refused What the model has refused, as `negotiate` hands it over. Absent is a model
 * that has refused nothing.
 * @param messages The request's messages, system prompt included, sent as they are.
 * @param tools The tool definitions. Ordered by name, sanitised here — a lookup for a definition
 * seen before — and relaxed where the endpoint needs it. Empty sends no `tools` field at all.
 * @param order How to order them before sending. `true`, the default, is by name, which keeps the
 * cache when the caller's array is assembled differently from one request to the next. See
 * `orderTools`.
 */
export function buildBody(
  config: ModelParams,
  supports: Capabilities,
  refused: ModelCapabilities | undefined,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionTool[] = [],
  order: ToolOrder = true,
): OpenAI.ChatCompletionCreateParamsStreaming {
  const sorted = orderTools(tools, order);
  const declared = supports.strictSchemas
    ? sanitizeTools(sorted)
    : relaxTools(sanitizeTools(sorted));
  const effort = effortFor(refused, config.reasoningEffort);
  const extra = Object.entries(config.extraBody ?? {}).filter(
    ([field]) => !RESERVED_BODY_FIELDS.includes(field) && !refused?.refusedFields.has(field),
  );
  return {
    ...ceilingAndTemperature(refused, config.maxTokens, config.temperature),
    ...(effort ? { reasoning_effort: effort as OpenAI.ReasoningEffort } : {}),
    ...(supports.usageInStream ? { stream_options: { include_usage: true } } : {}),
    ...Object.fromEntries(extra),
    model: config.model,
    messages,
    stream: true,
    ...(declared.length ? { tools: declared } : {}),
  };
}

/**
 * A long tool argument or result cut to what a watcher needs, with the full length said.
 *
 * For events, never for the transcript: the model reads the whole of what a tool returned.
 *
 * @param text What to show.
 * @param limit Characters kept, 2000 by default. Text at or under it comes back as it was.
 */
export const preview = (text: string, limit = 2000) =>
  text.length > limit ? `${text.slice(0, limit)}… (${text.length} chars)` : text;

/** A count and its noun, plural unless the count is one: `1 tool`, `3 tools`. */
const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** A base URL as two settings rows would agree on it: trimmed, without the trailing slash. */
const sameUrl = (a: string, b: string) =>
  a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");

/**
 * The key to send, where an endpoint may inherit one from the settings it overrides.
 *
 * A credential issued for one endpoint has no business being posted to another. A profile that
 * names its own `baseUrl` and no key of its own is sent `NO_KEY` — not the operator's key, and
 * not `$OPENAI_API_KEY` — because "I pointed an agent at a friend's server and it sent my OpenAI
 * key" is not a mistake worth being able to make, and a local server wants no key anyway. One on
 * the same endpoint inherits the key as it inherits everything else, and the environment is the
 * last word on the endpoint that was configured rather than overridden.
 *
 * @param own The endpoint as the agent or profile states it. Its own key always wins. An empty or
 * absent `baseUrl` is one that inherits the endpoint too.
 * @param inherited The settings it overrides. Absent treats `own` as the configured endpoint, so
 * only its key and the environment's are in play.
 * @param env Where `OPENAI_API_KEY` is read from, `process.env` by default.
 */
export function resolveApiKey(
  own: { baseUrl?: string; apiKey?: string },
  inherited?: { baseUrl: string; apiKey?: string },
  env: Record<string, string | undefined> = process.env,
): string {
  if (own.apiKey) return own.apiKey;
  const baseUrl = own.baseUrl?.trim();
  if (inherited && baseUrl && !sameUrl(baseUrl, inherited.baseUrl)) return NO_KEY;
  return inherited?.apiKey || env.OPENAI_API_KEY || NO_KEY;
}

/**
 * A side task's settings as the call that honours them: its endpoint, its model, and the options
 * `ask`, `askJson`, `summariser` and `preselect` take last.
 *
 * A helper rather than a second signature on each of the four, so a setting added to a task later
 * arrives through `options` without a host's call changing. What the task states wins over the
 * same field in `options`: the host's code is written once and the task is what an operator
 * configured over it, so a host passes its own ceiling as the value for a task that names none.
 * A setting the task leaves out and `options` does too is absent from the result, which is what
 * leaves it to the entry point's own default — 0.3, not the agent's temperature.
 *
 * A resolved spec carries no key, so a task on the agent's own endpoint would otherwise go out
 * unkeyed, and be remembered under a second capability entry beside the agent's. Given `agent`,
 * such a task is sent the agent's `baseUrl` as the agent spells it and, having no key of its own,
 * the agent's key, so `capabilitiesFor` answers both with one object; a task on another endpoint
 * is sent only a key of its own, as `resolveApiKey` has it. The environment is not read: the
 * agent's key is whatever the main turn is sent.
 *
 * @param task The task, ordinarily `resolved.tasks.<key>`.
 * @param options What the host adds — cancellation, notices, `keywords` — and its own defaults
 * for the settings a task may leave out.
 * @param agent The endpoint the main turn uses, key included. Absent sends the task's endpoint
 * as it stands.
 */
export function taskCall<Options extends SideTaskOptions = SideTaskOptions>(
  task: SideTask,
  options?: Options,
  agent?: { baseUrl: string; apiKey?: string },
): { endpoint: Endpoint; model: string; options: Options } {
  const own = task.endpoint;
  const shared = agent && (!own.baseUrl.trim() || sameUrl(own.baseUrl, agent.baseUrl));
  const stated: SideTaskOptions = {};
  if (task.maxTokens !== undefined) stated.maxTokens = task.maxTokens;
  if (task.temperature !== undefined) stated.temperature = task.temperature;
  if (task.reasoningEffort !== undefined) stated.reasoningEffort = task.reasoningEffort;
  return {
    endpoint: agent
      ? {
          ...own,
          ...(shared ? { baseUrl: agent.baseUrl } : {}),
          apiKey: resolveApiKey(own, agent, {}),
        }
      : own,
    model: task.model,
    options: { ...options, ...stated } as Options,
  };
}

/**
 * The tools a request is likely to need, picked by a small model before the run starts, or none.
 *
 * On-demand loading otherwise spends a round trip on reading the catalogue and calling
 * `load_tools`; a small model reading the same catalogue usually names the right tools, and the
 * task model opens with them in hand. A wrong guess costs a few hundred tokens for one run, and
 * a failed one costs nothing — it is reported through `onNotice` and answered with an empty list,
 * since a side task is never worth failing the run. A stop still throws.
 *
 * With `keywords`, the request's own words are matched against the catalogue first and the model
 * is spent only on what they cannot settle, which on a local box is the difference between a run
 * starting now and starting in a few seconds. The words have to be clear about it; see
 * `preselectByKeywords` for what that means.
 *
 * @param config The endpoint the preselector is reached through.
 * @param model The preselector. An empty name picks nothing, which is what `toolSelectModel`
 * means by empty.
 * @param catalog The servers to choose from.
 * @param prompt The request being planned for. Only its head is read; see `preselectInput`.
 * @param options Cancellation, notices, the reply ceiling (256), the temperature and reasoning
 * effort as `ask` reads them (0.3 and none when absent), the cap the choice is held to
 * (`MAX_PER_LOAD`), and whether to try the words first.
 */
export async function preselect(
  config: Endpoint,
  model: string,
  catalog: CatalogServer[],
  prompt: string,
  {
    signal,
    onNotice,
    maxTokens = 256,
    temperature,
    reasoningEffort,
    maxPerLoad = MAX_PER_LOAD,
    keywords,
  }: {
    signal?: AbortSignal;
    onNotice?: (message: string) => void;
    maxTokens?: number;
    /** As `SideTaskOptions.temperature`: absent is 0.3. */
    temperature?: number;
    /** As `SideTaskOptions.reasoningEffort`: absent keeps the no-thinking hints. */
    reasoningEffort?: string;
    maxPerLoad?: number;
    /**
     * Try `preselectByKeywords` first and spend the model only on what it cannot settle. `true`
     * takes its defaults; an object tunes the thresholds. An empty `model` still means no
     * preselection at all, words included — that is what `toolSelectModel: ""` asks for.
     */
    keywords?: boolean | KeywordPreselectOptions;
  } = {},
): Promise<string[]> {
  if (!model || !catalog.some((server) => server.tools.length > 0)) return [];
  if (keywords) {
    const guess = preselectByKeywords(catalog, prompt, {
      maxPerLoad,
      ...(keywords === true ? {} : keywords),
    });
    if (guess.confident) {
      onNotice?.(`chose ${counted(guess.names.length, "tool")} by name`);
      return guess.names;
    }
  }
  const reply = await tryAsk(
    "preselect",
    () =>
      askJson<unknown>(
        config,
        model,
        preselectSystem(maxPerLoad),
        preselectInput(catalog, prompt),
        PRESELECT_SCHEMA,
        { name: "preselection", maxTokens, temperature, reasoningEffort, signal, onNotice },
      ),
    { onNotice },
  );
  return preselection(reply, catalog, maxPerLoad);
}

/**
 * One call the model made, as `dispatch` and `onToolCall` are handed it.
 *
 * A `call_tool` arrives as the tool it names — that tool's name and arguments, under the
 * `call_tool`'s id — so a dispatcher is the same in every discovery mode.
 */
export interface ToolCallRequest {
  id: string;
  name: string;
  /**
   * Parsed by `parseToolArguments`, repairs and all. Empty for a call whose arguments could not be
   * read, which only `onToolCall` is ever handed.
   */
  args: Record<string, unknown>;
  /**
   * The arguments as the model wrote them, before any repair. Through `call_tool`, the inner
   * arguments as JSON text.
   */
  raw: string;
}

/** What one tool call did, in the order the model asked. */
export interface ToolCallOutcome {
  /**
   * The id the model's reply gave the call, which is what tells two calls to one tool apart.
   * Distinct within a step — `streamTurn` mints one where the server sent none or repeated one —
   * but nothing stops a server using the same id again in a later step. `runAgentLoop` always
   * sets it; optional so an outcome built before it existed still compiles.
   */
  id?: string;
  /** The tool that was called. For a `call_tool`, the tool it named. */
  name: string;
  /** False when the arguments did not parse, the tool threw, or `load_tools` loaded nothing. */
  ok: boolean;
}

/**
 * One step's request as `onRequest` is handed it: what the model is about to read.
 *
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
 * One call's whole answer, as `onToolResult` is handed it.
 *
 * The `tool-result` event carries the same answer cut by `preview`, which is right for a readout
 * and wrong for a host that renders or stores the result: this is the text the model reads.
 */
export interface ToolCallResult extends ToolCallOutcome {
  id: string;
  /**
   * What went into the transcript for this call, uncut: what the tool returned, what it threw, the
   * `load_tools` answer, or why the arguments could not be read.
   */
  content: string;
}

/**
 * The hooks a loop runs around one question. See `hooks.ts`.
 *
 * The loop gathers before its first request and nothing else can run beside that, so a host with
 * pre-turn work of its own to overlap with the hooks — compaction, a preselection — calls `gather`
 * itself, puts the context on with `withContext`, calls `notify` after, and passes no `hooks`.
 */
export interface AgentLoopHooks {
  run: HookRunner;
  /** What the hooks are told. `reply` and `turn` are filled in for `afterTurn`. */
  context: HookContext;
  /** Run before the first request, `["beforeTurn"]` by default. */
  events?: readonly HookEvent[];
  /** The shared context budget. Absent is `configureHooks`'s. */
  maxTokens?: number;
  /** Said above the context blocks. Absent is `configureHooks`'s; empty is none. */
  preface?: string;
  /** Hears each note, from before the request and from `afterTurn`. */
  onNote?: (note: HookNote) => void;
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

/** What `runAgentLoop` takes. */
export interface AgentLoopOptions {
  /**
   * The endpoint, what to ask the model for, and how long it may keep calling tools.
   * `toolDiscovery` absent is eager, `maxRetries` absent is none, and `contextLength` is handed
   * to `runTurn` as `contextLimit`, which sizes each request against the window before sending.
   * `"proxy"` is on-demand loading behind a tool array that never changes; see `PROXY_TOOLS`.
   *
   * `tasks` is a resolved agent's, and is read only for the side tasks the loop was asked to run:
   * `tasks.toolSelect` under `preselect` and `tasks.compaction` under `compact`. `toolSelectModel`
   * is the flattened spelling of the first, for a host that is not on the spec.
   */
  config: Endpoint &
    ModelParams &
    Pick<ToolPolicy, "maxToolIterations"> &
    Partial<Pick<ToolPolicy, "toolDiscovery" | "toolSelectModel">> &
    Partial<RetryPolicy> & {
      contextLength?: number;
      tasks?: Readonly<Record<string, SideTask>>;
    };
  /**
   * The standing instruction, sent as the first message. On-demand and proxied modes append the
   * catalogue, each in its own wording.
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
   * The same tools as a name-only catalogue. On-demand and proxied modes need it, and are eager
   * without it.
   */
  catalog?: CatalogServer[];
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
   * Proxied, the tool array is fixed and there is no such step. The shortlist is written into the
   * transcript instead, after the question, as a `load_tools` call the model did not make and the
   * result that call would have had — an assistant message and a tool message, handed back in
   * `messages` like any other, reported as a `tool-call` and a `tool-result` event and told to
   * `onToolCall` and `onToolResult`. Names with no definition in `tools`, or outside the
   * catalogue, are left out, and none left is no exchange.
   */
  preselected?: readonly string[];
  /**
   * What a preselection does to the first step. `"exclusive"`, the default, is the shortlist alone
   * as `preselected` describes — and a system prompt and tool array unlike the last request's and
   * unlike the next step's, so a prompt cache misses the whole transcript on the first step and
   * again on the second. `"append"` loads the shortlist as a `load_tools` call would have and
   * sends the first step like any other: the catalogue, `load_tools`, what `loaded` carried, then
   * the shortlist after it, with a name already carried left where it is. The price is the menu
   * back in front of the model. Which costs more has not been measured, which is why the default
   * has not moved.
   *
   * Appended is before `toolOrder` has its say: sorted, a preselected tool lands at its name's
   * place and moves every definition after it, so only `toolOrder: false` keeps a carried array
   * a strict prefix. Either way the first step's system prompt is the second's, and so is its
   * tool array until something else is loaded. Nothing to do without a preselection, in eager
   * mode, or proxied, where no step is routed either way.
   */
  preselectRouting?: "exclusive" | "append";
  /**
   * Has the loop make the preselection itself, before its first request, with the preselector
   * the config names. Off by default: a host that passes a resolved agent and calls `preselect`
   * on its own is not sent a second one.
   *
   * The preselector is `config.tasks.toolSelect` with everything it states — its endpoint, model,
   * ceiling, temperature and reasoning effort, keyed as `taskCall` keys a task against `config` —
   * and otherwise `config.toolSelectModel` on the config's own endpoint at `preselect`'s defaults.
   * What it is asked about is the text of the last user message. Nothing is asked in eager mode,
   * with neither preselector named, with no user message, or when `preselected` is given — an
   * empty one included, which is how a host says it has already decided.
   *
   * `true` takes `preselect`'s defaults; an object passes `keywords` and `maxPerLoad` through.
   * Its notices arrive as `notice` events, and a preselection that fails picks nothing rather
   * than ending the run. It runs before the hooks gather, not beside them.
   */
  preselect?: boolean | { keywords?: boolean | KeywordPreselectOptions; maxPerLoad?: number };
  /**
   * Has the loop fold the transcript itself before a step, once `planCompaction` says the window
   * is filling, with the summary written by `config.tasks.compaction` on its own settings. Off by
   * default, and nothing is folded without that task — there is no falling back to the main model
   * — or without a `config.contextLength` to plan against.
   *
   * It runs after `beforeStep`, on what that returned, and is `compactTranscript` and nothing
   * more: the plan is made from the last request's reported prompt, or an estimate before the
   * first step and after a `beforeStep` rewrite; `hooks`, when given, are told `beforeCompact`
   * beside the summary; and a fold is said as a `notice` event. A summary that fails is a notice
   * too and folds nothing. Tool results are not pruned — `beforeStep` is where a host does that.
   *
   * The result's `messages` then open with the summary in place of what was folded, so a host
   * that keeps its transcript append-only wants `runCompaction` and a stored fold instead. `true`
   * plans by `planCompaction`'s defaults; an object moves its thresholds.
   */
  compact?: boolean | Pick<CompactionOptions, "compactAt" | "keepRatio" | "target">;
  /**
   * Tools already loaded, carried from an earlier question. See `carryOver`. Not read in proxied
   * mode, where a tool is loaded only while its definition is in the history.
   */
  loaded?: Iterable<string>;
  /** Runs one tool call and returns what the model reads. What it throws, the model reads too. */
  dispatch: (call: ToolCallRequest, signal?: AbortSignal) => Promise<string>;
  /**
   * Runs a step's calls together rather than one after another. Results still go into the
   * transcript in the order the model asked. See `dedupeToolCalls`, which applies either way.
   */
  parallel?: boolean;
  /**
   * Answers an identical repeat of a call — the same name and the same arguments, word for word —
   * within one step from the first one, rather than dispatching it again.
   *
   * On by default, and on whether or not the calls run in `parallel`: a model that asks the same
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
   * Told of every call the model made, as it starts — the ones `dispatch` never sees included:
   * `load_tools`, an identical repeat answered from the first, and a call whose arguments could
   * not be read, which arrives with empty `args` and the model's own text in `raw`.
   *
   * For a host that shows each call as it is made and fills it in when its result lands, which
   * `dispatch` alone cannot do for those three. Not awaited: a promise it returns is dropped.
   */
  onToolCall?: (call: ToolCallRequest) => void;
  /**
   * Told of every call's answer as it lands, whole, under the id `onToolCall` announced it by.
   *
   * One per call the model made: a deduplicated repeat gets its own, carrying the answer it
   * shares with the first. With `parallel` they arrive as the calls finish, which need not be
   * the order they were made in; the transcript and the result's `toolCalls` keep that order.
   * Not awaited: a promise it returns is dropped.
   */
  onToolResult?: (result: ToolCallResult) => void;
  /**
   * Hooks gathered onto the question before the first request, and told the reply after.
   *
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
  ) =>
    | OpenAI.ChatCompletionMessageParam[]
    | undefined
    | Promise<OpenAI.ChatCompletionMessageParam[] | undefined>;
  /**
   * The ledger an earlier run handed back for this transcript, to be continued. Its indexes have
   * to be into `messages` as given here — see `rebaseLedger` for a transcript rewritten since.
   * This run's requests start a new epoch, because the loop cannot see whether the request before
   * its first one had the same system prompt and tools. Absent starts an empty one.
   */
  ledger?: TokenLedger;
  /** Stops the run: the request in flight, and between steps and calls. */
  signal?: AbortSignal;
  /** Told what the run is doing, as the events a watcher reads. */
  onEvent?: (event: RunEventInput) => void;
  /**
   * Takes tool calls a model wrote into its reply as text and runs them as calls, with a notice
   * saying so. On by default: a server whose tool-call parser does not match the model's template
   * otherwise ends the run on a reply that is only a call nobody made. Off leaves such a reply as
   * the answer. See `recoverToolCalls`.
   */
  recoverToolCalls?: boolean;
  /**
   * Each step's request as first built, before it goes out — for measuring what was sent, not for
   * changing it, which is `beforeStep`'s.
   *
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
   * The assistant message is the one replayed on later requests — arguments repaired, recovered
   * calls folded in — and comes with its `turn`, as `onTurn` was handed it, for the `reasoning` a
   * host keeps beside the message. A tool result comes without one, and so do the two messages
   * a proxied run writes for its `preselected` shortlist, told as step zero's before any request.
   * What it returns is ignored: `beforeStep` is the one way to rewrite the transcript. What it
   * throws ends the run, and it is not called again for that run.
   */
  onMessage?: (
    message: OpenAI.ChatCompletionMessageParam,
    step: number,
    turn?: Turn,
  ) => void | Promise<void>;
  /**
   * How many times an answer cut off at `maxTokens` is continued, zero — the default — for never.
   * Opt-in because it spends another request, and on a server that does not continue a trailing
   * assistant message it spends one to find that out. See `continueTurn`.
   */
  maxContinuations?: number;
}

/** What a finished loop hands back. */
export interface AgentLoopResult {
  /** The last turn: the one that asked for no tools, as `onTurn` was handed it. */
  turn: Turn;
  /** The transcript, with every assistant turn and tool result the run added. No system prompt. */
  messages: OpenAI.ChatCompletionMessageParam[];
  /** Summed over every turn of the run. */
  usage: TurnUsage;
  /**
   * Every call, `load_tools` included, in the order they were made, each under its call id — a
   * proxied preselection's among them, first.
   */
  toolCalls: ToolCallOutcome[];
  /**
   * What is loaded at the end, for `carryOver`. Empty in eager mode, and in proxied mode: a
   * definition loaded there is already in the history, and one a compaction folded away has to be
   * loadable again rather than answered "already loaded".
   */
  loaded: string[];
  /** The tools the model actually called, `load_tools` excluded and `call_tool` looked through. */
  used: string[];
  /** The hooks' notes from before the first request. */
  notes: HookNote[];
  /**
   * The `<context>` blocks the hooks added to this question, as `withContext` takes them. Empty
   * when no hook added any, and without `hooks`. Not in `messages`, so a host that wants the next
   * turn's request to begin with this one's stores it beside the question; see `hooks`.
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
   * reaches `onNote` as well. Already resolved and empty without `hooks`, and rejects only if
   * `onNote` throws.
   */
  afterTurn: Promise<HookNote[]>;
  /**
   * The run summed and derived: what `runMetrics` makes of the events this loop emitted, plus the
   * `load_tools` findings only the loop sees, `wallMs` from the call to the return, and `outcome`.
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
interface Sent {
  messages: OpenAI.ChatCompletionMessageParam[];
  tools: string[];
  /** The prompt the first request of the turn reported, before any continuation was joined. */
  prompt: number;
  /** The completion across the whole turn, continuations included. */
  completion: number;
}

/** Whether two messages say the same thing, by identity first since most of a transcript is. */
const sameMessage = (a: OpenAI.ChatCompletionMessageParam, b: OpenAI.ChatCompletionMessageParam) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** The system messages a request opens with, which a template renders ahead of the history. */
const leadingSystem = (messages: OpenAI.ChatCompletionMessageParam[]) => {
  const end = messages.findIndex((message) => message.role !== "system");
  return messages.slice(0, end === -1 ? messages.length : end);
};

/**
 * Where a request stopped matching the one before it, earliest in the rendered prompt first — the
 * tool block, then the system prompt, then the history — or `none-known` where it only appended.
 */
function breakReason(
  previous: Sent,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: string[],
): NonNullable<TurnUsage["cacheBreakReason"]> {
  if (
    previous.tools.length !== tools.length ||
    previous.tools.some((name, at) => name !== tools[at])
  )
    return "tools-changed";
  const before = leadingSystem(previous.messages);
  const now = leadingSystem(messages);
  if (before.length !== now.length || before.some((message, at) => !sameMessage(message, now[at])))
    return "system-changed";
  if (
    previous.messages.length > messages.length ||
    previous.messages.some((message, at) => !sameMessage(message, messages[at]))
  )
    return "history-rewritten";
  return "none-known";
}

/**
 * The share of the previous prompt a cache that kept its prefix reports as hit. Short of it by
 * more than this is a break, not the few tokens a template re-renders at the join.
 */
const CACHE_KEPT = 0.9;

/**
 * What one turn's cache should have been and whether it was, against the request before it.
 * Nothing before the second request, or where the previous prompt was not reported.
 */
function cacheDiagnosis(
  previous: Sent | undefined,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: string[],
  usage: TurnUsage,
): Partial<TurnUsage> {
  if (!previous || !(previous.prompt > 0)) return {};
  const found: Partial<TurnUsage> = { cacheExpected: previous.prompt + previous.completion };
  if (usage.uncached === undefined) return found;
  found.cacheBroken = usage.cached < previous.prompt * CACHE_KEPT;
  if (found.cacheBroken) found.cacheBreakReason = breakReason(previous, messages, tools);
  return found;
}

/** What a tool call the run was stopped during is answered with, in place of a result. */
const STOPPED_CALL = "Stopped before this call finished.";

/** The same for a call of that step the loop never got to. */
const UNRUN_CALL = "Not run: the run stopped first.";

/** How `runAgentLoop` reads the run as it stands, from outside the steps that are building it. */
interface Standing {
  read: () => AgentLoopFailure;
}

/**
 * Runs a question to its answer: one `runTurn` per step, the tools it asks for between them,
 * until a turn asks for none. Throws when `maxToolIterations` is spent, when stopped, and on
 * whatever `runTurn` throws — `ContextOverflow` among them, however it was found out.
 *
 * What it throws carries the run as it stood — `messages`, `usage`, `toolCalls`, `loaded` and
 * `used` — because the steps before a failure were real and a host that stores its transcript
 * has nothing else to store them from. A spent budget is a `ToolIterationLimit`, an overflow is
 * an `AgentLoopOverflow`, which is still a `ContextOverflow`, and anything else is an
 * `AgentLoopError` with what was caught as its `cause` and its message as its own; `failedRun`
 * reads the run off any of the three. A failure while a step's tools run leaves the transcript
 * well-formed: the results that came back are kept, and each call without one is answered with a
 * line saying it was stopped or never run, since a call with no result is refused on replay.
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
 *
 * Neither side task is run unless asked for. `preselect` has the loop make the preselection and
 * `compact` has it fold the transcript, each by the task `config.tasks` carries for it and on
 * that task's own settings — a setting the task leaves out is the side task's default, never the
 * run's `temperature` or `maxTokens`.
 *
 * @param options The config, transcript, tools and dispatcher, plus the optional hooks, events
 * and cancellation. See `AgentLoopOptions`.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  // Until the steps have set themselves up there is only what the caller handed over.
  const standing: Standing = {
    read: () => ({
      messages: [...options.messages],
      usage: noUsage(),
      toolCalls: [],
      loaded: [],
      used: [],
    }),
  };
  let result: AgentLoopResult | undefined;
  try {
    result = await runSteps(options, standing);
  } catch (error) {
    // Wrapped rather than annotated: an abort's reason is one object shared by every run under
    // the signal, so the run cannot be hung on the error itself. An overflow keeps its class,
    // because `instanceof ContextOverflow` is how a caller knows to compact and try again.
    throw error instanceof ContextOverflow
      ? new AgentLoopOverflow(error.message, standing.read(), { cause: error })
      : new AgentLoopError(errorMessage(error), standing.read(), { cause: error });
  }
  if (result) return result;
  throw new ToolIterationLimit(
    `Stopped after ${options.config.maxToolIterations} tool iterations.`,
    standing.read(),
  );
}

/** A message's words, as the preselector is asked about them: its string, or its text parts. */
const userText = (message: OpenAI.ChatCompletionMessageParam | undefined): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => (part.type === "text" ? part.text : [])).join("\n");
};

/**
 * The loop's own preselection: by the task where the config carries one, and by the flattened
 * name on its own endpoint where it does not. `preselect` answers an empty model with nothing, so
 * a config that names neither asks nothing.
 */
async function chooseTools(
  options: AgentLoopOptions,
  notice: (text: string) => void,
): Promise<string[]> {
  const { config, catalog = [], signal } = options;
  const prompt = userText(options.messages.findLast((message) => message.role === "user"));
  if (!prompt.trim()) return [];
  const asked = {
    ...(typeof options.preselect === "object" ? options.preselect : {}),
    signal,
    onNotice: notice,
  };
  const selector = config.tasks?.toolSelect;
  if (!selector?.model) {
    return preselect(config, config.toolSelectModel ?? "", catalog, prompt, asked);
  }
  const call = taskCall(selector, asked, config);
  return preselect(call.endpoint, call.model, catalog, prompt, call.options);
}

/**
 * The loop's own summariser, which is the compaction task's or nothing: a summary the main model
 * writes is a second full-price request the operator did not ask for.
 */
function ownSummariser(options: AgentLoopOptions, notice: (text: string) => void) {
  const { config, signal } = options;
  const compactor = options.compact ? config.tasks?.compaction : undefined;
  if (!compactor?.model) return undefined;
  const call = taskCall(compactor, { signal, onNotice: notice }, config);
  const write = summariser(call.endpoint, call.model, call.options);
  // A summary that fails folds nothing, and the step goes out as it was.
  return async (text: string) =>
    (await tryAsk("compaction", () => write(text), { onNotice: notice })) ?? "";
}

/**
 * A step's transcript after the loop's own compaction: folded where a fold was due and its summary
 * came back, and otherwise the array it was given.
 */
async function foldBeforeStep(
  transcript: OpenAI.ChatCompletionMessageParam[],
  reported: { used?: number },
  summarise: (text: string) => Promise<string>,
  {
    options,
    charsPerToken,
    notice,
  }: { options: AgentLoopOptions; charsPerToken: number; notice: (text: string) => void },
): Promise<OpenAI.ChatCompletionMessageParam[]> {
  const { config, hooks } = options;
  const compactor = config.tasks?.compaction;
  const plan = planCompaction(transcript, {
    ...(typeof options.compact === "object" ? options.compact : {}),
    limit: config.contextLength ?? 0,
    ...reported,
    charsPerToken,
    ...((compactor?.maxTokens ?? 0) > 0 ? { summaryTokens: compactor?.maxTokens } : {}),
  });
  if (!plan) return transcript;
  const folded = await compactTranscript(transcript, plan, summarise, {
    ...(hooks ? { hooks: { run: hooks.run, context: hooks.context, onNote: hooks.onNote } } : {}),
  });
  if (folded !== transcript) notice(`compacted ${plan.cut - plan.from} messages into a summary`);
  return folded;
}

/** One of a turn's calls with its arguments read, or with the reason they could not be. */
interface ReadCall {
  call: ToolCall;
  /** Absent where the arguments could not be read. */
  args?: Record<string, unknown>;
  /** Why they could not, which is then the call's answer. */
  error?: unknown;
  /** The arguments as every later request replays them: the repaired JSON, or `{}` for none. */
  normal: string;
}

/**
 * A turn's calls with their arguments read. A server that parses replayed arguments refuses the
 * almost-JSON a model wrote, so each is normalised here, and one that could not be read at all is
 * replayed as no arguments.
 */
const readCalls = (calls: ToolCall[], finishReason: Turn["finishReason"]): ReadCall[] =>
  calls.map((call) => {
    try {
      const args = parseToolArguments(call.function.arguments, { finishReason });
      return { call, args, normal: JSON.stringify(args) };
    } catch (error) {
      return { call, error, normal: "{}" };
    }
  });

/** The assistant message a turn is written into the transcript as, its calls' arguments repaired. */
const assistantMessage = (
  content: string,
  parsed: ReadCall[],
): OpenAI.ChatCompletionAssistantMessageParam => ({
  role: "assistant",
  content: content || null,
  ...(parsed.length
    ? {
        tool_calls: parsed.map(({ call, normal }) => ({
          ...call,
          function: { ...call.function, arguments: normal },
        })),
      }
    : {}),
});

/**
 * Tells the `afterTurn` hooks what was answered, with the turn it closed where the question is
 * still in the transcript. Resolves to their notes — failures only, as `notify` returns them.
 */
const tellAfterTurn = (
  hooks: NonNullable<AgentLoopOptions["hooks"]>,
  messages: OpenAI.ChatCompletionMessageParam[],
  at: number,
  reply: string,
): Promise<HookNote[]> =>
  notify(
    hooks.run,
    "afterTurn",
    {
      ...hooks.context,
      reply,
      ...(at >= 0
        ? {
            turn: {
              index: turnIndex(messages, at),
              messages: turnMessages(hooks.context.session.id, messages, at),
            },
          }
        : {}),
    },
    hooks.onNote,
  );

/** The definitions the host gave for these names, in the order the names are given. */
const definedAs = (
  definitions: ReadonlyMap<string, OpenAI.ChatCompletionTool>,
  names: Iterable<string>,
) => [...names].flatMap((name) => definitions.get(name) ?? []);

/**
 * What running a step's calls reads of the run and writes back into it. One per run, shared by
 * every step: the sets and counts here are the run's own, not copies.
 */
interface Calling {
  catalog: CatalogServer[];
  /** Whether tools are loaded from the catalogue, behind a moving tool array or a fixed one. */
  onDemand: boolean;
  /** Whether the tool array is the fixed one, so a definition lives in the history. */
  proxied: boolean;
  /** Whether a `call_tool` is looked through, which it is unless the host has a tool by that name. */
  proxies: boolean;
  definitions: ReadonlyMap<string, OpenAI.ChatCompletionTool>;
  loaded: Set<string>;
  loads: { toolsLoaded: number; redundantLoads: number; unknownToolNames: number };
  used: Set<string>;
  toolCalls: ToolCallOutcome[];
  dedupable: (call: ToolCallRequest) => boolean;
  dispatch: AgentLoopOptions["dispatch"];
  parallel: boolean;
  signal: AbortSignal | undefined;
  onEvent: (input: RunEventInput) => void;
  onToolCall: AgentLoopOptions["onToolCall"];
  onToolResult: AgentLoopOptions["onToolResult"];
  /** Offers a message just written into the transcript to the host. */
  announce: (message: OpenAI.ChatCompletionMessageParam, step: number) => Promise<void>;
}

/**
 * What a call is shown, counted and dispatched as: a `call_tool` as the tool it names. Read from
 * the repaired arguments where there are any, since the model's own may be almost-JSON.
 */
const shownAs = (run: Calling, { call, args, normal }: ReadCall) =>
  run.proxies && call.function.name === CALL_TOOL
    ? shownCall(CALL_TOOL, args ? normal : call.function.arguments)
    : { name: call.function.name, input: call.function.arguments };

/** Answers a `load_tools`, counting what it loaded. Not ok where it named nothing loadable. */
function answerLoad(run: Calling, args: Record<string, unknown>) {
  const { catalog, proxied, definitions, loaded, loads } = run;
  const resolved = expandNames(requestedNames(args), catalog);
  const content = proxied
    ? proxyLoadResult(resolved, catalog, definedAs(definitions, resolved.matched), loaded)
    : loadResult(resolved, catalog, loaded);
  // Proxied, a load is only of what the result could define: a catalogued name the host
  // gave no definition for was not loaded, and is not counted or remembered as though it was.
  const hits = proxied ? resolved.matched.filter((hit) => definitions.has(hit)) : resolved.matched;
  for (const hit of hits) loads[loaded.has(hit) ? "redundantLoads" : "toolsLoaded"]++;
  loads.unknownToolNames += resolved.unknown.length;
  for (const hit of hits) loaded.add(hit);
  return { content, ok: hits.length > 0 };
}

/**
 * Runs one call to its result, telling the host of both. A tool that throws is that call's answer
 * rather than the run's end, unless the run was stopped.
 *
 * @param run The run the call belongs to.
 * @param entry The call, with its arguments read.
 * @param answered The step's calls already made, by tool and arguments, for `dedupeToolCalls`.
 */
async function runCall(run: Calling, entry: ReadCall, answered: Map<string, Promise<string>>) {
  const { catalog, onDemand, proxied, signal } = run;
  const { call, args, error: unreadable, normal } = entry;
  const proxy = run.proxies && call.function.name === CALL_TOOL;
  const { name, input: raw } = shownAs(run, entry);
  // Looked through before the call is announced, so a host is told of the tool it names with
  // that tool's arguments. A name outside the catalogue is refused here, so `call_tool` reaches
  // nothing a load could not, and the refusal is the call's answer below.
  let inner = args ?? {};
  let refused: { error: unknown } | undefined;
  if (proxy && args) {
    try {
      inner = proxiedCall(args, catalog).input;
    } catch (error) {
      inner = {};
      refused = { error };
    }
  }
  // Built for every call rather than only the dispatched ones, so a host hears of the calls
  // the loop answers itself in the same shape. Arguments that could not be read are none.
  const request: ToolCallRequest = { id: call.id, name, args: inner, raw };
  run.onEvent({ kind: "tool-call", id: call.id, name, text: preview(raw) });
  run.onToolCall?.(request);
  let content: string;
  let ok = true;
  try {
    if (!args) throw unreadable;
    // By the name the model called, not the one a `call_tool` wraps: `load_tools` is not in
    // the catalogue, and one reached through `call_tool` is refused below like any other.
    if (onDemand && call.function.name === LOAD_TOOLS) {
      ({ content, ok } = answerLoad(run, args));
    } else {
      if (refused) throw refused.error;
      // A model that skips `load_tools` and calls a catalogued tool by name is right about
      // what it wants; load it and run it rather than refusing. Not proxied, where loaded
      // means its definition is in the history, and this call put none there.
      if (onDemand && !proxied && inCatalog(catalog, name)) run.loaded.add(name);
      run.used.add(name);
      // Keyed on the inner call, so one made through `call_tool` and one made natively share.
      const key = `${name}\0${proxy ? JSON.stringify(inner) : normal}`;
      content = run.dedupable(request)
        ? await once(answered, key, () => run.dispatch(request, signal))
        : await run.dispatch(request, signal);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    content = errorMessage(error);
    ok = false;
  }
  run.onEvent({ kind: "tool-result", id: call.id, name, ok, text: preview(content) });
  const result = { id: call.id, name, ok, content };
  run.onToolResult?.(result);
  return result;
}

/**
 * Runs a step's calls and writes each result into the transcript, in the order asked.
 *
 * A failure part-way leaves the transcript well-formed before it is rethrown: a call with no
 * result is a transcript no endpoint takes back, so every call of the step is answered — with what
 * it returned where it had, and otherwise with a line saying it was stopped, or never run.
 *
 * @param run The run the step belongs to.
 * @param parsed The step's calls, with their arguments read.
 * @param messages The transcript the results are written into.
 * @param step Which step this is, for the host told of each result.
 */
async function runCalls(
  run: Calling,
  parsed: ReadCall[],
  messages: OpenAI.ChatCompletionMessageParam[],
  step: number,
): Promise<void> {
  const { signal, toolCalls } = run;
  // Per step, not per run: the answer to a call made two steps ago was true before the tools in
  // between ran, and the file the model read may be the file it has since written.
  const answered = new Map<string, Promise<string>>();
  // By position, so a call that came back while another was being stopped is still found.
  const outcomes: (Awaited<ReturnType<typeof runCall>> | undefined)[] = parsed.map(() => undefined);
  // How many of the step's calls were handed off, and how many have their result in the
  // transcript. Both count from the front, since results are written in the order asked.
  let begun = 0;
  let kept = 0;
  const keep = async (id: string, content: string) => {
    const result: OpenAI.ChatCompletionToolMessageParam = {
      role: "tool",
      tool_call_id: id,
      content,
    };
    messages.push(result);
    kept++;
    await run.announce(result, step);
  };
  try {
    if (run.parallel) {
      signal?.throwIfAborted();
      begun = parsed.length;
      await Promise.all(
        parsed.map(async (call, at) => {
          outcomes[at] = await runCall(run, call, answered);
        }),
      );
      for (const { id, name, ok, content } of outcomes.flatMap((outcome) => outcome ?? [])) {
        toolCalls.push({ id, name, ok });
        await keep(id, content);
      }
    } else {
      for (const [at, call] of parsed.entries()) {
        signal?.throwIfAborted();
        begun = at + 1;
        const { id, name, ok, content } = await runCall(run, call, answered);
        toolCalls.push({ id, name, ok });
        await keep(id, content);
      }
    }
  } catch (error) {
    // Only a call that was made counts in `toolCalls`.
    for (const [at, entry] of parsed.entries()) {
      const { call } = entry;
      if (at < kept) continue;
      const outcome = outcomes[at];
      // Under the name it was announced by, which for a `call_tool` is the tool it names.
      if (at < begun) {
        toolCalls.push({ id: call.id, name: shownAs(run, entry).name, ok: outcome?.ok ?? false });
      }
      // The run is already ending on `error`; a host that cannot take this result does not
      // get to replace it.
      await keep(call.id, outcome?.content ?? (at < begun ? STOPPED_CALL : UNRUN_CALL)).catch(
        () => {},
      );
    }
    throw error;
  }
}

/**
 * Writes a proxied preselection into the transcript as a `load_tools` exchange: the tool array is
 * fixed, so a shortlist has nowhere else to go, and it is answered as though the model had loaded
 * it. Told to the host as a call the model made would be, so one pairing calls with results by id
 * shows this one like the rest.
 *
 * @param run The run it opens.
 * @param shortlist The definitions preselected, each of them in the catalogue.
 * @param messages The transcript, which the exchange is appended to.
 */
async function loadShortlist(
  run: Calling,
  shortlist: OpenAI.ChatCompletionTool[],
  messages: OpenAI.ChatCompletionMessageParam[],
): Promise<void> {
  const { catalog } = run;
  const names = shortlist.map((tool) => toolName(tool) ?? "");
  // Numbered by where the call lands, so two questions in one transcript do not share an id.
  const id = `preselect-${messages.length}`;
  const args = JSON.stringify({ names });
  // Held to its own length rather than `MAX_PER_LOAD`: that cap is for a model choosing, and a
  // host that shortlisted more has already chosen.
  const content = proxyLoadResult(expandNames(names, catalog, names.length), catalog, shortlist);
  run.onEvent({ kind: "tool-call", id, name: LOAD_TOOLS, text: preview(args) });
  run.onToolCall?.({ id, name: LOAD_TOOLS, args: { names }, raw: args });
  run.onEvent({ kind: "tool-result", id, name: LOAD_TOOLS, ok: true, text: preview(content) });
  run.onToolResult?.({ id, name: LOAD_TOOLS, ok: true, content });
  run.toolCalls.push({ id, name: LOAD_TOOLS, ok: true });
  run.loads.toolsLoaded += names.length;
  for (const name of names) run.loaded.add(name);
  const exchange: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name: LOAD_TOOLS, arguments: args } }],
    },
    { role: "tool", tool_call_id: id, content },
  ];
  // Both written before either is announced, so a host that throws on the first leaves a call
  // with its result. Told as step zero's, with no turn: no request was made for them.
  messages.push(...exchange);
  for (const message of exchange) await run.announce(message, 0);
}

/**
 * The steps of `runAgentLoop`, throwing what they caught as it was caught. Resolves to nothing
 * when `maxToolIterations` is spent, and tells `standing` how to read the run either way.
 */
async function runSteps(
  options: AgentLoopOptions,
  standing: Standing,
): Promise<AgentLoopResult | undefined> {
  const { config, system = "", tools = [], catalog = [], dispatch, hooks, signal } = options;
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
    preselectRouting = "exclusive",
  } = options;
  const dedupable = typeof dedupeToolCalls === "function" ? dedupeToolCalls : () => dedupeToolCalls;
  const started = Date.now();
  // What the loop emitted, less the token deltas, for `runMetrics` at the end. Stamped here rather
  // than by the bus, which the loop does not know about.
  const recorded: RunEvent[] = [];
  const record = (input: RunEventInput) => {
    if (input.kind === "thinking" || input.kind === "output") return;
    recorded.push(stamp(input, "", recorded.length + 1, Date.now()));
  };
  const onEvent = (input: RunEventInput) => {
    record(input);
    options.onEvent?.(input);
  };
  const client = getClient(config);
  const supports = capabilitiesFor(config.baseUrl, config.apiKey);
  const maxRetries = Math.max(0, Number(config.maxRetries) || 0);
  const notice = (text: string) => onEvent({ kind: "notice", text });

  // On demand, but with a tool array that never changes: definitions come back as `load_tools`
  // results and run through `call_tool`. `onDemand` is true of both.
  const proxied = config.toolDiscovery === "proxy" && catalog.length > 0;
  const onDemand = proxied || (config.toolDiscovery === "ondemand" && catalog.length > 0);
  // Proxied, `loaded` is what this run has put a definition in the history for, and starts empty.
  const loaded = new Set(onDemand && !proxied ? (options.loaded ?? []) : []);
  // The loop's own preselection, where it was asked for and the host has not already decided.
  const preselected = !onDemand
    ? []
    : options.preselect && options.preselected === undefined
      ? await chooseTools(options, notice)
      : [...(options.preselected ?? [])];
  if (!proxied) for (const name of preselected) loaded.add(name);
  const summarise = ownSummariser(options, notice);
  const used = new Set<string>();
  const definitions = new Map<string, OpenAI.ChatCompletionTool>();
  for (const tool of tools) {
    const name = toolName(tool);
    if (name !== undefined && !definitions.has(name)) definitions.set(name, tool);
  }
  // Looked through unless the host has a tool by that name, which is then the host's to answer.
  const proxies = onDemand && !definitions.has(CALL_TOOL);
  // What a call the model wrote as text may name: the host's tools, and the loop's own on demand.
  const recoverable = [
    ...tools.map(toolName).filter((name) => name !== undefined),
    ...(onDemand ? [LOAD_TOOLS, ...(proxies ? [CALL_TOOL] : [])] : []),
  ];
  // In the order the names are given, not the order of `tools`: `loaded` is a set, which iterates
  // in the order things were added, so a load appends and never reshuffles what went before.
  const byName = (names: Iterable<string>) => definedAs(definitions, names);

  let messages = [...options.messages];
  let usage = noUsage();
  const toolCalls: ToolCallOutcome[] = [];
  standing.read = () => ({
    messages,
    usage,
    toolCalls,
    // As the result would have said it: proxied, nothing is loaded that the history does not hold.
    loaded: proxied ? [] : [...loaded],
    used: [...used],
  });
  // Once `onMessage` has thrown the run is ending on that, and the results still to be written
  // into the transcript are not offered to a host that has just failed to take one.
  let heard = true;
  const announce = async (
    message: OpenAI.ChatCompletionMessageParam,
    step: number,
    turn?: Turn,
  ) => {
    if (!onMessage || !heard) return;
    try {
      await onMessage(message, step, turn);
    } catch (error) {
      heard = false;
      throw error;
    }
  };
  // Held by reference rather than by index, so a `beforeStep` that folds the head into a summary
  // moves the question without losing it — and one that summarises the question away takes the
  // hooks' context with it, which is right.
  const question = messages.findLast((message) => message.role === "user");
  const questionAt = () => (question ? messages.indexOf(question) : -1);
  const gathered: Gathered = hooks
    ? await gather(hooks.run, hooks.events ?? ["beforeTurn"], hooks.context, {
        signal,
        onNote: hooks.onNote,
        maxTokens: hooks.maxTokens,
      })
    : { context: "", notes: [] };
  // Read once, so what the result hands back is what every step of this run said.
  const preface = hooks?.preface ?? configureHooks().preface;

  const loads = { toolsLoaded: 0, redundantLoads: 0, unknownToolNames: 0 };
  let previous: Sent | undefined;
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
    loaded,
    loads,
    used,
    toolCalls,
    dedupable,
    dispatch,
    parallel,
    signal,
    onEvent,
    onToolCall,
    onToolResult,
    announce,
  };

  if (shortlist.length) await loadShortlist(calling, shortlist, messages);

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
    // The last request's prompt describes this transcript only while nothing has rewritten it.
    const next = summarise
      ? await foldBeforeStep(given, given === messages ? reported : {}, summarise, {
          options,
          charsPerToken: charsPerTokenFor(supports, config.model),
          notice,
        })
      : given;
    // A rewrite may have folded a definition away, and a load answered "already loaded" would
    // then point at nothing. Forgetting costs a definition sent twice at worst.
    if (proxied && next !== messages) loaded.clear();
    messages = next;
    ledger = rebaseLedger(ledger, before, messages);
    onEvent({ kind: "turn", text: `turn ${step + 1}` });

    // Appended, the shortlist is already in `loaded` — after what was carried, and once — so the
    // first step needs nothing of its own. Proxied, it is in the history.
    const routed =
      !proxied && preselectRouting !== "append" && preselected.length > 0 && step === 0;
    // Ordered here rather than left to `buildBody`, so `names` below is what the request actually
    // declared — a diagnosis reading an order the server never saw calls an untouched tool array
    // `tools-changed`.
    const declared = orderTools(
      routed
        ? byName(new Set(preselected))
        : proxied
          ? [...PROXY_TOOLS]
          : onDemand
            ? loadedTools([LOAD_TOOLS_DEFINITION], byName(loaded))
            : tools,
      toolOrder,
    );
    // Unmarked, so the system prompt is the same text on every step and a load does not throw
    // away the cache for the whole transcript. What is loaded is said in `declared` and in the
    // `load_tools` result instead. The preselected first step is the one exception, by design,
    // and `preselectRouting: "append"` is the way out of it.
    const catalogue = proxied ? proxyCatalogPrompt(catalog) : catalogPrompt(catalog);
    const prompt = onDemand && !routed ? `${system}\n\n${catalogue}`.trim() : system;
    const request: OpenAI.ChatCompletionMessageParam[] = [
      ...(prompt ? [{ role: "system" as const, content: prompt }] : []),
      ...withContext(messages, questionAt(), gathered.context, preface),
    ];

    const build = (supported: Capabilities, refused: ModelCapabilities | undefined) =>
      buildBody(config, supported, refused, request, declared, toolOrder);
    const turnOptions = {
      model: config.model,
      droppable: Object.keys(config.extraBody ?? {}),
      maxRetries,
      ...(config.loadingTimeoutSeconds === undefined
        ? {}
        : { loadingTimeoutMs: Math.max(0, config.loadingTimeoutSeconds) * 1000 }),
      contextLimit: config.contextLength ?? 0,
      signal,
      idleMs: timeoutMs(config),
      firstChunkMs: firstTokenMs(config) ?? 0,
      onNotice: notice,
      onThinking: (text: string) => onEvent({ kind: "thinking", text }),
      onOutput: (text: string) => onEvent({ kind: "output", text }),
    };
    // Built the way `negotiate` is about to build the first attempt — the same flags, the same
    // model's refusals — so what the host is told is what is sent unless something is refused.
    if (onRequest) {
      const opening = build(supports, modelCapabilitiesFor(supports, config.model));
      onRequest({ messages: opening.messages, tools: opening.tools ?? [], step });
    }
    const first = await runTurn(client, supports, build, turnOptions);
    const names = declared.map((tool) => toolName(tool) ?? "");
    // Compared before any continuation is joined on: the cache a request meets is the one its own
    // prompt found, and a continuation's prompt is this request's plus the reply so far.
    // The breakdown measures the array `toolSchemaTokens` does, so where no prompt was reported
    // the two give one number for the tool block rather than two.
    const charsPerToken = charsPerTokenFor(supports, config.model);
    Object.assign(first.usage, cacheDiagnosis(previous, request, names, first.usage), {
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
    if (entered !== ledger) measured = sent;
    ledger = entered;
    const turn =
      maxContinuations > 0
        ? await continueTurn(client, supports, build, first, { ...turnOptions, maxContinuations })
        : first;
    previous = {
      messages: request,
      tools: names,
      prompt: firstPrompt,
      completion: turn.usage.completion,
    };
    usage = addCounts(usage, turn.usage);
    onEvent({
      kind: "usage",
      usage: {
        promptTokens: usage.prompt,
        completionTokens: usage.completion,
        totalTokens: usage.total,
        cachedTokens: usage.cached,
        turn: { ...turn.usage, finishReason: turn.finishReason },
        ledger,
      },
    });
    if (turn.finishReason === "length") {
      notice(`the model stopped at maxTokens (${config.maxTokens}); this turn is cut short`);
    }
    // A call with no name is a fragment the server never finished sending: nothing to run, and
    // an assistant message naming it would be answered by nothing.
    let calls: ToolCall[] = turn.toolCalls.filter((call) => call.function.name);
    let content = turn.content;
    if (recover && !calls.length && content && (tools.length > 0 || onDemand)) {
      const recovered = recoverToolCalls(content, { names: recoverable });
      if (recovered.toolCalls.length) {
        calls = recovered.toolCalls;
        content = recovered.content;
        notice(
          `recovered ${counted(calls.length, "tool call")} the model wrote as text; the server's tool-call parser does not match this model's template`,
        );
      }
    }
    const shown: Turn = { ...turn, content, toolCalls: calls };
    onTurn?.(shown, step);

    // Read before the assistant message is written, so what is replayed on every later request
    // is the repaired JSON.
    const parsed = readCalls(calls, turn.finishReason);
    const assistant = assistantMessage(content, parsed);
    messages.push(assistant);
    await announce(assistant, step, shown);

    if (!calls.length) {
      // Not awaited: the answer is ready, and remembering it is not something to hold it for.
      // Handed back instead, for a host that wants its notes.
      const afterTurn = hooks
        ? tellAfterTurn(hooks, messages, questionAt(), turn.content)
        : Promise.resolve([]);
      const metrics = runMetrics(recorded, { contextLength: config.contextLength });
      return {
        turn: shown,
        messages,
        usage,
        toolCalls,
        loaded: proxied ? [] : [...loaded],
        used: [...used],
        notes: gathered.notes,
        context: gathered.context,
        preface,
        afterTurn,
        metrics: {
          ...metrics,
          ...(onDemand ? loads : {}),
          wallMs: Date.now() - started,
          outcome: turn.finishReason === "length" ? "truncated" : "answered",
        },
        ledger,
      };
    }

    await runCalls(calling, parsed, messages, step);
  }

  return undefined;
}

/**
 * Makes a call at most once per key, sharing the in-flight promise so two identical calls in one
 * step make one request between them whether they run together or one after the other. A call
 * that rejected is forgotten, so asking again is a real retry rather than a replayed failure.
 */
async function once(
  answered: Map<string, Promise<string>>,
  key: string,
  make: () => Promise<string>,
): Promise<string> {
  const previous = answered.get(key);
  if (previous) return previous;
  const pending = make();
  answered.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (answered.get(key) === pending) answered.delete(key);
    throw error;
  }
}
