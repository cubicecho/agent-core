import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDiscovery } from '../../src/core/config.ts';
import { RunEventKind } from '../../src/run/events.ts';
import { FinishReason, Role } from '../../src/wire/wire.ts';
import { type Body, chunks, config, type Message, says, tool } from '../helpers.ts';

const create = vi.fn();
/** Only the SDK-touching half is replaced; the rest of the client module is pure. */
vi.mock('../../src/endpoint/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/endpoint/client.ts')>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { runAgentLoop } = await import('../../src/run/agent-loop.ts');
const { resetCapabilities } = await import('../../src/endpoint/capabilities.ts');
const { CALL_TOOL } = await import('../../src/tools/tool-loading.ts');
const { RECORD_ARTIFACT } = await import('../../src/run/artifacts.ts');

type ToolCallRequest = import('../../src/wire/tool-calls.ts').ToolCallRequest;
type ToolCallResult = import('../../src/wire/tool-calls.ts').ToolCallResult;
type RunEventInput = import('../../src/run/events.ts').RunEventInput;

/** A turn that asks for these calls. */
const calls = (...list: [name: string, args: Record<string, unknown>][]) =>
  chunks({
    choices: [
      {
        delta: {
          tool_calls: list.map(([name, args], index) => ({
            index,
            id: `c${index}`,
            function: { name, arguments: JSON.stringify(args) },
          })),
        },
        finish_reason: FinishReason.ToolCalls,
      },
    ],
  });

const question: Message[] = [{ role: Role.User, content: 'hi' }];
const bodies = () => create.mock.calls.map(([body]) => body as Body);
/** What each request was sent, by the name of every tool it declared. */
const declared = () =>
  bodies().map((body) => (body.tools ?? []).map((t) => (t as OpenAI.ChatCompletionFunctionTool).function.name));
const results = (messages: Message[]) =>
  messages.flatMap((message) => (message.role === Role.Tool ? [String(message.content)] : []));
const names = ['fs__write_file', 'fs__read_file', 'fs__edit_file'];
const tools = names.map(tool);
const write = { path: 'work/plan.md', content: '# Plan' };

beforeEach(() => create.mockReset());
afterEach(() => resetCapabilities());

describe('artifacts', () => {
  it('collects nothing but links, and declares no tool, unless asked', async () => {
    create.mockReturnValueOnce(calls(['fs__write_file', write])).mockReturnValueOnce(says('done'));
    const result = await runAgentLoop({ config, messages: question, tools, dispatch: async () => 'wrote' });
    expect(result.artifacts).toEqual([]);
    expect(declared()[0]).not.toContain(RECORD_ARTIFACT);
  });

  describe('detect', () => {
    it('reads a successful write as an artifact, telling watchers once', async () => {
      create
        .mockReturnValueOnce(calls(['fs__write_file', write]))
        .mockReturnValueOnce(calls(['fs__edit_file', { path: 'work/plan.md', content: '# Plan, again' }]))
        .mockReturnValueOnce(says('done'));
      const events: RunEventInput[] = [];
      const result = await runAgentLoop({
        config,
        messages: question,
        tools,
        artifacts: { detect: true },
        dispatch: async () => 'wrote',
        onEvent: (event) => events.push(event),
      });
      expect(result.artifacts).toEqual([
        {
          link: { uri: 'work/plan.md', name: 'plan.md', mimeType: 'text/markdown' },
          callId: 'c0',
          tool: 'fs__write_file',
          step: 0,
          count: 2,
          source: 'detected',
          action: 'updated',
          sizeBytes: 13,
        },
      ]);
      expect(events.filter((event) => event.kind === RunEventKind.Artifact).map(({ text }) => text)).toEqual([
        'work/plan.md',
      ]);
      expect(result.metrics.artifacts).toBe(1);
    });

    it('makes nothing of a write that threw, or one the predicate does not pass', async () => {
      create
        .mockReturnValueOnce(calls(['fs__write_file', write], ['board__create_note', { path: 'note/1' }]))
        .mockReturnValueOnce(says('done'));
      const result = await runAgentLoop({
        config,
        messages: question,
        tools: [...tools, tool('board__create_note')],
        artifacts: { detect: ({ name }: ToolCallRequest) => name.startsWith('board__') === false },
        dispatch: async ({ name }) => {
          if (name === 'fs__write_file') {
            throw new Error('disk full');
          }
          return 'noted';
        },
      });
      expect(result.artifacts).toEqual([]);
    });

    it('lets a link to the same location take over', async () => {
      create.mockReturnValueOnce(calls(['fs__write_file', write])).mockReturnValueOnce(says('done'));
      const result = await runAgentLoop({
        config,
        messages: question,
        tools,
        artifacts: { detect: true },
        dispatch: async () => ({ text: 'wrote', links: [{ uri: 'work/plan.md', name: 'plan', title: 'Plan' }] }),
      });
      expect(result.artifacts).toEqual([
        {
          // The write's guess fills only what the server's link left out.
          link: { uri: 'work/plan.md', name: 'plan', title: 'Plan', mimeType: 'text/markdown' },
          callId: 'c0',
          tool: 'fs__write_file',
          step: 0,
          count: 1,
          action: 'created',
          sizeBytes: 6,
        },
      ]);
    });
  });

  describe('declare', () => {
    it('declares record_artifact after the host tools on every step, and never dispatches it', async () => {
      create
        .mockReturnValueOnce(calls(['fs__write_file', write]))
        .mockReturnValueOnce(calls([RECORD_ARTIFACT, { location: '/work/plan.md', title: 'Plan' }]))
        .mockReturnValueOnce(says('done'));
      const dispatch = vi.fn(async (_call: ToolCallRequest) => 'wrote');
      const handed: ToolCallResult[] = [];
      const result = await runAgentLoop({
        config,
        messages: question,
        tools: [tool('fs__write_file')],
        hostTools: [tool('ask_person')],
        toolOrder: false,
        artifacts: { declare: true },
        dispatch,
        onToolResult: (answer) => handed.push(answer),
      });
      expect(declared()).toEqual([
        ['fs__write_file', RECORD_ARTIFACT, 'ask_person'],
        ['fs__write_file', RECORD_ARTIFACT, 'ask_person'],
        ['fs__write_file', RECORD_ARTIFACT, 'ask_person'],
      ]);
      expect(dispatch.mock.calls.map(([call]) => call.name)).toEqual(['fs__write_file']);
      expect(results(result.messages)).toEqual(['wrote', 'Recorded /work/plan.md.']);
      expect(handed.map(({ name, ok }) => ({ name, ok }))).toEqual([
        { name: 'fs__write_file', ok: true },
        { name: RECORD_ARTIFACT, ok: true },
      ]);
      // Put down to the write that touched it, not to the declaration.
      expect(result.artifacts).toEqual([
        {
          link: { uri: '/work/plan.md', name: 'plan.md', title: 'Plan', mimeType: 'text/markdown' },
          callId: 'c0',
          tool: 'fs__write_file',
          step: 0,
          count: 1,
          source: 'declared',
        },
      ]);
      expect(result.used).toEqual(['fs__write_file']);
      expect(result.toolCalls.map(({ name }) => name)).toEqual(['fs__write_file', RECORD_ARTIFACT]);
    });

    it('refuses a location no call in the run touched, for the model to read', async () => {
      create
        .mockReturnValueOnce(calls(['fs__read_file', { path: 'in.md' }]))
        .mockReturnValueOnce(calls([RECORD_ARTIFACT, { location: 'answer.md' }], [RECORD_ARTIFACT, {}]))
        .mockReturnValueOnce(says('done'));
      const result = await runAgentLoop({
        config,
        messages: question,
        tools,
        artifacts: { declare: true },
        dispatch: async () => 'contents',
      });
      expect(results(result.messages).slice(1)).toEqual([
        'No tool call in this run touched answer.md, so it was not recorded. Record only what one of your tools stored, after the call that stored it.',
        'record_artifact needs a location.',
      ]);
      expect(result.toolCalls.map(({ ok }) => ok)).toEqual([true, false, false]);
      expect(result.artifacts).toEqual([]);
    });

    it('does not believe a call that threw', async () => {
      create
        .mockReturnValueOnce(calls(['fs__write_file', write]))
        .mockReturnValueOnce(calls([RECORD_ARTIFACT, { location: 'work/plan.md' }]))
        .mockReturnValueOnce(says('done'));
      const result = await runAgentLoop({
        config,
        messages: question,
        tools,
        artifacts: { declare: true },
        dispatch: async () => {
          throw new Error('disk full');
        },
      });
      expect(result.artifacts).toEqual([]);
    });

    it('waits for the rest of its batch, so a write beside it in parallel is believed', async () => {
      create
        .mockReturnValueOnce(
          calls([RECORD_ARTIFACT, { location: 'work/plan.md', title: 'Plan' }], ['fs__write_file', write]),
        )
        .mockReturnValueOnce(says('done'));
      const result = await runAgentLoop({
        config,
        messages: question,
        tools,
        parallel: true,
        artifacts: { declare: true },
        dispatch: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return 'wrote';
        },
      });
      // Results still go back in the order asked.
      expect(results(result.messages)).toEqual(['Recorded work/plan.md.', 'wrote']);
      expect(result.artifacts.map(({ callId, source, link }) => ({ callId, source, title: link.title }))).toEqual([
        { callId: 'c1', source: 'declared', title: 'Plan' },
      ]);
    });

    it('fills in a detection and takes over its source, keeping the write’s action', async () => {
      create
        .mockReturnValueOnce(calls(['fs__edit_file', write]))
        .mockReturnValueOnce(calls([RECORD_ARTIFACT, { location: 'work/plan.md', title: 'Plan', description: 'It.' }]))
        .mockReturnValueOnce(says('done'));
      const result = await runAgentLoop({
        config,
        messages: question,
        tools,
        artifacts: { declare: true, detect: true },
        dispatch: async () => 'edited',
      });
      expect(result.artifacts).toEqual([
        {
          link: { uri: 'work/plan.md', name: 'plan.md', title: 'Plan', description: 'It.', mimeType: 'text/markdown' },
          callId: 'c0',
          tool: 'fs__edit_file',
          step: 0,
          count: 1,
          source: 'declared',
          action: 'updated',
          sizeBytes: 6,
        },
      ]);
    });

    it('is declared beside the proxy tools, and refused through call_tool', async () => {
      create
        .mockReturnValueOnce(calls([CALL_TOOL, { name: RECORD_ARTIFACT, arguments: { location: 'x' } }]))
        .mockReturnValueOnce(says('done'));
      const dispatch = vi.fn(async () => 'never');
      const result = await runAgentLoop({
        config: { ...config, toolDiscovery: ToolDiscovery.Proxy },
        messages: question,
        tools,
        catalog: [{ id: 'fs', label: 'FS', tools: names.map((name) => ({ name, description: name })) }],
        artifacts: { declare: true },
        dispatch,
      });
      expect(declared()[0]).toContain(RECORD_ARTIFACT);
      expect(dispatch).not.toHaveBeenCalled();
      expect(results(result.messages)[0]).toContain('call it directly');
    });
  });
});
