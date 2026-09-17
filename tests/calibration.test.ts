import type OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calibrate, charsPerTokenFor, resetCalibration } from "../src/calibration.ts";
import { capabilitiesFor, resetCapabilities } from "../src/capabilities.ts";
import {
  CHARS_PER_TOKEN,
  ContextOverflow,
  requestChars,
  requestTokens,
  toolsChars,
} from "../src/retry.ts";
import { runTurn } from "../src/run-turn.ts";

type Body = OpenAI.ChatCompletionCreateParamsStreaming;

const says = (content: string, model = "m"): Body => ({
  model,
  stream: true,
  messages: [{ role: "user", content }],
});
/** The prompt count that puts a body at this many characters per token. */
const promptAt = (body: Body, ratio: number) =>
  (requestChars(body) + toolsChars(body.tools ?? [])) / ratio;

const clientOf = (create: (body: Body) => unknown) =>
  ({ chat: { completions: { create } } }) as unknown as OpenAI;
const chunks = (...list: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* list as OpenAI.ChatCompletionChunk[];
  },
});
/** A turn that answers and reports this prompt count. */
const reports = (prompt: number) =>
  chunks(
    { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
    {
      choices: [],
      usage: { prompt_tokens: prompt, completion_tokens: 1, total_tokens: prompt + 1 },
    },
  );

afterEach(() => {
  resetCalibration();
  resetCapabilities();
});

describe("calibration", () => {
  const supports = () => capabilitiesFor("http://local/v1");

  it("sizes at four characters a token until something has been measured", () => {
    expect(charsPerTokenFor(supports(), "m")).toBe(CHARS_PER_TOKEN);
  });

  it("takes the highest of the latest four readings, which is the lowest count", () => {
    const body = says("x".repeat(3000));
    for (const ratio of [7, 2, 3, 2.5, 3.5]) calibrate(supports(), body, promptAt(body, ratio));
    // The 7 has aged out; of 2, 3, 2.5 and 3.5 the estimate that errs low divides by 3.5.
    expect(charsPerTokenFor(supports(), "m")).toBeCloseTo(3.5);
  });

  it("keeps each model and each endpoint to itself", () => {
    const body = says("x".repeat(3000));
    calibrate(supports(), body, promptAt(body, 2));
    expect(charsPerTokenFor(supports(), "m")).toBeCloseTo(2);
    expect(charsPerTokenFor(supports(), "other")).toBe(CHARS_PER_TOKEN);
    expect(charsPerTokenFor(capabilitiesFor("http://elsewhere/v1"), "m")).toBe(CHARS_PER_TOKEN);
  });

  it("counts the tools the request declared", () => {
    const body: Body = {
      ...says("x".repeat(1000)),
      tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }],
    };
    expect(calibrate(supports(), body, promptAt(body, 3))).toBeCloseTo(3);
  });

  it("does not learn from a reading no tokenizer produces, or from no reading", () => {
    const body = says("x".repeat(3000));
    calibrate(supports(), body, promptAt(body, 0.5));
    calibrate(supports(), body, promptAt(body, 20));
    calibrate(supports(), body, 0);
    expect(charsPerTokenFor(supports(), "m")).toBe(CHARS_PER_TOKEN);
  });

  it("does not learn from a request carrying an image", () => {
    const body: Body = {
      model: "m",
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    };
    expect(calibrate(supports(), body, 800)).toBe(CHARS_PER_TOKEN);
  });

  it("is forgotten by resetCalibration", () => {
    const body = says("x".repeat(3000));
    calibrate(supports(), body, promptAt(body, 2));
    resetCalibration();
    expect(charsPerTokenFor(supports(), "m")).toBe(CHARS_PER_TOKEN);
  });

  it("is learned by runTurn and then sizes the guard in front of the next request", async () => {
    // 30k characters is about 7.5k tokens at four, under an 8192 window; at two it is 15k.
    const big = () => says("x".repeat(30_000));
    // Sized at four, it would have been let through.
    expect(requestTokens(big(), { charsPerToken: charsPerTokenFor(supports(), "m") })).toBeLessThan(
      8192,
    );
    const small = says("x".repeat(2000));
    const create = vi.fn().mockReturnValue(reports(promptAt(small, 2)));
    await runTurn(clientOf(create), supports(), () => small, { contextLimit: 8192 });
    expect(charsPerTokenFor(supports(), "m")).toBeCloseTo(2);
    create.mockClear();
    await expect(
      runTurn(clientOf(create), supports(), big, { contextLimit: 8192 }),
    ).rejects.toThrow(ContextOverflow);
    expect(create).not.toHaveBeenCalled();
  });
});
