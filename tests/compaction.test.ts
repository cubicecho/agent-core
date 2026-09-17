import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  applyCompaction,
  compactTranscript,
  planCompaction,
  pruneToolResults,
  requestIndex,
  runCompaction,
  SUMMARY_LEAD,
  summaryInput,
} from "../src/compaction.ts";
import { turnMessages } from "../src/hooks.ts";

type Message = OpenAI.ChatCompletionMessageParam;

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });
const result = (content: string): Message => ({ role: "tool", tool_call_id: "c", content });
/** Every message costs ten, so the arithmetic below can be read off the counts. */
const estimate = () => 10;

describe("pruneToolResults", () => {
  it("clears all but the latest results, and says how much was there", () => {
    const big = "x".repeat(10412);
    const messages = [user("q"), result(big), result(big), result(big)];
    const pruned = pruneToolResults(messages, { keepLast: 2 });
    expect(pruned.map((m) => m.content)).toEqual(["q", "[result cleared, 10,412 chars]", big, big]);
    expect(messages[1].content).toBe(big);
  });

  it("keeps short results, and hands back the same array when nothing changed", () => {
    const messages = [result("short"), result("short"), result("x".repeat(300))];
    expect(pruneToolResults(messages, { keepLast: 1 })).toBe(messages);
  });

  it("does not clear a stub again", () => {
    const messages = [result("x".repeat(1000)), result("y")];
    const once = pruneToolResults(messages, { keepLast: 1, maxChars: 10 });
    expect(pruneToolResults(once, { keepLast: 1, maxChars: 10 })).toBe(once);
  });
});

describe("planCompaction", () => {
  const long = [
    { role: "system", content: "prompt" } as Message,
    user("1"),
    assistant("a"),
    user("2"),
    assistant("b"),
    user("3"),
    assistant("c"),
    user("4"),
    assistant("d"),
  ];

  it("leaves a transcript alone until the window is filling", () => {
    expect(planCompaction(long, { limit: 200, estimate })).toBeUndefined();
    expect(planCompaction(long, { limit: 0, used: 1e6, estimate })).toBeUndefined();
  });

  it("keeps the system prompt and cuts on a user message", () => {
    // 90 of 100 used; the tail may fill 35, so three messages fit and the cut moves onto `4`.
    const plan = planCompaction(long, { limit: 100, estimate });
    expect(plan).toMatchObject({ from: 1, cut: 7 });
    expect(plan?.toSummarise).toEqual(long.slice(1, 7));
  });

  it("weighs the transcript at the characters per token it is given", () => {
    const wordy = [
      user("x".repeat(100)),
      ...long.slice(1).map((m) => ({ ...m, content: "x".repeat(100) }) as Message),
    ];
    // About 290 tokens at four characters each, under the mark on a 500 window; twice that at two.
    expect(planCompaction(wordy, { limit: 500 })).toBeUndefined();
    expect(planCompaction(wordy, { limit: 500, charsPerToken: 2 })).toBeDefined();
  });

  it("trusts a reported count over the estimate", () => {
    expect(planCompaction(long, { limit: 1000, used: 800, estimate })).toBeDefined();
  });

  it("does not fold too little to pay for the summary", () => {
    expect(
      planCompaction([user("1"), assistant("a"), user("2")], { limit: 10, estimate }),
    ).toBeUndefined();
  });

  it("continues an earlier summary rather than summarising it", () => {
    const again = [
      { role: "system", content: "prompt" } as Message,
      { role: "system", content: `${SUMMARY_LEAD}they like tea` } as Message,
      ...long.slice(1),
    ];
    const plan = planCompaction(again, { limit: 100, estimate });
    expect(plan).toMatchObject({ from: 2, previous: "they like tea" });
    if (!plan) throw new Error("expected a plan");
    expect(summaryInput(plan)).toMatch(/^Notes so far:\nthey like tea\n\nContinue them/);
  });
});

describe("summaryInput", () => {
  it("renders roles and text, a call by its name, and caps a message", () => {
    const text = summaryInput({
      from: 0,
      cut: 2,
      toSummarise: [
        user("y".repeat(5000)),
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }],
        },
      ],
    });
    expect(text).toBe(`user: ${"y".repeat(4000)}\n\nassistant: read({})`);
  });
});

describe("compactTranscript", () => {
  const messages: Message[] = [
    { role: "system", content: "prompt" },
    { role: "system", content: `${SUMMARY_LEAD}old` },
    user("1"),
    assistant("a"),
    user("2"),
  ];
  const plan = { from: 2, cut: 4, toSummarise: messages.slice(2, 4), previous: "old" };

  it("replaces the stretch and any earlier summary with the new one, and tells the hooks", async () => {
    const run = vi.fn(async () => []);
    const summarise = vi.fn(async (_text: string) => " new notes ");
    const out = await compactTranscript(messages, plan, summarise, {
      hooks: { run: run as never, context: { session: { id: "s" } } },
    });
    expect(out).toEqual([
      { role: "system", content: "prompt" },
      { role: "system", content: `${SUMMARY_LEAD}new notes` },
      user("2"),
    ]);
    expect(summarise.mock.calls[0][0]).toContain("Notes so far:\nold");
    expect(run).toHaveBeenCalledWith(
      "beforeCompact",
      expect.objectContaining({
        range: { from: 2, through: 4 },
        compacting: [
          expect.objectContaining({ speaker: "user", text: "1" }),
          expect.objectContaining({ speaker: "assistant", text: "a" }),
        ],
      }),
      expect.anything(),
    );
  });

  describe("a veto", () => {
    const vetoing = () =>
      vi.fn(async () => [
        { serverId: "m", label: "Memory", hookId: "file", event: "beforeCompact", ok: true },
        {
          serverId: "g",
          label: "Guard",
          hookId: "keep",
          event: "beforeCompact",
          ok: true,
          veto: true,
        },
        {
          serverId: "b",
          label: "Broken",
          hookId: "x",
          event: "beforeCompact",
          ok: false,
          veto: true,
          error: "down",
        },
      ]);

    it("is ignored unless the host asks, and the summary is written beside the hooks", async () => {
      let hooksDone = false;
      const run = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        hooksDone = true;
        return [
          {
            serverId: "g",
            label: "Guard",
            hookId: "keep",
            event: "beforeCompact",
            ok: true,
            veto: true,
          },
        ];
      });
      const summarise = vi.fn(async () => {
        expect(hooksDone).toBe(false);
        return "notes";
      });
      const out = await compactTranscript(messages, plan, summarise, {
        hooks: { run: run as never, context: { session: { id: "s" } } },
      });
      expect(out).not.toBe(messages);
      expect(summarise).toHaveBeenCalledOnce();
    });

    it("leaves the transcript alone, writes no summary, and names the hook", async () => {
      const summarise = vi.fn(async () => "notes");
      const heard: unknown[] = [];
      const out = await compactTranscript(messages, plan, summarise, {
        hooks: {
          run: vetoing() as never,
          context: { session: { id: "s" } },
          onNote: (note) => heard.push(note),
          honourVeto: true,
        },
      });
      expect(out).toBe(messages);
      expect(summarise).not.toHaveBeenCalled();
      expect(heard).toEqual([
        { event: "beforeCompact", source: "Guard", hookId: "keep", veto: true },
        { event: "beforeCompact", source: "Broken", hookId: "x", error: "down" },
      ]);
    });

    it("waits for the hooks and goes ahead when none of them vetoes", async () => {
      const order: string[] = [];
      const run = vi.fn(async () => {
        order.push("hooks");
        return [
          { serverId: "m", label: "Memory", hookId: "file", event: "beforeCompact", ok: true },
        ];
      });
      const summarise = vi.fn(async () => {
        order.push("summary");
        return "notes";
      });
      const out = await compactTranscript(messages, plan, summarise, {
        hooks: { run: run as never, context: { session: { id: "s" } }, honourVeto: true },
      });
      expect(order).toEqual(["hooks", "summary"]);
      expect(out.at(1)).toEqual({ role: "system", content: `${SUMMARY_LEAD}notes` });
    });

    it("does not stop a compaction forced by an overflow", async () => {
      const summarise = vi.fn(async () => "notes");
      const heard: unknown[] = [];
      const out = await compactTranscript(messages, plan, summarise, {
        hooks: {
          run: vetoing() as never,
          context: { session: { id: "s" } },
          onNote: (note) => heard.push(note),
          honourVeto: true,
        },
        forced: true,
      });
      expect(out).not.toBe(messages);
      expect(summarise).toHaveBeenCalledOnce();
      expect(heard).toEqual([
        { event: "beforeCompact", source: "Broken", hookId: "x", error: "down" },
      ]);
    });
  });

  it("folds nothing on an empty summary", async () => {
    expect(await compactTranscript(messages, plan, async () => "  ")).toBe(messages);
  });
});

/**
 * A host that keeps its transcript append-only and its fold on the session row: no system prompt
 * in the array, no summary message in it either, and the indexes below are the stored ones.
 */
describe("a stored fold", () => {
  /** Twelve messages, user on the even indexes. */
  const stored: Message[] = Array.from({ length: 12 }, (_, at) =>
    at % 2 === 0 ? user(`q${at}`) : assistant(`a${at}`),
  );
  const window = { limit: 100, used: 100, estimate };

  it("plans from where the caller says the last fold ended", () => {
    const plan = planCompaction(stored, { ...window, from: 6, previous: "first notes" });
    expect(plan).toMatchObject({ from: 6, cut: 10, previous: "first notes" });
    expect(plan?.toSummarise).toEqual(stored.slice(6, 10));
  });

  it("plans the same cut the scan finds for the same transcript rebuilt", () => {
    const scanned = [
      { role: "system", content: "prompt" } as Message,
      { role: "system", content: `${SUMMARY_LEAD}they like tea` } as Message,
      ...stored,
    ];
    const byScan = planCompaction(scanned, window);
    const byHand = planCompaction(stored, { ...window, from: 0, previous: "they like tea" });
    expect(byScan).toMatchObject({ from: 2, previous: "they like tea" });
    expect(byHand).toMatchObject({ from: 0, previous: "they like tea" });
    // The two arrays differ by the two system messages at the head, and so do the cuts.
    expect(byScan?.cut).toBe((byHand?.cut ?? 0) + 2);
    expect(byScan?.toSummarise).toEqual(byHand?.toSummarise);
    if (!byScan || !byHand) throw new Error("expected two plans");
    expect(summaryInput(byScan)).toBe(summaryInput(byHand));
  });

  it("records the fold compactTranscript would have applied", async () => {
    const plan = planCompaction(stored, { ...window, from: 0 });
    if (!plan) throw new Error("expected a plan");
    const summarise = async () => " first notes ";
    const record = await runCompaction(stored, plan, summarise);
    expect(record).toMatchObject({ summary: "first notes", through: plan.cut });
    expect(Date.parse(record?.at ?? "")).not.toBeNaN();
    expect(applyCompaction(stored, record, { from: plan.from })).toEqual(
      await compactTranscript(stored, plan, summarise),
    );
  });

  it("stores nothing when a hook vetoes or the summary comes back empty", async () => {
    const plan = { from: 0, cut: 2, toSummarise: stored.slice(0, 2) };
    expect(await runCompaction(stored, plan, async () => "   ")).toBeUndefined();
    const run = vi.fn(async () => [
      {
        serverId: "g",
        label: "Guard",
        hookId: "keep",
        event: "beforeCompact",
        ok: true,
        veto: true,
      },
    ]);
    const record = await runCompaction(stored, plan, async () => "notes", {
      hooks: { run: run as never, context: { session: { id: "s" } }, honourVeto: true },
    });
    expect(record).toBeUndefined();
  });

  it("rebuilds a request the next plan can read its own summary out of", async () => {
    // Cut by hand at six, so the tail is still long enough to need folding a second time.
    const first = { from: 0, cut: 6, toSummarise: stored.slice(0, 6) };
    const record = await runCompaction(stored, first, async () => "first notes");
    if (!record) throw new Error("expected a record");
    expect(record.through).toBe(6);

    const request = applyCompaction(stored, record);
    expect(request).toEqual([
      { role: "system", content: `${SUMMARY_LEAD}first notes` },
      ...stored.slice(6),
    ]);
    expect(applyCompaction(stored, undefined)).toBe(stored);

    // The same second fold, planned over the request by scanning and over the transcript by hand.
    const scanned = planCompaction(request, window);
    const byHand = planCompaction(stored, {
      ...window,
      from: record.through,
      previous: record.summary,
    });
    expect(scanned?.previous).toBe("first notes");
    expect(byHand?.previous).toBe("first notes");
    expect(scanned?.toSummarise).toEqual(byHand?.toSummarise);
    expect(requestIndex(byHand?.cut ?? 0, record)).toBe(scanned?.cut);
    // Continued, not summarised again: the notes lead the summariser's input.
    if (!byHand) throw new Error("expected a plan");
    expect(summaryInput(byHand)).toMatch(/^Notes so far:\nfirst notes\n\nContinue them/);
  });

  it("keeps a message's uuid across a fold when the numbering follows the store", async () => {
    const record = { summary: "first notes", through: 6, at: "" };
    const request = applyCompaction(stored, record);
    const before = turnMessages("s", stored, 6, 8);
    const after = turnMessages("s", request, requestIndex(6, record), requestIndex(8, record), {
      offset: record.through - 1,
    });
    expect(after).toEqual(before);
    // Without it, the same two messages arrive as two new memories.
    expect(turnMessages("s", request, 1, 3)[0].uuid).not.toBe(before[0].uuid);
  });

  it("maps a stored index onto the request the fold left", () => {
    const record = { through: 6 };
    expect(requestIndex(7, undefined)).toBe(7);
    expect(requestIndex(6, record)).toBe(1);
    expect(requestIndex(11, record)).toBe(6);
    // Inside the folded stretch, the summary message is what now stands for it.
    expect(requestIndex(2, record)).toBe(0);
    // A host that keeps its system prompt in the array says how much sits ahead of the summary.
    expect(requestIndex(6, record, 1)).toBe(2);
  });
});
