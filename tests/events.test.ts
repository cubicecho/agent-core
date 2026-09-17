import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureEvents,
  emit,
  endRun,
  fold,
  history,
  resetEvents,
  runMetrics,
  watch,
} from "../src/events.ts";
import { LOAD_TOOLS } from "../src/tool-loading.ts";

beforeEach(() => resetEvents());
afterEach(() => {
  resetEvents();
  vi.useRealTimers();
});

describe("emit", () => {
  it("numbers a run's events from one, in order", () => {
    emit("r", { kind: "step", name: "plan" });
    emit("r", { kind: "output", text: "a" });
    emit("r", { kind: "done", ok: true });
    expect(history("r").map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(history("r").every((event) => event.runId === "r")).toBe(true);
  });

  it("does not let a caller file an event under another run or reuse a sequence", () => {
    emit("a", { kind: "output", text: "one" });
    // The type forbids this; a JavaScript caller, or a widened object, does not.
    emit("a", { kind: "output", text: "two", runId: "b", seq: 1 } as never);

    expect(history("a").map((event) => [event.runId, event.seq])).toEqual([
      ["a", 1],
      ["a", 2],
    ]);
    expect(history("b")).toEqual([]);
  });

  it("keeps separate runs' sequences to themselves", () => {
    emit("a", { kind: "output", text: "x" });
    emit("b", { kind: "output", text: "y" });
    expect(history("a")[0].seq).toBe(1);
    expect(history("b")[0].seq).toBe(1);
  });

  it("trims the backlog in batches, back to the cap", () => {
    // 1000 kept, 256 of slack: the 1257th push is the one that trims.
    for (let i = 0; i < 1256; i++) emit("chatty", { kind: "output", text: "x" });
    expect(history("chatty")).toHaveLength(1256);

    emit("chatty", { kind: "output", text: "x" });
    const kept = history("chatty");
    expect(kept).toHaveLength(1000);
    // The oldest went, and the sequence numbers do not restart.
    expect(kept[0].seq).toBe(258);
    expect(kept[kept.length - 1].seq).toBe(1257);
  });
});

describe("watch", () => {
  it("delivers a backlog larger than the bus keeps, in order, without dropping any of it", async () => {
    // Bigger than `MAX_EVENTS + TRIM_SLACK`, so the bus has already trimmed by the time this
    // subscribes: what a watcher joining a long reasoning run actually finds waiting for it.
    for (let i = 0; i < 4000; i++) emit("r", { kind: "thinking", text: `${i}` });
    emit("r", { kind: "done", ok: true });

    const seen: number[] = [];
    for await (const event of watch("r")) {
      if (event.kind === "thinking") seen.push(event.seq);
    }
    expect(seen.length).toBeGreaterThan(0);
    // In order and contiguous. The cursor drain replaced a `shift()`, and an off-by-one there
    // would show up as a hole rather than as a failure anywhere else.
    expect(seen).toEqual(Array.from({ length: seen.length }, (_, i) => seen[0] + i));
  });

  it("tells a watcher that fell behind how much it missed rather than growing forever", async () => {
    const stream = watch("r");
    // Nothing is read until this point, so everything below queues behind the generator.
    const first = stream.next();
    for (let i = 0; i < 3000; i++) emit("r", { kind: "thinking", text: `${i}` });
    emit("r", { kind: "done", ok: true });

    const seen = [await first];
    for (;;) {
      const next = await stream.next();
      if (next.done) break;
      seen.push(next);
    }
    const notices = seen.filter((step) => step.value?.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].value?.text).toMatch(/event\(s\) dropped/);
    // Inside the gap it reports, not on top of the event behind it. `seq` is what a client
    // de-duplicates on, so sharing one made the notice and that event indistinguishable from a
    // repeat and a client doing exactly that threw away one of the two.
    const after = seen[seen.indexOf(notices[0]) + 1];
    expect(notices[0].value?.seq).toBe((after.value?.seq ?? 0) - 1);
    expect(new Set(seen.map((step) => step.value?.seq)).size).toBe(seen.length);
    // Capped rather than unbounded: the watcher inherits the guarantee the bus already has.
    expect(seen.length).toBeLessThan(1500);
  });

  it("releases what it dropped, rather than only declining to deliver it", async () => {
    // The cap is about memory, and the assertion above it is not: a watcher that reports a gap
    // and hands back fewer events can still be holding every one of them. Only a reference can
    // tell the two apart, so hold one to an event that must not survive.
    //
    // `gc` is turned on here rather than by an `execArgv` in the vitest config, which the pool
    // does not pass through, so the flag would have been set and the test would have gone on
    // asserting nothing.
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc") as () => void;

    const stream = watch("r");
    emit("r", { kind: "notice", text: "start" });
    // Subscribes, delivers that one, and parks on the yield. Everything below piles up behind a
    // consumer that has stopped pulling — which is the only case the cap exists for.
    await stream.next();

    // Made in a frame that has returned by the time anything is collected. Written inline, the
    // event stays live in this function's own registers and the assertion fails on correct code.
    const track = () => new WeakRef(emit("r", { kind: "thinking", text: "first" }));
    const dropped = track();
    // Past both caps, so neither the bus's backlog nor the watcher's queue may still name it.
    for (let i = 0; i < 3000; i++) emit("r", { kind: "thinking", text: `${i}` });

    // A `WeakRef` holds its target alive for the rest of the job it was made in, so the two
    // below reclaim nothing at all without a turn of the event loop between them and `track`.
    await new Promise((resolve) => setTimeout(resolve, 0));
    collect();
    collect();
    expect(dropped.deref()).toBeUndefined();

    emit("r", { kind: "done", ok: true });
    for (;;) if ((await stream.next()).done) break;
  });

  it("reads the backlog first, then what happens next, and stops at done", async () => {
    emit("r", { kind: "step", name: "plan" });
    emit("r", { kind: "output", text: "before" });

    const seen: string[] = [];
    const reading = (async () => {
      for await (const event of watch("r")) seen.push(`${event.kind}:${event.text}`);
    })();

    // Let the generator drain the backlog and park on the wait.
    await Promise.resolve();
    emit("r", { kind: "output", text: "after" });
    emit("r", { kind: "done", ok: true });
    await reading;

    expect(seen).toEqual(["step:", "output:before", "output:after", "done:"]);
  });

  it("leaves a live run's backlog behind when a watcher goes away", async () => {
    emit("live", { kind: "output", text: "a" });
    const watcher = watch("live");
    await watcher.next();
    await watcher.return(undefined);
    // The run has not ended, so the next watcher still gets to read what it missed.
    expect(history("live")).toHaveLength(1);
  });
});

describe("watch, cancelled", () => {
  it("lets a watcher out of a run that never says done", async () => {
    emit("live", { kind: "output", text: "a" });
    const stop = new AbortController();
    const watcher = watch("live", stop.signal);

    expect((await watcher.next()).value?.text).toBe("a");
    // Parked here, waiting on a run that has not finished and will not. Returning the generator
    // is not the way out: suspended at an `await` rather than at a `yield`, the return is queued
    // behind a promise only the next event can settle.
    const parked = watcher.next();
    stop.abort();
    expect(await parked).toEqual({ value: undefined, done: true });
  });

  it("stops pinning the stream, so the sweep can reach an abandoned run", async () => {
    vi.useFakeTimers();
    emit("abandoned", { kind: "output", text: "half a thought" });
    const stop = new AbortController();
    const watcher = watch("abandoned", stop.signal);
    await watcher.next();

    // A listener holds the stream past every deadline: the sweep skips any stream one is on, so
    // this is the leak the sweep exists to prevent, arriving by the one route it cannot see.
    vi.advanceTimersByTime(31 * 60_000);
    expect(history("abandoned")).toHaveLength(1);

    const parked = watcher.next();
    stop.abort();
    await parked;
    vi.advanceTimersByTime(31 * 60_000);
    expect(history("abandoned")).toEqual([]);
  });

  it("leaves without replaying the backlog when the signal is already aborted", async () => {
    emit("r", { kind: "output", text: "a" });
    expect(await watch("r", AbortSignal.abort()).next()).toEqual({ value: undefined, done: true });
  });

  it("stops mid-backlog rather than finishing the queue it already holds", async () => {
    for (let i = 0; i < 5; i++) emit("r", { kind: "output", text: `${i}` });
    const stop = new AbortController();
    const seen: string[] = [];
    for await (const event of watch("r", stop.signal)) {
      seen.push(event.text);
      if (seen.length === 2) stop.abort();
    }
    expect(seen).toEqual(["0", "1"]);
  });

  it("ends on done as it always did, with a signal that never fires", async () => {
    emit("r", { kind: "output", text: "a" });
    emit("r", { kind: "done", ok: true });
    const stop = new AbortController();
    const seen: string[] = [];
    for await (const event of watch("r", stop.signal)) seen.push(event.kind);
    expect(seen).toEqual(["output", "done"]);
  });
});

describe("cleanup", () => {
  it("forgets a finished run whose watcher was still reading when retention lapsed", async () => {
    vi.useFakeTimers();
    emit("late", { kind: "output", text: "a" });
    emit("late", { kind: "done", ok: true });
    vi.advanceTimersByTime(30_000);

    // A slow client: attached inside the retention window, still attached when it closes. The
    // cleanup used to fire once, find a listener, delete nothing and never reschedule — and
    // the watcher leaving could not finish the job either, because the run had events.
    const watcher = watch("late");
    const seen: string[] = [];
    seen.push((await watcher.next()).value?.kind as string);
    vi.advanceTimersByTime(40_000);
    seen.push((await watcher.next()).value?.kind as string);
    await watcher.next();

    expect(seen).toEqual(["output", "done"]);
    expect(history("late")).toEqual([]);
  });

  it("forgets a run on request", () => {
    emit("doomed", { kind: "output", text: "a" });
    endRun("doomed");
    expect(history("doomed")).toEqual([]);
  });

  it("forgets a run that dies without ever saying done", () => {
    vi.useFakeTimers();
    emit("abandoned", { kind: "output", text: "half a thought" });
    expect(history("abandoned")).toHaveLength(1);

    // On the unfinished run's much longer clock: a minute of quiet is a slow tool call, not a
    // death, and the run below depends on the difference.
    vi.advanceTimersByTime(31 * 60_000);
    expect(history("abandoned")).toEqual([]);
  });

  it("keeps a live run that has simply gone quiet, and its sequence with it", () => {
    vi.useFakeTimers();
    emit("slow", { kind: "output", text: "before the tool call" });

    // Nobody watching, nothing emitted: one long MCP call, well past a finished run's retention.
    vi.advanceTimersByTime(5 * 60_000);

    expect(history("slow")).toHaveLength(1);
    // The backlog surviving is the smaller half. A fresh stream would restart `seq` at 1, and
    // `seq` is what a reconnecting client de-duplicates on — it would drop this as one it had.
    expect(emit("slow", { kind: "output", text: "after" }).seq).toBe(2);
  });

  it("completes a watcher it is ending the run under", async () => {
    const seen: string[] = [];
    let finished = false;
    const drained = (async () => {
      for await (const event of watch("cut")) seen.push(event.kind);
      finished = true;
    })();

    emit("cut", { kind: "output", text: "a" });
    await vi.waitFor(() => expect(seen).toEqual(["output"]));

    // The loop threw where it could not be caught. A watcher parked on the next event has no
    // emit coming to wake it, so ending the run has to be the thing that does.
    endRun("cut");
    await drained;

    expect(finished).toBe(true);
    expect(seen).toEqual(["output", "done"]);
  });

  it("does not forget a run that is still being watched", async () => {
    vi.useFakeTimers();
    const watcher = watch("live");
    const first = watcher.next();
    emit("live", { kind: "output", text: "a" });
    await first;

    vi.advanceTimersByTime(10 * 60_000);
    expect(history("live")).toHaveLength(1);

    await watcher.return(undefined);
  });
});

describe("configureEvents", () => {
  it("caps a run's backlog at the number it was given", () => {
    configureEvents({ maxEvents: 4, trimSlack: 1 });
    for (let n = 0; n < 20; n++) emit("chatty", { kind: "output", text: `${n}` });
    // Trimmed in batches, as at the default: the backlog runs to the cap plus the slack and is
    // cut back to the cap, so what is left is the four most recent rather than five.
    expect(history("chatty").map((event) => event.seq)).toEqual([17, 18, 19, 20]);
  });

  it("reaps an unfinished run on the clock it was given", () => {
    vi.useFakeTimers();
    // A consumer whose tool calls are minutes rather than hours wants its abandoned runs back
    // sooner than the half-hour assumed here.
    configureEvents({ retainUnendedMs: 60_000 });
    emit("abandoned", { kind: "output", text: "half a thought" });
    vi.advanceTimersByTime(60_000);
    expect(history("abandoned")).toEqual([]);
  });

  it("changes only what it was handed a number for", () => {
    const before = configureEvents();
    const after = configureEvents({ retainMs: 5_000 });
    expect(after).toEqual({ ...before, retainMs: 5_000 });
  });

  it("keeps what it has rather than taking a number that is not one", () => {
    // A half-built config — a `0` standing in for "no opinion", a parsed env var that came back
    // `NaN` — must not turn the backlog off. Nothing here has a meaningful zero.
    expect(configureEvents({ maxEvents: 0, retainMs: -1, trimSlack: Number.NaN })).toEqual(
      configureEvents(),
    );
    expect(configureEvents().maxEvents).toBe(1000);
  });

  it("is undone by a reset, so one test's cap is not the next one's", () => {
    configureEvents({ maxEvents: 4, retainMs: 5_000 });
    resetEvents();
    expect(configureEvents()).toEqual({
      maxEvents: 1000,
      trimSlack: 256,
      retainMs: 60_000,
      retainUnendedMs: 30 * 60_000,
    });
  });
});

describe("fold", () => {
  it("merges consecutive tokens of one kind into one block", () => {
    emit("r", { kind: "output", text: "he", step: "s" });
    emit("r", { kind: "output", text: "llo", step: "s" });
    emit("r", { kind: "done", ok: true, step: "s" });

    const blocks = fold(history("r"));
    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ["output", "hello"],
      ["done", ""],
    ]);
    // The block carries the seq of its last event, so a caller can ask for what came after.
    expect(blocks[0].seq).toBe(2);
  });

  it("does not merge two blocks that belong to different steps", () => {
    // The fix merged in from task_server: same kind, same run, different step is two things.
    emit("r", { kind: "output", text: "first", step: "one" });
    emit("r", { kind: "output", text: "second", step: "two" });
    expect(fold(history("r")).map((block) => block.text)).toEqual(["first", "second"]);
  });

  it("does not merge across a different kind", () => {
    emit("r", { kind: "output", text: "a" });
    emit("r", { kind: "thinking", text: "b" });
    emit("r", { kind: "output", text: "c" });
    expect(fold(history("r")).map((block) => block.text)).toEqual(["a", "b", "c"]);
  });

  it("hands back its own blocks rather than the bus's events", () => {
    emit("r", { kind: "output", text: "a" });
    emit("r", { kind: "thinking", text: "b" });

    const blocks = fold(history("r"));
    blocks[0].text = "REDACTED";
    expect(history("r").map((event) => event.text)).toEqual(["a", "b"]);
  });
});

describe("runMetrics", () => {
  it("counts nothing and measures nothing for a run with no turns", () => {
    const metrics = runMetrics([]);
    expect(metrics).toEqual({
      steps: 0,
      turns: 0,
      requests: 0,
      toolCalls: 0,
      toolErrors: {},
      loadCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cacheBreaks: 0,
      cacheBreakReasons: {},
      truncatedTurns: 0,
    });
  });

  it("sums a run's turns, times its tools and weighs what only some turns reported", () => {
    vi.useFakeTimers({ now: 1000 });
    const at = (ms: number) => vi.setSystemTime(1000 + ms);
    emit("r", { kind: "step", name: "plan" });
    emit("r", {
      kind: "usage",
      usage: {
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
        turn: {
          prompt: 100,
          completion: 10,
          total: 110,
          cached: 0,
          uncached: 100,
          wallMs: 900,
          firstTokenMs: 300,
          promptMs: 200,
          draftTotal: 10,
          draftAccepted: 5,
          finishReason: "tool_calls",
        },
      },
    });
    at(100);
    emit("r", { kind: "tool-call", name: LOAD_TOOLS });
    emit("r", { kind: "tool-call", name: "read" });
    at(150);
    emit("r", { kind: "tool-result", name: LOAD_TOOLS, ok: true });
    at(400);
    emit("r", { kind: "tool-result", name: "read", ok: false });
    emit("r", {
      kind: "usage",
      usage: {
        promptTokens: 400,
        completionTokens: 30,
        totalTokens: 430,
        turn: {
          prompt: 300,
          completion: 20,
          total: 320,
          cached: 30,
          uncached: 270,
          wallMs: 1200,
          firstTokenMs: 500,
          continuations: 1,
          cacheBroken: true,
          cacheBreakReason: "tools-changed",
          finishReason: "length",
        },
      },
    });
    // A turn from a server that says nothing of its cache or its timings.
    emit("r", {
      kind: "usage",
      usage: {
        promptTokens: 400,
        completionTokens: 30,
        totalTokens: 430,
        turn: { prompt: 500, completion: 5, total: 505, cached: 0, finishReason: "stop" },
      },
    });
    at(2000);
    emit("r", { kind: "done", ok: true });

    const metrics = runMetrics(history("r"), { contextLength: 1000 });
    expect(metrics).toMatchObject({
      steps: 1,
      turns: 3,
      requests: 4,
      toolCalls: 2,
      toolErrors: { read: 1 },
      loadCalls: 1,
      promptTokens: 900,
      completionTokens: 35,
      cachedTokens: 30,
      uncachedTokens: 370,
      cacheBreaks: 1,
      cacheBreakReasons: { "tools-changed": 1 },
      truncatedTurns: 1,
      wallMs: 2000,
      promptMs: 200,
      toolMs: 350,
      slowestTurnMs: 1200,
      firstTokenMs: 400,
      draftTotal: 10,
      draftAccepted: 5,
      draftAcceptance: 0.5,
      largestPrompt: 500,
      largestPromptShare: 0.5,
      outcome: "answered",
    });
    // Over the 400 prompt tokens whose cache was reported, not the 900 of all of them.
    expect(metrics.cacheHitRatio).toBeCloseTo(30 / 400);
    // No turn reported these, so nothing is made up for them.
    expect(metrics).not.toHaveProperty("reasoningTokens");
    expect(metrics).not.toHaveProperty("predictedMs");
  });

  it("reads the outcome off the last turn and the run's end", () => {
    const turn = (finishReason: string) => ({
      kind: "usage" as const,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        turn: { prompt: 0, completion: 0, total: 0, cached: 0, finishReason },
      },
    });
    emit("cut", turn("length"));
    emit("cut", { kind: "done", ok: true });
    expect(runMetrics(history("cut")).outcome).toBe("truncated");
    emit("broke", turn("stop"));
    emit("broke", { kind: "done", ok: false });
    expect(runMetrics(history("broke")).outcome).toBe("failed");
    emit("running", turn("stop"));
    expect(runMetrics(history("running"))).not.toHaveProperty("outcome");
  });

  it("ignores usage a caller emitted without a turn report", () => {
    emit("r", { kind: "usage", usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } });
    expect(runMetrics(history("r"))).toMatchObject({ turns: 0, promptTokens: 0 });
  });
});
