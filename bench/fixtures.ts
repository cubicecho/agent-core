import type OpenAI from 'openai';
import type { RunEvent } from '../src/run/events.ts';
import { RunEventKind } from '../src/run/events.ts';
import { FUNCTION_TOOL, Role, SchemaType } from '../src/wire/wire.ts';

/**
 * Shapes big enough for the costs to show.
 *
 * Every number here is the size the thing actually reaches in a run rather than a round one: a
 * couple of connected MCP servers is a couple of dozen tools, a reasoning turn is tens of
 * thousands of deltas, and a transcript that has been through a dozen tool iterations is a few
 * hundred kilobytes. A bench over a toy input measures the harness.
 */

/** One MCP-shaped tool: nested objects, a nullable union, a pattern, a format. */
export const mcpTool = (index: number): OpenAI.ChatCompletionTool => ({
  type: FUNCTION_TOOL,
  function: {
    name: `server_${index % 4}__group__tool_${index}`,
    description: `Does the ${index}th thing, at some length, the way an MCP server describes it.`,
    parameters: {
      type: SchemaType.Object,
      properties: {
        path: { type: SchemaType.String, pattern: '^[\\w/.-]+$', description: 'Where to look.' },
        mode: { type: [SchemaType.String, SchemaType.Null], enum: ['read', 'write'] },
        when: { type: SchemaType.String, format: 'date-time' },
        filter: {
          type: SchemaType.Object,
          properties: {
            match: { anyOf: [{ type: SchemaType.String, pattern: '\\d+' }, { type: SchemaType.Null }] },
            limit: { type: SchemaType.Integer },
            nested: {
              type: SchemaType.Object,
              properties: { deep: { type: SchemaType.String, format: 'uri' } },
            },
          },
        },
        tags: { type: SchemaType.Array, items: { type: SchemaType.String, pattern: '^[a-z]+$' } },
      },
      required: ['path'],
    },
  },
});

export const mcpTools = (count = 25) => Array.from({ length: count }, (_, i) => mcpTool(i));

/** A transcript after a dozen tool iterations — a few hundred kilobytes of messages. */
export function transcript(turns = 40): OpenAI.ChatCompletionMessageParam[] {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: Role.System, content: 'You are an agent. '.repeat(60) },
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: Role.User, content: `Request ${i}. ${'context '.repeat(120)}` });
    messages.push({
      role: Role.Assistant,
      content: null,
      tool_calls: [
        {
          id: `call_${i}`,
          type: FUNCTION_TOOL,
          function: { name: 'read_file', arguments: JSON.stringify({ path: `/f/${i}`, n: i }) },
        },
      ],
    });
    messages.push({ role: Role.Tool, tool_call_id: `call_${i}`, content: 'result '.repeat(200) });
  }
  return messages;
}

export const streamingBody = (
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionTool[],
): OpenAI.ChatCompletionCreateParamsStreaming => ({ model: 'm', stream: true, messages, tools });

/** A reasoning turn's worth of deltas, as the bus stores them. */
export const deltas = (count = 20_000): RunEvent[] =>
  Array.from({ length: count }, (_, i) => ({
    runId: 'bench',
    seq: i + 1,
    at: Date.now(),
    kind: i % 2000 === 1999 ? RunEventKind.Output : RunEventKind.Thinking,
    text: 'token ',
    name: '',
    step: i < count / 2 ? 'plan' : 'act',
    ok: null,
    usage: null,
  }));
