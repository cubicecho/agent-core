import type OpenAI from 'openai';
import { ReasoningReplay } from '../core/config.ts';
import { isRecord } from '../core/guards.ts';
import type { CatalogServer } from '../tools/catalog.ts';
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
} from '../tools/tool-loading.ts';
import { type CallIdMinter, callIdsIn, freshCallId } from '../wire/call-ids.ts';
import { errorMessage } from '../wire/errors.ts';
import { reasoningEntry, type Turn } from '../wire/stream.ts';
import {
  type EndedBy,
  parseToolArguments,
  type ResourceLink,
  type RunArtifact,
  type ServerLogEntry,
  type ToolAnswer,
  type ToolCall,
  type ToolCallOutcome,
  type ToolCallReport,
  type ToolCallRequest,
  type ToolCallResult,
} from '../wire/tool-calls.ts';
import { FUNCTION_TOOL, REASONING, REASONING_CONTENT, type ReasoningField, Role } from '../wire/wire.ts';
import {
  type ArtifactFrom,
  declaredArtifact,
  detectArtifact,
  RECORD_ARTIFACT,
  type RunArtifacts,
} from './artifacts.ts';
import type { LoadCounts, RunEventInput } from './events.ts';
import { RunEventKind } from './events.ts';

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
 * @param text - What to show.
 * @param [limit] - Characters kept. Text at or under it comes back as it was.
 * @returns The text to show. Cut, it ends in an ellipsis and the whole length, `… (N chars)`.
 *
 * @remarks
 * For events, never for the transcript: the model reads the whole of what a tool returned.
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
  /** Whether `args` took a repair to read, as `ToolCallRequest.repaired` says. */
  repaired: boolean;
}

/**
 * Whether a call's arguments are, as written, the JSON of an object — or no arguments at all.
 *
 * @param raw - The arguments as the turn carried them: a string, or an object a server parsed.
 * @returns False where reading them took `parseToolArguments`' repairs.
 */
function readsAsWritten(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw.trim()) {
    return true;
  }
  try {
    return isRecord(JSON.parse(raw));
  } catch {
    return false;
  }
}

/**
 * One call with its arguments read, or with why they could not be.
 *
 * @param call - The call as the turn carried it.
 * @param finishReason - Why the turn ended, which tells a call cut off from one written wrongly.
 * @param recovered - Whether the call was recovered from the reply's text, which makes it repaired
 * whatever its arguments.
 * @returns The call beside its arguments and their repaired JSON, or beside the error and `{}`.
 */
function readCall(call: ToolCall, finishReason: Turn['finishReason'], recovered: boolean): ReadCall {
  try {
    const args = parseToolArguments(call.function.arguments, { finishReason });
    const repaired = recovered || !readsAsWritten(call.function.arguments);
    return { call, args, normal: JSON.stringify(args), repaired };
  } catch (error) {
    return { call, error, normal: '{}', repaired: false };
  }
}

/**
 * A turn's calls with their arguments read.
 *
 * @param calls - The turn's calls, in the order the model made them.
 * @param finishReason - Why the turn ended, which tells a call cut off from one written wrongly.
 * @param [recovered] - Whether the calls were recovered from the reply's text.
 * @returns One entry per call, in the same order. Unreadable arguments do not throw: the entry
 * carries the error in place of them.
 *
 * @remarks
 * A server that parses replayed arguments refuses the almost-JSON a model wrote, so each is
 * normalised here, and one that could not be read at all is replayed as no arguments.
 */
export const readCalls = (calls: ToolCall[], finishReason: Turn['finishReason'], recovered = false): ReadCall[] =>
  calls.map((call) => readCall(call, finishReason, recovered));

/** An assistant message as the loop writes it: the SDK's shape, plus the scratchpad it may replay. */
export type ReasonedMessage = OpenAI.ChatCompletionAssistantMessageParam & {
  [REASONING_CONTENT]?: string;
  [REASONING]?: string;
};

/** A scratchpad to write onto a message, and the field it goes under. */
export interface Scratchpad {
  /** The reasoning. Empty writes no field. */
  reasoning: string;
  /**
   * The field it arrived in, as `Turn.reasoningField` has it.
   *
   * @defaultValue `REASONING_CONTENT`
   */
  field?: ReasoningField;
}

/**
 * Whether a turn's scratchpad is written onto its assistant message under a policy.
 *
 * @param policy - The run's `reasoningReplay`.
 * @param endsInCalls - Whether the message carries tool calls, which is the tool loop's half.
 * @returns `true` under `all`, and under `tool-loop` for a message with calls.
 */
export const replaysReasoning = (policy: ReasoningReplay, endsInCalls: boolean) =>
  policy === ReasoningReplay.All || (policy === ReasoningReplay.ToolLoop && endsInCalls);

/**
 * What an assistant message's `content` is written as, for a turn's text.
 *
 * @param content - The turn's text.
 * @param hasCalls - Whether the message carries `tool_calls`.
 * @returns The text where there is any; otherwise `null` beside calls and `""` without them.
 *
 * @remarks
 * `null` is what the spec and every reference loop write beside calls. Without calls it leaves a
 * message with neither, which Ollama refuses on the next request that carries it ("invalid message
 * content type") and which a host's stored transcript carries into the next run. An empty string
 * is accepted by Ollama, llama.cpp and vLLM alike, and keeps the turn, and any reasoning on it, in
 * the history rather than dropping it as pydantic-ai does.
 */
const spokenContent = (content: string, hasCalls: boolean) => content || (hasCalls ? null : '');

/**
 * The assistant message a turn is written into the transcript as, its calls' arguments repaired.
 *
 * @param content - The turn's text. Empty is written as `null` beside calls and as `""` without
 * them, per `spokenContent`.
 * @param parsed - The turn's calls as `readCalls` read them. Not written to. None leaves
 * `tool_calls` off the message rather than empty.
 * @param [scratchpad] - The reasoning to replay, under the field it arrived in. None, or empty
 * reasoning, leaves the field off.
 * @returns A new message, each call on it a copy with `normal` for its arguments.
 */
export const assistantMessage = (content: string, parsed: ReadCall[], scratchpad?: Scratchpad): ReasonedMessage => ({
  role: Role.Assistant,
  content: spokenContent(content, parsed.length > 0),
  ...reasoningEntry(scratchpad?.reasoning ?? '', scratchpad?.field),
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
 * The assistant message a turn is, as the model produced it: its text and calls as they streamed.
 *
 * @param content - The turn's text, recovered calls left in it. Empty is written as
 * `assistantMessage` writes it.
 * @param calls - The calls the model sent as calls, with their arguments as streamed. Not written
 * to. None leaves `tool_calls` off the message rather than empty.
 * @param [scratchpad] - The reasoning, as `assistantMessage` was given it.
 * @returns A new message, each call on it a copy.
 */
export const writtenMessage = (content: string, calls: ToolCall[], scratchpad?: Scratchpad): ReasonedMessage => ({
  role: Role.Assistant,
  content: spokenContent(content, calls.length > 0),
  ...reasoningEntry(scratchpad?.reasoning ?? '', scratchpad?.field),
  ...(calls.length ? { tool_calls: calls.map((call) => ({ ...call, function: { ...call.function } })) } : {}),
});

/**
 * The transcript with `reasoning_content` and `reasoning` taken off its assistant messages from an
 * index on.
 *
 * @param messages - The transcript. Not written to.
 * @param [from] - The first index to drop it from. Negative reads as zero.
 * @returns `messages` itself where no message from `from` on carries the field, otherwise a new
 * array in which each such message is a copy without it and every other one the same object.
 *
 * @remarks
 * What `runAgentLoop` does to the question's tool loop under `tool-loop` once the answer is
 * written, what `buildBody` does for a model that refused the field, and what a host storing rows
 * from `onMessage` does to them under `tool-loop`.
 */
export function dropReasoning(
  messages: OpenAI.ChatCompletionMessageParam[],
  from = 0,
): OpenAI.ChatCompletionMessageParam[] {
  let out: OpenAI.ChatCompletionMessageParam[] | undefined;
  for (let at = Math.max(0, from); at < messages.length; at++) {
    const message = messages[at];
    const carries = REASONING_CONTENT in message || REASONING in message;
    if (message.role !== Role.Assistant || !carries) {
      continue;
    }
    const { [REASONING_CONTENT]: _content, [REASONING]: _alias, ...rest } = message as ReasonedMessage;
    out ??= [...messages];
    out[at] = rest;
  }
  return out ?? messages;
}

/**
 * The definitions the host gave for these names, in the order the names are given.
 *
 * @param definitions - The host's definitions by name.
 * @param names - The names wanted. One the host gave no definition for is left out, and one given
 * twice is answered twice.
 * @returns A new array of the definitions themselves, not copies.
 */
export const definedAs = (definitions: ReadonlyMap<string, OpenAI.ChatCompletionTool>, names: Iterable<string>) =>
  [...names].flatMap((name) => definitions.get(name) ?? []);

/**
 * Runs one tool call and resolves to what the model reads, alone or with what the call produced;
 * what it throws, the model reads too.
 *
 * @remarks
 * `report` is how the call tells watchers what its server said on the way, and a dispatcher with
 * nothing to report leaves it off: one written for `(call, signal)` is a `ToolDispatch` still.
 * `signal` is `undefined` rather than optional so that `report` can follow it.
 */
export type ToolDispatch = (
  call: ToolCallRequest,
  signal: AbortSignal | undefined,
  report: ToolCallReport,
) => Promise<string | ToolAnswer>;

/**
 * A server's log message as the text of its event.
 *
 * @param data - What the server sent: a string, or any JSON value.
 * @returns A string as it was, anything else as JSON, cut by `preview`. What JSON cannot spell is
 * shown as `String` shows it.
 */
function logText(data: unknown): string {
  if (typeof data === 'string') {
    return preview(data);
  }
  try {
    return preview(JSON.stringify(data) ?? String(data));
  } catch {
    return preview(String(data));
  }
}

/**
 * What one call's dispatcher may report through, and the switch that closes it once it has answered.
 *
 * @param run - The run, whose watchers hear what is reported.
 * @param id - The call's id, which every event it reports carries.
 * @param name - The tool the call is shown as.
 * @returns The report to hand `dispatch`, and `close`, after which it reports nothing.
 */
function reportFor(run: Calling, id: string, name: string): { report: ToolCallReport; close: () => void } {
  let isOpen = true;
  const log = ({ level, data }: ServerLogEntry) => {
    if (isOpen) {
      run.onEvent({ kind: RunEventKind.ServerLog, id, name, level, text: logText(data) });
    }
  };
  return {
    report: { log },
    close: () => {
      isOpen = false;
    },
  };
}

/** Whether an answer ends the run, and why where it said: `false`, or what `EndedBy` adds. */
type Ending = false | Pick<EndedBy, 'reason'>;

/**
 * A dispatcher's answer in the one shape, whichever it gave.
 *
 * @param answer - What `dispatch` resolved to.
 * @returns The text, the links and whether it ends the run, a string answer having no links and
 * ending nothing.
 */
function answerOf(answer: string | ToolAnswer): { text: string; links: ResourceLink[]; end: Ending } {
  if (typeof answer === 'string') {
    return { text: answer, links: [], end: false };
  }
  const { text, links = [], end = false } = answer;
  if (typeof end === 'object') {
    return { text, links, end: { reason: end.reason } };
  }
  return { text, links, end: end ? {} : false };
}

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
  /** The host's own tools by name: declared on every step, and never reached through `call_tool`. */
  hostNames: ReadonlySet<string>;
  loaded: Set<string>;
  loads: LoadCounts;
  used: Set<string>;
  toolCalls: ToolCallOutcome[];
  /** What the run's calls linked to, wrote, or were said to have stored, by location. */
  artifacts: RunArtifacts;
  /** Whether `record_artifact` is the loop's to answer, and every successful call is witnessed. */
  declares: boolean;
  /** Which successful calls are read for the shape of a write. Absent where none are. */
  detects: ((call: ToolCallRequest) => boolean) | undefined;
  dedupable: (call: ToolCallRequest) => boolean;
  dispatch: ToolDispatch;
  /** All of a step's calls together, each alone, or together in runs of the calls it passes. */
  parallel: boolean | ((call: ToolCallRequest) => boolean);
  signal: AbortSignal | undefined;
  onEvent: (input: RunEventInput) => void;
  onToolCall: ((call: ToolCallRequest) => void) | undefined;
  onToolResult: ((result: ToolCallResult) => void) | undefined;
  /** Offers a message just written into the transcript to the host. */
  announce: (message: OpenAI.ChatCompletionMessageParam, step: number) => Promise<void>;
  /** Where the id of a call the loop writes itself comes from. */
  mintCallId: CallIdMinter;
}

/**
 * What a call is shown, counted and dispatched as: a `call_tool` as the tool it names.
 *
 * @param run - The run, read for whether a `call_tool` is looked through.
 * @param entry - The call, with its arguments read.
 * @returns The name, and the arguments as JSON text under `input`: the inner tool's for a
 * `call_tool` that names one, and otherwise the call's own, as the model wrote them.
 *
 * @remarks
 * Read from the repaired arguments where there are any, since the model's own may be almost-JSON.
 */
const shownAs = (run: Calling, { call, args, normal }: ReadCall) =>
  run.proxies && call.function.name === CALL_TOOL
    ? shownCall(CALL_TOOL, args ? normal : call.function.arguments)
    : { name: call.function.name, input: call.function.arguments };

/**
 * Adds one call's load counts to the run's.
 *
 * @param into - The run's counts. Written to.
 * @param counts - The call's. Not written to.
 */
function addLoads(into: LoadCounts, counts: LoadCounts) {
  into.toolsLoaded += counts.toolsLoaded;
  into.redundantLoads += counts.redundantLoads;
  into.unknownToolNames += counts.unknownToolNames;
}

/**
 * Answers a `load_tools`, counting what it loaded.
 *
 * @param run - The run. Written to: the names this call loads are added to `loaded`, and `loads`
 * counts the new ones, the ones already loaded and the ones not in the catalogue.
 * @param args - The call's arguments, read as `requestedNames` reads them.
 * @returns The text the model reads; `ok`, false where nothing it named was loadable and true
 * where it named even one tool that was loaded already; and `counts`, this call's alone.
 */
function answerLoad(run: Calling, args: Record<string, unknown>) {
  const { catalog, proxied, definitions, loaded } = run;
  const resolved = expandNames(requestedNames(args), catalog);
  const content = proxied
    ? proxyLoadResult(resolved, catalog, definedAs(definitions, resolved.matched), loaded)
    : loadResult(resolved, catalog, loaded);
  // Proxied, a load is only of what the result could define: a catalogued name the host
  // gave no definition for was not loaded, and is not counted or remembered as though it was.
  const hits = proxied ? resolved.matched.filter((hit) => definitions.has(hit)) : resolved.matched;
  const counts: LoadCounts = { toolsLoaded: 0, redundantLoads: 0, unknownToolNames: resolved.unknown.length };
  for (const hit of hits) {
    counts[loaded.has(hit) ? 'redundantLoads' : 'toolsLoaded']++;
  }
  addLoads(run.loads, counts);
  for (const hit of hits) {
    loaded.add(hit);
  }
  return { content, ok: hits.length > 0, counts };
}

/**
 * Makes a call at most once per key, sharing the in-flight promise so two identical calls in one
 * step make one request between them whether they run together or one after the other.
 *
 * @typeParam T - What a call answers with.
 * @param answered - The step's calls so far, by key. Written to.
 * @param key - What makes two calls the same one.
 * @param make - Makes the call. Not called where the key has an answer, or one on its way.
 * @returns The answer, which for a repeat is the first call's. Rejects with what the call did, for
 * every caller waiting on it.
 *
 * @remarks
 * A call that rejected is forgotten, so asking again is a real retry rather than a replayed
 * failure.
 */
async function once<T>(answered: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
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
 * Tells watchers of artifacts the run had not produced before.
 *
 * @param run - The run, whose watchers hear of them.
 * @param added - The new artifacts, each told once.
 */
function announceArtifacts(run: Calling, added: RunArtifact[]) {
  for (const { link, callId, tool } of added) {
    run.onEvent({ kind: RunEventKind.Artifact, id: callId, name: tool, text: link.title || link.uri, link });
  }
}

/**
 * Adds what one successful call produced to the run's artifacts: its links, and — where the run
 * collects them — what it was given and answered, and the write it reads as.
 *
 * @param run - The run. Written to: its `artifacts`.
 * @param request - The call, under the tool it was shown as.
 * @param content - What it answered.
 * @param links - What its answer linked to.
 * @param from - The call, as an artifact is put down to it.
 */
function collect(run: Calling, request: ToolCallRequest, content: string, links: ResourceLink[], from: ArtifactFrom) {
  announceArtifacts(run, run.artifacts.link(links, from));
  if (run.declares) {
    run.artifacts.witness(request.args, content, links, from);
  }
  const draft = run.detects?.(request) ? detectArtifact(request.name, request.args) : null;
  const added = draft ? run.artifacts.add(draft, from) : undefined;
  announceArtifacts(run, added ? [added] : []);
}

/**
 * Answers a `record_artifact`, keeping the declaration where some call in the run touched the
 * location.
 *
 * @param run - The run. Written to: its `artifacts`, where the declaration is believed.
 * @param args - The call's arguments.
 * @returns What the model reads. Throws, which the model reads instead, for a declaration with no
 * location or one no call in the run was given or answered with.
 */
function answerRecord(run: Calling, args: Record<string, unknown>): string {
  const draft = declaredArtifact(args);
  if (draft === null) {
    throw new Error(`${RECORD_ARTIFACT} needs a location.`);
  }
  const from = run.artifacts.seen(draft.location);
  if (from === undefined) {
    throw new Error(
      `No tool call in this run touched ${draft.location}, so it was not recorded. ` +
        'Record only what one of your tools stored, after the call that stored it.',
    );
  }
  const added = run.artifacts.add(draft, from);
  announceArtifacts(run, added ? [added] : []);
  return `Recorded ${draft.location}.`;
}

/** One call made ready to run: what a host is told of it, and what `dispatch` would be handed. */
interface Prepared {
  entry: ReadCall;
  request: ToolCallRequest;
  /** Whether the call is a `load_tools` the loop answers itself. */
  load: boolean;
  /** Whether the call is a `record_artifact` the loop answers itself. */
  record: boolean;
  /** Why a `call_tool` was refused before it was dispatched, which is then its answer. */
  refused?: { error: unknown };
  /** Whether an identical repeat of it is answered from the first, as `dedupeToolCalls` said. */
  dedupable: boolean;
  /** What makes two calls of a step the same one. */
  key: string;
  /** Whether it may run beside other calls, once decided: a barrier ends one batch and opens the next. */
  passed?: boolean;
}

/**
 * A call looked through and built into the request every host callback is handed.
 *
 * @param run - The run the call belongs to. Read, never written to.
 * @param entry - The call, with its arguments read.
 * @returns The call, its request, and whether the loop answers it itself or may answer it from
 * an identical call. `dedupeToolCalls` is asked only of a call that would reach `dispatch`.
 */
function prepare(run: Calling, entry: ReadCall): Prepared {
  const { catalog, onDemand } = run;
  const { call, args, normal } = entry;
  const proxy = run.proxies && call.function.name === CALL_TOOL;
  const { name, input: raw } = shownAs(run, entry);
  // Looked through before the call is announced, so a host is told of the tool it names with
  // that tool's arguments. A name outside the catalogue is refused here, so `call_tool` reaches
  // nothing a load could not, and the refusal is the call's answer.
  let inner = args ?? {};
  let refused: { error: unknown } | undefined;
  if (proxy && args && run.hostNames.has(name)) {
    // Declared already, so the model is pointed at the call it can make rather than told the
    // tool does not exist.
    refused = { error: new Error(`${name} is not in the catalogue; call it directly, not through ${CALL_TOOL}.`) };
  } else if (proxy && args) {
    try {
      inner = proxiedCall(args, catalog).input;
    } catch (error) {
      inner = {};
      refused = { error };
    }
  }
  // Built for every call rather than only the dispatched ones, so a host hears of the calls
  // the loop answers itself in the same shape. Arguments that could not be read are none.
  const request: ToolCallRequest = { id: call.id, name, args: inner, raw, repaired: entry.repaired };
  // By the name the model called, not the one a `call_tool` wraps: `load_tools` is not in
  // the catalogue, and one reached through `call_tool` is refused like any other.
  const load = onDemand && call.function.name === LOAD_TOOLS;
  const record = run.declares && call.function.name === RECORD_ARTIFACT;
  const dispatched = args !== undefined && load === false && record === false && refused === undefined;
  // Keyed on the inner call, so one made through `call_tool` and one made natively share.
  const key = `${name}\0${proxy ? JSON.stringify(inner) : normal}`;
  return { entry, request, load, record, refused, dedupable: dispatched && run.dedupable(request), key };
}

/**
 * Whether a call is answered without `dispatch` seeing it, so it can run beside anything.
 *
 * @param prepared - The call.
 * @param answered - The step's calls already made, by key. A call that threw is not in it.
 * @param batch - The keys of the calls in the batch being gathered, which a repeat shares.
 * @returns True for a `load_tools`, a `record_artifact`, a call whose arguments could not be read,
 * a `call_tool` that was refused, and an identical repeat that `dedupeToolCalls` answers from the
 * first.
 */
const answersItself = (
  { entry, load, record, refused, dedupable, key }: Prepared,
  answered: ReadonlyMap<string, unknown>,
  batch: ReadonlySet<string>,
) =>
  entry.args === undefined ||
  load ||
  record ||
  refused !== undefined ||
  (dedupable && (answered.has(key) || batch.has(key)));

/**
 * Where the batch of calls starting at `from` ends: every call, one call, or the calls up to the
 * first one the host's predicate does not pass.
 *
 * @param run - The run, read for `parallel`.
 * @param ready - The step's calls by position, prepared as they are first asked for.
 * @param from - Where the batch starts.
 * @param total - How many calls the step has.
 * @param answered - The step's calls already made, by key.
 * @returns The position after the batch's last call; always past `from`.
 *
 * @remarks
 * A call the predicate fails is a barrier: it waits for every call before it, and runs alone, so
 * a read asked for after a write sees what the write did. Calls the loop answers itself are not
 * put to the predicate — they touch nothing a tool could — and count as reads.
 */
function batchEnd(
  run: Calling,
  ready: (at: number) => Prepared,
  from: number,
  total: number,
  answered: ReadonlyMap<string, unknown>,
): number {
  const { parallel } = run;
  if (parallel === true) {
    return total;
  }
  if (parallel === false) {
    return from + 1;
  }
  const batch = new Set<string>();
  for (let at = from; at < total; at++) {
    const prepared = ready(at);
    prepared.passed ??= answersItself(prepared, answered, batch) || parallel(prepared.request);
    const reads = prepared.passed;
    if (reads === false) {
      return at === from ? at + 1 : at;
    }
    if (prepared.dedupable) {
      batch.add(prepared.key);
    }
  }
  return total;
}

/** One call run: the result the host is handed, and whether its answer ends the run. */
interface Ran {
  result: ToolCallResult;
  end: Ending;
}

/**
 * Runs one call to its result, telling the host of both. A tool that throws is that call's answer
 * rather than the run's end, unless the run was stopped.
 *
 * @param run - The run the call belongs to.
 * @param prepared - The call, with its request built.
 * @param answered - The step's calls already made, by tool and arguments, for `dedupeToolCalls`.
 * @param step - Which step this is, for the artifacts the call's links become.
 * @returns The result — the call's id, the name it was shown under, whether it worked, the whole
 * of what the model reads, and the links its answer carried, where it carried any — and whether
 * the answer ended the run. Rejects where the run was stopped or a host callback threw.
 */
async function runCall(
  run: Calling,
  prepared: Prepared,
  answered: Map<string, Promise<string | ToolAnswer>>,
  step: number,
): Promise<Ran> {
  const { catalog, onDemand, proxied, signal } = run;
  const { entry, request, load, record, refused, dedupable, key } = prepared;
  const { call, args, error: unreadable } = entry;
  const { name, raw } = request;
  run.onEvent({ kind: RunEventKind.ToolCall, id: call.id, name, text: preview(raw) });
  run.onToolCall?.(request);
  const { report, close } = reportFor(run, call.id, name);
  let content: string;
  let links: ResourceLink[] = [];
  let end: Ending = false;
  let ok = true;
  let loads: LoadCounts | undefined;
  // Answered from an earlier identical call of the step, whose links are already counted.
  let shared = false;
  try {
    if (!args) {
      throw unreadable;
    }
    if (load) {
      ({ content, ok, counts: loads } = answerLoad(run, args));
    } else if (record) {
      content = answerRecord(run, args);
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
      // Read before `once` looks, which it does before it awaits anything.
      shared = dedupable && answered.has(key);
      // A repeat answered from the first call reports nothing of its own: the first call's
      // report is the one its dispatcher holds.
      const answer = dedupable
        ? await once(answered, key, () => run.dispatch(request, signal, report))
        : await run.dispatch(request, signal, report);
      ({ text: content, links, end } = answerOf(answer));
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    content = errorMessage(error);
    ok = false;
  } finally {
    close();
  }
  run.onEvent({
    kind: RunEventKind.ToolResult,
    id: call.id,
    name,
    ok,
    text: preview(content),
    ...(loads ? { loads } : {}),
  });
  // Only what `dispatch` answered made anything, and a repeat made nothing the first did not.
  const isMade = ok && load === false && record === false && shared === false;
  if (isMade) {
    collect(run, request, content, links, { callId: call.id, tool: name, step });
  }
  const result: ToolCallResult = { id: call.id, name, ok, content, ...(links.length ? { links } : {}) };
  run.onToolResult?.(result);
  return { result, end };
}

/**
 * Runs a step's calls and writes each result into the transcript, in the order asked.
 *
 * @param run - The run the step belongs to.
 * @param parsed - The step's calls, with their arguments read.
 * @param messages - The transcript the results are written into.
 * @param step - Which step this is, for the host told of each result.
 * @returns The first call, in the order asked, whose answer ended the run, or `undefined` where
 * none did.
 *
 * @remarks
 * A failure part-way leaves the transcript well-formed before it is rethrown: a call with no
 * result is a transcript no endpoint takes back, so every call of the step is answered — with what
 * it returned where it had, and otherwise with a line saying it was stopped, or never run.
 *
 * An answer that ends the run does not end the step. The calls after it still run, in whatever
 * batch `parallel` puts them, because the model asked for them in the same breath and how a host
 * schedules calls is not what they mean: a reply that says "write the file, then hand off" in one
 * turn wants the file written whichever order it named the two in, and a call batched beside the
 * end was running already. A tool that must have nothing after it says so in its description.
 */
export async function runCalls(
  run: Calling,
  parsed: ReadCall[],
  messages: OpenAI.ChatCompletionMessageParam[],
  step: number,
): Promise<EndedBy | undefined> {
  const { signal, toolCalls } = run;
  // Per step, not per run: the answer to a call made two steps ago was true before the tools in
  // between ran, and the file the model read may be the file it has since written.
  const answered = new Map<string, Promise<string | ToolAnswer>>();
  // By position, so a call that came back while another was being stopped is still found.
  const outcomes: (ToolCallResult | undefined)[] = parsed.map(() => undefined);
  const ends: Ending[] = parsed.map(() => false);
  // How many of the step's calls were handed off, and how many have their result in the
  // transcript. Both count from the front, since results are written in the order asked.
  let begun = 0;
  let kept = 0;
  const keep = async (id: string, content: string) => {
    const result: OpenAI.ChatCompletionToolMessageParam = {
      role: Role.Tool,
      tool_call_id: id,
      content,
    };
    messages.push(result);
    kept++;
    await run.announce(result, step);
  };
  // Prepared when first asked for, so a predicate is put only calls the step got to.
  const prepared: Prepared[] = [];
  const ready = (at: number) => {
    prepared[at] ??= prepare(run, parsed[at]);
    return prepared[at];
  };
  try {
    // One batch of every call, a batch per call, or batches split at the calls the host's
    // predicate does not pass; a batch's calls run together and the next waits for all of them.
    let from = 0;
    while (from < parsed.length) {
      signal?.throwIfAborted();
      const start = from;
      const to = batchEnd(run, ready, start, parsed.length, answered);
      begun = to;
      const runAt = async (at: number) => {
        const { result, end } = await runCall(run, ready(at), answered, step);
        outcomes[at] = result;
        ends[at] = end;
      };
      // A declaration describes what the batch beside it stored, so it waits for the rest of the
      // batch: run together, it would be checked before the write it names had answered.
      const positions = parsed.slice(start, to).map((_, offset) => start + offset);
      const isRecord = (at: number) => ready(at).record;
      await Promise.all(positions.filter((at) => isRecord(at) === false).map(runAt));
      await Promise.all(positions.filter(isRecord).map(runAt));
      for (const { id, name, ok, content } of outcomes.slice(from, to).flatMap((outcome) => outcome ?? [])) {
        toolCalls.push({ id, name, ok });
        await keep(id, content);
      }
      from = to;
    }
    // The first by position rather than by finishing: a batch's calls end in no order worth
    // reporting, and a deduplicated repeat shares its answer's `end` with the call before it.
    const at = ends.findIndex((end) => end !== false);
    const end = ends[at];
    const outcome = outcomes[at];
    if (end === undefined || end === false || outcome === undefined) {
      return undefined;
    }
    return { callId: outcome.id, name: outcome.name, ...(end.reason === undefined ? {} : { reason: end.reason }) };
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
  // Checked against the transcript, so two questions in one history do not share an id.
  const id = freshCallId(callIdsIn(messages), run.mintCallId);
  const args = JSON.stringify({ names });
  // Held to its own length rather than `MAX_PER_LOAD`: that cap is for a model choosing, and a
  // host that shortlisted more has already chosen.
  const content = proxyLoadResult(expandNames(names, catalog, names.length), catalog, shortlist);
  run.onEvent({ kind: RunEventKind.ToolCall, id, name: LOAD_TOOLS, text: preview(args) });
  run.onToolCall?.({ id, name: LOAD_TOOLS, args: { names }, raw: args, repaired: false });
  const loads: LoadCounts = { toolsLoaded: names.length, redundantLoads: 0, unknownToolNames: 0 };
  run.onEvent({ kind: RunEventKind.ToolResult, id, name: LOAD_TOOLS, ok: true, text: preview(content), loads });
  run.onToolResult?.({ id, name: LOAD_TOOLS, ok: true, content });
  run.toolCalls.push({ id, name: LOAD_TOOLS, ok: true });
  addLoads(run.loads, loads);
  for (const name of names) {
    run.loaded.add(name);
  }
  const exchange: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: Role.Assistant,
      content: null,
      tool_calls: [{ id, type: FUNCTION_TOOL, function: { name: LOAD_TOOLS, arguments: args } }],
    },
    { role: Role.Tool, tool_call_id: id, content },
  ];
  // Both written before either is announced, so a host that throws on the first leaves a call
  // with its result. Told as step zero's, with no turn: no request was made for them.
  messages.push(...exchange);
  for (const message of exchange) {
    await run.announce(message, 0);
  }
}
