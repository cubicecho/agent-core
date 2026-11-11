import type { TokenLedger } from '../context/ledger.ts';
import { getOrCreate } from '../core/guards.ts';
import { ABORT_EVENT, MS_PER_MINUTE } from '../core/platform.ts';
import { assignSettings, scoped } from '../core/scope.ts';
import { LOAD_TOOLS } from '../tools/tool-loading.ts';
import type { TurnUsage } from '../wire/stream.ts';
import { CacheBreakReason } from '../wire/stream.ts';
import { type ResourceLink, ServerLogLevel } from '../wire/tool-calls.ts';
import { FinishReason } from '../wire/wire.ts';

/**
 * What a run is doing, while it is doing it.
 *
 * A run row only exists as a before and an after: it is written when the agent starts and
 * updated when it stops, and everything in between — the thinking, the tool the model reached
 * for, the argument it got wrong — is gone by the time anyone can read it. This is that middle,
 * kept in memory and handed to whoever is watching.
 *
 * In memory on purpose: it is debugging output, worth nothing once the run has finished and its
 * outcome is in the database. Nothing here survives a restart, and nothing here is the record.
 */

/** What the bus keeps and for how long. Every field optional; see `configureEvents`. */
export interface EventBusOptions {
  /** How many events one run keeps for a watcher that joins late. A chatty run loses its oldest. */
  maxEvents?: number;
  /**
   * How far past the cap the backlog is allowed to run before it is trimmed.
   *
   * @remarks
   * Dropping the oldest event on every push means shifting a thousand-element array tens of
   * thousands of times over a reasoning run — the one thing in here that would ever show up in a
   * profile. Trimming in batches makes it a few dozen splices instead, at the cost of the backlog
   * sometimes being a little longer than the cap, which nothing depends on. The one field here
   * that is an implementation detail rather than a policy: raising it trades memory for fewer
   * splices, and there is no reason to lower it.
   */
  trimSlack?: number;
  /** How long a finished run stays readable, for a watcher that arrives just after the end. */
  retainMs?: number;
  /**
   * The same for a run that has not said `done`, which is a far more dangerous thing to drop.
   *
   * @remarks
   * A finished run has nothing more to say, so forgetting it a minute later costs a late watcher
   * a backlog and nothing else. An unfinished one is still writing: `touched` only moves on
   * `emit`, so a live run that spends a minute inside one slow tool call looked exactly like an
   * abandoned one and was reaped out from under itself. What made that more than a lost backlog
   * is that the next `emit` builds a fresh stream with `seq` back at zero — and `seq` is the
   * field `RunEvent` documents for ordering and de-duplication, so a client that reconnects
   * across the gap discards the new events as ones it has already seen.
   *
   * The sweep still has to reap them, because a run killed by a signal or simply forgotten
   * reaches no `done` either. This is the backstop for a caller that never says so; `endRun` is
   * for one that knows. Anything shorter than the longest a tool call may take is a live run
   * reaped out from under itself.
   */
  retainUnendedMs?: number;
}

/** How many minutes an unended run's events are kept, absent a `retainUnendedMs`. */
const RETAIN_UNENDED_MINUTES = 30;

/** The numbers a run of the shape this bus was written for wants. */
const DEFAULTS: Required<EventBusOptions> = {
  maxEvents: 1000,
  trimSlack: 256,
  retainMs: MS_PER_MINUTE,
  retainUnendedMs: RETAIN_UNENDED_MINUTES * MS_PER_MINUTE,
};

/**
 * One runtime's bus, held as a single object so a watcher and the sweep timer keep hold of the
 * bus they began on — a generator resumes in whatever context asks it for the next event, which
 * need not be the runtime that opened it.
 */
interface Bus {
  /** What is in force now. Read where it is used, so a change applies from the next event. */
  limits: Required<EventBusOptions>;
  streams: Map<string, Stream>;
  /** The pending sweep, see `sweep`. */
  sweeping: ReturnType<typeof setTimeout> | null;
}

const bus = scoped((): Bus => ({ limits: { ...DEFAULTS }, streams: new Map(), sweeping: null }));

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
 * take an hour wants a longer `retainUnendedMs` than the thirty minutes assumed here.
 *
 * Changes apply from the next event and the next sweep. Nothing already buffered is trimmed to
 * a cap that has just come down, because the trim happens on push; the backlog settles to the
 * new number as the run goes on.
 */
export function configureEvents(options: EventBusOptions = {}): Required<EventBusOptions> {
  return assignSettings(bus().limits, options);
}

/** Which kind of thing happened, and what `text`, `name`, `ok` and `usage` carry for it. */
export const RunEventKind = {
  /** A step of a caller's own flow began. `name` is the step, `text` its kind. */
  Step: 'step',
  /** A decision step chose an arm. `text` is the arm it took. */
  Decision: 'decision',
  /** A new turn of the agent loop began, inside whichever step is running. */
  Turn: 'turn',
  /** Reasoning tokens, as they arrive. */
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
   * A tool call's answer linked to something the run had not produced before — or, where the run
   * collects them, a write was detected or a declaration believed at a new location. `id` is the
   * call's the artifact is put down to, `name` its tool, `text` the link's title or else its uri,
   * and `link` the link itself. Once per location per run: a later call that links or writes it
   * again only adds to its count, and a declaration over it only fills it in.
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
   * What the run has cost so far, at the end of every turn, and what that one turn did. Sent
   * whether or not the endpoint reported tokens, since the timings and the cache comparison are
   * measured either way.
   */
  Usage: 'usage',
  /**
   * The run ended. Always last, and always sent. A run a tool call ended carries that call: `id`
   * the call's, `name` the tool, and `text` the reason, as `AgentLoopResult.ended` has them.
   */
  Done: 'done',
} as const;

/** Any one of the kinds in `RunEventKind`. */
export type RunEventKind = (typeof RunEventKind)[keyof typeof RunEventKind];

/**
 * What a run has spent, counted from the start of the run rather than for the turn that
 * carried it: a client draws the latest one it has seen and needs no arithmetic of its own,
 * and one lost to the backlog cap costs nothing because the next supersedes it.
 *
 * @remarks
 * The counts are `UsageTotals`, the spelling `AgentLoopResult.usage` shares, with the cache's two
 * fields optional so a host emitting usage of its own need not know them.
 */
export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * How much of `promptTokens` the endpoint served from its prompt cache. Optional so a caller
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
   * The run's token ledger as of this turn, whole rather than the entry it added — a host whose
   * run then fails still holds the latest one, and a rewrite in `beforeStep` moves earlier entries.
   * Absent from a caller emitting usage of its own.
   */
  ledger?: TokenLedger;
}

/** One turn's usage and measurements as a `usage` event carries them. */
export interface TurnReport extends TurnUsage {
  /** Why the model stopped, as `Turn.finishReason` says it; `length` is a turn cut short. */
  finishReason: string;
  /**
   * The window the turn was served, where the loop was told one, for `largestPromptShare`.
   *
   * @remarks
   * On the turn rather than only in `runMetrics`' options, because a run of several loops can put
   * them on models with different windows, and one window for the whole run misstates how close
   * any of them came.
   */
  contextLength?: number;
}

/**
 * What `load_tools` calls resolved to: new tools, ones already loaded, and names in no catalogue.
 *
 * @remarks
 * Carried on each `load_tools` result as `loads`, so `runMetrics` over every loop's events adds
 * them up without the loops' results beside it.
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
 * One thing that happened in a run, as a watcher receives it.
 *
 * @remarks
 * Every field but `id` and `link` is always present — the empty ones are `""` or `null` rather
 * than missing — so a client reads it without guarding each key.
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
  /** Tool name on the tool kinds, and on a `done` the tool that ended the run; otherwise empty. */
  name: string;
  /**
   * The call's id on the tool kinds, which pairs a `tool-result` with its `tool-call` when one
   * tool is called twice in a step. The one field `emit` does not fill in: it is there only where
   * the emitter gave one, and optional so an event built before it existed still compiles.
   */
  id?: string;
  /**
   * The caller's own flow step this happened inside, so a watcher can group a run the way the
   * work is written. Empty for events that belong to the run rather than to any one step, and
   * empty throughout for a caller with no steps at all.
   */
  step: string;
  /** Outcome on `tool-result` and `done`, otherwise null. */
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
 * field reads as.
 */
export const stamp = (input: RunEventInput, runId: string, seq: number, at: number): RunEvent => ({
  at,
  text: '',
  name: '',
  step: '',
  ok: null,
  usage: null,
  ...input,
  runId,
  seq,
});

interface Stream {
  events: RunEvent[];
  listeners: Set<(event: RunEvent) => void>;
  seq: number;
  /** When this stream last saw an event, for the sweep below. */
  touched: number;
  /** Whether `done` has been seen, so a watcher leaving knows the run is over. */
  ended: boolean;
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
    ended: false,
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
    if (stream.touched <= now - (stream.ended ? limits.retainMs : limits.retainUnendedMs)) {
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
  // Watchers are parked on a promise that only an `emit` to *this* stream can resolve, and the
  // delete below puts it beyond the reach of every later one — the next `emit` builds a fresh
  // stream and wakes nobody. So they are told the run is over first: a watcher that is handed
  // `done` completes, runs its `finally` and lets its consumer go, where one left parked holds
  // an open subscription that can never say anything again. An SSE client on the other end of
  // that is a connection that never closes.
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
  if (stream.events.length > limits.maxEvents + limits.trimSlack) {
    stream.events.splice(0, stream.events.length - limits.maxEvents);
  }
  // Kept for a moment so a watcher that arrives just after the end still sees how it went,
  // then dropped: a finished run's record is the row, not this.
  if (event.kind === RunEventKind.Done) {
    stream.ended = true;
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
 * @param next - The event the notice goes ahead of, which gives it its step, its time and — less
 * one — its seq.
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
      step: next.step,
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
    // The bus caps its own backlog at `maxEvents`; without this the watcher downstream of it
    // had no cap at all, so a client too slow to keep up held every delta a run ever emitted.
    // The oldest go, which is what the backlog does, and the gap is reported once below.
    //
    // Dropped here means released here. Advancing the cursor alone left the dropped events in
    // the slots behind it, to be freed by the compaction in the drain below — which a consumer
    // that has stalled does not reach, and a stalled consumer is the whole reason for the cap.
    // It read as capped and held every event anyway: 16MB where the cap promises a third of one.
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
        // than leaving the client holding an open stream that will never say anything again.
        if (event.kind === RunEventKind.Done) {
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
    // A watcher can name a run that has not started, or will never start. Nothing was recorded
    // under it, so nothing is left behind either — and a run that has ended has nothing more to
    // say to anyone, so the last watcher leaving takes the backlog with it.
    // Against `stream` rather than the id: this generator may have outlived its own entry — a
    // sweep or an `endRun` drops it and a later `emit` files the same run under a new one — and
    // the last watcher of the old stream has no business deleting the new one.
    const stillFiled = streams.get(runId) === stream;
    const unwatched = stream.listeners.size === 0;
    const nothingMoreToSay = stream.ended || stream.events.length === 0;
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
  Object.assign(held.limits, DEFAULTS);
};

/**
 * A run's events with each stretch of `thinking` or of `output` joined into one block, for a
 * reader that takes a run in snapshots.
 *
 * @param events - Events in `seq` order, from `history` or collected from `watch`. Not written to.
 * @returns One event per block, every one a copy. A run of `thinking` or of `output` within one
 * step is a single block with the texts joined; anything else is a block to itself.
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
    const continuesLast = last && last.kind === event.kind && last.step === event.step;
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
  /** The caller's own `step` events. */
  steps: number;
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
   * Absent where no result carried any; `runAgentLoop` fills all three with zero in a run on
   * demand that loaded nothing.
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
  /** From the first event to the last, which a still-running run keeps moving. */
  wallMs?: number;
  /** Prefill time summed over the turns. */
  promptMs?: number;
  /** Decode time summed over the turns. */
  predictedMs?: number;
  /**
   * Time from each tool call to its result, summed per call — so calls run in parallel can add up
   * to more than the wall time they took.
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
   * The highest share of its window any turn's prompt took, for how close the run came: each
   * turn over its own `contextLength`, or over the one `runMetrics` was told where it has none.
   */
  largestPromptShare?: number;
  /** How it ended, read off `done` and the last turn. */
  outcome?: RunOutcome;
}

/** The fields of `RunMetrics` that are a number, which are the ones a report can be added to. */
type CountedMetric = {
  [K in keyof RunMetrics]-?: RunMetrics[K] extends number | undefined ? K : never;
}[keyof RunMetrics];

/** The log levels quietest first, which is what makes "warning and above" a comparison. */
const SEVERITY: readonly string[] = Object.values(ServerLogLevel);

/** Where `warning` sits in `SEVERITY`: a level past it is an error. */
const WARNING = SEVERITY.indexOf(ServerLogLevel.Warning);

/** How a run ended, as `runMetrics` reads it. */
export const RunOutcome = {
  /** The run did not fail, and its last turn was neither cut off nor withheld. */
  Answered: 'answered',
  /** The run did not fail, and its last turn is an answer the reply ceiling cut off. */
  Truncated: 'truncated',
  /**
   * The run did not fail, and the provider's content filter withheld its last turn
   * (`finish_reason: "content_filter"`): what the answer says, if anything, is not the model's
   * whole reply.
   */
  Filtered: 'filtered',
  /**
   * The run did not fail, and a tool call ended it: `AgentLoopResult.ended` says which, and so
   * does a `done` that names the tool.
   */
  Ended: 'ended',
  /**
   * `done` said the run was not ok. Whether that was an error, a stop or the tool budget is in
   * the host's own `done` text and not here.
   */
  Failed: 'failed',
} as const;

/** Any one of the outcomes in `RunOutcome`. */
export type RunOutcome = (typeof RunOutcome)[keyof typeof RunOutcome];

/**
 * How a run that reported `done` ended.
 *
 * @param done - The `done` event. Only an `ok` of `false` is a failure; one that names a tool was
 * ended by it; anything else is read off the turn.
 * @param last - The last turn a `usage` event reported, if any did.
 * @returns `failed` for a `done` that was not ok, `ended` for one that names the tool that ended
 * the run, `truncated` where the last turn ran into the reply ceiling, `filtered` where a content
 * filter withheld it, and `answered` otherwise.
 */
function outcomeOf({ ok, name }: RunEvent, last: TurnReport | undefined): RunOutcome {
  if (ok === false) {
    return RunOutcome.Failed;
  }
  // Read as a truthy string, so an event put together by hand without one is not ended.
  const isEnded = Boolean(name);
  if (isEnded) {
    return RunOutcome.Ended;
  }
  return endingOf(last?.finishReason);
}

/**
 * How a run that ends on a turn ends, read off that turn's finish reason.
 *
 * @param finishReason - The last turn's `finish_reason`, as the server sent it.
 * @returns `truncated` for `length`, `filtered` for `content_filter`, and `answered` otherwise.
 */
export function endingOf(finishReason: string | undefined): RunOutcome {
  if (finishReason === FinishReason.Length) {
    return RunOutcome.Truncated;
  }
  if (finishReason === FinishReason.ContentFilter) {
    return RunOutcome.Filtered;
  }
  return RunOutcome.Answered;
}

/** What `runMetrics` takes besides the events. */
export interface RunMetricsOptions {
  /**
   * The window the run was served, for `largestPromptShare` over the turns that do not carry
   * their own. Absent or zero leaves those out.
   */
  contextLength?: number;
}

/**
 * A run's totals, timings and cache findings, derived from the events it emitted.
 *
 * @param events - A run's events in `seq` order, from `history` or collected from `watch`. A backlog
 * that has lost its oldest events to the cap sums what it still has.
 * @param [options] - The served window, for how full the run came to it.
 * @returns A summary of the caller's own. The counts are zero for an empty list, and `outcome` is
 * absent for a run that has not reported `done`.
 *
 * @remarks
 * A sibling of `fold` rather than part of it. `fold` hands back events, and a client renders
 * what it returns as blocks; a summary is another shape, and folding one in would give every
 * consumer of `fold` a block it does not know how to draw. Derived from the `usage` reports' own
 * `turn` rather than the running totals, so a run with several loops in it — a question per loop —
 * adds up the same as one with a single loop. That holds for everything here: what `load_tools`
 * resolved to rides on its results, and each turn carries the window it was served, so the events
 * of every loop of a run, concatenated, are a complete account of it.
 */
export function runMetrics(events: RunEvent[], { contextLength }: RunMetricsOptions = {}): RunMetrics {
  const metrics: RunMetrics = {
    steps: 0,
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
  // Calls waiting for their results, by tool name, oldest first.
  const pending = new Map<string, number[]>();
  let last: TurnReport | undefined;

  for (const event of events) {
    if (event.kind === RunEventKind.Step) {
      metrics.steps++;
    } else if (event.kind === RunEventKind.ToolCall) {
      if (event.name === LOAD_TOOLS) {
        metrics.loadCalls++;
      }
      getOrCreate(pending, event.name, () => []).push(event.at);
    } else if (event.kind === RunEventKind.ToolResult) {
      metrics.toolCalls++;
      if (event.ok === false) {
        metrics.toolErrors[event.name] = (metrics.toolErrors[event.name] ?? 0) + 1;
      }
      if (event.loads) {
        add('toolsLoaded', event.loads.toolsLoaded);
        add('redundantLoads', event.loads.redundantLoads);
        add('unknownToolNames', event.loads.unknownToolNames);
      }
      const called = pending.get(event.name)?.shift();
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
      last = turn;
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
      metrics.outcome = outcomeOf(event, last);
    }
  }

  if (events.length > 1) {
    metrics.wallMs = events[events.length - 1].at - events[0].at;
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
