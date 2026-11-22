import type { TokenLedger } from '../context/ledger.ts';
import { EVENT_BUS_DEFAULTS, type EventBusSettings } from '../core/defaults.ts';
import { getOrCreate } from '../core/guards.ts';
import { ABORT_EVENT } from '../core/platform.ts';
import { assignSettings, scoped } from '../core/scope.ts';
import { LOAD_TOOLS } from '../tools/tool-loading.ts';
import type { TurnUsage } from '../wire/stream.ts';
import { CacheBreakReason } from '../wire/stream.ts';
import { FinishReason } from '../wire/wire.ts';
import { type ResourceLink, ServerLogLevel } from './dispatch.ts';

/**
 * What a run is doing, while it is doing it.
 *
 * A run row only exists as a before and an after: it is written when the agent starts and
 * updated when it stops, and everything in between — the scratchpad, the tool the model reached
 * for, the argument it got wrong — is gone by the time anyone can read it. This is that middle,
 * kept in memory and handed to whoever is watching.
 *
 * In memory on purpose: it is debugging output, worth nothing once the run has finished and its
 * outcome is in the database. Nothing here survives a restart, and nothing here is the record.
 */

/**
 * What the bus may be told to change, across a process: any of `EventBusSettings`, the rest left as
 * they are. See `configureEvents`.
 */
export type EventBusOptions = Partial<EventBusSettings>;

/**
 * One runtime's bus, held as a single object so a watcher and the sweep timer keep hold of the
 * bus they began on — a generator resumes in whatever context asks it for the next event, which
 * need not be the runtime that opened it.
 */
interface Bus {
  /** What is in force now. Read where it is used, so a change applies from the next event. */
  limits: EventBusSettings;
  streams: Map<string, Stream>;
  /** The pending sweep, see `sweep`. */
  sweeping: ReturnType<typeof setTimeout> | null;
}

const bus = scoped((): Bus => ({ limits: { ...EVENT_BUS_DEFAULTS }, streams: new Map(), sweeping: null }));

/**
 * Changes what the bus keeps, for a process whose runs are not shaped like the ones these
 * defaults were chosen for.
 *
 * @param [options] - The bounds to change. A field left out — or given anything that is not a
 * number above zero — keeps what it has, so a partial or a half-built config narrows nothing.
 * @returns Everything in force afterwards, including what this call did not change.
 *
 * @remarks
 * The bus is one thing per runtime rather than an object a caller holds, so this is too: it is
 * a deployment's setting, said once at startup, and not something to move around under a run.
 * Called at the top level that is the process's bus; a runtime made by `createRuntime` has its
 * own, set through its options or its own `configureEvents`.
 * What it costs is memory against how much of a run a late or slow watcher can still read —
 * a server with hundreds of concurrent runs wants a smaller backlog, and one whose tool calls
 * take an hour wants a longer `retainUnendedMs` than the `EVENT_BUS_DEFAULTS` one.
 *
 * Changes apply from the next event and the next sweep. Nothing already buffered is trimmed to
 * a cap that has just come down, because the trim happens on push; the backlog settles to the
 * new number as the run goes on.
 */
export function configureEvents(options: EventBusOptions = {}): EventBusSettings {
  return assignSettings(bus().limits, options);
}

/** Which kind of thing happened, and what `text`, `name`, `ok` and `usage` carry for it. */
export const RunEventKind = {
  /**
   * An exchange began. `runAgentLoop` sends one first, `name` its `exchange` option; an app may
   * send its own too, `text` its kind.
   */
  Exchange: 'exchange',
  /** A deciding exchange chose an arm. `text` is the arm it took. */
  Decision: 'decision',
  /** A new turn of the agent loop began, inside whichever exchange is running. */
  Turn: 'turn',
  /** Scratchpad tokens, as they arrive. */
  Thinking: 'thinking',
  /** Reply tokens, as they arrive. */
  Output: 'output',
  /** The model asked for a tool, with the arguments it chose. `id` is the call's. */
  ToolCall: 'tool-call',
  /** A tool came back, with what it said. `id` is the id of the call it answers. */
  ToolResult: 'tool-result',
  /** Something the runner did that is not the model's doing — a preselection, a retry. */
  Notice: 'notice',
  /**
   * Input the app's `takeInput` handed over mid-exchange, now in the transcript. `text` is what
   * it says.
   */
  Input: 'input',
  /**
   * A tool call's answer linked to something the exchange had not produced before — or, where the
   * exchange collects them, a write was detected or a declaration believed at a new location. `id`
   * is the call's the artifact is put down to, `name` its tool, `text` the link's title or else its
   * uri, and `link` the link itself. Once per location per exchange: a later call that links or
   * writes it again only adds to its count, and a declaration over it only fills it in.
   */
  Artifact: 'artifact',
  /**
   * A tool's server logged something while a call was running, which the dispatcher passed on
   * through `report.log`. `id` is the call's, `name` the tool, `level` the server's, and `text`
   * the message's data — as it was where a string, as JSON otherwise — cut by `preview`. Never in
   * the transcript, and never from a call the loop answers itself.
   */
  ServerLog: 'server-log',
  /**
   * What the exchange has cost so far, at the end of every turn, and what that one turn did. Sent
   * whether or not the model server reported tokens, since the timings and the cache comparison are
   * measured either way.
   */
  Usage: 'usage',
  /**
   * The exchange stopped to wait for the app to answer calls it handed back: the turn's `tool-call`
   * events with no `tool-result`, as `AgentLoopResult.pending` lists them. `text` says how many.
   *
   * @remarks
   * The exchange's `exchange-end` follows it, outcome `waiting`. The run's is not an end: it goes
   * on, under the same id, once they are answered, and the bus keeps it on `retainWaitingMs`.
   */
  Wait: 'wait',
  /**
   * An exchange ended, last of its events, whether it returned or threw. `outcome` says how; on
   * `ended`, `id`, `name` and `text` are the call, its tool and the reason, and on `waiting`,
   * `pending` the handed-back calls' ids. `text` is the error's message on `failed` or `stopped`,
   * and `ok` is false on those two alone.
   */
  ExchangeEnd: 'exchange-end',
  /**
   * The run ended, as the app announces it: `runAgentLoop` never sends it, and `endRun` sends one
   * only to a run still watched. Last where it is sent. `ok` false is a run that failed.
   */
  Done: 'done',
} as const;

/** Any one of the kinds in `RunEventKind`. */
export type RunEventKind = (typeof RunEventKind)[keyof typeof RunEventKind];

/**
 * What an exchange has spent, counted from the start of the exchange rather than for the turn that
 * carried it: a client draws the latest one it has seen and needs no arithmetic of its own,
 * and one lost to the backlog cap costs nothing because the next supersedes it.
 *
 * @remarks
 * The counts are `UsageTotals`, the spelling `AgentLoopResult.usage` shares, with the cache's two
 * fields optional so an app emitting usage of its own need not know them.
 */
export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * How much of `promptTokens` the model server served from its prompt cache. Optional so a caller
   * emitting usage before this field existed still compiles; absent reads the same as zero.
   */
  cachedTokens?: number;
  /**
   * Whether any turn so far reported a cache count, as `UsageTotals.cacheReported` says it — so a
   * `cachedTokens` of zero reads as a miss or as nothing said. `runAgentLoop` always sets it;
   * optional for the reason `cachedTokens` is, and absent reads as not known.
   */
  cacheReported?: boolean;
  /**
   * The turn that carried this report, on its own rather than added in — the half `runMetrics`
   * reads, since a total says nothing about which turn was slow or where the cache broke. Absent
   * from a caller emitting usage of its own.
   */
  turn?: TurnReport;
  /**
   * The exchange's token ledger as of this turn, whole rather than the entry it added — an app
   * whose exchange then fails still holds the latest one, and a rewrite in `beforeTurn` moves
   * earlier entries. Absent from a caller emitting usage of its own.
   */
  ledger?: TokenLedger;
}

/** One turn's usage and measurements as a `usage` event carries them. */
export interface TurnReport extends TurnUsage {
  /** Why the model stopped, as `Turn.finishReason` says it; `length` is a reply cut short. */
  finishReason: string;
  /**
   * The context window the turn was served, where the loop was told one, for `largestPromptShare`.
   *
   * @remarks
   * On the turn rather than only in `runMetrics`' options, because a run of several exchanges can
   * put them on models with different context windows, and one context window for the whole run
   * misstates how close any of them came.
   */
  contextLength?: number;
}

/**
 * What `load_tools` calls resolved to: new tools, ones already loaded, and names in no catalogue.
 *
 * @remarks
 * Carried on each `load_tools` result as `loads`, so `runMetrics` over every exchange's events adds
 * them up without the exchanges' results beside it.
 */
export interface LoadCounts {
  /** Tools loaded that were not loaded already. */
  toolsLoaded: number;
  /** Tools asked for that were loaded already. */
  redundantLoads: number;
  /** Names asked for that are in no catalogue. */
  unknownToolNames: number;
}

/**
 * One step on the way from a run to an event that happened in a run inside it: the inner run, and
 * the call of the outer run it ran under.
 *
 * @remarks
 * A tool call can itself be an agent run, such as another agent called as an MCP task. A host that
 * shows that run's events inside its caller's stream republishes each with `nestEvent`, which says
 * where it came from here.
 */
export interface RunVia {
  /** The inner run the event came from. */
  runId: string;
  /** The id of the outer run's call that the inner run answers. */
  callId: string;
}

/**
 * One thing that happened in a run, as a watcher receives it.
 *
 * @remarks
 * Every field but `id`, `link`, `level`, `loads`, `outcome`, `pending` and `via` is always present —
 * the empty ones are `""` or `null` rather than missing — so a client reads it without guarding
 * each key. Those seven belong to a few kinds each, and are absent on the rest.
 */
export interface RunEvent {
  /** The run it belongs to. `emit` fills this in; a caller does not pass it. */
  runId: string;
  /** Per-run counter, from 1. Lets a client order and de-duplicate what it receives. */
  seq: number;
  /**
   * When it happened, as epoch milliseconds.
   *
   * @remarks
   * A number rather than a `Date`: these events are read over a wire, where a `Date` is an ISO
   * string by the time anyone sees it, and `emit` runs once per streamed token — so the object
   * it does not allocate is one per token. It also spares the `getTime()` the sweep used to do
   * to get this same number back out.
   */
  at: number;
  kind: RunEventKind;
  /** The delta, the arguments, the result, or the reason — whatever the kind carries. */
  text: string;
  /**
   * Tool name on the tool kinds, and on a `done` the tool that ended the exchange; otherwise empty.
   */
  name: string;
  /**
   * The call's id on the tool kinds, which pairs a `tool-result` with its `tool-call` when one
   * tool is called twice in a turn. The one field `emit` does not fill in: it is there only where
   * the emitter gave one, and optional so an event built before it existed still compiles.
   */
  id?: string;
  /**
   * Which exchange this belongs to: the app's own, such as a task's stage, so a watcher can group a
   * run the way the work is written. Empty for events that belong to the run rather than to any one
   * exchange, and empty throughout for an app that sends no `exchange` events.
   */
  exchange: string;
  /** Outcome on `tool-result`, `exchange-end` and `done`, otherwise null. */
  ok: boolean | null;
  /** Running totals on `usage`, otherwise null. */
  usage: RunUsage | null;
  /**
   * What the call produced, on `artifact` and on no other kind. Optional for the reason `id` is:
   * an event built before it existed still compiles.
   */
  link?: ResourceLink;
  /**
   * The level the server logged at, on `server-log` and on no other kind. Optional for the reason
   * `id` is.
   */
  level?: string;
  /**
   * What the call loaded, on a `load_tools` `tool-result` and on no other event. Absent from one
   * whose arguments did not parse, which loaded nothing. Optional for the reason `id` is.
   */
  loads?: LoadCounts;
  /** How the exchange ended, on `exchange-end` and on no other kind. Optional for the reason `id` is. */
  outcome?: ExchangeOutcome;
  /**
   * The ids of the calls handed back, on an `exchange-end` whose outcome is `waiting`, in the order
   * asked. Optional for the reason `id` is.
   */
  pending?: string[];
  /**
   * Where an event from a run inside this one came from, outermost first: the run that called it and
   * the call, then any run that run called in turn. Absent, or empty, on the run's own events. Optional
   * for the reason `id` is.
   *
   * @remarks
   * A nested event is shown, not acted on: its `done` does not end a watcher, its `wait` or `done`
   * does not move the run's retention, `fold` keeps its text apart, and `runMetrics` leaves it out.
   */
  via?: RunVia[];
}

/**
 * Whether an event came from a run inside the one it is filed under.
 *
 * @param event - The event.
 * @returns True where its `via` names at least one run.
 */
export const isNested = (event: Pick<RunEvent, 'via'>): boolean => (event.via?.length ?? 0) > 0;

/**
 * An inner run's event as its outer run republishes it, filed under the call it ran for.
 *
 * @param event - The inner run's event, whole. Not written to.
 * @param hop - The inner run and the outer run's call it answers.
 * @returns An input for `emit` (or `stamp`) on the outer run: the event less its `runId` and `seq`,
 * which are the outer run's to give, its `at` kept, and `hop` put ahead of whatever `via` it had.
 *
 * @remarks
 * The outer run numbers what it republishes in its own sequence, so a watcher still orders and
 * de-duplicates the stream on `seq` alone. Nesting more than one level is the same call at each
 * level: a run two calls down reaches the top with both hops, outermost first.
 */
export function nestEvent(event: RunEvent, hop: RunVia): RunEventInput {
  const { runId: _runId, seq: _seq, via = [], ...rest } = event;
  return { ...rest, via: [{ runId: hop.runId, callId: hop.callId }, ...via] };
}

/**
 * Whether two events came by the same way: both the run's own, or both through the same calls.
 *
 * @param a - One event.
 * @param b - The other.
 * @returns True where their `via`s name the same runs and calls in the same order.
 */
function sameVia(a: Pick<RunEvent, 'via'>, b: Pick<RunEvent, 'via'>): boolean {
  const left = a.via ?? [];
  const right = b.via ?? [];
  return (
    left.length === right.length &&
    left.every((hop, i) => hop.runId === right[i].runId && hop.callId === right[i].callId)
  );
}

/**
 * What `emit` is given: the run and the sequence are the bus's to assign.
 *
 * @remarks
 * Named exclusions rather than a blanket `Partial`, which permitted both and let the spread in
 * `emit` overwrite them — a caller could file an event under another run and hand every watcher
 * a duplicate `seq`, which is the one thing the sequence is for.
 */
export type RunEventInput = Pick<RunEvent, 'kind'> & Partial<Omit<RunEvent, 'kind' | 'runId' | 'seq'>>;

/**
 * A whole event from what a caller said of it: the empty defaults under it, the run and sequence over it.
 *
 * @param input - What happened. An `at` it carries wins over the one given here.
 * @param runId - The run it belongs to. Written after `input`, which gets no say in it.
 * @param seq - Its place in that run, the same.
 * @param at - When, for an input that does not say.
 * @returns A new event; `input` is not written to.
 *
 * @remarks
 * The one place the defaults are written, so an event the bus stamps, one the loop keeps for its
 * own metrics and the notice a slow watcher is sent cannot come to disagree about what an unset
 * field reads as. An app that numbers and stores a run's events itself, rather than on `emit`'s
 * in-memory bus, makes each one with this, so its events keep that shape as `RunEvent` grows.
 */
export const stamp = (input: RunEventInput, runId: string, seq: number, at: number): RunEvent => ({
  at,
  text: '',
  name: '',
  exchange: '',
  ok: null,
  usage: null,
  ...input,
  runId,
  seq,
});

/** Where a stream's run stands, as its events so far say, which sets how long the sweep keeps it. */
const StreamPhase = {
  /** Still writing, or gone quiet with no `done`. */
  Live: 'live',
  /** Its last event is `wait`: stopped until the calls it handed back are answered. */
  Waiting: 'waiting',
  /** `done` has been seen. Nothing after it changes that. */
  Ended: 'ended',
} as const;

/** Any one of the phases in `StreamPhase`. */
type StreamPhase = (typeof StreamPhase)[keyof typeof StreamPhase];

/** The setting that says how long an unwatched stream in each phase outlives its last event. */
const RETENTION_BY_PHASE = {
  [StreamPhase.Live]: 'retainUnendedMs',
  [StreamPhase.Waiting]: 'retainWaitingMs',
  [StreamPhase.Ended]: 'retainMs',
} as const satisfies Record<StreamPhase, keyof EventBusSettings>;

/**
 * The phase an event puts a run in that has not ended, for the kinds that move it off `live`.
 *
 * @remarks
 * A map rather than an object, so a kind a JavaScript caller made up, `constructor` say, is not
 * looked up on the prototype.
 */
const PHASE_BY_KIND: ReadonlyMap<string, StreamPhase> = new Map([
  [RunEventKind.Wait, StreamPhase.Waiting],
  [RunEventKind.Done, StreamPhase.Ended],
]);

interface Stream {
  events: RunEvent[];
  listeners: Set<(event: RunEvent) => void>;
  seq: number;
  /** When this stream last saw an event, for the sweep below. */
  touched: number;
  /** Where the run stands, so the sweep knows how long to keep it and a watcher leaving knows it is over. */
  phase: StreamPhase;
}

/**
 * A run's stream on a bus, begun empty where the run has none.
 *
 * @param held - The bus to look on. Gains an entry on a miss.
 * @param runId - The run whose stream is wanted.
 * @returns The stream the bus holds, not a copy — writing to it is writing to the run.
 */
const streamFor = ({ streams }: Bus, runId: string): Stream =>
  getOrCreate(streams, runId, () => ({
    events: [],
    listeners: new Set(),
    seq: 0,
    touched: Date.now(),
    phase: StreamPhase.Live,
  }));

/**
 * Drops the streams nobody is reading and nothing is writing to.
 *
 * @param held - The bus to sweep. Loses each unwatched stream untouched for its retention or
 * longer, and has its timer cleared and — while any stream is left — set again.
 *
 * @remarks
 * Cleanup used to hang entirely off `done`, which assumed every run reaches it. A run killed by
 * an uncaught throw, a signal, or a caller that simply forgets pinned its backlog for the life
 * of the process — and in a long-lived server that map only ever grew. The `done` timer had the
 * same shape of hole from the other end: if a watcher was still attached when it fired it
 * deleted nothing and nothing rescheduled it, so any client slow enough to still be reading a
 * minute after the end leaked the stream permanently.
 *
 * One timer for the whole map, rescheduled only while there is something in it to expire.
 */
function sweep(held: Bus) {
  const { limits, streams } = held;
  held.sweeping = null;
  const now = Date.now();
  for (const [runId, stream] of streams) {
    if (stream.listeners.size) {
      continue;
    }
    const isExpired = stream.touched <= now - limits[RETENTION_BY_PHASE[stream.phase]];
    if (isExpired) {
      streams.delete(runId);
    }
  }
  scheduleSweep(held);
}

/**
 * Arms a bus's one sweep timer, unless it is armed already or the bus holds no stream to expire.
 *
 * @param held - The bus. Its `sweeping` is set to a timer that fires after `retainMs` as it stands
 * now, and that does not keep the process alive.
 */
function scheduleSweep(held: Bus) {
  if (held.sweeping || held.streams.size === 0) {
    return;
  }
  held.sweeping = setTimeout(() => sweep(held), held.limits.retainMs);
  held.sweeping.unref?.();
}

/**
 * Forgets a run that will not be emitting `done` — one whose process is tearing down, or whose
 * loop threw where it could not be caught. The sweep gets there on its own; this is for a
 * caller that already knows.
 *
 * @param runId - The run to forget. An id nothing was emitted under is ignored.
 */
export function endRun(runId: string) {
  const { streams } = bus();
  const stream = streams.get(runId);
  if (!stream) {
    return;
  }
  // Watchers are parked on a promise only an `emit` to this stream resolves, and the delete puts it
  // beyond reach, so they are handed `done` first: one left parked is an SSE connection that never closes.
  if (stream.listeners.size) {
    emit(runId, { kind: RunEventKind.Done, ok: false, text: 'run ended' });
  }
  streams.delete(runId);
}

/**
 * Records one event and hands it to everyone watching that run. Never throws at the caller.
 *
 * @param runId - The run this belongs to. Created on first use.
 * @param input - The event. `kind` is required; `runId` and `seq` are not a caller's to set.
 * @returns The event as it was recorded: its `seq` in the run, its time, and every unset field
 * filled in.
 */
export function emit(runId: string, input: RunEventInput): RunEvent {
  const held = bus();
  const { limits } = held;
  const stream = streamFor(held, runId);
  // One clock read, used for both the event and the sweep's bookkeeping.
  const at = Date.now();
  const event = stamp(input, runId, ++stream.seq, at);
  stream.events.push(event);
  stream.touched = at;
  const isOverfull = stream.events.length > limits.maxEvents + limits.trimSlack;
  if (isOverfull) {
    stream.events.splice(0, stream.events.length - limits.maxEvents);
  }
  // A finished run is kept for a moment so a watcher that arrives just after the end still sees
  // how it went, then dropped: its record is the row, not this. A waiting one is kept far longer.
  // An exchange's end says nothing of whether the run goes on: after a `wait`, it is still waiting.
  // Nor does a nested event, which is a run inside this one waiting or ending, not this run.
  const isOver = stream.phase === StreamPhase.Ended;
  const movesPhase = isOver === false && event.kind !== RunEventKind.ExchangeEnd && isNested(event) === false;
  if (movesPhase) {
    stream.phase = PHASE_BY_KIND.get(event.kind) ?? StreamPhase.Live;
  }
  scheduleSweep(held);

  for (const listener of stream.listeners) {
    // The guarantee above is the point of this: a listener that throws must not take out the
    // emitter, the listeners after it, or the bookkeeping already done above.
    try {
      listener(event);
    } catch {}
  }
  return event;
}

/**
 * Everything that has happened on a run, then everything that happens next, until it ends.
 *
 * @param runId - The run to follow. One that has not started yet is waited on, not refused.
 * @param [signal] - Stops following. The only other way out is the run's own `done`, and a watcher
 * with no way out is a leak rather than a lost backlog: the sweep below skips any stream a
 * listener is on, so a run that dies without `done` pins its backlog for the life of the process.
 * Returning the generator is not that way out — parked on the promise at the foot of this
 * function it is suspended at an `await` rather than at a `yield`, and a `return()` there is
 * queued behind a promise only the next event can settle. An abort resolves that promise itself.
 * @returns The run's events in order, ending after its `done` or at the abort. A watcher that fell
 * too far behind is given one notice in place of the events it missed. Nothing is subscribed until
 * the first event is asked for.
 *
 * @remarks
 * The backlog comes first so a watcher that joins halfway through — or after the run finished,
 * inside the retention window — reads the same story as one that was there from the start.
 */
export function watch(runId: string, signal?: AbortSignal): AsyncGenerator<RunEvent> {
  // Read here, not in the generator: its body runs when the first event is asked for, and by
  // then the caller may be outside the runtime whose run this is.
  return watching(bus(), runId, signal);
}

/**
 * The notice a watcher that fell behind is given in place of the events it missed.
 *
 * @param runId - The run the watcher is following.
 * @param gap - How many events were dropped, for the text.
 * @param next - The event the notice goes ahead of, which gives it its exchange, its time and —
 * less one — its seq.
 * @returns A `notice` event made for that one watcher: it is in no backlog.
 *
 * @remarks
 * One short of the event it precedes, which is the last seq that went missing. Sharing a seq
 * with the event behind it made the notice indistinguishable from a duplicate, and de-duplicating
 * on `seq` is the one thing the sequence is documented for — so a client doing exactly that
 * dropped either the gap notice or the event it explains. Inside the gap there is nothing to
 * collide with: those seqs reach no watcher.
 */
const gapNotice = (runId: string, gap: number, next: RunEvent): RunEvent =>
  stamp(
    {
      kind: RunEventKind.Notice,
      text: `${gap} event(s) dropped: this watcher fell too far behind`,
      exchange: next.exchange,
    },
    runId,
    next.seq - 1,
    next.at,
  );

/**
 * The generator behind `watch`, on a bus already chosen.
 *
 * @param held - The bus the run is on, kept for the generator's life whichever runtime resumes it.
 * @param runId - The run to follow. A stream is begun for one that has none, and dropped on the way
 * out where this was its last watcher and the run has ended or never emitted.
 * @param [signal] - Stops following. One already aborted yields nothing, the backlog included.
 * @returns The backlog as it stood at the first `next()`, then each event as it is emitted, ending
 * after `done` or at the abort.
 */
async function* watching(held: Bus, runId: string, signal?: AbortSignal): AsyncGenerator<RunEvent> {
  const { limits, streams } = held;
  const stream = streamFor(held, runId);
  // A cursor rather than `shift()`. Draining a backlog an event at a time off the front of an
  // array is a copy of the whole array per event, which on the ten-thousand-delta run this bus
  // is built for is the one quadratic left in the file. The prefix behind the cursor is dropped
  // in one `slice` per `maxEvents` instead — the same amortised trade the bus itself makes.
  let queue: RunEvent[] = [...stream.events];
  let head = 0;
  let dropped = 0;
  let wake: (() => void) | null = null;
  const listener = (event: RunEvent) => {
    queue.push(event);
    // Capped as the bus's own backlog is, oldest first, and released here rather than by the drain's
    // compaction, which a stalled consumer (the reason for the cap) never reaches.
    const cut = queue.length - head - limits.maxEvents;
    if (cut > limits.trimSlack) {
      queue = queue.slice(head + cut);
      head = 0;
      dropped += cut;
    }
    wake?.();
  };
  stream.listeners.add(listener);
  // The same wake the listener uses: an abort is another reason to stop waiting, and what the
  // loop does about it is decided in one place below rather than here.
  const onAbort = () => wake?.();
  signal?.addEventListener(ABORT_EVENT, onAbort, { once: true });
  try {
    for (;;) {
      // Guarding the drain rather than sitting after it, so an already-aborted signal leaves
      // without replaying the backlog and one raised mid-drain stops at the next event instead
      // of finishing the queue first.
      while (!signal?.aborted && head < queue.length) {
        const event = queue[head++];
        // What is behind the cursor is released rather than left there. Resetting only on catch-up
        // was not enough: a watcher that keeps pace but never quite empties the queue never
        // reaches that branch, and the array grows by a slot per event for the length of the run.
        if (head === queue.length) {
          queue = [];
          head = 0;
        } else if (head > limits.maxEvents) {
          queue = queue.slice(head);
          head = 0;
        }
        if (dropped > 0) {
          // Said once per gap rather than per event, and before the event that follows it, so a
          // client reading `seq` sees why the numbers jump instead of assuming it lost its place.
          const gap = dropped;
          dropped = 0;
          yield gapNotice(runId, gap, event);
        }
        yield event;
        // `done` is the last event a run will ever have, so the subscription completes rather
        // than leaving the client holding an open stream that will never say anything again. A
        // nested `done` is a run inside this one ending, and this one goes on.
        const isRunDone = event.kind === RunEventKind.Done && isNested(event) === false;
        if (isRunDone) {
          return;
        }
      }
      if (signal?.aborted) {
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  } finally {
    // `once` covers the abort that fired; this is for the one that never did, which would
    // otherwise hold this generator and its queue alive for as long as the caller holds the
    // signal — a run's whole backlog kept by a watcher that finished on `done`.
    signal?.removeEventListener(ABORT_EVENT, onAbort);
    stream.listeners.delete(listener);
    // Nothing is left behind for a run that never started or has ended. Checked against `stream`, not
    // the id: a later `emit` may have filed the same run under a new stream, which is not ours to delete.
    const stillFiled = streams.get(runId) === stream;
    const unwatched = stream.listeners.size === 0;
    const nothingMoreToSay = stream.phase === StreamPhase.Ended || stream.events.length === 0;
    if (stillFiled && unwatched && nothingMoreToSay) {
      streams.delete(runId);
    }
  }
}

/**
 * The backlog alone, for a caller that wants a snapshot rather than a subscription.
 *
 * @param runId - The run to read. An unknown or already-swept run gives an empty array.
 * @returns The events still held, oldest first, in an array of the caller's own.
 *
 * @remarks
 * The array is a copy; the events in it are not. They are the same objects the bus holds and
 * every watcher was handed, so writing to one rewrites the run for everybody — which is what
 * `fold` copies to avoid, and this is the other half of the same warning. Read them, or copy
 * what you mean to change.
 */
export const history = (runId: string): RunEvent[] => [...(bus().streams.get(runId)?.events ?? [])];

/**
 * Test seam: forget every run, so one test's events cannot be read by the next.
 *
 * @remarks
 * Named for what it forgets rather than bare `reset`, which sat in a consumer's imports beside
 * `resetAll`, `resetClients`, `resetCapabilities` and `resetHints` saying nothing about which
 * of the five it was — `reset.ts` had to alias it on the way in to stay readable.
 *
 * `configureEvents` is undone too, for the reason `reset.ts` gives about latches: a bus left
 * holding a cap one test set is the same order-dependent suite, passing where that test ran
 * first and failing where it did not. A consumer that configures at startup and resets at
 * teardown configures again, which is the same line it already wrote once.
 */
export const resetEvents = () => {
  const held = bus();
  held.streams.clear();
  if (held.sweeping) {
    clearTimeout(held.sweeping);
  }
  held.sweeping = null;
  // In place, so a watcher still open reads the defaults too and not the caps it began under.
  Object.assign(held.limits, EVENT_BUS_DEFAULTS);
};

/**
 * A run's events with each stretch of `thinking` or of `output` joined into one block, for a
 * reader that takes a run in snapshots.
 *
 * @param events - Events in `seq` order, from `history` or collected from `watch`. Not written to.
 * @returns One event per block, every one a copy. A stretch of `thinking` or of `output` within
 * one exchange, said by one run, is a single block with the texts joined; anything else is a block
 * to itself. A nested event's run is its `via`, so a stretch of an inner run's thinking is kept
 * apart from the outer run's and from every other inner run's.
 *
 * @remarks
 * Consecutive tokens of one kind are one thing being said, not hundreds of things. A client that
 * reads a run in snapshots rather than token by token wants it that way: a
 * reasoning model spends ten thousand deltas on a paragraph, and a paragraph is what it meant.
 * Each block carries the `seq` of its last event, so asking for what came after one block
 * picks up exactly where it left off.
 */
export function fold(events: RunEvent[]): RunEvent[] {
  const blocks: RunEvent[] = [];
  // The text of the block still open, accumulated rather than re-concatenated. Rebuilding the
  // block object per delta — a spread and a join of everything so far — is the same paragraph
  // built ten thousand times to produce it once.
  let parts: string[] = [];
  const close = () => {
    if (!parts.length) {
      return;
    }
    const last = blocks[blocks.length - 1];
    if (parts.length > 1) {
      last.text = parts.join('');
    }
    parts = [];
  };

  for (const event of events) {
    const last = blocks[blocks.length - 1];
    const mergeable = event.kind === RunEventKind.Thinking || event.kind === RunEventKind.Output;
    const continuesLast = last && last.kind === event.kind && last.exchange === event.exchange && sameVia(last, event);
    if (mergeable && continuesLast) {
      last.seq = event.seq;
      last.at = event.at;
      parts.push(event.text);
    } else {
      close();
      // A copy, because the merged branch above writes into the block it returns and the caller
      // cannot tell which branch its events took. Pushing the stored object let
      // `fold(history(id))[0].text = ...` rewrite the bus, and every watcher after it read the
      // rewrite.
      blocks.push({ ...event });
      if (mergeable) {
        parts.push(event.text);
      }
    }
  }
  close();
  return blocks;
}

/**
 * A run summed and derived from its events: what it cost, where the time went, and why.
 *
 * @remarks
 * The counts are always there, zero when nothing happened. Every other field is absent where no
 * turn reported what it is made of, and summed over the turns that did where only some did —
 * a mean of a number a server never sent would be a number nobody measured.
 */
export interface RunMetrics {
  /** `exchange` events: one per exchange `runAgentLoop` ran, and any the app sent of its own. */
  exchanges: number;
  /** Turns of the agent loop, one per `usage` report. */
  turns: number;
  /** Model requests, which is turns plus the continuations joined onto them. */
  requests: number;
  /** Tool results, `load_tools` included. */
  toolCalls: number;
  /** Tool results that came back not ok, by tool name. */
  toolErrors: Record<string, number>;
  /** `load_tools` calls. */
  loadCalls: number;
  /** `artifact` events: the distinct things the run's tool calls linked to. */
  artifacts: number;
  /** `server-log` events at `warning`. */
  serverWarnings: number;
  /** `server-log` events at `error` or above: `critical`, `alert` and `emergency` with it. */
  serverErrors: number;
  /**
   * Tools `load_tools` loaded that were not loaded already, summed from each result's `loads`.
   * Absent where no result carried any; `runAgentLoop` fills all three with zero in an on-demand
   * exchange that loaded nothing.
   */
  toolsLoaded?: number;
  /** Tools the model asked `load_tools` for that it already had, summed the same way. */
  redundantLoads?: number;
  /** Names the model asked `load_tools` for that are in no catalogue, summed the same way. */
  unknownToolNames?: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Summed over the turns that reported a cache count. */
  uncachedTokens?: number;
  reasoningTokens?: number;
  /** Cached over prompt tokens, across only the turns that reported a cache count. */
  cacheHitRatio?: number;
  /** Turns whose cache fell short of what the turn before left it. */
  cacheBreaks: number;
  /** Those turns by what the loop changed. */
  cacheBreakReasons: Partial<Record<CacheBreakReason, number>>;
  /** Turns cut off at `maxTokens` after any continuation. */
  truncatedTurns: number;
  /**
   * Turns of a `session` run served on no llama.cpp slot of their own, which `cacheHitRatio` reads
   * against. Absent where no turn reported `pinned`.
   */
  unpinnedTurns?: number;
  /** From the run's own first event to its last, which a still-running run keeps moving. */
  wallMs?: number;
  /** Prefill time summed over the turns. */
  promptMs?: number;
  /** Decode time summed over the turns. */
  predictedMs?: number;
  /**
   * Time from each tool call to its result, summed per call — so calls run in parallel can add up
   * to more than the wall time they took. A call with no result here, such as one handed back,
   * adds nothing.
   */
  toolMs?: number;
  /** The longest any one turn took, retries and continuations in. */
  slowestTurnMs?: number;
  /** The mean time to first token over the turns that produced one. */
  firstTokenMs?: number;
  draftTotal?: number;
  draftAccepted?: number;
  /** Accepted over drafted. */
  draftAcceptance?: number;
  /** The biggest prompt any turn reported. */
  largestPrompt?: number;
  /**
   * The highest share of its context window any turn's prompt took, for how close the run came:
   * each turn over its own `contextLength`, or over the one `runMetrics` was told where it
   * has none.
   */
  largestPromptShare?: number;
  /**
   * How the run ended, in an exchange's terms: its last `exchange-end`'s outcome, or `failed` where
   * a `done` was not ok and that exchange did not fail already. Absent where no exchange has ended
   * since the last one began, and no `done` said the run failed.
   */
  outcome?: ExchangeOutcome;
}

/** The fields of `RunMetrics` that are a number, which are the ones a report can be added to. */
type CountedMetric = {
  [K in keyof RunMetrics]-?: RunMetrics[K] extends number | undefined ? K : never;
}[keyof RunMetrics];

/** The log levels quietest first, which is what makes "warning and above" a comparison. */
const SEVERITY: readonly string[] = Object.values(ServerLogLevel);

/** Where `warning` sits in `SEVERITY`: a level past it is an error. */
const WARNING = SEVERITY.indexOf(ServerLogLevel.Warning);

/** How an exchange ended, as its result says or as `runMetrics` reads it off a run's events. */
export const ExchangeOutcome = {
  /** The exchange did not fail, and its last turn was neither cut off nor withheld. */
  Answered: 'answered',
  /** The exchange did not fail, and its last turn is an answer the reply ceiling cut off. */
  Truncated: 'truncated',
  /**
   * The exchange did not fail, and the provider's content filter withheld its last turn
   * (`finish_reason: "content_filter"`): what the answer says, if anything, is not the model's
   * whole reply.
   */
  Filtered: 'filtered',
  /**
   * The exchange did not fail, and a tool call ended it: `AgentLoopResult.ended` says which, and so
   * does its `exchange-end`.
   */
  Ended: 'ended',
  /**
   * The exchange stopped: it handed calls back and waits for the app to answer them, as
   * `AgentLoopResult.pending` and its `exchange-end` list them.
   */
  Waiting: 'waiting',
  /**
   * The exchange threw: a request or a callback failed, it overflowed, or its turns ran out. Never on
   * a result; for a run, also a `done` that was not ok.
   */
  Failed: 'failed',
  /** The app's signal stopped the exchange, which then threw: never on a result. */
  Stopped: 'stopped',
} as const;

/** Any one of the outcomes in `ExchangeOutcome`. */
export type ExchangeOutcome = (typeof ExchangeOutcome)[keyof typeof ExchangeOutcome];

/**
 * How a run ended, from its last exchange's end and its `done`.
 *
 * @param ending - The last `exchange-end`, where no exchange began after it.
 * @param failed - Whether a `done` said the run was not ok.
 * @returns `failed` where the run failed and that exchange did not, else that exchange's outcome;
 * `undefined` where neither says anything.
 */
function runOutcome(ending: RunEvent | undefined, failed: boolean): ExchangeOutcome | undefined {
  const failedAfter = failed && ending?.ok !== false;
  return failedAfter ? ExchangeOutcome.Failed : ending?.outcome;
}

/**
 * The outcome of an exchange whose last turn finished for a reason other than an answer.
 *
 * @remarks
 * A map rather than an object, because the key is whatever the server sent and an object would
 * look `constructor` up on its prototype.
 */
const OUTCOME_BY_FINISH: ReadonlyMap<string | undefined, ExchangeOutcome> = new Map([
  [FinishReason.Length, ExchangeOutcome.Truncated],
  [FinishReason.ContentFilter, ExchangeOutcome.Filtered],
]);

/**
 * How an exchange that ends on a turn ends, read off that turn's finish reason.
 *
 * @param finishReason - The last turn's `finish_reason`, as the server sent it.
 * @returns `truncated` for `length`, `filtered` for `content_filter`, and `answered` otherwise.
 */
export function endingOf(finishReason: string | undefined): ExchangeOutcome {
  return OUTCOME_BY_FINISH.get(finishReason) ?? ExchangeOutcome.Answered;
}

/** What `runMetrics` takes besides the events. */
export interface RunMetricsOptions {
  /**
   * The context window the run was served, for `largestPromptShare` over the turns that do not
   * carry their own. Absent or zero leaves those out.
   */
  contextLength?: number;
}

/**
 * A run's totals, timings and cache findings, derived from the events it emitted.
 *
 * @param events - A run's events in `seq` order, from `history` or collected from `watch`. A backlog
 * that has lost its oldest events to the cap sums what it still has. Nested events, those with a
 * `via`, are left out: they are an inner run's, which is summed from its own events.
 * @param [options] - The served context window, for how full the run came to it.
 * @returns A summary of the caller's own. The counts are zero for an empty list, and `outcome` is
 * what `RunMetrics.outcome` says: absent while an exchange is going.
 *
 * @remarks
 * A sibling of `fold` rather than part of it. `fold` hands back events, and a client renders
 * what it returns as blocks; a summary is another shape, and folding one in would give every
 * consumer of `fold` a block it does not know how to draw. Derived from the `usage` reports' own
 * `turn` rather than the running totals, so a run with several exchanges in it — a question per
 * exchange — adds up the same as one with a single exchange. That holds for everything here: what
 * `load_tools` resolved to rides on its results, and each turn carries the context window it was
 * served, so the events of every exchange of a run, concatenated, are a complete account of it.
 */
export function runMetrics(events: RunEvent[], { contextLength }: RunMetricsOptions = {}): RunMetrics {
  const metrics: RunMetrics = {
    exchanges: 0,
    turns: 0,
    requests: 0,
    toolCalls: 0,
    toolErrors: {},
    loadCalls: 0,
    artifacts: 0,
    serverWarnings: 0,
    serverErrors: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheBreaks: 0,
    cacheBreakReasons: {},
    truncatedTurns: 0,
  };
  /** Adds to a field that is absent until something reports it. */
  const add = (field: CountedMetric, value: number | undefined) => {
    if (value === undefined) {
      return;
    }
    metrics[field] = (metrics[field] ?? 0) + value;
  };
  let reportedPrompt = 0;
  let reportedCached = 0;
  let firstTokens = 0;
  // Calls waiting for their results, by call id, oldest first. An event built without an id is
  // paired by its tool's name, which is all it carries.
  const pending = new Map<string, number[]>();
  // The last exchange's end, until another exchange begins, and whether a `done` said the run failed.
  let ending: RunEvent | undefined;
  let failed = false;
  // The run's own first and last event, which `wallMs` spans: an inner run's are not its clock.
  let first: RunEvent | undefined;
  let last: RunEvent | undefined;

  for (const event of events) {
    if (isNested(event)) {
      continue;
    }
    first ??= event;
    last = event;
    if (event.kind === RunEventKind.Exchange) {
      metrics.exchanges++;
      ending = undefined;
    } else if (event.kind === RunEventKind.ExchangeEnd) {
      ending = event;
    } else if (event.kind === RunEventKind.ToolCall) {
      if (event.name === LOAD_TOOLS) {
        metrics.loadCalls++;
      }
      getOrCreate(pending, event.id ?? event.name, () => []).push(event.at);
    } else if (event.kind === RunEventKind.ToolResult) {
      metrics.toolCalls++;
      const toolFailed = event.ok === false;
      if (toolFailed) {
        metrics.toolErrors[event.name] = (metrics.toolErrors[event.name] ?? 0) + 1;
      }
      if (event.loads) {
        add('toolsLoaded', event.loads.toolsLoaded);
        add('redundantLoads', event.loads.redundantLoads);
        add('unknownToolNames', event.loads.unknownToolNames);
      }
      const called = pending.get(event.id ?? event.name)?.shift();
      if (called !== undefined) {
        add('toolMs', event.at - called);
      }
    } else if (event.kind === RunEventKind.Artifact) {
      metrics.artifacts++;
    } else if (event.kind === RunEventKind.ServerLog) {
      const severity = SEVERITY.indexOf(event.level ?? '');
      if (severity === WARNING) {
        metrics.serverWarnings++;
      } else if (severity > WARNING) {
        metrics.serverErrors++;
      }
    } else if (event.kind === RunEventKind.Usage && event.usage?.turn) {
      const turn = event.usage.turn;
      metrics.turns++;
      metrics.requests += 1 + (turn.continuations ?? 0);
      metrics.promptTokens += turn.prompt;
      metrics.completionTokens += turn.completion;
      metrics.cachedTokens += turn.cached;
      if (turn.uncached !== undefined) {
        add('uncachedTokens', turn.uncached);
        reportedPrompt += turn.prompt;
        reportedCached += turn.cached;
      }
      add('reasoningTokens', turn.reasoningTokens);
      add('promptMs', turn.promptMs);
      add('predictedMs', turn.predictedMs);
      add('draftTotal', turn.draftTotal);
      add('draftAccepted', turn.draftAccepted);
      if (turn.cacheBroken) {
        metrics.cacheBreaks++;
        const reason = turn.cacheBreakReason ?? CacheBreakReason.NoneKnown;
        metrics.cacheBreakReasons[reason] = (metrics.cacheBreakReasons[reason] ?? 0) + 1;
      }
      if (turn.finishReason === FinishReason.Length) {
        metrics.truncatedTurns++;
      }
      if (turn.pinned !== undefined) {
        add('unpinnedTurns', turn.pinned ? 0 : 1);
      }
      if (turn.wallMs !== undefined) {
        metrics.slowestTurnMs = Math.max(metrics.slowestTurnMs ?? 0, turn.wallMs);
      }
      if (turn.firstTokenMs !== undefined) {
        add('firstTokenMs', turn.firstTokenMs);
        firstTokens++;
      }
      if (turn.prompt > 0) {
        metrics.largestPrompt = Math.max(metrics.largestPrompt ?? 0, turn.prompt);
        const window = turn.contextLength ?? contextLength ?? 0;
        if (window > 0) {
          metrics.largestPromptShare = Math.max(metrics.largestPromptShare ?? 0, turn.prompt / window);
        }
      }
    } else if (event.kind === RunEventKind.Done) {
      failed = event.ok === false;
    }
  }

  const outcome = runOutcome(ending, failed);
  if (outcome) {
    metrics.outcome = outcome;
  }
  if (first && last && first !== last) {
    metrics.wallMs = last.at - first.at;
  }
  if (reportedPrompt > 0) {
    metrics.cacheHitRatio = reportedCached / reportedPrompt;
  }
  if (metrics.firstTokenMs !== undefined) {
    metrics.firstTokenMs /= firstTokens;
  }
  if (metrics.draftTotal && metrics.draftAccepted !== undefined) {
    metrics.draftAcceptance = metrics.draftAccepted / metrics.draftTotal;
  }
  return metrics;
}
