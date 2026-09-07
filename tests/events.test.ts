import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit, endRun, fold, history, resetEvents, watch } from "../src/events.ts";

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

    vi.advanceTimersByTime(2 * 60_000 + 1);
    expect(history("abandoned")).toEqual([]);
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
