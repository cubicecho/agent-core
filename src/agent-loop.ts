import type OpenAI from "openai";
import { type Capabilities, capabilitiesFor, type ModelCapabilities } from "./capabilities.ts";
import type { CatalogServer } from "./catalog.ts";
import { firstTokenMs, getClient, NO_KEY, timeoutMs } from "./client.ts";
import type { Endpoint, ModelParams, RetryPolicy, ToolPolicy } from "./config.ts";
import { errorMessage } from "./errors.ts";
import type { RunEventInput } from "./events.ts";
import {
  type Gathered,
  gather,
  type HookContext,
  type HookEvent,
  type HookNote,
  type HookRunner,
  notify,
  turnIndex,
  turnMessages,
  withContext,
} from "./hooks.ts";
import { runTurn } from "./run-turn.ts";
import { relaxTools, sanitizeTools } from "./schema-compat.ts";
import { askJson, tryAsk } from "./side-task.ts";
import type { Turn, TurnUsage } from "./stream.ts";
import { parseToolArguments, recoverToolCalls, type ToolCall } from "./tool-calls.ts";
import {
  catalogPrompt,
  expandNames,
  inCatalog,
  LOAD_TOOLS,
  LOAD_TOOLS_DEFINITION,
  loadedTools,
  loadResult,
  MAX_PER_LOAD,
  PRESELECT_SCHEMA,
  preselectInput,
  preselection,
  preselectSystem,
  requestedNames,
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

/** The fields `extraBody` may not override, because the loop's request is built around them. */
const RESERVED = new Set(["model", "messages", "stream", "tools"]);

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
 * absent or `"off"` sends no effort.
 * @param supports What the endpoint has refused, as `negotiate` hands it to `send`.
 * @param refused What the model has refused, as `negotiate` hands it over. Absent is a model
 * that has refused nothing.
 * @param messages The request's messages, system prompt included, sent as they are.
 * @param tools The tool definitions. Sanitised here — a lookup for a definition seen before —
 * and relaxed where the endpoint needs it. Empty sends no `tools` field at all.
 */
export function buildBody(
  config: ModelParams,
  supports: Capabilities,
  refused: ModelCapabilities | undefined,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionTool[] = [],
): OpenAI.ChatCompletionCreateParamsStreaming {
  const declared = supports.strictSchemas ? sanitizeTools(tools) : relaxTools(sanitizeTools(tools));
  const effort = config.reasoningEffort;
  const extra = Object.entries(config.extraBody ?? {}).filter(
    ([field]) => !RESERVED.has(field) && !refused?.refusedFields.has(field),
  );
  return {
    ...(config.maxTokens > 0
      ? refused?.legacyTokenLimit === false
        ? { max_completion_tokens: config.maxTokens }
        : { max_tokens: config.maxTokens }
      : {}),
    ...(refused?.chosenTemperature === false ? {} : { temperature: config.temperature }),
    ...(effort && effort !== "off" && refused?.reasoningEffort !== false
      ? { reasoning_effort: effort as OpenAI.ReasoningEffort }
      : {}),
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
 * The tools a request is likely to need, picked by a small model before the run starts, or none.
 *
 * On-demand loading otherwise spends a round trip on reading the catalogue and calling
 * `load_tools`; a small model reading the same catalogue usually names the right tools, and the
 * task model opens with them in hand. A wrong guess costs a few hundred tokens for one run, and
 * a failed one costs nothing — it is reported through `onNotice` and answered with an empty list,
 * since a side task is never worth failing the run. A stop still throws.
 *
 * @param config The endpoint the preselector is reached through.
 * @param model The preselector. An empty name picks nothing, which is what `toolSelectModel`
 * means by empty.
 * @param catalog The servers to choose from.
 * @param prompt The request being planned for. Only its head is read; see `preselectInput`.
 * @param options Cancellation, notices, the reply ceiling (256) and the cap the choice is held to
 * (`MAX_PER_LOAD`).
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
    maxPerLoad = MAX_PER_LOAD,
  }: {
    signal?: AbortSignal;
    onNotice?: (message: string) => void;
    maxTokens?: number;
    maxPerLoad?: number;
  } = {},
): Promise<string[]> {
  if (!model || !catalog.some((server) => server.tools.length > 0)) return [];
  const reply = await tryAsk(
    "preselect",
    () =>
      askJson<unknown>(
        config,
        model,
        preselectSystem(maxPerLoad),
        preselectInput(catalog, prompt),
        PRESELECT_SCHEMA,
        { name: "preselection", maxTokens, signal, onNotice },
      ),
    { onNotice },
  );
  return preselection(reply, catalog, maxPerLoad);
}

/** One call the model made, as `dispatch` is handed it. */
export interface ToolCallRequest {
  id: string;
  name: string;
  /** Parsed by `parseToolArguments`, repairs and all. */
  args: Record<string, unknown>;
  /** The arguments as the model wrote them, before any repair. */
  raw: string;
}

/** What one tool call did, in the order the model asked. */
export interface ToolCallOutcome {
  name: string;
  /** False when the arguments did not parse, the tool threw, or `load_tools` loaded nothing. */
  ok: boolean;
}

/** The hooks a loop runs around one question. See `hooks.ts`. */
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

/** What `runAgentLoop` takes. */
export interface AgentLoopOptions {
  /**
   * The endpoint, what to ask the model for, and how long it may keep calling tools.
   * `toolDiscovery` absent is eager, `maxRetries` absent is none, and `contextLength` is handed
   * to `runTurn` as `contextLimit`, which sizes each request against the window before sending.
   */
  config: Endpoint &
    ModelParams &
    Pick<ToolPolicy, "maxToolIterations"> &
    Partial<Pick<ToolPolicy, "toolDiscovery">> &
    Partial<RetryPolicy> & { contextLength?: number };
  /** The standing instruction, sent as the first message. On-demand mode appends the catalogue. */
  system?: string;
  /** The transcript so far, ending in the question. Not written to; see the result's `messages`. */
  messages: OpenAI.ChatCompletionMessageParam[];
  /**
   * Every tool this run may reach. Eager mode sends all of them; on-demand mode sends the ones
   * loaded so far, by name.
   */
  tools?: OpenAI.ChatCompletionTool[];
  /** The same tools as a name-only catalogue. On-demand mode needs it, and is eager without it. */
  catalog?: CatalogServer[];
  /**
   * What `preselect` picked. The first step is sent these and nothing else — no catalogue, no
   * `load_tools` — because a model with the menu still in front of it shops: it reloads what it
   * has or picks a sibling. Everything comes back on the step after.
   */
  preselected?: readonly string[];
  /** Tools already loaded, carried from an earlier question. See `carryOver`. */
  loaded?: Iterable<string>;
  /** Runs one tool call and returns what the model reads. What it throws, the model reads too. */
  dispatch: (call: ToolCallRequest, signal?: AbortSignal) => Promise<string>;
  /**
   * Runs a step's calls together rather than one after another, and makes an identical call —
   * the same name and arguments, word for word — once for the run, handing a repeat the first
   * answer. A call that threw is not an answer and is made again. Results still go into the
   * transcript in the order the model asked.
   */
  parallel?: boolean;
  /** Hooks gathered onto the question before the first request, and told the reply after. */
  hooks?: AgentLoopHooks;
  /**
   * Called before each step with the transcript, and what it returns replaces it — the point to
   * compact or prune a run that has grown into its window. Returning nothing keeps it.
   */
  beforeStep?: (
    messages: readonly OpenAI.ChatCompletionMessageParam[],
    step: number,
  ) =>
    | OpenAI.ChatCompletionMessageParam[]
    | undefined
    | Promise<OpenAI.ChatCompletionMessageParam[] | undefined>;
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
  /** Each turn as it comes back, before its tools run. Recovered calls are in it as calls. */
  onTurn?: (turn: Turn, step: number) => void;
}

/** What a finished loop hands back. */
export interface AgentLoopResult {
  /** The last turn: the one that asked for no tools, as `onTurn` was handed it. */
  turn: Turn;
  /** The transcript, with every assistant turn and tool result the run added. No system prompt. */
  messages: OpenAI.ChatCompletionMessageParam[];
  /** Summed over every turn of the run. */
  usage: TurnUsage;
  /** Every call, `load_tools` included, in the order they were made. */
  toolCalls: ToolCallOutcome[];
  /** What is loaded at the end, for `carryOver`. Empty in eager mode. */
  loaded: string[];
  /** The tools the model actually called, `load_tools` excluded. */
  used: string[];
  /** The hooks' notes from before the first request. */
  notes: HookNote[];
}

/** Every numeric field of one usage added into another. */
const accumulate = (total: TurnUsage, turn: TurnUsage) => {
  for (const key of Object.keys(turn) as (keyof TurnUsage)[]) total[key] += turn[key] ?? 0;
};

/**
 * Runs a question to its answer: one `runTurn` per step, the tools it asks for between them,
 * until a turn asks for none. Throws when `maxToolIterations` is spent, when stopped, and on
 * whatever `runTurn` throws — `ContextOverflow` among them, however it was found out.
 *
 * On-demand loading is handled here, `load_tools` and all: the catalogue rides on the system
 * prompt unchanged from step to step, loaded tools are appended to the tool array in load order,
 * a catalogued tool called without being loaded is loaded and run rather than refused, and a
 * preselection shapes the first step. A turn cut off at `maxTokens` is said so as a notice,
 * because it otherwise reads exactly like a finished one.
 *
 * @param options The config, transcript, tools and dispatcher, plus the optional hooks, events
 * and cancellation. See `AgentLoopOptions`.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const { config, system = "", tools = [], catalog = [], dispatch, hooks, signal } = options;
  const {
    onEvent,
    onTurn,
    beforeStep,
    parallel = false,
    recoverToolCalls: recover = true,
  } = options;
  const client = getClient(config);
  const supports = capabilitiesFor(config.baseUrl, config.apiKey);
  const maxRetries = Math.max(0, Number(config.maxRetries) || 0);
  const notice = (text: string) => onEvent?.({ kind: "notice", text });

  const onDemand = config.toolDiscovery === "ondemand" && catalog.length > 0;
  const loaded = new Set(onDemand ? (options.loaded ?? []) : []);
  const preselected = onDemand ? [...(options.preselected ?? [])] : [];
  for (const name of preselected) loaded.add(name);
  const used = new Set<string>();
  const definitions = new Map<string, OpenAI.ChatCompletionTool>();
  for (const tool of tools) {
    if (tool.type === "function" && !definitions.has(tool.function.name)) {
      definitions.set(tool.function.name, tool);
    }
  }
  // In the order the names are given, not the order of `tools`: `loaded` is a set, which iterates
  // in the order things were added, so a load appends and never reshuffles what went before.
  const byName = (names: Iterable<string>) =>
    [...names].flatMap((name) => definitions.get(name) ?? []);

  let messages = [...options.messages];
  // Held by reference rather than by index, so a `beforeStep` that folds the head into a summary
  // moves the question without losing it — and one that summarises the question away takes the
  // hooks' context with it, which is right.
  const question = messages.findLast((message) => message.role === "user");
  const gathered: Gathered = hooks
    ? await gather(hooks.run, hooks.events ?? ["beforeTurn"], hooks.context, {
        signal,
        onNote: hooks.onNote,
        maxTokens: hooks.maxTokens,
      })
    : { context: "", notes: [] };

  const usage: TurnUsage = { prompt: 0, completion: 0, total: 0, cached: 0 };
  const toolCalls: ToolCallOutcome[] = [];
  const answered = new Map<string, Promise<string>>();

  for (let step = 0; step < config.maxToolIterations; step++) {
    // A stop aborts the request in flight, but a tool call already handed off runs to its own
    // end — so the signal is read between steps as well.
    signal?.throwIfAborted();
    messages = (await beforeStep?.(messages, step)) ?? messages;
    onEvent?.({ kind: "turn", text: `turn ${step + 1}` });

    const routed = preselected.length > 0 && step === 0;
    const declared = routed
      ? byName(new Set(preselected))
      : onDemand
        ? loadedTools([LOAD_TOOLS_DEFINITION], byName(loaded))
        : tools;
    // Unmarked, so the system prompt is the same text on every step and a load does not throw
    // away the cache for the whole transcript. What is loaded is said in `declared` and in the
    // `load_tools` result instead. The preselected first step is the one exception, by design.
    const prompt = onDemand && !routed ? `${system}\n\n${catalogPrompt(catalog)}`.trim() : system;
    const request: OpenAI.ChatCompletionMessageParam[] = [
      ...(prompt ? [{ role: "system" as const, content: prompt }] : []),
      ...withContext(
        messages,
        question ? messages.indexOf(question) : -1,
        gathered.context,
        hooks?.preface,
      ),
    ];

    const turn = await runTurn(
      client,
      supports,
      (supported, refused) => buildBody(config, supported, refused, request, declared),
      {
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
        onThinking: (text) => onEvent?.({ kind: "thinking", text }),
        onOutput: (text) => onEvent?.({ kind: "output", text }),
      },
    );
    accumulate(usage, turn.usage);
    if (turn.usage.total > 0 || turn.usage.prompt > 0 || turn.usage.completion > 0) {
      onEvent?.({
        kind: "usage",
        usage: {
          promptTokens: usage.prompt,
          completionTokens: usage.completion,
          totalTokens: usage.total,
        },
      });
    }
    if (turn.finishReason === "length") {
      notice(`the model stopped at maxTokens (${config.maxTokens}); this turn is cut short`);
    }
    // A call with no name is a fragment the server never finished sending: nothing to run, and
    // an assistant message naming it would be answered by nothing.
    let calls: ToolCall[] = turn.toolCalls.filter((call) => call.function.name);
    let content = turn.content;
    if (recover && !calls.length && content && (tools.length > 0 || onDemand)) {
      const names = tools.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []));
      const recovered = recoverToolCalls(content, {
        names: onDemand ? [...names, LOAD_TOOLS] : names,
      });
      if (recovered.toolCalls.length) {
        calls = recovered.toolCalls;
        content = recovered.content;
        notice(
          `recovered ${calls.length} tool call${calls.length === 1 ? "" : "s"} the model wrote as text; the server's tool-call parser does not match this model's template`,
        );
      }
    }
    const shown: Turn = { ...turn, content, toolCalls: calls };
    onTurn?.(shown, step);

    // Read before the assistant message is written, so what is replayed on every later request
    // is the repaired JSON: a server that parses replayed arguments refuses the almost-JSON, and
    // one that could not be read at all is replayed as no arguments.
    const parsed = calls.map((call) => {
      try {
        const args = parseToolArguments(call.function.arguments, {
          finishReason: turn.finishReason,
        });
        return { call, args, normal: JSON.stringify(args) };
      } catch (error) {
        return { call, error, normal: "{}" };
      }
    });

    messages.push({
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

    if (!calls.length) {
      if (hooks) {
        const at = question ? messages.indexOf(question) : -1;
        // Not awaited: the answer is ready, and remembering it is not something to hold it for.
        // `notify` never rejects.
        void notify(
          hooks.run,
          "afterTurn",
          {
            ...hooks.context,
            reply: turn.content,
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
      }
      return {
        turn: shown,
        messages,
        usage,
        toolCalls,
        loaded: [...loaded],
        used: [...used],
        notes: gathered.notes,
      };
    }

    const run = async ({ call, args, error: unreadable, normal }: (typeof parsed)[number]) => {
      const { name, arguments: raw } = call.function;
      onEvent?.({ kind: "tool-call", name, text: preview(raw) });
      let content: string;
      let ok = true;
      try {
        if (!args) throw unreadable;
        if (onDemand && name === LOAD_TOOLS) {
          const resolved = expandNames(requestedNames(args), catalog);
          content = loadResult(resolved, catalog, loaded);
          for (const hit of resolved.matched) loaded.add(hit);
          ok = resolved.matched.length > 0;
        } else {
          // A model that skips `load_tools` and calls a catalogued tool by name is right about
          // what it wants; load it and run it rather than refusing.
          if (onDemand && inCatalog(catalog, name)) loaded.add(name);
          used.add(name);
          const request = { id: call.id, name, args, raw };
          content = parallel
            ? await once(answered, `${name} ${normal}`, () => dispatch(request, signal))
            : await dispatch(request, signal);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        content = errorMessage(error);
        ok = false;
      }
      onEvent?.({ kind: "tool-result", name, ok, text: preview(content) });
      return { id: call.id, name, ok, content };
    };

    const outcomes: Awaited<ReturnType<typeof run>>[] = [];
    if (parallel) {
      signal?.throwIfAborted();
      outcomes.push(...(await Promise.all(parsed.map(run))));
    } else {
      for (const call of parsed) {
        signal?.throwIfAborted();
        outcomes.push(await run(call));
      }
    }
    for (const { id, name, ok, content } of outcomes) {
      toolCalls.push({ name, ok });
      messages.push({ role: "tool", tool_call_id: id, content });
    }
  }

  throw new Error(`Stopped after ${config.maxToolIterations} tool iterations.`);
}

/**
 * Makes a call at most once per key, sharing the in-flight promise so two identical calls in one
 * step make one request between them. A call that rejected is forgotten, so asking again is a
 * real retry rather than a replayed failure.
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
