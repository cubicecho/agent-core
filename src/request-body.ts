import type OpenAI from 'openai';
import { type Capabilities, ceilingAndTemperature, effortFor, type ModelCapabilities } from './capabilities.ts';
import { type ModelParams, RESERVED_BODY_FIELDS } from './config.ts';
import { relaxTools, sanitizeTools } from './schema-compat.ts';
import { orderTools, type ToolOrder } from './tool-loading.ts';

/**
 * The one place a streamed request's body is decided from a config and what the endpoint and
 * the model have refused.
 *
 * Every field that negotiates lives here: the ceiling's two spellings, a temperature only a
 * model that takes ours is sent, a reasoning effort only one that takes it is, `stream_options`
 * only where the server has heard of it, relaxed schemas only where it could not build a grammar,
 * and `extraBody` last, less whatever the model refused by name. The ceiling is tested
 * `=== false` — `modelCapabilitiesFor` starts a model at `legacyTokenLimit: true` and an absent
 * one has to read the same — which is the test one of the three copies had inverted.
 *
 * @param config - What to ask for. `maxTokens` of zero or less sends no ceiling; `reasoningEffort`
 * absent or `"off"` sends no effort, and one the model has refused by value is stepped up to the
 * cheapest it takes by `effortFor`.
 * @param supports - What the endpoint has refused, as `negotiate` hands it to `send`.
 * @param refused - What the model has refused, as `negotiate` hands it over. Absent is a model
 * that has refused nothing.
 * @param messages - The request's messages, system prompt included, sent as they are.
 * @param [tools] - The tool definitions. Ordered by name, sanitised here — a lookup for a definition
 * seen before — and relaxed where the endpoint needs it. Empty sends no `tools` field at all.
 * @param [order] - How to order them before sending. `true` is by name, which keeps the cache
 * when the caller's array is assembled differently from one request to the next. See
 * `orderTools`.
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
  const extra = Object.entries(config.extraBody ?? {}).filter(
    ([field]) => !RESERVED_BODY_FIELDS.includes(field) && !refused?.refusedFields.has(field),
  );
  return {
    ...ceilingAndTemperature(refused, config.maxTokens, config.temperature),
    ...(effort ? { reasoning_effort: effort as OpenAI.ReasoningEffort } : {}),
    ...(supports.usageInStream ? { stream_options: { include_usage: true } } : {}),
    ...Object.fromEntries(extra),
    model: config.model,
    messages,
    stream: true,
    ...(declared.length ? { tools: declared } : {}),
  };
}
