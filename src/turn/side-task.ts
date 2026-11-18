import type OpenAI from 'openai';
import type { Endpoint, EndpointIdentity } from '../core/config.ts';
import {
  type Capabilities,
  capabilitiesFor,
  ceilingAndTemperature,
  EFFORT_NONE,
  effortFor,
  extraFields,
  type ModelCapabilities,
  modelCapabilitiesFor,
  type OnNotice,
} from '../endpoint/capabilities.ts';
import { getClient, idleTimeoutMs, resolveApiKey, sameUrl } from '../endpoint/client.ts';
import { relaxSchema, sanitizeSchema } from '../endpoint/schema-compat.ts';
import { errorMessage } from '../wire/errors.ts';
import { isAbort } from '../wire/retry.ts';
import type { Turn } from '../wire/stream.ts';
import { stripThinking } from '../wire/thinking.ts';
import { CODE_FENCE, looseJson } from '../wire/tool-calls.ts';
import { CHAT_TEMPLATE_KWARGS, JSON_SCHEMA_FORMAT, Role } from '../wire/wire.ts';
import { type RequestBuilder, runTurn } from './run-turn.ts';

/**
 * One-shot calls that support an exchange without being one: picking tools, naming a session,
 * summarising a transcript, proposing follow-ups. They share a shape — small prompt, short
 * answer, no tools — and none is ever worth failing the exchange it supports.
 *
 * Each is one request sent by `runTurn`, as an exchange's turn is: negotiated, retried, waited
 * out while the model loads, and read as it streams in. What a side task adds is its body.
 */

/**
 * Reasoning models will happily spend a whole budget deliberating over a six-word answer and
 * return empty content, so side tasks ask for thinking to be turned off. `reasoning_effort` is
 * the OpenAI-compatible spelling and `chat_template_kwargs` the llama.cpp/vLLM one; servers
 * disagree about which they take, so send both.
 *
 * @remarks
 * This is the second half, sent as a droppable field: a model server that refuses it by name
 * has it latched into `refusedFields` by `negotiate` and is not sent it again. `reasoning_effort`
 * is latched under `ModelCapabilities.reasoningEffort`, as every exchange's is.
 */
const NO_THINKING = { [CHAT_TEMPLATE_KWARGS]: { enable_thinking: false } };

/**
 * How many times a side task sends a lost request again, where its caller does not say.
 *
 * @remarks
 * Not the exchange's `maxRetries`, which defaults to none: a side task is small, and a lost one
 * that is not sent again costs the exchange a title or a shortlist for one dropped connection.
 */
const SIDE_TASK_RETRIES = 2;

/**
 * The input a side task applies its instruction to: text, or the content parts a vision model
 * reads.
 *
 * @remarks
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
   * Ceiling on the reply. These answers are meant to be short. Zero or less sends none and leaves
   * it to the server, which is what `maxTokens: 0` means on the main model too.
   *
   * @defaultValue `512`
   */
  maxTokens?: number;
  /**
   * Sampling temperature. Naming and classifying want the same answer twice.
   *
   * @defaultValue `0.3`
   */
  temperature?: number;
  /**
   * A reasoning effort to ask for in place of the no-thinking hints, for a side task an operator
   * has pointed at a model that should deliberate — a compaction summary is the usual one.
   *
   * @remarks
   * Absent, `""` and `"off"` all keep the hints, because off is what they already ask for. Any
   * other value is sent as `reasoning_effort`, stepped up by `effortFor` where the model has
   * refused it by value, and `chat_template_kwargs` is left out of the request altogether.
   */
  reasoningEffort?: string;
  /**
   * Request fields these options cannot spell, as `ModelParams.extraBody` is for the main model:
   * `top_p`, `top_k`, `min_p` and the penalties a model card asks for.
   *
   * @remarks
   * Merged in after the ceiling, temperature and thinking fields, so it may override them, and
   * before `askJson`'s `response_format`. `model`, `messages`, `stream` and `tools` are dropped. A
   * field the model server refuses by name is latched for the model and the request sent again
   * without it.
   */
  extraBody?: Record<string, unknown>;
  /**
   * How many times a lost request is sent again: a dropped connection, a busy or silent model
   * server. A refusal is not one, and a model still loading is waited out without spending these.
   *
   * @defaultValue `2`
   */
  maxRetries?: number;
  /** Abandons the call, usually because the exchange it supports has gone away. */
  signal?: AbortSignal;
  /**
   * Told what was given up on, waited out or retried, as `runTurn` tells an exchange.
   *
   * @remarks
   * There is no default, and nothing is printed without one. A library that writes to the
   * console decides for its consumer where operator text goes — which a server embedding this
   * cannot then route to its own logger, attach to the run it belongs to, or silence in tests.
   */
  onNotice?: OnNotice;
}

/**
 * One side task's own settings, as a resolved agent spec carries them under `tasks.<key>`.
 *
 * @remarks
 * Declared here rather than imported from `spec.ts`, whose `ResolvedTask` it matches field for
 * field: the spec module is one nothing else in `src/` imports, and an app that is not on the spec
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
  /**
   * Sampling temperature, whatever the agent's own is. Zero means zero.
   *
   * @defaultValue `0.3`
   */
  temperature?: number;
  /** As `SideTaskOptions.reasoningEffort`: a level replaces the no-thinking hints. */
  reasoningEffort?: string;
  /** As `SideTaskOptions.extraBody`: the sampler fields a model card asks for, sent as given. */
  extraBody?: Record<string, unknown>;
}

/**
 * Runs a side task and returns the reply text, scratchpad stripped. Throws like any request, once
 * `runTurn` has negotiated, retried and waited out what it can.
 *
 * @param config - Where to send it and how long to wait.
 * @param model - The model to ask, usually smaller than the one running the work.
 * @param system - The instruction.
 * @param user - The input it applies to. Content parts where the model is being shown an image.
 * @param [options] - Reply ceiling, temperature, a reasoning effort, extra fields, retries, cancellation,
 * notices.
 * @returns The reply's content, trimmed. Where that is empty once the scratchpad is stripped, a
 * scratchpad the server sent in a field of its own, `reasoning_content` or `reasoning`, stripped
 * the same way, or an empty string.
 */
export async function ask(
  config: Endpoint,
  model: string,
  system: string,
  user: SideTaskInput,
  options: SideTaskOptions = {},
): Promise<string> {
  const { text } = await complete(config, model, system, user, options);
  return text;
}

/** A side task's reply, with why the model stopped writing it. */
export interface SideTaskReply {
  /** The reply's content as `ask` returns it: trimmed, scratchpad stripped. */
  text: string;
  /**
   * The reply's `finish_reason` as the server sent it, compared with `FinishReason`.
   * `FinishReason.Length` means `text` was cut off at the ceiling. Undefined when none was sent.
   */
  finishReason: string | undefined;
}

/**
 * Runs a side task as `ask` does, and says why the reply ended as well as what it said.
 *
 * @param config - Where to send it and how long to wait.
 * @param model - The model to ask.
 * @param system - The instruction.
 * @param user - The input it applies to. Content parts where the model is being shown an image.
 * @param [options] - Reply ceiling, temperature, a reasoning effort, extra fields, retries, cancellation,
 * notices.
 * @returns The text `ask` would return, and the `finish_reason` it came with.
 *
 * @remarks
 * For a caller whose reply is the product, such as a page's transcript: one that ran into the
 * ceiling, often because the model was looping, reads like a finished one in its text alone.
 * Nothing is thrown for it, because whether a cut-off reply is still worth keeping is the
 * caller's call.
 */
export function askReply(
  config: Endpoint,
  model: string,
  system: string,
  user: SideTaskInput,
  options: SideTaskOptions = {},
): Promise<SideTaskReply> {
  return complete(config, model, system, user, options);
}

/**
 * The request `ask` and `askJson` share, sent by `runTurn`, with `format` deciding the extra body
 * fields from what the model and the model server have refused, rebuilt on every send.
 *
 * @param config - Where to send it, and how long a reply may stay silent. Its `baseUrl` and key
 * also pick the capabilities the request is negotiated against.
 * @param model - The model to ask, and the one whose refusals are negotiated.
 * @param system - The instruction, sent as the system message.
 * @param user - The input, sent as the user message as it was given.
 * @param options - A side task's options. A `reasoningEffort` that is a level leaves the
 * no-thinking hints out; absent, `""` or `"off"` sends them unless the model has refused them.
 * The hints and the keys of `extraBody` are offered to `negotiate` as droppable.
 * @param [format] - Builds the extra body fields from the model server's capabilities and
 * the model's.
 * Called on every send, so a re-send is built from what has been latched since. Absent adds none.
 * @returns The reply as `answerOf` reads it, empty when there was no answer, and its
 * `finish_reason`. Throws what `runTurn` throws.
 */
async function complete(
  config: Endpoint,
  model: string,
  system: string,
  user: SideTaskInput,
  {
    maxTokens = 512,
    temperature = 0.3,
    reasoningEffort,
    extraBody,
    maxRetries = SIDE_TASK_RETRIES,
    signal,
    onNotice,
  }: SideTaskOptions,
  format?: (supports: Capabilities, refused: ModelCapabilities) => Record<string, unknown>,
): Promise<SideTaskReply> {
  // The effort the caller chose, or empty where it chose none: `""` and `"off"` read as absent,
  // since off is what the hints below already ask for.
  const level = effortFor(undefined, reasoningEffort);
  // The model server's own object, not one of this module's: what a model refuses is the same fact
  // whether an exchange or a side task found it out, and the point of latching it is that only one
  // of them has to pay for it.
  const supports = capabilitiesFor(config);
  // A chosen effort replaces the template hint rather than riding beside it: `enable_thinking:
  // false` next to `reasoning_effort: "high"` is a request that contradicts itself.
  const isHinted = level === '' && modelCapabilitiesFor(supports, model).thinkingHints;
  const hints = isHinted ? NO_THINKING : {};
  // After the hints, so a caller's own `chat_template_kwargs` is the one sent.
  const optional = { ...hints, ...extraBody };
  const build: RequestBuilder = (latched, refused) => {
    // `none` is what a side task wants and not always what the model offers: OpenAI's reasoning
    // models refuse it by value and list `minimal` as their floor. `effortFor` answers with the
    // cheapest rung this one takes, which `negotiate` has been stepping up as it was refused.
    // A level the caller chose goes through the same ladder, which only ever steps up from it.
    const effort = effortFor(refused, level || EFFORT_NONE);
    return {
      // The reasoning models want the ceiling spelled the other way, and they are exactly the
      // models a side task most wants to stop deliberating. One that will only run at its own
      // temperature is sent none: a side task wants the same answer twice, and 1.0 from that
      // model is as close as it gets.
      ...ceilingAndTemperature(refused, maxTokens, temperature),
      ...(effort ? { reasoning_effort: effort as OpenAI.ReasoningEffort } : {}),
      ...(latched.usageInStream ? { stream_options: { include_usage: true } } : {}),
      ...extraFields(refused, optional),
      ...(format && refused ? format(latched, refused) : {}),
      model,
      messages: [
        { role: Role.System, content: system },
        { role: Role.User, content: user },
      ],
      stream: true,
    };
  };
  // One allowance for the silence before the reply and within it, which is the one wait a side
  // task has always had: `requestTimeoutSeconds`.
  const turn = await runTurn(getClient(config), supports, build, {
    model,
    droppable: Object.keys(optional),
    maxRetries,
    onNotice,
    signal,
    idleMs: idleTimeoutMs(config),
  });
  return { text: answerOf(turn), finishReason: turn.finishReason || undefined };
}

/**
 * A reply's answer, scratchpad stripped, or the scratchpad itself where the answer is nothing else.
 *
 * @param turn - The reply, its fenced scratchpad already split out of `content` by `streamTurn`.
 * @returns The content, trimmed, with any fence the reader left stripped. Where that leaves
 * nothing, a scratchpad the server sent in a field of its own, read the same way, and an empty
 * string where there is none.
 *
 * @remarks
 * Reasoning models that ignore the hints still fence their scratchpad. A side task answers under
 * a small ceiling, so the fence often never closes, and a template that opened it in the prompt
 * leaves only the close; either way the scratchpad used to come back as the answer. A scratchpad
 * split out of a fence is not an answer, so only one from its own field is fallen back on.
 */
function answerOf(turn: Turn): string {
  const answer = stripThinking(turn.content).trim();
  if (answer) {
    return answer;
  }
  // Nothing but scratchpad. Some servers put the scratchpad in its own field and leave the
  // content genuinely empty, in which case there is no answer to find anywhere else.
  return turn.reasoningField ? stripThinking(turn.reasoning).trim() : '';
}

/** What `askJson` takes besides a side task's options. */
export interface AskJsonOptions extends SideTaskOptions {
  /**
   * What the schema is called in the request. Letters, digits, `_` and `-`.
   *
   * @defaultValue `'answer'`
   */
  name?: string;
  /**
   * Asks the server to hold the reply to the schema exactly. OpenAI's strict mode wants every
   * property required and `additionalProperties: false`; a schema written otherwise wants this
   * off there.
   *
   * @defaultValue `true`
   */
  strict?: boolean;
}

/**
 * A side task whose answer is JSON matching a schema, parsed. Undefined when no JSON came back.
 * Throws like any request.
 *
 * @param config - Where to send it and how long to wait.
 * @param model - The model to ask.
 * @param system - The instruction. The schema is appended to it.
 * @param user - The input it applies to. Content parts where the model is being shown an image.
 * @param schema - The JSON Schema of the answer. Its root is held to an object, as a tool's is.
 * @param [options] - A side task's options, plus the schema's `name` and whether it is `strict`.
 * @returns What the reply parsed to, unchecked against the schema: `T` is the caller's claim.
 * `undefined` when `parseJson` found nothing in it, as in a reply cut off before its JSON closed.
 *
 * @remarks
 * Sends `response_format` with the schema, which a llama.cpp server compiles into a grammar and
 * vLLM, LM Studio, Ollama and OpenAI each hold the reply to, so a small model that wraps JSON in
 * prose cannot. The schema is normalised as a tool's parameters are, and relaxed where the model
 * server could not build a grammar, since the same converter reads both. A model that refuses the
 * field latches it off and is asked in words: the schema rides on the system prompt either way, and
 * the reply goes through `parseJson`, which finds the JSON in whatever came back.
 */
export async function askJson<T>(
  config: Endpoint,
  model: string,
  system: string,
  user: SideTaskInput,
  schema: Record<string, unknown>,
  { name = 'answer', strict = true, ...options }: AskJsonOptions = {},
): Promise<T | undefined> {
  const sanitized = sanitizeSchema(schema);
  const instruction = `${system}\n\nReply with JSON alone, matching this JSON Schema:\n${JSON.stringify(sanitized)}`;
  const { text } = await complete(config, model, instruction, user, options, (supports, refused) =>
    refused.structuredOutput
      ? {
          response_format: {
            type: JSON_SCHEMA_FORMAT,
            json_schema: {
              name,
              strict,
              schema: supports.strictSchemas ? sanitized : relaxSchema(sanitized),
            },
          },
        }
      : {},
  );
  return parseJson<T>(text);
}

/**
 * Runs a side task and answers `undefined` where it fails, so the work it supports carries on.
 *
 * @param label - Names the task in the notice when it fails.
 * @param run - The call to attempt. Anything it throws becomes `undefined`, an abort excepted.
 * @param [options] - `onNotice`, told what was given up on, and the `signal` that `run` is
 * cancelled by.
 * @returns What `run` resolved with, or `undefined` when it threw. Whatever it threw once the
 * signal had aborted is thrown on and raises no notice, as is an error that is itself an abort.
 *
 * @remarks
 * A side task is never worth failing the work it supports. Callers that can carry on without
 * an answer use this and get `undefined` instead of an exception.
 */
export async function tryAsk<T>(
  label: string,
  run: () => Promise<T>,
  { onNotice, signal }: Pick<SideTaskOptions, 'onNotice' | 'signal'> = {},
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    // A cancelled exchange is not a failed side task. Swallowing the abort made the two
    // indistinguishable and left the cancellation with nowhere to go. The signal is asked first:
    // an abort with a reason of the caller's own rejects with that reason, which no class names.
    const wasCancelled = signal?.aborted === true || isAbort(error);
    if (wasCancelled) {
      throw error;
    }
    onNotice?.(`${label}: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * The first array or object in a model's reply, parsed, whatever prose or fence surrounds it.
 *
 * @param text - The reply, fences and prose included. Nothing parseable gives `undefined`.
 * @returns What lies between the first `[` or `{` and the last `]` or `}`, parsed — inside the
 * first fenced block where there is one. Unchecked: `T` is the caller's claim. `undefined` when
 * there is no such stretch or it will not parse even repaired.
 *
 * @remarks
 * Models are asked for JSON and often answer with prose around it, or a fenced block, and a
 * wrapper is not worth failing the task over.
 *
 * What is pulled out is read the way a tool call's arguments are: as written where that parses,
 * and otherwise with the almost-JSON a local model writes repaired — single quotes, `True` and
 * `None`, bare keys, a trailing comma. A small model asked for a list gets these wrong as often in
 * a reply as in a call, and a side task that fails over one costs the exchange a second request.
 */
export function parseJson<T>(text: string): T | undefined {
  const [fenced] = text.matchAll(CODE_FENCE);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) {
    return undefined;
  }
  const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
  if (end <= start) {
    return undefined;
  }
  return looseJson(body.slice(start, end + 1)) as T | undefined;
}

/**
 * Strips the quoting and list punctuation models decorate short answers with.
 *
 * @param line - One line of a reply.
 * @returns The line trimmed, without one leading bullet or number, any quotes or backticks at
 * either end, or trailing full stops. Empty when nothing else was there.
 */
export const clean = (line: string) =>
  line
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s*/, '')
    .replace(/^["'`]+|["'`.]+$/g, '')
    .trim();

/**
 * A list-shaped reply, one item per line, cleaned of the bullets and quotes models decorate
 * them with. Overlong items are dropped rather than truncated — a suggestion that has to be
 * squinted at is worse than one fewer suggestion.
 *
 * @param text - The reply, one item per line.
 * @param max - How many items to keep.
 * @param maxChars - Longest item kept. Longer ones are dropped, not truncated.
 * @returns The first `max` items that survive, in reply order. Lines that clean to nothing are not
 * items, and an overlong one does not count towards `max`.
 */
export const listLines = (text: string, max: number, maxChars: number) =>
  text
    .split('\n')
    .map(clean)
    .filter((line) => line.length > 0 && line.length <= maxChars)
    .slice(0, max);

/**
 * A side task's settings as the call that honours them: its model server, its model, and the
 * options `ask`, `askReply`, `askJson`, `summariser` and `preselect` take last.
 *
 * @param task - The task, ordinarily `resolved.tasks.<key>`.
 * @param [options] - What the app adds — cancellation, notices, `keywords` — and its own defaults
 * for the settings a task may leave out.
 * @param [agent] - The model server the main turn uses, key and `fetch` included. Absent sends the
 * task's model server as it stands.
 * @returns The three arguments a side-task entry point takes. `options` is a new object, and
 * `endpoint` is the task's own object when no `agent` was given, a copy otherwise.
 *
 * @remarks
 * A helper rather than a second signature on each entry point, so a setting added to a task later
 * arrives through `options` without an app's call changing. What the task states wins over the
 * same field in `options`: the app's code is written once and the task is what an operator
 * configured over it, so an app passes its own ceiling as the value for a task that names none.
 * `extraBody` is merged key by key, the task's keys winning, as layers merge it.
 * A setting the task leaves out and `options` does too is absent from the result, which is what
 * leaves it to the entry point's own default — 0.3, not the agent's temperature.
 *
 * A resolved spec carries no key, so a task on the agent's own model server would otherwise go out
 * unkeyed, and be remembered under a second capability entry beside the agent's. Given `agent`,
 * such a task is sent the agent's `baseUrl` as the agent spells it and, having no key of its own,
 * the agent's key, so `capabilitiesFor` answers both with one object; a task on another model
 * server is sent only a key of its own, as `resolveApiKey` has it. The environment is not read: the
 * agent's key is whatever the main turn is sent.
 *
 * The agent's `fetch` goes where its key would, to a task on the agent's model server with none of
 * its own, and never to another model server, whose task sends through its own `endpoint.fetch`.
 */
export function taskCall<Options extends SideTaskOptions = SideTaskOptions>(
  task: SideTask,
  options?: Options,
  agent?: EndpointIdentity & Pick<Endpoint, 'fetch'>,
): { endpoint: Endpoint; model: string; options: Options } {
  const own = task.endpoint;
  const shared = agent && (!own.baseUrl.trim() || sameUrl(own.baseUrl, agent.baseUrl));
  const fetch = own.fetch ?? (shared ? agent.fetch : undefined);
  const stated: SideTaskOptions = {};
  if (task.maxTokens !== undefined) {
    stated.maxTokens = task.maxTokens;
  }
  if (task.temperature !== undefined) {
    stated.temperature = task.temperature;
  }
  if (task.reasoningEffort !== undefined) {
    stated.reasoningEffort = task.reasoningEffort;
  }
  if (task.extraBody !== undefined) {
    stated.extraBody = { ...options?.extraBody, ...task.extraBody };
  }
  return {
    endpoint: agent
      ? {
          ...own,
          ...(shared ? { baseUrl: agent.baseUrl } : {}),
          apiKey: resolveApiKey(own, agent, {}),
          ...(fetch ? { fetch } : {}),
        }
      : own,
    model: task.model,
    options: { ...options, ...stated } as Options,
  };
}
