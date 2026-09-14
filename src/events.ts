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

/** The numbers a run of the shape this bus was written for wants. */
const DEFAULTS: Required<EventBusOptions> = {
  maxEvents: 1000,
  trimSlack: 256,
  retainMs: 60_000,
  retainUnendedMs: 30 * 60_000,
};

/** What is in force now. Read where it is used, so a change applies from the next event. */
let limits: Required<EventBusOptions> = { ...DEFAULTS };

/**
 * Changes what the bus keeps, for a process whose runs are not shaped like the ones these
 * defaults were chosen for.
 *
 * The bus is one module-level thing rather than an object a caller holds, so this is too: it is
 * a deployment's setting, said once at startup, and not something to move around under a run.
 * What it costs is memory against how much of a run a late or slow watcher can still read —
 * a server with hundreds of concurrent runs wants a smaller backlog, and one whose tool calls
 * take an hour wants a longer `retainUnendedMs` than the thirty minutes assumed here.
 *
 * Changes apply from the next event and the next sweep. Nothing already buffered is trimmed to
 * a cap that has just come down, because the trim happens on push; the backlog settles to the
 * new number as the run goes on.
 *
 * @param options The bounds to change. A field left out — or given anything that is not a
 * number above zero — keeps what it has, so a partial or a half-built config narrows nothing.
 * @returns Everything in force afterwards, including what this call did not change.
 */
export function configureEvents(options: EventBusOptions = {}): Required<EventBusOptions> {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value === "number" && value > 0) limits[name as keyof EventBusOptions] = value;
  }
  return { ...limits };
}

/** Which kind of thing happened, and what `text`, `name`, `ok` and `usage` carry for it. */
export type RunEventKind =
  /** A step of a caller's own flow began. `name` is the step, `text` its kind. */
  | "step"
  /** A decision step chose an arm. `text` is the arm it took. */
  | "decision"
  /** A new turn of the agent loop began, inside whichever step is running. */
  | "turn"
  /** Reasoning tokens, as they arrive. */
  | "thinking"
  /** Reply tokens, as they arrive. */
  | "output"
  /** The model asked for a tool, with the arguments it chose. */
  | "tool-call"
  /** A tool came back, with what it said. */
  | "tool-result"
  /** Something the runner did that is not the model's doing — a preselection, a retry. */
  | "notice"
  /** What the run has cost so far, as the endpoint reported it at the end of a turn. */
  | "usage"
  /** The run ended. Always last, and always sent. */
  | "done";

/**
 * What a run has spent, counted from the start of the run rather than for the turn that
 * carried it: a client draws the latest one it has seen and needs no arithmetic of its own,
 * and one lost to the backlog cap costs nothing because the next supersedes it.
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
}

/**
 * One thing that happened in a run, as a watcher receives it.
 *
 * Every field is always present — the empty ones are `""` or `null` rather than missing — so a
 * client reads it without guarding each key.
 */
export interface RunEvent {
  /** The run it belongs to. `emit` fills this in; a caller does not pass it. */
  runId: string;
  /** Per-run counter, from 1. Lets a client order and de-duplicate what it receives. */
  seq: number;
  /**
   * When it happened, as epoch milliseconds.
   *
   * A number rather than a `Date`: these events are read over a wire, where a `Date` is an ISO
   * string by the time anyone sees it, and `emit` runs once per streamed token — so the object
   * it does not allocate is one per token. It also spares the `getTime()` the sweep used to do
   * to get this same number back out.
   */
  at: number;
  kind: RunEventKind;
  /** The delta, the arguments, the result, or the reason — whatever the kind carries. */
  text: string;
  /** Tool name on the tool kinds, otherwise empty. */
  name: string;
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
}

/**
 * What `emit` is given: the run and the sequence are the bus's to assign.
 *
 * Named exclusions rather than a blanket `Partial`, which permitted both and let the spread in
 * `emit` overwrite them — a caller could file an event under another run and hand every watcher
 * a duplicate `seq`, which is the one thing the sequence is for.
 */
export type RunEventInput = Pick<RunEvent, "kind"> &
  Partial<Omit<RunEvent, "kind" | "runId" | "seq">>;

interface Stream {
  events: RunEvent[];
  listeners: Set<(event: RunEvent) => void>;
  seq: number;
  /** When this stream last saw an event, for the sweep below. */
  touched: number;
  /** Whether `done` has been seen, so a watcher leaving knows the run is over. */
  ended: boolean;
}

const streams = new Map<string, Stream>();

const streamFor = (runId: string): Stream => {
  const existing = streams.get(runId);
  if (existing) return existing;
  const stream: Stream = {
    events: [],
    listeners: new Set(),
    seq: 0,
    touched: Date.now(),
    ended: false,
  };
  streams.set(runId, stream);
  return stream;
};

/**
 * Drops the streams nobody is reading and nothing is writing to.
 *
 * Cleanup used to hang entirely off `done`, which assumed every run reaches it. A run killed by
 * an uncaught throw, a signal, or a caller that simply forgets pinned its backlog for the life
 * of the process — and in a long-lived server that map only ever grew. The `done` timer had the
 * same shape of hole from the other end: if a watcher was still attached when it fired it
 * deleted nothing and nothing rescheduled it, so any client slow enough to still be reading a
 * minute after the end leaked the stream permanently.
 *
 * One timer for the whole map, rescheduled only while there is something in it to expire.
 */
let sweeping: ReturnType<typeof setTimeout> | null = null;

function sweep() {
  sweeping = null;
  const now = Date.now();
  for (const [runId, stream] of streams) {
    if (stream.listeners.size) continue;
    if (stream.touched <= now - (stream.ended ? limits.retainMs : limits.retainUnendedMs))
      streams.delete(runId);
  }
  scheduleSweep();
}

function scheduleSweep() {
  if (sweeping || streams.size === 0) return;
  sweeping = setTimeout(sweep, limits.retainMs);
  sweeping.unref?.();
}

/**
 * Forgets a run that will not be emitting `done` — one whose process is tearing down, or whose
 * loop threw where it could not be caught. The sweep gets there on its own; this is for a
 * caller that already knows.
 *
 * @param runId The run to forget. An id nothing was emitted under is ignored.
 */
export function endRun(runId: string) {
  const stream = streams.get(runId);
  if (!stream) return;
  // Watchers are parked on a promise that only an `emit` to *this* stream can resolve, and the
  // delete below puts it beyond the reach of every later one — the next `emit` builds a fresh
  // stream and wakes nobody. So they are told the run is over first: a watcher that is handed
  // `done` completes, runs its `finally` and lets its consumer go, where one left parked holds
  // an open subscription that can never say anything again. An SSE client on the other end of
  // that is a connection that never closes.
  if (stream.listeners.size) emit(runId, { kind: "done", ok: false, text: "run ended" });
  streams.delete(runId);
}

/**
 * Records one event and hands it to everyone watching that run. Never throws at the caller.
 *
 * @param runId The run this belongs to. Created on first use.
 * @param input The event. `kind` is required; `runId` and `seq` are not a caller's to set.
 */
export function emit(runId: string, input: RunEventInput): RunEvent {
  const stream = streamFor(runId);
  // One clock read, used for both the event and the sweep's bookkeeping.
  const at = Date.now();
  const event: RunEvent = {
    at,
    text: "",
    name: "",
    step: "",
    ok: null,
    usage: null,
    ...input,
    // After the spread, not before: these are the bus's and a caller does not get a say.
    runId,
    seq: ++stream.seq,
  };
  stream.events.push(event);
  stream.touched = at;
  if (stream.events.length > limits.maxEvents + limits.trimSlack) {
    stream.events.splice(0, stream.events.length - limits.maxEvents);
  }
  // Kept for a moment so a watcher that arrives just after the end still sees how it went,
  // then dropped: a finished run's record is the row, not this.
  if (event.kind === "done") stream.ended = true;
  scheduleSweep();

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
 * The backlog comes first so a watcher that joins halfway through — or after the run finished,
 * inside the retention window — reads the same story as one that was there from the start.
 *
 * @param runId The run to follow. One that has not started yet is waited on, not refused.
 * @param signal Stops following. The only other way out is the run's own `done`, and a watcher
 * with no way out is a leak rather than a lost backlog: the sweep below skips any stream a
 * listener is on, so a run that dies without `done` pins its backlog for the life of the process.
 * Returning the generator is not that way out — parked on the promise at the foot of this
 * function it is suspended at an `await` rather than at a `yield`, and a `return()` there is
 * queued behind a promise only the next event can settle. An abort resolves that promise itself.
 */
export async function* watch(runId: string, signal?: AbortSignal): AsyncGenerator<RunEvent> {
  const stream = streamFor(runId);
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
  signal?.addEventListener("abort", onAbort, { once: true });
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
          //
          // One short of the event it precedes, which is the last seq that went missing. Sharing
          // a seq with the event behind it made the notice indistinguishable from a duplicate,
          // and de-duplicating on `seq` is the one thing the sequence is documented for — so a
          // client doing exactly that dropped either the gap notice or the event it explains.
          // Inside the gap there is nothing to collide with: those seqs reach no watcher.
          const gap = dropped;
          dropped = 0;
          yield {
            runId,
            seq: event.seq - 1,
            at: event.at,
            kind: "notice",
            text: `${gap} event(s) dropped: this watcher fell too far behind`,
            name: "",
            step: event.step,
            ok: null,
            usage: null,
          };
        }
        yield event;
        // `done` is the last event a run will ever have, so the subscription completes rather
        // than leaving the client holding an open stream that will never say anything again.
        if (event.kind === "done") return;
      }
      if (signal?.aborted) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  } finally {
    // `once` covers the abort that fired; this is for the one that never did, which would
    // otherwise hold this generator and its queue alive for as long as the caller holds the
    // signal — a run's whole backlog kept by a watcher that finished on `done`.
    signal?.removeEventListener("abort", onAbort);
    stream.listeners.delete(listener);
    // A watcher can name a run that has not started, or will never start. Nothing was recorded
    // under it, so nothing is left behind either — and a run that has ended has nothing more to
    // say to anyone, so the last watcher leaving takes the backlog with it.
    // Against `stream` rather than the id: this generator may have outlived its own entry — a
    // sweep or an `endRun` drops it and a later `emit` files the same run under a new one — and
    // the last watcher of the old stream has no business deleting the new one.
    if (
      streams.get(runId) === stream &&
      stream.listeners.size === 0 &&
      (stream.ended || stream.events.length === 0)
    ) {
      streams.delete(runId);
    }
  }
}

/**
 * The backlog alone, for a caller that wants a snapshot rather than a subscription.
 *
 * The array is a copy; the events in it are not. They are the same objects the bus holds and
 * every watcher was handed, so writing to one rewrites the run for everybody — which is what
 * `fold` copies to avoid, and this is the other half of the same warning. Read them, or copy
 * what you mean to change.
 *
 * @param runId The run to read. An unknown or already-swept run gives an empty array.
 */
export const history = (runId: string): RunEvent[] => [...(streams.get(runId)?.events ?? [])];

/**
 * Test seam: forget every run, so one test's events cannot be read by the next.
 *
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
  streams.clear();
  if (sweeping) clearTimeout(sweeping);
  sweeping = null;
  limits = { ...DEFAULTS };
};

/**
 * Consecutive tokens of one kind are one thing being said, not hundreds of things.
 *
 * A client that reads a run in snapshots rather than token by token wants it that way: a
 * reasoning model spends ten thousand deltas on a paragraph, and a paragraph is what it meant.
 * Each block carries the `seq` of its last event, so asking for what came after one block
 * picks up exactly where it left off.
 *
 * @param events Events in `seq` order, from `history` or collected from `watch`.
 */
export function fold(events: RunEvent[]): RunEvent[] {
  const blocks: RunEvent[] = [];
  // The text of the block still open, accumulated rather than re-concatenated. Rebuilding the
  // block object per delta — a spread and a join of everything so far — is the same paragraph
  // built ten thousand times to produce it once.
  let parts: string[] = [];
  const close = () => {
    if (!parts.length) return;
    const last = blocks[blocks.length - 1];
    if (parts.length > 1) last.text = parts.join("");
    parts = [];
  };

  for (const event of events) {
    const last = blocks[blocks.length - 1];
    const mergeable = event.kind === "thinking" || event.kind === "output";
    if (last && mergeable && last.kind === event.kind && last.step === event.step) {
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
      if (mergeable) parts.push(event.text);
    }
  }
  close();
  return blocks;
}
