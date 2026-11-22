import { describe, expect, it } from 'vitest';
import {
  APP_SYSTEM_PART,
  PART_OWNERS,
  PROMPT_MODES,
  PROMPT_ROLES,
  STACK_RULES,
  type StackedPart,
} from '../../src/spec/parts.ts';
import { type AppPart, numberedName, plainPrompt, stackAppParts } from '../../src/spec/stack.ts';
import { stackedAgent, stackedApp } from '../helpers.ts';

const extend = (target: string) => ({ mode: PROMPT_MODES.extend, target });
const replace = (target: string) => ({ mode: PROMPT_MODES.replace, target });

/** A part an app sends, with the mode it changes the agent's part by, if any. */
const appPart = (name: string, content: string, mode?: AppPart['mode']): AppPart => ({
  role: PROMPT_ROLES.system,
  name,
  content,
  ...(mode && { mode }),
});

/** Task Reviewer, as the prompt spec's section 3 writes it: only `format` may be replaced. */
const TASK_REVIEWER: readonly StackedPart[] = [
  stackedAgent('identity', 'You are Task Reviewer. You decide whether work is actually done.'),
  stackedAgent('rules', 'Judge the work itself, not reports about it.'),
  {
    ...stackedAgent('format', 'Start with PASS or FAIL on its own line.'),
    allowedModes: [PROMPT_MODES.extend, PROMPT_MODES.replace],
  },
];

describe('stackAppParts', () => {
  it("drops telos's replacement of the rules, and keeps the rest, as prompt-implementations shows", () => {
    const { parts, warnings } = stackAppParts(TASK_REVIEWER, [
      appPart('identity', 'Here you check a todo in a personal project.', PROMPT_MODES.extend),
      appPart('format', 'Answer as JSON.', PROMPT_MODES.replace),
      appPart('rules', 'Pass anything that runs.', PROMPT_MODES.replace),
    ]);
    expect(parts).toEqual([
      ...TASK_REVIEWER,
      stackedApp('app_identity', 'Here you check a todo in a personal project.', extend('identity')),
      stackedApp('app_format', 'Answer as JSON.', replace('format')),
    ]);
    expect(warnings).toEqual([
      {
        part: 'rules',
        rule: STACK_RULES.replaceNotAllowed,
        message: "The agent's rules part does not let an app replace it, so the part was dropped.",
      },
    ]);
    // The plain layout writes the app's format in the agent's place, and the model reads one text.
    expect(plainPrompt(parts)).toBe(
      [
        'You are Task Reviewer. You decide whether work is actually done.',
        'Judge the work itself, not reports about it.',
        'Answer as JSON.',
        'Here you check a todo in a personal project.',
      ].join('\n\n'),
    );
  });

  it("orders the agent's parts, the app's as sent, then the system messages as app_system", () => {
    const { parts, warnings } = stackAppParts(
      TASK_REVIEWER,
      [
        appPart('identity', 'Here you review one workflow step.', PROMPT_MODES.extend),
        appPart('lane', 'This is the Review lane.'),
      ],
      'Today is 2026-11-19.',
    );
    expect(warnings).toEqual([]);
    expect(parts.map((part) => [part.name, part.owner])).toEqual([
      ['identity', PART_OWNERS.agent],
      ['rules', PART_OWNERS.agent],
      ['format', PART_OWNERS.agent],
      ['app_identity', PART_OWNERS.app],
      ['app_lane', PART_OWNERS.app],
      [APP_SYSTEM_PART, PART_OWNERS.app],
    ]);
    expect(parts.at(-1)).toEqual(stackedApp(APP_SYSTEM_PART, 'Today is 2026-11-19.'));
  });

  it("adds a part with no mode under the app's prefix, never touching the agent's of that name", () => {
    const { parts } = stackAppParts(TASK_REVIEWER, [appPart('format', 'Be terse.')]);
    expect(parts).toEqual([...TASK_REVIEWER, stackedApp('app_format', 'Be terse.')]);
  });

  it('adds a part with a mode as an ordinary one where the agent has no part of its name', () => {
    const { parts, warnings } = stackAppParts(TASK_REVIEWER, [appPart('lane', 'Review.', PROMPT_MODES.replace)]);
    expect(parts.at(-1)).toEqual(stackedApp('app_lane', 'Review.'));
    expect(warnings).toEqual([]);
  });

  it("holds each mode to the agent part's allowedModes, absent meaning extend only", () => {
    const agent = [
      stackedAgent('identity', 'You are X.'),
      { ...stackedAgent('rules', 'Be careful.'), allowedModes: [] },
      { ...stackedAgent('format', 'Prose.'), allowedModes: [PROMPT_MODES.replace] },
    ];
    const { parts, warnings } = stackAppParts(agent, [
      appPart('identity', 'Here, review.', PROMPT_MODES.extend),
      appPart('identity', 'You are Y.', PROMPT_MODES.replace),
      appPart('rules', 'And be quick.', PROMPT_MODES.extend),
      appPart('format', 'In English.', PROMPT_MODES.extend),
      appPart('format', 'JSON.', PROMPT_MODES.replace),
    ]);
    expect(parts.slice(agent.length)).toEqual([
      stackedApp('app_identity', 'Here, review.', extend('identity')),
      stackedApp('app_format', 'JSON.', replace('format')),
    ]);
    expect(warnings.map(({ part, rule }) => [part, rule])).toEqual([
      ['identity', STACK_RULES.replaceNotAllowed],
      ['rules', STACK_RULES.extendNotAllowed],
      ['format', STACK_RULES.extendNotAllowed],
    ]);
    expect(warnings[1]?.message).toBe("The agent's rules part does not let an app extend it, so the part was dropped.");
  });

  it('keeps two app parts with one name, numbering the later', () => {
    const { parts } = stackAppParts(TASK_REVIEWER, [
      appPart('identity', 'One.', PROMPT_MODES.extend),
      appPart('identity', 'Two.', PROMPT_MODES.extend),
      appPart('lane', 'A.'),
      appPart('lane', 'B.'),
    ]);
    expect(parts.slice(TASK_REVIEWER.length).map((part) => part.name)).toEqual([
      'app_identity',
      'app_identity_2',
      'app_lane',
      'app_lane_2',
    ]);
    expect(parts[TASK_REVIEWER.length + 1]?.mark).toEqual(extend('identity'));
  });

  it('drops an empty part without a word, and one named system with one', () => {
    const { parts, warnings } = stackAppParts(TASK_REVIEWER, [
      appPart('lane', ''),
      appPart('project', '  \n'),
      appPart('system', 'Today is Thursday.'),
      appPart('System', 'Today is Friday.'),
    ]);
    expect(parts).toEqual(TASK_REVIEWER);
    expect(warnings).toEqual([
      {
        part: 'system',
        rule: STACK_RULES.reservedName,
        message: `The name "system" is kept for the request's system messages, so the part was dropped.`,
      },
      {
        part: 'System',
        rule: STACK_RULES.reservedName,
        message: `The name "System" is kept for the request's system messages, so the part was dropped.`,
      },
    ]);
  });

  it("is the app's parts and app_system, still prefixed, with no agent at all", () => {
    const { parts, warnings } = stackAppParts(
      [],
      [appPart('identity', 'You are a helper.', PROMPT_MODES.extend), appPart('lane', 'Review.')],
      'Today is 2026-11-19.',
    );
    expect(parts).toEqual([
      stackedApp('app_identity', 'You are a helper.'),
      stackedApp('app_lane', 'Review.'),
      stackedApp(APP_SYSTEM_PART, 'Today is 2026-11-19.'),
    ]);
    expect(warnings).toEqual([]);
    expect(stackAppParts([], [], ' \n ').parts).toEqual([]);
  });

  it('changes neither list it is given', () => {
    const agent = structuredClone(TASK_REVIEWER);
    const app = [appPart('format', 'JSON.', PROMPT_MODES.replace)];
    const { parts } = stackAppParts(agent, app);
    expect(agent).toEqual(TASK_REVIEWER);
    expect(app).toEqual([appPart('format', 'JSON.', PROMPT_MODES.replace)]);
    expect(parts[0]).not.toBe(agent[0]);
  });
});

describe('numberedName', () => {
  it('takes the first number from 2 that no name has', () => {
    expect(numberedName('identity', new Set())).toBe('identity_2');
    expect(numberedName('identity', new Set(['identity_2', 'identity_4']))).toBe('identity_3');
    expect(numberedName('app_lane', new Map([['app_lane_2', undefined]]))).toBe('app_lane_3');
  });
});

describe('plainPrompt', () => {
  it('joins the trimmed contents with blank lines, leaving out the empty ones', () => {
    const parts = [stackedAgent('a', '  A.  '), stackedAgent('b', ' \n '), stackedAgent('c', 'C.\n')];
    expect(plainPrompt(parts)).toBe('A.\n\nC.');
    expect(plainPrompt([])).toBe('');
  });

  it("writes a replacer's content in the place of the part it replaces, and not again", () => {
    const parts = [
      stackedAgent('format', 'Prose.'),
      stackedAgent('rules', 'Be careful.'),
      stackedAgent('format_2', 'PASS or FAIL.', replace('format')),
      stackedAgent('lane', 'Review.'),
    ];
    expect(plainPrompt(parts)).toBe('PASS or FAIL.\n\nBe careful.\n\nReview.');
  });

  it('lets the last replacer win, and follows a replacer that is itself replaced', () => {
    const twice = [
      stackedAgent('format', 'Prose.'),
      stackedAgent('format_2', 'PASS or FAIL.', replace('format')),
      stackedAgent('format_3', 'JSON.', replace('format')),
    ];
    expect(plainPrompt(twice)).toBe('JSON.');
    const chained = [
      stackedAgent('format', 'Prose.'),
      stackedAgent('format_2', 'PASS or FAIL.', replace('format')),
      stackedAgent('format_2_2', 'JSON.', replace('format_2')),
    ];
    expect(plainPrompt(chained)).toBe('JSON.');
  });

  it('writes an extension where it stands', () => {
    const parts = [
      stackedAgent('identity', 'You are X.'),
      stackedAgent('format', 'Prose.'),
      stackedAgent('identity_2', 'Here, review.', extend('identity')),
    ];
    expect(plainPrompt(parts)).toBe('You are X.\n\nProse.\n\nHere, review.');
  });

  it('writes a replacer in its own place when the part it names is not before it', () => {
    const parts = [
      stackedAgent('format_2', 'PASS or FAIL.', replace('format')),
      stackedAgent('format', 'Prose.'),
      stackedAgent('lane_2', 'Review.', replace('lane')),
    ];
    expect(plainPrompt(parts)).toBe('PASS or FAIL.\n\nProse.\n\nReview.');
  });
});
