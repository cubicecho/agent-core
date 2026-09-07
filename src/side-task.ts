import type OpenAI from "openai";
import { getClient } from "./client.ts";
import type { Endpoint } from "./config.ts";

/**
 * One-shot calls that support a run without being one: picking tools, naming a session,
 * summarising a transcript, proposing follow-ups. They share a shape — small prompt, short
 * answer, no tools, no streaming — and none is ever worth failing the run it supports.
 */

/**
 * Reasoning models will happily spend a whole budget deliberating over a six-word answer and
 * return empty content, so side tasks ask for thinking to be turned off. `reasoning_effort` is
 * the OpenAI-compatible spelling and `chat_template_kwargs` the llama.cpp/vLLM one; servers
 * disagree about which they take, so send both. One that rejects the unknown fields gets a
 * single retry without them, and we stop sending them after that.
 */
const NO_THINKING = {
  reasoning_effort: "none",
  chat_template_kwargs: { enable_thinking: false },
};
let thinkingHintsSupported = true;

/** Reasoning models that ignore the hints still fence their scratchpad; drop it. */
const stripThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/gi, "");

export interface SideTaskOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** Runs a side task and returns the reply text, thinking stripped. Throws like any request. */
export async function ask(
  config: Endpoint,
  model: string,
  system: string,
  user: string,
  { maxTokens = 512, temperature = 0.3, signal }: SideTaskOptions = {},
): Promise<string> {
  const send = (hints: boolean) =>
    getClient(config).chat.completions.create(
      {
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(hints ? NO_THINKING : {}),
      } as OpenAI.ChatCompletionCreateParamsNonStreaming,
      { signal },
    );

  let response: Awaited<ReturnType<typeof send>>;
  try {
    response = await send(thinkingHintsSupported);
  } catch (error) {
    if (!thinkingHintsSupported) throw error;
    console.warn("[side-task] server rejected the no-thinking hints; retrying without them");
    thinkingHintsSupported = false;
    response = await send(false);
  }

  return stripThinking(response.choices[0]?.message?.content ?? "").trim();
}

/**
 * A side task is never worth failing the work it supports. Callers that can carry on without
 * an answer use this and get `undefined` instead of an exception.
 */
export async function tryAsk<T>(label: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    console.warn(`[side-task] ${label}:`, (error as Error).message);
    return undefined;
  }
}

/**
 * Models are asked for JSON and often answer with prose around it, or a fenced block. Pull out
 * the first array or object rather than failing the task over a wrapper.
 */
export function parseJson<T>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) return undefined;
  const end = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));
  if (end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}

/** Strips the quoting and list punctuation models decorate short answers with. */
export const clean = (line: string) =>
  line
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s*/, "")
    .replace(/^["'`]+|["'`.]+$/g, "")
    .trim();

/**
 * A list-shaped reply, one item per line, cleaned of the bullets and quotes models decorate
 * them with. Overlong items are dropped rather than truncated — a suggestion that has to be
 * squinted at is worse than one fewer suggestion.
 */
export const listLines = (text: string, max: number, maxChars: number) =>
  text
    .split("\n")
    .map(clean)
    .filter((line) => line.length > 0 && line.length <= maxChars)
    .slice(0, max);

/**
 * Rough token count. Characters over four, because there is no tokenizer here and there is not
 * going to be one: a server that will not say how big its window is will not lend us its
 * vocabulary either.
 *
 * The estimate runs low on tool schemas — JSON packs more tokens into a character than prose
 * does — and that is the side to be wrong on wherever it guards a window, since the cost of
 * guessing high is a run refused that would have worked, and the cost of guessing low is the
 * endpoint's own refusal, which is where we were before the guard existed.
 */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
