import { describe, expect, it } from "vitest";
import { parseToolArguments, recoverToolCalls, ToolArgumentsError } from "../src/tool-calls.ts";

describe("parseToolArguments", () => {
  it("reads an object, and reads empty as none", () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments("  ")).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
    expect(parseToolArguments(null)).toEqual({});
  });

  it("passes an already-parsed object through", () => {
    const args = { a: [1] };
    expect(parseToolArguments(args)).toBe(args);
  });

  it("opens JSON a string was holding", () => {
    expect(parseToolArguments(JSON.stringify('{"a":1}'))).toEqual({ a: 1 });
  });

  it("repairs the almost-JSON local models write", () => {
    expect(parseToolArguments("{'path': 'a.txt', 'force': True, 'depth': None,}")).toEqual({
      path: "a.txt",
      force: true,
      depth: null,
    });
    expect(parseToolArguments('{path: "it\'s", list: [1, 2,],}')).toEqual({
      path: "it's",
      list: [1, 2],
    });
    expect(parseToolArguments(`{'say': 'a "quoted" word'}`)).toEqual({ say: 'a "quoted" word' });
  });

  it("leaves what is inside a string alone", () => {
    expect(parseToolArguments(`{'text': 'True, } None: x'}`)).toEqual({ text: "True, } None: x" });
  });

  it("refuses what is not an object, as malformed", () => {
    for (const raw of ["[1]", "{nope", "42"]) {
      const error = (() => {
        try {
          parseToolArguments(raw);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(ToolArgumentsError);
      expect((error as ToolArgumentsError).kind).toBe("malformed");
    }
    expect(() => parseToolArguments("[1]")).toThrow("not an object");
    expect(() => parseToolArguments("{nope")).toThrow("invalid tool arguments");
  });

  it("calls a failure at the ceiling truncated", () => {
    expect(() => parseToolArguments('{"a": "lo', { finishReason: "length" })).toThrow(
      expect.objectContaining({ kind: "truncated", message: expect.stringContaining("maxTokens") }),
    );
  });
});

describe("recoverToolCalls", () => {
  const names = ["read", "write"];

  it("takes Hermes and Qwen tool_call blocks out of the text", () => {
    const text =
      'Reading both.\n<tool_call>\n{"name": "read", "arguments": {"path": "a"}}\n</tool_call>\n<tool_call>{"name": "read", "arguments": "{\\"path\\": \\"b\\"}"}</tool_call>';
    expect(recoverToolCalls(text)).toEqual({
      content: "Reading both.",
      toolCalls: [
        {
          id: "call_recovered_0",
          type: "function",
          function: { name: "read", arguments: '{"path":"a"}' },
        },
        {
          id: "call_recovered_1",
          type: "function",
          function: { name: "read", arguments: '{"path": "b"}' },
        },
      ],
    });
  });

  it("reads a block the model never closed", () => {
    const { toolCalls } = recoverToolCalls('<tool_call>{"name": "read", "arguments": {}}');
    expect(toolCalls[0].function).toEqual({ name: "read", arguments: "{}" });
  });

  it("reads Qwen3-Coder's function markup", () => {
    const text =
      "<tool_call>\n<function=write>\n<parameter=path>\nnotes.md\n</parameter>\n<parameter=lines>\n3\n</parameter>\n</function>\n</tool_call>";
    expect(recoverToolCalls(text)).toEqual({
      content: "",
      toolCalls: [
        {
          id: "call_recovered_0",
          type: "function",
          function: { name: "write", arguments: '{"path":"notes.md","lines":3}' },
        },
      ],
    });
  });

  it("reads Mistral's two spellings", () => {
    const list = recoverToolCalls('[TOOL_CALLS] [{"name": "read", "arguments": {"path": "a"}}]');
    expect(list.toolCalls.map((c) => c.function.name)).toEqual(["read"]);
    const named = recoverToolCalls('[TOOL_CALLS]read[ARGS]{"path": "a"}[TOOL_CALLS]write[ARGS]{}');
    expect(named.toolCalls.map((c) => c.function)).toEqual([
      { name: "read", arguments: '{"path":"a"}' },
      { name: "write", arguments: "{}" },
    ]);
    expect(named.content).toBe("");
  });

  it("reads Llama's python_tag, parameters and all", () => {
    const text =
      '<|python_tag|>{"name": "read", "parameters": {"path": "a"}}; {"name": "write", "parameters": {}}<|eom_id|>';
    const { content, toolCalls } = recoverToolCalls(text);
    expect(toolCalls.map((c) => c.function.name)).toEqual(["read", "write"]);
    expect(toolCalls[0].function.arguments).toBe('{"path":"a"}');
    expect(content).toBe("");
  });

  it("reads a bare or fenced call only when it names a tool that exists", () => {
    const bare = '{"name": "read", "arguments": {"path": "a"}}';
    expect(recoverToolCalls(bare, { names }).toolCalls).toHaveLength(1);
    expect(recoverToolCalls(bare).toolCalls).toEqual([]);
    expect(recoverToolCalls('{"name": "Ada", "arguments": 1}', { names }).toolCalls).toEqual([]);
    const fenced = `I'll look.\n\`\`\`json\n{"function": {"name": "read", "arguments": {}}}\n\`\`\``;
    expect(recoverToolCalls(fenced, { names })).toMatchObject({
      content: "I'll look.",
      toolCalls: [{ function: { name: "read", arguments: "{}" } }],
    });
  });

  it("ignores a call the model only thought about", () => {
    const text = '<think>maybe <tool_call>{"name": "read"}</tool_call></think>No tools needed.';
    expect(recoverToolCalls(text, { names })).toEqual({ content: text, toolCalls: [] });
  });

  it("leaves plain text as it was", () => {
    expect(recoverToolCalls("The answer is {x}.", { names })).toEqual({
      content: "The answer is {x}.",
      toolCalls: [],
    });
  });
});
