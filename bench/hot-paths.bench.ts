import { bench, describe } from "vitest";
import { emit, fold, resetEvents, watch } from "../src/events.ts";
import { requestTokens } from "../src/retry.ts";
import { relaxTools, sanitizeTools } from "../src/schema-compat.ts";
import { deltas, mcpTools, streamingBody, transcript } from "./fixtures.ts";

/**
 * The four places the loop spends time that are not the request.
 *
 * Each of these sits on a path a run takes per turn or per token, so the question a bench answers
 * here is not "is this fast" but "does this scale with the run". They exist to be read before and
 * after a change: a change that does not move its own bench is a change to drop.
 */

describe("schema-compat", () => {
  const declared = sanitizeTools(mcpTools());

  // The documented per-request call once `strictSchemas` has latched off. See README's turn.
  bench("relaxTools over 25 MCP schemas", () => {
    relaxTools(declared);
  });

  // The once-per-connection call, already memoised — the baseline a cached relax should approach.
  bench("sanitizeTools over 25 MCP schemas (cached)", () => {
    sanitizeTools(declared);
  });
});

describe("retry", () => {
  const body = streamingBody(transcript(), sanitizeTools(mcpTools()));

  bench("requestTokens over a 40-turn transcript", () => {
    requestTokens(body);
  });
});

describe("events", () => {
  const events = deltas();

  bench("fold over 20k deltas", () => {
    fold(events);
  });

  // `emit` is the only thing in the package that runs once per streamed token, so its per-call
  // cost is multiplied by the length of a reasoning turn — which made it, not the drain, the
  // bulk of what a combined watch bench was measuring. Split out so each is readable.
  bench("emit 10k deltas", () => {
    resetEvents();
    for (let i = 0; i < 10_000; i++) emit("bench", { kind: "thinking", text: "token " });
  });

  // The same emits plus a full drain, so the drain is the difference between the two. It cannot
  // be timed alone: a per-iteration setup is not something tinybench offers — its `setup` runs
  // once, and every iteration after the first would find an empty stream and wait on it forever.
  bench("emit and drain 10k deltas", async () => {
    resetEvents();
    for (let i = 0; i < 10_000; i++) emit("drain", { kind: "thinking", text: "token " });
    emit("drain", { kind: "done", ok: true });
    for await (const _ of watch("drain")) {
    }
  });
});
