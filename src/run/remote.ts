import type OpenAI from 'openai';
import { ToolDiscovery } from '../core/config.ts';
import { isRecord } from '../core/guards.ts';
import type { AgentLoopOptions } from './agent-loop.ts';
import { type RunEvent, type RunEventInput, RunEventKind } from './events.ts';

/**
 * Running against a remote agent: a model that runs a whole agent loop of its own behind the chat
 * completions API, and hands the host's tools back to it with `finish_reason: "tool_calls"`.
 *
 * Its steps happen on the server, so what they say comes back as the server's own run events,
 * carried beside the chunks under `PROGRESS_FIELD`. The encoder is for that server and the decoder
 * for `runAgentLoop`, so the wire shape lives with `RunEvent` and the two ends cannot drift.
 */

/**
 * The body field a remote agent's progress travels under: `{ progress: true }` on a request,
 * `{ event }` on a streamed chunk, and `{ runId, events }` on an answer that is not streamed.
 *
 * @remarks
 * ai-router's own name, because the request's other router fields (`task`, `servers`) live under it
 * too, and a second name for the answer's half would split one namespace in two. A standard
 * client skips it on the way in, and a server that refuses it on the way out has it dropped by name.
 */
export const PROGRESS_FIELD = 'ai_router' as const;

/** The header that makes a resent request the same request: one key per turn, kept across its retries. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key' as const;

/** What a streamed chunk calls itself. */
const CHUNK_OBJECT = 'chat.completion.chunk' as const;

/** What a notice about the options a remote agent's run sets aside opens with, ahead of their names. */
export const REMOTE_AGENT_NOTICE = 'left to the remote agent, which runs its own: ' as const;

/** The kinds of event a remote agent's progress says of its steps, which the loop then does not say too. */
const SERVER_OWNED: ReadonlySet<string> = new Set([
  RunEventKind.Turn,
  RunEventKind.Thinking,
  RunEventKind.Output,
  RunEventKind.ToolCall,
  RunEventKind.ToolResult,
  RunEventKind.Usage,
]);

/** Every kind a `RunEvent` may be, for telling one off the wire from something else. */
const KINDS: ReadonlySet<string> = new Set(Object.values(RunEventKind));

/** A streamed chunk that carries one of a remote run's events: no choices, and the event beside them. */
export type ProgressChunk = OpenAI.ChatCompletionChunk & { [PROGRESS_FIELD]: { event: RunEvent } };

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
  const { kind, runId, seq, at, text, name, step, ok, usage, id } = value;
  return (
    typeof kind === 'string' &&
    KINDS.has(kind) &&
    typeof runId === 'string' &&
    Number.isInteger(seq) &&
    typeof at === 'number' &&
    typeof text === 'string' &&
    typeof name === 'string' &&
    typeof step === 'string' &&
    (ok === null || typeof ok === 'boolean') &&
    (usage === null || isRecord(usage)) &&
    (id === undefined || typeof id === 'string')
  );
}

/**
 * A run event as a progress chunk, for a server streaming a remote agent's run.
 *
 * @param event - The event, whole, under the server's run id and numbering.
 * @param head - The chunk's `id`, `created` and `model`, the same as the stream's other chunks.
 * @returns A new chunk with empty `choices`, the event under `PROGRESS_FIELD`.
 */
export function progressChunk(
  event: RunEvent,
  head: Pick<OpenAI.ChatCompletionChunk, 'id' | 'created' | 'model'>,
): ProgressChunk {
  return { ...head, object: CHUNK_OBJECT, choices: [], [PROGRESS_FIELD]: { event } };
}

/**
 * An answer that is not streamed, with a remote run's events beside its `choices`.
 *
 * @typeParam T - The completion's own type.
 * @param completion - The `chat.completion` body. Not written to.
 * @param runId - The server's run id.
 * @param events - What the run said, in order.
 * @returns A copy of `completion` with `{ runId, events }` under `PROGRESS_FIELD`.
 */
export function withProgress<T extends object>(
  completion: T,
  runId: string,
  events: readonly RunEvent[],
): T & { [PROGRESS_FIELD]: RunProgress } {
  return { ...completion, [PROGRESS_FIELD]: { runId, events: [...events] } };
}

/**
 * The run event a streamed chunk carries, where it carries one.
 *
 * @param chunk - One chunk of the stream, as parsed.
 * @returns The event as the server sent it — its `runId`, `seq` and `at` kept — or `undefined` for
 * a chunk with none, and for one whose event is malformed or of a kind this version does not know.
 */
export function progressEvent(chunk: unknown): RunEvent | undefined {
  const carried = isRecord(chunk) ? chunk[PROGRESS_FIELD] : undefined;
  const event = isRecord(carried) ? carried.event : undefined;
  return isRunEvent(event) ? event : undefined;
}

/**
 * The run id and events an answer that is not streamed carries, where it carries them.
 *
 * @param completion - The `chat.completion` body, as parsed.
 * @returns The run and its events, less any that are malformed or of an unknown kind; `undefined`
 * where the answer carries no run id or no list of events.
 */
export function progressEvents(completion: unknown): RunProgress | undefined {
  const carried = isRecord(completion) ? completion[PROGRESS_FIELD] : undefined;
  if (!isRecord(carried) || typeof carried.runId !== 'string' || !Array.isArray(carried.events)) {
    return undefined;
  }
  return { runId: carried.runId, events: carried.events.filter(isRunEvent) };
}

/**
 * A remote agent's `extraBody`, with its progress asked for under what the host wrote.
 *
 * @param [extraBody] - The host's. Not written to.
 * @returns A new body whose `PROGRESS_FIELD` object says `progress: true` unless the host's own says
 * otherwise, the host's other router fields kept.
 */
function askingProgress(extraBody: Record<string, unknown> = {}): Record<string, unknown> {
  const own = extraBody[PROGRESS_FIELD];
  return { ...extraBody, [PROGRESS_FIELD]: { progress: true, ...(isRecord(own) ? own : {}) } };
}

/** What a run on a remote agent adds to each step of `runAgentLoop`. */
export interface RemoteRun {
  /** The config's `extraBody` with progress asked for, unless the host turned it off. */
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
 * The parts of a run that differ against a remote agent: progress asked for and forwarded, the
 * loop's own step events left to the server, and a key per turn.
 *
 * @param extraBody - The config's `extraBody`. Not written to.
 * @param told - Hears every event the run emits, the server's and the loop's.
 * @param [newKey] - Makes a turn's idempotency key.
 * @returns The run's remote half.
 *
 * @remarks
 * With progress on, the server says each step's `turn`, `thinking`, `output`, `tool-call`,
 * `tool-result` and `usage`, its handed-back calls included, so the loop says none of those itself.
 * The server's `done` is not forwarded: the loop's run goes on past a remote stretch, and its end is
 * the host's to say. With progress off, the loop's own events are all there is, and all are said.
 */
export function remoteRun(
  extraBody: Record<string, unknown> | undefined,
  told: (event: RunEventInput | RunEvent) => void,
  newKey: () => string = () => globalThis.crypto.randomUUID(),
): RemoteRun {
  const asked = askingProgress(extraBody);
  const options = asked[PROGRESS_FIELD];
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
      const event = progressEvent(chunk);
      if (!event) {
        return;
      }
      runId = event.runId;
      if (event.kind !== RunEventKind.Done) {
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
 * @param [remote] - The run's remote half. Absent on a model that is not a remote agent.
 * @returns `{ remoteRunId }` once an event has named the run, and otherwise nothing.
 */
export function remoteRunOf(remote?: RemoteRun): { remoteRunId?: string } {
  const remoteRunId = remote?.runId();
  return remoteRunId === undefined ? {} : { remoteRunId };
}

/**
 * A run's options with what a remote agent does for itself set aside, where the config says it is one.
 *
 * @param options - What `runAgentLoop` was given. Not written to.
 * @returns `options` itself without `config.remoteAgent`, and otherwise a copy that loads tools
 * eagerly and does not compact, prune, preselect, continue, recover calls from text or size requests
 * against `contextLength`. One notice names whichever of those the host had asked for.
 *
 * @remarks
 * Ignored rather than refused: the flag comes from the model entry and the options from the host's
 * code, written once for every model, so a refusal would have every host branch on the flag. Each
 * is the server's to do, and on the client would break the run: a fold or prune rewrites the
 * transcript the server resumes by, `load_tools` hides the host's tools, and a preselection or a
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
