import OpenAI from "openai";
import { getClient } from "./client.ts";
import type { Endpoint } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { isTransient } from "./retry.ts";

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
 * single retry without them, and is not offered them again.
 */
const NO_THINKING = {
  reasoning_effort: "none",
  chat_template_kwargs: { enable_thinking: false },
};

/**
 * The models that turned out not to take the hints, by endpoint and model.
 *
 * Keyed rather than global for the reason the client cache is keyed: a refusal is a fact about
 * what is on the other end, not about this process. A llama.cpp box and a cloud API are both
 * reachable from one consumer over its lifetime, and the first one's refusal must not stop the
 * second from ever being asked.
 *
 * The model belongs in the key for the same reason. One base URL is routinely many models —
 * OpenRouter, LiteLLM, vLLM serving several at once — and whether `reasoning_effort` is
 * understood is a property of the model behind the route, not of the route. Keyed on the host
 * alone, the first model to refuse spoke for every model on it.
 */
const noHints = new Set<string>();

const hintKey = (baseUrl: string, model: string) => JSON.stringify([baseUrl, model]);

/** Test seam, alongside `resetClients` and `resetAll`: forget which models refused the hints. */
export const resetHints = () => noHints.clear();

/**
 * Whether a failure is the server complaining about the request, rather than failing to answer.
 *
 * The retry below used to catch everything, so an aborted first call — or a connection that
 * never landed — latched the hints off for the life of the process and every later side task
 * paid for it by burning a whole budget on deliberation. Narrowing that to any 4xx was still
 * too wide: 401, 404 and 429 are all 4xx and none of them is about the fields. A 429 was the
 * worst of them, because the retry then re-sent the whole request immediately — doubling the
 * rate against a server that had just asked for less of it — and `isTransient` accepts exactly
 * that status, so the two halves of this package disagreed about one error.
 *
 * 400 and 422 are what a server says when it read the body and disliked it. Everything else
 * is left to the caller's own retry.
 */
function rejectedTheRequest(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError) || isTransient(error)) return false;
  return error.status === 400 || error.status === 422;
}

/**
 * Reasoning models that ignore the hints still fence their scratchpad; drop it.
 *
 * Including the fence that never closes. A side task answers under a small `max_tokens`, so a
 * model that spends it deliberating is cut off mid-scratchpad and the closing tag never
 * arrives — and the whole deliberation was then returned to the caller as the answer.
 */
const stripThinking = (text: string) =>
  text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    // And the fence that never opens. Several chat templates put the opening tag at the end of
    // the prompt rather than leaving the model to write it, so what comes back is deliberation
    // first and only the closing tag to mark where it stops. Neither pattern above matches that,
    // and the whole scratchpad went to the caller as the answer — a session title, a tool
    // preselection, a suggestion list. Every real `<think>` is gone by this point, so a `</think>`
    // still here opened in the prompt; the first one is taken, which keeps the most text.
    .replace(/^[\s\S]*?<\/think>/i, "");

/** What a side task may be given. All optional — one given none of them still runs. */
export interface SideTaskOptions {
  /** Ceiling on the reply, default 512. These answers are meant to be short. */
  maxTokens?: number;
  /** Sampling temperature, default 0.3. Naming and classifying want the same answer twice. */
  temperature?: number;
  /** Abandons the call, usually because the run it supports has gone away. */
  signal?: AbortSignal;
  /**
   * Told what was given up on, the same way `runTurn` and `negotiate` tell a caller.
   *
   * There is no default, and nothing is printed without one. A library that writes to the
   * console decides for its consumer where operator text goes — which a server embedding this
   * cannot then route to its own logger, attach to the run it belongs to, or silence in tests.
   */
  onNotice?: (message: string) => void;
}

/**
 * Runs a side task and returns the reply text, thinking stripped. Throws like any request.
 *
 * @param config Where to send it and how long to wait.
 * @param model The model to ask, usually smaller than the one running the work.
 * @param system The instruction.
 * @param user The input it applies to.
 * @param options Reply ceiling, temperature, cancellation, notices.
 */
export async function ask(
  config: Endpoint,
  model: string,
  system: string,
  user: string,
  { maxTokens = 512, temperature = 0.3, signal, onNotice }: SideTaskOptions = {},
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

  const key = hintKey(config.baseUrl, model);
  const hints = !noHints.has(key);
  let response: Awaited<ReturnType<typeof send>>;
  try {
    response = await send(hints);
  } catch (error) {
    if (!hints || !rejectedTheRequest(error)) throw error;
    onNotice?.("server rejected the no-thinking hints; retrying without them");
    noHints.add(key);
    response = await send(false);
  }

  const message = response.choices[0]?.message;
  const answer = stripThinking(message?.content ?? "").trim();
  // Nothing but scratchpad. Some servers put the deliberation in its own field and leave the
  // content genuinely empty, in which case there is no answer to find anywhere else.
  if (answer) return answer;
  const reasoning = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
  return typeof reasoning === "string" ? stripThinking(reasoning).trim() : "";
}

/**
 * A side task is never worth failing the work it supports. Callers that can carry on without
 * an answer use this and get `undefined` instead of an exception.
 *
 * @param label Names the task in the notice when it fails.
 * @param run The call to attempt. Anything it throws becomes `undefined`, an abort excepted.
 * @param options `onNotice`, told what was given up on.
 */
export async function tryAsk<T>(
  label: string,
  run: () => Promise<T>,
  { onNotice }: Pick<SideTaskOptions, "onNotice"> = {},
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    // A cancelled run is not a failed side task. Swallowing the abort made the two
    // indistinguishable and left the cancellation with nowhere to go.
    if (error instanceof OpenAI.APIUserAbortError) throw error;
    onNotice?.(`${label}: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * Models are asked for JSON and often answer with prose around it, or a fenced block. Pull out
 * the first array or object rather than failing the task over a wrapper.
 *
 * @param text The reply, fences and prose included. Nothing parseable gives `undefined`.
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

/**
 * Strips the quoting and list punctuation models decorate short answers with.
 *
 * @param line One line of a reply.
 */
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
 *
 * @param text The reply, one item per line.
 * @param max How many items to keep.
 * @param maxChars Longest item kept. Longer ones are dropped, not truncated.
 */
export const listLines = (text: string, max: number, maxChars: number) =>
  text
    .split("\n")
    .map(clean)
    .filter((line) => line.length > 0 && line.length <= maxChars)
    .slice(0, max);
