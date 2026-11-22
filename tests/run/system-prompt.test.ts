import { describe, expect, it } from 'vitest';
import { stackRequest, withoutAgentCore, writeSystemPrompt } from '../../src/run/system-prompt.ts';
import { PRECEDENCE_TEXT } from '../../src/spec/layout.ts';
import type { StackedPart } from '../../src/spec/parts.ts';
import { Role } from '../../src/wire/wire.ts';

const agent = (name: string, content: string, extra: Partial<StackedPart> = {}): StackedPart => ({
  role: 'system',
  name,
  content,
  owner: 'agent',
  ...extra,
});
const reviewer = [
  agent('identity', 'You are Task Reviewer.'),
  agent('format', 'Start with PASS or FAIL.', { allowedModes: ['extend', 'replace'] }),
];
const chat = [
  { role: Role.System, content: 'Today is 2026-11-19.' },
  { role: Role.User, content: 'Card 812' },
] as const;

describe('stackRequest', () => {
  it("stacks the app's parts and takes the leading system messages in as app_system", () => {
    const agentCore = { prompt: [{ role: 'system', name: 'format', mode: 'replace', content: 'Answer as JSON.' }] };
    const stacked = stackRequest(reviewer, agentCore, [...chat]);
    expect(stacked.leading).toBe(1);
    expect(stacked.parts.map((part) => part.name)).toEqual(['identity', 'format', 'app_format', 'app_system']);
    expect(stacked.warnings).toEqual([]);
  });

  it('says what it dropped, and reads a string prompt as the lead', () => {
    const agentCore = { prompt: [{ role: 'system', name: 'identity', mode: 'replace', content: 'Be lenient.' }] };
    const stacked = stackRequest('You are an assistant.', agentCore, []);
    expect(stacked.lead).toBe('You are an assistant.');
    // With no agent's part to act on, the mode is moot and the part is added.
    expect(stacked.parts.map((part) => part.name)).toEqual(['app_identity']);
    const strict = stackRequest(reviewer, agentCore, []);
    expect(strict.warnings).toEqual([
      "The agent's identity part does not let an app replace it, so the part was dropped.",
    ]);
  });

  it('names the agent_core field a malformed prompt came in', () => {
    const { warnings } = stackRequest(reviewer, { prompt: 'Answer as JSON.' }, []);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].startsWith('agent_core.prompt')).toBe(true);
  });
});

describe('writeSystemPrompt', () => {
  const stacked = stackRequest(
    reviewer,
    { prompt: [{ role: 'system', name: 'format', mode: 'replace', content: 'Answer as JSON.' }] },
    [...chat],
  );

  it("writes the loop's sections before app_system, which comes last", () => {
    const { text } = writeSystemPrompt(stacked, 'xml', ['<tool_catalogue>\nS:\n</tool_catalogue>']);
    expect(text).toBe(
      [
        '<prompt_identity>\nYou are Task Reviewer.\n</prompt_identity>',
        '<prompt_format>\nStart with PASS or FAIL.\n</prompt_format>',
        `<precedence>\n${PRECEDENCE_TEXT.xml}\n</precedence>`,
        '<prompt_app_format replaces="format">\nAnswer as JSON.\n</prompt_app_format>',
        '<tool_catalogue>\nS:\n</tool_catalogue>',
        '<prompt_app_system>\nToday is 2026-11-19.\n</prompt_app_system>',
      ].join('\n\n'),
    );
  });

  it('writes the precedence sentence when app_system is the only app part', () => {
    const { text } = writeSystemPrompt(stackRequest(reviewer, undefined, [...chat]), 'markdown', []);
    expect(text).toBe(
      [
        '## Identity\n\nYou are Task Reviewer.',
        '## Format\n\nStart with PASS or FAIL.',
        `## Precedence\n\n${PRECEDENCE_TEXT.markdown}`,
        '## App System\n\nToday is 2026-11-19.',
      ].join('\n\n'),
    );
  });

  it('writes no app_system and no precedence for a request with no system messages', () => {
    const { text } = writeSystemPrompt(stackRequest(reviewer, undefined, [chat[1]]), 'xml', []);
    expect(text).toBe(
      '<prompt_identity>\nYou are Task Reviewer.\n</prompt_identity>\n\n<prompt_format>\nStart with PASS or FAIL.\n</prompt_format>',
    );
  });

  it('writes a replace as an overwrite in plain, with app_system after the sections', () => {
    const { text } = writeSystemPrompt(stacked, 'plain', ['# Tool catalogue']);
    expect(text).toBe('You are Task Reviewer.\n\nAnswer as JSON.\n\n# Tool catalogue\n\nToday is 2026-11-19.');
  });
});

describe('withoutAgentCore', () => {
  it('leaves a body without the field alone, and copies one with it', () => {
    const body = { top_k: 20 };
    expect(withoutAgentCore(body)).toBe(body);
    expect(withoutAgentCore({ top_k: 20, agent_core: { prompt: [] } })).toEqual({ top_k: 20 });
    expect(withoutAgentCore(undefined)).toBeUndefined();
  });
});
