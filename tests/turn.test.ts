import type OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { capabilitiesFor, negotiate, resetCapabilities } from "../src/capabilities.ts";
import { streamTurn } from "../src/stream.ts";

/**
 * `negotiate` wrapping `streamTurn` is the whole of a turn. Both are useful alone; this is the
 * shape every consumer actually builds, and the seam between them is a flag that used to have
 * to be passed to each of them separately.
 */

const chunk = (partial: unknown) => partial as OpenAI.ChatCompletionChunk;
const text = (content: string) => chunk({ choices: [{ delta: { content } }] });
const NO_GRAMMAR = new Error("Failed to initialize samplers: failed to parse grammar");

/** A server that refuses the first request, in the words llama.cpp uses, then answers. */
const refusesOnce = (words: string[], { after }: { after: number }) => {
  let attempt = 0;
  return vi.fn(async () => {
    const failing = ++attempt === 1;
    return {
      async *[Symbol.asyncIterator]() {
        for (const word of words.slice(0, failing ? after : words.length)) yield text(word);
        if (failing) throw NO_GRAMMAR;
      },
    };
  });
};

const clientOf = (create: unknown) => ({ chat: { completions: { create } } }) as unknown as OpenAI;
const body = {} as OpenAI.ChatCompletionCreateParamsStreaming;

beforeEach(() => resetCapabilities());

describe("negotiate ∘ streamTurn", () => {
  it("relaxes the schemas and re-sends when the server cannot build a grammar", async () => {
    const supports = capabilitiesFor("http://local/v1");
    const asked: boolean[] = [];
    const create = refusesOnce(["hi"], { after: 0 });
    const turn = await negotiate(supports, (supports, produced) => {
      asked.push(supports.strictSchemas);
      return streamTurn(clientOf(create), body, { produced });
    });

    expect(turn.content).toBe("hi");
    expect(asked).toEqual([true, false]);
    expect(supports.strictSchemas).toBe(false);
  });

  it("does not re-send a turn whose tokens are already out", async () => {
    // The trap this closes. `produced` is one box per attempt: `streamTurn` sets it and the
    // re-send reads it. When each of them had to be handed the flag separately, a caller that
    // gave it to only one got a turn that had already streamed to a watcher sent again, and
    // the watcher saw every token twice — silently, and only against a server that refuses
    // something mid-stream.
    const seen: string[] = [];
    const create = refusesOnce(["half ", "an ", "answer"], { after: 2 });
    await expect(
      negotiate(capabilitiesFor("http://local/v1"), (_supports, produced) =>
        streamTurn(clientOf(create), body, { produced, onOutput: (d) => seen.push(d) }),
      ),
    ).rejects.toThrow("grammar");

    expect(seen).toEqual(["half ", "an "]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("hands an outer retry loop the same flag it hands send", async () => {
    // A caller with its own retry budget has to read the flag after `negotiate` returns, so it
    // can still pass its own box in — and it is the one `send` is given.
    const produced = { any: false };
    const create = refusesOnce(["tokens"], { after: 1 });
    await expect(
      negotiate(
        capabilitiesFor("http://local/v1"),
        (_supports, given) => {
          expect(given).toBe(produced);
          return streamTurn(clientOf(create), body, { produced: given });
        },
        { produced },
      ),
    ).rejects.toThrow("grammar");
    expect(produced.any).toBe(true);
  });

  it("still reports a silent endpoint through the negotiation", async () => {
    vi.useFakeTimers();
    const create = vi.fn(
      (_body: unknown, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const turn = negotiate(capabilitiesFor("http://quiet/v1"), (_supports, produced) =>
      streamTurn(clientOf(create), body, { produced, idleMs: 30_000 }),
    );
    const settled = expect(turn).rejects.toThrow("sent nothing for 30s");
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
    // Not a capability refusal: nothing is latched off on the way past.
    expect(capabilitiesFor("http://quiet/v1")).toMatchObject({
      strictSchemas: true,
      usageInStream: true,
    });
    vi.useRealTimers();
  });
});
