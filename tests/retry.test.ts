import OpenAI from "openai";
import { expect, test } from "vitest";
import {
  backoffMs,
  ContextOverflow,
  compact,
  EndpointSilent,
  isOverflow,
  isTransient,
  requestTokens,
  sleep,
} from "../src/retry.ts";

/** An `APIError` as the SDK raises it, with only the status this cares about set. */
const apiError = (status: number) =>
  new OpenAI.APIError(status, { error: { message: "nope" } }, "nope", undefined);

test("a lost or refused request is worth sending again; a complaint about it is not", () => {
  expect(isTransient(new EndpointSilent("went quiet"))).toBe(true);
  expect(isTransient(new OpenAI.APIConnectionError({ message: "ECONNREFUSED" }))).toBe(true);
  expect(isTransient(apiError(429))).toBe(true);
  expect(isTransient(apiError(503))).toBe(true);

  // A 400 for a malformed tool schema fails the same way every time.
  expect(isTransient(apiError(400))).toBe(false);
  expect(isTransient(apiError(404))).toBe(false);
  expect(isTransient(new Error("something else"))).toBe(false);
  // Its own class precisely so nothing retries it.
  expect(isTransient(new ContextOverflow("too big"))).toBe(false);
});

test("backoff grows, stays under the cap, and is never two identical waits", () => {
  const waits = [0, 1, 2, 3, 9].map(backoffMs);
  for (const wait of waits) expect(wait).toBeLessThanOrEqual(8000);
  // Jittered into the top half of each step, so the steps stay ordered but two tasks failing
  // together do not come back in lockstep.
  expect(backoffMs(0)).toBeGreaterThanOrEqual(250);
  expect(backoffMs(3)).toBeGreaterThanOrEqual(2000);
});

test("sleeping is cut short by an abort rather than run out", async () => {
  const controller = new AbortController();
  const waited = sleep(60_000, controller.signal);
  controller.abort(new Error("stopped"));
  await expect(waited).rejects.toThrow("stopped");
});

test("a server's own words for an over-long request are read as one", () => {
  expect(isOverflow("This model's maximum context length is 8192 tokens")).toBe(true);
  expect(isOverflow("the request exceeds the available context size (2000 tokens)")).toBe(true);
  // "Too long" about anything but the window is somebody else's error.
  expect(isOverflow("string too long for field name")).toBe(false);
  expect(isOverflow("rate limit exceeded")).toBe(false);
});

test("a request is sized from what is actually sent, tools included", () => {
  const messages = [{ role: "user" as const, content: "x".repeat(400) }];
  const bare = requestTokens({ model: "m", stream: true, messages });
  const withTools = requestTokens({
    model: "m",
    stream: true,
    messages,
    tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }],
  });
  expect(bare).toBeGreaterThan(100);
  expect(withTools).toBeGreaterThan(bare);
});

test("token counts are shortened the way they are read", () => {
  expect(compact(999)).toBe("999");
  expect(compact(1234)).toBe("1.2k");
});
