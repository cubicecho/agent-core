import type OpenAI from 'openai';
import { ToolDiscovery } from '../core/config.ts';
import { isRecord } from '../core/guards.ts';
import { CallIds } from '../wire/call-ids.ts';
import type { AgentLoopOptions } from './agent-loop.ts';
import { type RunEvent, type RunEventInput, RunEventKind } from './events.ts';

/**
 * Running against a remote agent: a model that runs a whole agent loop of its own behind the chat
 * completions API, and hands the app's tools back to it with `finish_reason: "tool_calls"`.
 *
 * Its turns happen on the server, so what they say comes back as the server's own run events,
 * carried beside the chunks under a field of their own, `PROGRESS_FIELD` unless the app names
 * another. The encoder is for that server and the decoder for `runAgentLoop`, so the wire shape
 * lives with `RunEvent` and the two ends cannot drift.
 */

/**
 * The body field a remote agent's progress travels under where the app names no other:
 * `{ progress: true }` on a request, `{ event }` on a streamed chunk, and `{ runId, events }` on
 * an answer that is not streamed.
 *
 * @remarks
 * ai-router's own name, because the request's other router fields (`task`, `servers`) live under it
 * too, and a second name for the answer's half would split one namespace in two. Another server
 * names its own: `RemoteAgentParams.progressField` for the loop, and the last argument of each
 * encoder and decoder here. A standard client skips it on the way in, and a server that refuses it
 * on the way out has it dropped by name.
 */
export const PROGRESS_FIELD = 'ai_router' as const;

/** The header that makes a resent request the same request: one key per turn, kept across its retries. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key' as const;

/** What a streamed chunk calls itself. */
const CHUNK_OBJECT = 'chat.completion.chunk' as const;

/** What a notice about the options an exchange with a remote agent sets aside opens with, ahead of their names. */
export const REMOTE_AGENT_NOTICE = 'left to the remote agent, which runs its own: ' as const;

/** The kinds of event a remote agent's progress says of its turns, which the loop then does not say too. */
const SERVER_OWNED: ReadonlySet<string> = new Set([
  RunEventKind.Turn,
  RunEventKind.Thinking,
  RunEventKind.Output,
  RunEventKind.ToolCall,
  RunEventKind.ToolResult,
  RunEventKind.Usage,
]);

/**
 * The kinds of event a remote agent's progress says of its own run and exchange, which are not
 * forwarded: the loop's own start and end describe the app's exchange, and the run's end is the app's.
 */
const UNFORWARDED: ReadonlySet<string> = new Set([RunEventKind.Exchange, RunEventKind.ExchangeEnd, RunEventKind.Done]);

/** Every kind a `RunEvent` may be, for telling one off the wire from something else. */
const KINDS: ReadonlySet<string> = new Set(Object.values(RunEventKind));

/**
 * A streamed chunk that carries one of a remote run's events: no choices, and the event beside them.
 *
 * @typeParam F - The field the event is under.
 */
export type ProgressChunk<F extends string = typeof PROGRESS_FIELD> = OpenAI.ChatCompletionChunk & {
  [K in F]: { event: RunEvent };
};

/** What an answer that is not streamed carries beside `choices`: the run, and what it said. */
export interface RunProgress {
  /** The remote agent's own run id. */
  runId: string;
  /** Its events in order, numbered by the server. */
  events: RunEvent[];
}

/**
 * Whether a value off the wire is a whole run event, as `stamp` makes one.
 *
 * @param value - Anything, usually just parsed.
 * @returns True of an object with a known `kind`, a `runId`, a whole `seq`, an `at`, and every other
 * always-present field of the right kind. `usage` is checked only for being an object or `null`.
 */
function isRunEvent(value: unknown): value is RunEvent {
  if (!isRecord(value)) {
    return false;
  }
  const { kind, runId, seq, at, text, name, exchange, ok, usage, id } = value;
  const isKnown = typeof kind === 'string' && KINDS.has(kind);
  return (
    isKnown &&
    typeof exchange === 'string' &&
    typeof runId === 'string' &&
    Number.isInteger(seq) &&
    typeof at === 'number' &&
    typeof text === 'string' &&
    typeof name === 'string' &&
    (ok === null || typeof ok === 'boolean') &&
    (usage === null || isRecord(usage)) &&
    (id === undefined || typeof id === 'string')
  );
}

/**
 * A run event as a progress chunk, for a server streaming a remote agent's run.
 *
 * @typeParam F - The field the event goes under.
 * @param event - The event, whole, under the server's run id and numbering.
 * @param head - The chunk's `id`, `created` and `model`, the same as the stream's other chunks.
 * @param [field] - The field the event goes under.
 * @returns A new chunk with empty `choices`, the event under `field`.
 */
export function progressChunk<F extends string = typeof PROGRESS_FIELD>(
  event: RunEvent,
  head: Pick<OpenAI.ChatCompletionChunk, 'id' | 'created' | 'model'>,
  field: F = PROGRESS_FIELD as F,
): ProgressChunk<F> {
  const chunk: OpenAI.ChatCompletionChunk = { ...head, object: CHUNK_OBJECT, choices: [] };
  return Object.assign(chunk, { [field]: { event } }) as ProgressChunk<F>;
}

/**
 * An answer that is not streamed, with a remote run's events beside its `choices`.
 *
 * @typeParam T - The completion's own type.
 * @typeParam F - The field the run goes under.
 * @param completion - The `chat.completion` body. Not written to.
 * @param runId - The server's run id.
 * @param events - What the run said, in order.
 * @param [field] - The field the run goes under.
 * @returns A copy of `completion` with `{ runId, events }` under `field`.
 */
export function withProgress<T extends object, F extends string = typeof PROGRESS_FIELD>(
  completion: T,
  runId: string,
  events: readonly RunEvent[],
  field: F = PROGRESS_FIELD as F,
): T & { [K in F]: RunProgress } {
  const progress: RunProgress = { runId, events: [...events] };
  return { ...completion, [field]: progress } as T & { [K in F]: RunProgress };
}

/**
 * The run event a streamed chunk carries, where it carries one.
 *
 * @param chunk - One chunk of the stream, as parsed.
 * @param [field] - The field the event is under.
 * @returns The event as the server sent it, its `runId`, `seq` and `at` kept, or `undefined` for a
 * chunk with none, and for one whose event is malformed or of a kind this version does not know.
 */
export function progressEvent(chunk: unknown, field: string = PROGRESS_FIELD): RunEvent | undefined {
  const carried = isRecord(chunk) ? chunk[field] : undefined;
  const event = isRecord(carried) ? carried.event : undefined;
  return isRunEvent(event) ? event : undefined;
}

/**
 * The run id and events an answer that is not streamed carries, where it carries them.
 *
 * @param completion - The `chat.completion` body, as parsed.
 * @param [field] - The field the run is under.
 * @returns The run and its events, less any that are malformed or of an unknown kind; `undefined`
 * where the answer carries no run id or no list of events.
 */
export function progressEvents(completion: unknown, field: string = PROGRESS_FIELD): RunProgress | undefined {
  const carried = isRecord(completion) ? completion[field] : undefined;
  if (!isRecord(carried) || typeof carried.runId !== 'string' || !Array.isArray(carried.events)) {
    return undefined;
  }
  return { runId: carried.runId, events: carried.events.filter(isRunEvent) };
}

/**
 * A remote agent's `extraBody`, with its progress asked for under what the app wrote.
 *
 * @param extraBody - The app's. Not written to.
 * @param field - The field progress is asked for under.
 * @returns A new body whose `field` object says `progress: true` unless the app's own says
 * otherwise, the app's other router fields kept.
 */
function askingProgress(extraBody: Record<string, unknown>, field: string): Record<string, unknown> {
  const own = extraBody[field];
  return { ...extraBody, [field]: { progress: true, ...(isRecord(own) ? own : {}) } };
}

/** How `remoteRun` reads and asks for the server's progress. */
interface RemoteRunOptions {
  /**
   * The field the server's progress travels under.
   *
   * @defaultValue `PROGRESS_FIELD`
   */
  field?: string;
  /**
   * Makes a turn's idempotency key.
   *
   * @defaultValue `crypto.randomUUID`
   */
  newKey?: () => string;
}

/** What an exchange with a remote agent adds to each turn of `runAgentLoop`. */
interface RemoteRun {
  /** The config's `extraBody` with progress asked for, unless the app turned it off. */
  extraBody: Record<string, unknown>;
  /** The loop's own events: those the server's progress already says are left out. */
  emit: (input: RunEventInput) => void;
  /** Reads a chunk for the server's event, and forwards it. */
  onChunk: (chunk: OpenAI.ChatCompletionChunk) => void;
  /** One turn's headers: a fresh `IDEMPOTENCY_HEADER`, which its retries send again. */
  turnHeaders: () => Record<string, string>;
  /** The server's run id, once an event has named it. */
  runId: () => string | undefined;
}

/**
 * The parts of an exchange that differ against a remote agent: progress asked for and forwarded,
 * the loop's own turn events left to the server, and a key per turn.
 *
 * @param extraBody - The config's `extraBody`. Not written to.
 * @param told - Hears every event the exchange emits, the server's and the loop's.
 * @param [options] - The progress field, and where keys come from.
 * @returns The exchange's remote half.
 *
 * @remarks
 * With progress on, the server says the `turn`, `thinking`, `output`, `tool-call`, `tool-result`
 * and `usage` of each of its turns, its handed-back calls included, so the loop says none of those
 * itself. The server's `exchange`, `exchange-end` and `done` are not forwarded: the loop's own start
 * and end say the app's exchange, and the run's end is the app's to say. With progress off, the
 * loop's own events are all there is, and all are said.
 */
export function remoteRun(
  extraBody: Record<string, unknown> | undefined,
  told: (event: RunEventInput | RunEvent) => void,
  { field = PROGRESS_FIELD, newKey = () => globalThis.crypto.randomUUID() }: RemoteRunOptions = {},
): RemoteRun {
  const asked = askingProgress(extraBody ?? {}, field);
  const options = asked[field];
  const isForwarding = isRecord(options) && options.progress === true;
  let runId: string | undefined;
  return {
    extraBody: asked,
    emit: (input) => {
      const isServerOwned = isForwarding && SERVER_OWNED.has(input.kind);
      if (isServerOwned === false) {
        told(input);
      }
    },
    onChunk: (chunk) => {
      const event = progressEvent(chunk, field);
      if (!event) {
        return;
      }
      runId = event.runId;
      const isForwarded = UNFORWARDED.has(event.kind) === false;
      if (isForwarded) {
        told(event);
      }
    },
    turnHeaders: () => ({ [IDEMPOTENCY_HEADER]: newKey() }),
    runId: () => runId,
  };
}

/**
 * A remote run's id, to spread into what the loop hands back.
 *
 * @param [remote] - The exchange's remote half. Absent on a model that is not a remote agent.
 * @returns `{ remoteRunId }` once an event has named the run, and otherwise nothing.
 */
export function remoteRunOf(remote?: RemoteRun): { remoteRunId?: string } {
  const remoteRunId = remote?.runId();
  return remoteRunId === undefined ? {} : { remoteRunId };
}

/**
 * An exchange's options with what a remote agent does for itself set aside, where the config says it is one.
 *
 * @param options - What `runAgentLoop` was given. Not written to.
 * @returns `options` itself without `config.remoteAgent`, and otherwise a copy that loads tools
 * eagerly and does not compact, prune, preselect, continue, recover calls from text, mint call ids
 * or size requests against `contextLength`. One notice names whichever of those the app had asked
 * for.
 *
 * @remarks
 * Ignored rather than refused: the flag comes from the model entry and the options from the app's
 * code, written once for every model, so a refusal would have every app branch on the flag. Each
 * is the server's to do, and on the client would break the exchange: a compaction or prune rewrites
 * the transcript the server resumes by, `load_tools` hides the app's tools, and a preselection or a
 * continuation is one more remote run.
 */
export function asRemoteAgent(options: AgentLoopOptions): AgentLoopOptions {
  const { config } = options;
  if (config.remoteAgent !== true) {
    return options;
  }
  const discovery = config.toolDiscovery ?? ToolDiscovery.Eager;
  const isOnDemand = discovery !== ToolDiscovery.Eager && (options.catalog?.length ?? 0) > 0;
  const asked = [
    options.compact ? 'compact' : '',
    options.prune ? 'prune' : '',
    options.preselect ? 'preselect' : '',
    isOnDemand ? `toolDiscovery "${discovery}"` : '',
    (options.maxContinuations ?? 0) > 0 ? 'maxContinuations' : '',
    options.recoverToolCalls === true ? 'recoverToolCalls' : '',
    options.callIds === CallIds.Minted ? `callIds "${CallIds.Minted}"` : '',
  ].filter((name) => name !== '');
  if (asked.length > 0) {
    options.onEvent?.({ kind: RunEventKind.Notice, text: `${REMOTE_AGENT_NOTICE}${asked.join(', ')}` });
  }
  return {
    ...options,
    config: { ...config, toolDiscovery: ToolDiscovery.Eager, contextLength: 0 },
    compact: false,
    prune: false,
    preselect: false,
    maxContinuations: 0,
    recoverToolCalls: false,
  };
}
