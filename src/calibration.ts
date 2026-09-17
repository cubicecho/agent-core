import type OpenAI from "openai";
import type { Capabilities } from "./capabilities.ts";
import { CHARS_PER_TOKEN, requestChars, toolsChars } from "./retry.ts";

/**
 * How many characters a token is worth on one model, learned from what its endpoint reports.
 *
 * Four is right for English prose and wrong for everything a tool-using run is made of: JSON
 * schemas and tool results pack closer to two or three, so the pre-flight guard let through
 * requests the endpoint then refused. Every turn comes back with the exact prompt count for a
 * request whose characters were already counted to size it, so the ratio is there for the taking.
 *
 * Kept apart from the capability latches, and out of `exportCapabilities`, on purpose. A latch is
 * a refusal that holds until the process dies; this is a measurement that moves every turn and is
 * learned again from the first one after a restart. `negotiate` compares every value on a
 * `ModelCapabilities` to tell whether a flag moved under a request in flight, so a number that
 * moves on every turn there would read as a latch changing and re-send refusals it should throw.
 */

/** How many of a model's latest readings the ratio is taken over. */
const READINGS = 4;

/**
 * The ratios no tokenizer produces over a whole request. Below one is a request whose tokens are
 * mostly somewhere the characters do not count — an image — and far above four is a server that
 * reported the uncached part of the prompt as all of it.
 */
const PLAUSIBLE = { least: 1, most: 8 };

/**
 * The latest readings per model, under the endpoint's own `Capabilities` object — the identity
 * `capabilitiesFor` already gives one server and key — so an endpoint forgotten by
 * `resetCapabilities` takes its readings with it. Replaced rather than cleared by `resetCalibration`,
 * since a `WeakMap` has no `clear`.
 */
let readings = new WeakMap<Capabilities, Map<string, number[]>>();

/**
 * The characters per token to size a request to this model with, `CHARS_PER_TOKEN` until a turn
 * has reported one.
 *
 * The highest of the model's last few readings rather than their mean. The estimate guards a
 * window, and `estimateTokens` says which side of wrong that should be on: a count that comes out
 * high refuses a run that would have fit, one that comes out low only costs the round trip the
 * guard was saving. The highest ratio is the lowest count, and the last few rather than all of
 * them because a run's transcript grows by appending, so the latest requests are the best
 * likeness of the next.
 *
 * @param supports The endpoint, as `capabilitiesFor` hands it over.
 * @param model The name the endpoint knows the model as, as it goes in the body.
 */
export function charsPerTokenFor(supports: Capabilities, model: string): number {
  const known = readings.get(supports)?.get(model);
  return known?.length ? Math.max(...known) : CHARS_PER_TOKEN;
}

/** Whether any message carries a part whose tokens its characters do not count. */
const hasMedia = (messages: OpenAI.ChatCompletionMessageParam[]) =>
  messages.some(
    ({ content }) =>
      Array.isArray(content) &&
      content.some((part) => part.type !== "text" && part.type !== "refusal"),
  );

/**
 * Takes one reading from a request that was answered, so the next one to this model is sized by it.
 *
 * `runTurn` calls it after every turn whose prompt was reported, so a caller using that has
 * nothing to do. A request carrying an image or audio is not read: a vision model charges a
 * picture hundreds of tokens its characters say nothing about. Neither is a reading outside what a
 * tokenizer could produce, which is a miscount and not a tokenizer.
 *
 * @param supports The endpoint the request went to.
 * @param body The request as it was last sent, which names the model.
 * @param promptTokens The prompt count the endpoint reported for it. Zero or less is no report.
 * @returns The ratio now in force for the model.
 */
export function calibrate(
  supports: Capabilities,
  body: OpenAI.ChatCompletionCreateParamsStreaming,
  promptTokens: number,
): number {
  if (!(promptTokens > 0) || hasMedia(body.messages)) return charsPerTokenFor(supports, body.model);
  const ratio = (requestChars(body) + toolsChars(body.tools ?? [])) / promptTokens;
  if (ratio < PLAUSIBLE.least || ratio > PLAUSIBLE.most) {
    return charsPerTokenFor(supports, body.model);
  }
  let models = readings.get(supports);
  if (!models) {
    models = new Map();
    readings.set(supports, models);
  }
  const known = models.get(body.model) ?? [];
  known.push(ratio);
  if (known.length > READINGS) known.shift();
  models.set(body.model, known);
  return charsPerTokenFor(supports, body.model);
}

/** Forgets every reading, so the next request is sized at `CHARS_PER_TOKEN` again. */
export function resetCalibration() {
  readings = new WeakMap();
}
