import type OpenAI from 'openai';
import type { CatalogServer } from './catalog.ts';
import { errorMessage } from './errors.ts';
import type { RunEventInput } from './events.ts';
import type { Turn } from './stream.ts';
import {
  parseToolArguments,
  type ToolCall,
  type ToolCallOutcome,
  type ToolCallRequest,
  type ToolCallResult,
} from './tool-calls.ts';
import {
  CALL_TOOL,
  expandNames,
  inCatalog,
  LOAD_TOOLS,
  loadResult,
  proxiedCall,
  proxyLoadResult,
  requestedNames,
  shownCall,
  toolName,
} from './tool-loading.ts';

/**
 * The tools between two turns: a step's calls read, run and written into the transcript.
 *
 * Apart from the loop because it is a different job with its own rules — a call is announced
 * before it runs and answered whatever happens, `load_tools` and `call_tool` are answered here
 * rather than dispatched, and a failure part-way has to leave a transcript an endpoint will take
 * back — and none of them is about when to send the next request.
 */

/**
 * A long tool argument or result cut to what a watcher needs, with the full length said.
 *
 * For events, never for the transcript: the model reads the whole of what a tool returned.
 *
 * @param text - What to show.
 * @param [limit] - Characters kept. Text at or under it comes back as it was.
 */
export const preview = (text: string, limit = 2000) =>
  text.length > limit ? `${text.slice(0, limit)}… (${text.length} chars)` : text;

/** What a tool call the run was stopped during is answered with, in place of a result. */
const STOPPED_CALL = 'Stopped before this call finished.';

/** The same for a call of that step the loop never got to. */
const UNRUN_CALL = 'Not run: the run stopped first.';

/** One of a turn's calls with its arguments read, or with the reason they could not be. */
export interface ReadCall {
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
export const readCalls = (calls: ToolCall[], finishReason: Turn['finishReason']): ReadCall[] =>
  calls.map((call) => {
    try {
      const args = parseToolArguments(call.function.arguments, { finishReason });
      return { call, args, normal: JSON.stringify(args) };
    } catch (error) {
      return { call, error, normal: '{}' };
    }
  });

/** The assistant message a turn is written into the transcript as, its calls' arguments repaired. */
export const assistantMessage = (content: string, parsed: ReadCall[]): OpenAI.ChatCompletionAssistantMessageParam => ({
  role: 'assistant',
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

/** The definitions the host gave for these names, in the order the names are given. */
export const definedAs = (definitions: ReadonlyMap<string, OpenAI.ChatCompletionTool>, names: Iterable<string>) =>
  [...names].flatMap((name) => definitions.get(name) ?? []);

/** Runs one tool call and resolves to what the model reads; what it throws, the model reads too. */
export type ToolDispatch = (call: ToolCallRequest, signal?: AbortSignal) => Promise<string>;

/**
 * What running a step's calls reads of the run and writes back into it. One per run, shared by
 * every step: the sets and counts here are the run's own, not copies.
 */
export interface Calling {
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
  dispatch: ToolDispatch;
  parallel: boolean;
  signal: AbortSignal | undefined;
  onEvent: (input: RunEventInput) => void;
  onToolCall: ((call: ToolCallRequest) => void) | undefined;
  onToolResult: ((result: ToolCallResult) => void) | undefined;
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
  for (const hit of hits) {
    loads[loaded.has(hit) ? 'redundantLoads' : 'toolsLoaded']++;
  }
  loads.unknownToolNames += resolved.unknown.length;
  for (const hit of hits) {
    loaded.add(hit);
  }
  return { content, ok: hits.length > 0 };
}

/**
 * Makes a call at most once per key, sharing the in-flight promise so two identical calls in one
 * step make one request between them whether they run together or one after the other. A call
 * that rejected is forgotten, so asking again is a real retry rather than a replayed failure.
 */
async function once(answered: Map<string, Promise<string>>, key: string, make: () => Promise<string>): Promise<string> {
  const previous = answered.get(key);
  if (previous) {
    return previous;
  }
  const pending = make();
  answered.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (answered.get(key) === pending) {
      answered.delete(key);
    }
    throw error;
  }
}

/**
 * Runs one call to its result, telling the host of both. A tool that throws is that call's answer
 * rather than the run's end, unless the run was stopped.
 *
 * @param run - The run the call belongs to.
 * @param entry - The call, with its arguments read.
 * @param answered - The step's calls already made, by tool and arguments, for `dedupeToolCalls`.
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
  run.onEvent({ kind: 'tool-call', id: call.id, name, text: preview(raw) });
  run.onToolCall?.(request);
  let content: string;
  let ok = true;
  try {
    if (!args) {
      throw unreadable;
    }
    // By the name the model called, not the one a `call_tool` wraps: `load_tools` is not in
    // the catalogue, and one reached through `call_tool` is refused below like any other.
    if (onDemand && call.function.name === LOAD_TOOLS) {
      ({ content, ok } = answerLoad(run, args));
    } else {
      if (refused) {
        throw refused.error;
      }
      // A model that skips `load_tools` and calls a catalogued tool by name is right about
      // what it wants; load it and run it rather than refusing. Not proxied, where loaded
      // means its definition is in the history, and this call put none there.
      if (onDemand && !proxied && inCatalog(catalog, name)) {
        run.loaded.add(name);
      }
      run.used.add(name);
      // Keyed on the inner call, so one made through `call_tool` and one made natively share.
      const key = `${name}\0${proxy ? JSON.stringify(inner) : normal}`;
      content = run.dedupable(request)
        ? await once(answered, key, () => run.dispatch(request, signal))
        : await run.dispatch(request, signal);
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    content = errorMessage(error);
    ok = false;
  }
  run.onEvent({ kind: 'tool-result', id: call.id, name, ok, text: preview(content) });
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
 * @param run - The run the step belongs to.
 * @param parsed - The step's calls, with their arguments read.
 * @param messages - The transcript the results are written into.
 * @param step - Which step this is, for the host told of each result.
 */
export async function runCalls(
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
      role: 'tool',
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
      if (at < kept) {
        continue;
      }
      const outcome = outcomes[at];
      // Under the name it was announced by, which for a `call_tool` is the tool it names.
      if (at < begun) {
        toolCalls.push({ id: call.id, name: shownAs(run, entry).name, ok: outcome?.ok ?? false });
      }
      // The run is already ending on `error`; a host that cannot take this result does not
      // get to replace it.
      await keep(call.id, outcome?.content ?? (at < begun ? STOPPED_CALL : UNRUN_CALL)).catch(() => {});
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
 * @param run - The run it opens.
 * @param shortlist - The definitions preselected, each of them in the catalogue.
 * @param messages - The transcript, which the exchange is appended to.
 */
export async function loadShortlist(
  run: Calling,
  shortlist: OpenAI.ChatCompletionTool[],
  messages: OpenAI.ChatCompletionMessageParam[],
): Promise<void> {
  const { catalog } = run;
  const names = shortlist.map((tool) => toolName(tool) ?? '');
  // Numbered by where the call lands, so two questions in one transcript do not share an id.
  const id = `preselect-${messages.length}`;
  const args = JSON.stringify({ names });
  // Held to its own length rather than `MAX_PER_LOAD`: that cap is for a model choosing, and a
  // host that shortlisted more has already chosen.
  const content = proxyLoadResult(expandNames(names, catalog, names.length), catalog, shortlist);
  run.onEvent({ kind: 'tool-call', id, name: LOAD_TOOLS, text: preview(args) });
  run.onToolCall?.({ id, name: LOAD_TOOLS, args: { names }, raw: args });
  run.onEvent({ kind: 'tool-result', id, name: LOAD_TOOLS, ok: true, text: preview(content) });
  run.onToolResult?.({ id, name: LOAD_TOOLS, ok: true, content });
  run.toolCalls.push({ id, name: LOAD_TOOLS, ok: true });
  run.loads.toolsLoaded += names.length;
  for (const name of names) {
    run.loaded.add(name);
  }
  const exchange: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: LOAD_TOOLS, arguments: args } }],
    },
    { role: 'tool', tool_call_id: id, content },
  ];
  // Both written before either is announced, so a host that throws on the first leaves a call
  // with its result. Told as step zero's, with no turn: no request was made for them.
  messages.push(...exchange);
  for (const message of exchange) {
    await run.announce(message, 0);
  }
}
