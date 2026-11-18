import { describe, expect, it } from 'vitest';
import * as defaults from '../../src/core/defaults.ts';

const groups = Object.entries(defaults);

describe('the defaults groups', () => {
  it('are all named for what they tune', () => {
    expect(groups.length).toBeGreaterThan(0);
    for (const [name] of groups) {
      expect(name).toMatch(/^[A-Z_]+_DEFAULTS$/);
    }
  });

  it('are frozen, so nothing can assign to a member while the program runs', () => {
    for (const [, group] of groups) {
      expect(Object.isFrozen(group)).toBe(true);
    }
  });

  it('hold only what JSON can, so a group survives being saved and read back', () => {
    for (const [, group] of groups) {
      expect(JSON.parse(JSON.stringify(group))).toEqual(group);
    }
  });
});
