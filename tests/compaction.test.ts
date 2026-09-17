import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  compactTranscript,
  planCompaction,
  pruneToolResults,
  SUMMARY_LEAD,
  summaryInput,
} from "../src/compaction.ts";

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
