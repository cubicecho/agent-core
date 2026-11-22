import { describe, expect, it } from 'vitest';
import { callIdMinter } from '../../src/wire/call-ids.ts';
import {
  ARGUMENTS_MALFORMED,
  ARGUMENTS_TRUNCATED,
  parseToolArguments,
  recoverToolCalls,
  ToolArgumentsError,
} from '../../src/wire/tool-calls.ts';
import { FinishReason, FUNCTION_TOOL } from '../../src/wire/wire.ts';
import { MINTED_ID } from '../helpers.ts';

describe('parseToolArguments', () => {
  it('reads an object, and reads empty as none', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments('  ')).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
    expect(parseToolArguments(null)).toEqual({});
  });

  it('passes an already-parsed object through', () => {
    const args = { a: [1] };
    expect(parseToolArguments(args)).toBe(args);
  });

  it('reads a value a server parsed into something other than an object as its JSON', () => {
    expect(() => parseToolArguments(42)).toThrow(expect.objectContaining({ kind: ARGUMENTS_MALFORMED }));
    expect(() => parseToolArguments(true)).toThrow('not an object: true');
  });

  it('opens JSON a string was holding', () => {
    expect(parseToolArguments(JSON.stringify('{"a":1}'))).toEqual({ a: 1 });
  });

  it('repairs the almost-JSON local models write', () => {
    expect(parseToolArguments("{'path': 'a.txt', 'force': True, 'depth': None,}")).toEqual({
      path: 'a.txt',
      force: true,
      depth: null,
    });
    expect(parseToolArguments('{path: "it\'s", list: [1, 2,],}')).toEqual({
      path: "it's",
      list: [1, 2],
    });
    expect(parseToolArguments(`{'say': 'a "quoted" word'}`)).toEqual({ say: 'a "quoted" word' });
  });

  it('leaves what is inside a string alone', () => {
    expect(parseToolArguments(`{'text': 'True, } None: x'}`)).toEqual({ text: 'True, } None: x' });
  });

  it('refuses what is not an object, as malformed', () => {
    for (const raw of ['[1]', '{nope', '42']) {
      const error = (() => {
        try {
          parseToolArguments(raw);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(ToolArgumentsError);
      expect((error as ToolArgumentsError).kind).toBe(ARGUMENTS_MALFORMED);
    }
    expect(() => parseToolArguments('[1]')).toThrow('not an object');
    expect(() => parseToolArguments('{nope')).toThrow('invalid tool arguments');
  });

  it('calls a failure at the ceiling truncated', () => {
    expect(() => parseToolArguments('{"a": "lo', { finishReason: FinishReason.Length })).toThrow(
      expect.objectContaining({ kind: ARGUMENTS_TRUNCATED, message: expect.stringContaining('maxTokens') }),
    );
  });
});

describe('recoverToolCalls', () => {
  const names = ['read', 'write'];

  it('takes Hermes and Qwen tool_call blocks out of the text', () => {
    const text =
      'Reading both.\n<tool_call>\n{"name": "read", "arguments": {"path": "a"}}\n</tool_call>\n<tool_call>{"name": "read", "arguments": "{\\"path\\": \\"b\\"}"}</tool_call>';
    const expected = callIdMinter(1);
    expect(recoverToolCalls(text, { mintCallId: callIdMinter(1) })).toEqual({
      content: 'Reading both.',
      toolCalls: [
        {
          id: expected(),
          type: FUNCTION_TOOL,
          function: { name: 'read', arguments: '{"path":"a"}' },
        },
        {
          id: expected(),
          type: FUNCTION_TOOL,
          function: { name: 'read', arguments: '{"path": "b"}' },
        },
      ],
    });
  });

  it('reads a block the model never closed', () => {
    const { toolCalls } = recoverToolCalls('<tool_call>{"name": "read", "arguments": {}}');
    expect(toolCalls[0].function).toEqual({ name: 'read', arguments: '{}' });
  });

  it("reads Qwen3-Coder's function markup", () => {
    const text =
      '<tool_call>\n<function=write>\n<parameter=path>\nnotes.md\n</parameter>\n<parameter=lines>\n3\n</parameter>\n</function>\n</tool_call>';
    expect(recoverToolCalls(text)).toEqual({
      content: '',
      toolCalls: [
        {
          id: expect.stringMatching(MINTED_ID),
          type: FUNCTION_TOOL,
          function: { name: 'write', arguments: '{"path":"notes.md","lines":3}' },
        },
      ],
    });
  });

  it("reads Mistral's two spellings", () => {
    const list = recoverToolCalls('[TOOL_CALLS] [{"name": "read", "arguments": {"path": "a"}}]');
    expect(list.toolCalls.map((c) => c.function.name)).toEqual(['read']);
    const named = recoverToolCalls('[TOOL_CALLS]read[ARGS]{"path": "a"}[TOOL_CALLS]write[ARGS]{}');
    expect(named.toolCalls.map((c) => c.function)).toEqual([
      { name: 'read', arguments: '{"path":"a"}' },
      { name: 'write', arguments: '{}' },
    ]);
    expect(named.content).toBe('');
  });

  it("reads Llama's python_tag, parameters and all", () => {
    const text =
      '<|python_tag|>{"name": "read", "parameters": {"path": "a"}}; {"name": "write", "parameters": {}}<|eom_id|>';
    const { content, toolCalls } = recoverToolCalls(text);
    expect(toolCalls.map((c) => c.function.name)).toEqual(['read', 'write']);
    expect(toolCalls[0].function.arguments).toBe('{"path":"a"}');
    expect(content).toBe('');
  });

  it('reads a bare or fenced call only when it names a tool that exists', () => {
    const bare = '{"name": "read", "arguments": {"path": "a"}}';
    expect(recoverToolCalls(bare, { names }).toolCalls).toHaveLength(1);
    expect(recoverToolCalls(bare).toolCalls).toEqual([]);
    expect(recoverToolCalls('{"name": "Ada", "arguments": 1}', { names }).toolCalls).toEqual([]);
    const fenced = `I'll look.\n\`\`\`json\n{"function": {"name": "read", "arguments": {}}}\n\`\`\``;
    expect(recoverToolCalls(fenced, { names })).toMatchObject({
      content: "I'll look.",
      toolCalls: [{ function: { name: 'read', arguments: '{}' } }],
    });
  });

  it('ignores a call the model only thought about', () => {
    const text = '<think>maybe <tool_call>{"name": "read"}</tool_call></think>No tools needed.';
    expect(recoverToolCalls(text, { names })).toEqual({ content: text, toolCalls: [] });
  });

  it('ignores a call the model only thought about inside a harmony or Kimi fence', () => {
    const call = '<tool_call>{"name": "read"}</tool_call>';
    for (const text of [
      `<|channel|>analysis<|message|>maybe ${call}<|end|><|start|>assistant<|channel|>final<|message|>Done.<|return|>`,
      `◁think▷maybe ${call}◁/think▷Done.`,
    ]) {
      expect(recoverToolCalls(text, { names })).toEqual({ content: text, toolCalls: [] });
    }
  });

  it('still recovers a call written after a fence closes', () => {
    const text = '◁think▷I should read it.◁/think▷<tool_call>{"name": "read"}</tool_call>';
    expect(recoverToolCalls(text, { names })).toMatchObject({
      content: '◁think▷I should read it.◁/think▷',
      toolCalls: [{ function: { name: 'read' } }],
    });
  });

  it('finds a fence in any case, where lower-casing the text would move it', () => {
    const text = 'İİ<THINK>Read it.</THINK><tool_call>{"name": "read"}</tool_call>';
    expect(recoverToolCalls(text, { names })).toMatchObject({
      content: 'İİ<THINK>Read it.</THINK>',
      toolCalls: [{ function: { name: 'read' } }],
    });
  });

  it('ignores a call inside a scratchpad that never closes', () => {
    const call = '<tool_call>{"name": "read"}</tool_call>';
    for (const text of [`<think>maybe ${call}`, `<think>a</think>Then.<think>maybe ${call}`]) {
      expect(recoverToolCalls(text, { names })).toEqual({ content: text, toolCalls: [] });
    }
  });

  it('still recovers a call written before a scratchpad that never closes', () => {
    const text = '<tool_call>{"name": "read"}</tool_call><think>Now wait.';
    expect(recoverToolCalls(text, { names })).toMatchObject({
      content: '<think>Now wait.',
      toolCalls: [{ function: { name: 'read' } }],
    });
  });

  it('leaves plain text as it was', () => {
    expect(recoverToolCalls('The answer is {x}.', { names })).toEqual({
      content: 'The answer is {x}.',
      toolCalls: [],
    });
  });

  it('leaves a marker with no readable call after it as text', () => {
    for (const text of [
      '<tool_call>"read"</tool_call>',
      '<tool_call>{"name": 3}</tool_call>',
      '<tool_call>{"name": "read", "arguments": {"path": "a"}',
      '[TOOL_CALLS]read[ARGS][1]',
      '<|python_tag|>nothing',
      '[{"name": "read"}, 3]',
      '{"name": "read"} and then some prose',
      '```json\nnot a call\n```',
      '```\n{"name": "read"} trailing\n```',
    ]) {
      expect(recoverToolCalls(text, { names })).toEqual({ content: text, toolCalls: [] });
    }
  });

  it("takes a marker inside another call's arguments as part of that call", () => {
    const text = '<tool_call>{"name": "read", "arguments": "[TOOL_CALLS]write[ARGS]{}"}</tool_call>';
    expect(recoverToolCalls(text, { names })).toMatchObject({
      content: '',
      toolCalls: [{ function: { name: 'read', arguments: '[TOOL_CALLS]write[ARGS]{}' } }],
    });
  });
});
