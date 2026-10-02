import OpenAI from "openai";
import {
  type Capabilities,
  capabilitiesFor,
  ceilingAndTemperature,
  effortFor,
  type ModelCapabilities,
  modelCapabilitiesFor,
  negotiate,
  type OnNotice,
} from "./capabilities.ts";
import { endpointId, getClient, modelKey } from "./client.ts";
import type { Endpoint } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { refusesRequest } from "./retry.ts";
import { relaxSchema, sanitizeSchema } from "./schema-compat.ts";
import { scoped } from "./scope.ts";
import { stripThinking } from "./thinking.ts";
import { looseJson } from "./tool-calls.ts";

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
 *
 * Only the second half is latched here. `reasoning_effort` is a field `negotiate` already knows
 * how to be refused, so it is sent under `ModelCapabilities.reasoningEffort` instead — which
 * both narrows the fallback below to the field it is really about, and shares the answer with
 * the runs on that model rather than keeping a second opinion about it.
 */
const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } };

/**
 * The models that turned out not to take the hints, by endpoint and model.
 *
 * Keyed rather than global for the reason the client cache is keyed, and on the same
 * endpoint it is, by `endpointId`: a refusal is a fact about what is on the other end, not about this
 * process. A llama.cpp box and a cloud API are both reachable from one consumer over its
 * lifetime, and the first one's refusal must not stop the second from ever being asked.
 *
 * The model belongs in the key for the same reason. One base URL is routinely many models —
 * OpenRouter, LiteLLM, vLLM serving several at once — and whether `chat_template_kwargs` reaches
 * a chat template that reads it is a property of the model behind the route, not of the route.
 * Keyed on the host alone, the first model to refuse spoke for every model on it.
 *
 * Only the `chat_template_kwargs` half is here. `reasoning_effort` is `negotiate`'s to latch, on
 * the same (endpoint, model) pair, where a run on that model can read it too. A pair is held as
 * `modelKey(endpointId, model)`, which is what `importCapabilities` adds to it by.
 */
const noHints = scoped(() => new Set<string>());

/** The pairs that refused the hints, the live set, for `exportCapabilities` and `importCapabilities`. */
export const refusedHints = (): Set<string> => noHints();

/** Test seam, alongside `resetClients` and `resetAll`: forget which models refused the hints. */
export const resetHints = () => noHints().clear();

/**
 * The input a side task applies its instruction to: text, or the content parts a vision model
 * reads.
 *
 * A string is the ordinary case and stays the cheapest thing to write. The array is what an
 * image needs, because a page, a screenshot or a photo reaches an OpenAI-compatible server only
 * as an `image_url` part alongside the text — there is no other spelling for it, and a caller
 * with one otherwise has to leave this module and build the request itself. Nothing here reads
 * the parts: they are handed to the SDK as given, and whether a model that cannot see rejects
 * the image or answers without it is the server's decision, not this module's.
 */
export type SideTaskInput = string | OpenAI.ChatCompletionContentPart[];

/** What a side task may be given. All optional — one given none of them still runs. */
export interface SideTaskOptions {
  /**
   * Ceiling on the reply, default 512. These answers are meant to be short. Zero or less sends
   * none and leaves it to the server, which is what `maxTokens: 0` means on the main model too.
   */
  maxTokens?: number;
  /** Sampling temperature, default 0.3. Naming and classifying want the same answer twice. */
  temperature?: number;
  /**
   * A reasoning effort to ask for in place of the no-thinking hints, for a side task an operator
   * has pointed at a model that should deliberate — a compaction summary is the usual one.
   *
   * Absent, `""` and `"off"` all keep the hints, because off is what they already ask for. Any
   * other value is sent as `reasoning_effort`, stepped up by `effortFor` where the model has
   * refused it by value, and `chat_template_kwargs` is left out of the request altogether.
   */
  reasoningEffort?: string;
  /** Abandons the call, usually because the run it supports has gone away. */
  signal?: AbortSignal;
  /**
   * Told what was given up on, the same way `runTurn` and `negotiate` tell a caller.
   *
   * The one notice `ask` raises itself opens with the model's name, as `negotiate`'s do for the
   * refusals that are the model's: what it announces is latched on the (endpoint, model) pair,
   * so on a consumer reaching several models through one base URL the name is the only thing
   * separating one announcement from the next.
   *
   * There is no default, and nothing is printed without one. A library that writes to the
   * console decides for its consumer where operator text goes — which a server embedding this
   * cannot then route to its own logger, attach to the run it belongs to, or silence in tests.
   */
  onNotice?: OnNotice;
}

/**
 * One side task's own settings, as a resolved agent spec carries them under `tasks.<key>`.
 *
 * Declared here rather than imported from `spec.ts`, whose `ResolvedTask` it matches field for
 * field: the spec module is one nothing else in `src/` imports, and a host that is not on the spec
 * can write one of these by hand. An absent setting is the side task's own default — 0.3, the
 * entry point's ceiling, thinking off — and never the main model's, so raising the agent's
 * temperature for the chat does not make its titler creative. See `taskCall`.
 */
export interface SideTask {
  /** The model that does the task. */
  model: string;
  /** Where that model is reached, which need not be where the agent's is. */
  endpoint: Endpoint;
  /** The reply's ceiling. Absent is the entry point's default; zero sends none. */
  maxTokens?: number;
  /** Absent is 0.3, whatever the agent's own temperature is. Zero means zero. */
  temperature?: number;
  /** As `SideTaskOptions.reasoningEffort`: a level replaces the no-thinking hints. */
  reasoningEffort?: string;
}

/**
 * Runs a side task and returns the reply text, thinking stripped. Throws like any request.
 *
 * @param config Where to send it and how long to wait.
 * @param model The model to ask, usually smaller than the one running the work.
 * @param system The instruction.
 * @param user The input it applies to. Content parts where the model is being shown an image.
 * @param options Reply ceiling, temperature, a reasoning effort, cancellation, notices.
 */
export function ask(
  config: Endpoint,
  model: string,
  system: string,
  user: SideTaskInput,
  options: SideTaskOptions = {},
): Promise<string> {
  return complete(config, model, system, user, options);
}

/**
 * The request `ask` and `askJson` share, with `format` deciding the extra body fields from what
 * the model and the endpoint have refused, rebuilt on every re-send.
 */
async function complete(
  config: Endpoint,
  model: string,
  system: string,
  user: SideTaskInput,
  { maxTokens = 512, temperature = 0.3, reasoningEffort, signal, onNotice }: SideTaskOptions,
  format?: (supports: Capabilities, refused: ModelCapabilities) => Record<string, unknown>,
): Promise<string> {
  // The effort the caller chose, or empty where it chose none: `""` and `"off"` read as absent,
  // since off is what the hints below already ask for.
  const level = effortFor(undefined, reasoningEffort);
  // Whether the last request carried an effort, which `negotiate` decides and not this function.
  let sentEffort = false;
  const send = (
    hints: boolean,
    effort: boolean,
    supports: Capabilities,
    refused: ModelCapabilities | undefined,
  ) => {
    // `none` is what a side task wants and not always what the model offers: OpenAI's reasoning
    // models refuse it by value and list `minimal` as their floor. `effortFor` answers with the
    // cheapest rung this one takes, which `negotiate` has been stepping up as it was refused.
    // A level the caller chose goes through the same ladder, which only ever steps up from it.
    const asked = effort ? effortFor(refused, level || "none") : "";
    sentEffort = asked !== "";
    return getClient(config).chat.completions.create(
      {
        model,
        // The reasoning models want the ceiling spelled the other way, and they are exactly the
        // models a side task most wants to stop deliberating. One that will only run at its own
        // temperature is sent none: a side task wants the same answer twice, and 1.0 from that
        // model is as close as it gets.
        ...ceilingAndTemperature(refused, maxTokens, temperature),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(hints ? NO_THINKING : {}),
        // Not gated on `hints`: a model that refuses `chat_template_kwargs` may still read the
        // effort, and the two latches would otherwise contradict each other.
        ...(sentEffort ? { reasoning_effort: asked } : {}),
        ...(format && refused ? format(supports, refused) : {}),
      } as OpenAI.ChatCompletionCreateParamsNonStreaming,
      { signal },
    );
  };

  // The endpoint's own object, not one of this module's: what a model refuses is the same fact
  // whether a run or a side task found it out, and the point of latching it is that only one of
  // them has to pay for it. Nothing here sends tools or `stream_options`; the grammar flag is in
  // play only for `askJson`, whose schema a llama.cpp server compiles the way it does a tool's.
  const supports = capabilitiesFor(config.baseUrl, config.apiKey);
  const attempt = (hints: boolean, effort: boolean) =>
    negotiate(supports, (latched, _produced, refused) => send(hints, effort, latched, refused), {
      model,
      onNotice,
    });

  const key = modelKey(endpointId(config), model);
  // A chosen effort replaces the template hint rather than riding beside it: `enable_thinking:
  // false` next to `reasoning_effort: "high"` is a request that contradicts itself.
  const hints = !level && !noHints().has(key);
  let response: Awaited<ReturnType<typeof send>>;
  try {
    response = await attempt(hints, true);
  } catch (error) {
    // Whatever is left after `negotiate` has answered everything it knows: on this path that is
    // the hints it does not, which is `chat_template_kwargs` and an effort the model has but
    // does not offer as `none`. Or a 400 about something else entirely, which is why the
    // notice says what was tried rather than what was wrong.
    const effort = sentEffort;
    if (!(hints || effort) || !refusesRequest(error)) throw error;
    onNotice?.(
      level
        ? `${model} rejected a request carrying a reasoning effort; retrying without it`
        : `${model} rejected a request carrying the no-thinking hints; retrying without them`,
    );
    response = await attempt(false, false);
    // Latched on the finding, not the hypothesis: a context overflow is a 400 `negotiate` does
    // not recognise too, and it fails the retry the same way, leaving the next call to try the
    // hints again. When both went out the refusal cannot say which, so the one `negotiate`
    // cannot latch is blamed; if it was the effort after all, the next call is left with only
    // the effort to drop and latches that instead.
    if (hints) noHints().add(key);
    else modelCapabilitiesFor(supports, model).reasoningEffort = false;
  }

  const message = response.choices[0]?.message;
  // Reasoning models that ignore the hints still fence their scratchpad. A side task answers
  // under a small ceiling, so the fence often never closes, and a template that opened it in
  // the prompt leaves only the close; either way the deliberation used to come back as the answer.
  const answer = stripThinking(message?.content ?? "").trim();
  // Nothing but scratchpad. Some servers put the deliberation in its own field and leave the
  // content genuinely empty, in which case there is no answer to find anywhere else.
  if (answer) return answer;
  const reasoning = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
  return typeof reasoning === "string" ? stripThinking(reasoning).trim() : "";
}

/** What `askJson` takes besides a side task's options. */
export interface AskJsonOptions extends SideTaskOptions {
  /** What the schema is called in the request, `answer` by default. Letters, digits, `_` and `-`. */
  name?: string;
  /**
   * Asks the server to hold the reply to the schema exactly, true by default. OpenAI's strict mode
   * wants every property required and `additionalProperties: false`; a schema written otherwise
   * wants this off there.
   */
  strict?: boolean;
}

/**
 * A side task whose answer is JSON matching a schema, parsed. Undefined when no JSON came back.
 * Throws like any request.
 *
 * Sends `response_format` with the schema, which a llama.cpp server compiles into a grammar and
 * vLLM, LM Studio, Ollama and OpenAI each hold the reply to, so a small model that wraps JSON in
 * prose cannot. The schema is normalised as a tool's parameters are, and relaxed where the endpoint
 * could not build a grammar, since the same converter reads both. A model that refuses the field
 * latches it off and is asked in words: the schema rides on the system prompt either way, and
 * the reply goes through `parseJson`, which finds the JSON in whatever came back.
 *
 * @param config Where to send it and how long to wait.
 * @param model The model to ask.
 * @param system The instruction. The schema is appended to it.
 * @param user The input it applies to. Content parts where the model is being shown an image.
 * @param schema The JSON Schema of the answer. Its root is held to an object, as a tool's is.
 * @param options A side task's options, plus the schema's `name` and whether it is `strict`.
 */
export async function askJson<T>(
  config: Endpoint,
  model: string,
  system: string,
  user: SideTaskInput,
  schema: Record<string, unknown>,
  { name = "answer", strict = true, ...options }: AskJsonOptions = {},
): Promise<T | undefined> {
  const sanitized = sanitizeSchema(schema);
  const instruction = `${system}\n\nReply with JSON alone, matching this JSON Schema:\n${JSON.stringify(sanitized)}`;
  const reply = await complete(config, model, instruction, user, options, (supports, refused) =>
    refused.structuredOutput
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name,
              strict,
              schema: supports.strictSchemas ? sanitized : relaxSchema(sanitized),
            },
          },
        }
      : {},
  );
  return parseJson<T>(reply);
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
 * What is pulled out is read the way a tool call's arguments are: as written where that parses,
 * and otherwise with the almost-JSON a local model writes repaired — single quotes, `True` and
 * `None`, bare keys, a trailing comma. A small model asked for a list gets these wrong as often in
 * a reply as in a call, and a side task that fails over one costs the run a second request.
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
  return looseJson(body.slice(start, end + 1)) as T | undefined;
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
