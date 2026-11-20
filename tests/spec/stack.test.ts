import { describe, expect, it } from 'vitest';
import { PART_OWNERS, PROMPT_MODES, PROMPT_ROLES, type StackedPart } from '../../src/spec/parts.ts';
import { numberedName, plainPrompt } from '../../src/spec/stack.ts';

/** A stacked agent's part, marked against another where `mark` says. */
const stacked = (name: string, content: string, mark?: StackedPart['mark']): StackedPart => ({
  role: PROMPT_ROLES.system,
  name,
  content,
  owner: PART_OWNERS.agent,
  ...(mark && { mark }),
});

const extend = (target: string) => ({ mode: PROMPT_MODES.extend, target });
const replace = (target: string) => ({ mode: PROMPT_MODES.replace, target });

describe('numberedName', () => {
  it('takes the first number from 2 that no name has', () => {
    expect(numberedName('identity', new Set())).toBe('identity_2');
    expect(numberedName('identity', new Set(['identity_2', 'identity_4']))).toBe('identity_3');
    expect(numberedName('app_lane', new Map([['app_lane_2', undefined]]))).toBe('app_lane_3');
  });
});

describe('plainPrompt', () => {
  it('joins the trimmed contents with blank lines, leaving out the empty ones', () => {
    const parts = [stacked('a', '  A.  '), stacked('b', ' \n '), stacked('c', 'C.\n')];
    expect(plainPrompt(parts)).toBe('A.\n\nC.');
    expect(plainPrompt([])).toBe('');
  });

  it("writes a replacer's content in the place of the part it replaces, and not again", () => {
    const parts = [
      stacked('format', 'Prose.'),
      stacked('rules', 'Be careful.'),
      stacked('format_2', 'PASS or FAIL.', replace('format')),
      stacked('lane', 'Review.'),
    ];
    expect(plainPrompt(parts)).toBe('PASS or FAIL.\n\nBe careful.\n\nReview.');
  });

  it('lets the last replacer win, and follows a replacer that is itself replaced', () => {
    const twice = [
      stacked('format', 'Prose.'),
      stacked('format_2', 'PASS or FAIL.', replace('format')),
      stacked('format_3', 'JSON.', replace('format')),
    ];
    expect(plainPrompt(twice)).toBe('JSON.');
    const chained = [
      stacked('format', 'Prose.'),
      stacked('format_2', 'PASS or FAIL.', replace('format')),
      stacked('format_2_2', 'JSON.', replace('format_2')),
    ];
    expect(plainPrompt(chained)).toBe('JSON.');
  });

  it('writes an extension where it stands', () => {
    const parts = [
      stacked('identity', 'You are X.'),
      stacked('format', 'Prose.'),
      stacked('identity_2', 'Here, review.', extend('identity')),
    ];
    expect(plainPrompt(parts)).toBe('You are X.\n\nProse.\n\nHere, review.');
  });

  it('writes a replacer in its own place when the part it names is not before it', () => {
    const parts = [
      stacked('format_2', 'PASS or FAIL.', replace('format')),
      stacked('format', 'Prose.'),
      stacked('lane_2', 'Review.', replace('lane')),
    ];
    expect(plainPrompt(parts)).toBe('PASS or FAIL.\n\nProse.\n\nReview.');
  });
});
