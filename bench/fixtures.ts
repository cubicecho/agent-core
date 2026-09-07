import type OpenAI from "openai";
import type { RunEvent } from "../src/events.ts";

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
  type: "function",
  function: {
    name: `server_${index % 4}__group__tool_${index}`,
    description: `Does the ${index}th thing, at some length, the way an MCP server describes it.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", pattern: "^[\\w/.-]+$", description: "Where to look." },
        mode: { type: ["string", "null"], enum: ["read", "write"] },
        when: { type: "string", format: "date-time" },
        filter: {
          type: "object",
          properties: {
            match: { anyOf: [{ type: "string", pattern: "\\d+" }, { type: "null" }] },
            limit: { type: "integer" },
            nested: {
              type: "object",
              properties: { deep: { type: "string", format: "uri" } },
            },
          },
        },
        tags: { type: "array", items: { type: "string", pattern: "^[a-z]+$" } },
      },
      required: ["path"],
    },
  },
});

export const mcpTools = (count = 25) => Array.from({ length: count }, (_, i) => mcpTool(i));

/** A transcript after a dozen tool iterations — a few hundred kilobytes of messages. */
export function transcript(turns = 40): OpenAI.ChatCompletionMessageParam[] {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: "You are an agent. ".repeat(60) },
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `Request ${i}. ${"context ".repeat(120)}` });
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call_${i}`,
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: `/f/${i}`, n: i }) },
        },
      ],
    });
    messages.push({ role: "tool", tool_call_id: `call_${i}`, content: "result ".repeat(200) });
  }
  return messages;
}

export const streamingBody = (
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionTool[],
): OpenAI.ChatCompletionCreateParamsStreaming => ({ model: "m", stream: true, messages, tools });

/** A reasoning turn's worth of deltas, as the bus stores them. */
export const deltas = (count = 20_000): RunEvent[] =>
  Array.from({ length: count }, (_, i) => ({
    runId: "bench",
    seq: i + 1,
    at: Date.now(),
    kind: i % 2000 === 1999 ? ("output" as const) : ("thinking" as const),
    text: "token ",
    name: "",
    step: i < count / 2 ? "plan" : "act",
    ok: null,
    usage: null,
  }));
