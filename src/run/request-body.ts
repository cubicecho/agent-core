import type OpenAI from 'openai';
import type { ModelParams } from '../core/config.ts';
import {
  type Capabilities,
  ceilingAndTemperature,
  effortFor,
  extraFields,
  type ModelCapabilities,
} from '../endpoint/capabilities.ts';
import { relaxTools, sanitizeTools } from '../endpoint/schema-compat.ts';
import { textOf } from '../hooks/hooks.ts';
import { orderTools, type ToolOrder } from '../tools/tool-loading.ts';
import { Role } from '../wire/wire.ts';
import { dropReasoning } from './run-calls.ts';

/** What the texts of several leading system messages are joined with when they become one. */
const SYSTEM_JOIN = '\n\n';

/**
 * A request's leading system messages as one, which is the most system messages some templates
 * take.
 *
 * @param messages - The request's messages, the loop's system prompt first. Not written to.
 * @returns `messages` itself when it opens with fewer than two `system` messages, otherwise a new
 * array whose first message is one `system` message holding their texts in order, a blank line
 * apart, and the rest as they were.
 *
 * @remarks
 * The Qwen3.5 and later templates and Devstral's raise on any `system` message that is not the
 * first, and so does Mistral's v0.3, so a host that keeps its own system message in the transcript
 * beside the loop's `system` option, or a transcript stored with a fold's summary as a `system`
 * message the way earlier versions wrote it, would otherwise fail on every request. The merge is the
 * same text on every step, so the prefix stays stable. A `system` message further down the
 * transcript is the host's and is sent where it is: moving it would change what it is said after.
 */
export function singleSystem(messages: OpenAI.ChatCompletionMessageParam[]): OpenAI.ChatCompletionMessageParam[] {
  const end = messages.findIndex((message) => message.role !== Role.System);
  const lead = end === -1 ? messages.length : end;
  if (lead < 2) {
    return messages;
  }
  const text = messages
    .slice(0, lead)
    .map((message) => textOf(message.content).trim())
    .filter((part) => part !== '')
    .join(SYSTEM_JOIN);
  return [{ role: Role.System, content: text }, ...messages.slice(lead)];
}

/**
 * The one place a streamed request's body is decided from a config and what the endpoint and
 * the model have refused.
 *
 * @param config - What to ask for. `maxTokens` of zero or less sends no ceiling; `reasoningEffort`
 * absent or `"off"` sends no effort, and one the model has refused by value is stepped up to the
 * cheapest it takes by `effortFor`.
 * @param supports - What the endpoint has refused, as `negotiate` hands it to `send`.
 * @param refused - What the model has refused, as `negotiate` hands it over. Absent is a model
 * that has refused nothing.
 * @param messages - The request's messages, system prompt included, sent as they are — less
 * their scratchpads for a model that refused them.
 * @param [tools] - The tool definitions. Ordered by name, sanitised here — a lookup for a definition
 * seen before — and relaxed where the endpoint needs it. Empty sends no `tools` field at all.
 * @param [order] - How to order them before sending. `true` is by name, which keeps the cache
 * when the caller's array is assembled differently from one request to the next. See
 * `orderTools`.
 * @returns A fresh body, always streaming, around the caller's own `messages` array unless a
 * scratchpad had to come off it. `model`,
 * `messages`, `stream` and `tools` are never `extraBody`'s to set.
 *
 * @remarks
 * Every field that negotiates lives here: the ceiling's two spellings, a temperature only a
 * model that takes ours is sent, a reasoning effort only one that takes it is, `stream_options`
 * only where the server has heard of it, relaxed schemas only where it could not build a grammar,
 * and `extraBody` last, less whatever the model refused by name. The ceiling is tested
 * `=== false` — `modelCapabilitiesFor` starts a model at `legacyTokenLimit: true` and an absent
 * one has to read the same — which is the test one of the three copies had inverted.
 */
export function buildBody(
  config: ModelParams,
  supports: Capabilities,
  refused: ModelCapabilities | undefined,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionTool[] = [],
  order: ToolOrder = true,
): OpenAI.ChatCompletionCreateParamsStreaming {
  const sorted = orderTools(tools, order);
  const declared = supports.strictSchemas ? sanitizeTools(sorted) : relaxTools(sanitizeTools(sorted));
  const effort = effortFor(refused, config.reasoningEffort);
  return {
    ...ceilingAndTemperature(refused, config.maxTokens, config.temperature),
    ...(effort ? { reasoning_effort: effort as OpenAI.ReasoningEffort } : {}),
    ...(supports.usageInStream ? { stream_options: { include_usage: true } } : {}),
    ...extraFields(refused, config.extraBody),
    model: config.model,
    messages: refused?.reasoningContent === false ? dropReasoning(messages) : messages,
    stream: true,
    ...(declared.length ? { tools: declared } : {}),
  };
}
