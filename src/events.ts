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

/** How many events one run keeps for a watcher that joins late. A chatty run loses its oldest. */
const MAX_EVENTS = 1000;
/**
 * How far past the cap the backlog is allowed to run before it is trimmed.
 *
 * Dropping the oldest event on every push means shifting a thousand-element array tens of
 * thousands of times over a reasoning run — the one thing in here that would ever show up in a
 * profile. Trimming in batches makes it a few dozen splices instead, at the cost of the backlog
 * sometimes being a little longer than the cap, which nothing depends on.
 */
const TRIM_SLACK = 256;
/** How long a finished run stays readable, for a watcher that arrives just after the end. */
const RETAIN_MS = 60_000;

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
  const deadline = Date.now() - RETAIN_MS;
  for (const [runId, stream] of streams) {
    if (stream.listeners.size === 0 && stream.touched <= deadline) streams.delete(runId);
  }
  scheduleSweep();
}

function scheduleSweep() {
  if (sweeping || streams.size === 0) return;
  sweeping = setTimeout(sweep, RETAIN_MS);
  sweeping.unref?.();
}

/**
 * Forgets a run that will not be emitting `done` — one whose process is tearing down, or whose
 * loop threw where it could not be caught. The sweep gets there on its own; this is for a
 * caller that already knows.
 */
export function endRun(runId: string) {
  streams.delete(runId);
}

/** Records one event and hands it to everyone watching that run. Never throws at the caller. */
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
  if (stream.events.length > MAX_EVENTS + TRIM_SLACK) {
    stream.events.splice(0, stream.events.length - MAX_EVENTS);
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
 */
export async function* watch(runId: string): AsyncGenerator<RunEvent> {
  const stream = streamFor(runId);
  // A cursor rather than `shift()`. Draining a backlog an event at a time off the front of an
  // array is a copy of the whole array per event, which on the ten-thousand-delta run this bus
  // is built for is the one quadratic left in the file. The prefix behind the cursor is dropped
  // in one `slice` per `MAX_EVENTS` instead — the same amortised trade the bus itself makes.
  let queue: RunEvent[] = [...stream.events];
  let head = 0;
  let dropped = 0;
  let wake: (() => void) | null = null;
  const listener = (event: RunEvent) => {
    queue.push(event);
    // The bus caps its own backlog at `MAX_EVENTS`; without this the watcher downstream of it
    // had no cap at all, so a client too slow to keep up held every delta a run ever emitted.
    // The oldest go, which is what the backlog does, and the gap is reported once below.
    //
    // Dropped here means released here. Advancing the cursor alone left the dropped events in
    // the slots behind it, to be freed by the compaction in the drain below — which a consumer
    // that has stalled does not reach, and a stalled consumer is the whole reason for the cap.
    // It read as capped and held every event anyway: 16MB where the cap promises a third of one.
    const cut = queue.length - head - MAX_EVENTS;
    if (cut > TRIM_SLACK) {
      queue = queue.slice(head + cut);
      head = 0;
      dropped += cut;
    }
    wake?.();
  };
  stream.listeners.add(listener);
  try {
    for (;;) {
      while (head < queue.length) {
        const event = queue[head++];
        // What is behind the cursor is released rather than left there. Resetting only on catch-up
        // was not enough: a watcher that keeps pace but never quite empties the queue never
        // reaches that branch, and the array grows by a slot per event for the length of the run.
        if (head === queue.length) {
          queue = [];
          head = 0;
        } else if (head > MAX_EVENTS) {
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
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  } finally {
    stream.listeners.delete(listener);
    // A watcher can name a run that has not started, or will never start. Nothing was recorded
    // under it, so nothing is left behind either — and a run that has ended has nothing more to
    // say to anyone, so the last watcher leaving takes the backlog with it.
    if (stream.listeners.size === 0 && (stream.ended || stream.events.length === 0)) {
      streams.delete(runId);
    }
  }
}

/** The backlog alone, for a caller that wants a snapshot rather than a subscription. */
export const history = (runId: string): RunEvent[] => [...(streams.get(runId)?.events ?? [])];

/**
 * Test seam: forget every run, so one test's events cannot be read by the next.
 *
 * Named for what it forgets rather than bare `reset`, which sat in a consumer's imports beside
 * `resetAll`, `resetClients`, `resetCapabilities` and `resetHints` saying nothing about which
 * of the five it was — `reset.ts` had to alias it on the way in to stay readable.
 */
export const resetEvents = () => {
  streams.clear();
  if (sweeping) clearTimeout(sweeping);
  sweeping = null;
};

/**
 * Consecutive tokens of one kind are one thing being said, not hundreds of things.
 *
 * A client that reads a run in snapshots rather than token by token wants it that way: a
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
