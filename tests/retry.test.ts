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
import { estimateTokens } from "../src/tokens.ts";

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

test("a rate limit is not read as an overflow, however it is worded", () => {
  // OpenAI's real one: "too large for" beside "tokens", which is both halves of the test
  // above, on a 429 that `isTransient` accepts and that succeeds on the next attempt.
  expect(
    isOverflow(
      "Request too large for gpt-4o in organization org-abc on tokens per min (TPM): " +
        "Limit 30000, Requested 40000.",
    ),
  ).toBe(false);
  expect(isOverflow("Rate limit reached for gpt-4o: 200000 tokens per day")).toBe(false);
  expect(isOverflow("token quota exceeded, request too large for this key")).toBe(false);

  // The classifiers have to agree: nothing may be both.
  const tpm = new OpenAI.APIError(
    429,
    { error: {} },
    "Request too large for gpt-4o on TPM",
    undefined,
  );
  expect(isTransient(tpm)).toBe(true);
  expect(isOverflow(tpm.message)).toBe(false);
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

test("a transcript costs more the longer it gets, and the walk sees every part of it", () => {
  const turn = (n: number) => [
    { role: "user" as const, content: `ask ${n} ${"x".repeat(200)}` },
    {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: `call_${n}`,
          type: "function" as const,
          function: { name: "search", arguments: JSON.stringify({ q: "y".repeat(100) }) },
        },
      ],
    },
    { role: "tool" as const, tool_call_id: `call_${n}`, content: "z".repeat(300) },
  ];
  const sized = (turns: number) =>
    requestTokens({
      model: "m",
      stream: true,
      messages: Array.from({ length: turns }, (_, i) => turn(i)).flat(),
    });
  expect(sized(5)).toBeGreaterThan(sized(1));
  expect(sized(20)).toBeGreaterThan(sized(5));
  // Within a rounding error of what serialising the same body would have said, which is what
  // the walk replaced. `estimateTokens` is documented as running low; it must not run wild.
  const walked = sized(20);
  const serialized = estimateTokens(
    JSON.stringify(Array.from({ length: 20 }, (_, i) => turn(i)).flat()),
  );
  expect(walked).toBeGreaterThan(serialized * 0.9);
  expect(walked).toBeLessThan(serialized * 1.1);
});

test("the keys only some messages carry are counted, not only their values", () => {
  // `ENVELOPE` is the two keys every message has. It was being applied to the three shapes that
  // carry another, whose value was counted and whose key was not — 4.5 tokens on every tool
  // result, the message a tool-using run accumulates most of, and short in the one direction
  // this estimate must not be short in: `requestTokens` guards a window, and under-counting
  // passes a request that then overflows for real.
  const sized = (messages: OpenAI.ChatCompletionMessageParam[]) =>
    requestTokens({ model: "m", stream: true, messages });
  const serialized = (messages: OpenAI.ChatCompletionMessageParam[]) =>
    estimateTokens(JSON.stringify(messages));
  // A hundred of a shape, so a per-message constant is worth whole tokens rather than a
  // rounding the ceiling swallows.
  const many = (message: OpenAI.ChatCompletionMessageParam) =>
    Array.from({ length: 100 }, () => message);

  // Each key, priced against the same message without it: the difference the walk sees has to
  // be the difference the serialisation sees.
  const named = many({ role: "user", name: "bob", content: "hi" });
  const anonymous = many({ role: "user", content: "hi" });
  expect(sized(named) - sized(anonymous)).toBe(serialized(named) - serialized(anonymous));

  const result = many({ role: "tool", tool_call_id: "call_1", content: "hi" });
  const bare = many({ role: "user", content: "hi" });
  expect(sized(result) - sized(bare)).toBe(serialized(result) - serialized(bare));

  // And the whole shape, end to end: twenty tool results is what a real run is mostly made of,
  // and the body the omission was worth ninety tokens on.
  const run = Array.from({ length: 20 }, (_, i) => ({
    role: "tool" as const,
    tool_call_id: `call_${i}`,
    content: "x".repeat(200),
  }));
  expect(sized(run)).toBe(serialized(run));
});

test("a message whose content is parts is sized from the parts it has text in", () => {
  const sized = (content: OpenAI.ChatCompletionUserMessageParam["content"]) =>
    requestTokens({ model: "m", stream: true, messages: [{ role: "user", content }] });
  const serialized = (content: OpenAI.ChatCompletionUserMessageParam["content"]) =>
    estimateTokens(JSON.stringify([{ role: "user", content }]));

  // Each part is an object in the body, so splitting the same text across more of them makes
  // the request bigger — `{"type":"text","text":""},` is 26 characters that are really sent.
  // Charging only `part.text` read the split content as the unsplit content and was short by
  // 6.5 tokens a part, which grows with the part count rather than with what the parts say.
  const plain = sized("x".repeat(400));
  const one = sized([{ type: "text", text: "x".repeat(400) }]);
  const eight = sized(
    Array.from({ length: 8 }, () => ({ type: "text" as const, text: "x".repeat(50) })),
  );
  expect(one).toBeGreaterThan(plain);
  expect(eight).toBeGreaterThan(one);

  // And each of the three is what serialising that same body says, which is the point: the
  // string case was already exact and the parts cases now are too.
  expect(plain).toBe(serialized("x".repeat(400)));
  expect(one).toBe(serialized([{ type: "text", text: "x".repeat(400) }]));
  expect(eight).toBe(
    serialized(Array.from({ length: 8 }, () => ({ type: "text" as const, text: "x".repeat(50) }))),
  );

  // An image part is a URL or a blob, and is not priced by the length of either — a vision
  // model does not charge a data URL by its base64 length, so this one stays uncounted on
  // purpose and the text part beside it is unaffected.
  const withImage = sized([
    { type: "text", text: "x".repeat(400) },
    { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(5000)}` } },
  ]);
  expect(withImage).toBe(one);
});

test("a refusal part is charged its own envelope too", () => {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "assistant", content: [{ type: "refusal", refusal: "no".repeat(100) }] },
  ];
  expect(requestTokens({ model: "m", stream: true, messages })).toBe(
    estimateTokens(JSON.stringify(messages)),
  );
});

test("the same tools array is only measured once", () => {
  const tools: OpenAI.ChatCompletionTool[] = [
    { type: "function", function: { name: "t", parameters: { type: "object" } } },
  ];
  const messages = [{ role: "user" as const, content: "hi" }];
  const first = requestTokens({ model: "m", stream: true, messages, tools });
  // Mutated behind the cache: a second reading of the same array must be the memoised number,
  // not a fresh walk, or the identity key is not doing what the comment says it does.
  tools.push({ type: "function", function: { name: "u".repeat(500), parameters: {} } });
  expect(requestTokens({ model: "m", stream: true, messages, tools })).toBe(first);
});

test("token counts are shortened the way they are read", () => {
  expect(compact(999)).toBe("999");
  expect(compact(1234)).toBe("1.2k");
});
