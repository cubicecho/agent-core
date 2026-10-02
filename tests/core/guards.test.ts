import { describe, expect, it } from 'vitest';
import { byCodeUnit, getOrCreate } from '../../src/core/guards.ts';

describe('byCodeUnit', () => {
  it('puts a capital before a lowercase letter, as their code units stand', () => {
    expect(['beta', 'Zeta', 'alpha'].sort(byCodeUnit)).toEqual(['Zeta', 'alpha', 'beta']);
  });

  it('answers zero for the same string', () => {
    expect(byCodeUnit('same', 'same')).toBe(0);
  });
});

describe('getOrCreate', () => {
  it('makes a value once and hands the same one back after', () => {
    const map = new Map<string, number[]>();
    const made = getOrCreate(map, 'a', () => []);
    expect(getOrCreate(map, 'a', () => [])).toBe(made);
  });

  it('keeps a held value that is falsy', () => {
    const map = new Map([['a', 0]]);
    expect(getOrCreate(map, 'a', () => 1)).toBe(0);
  });

  it('does not take a map whose values may be undefined', () => {
    const map = new Map<string, number | undefined>();
    // @ts-expect-error A stored undefined would read as a miss, so the type leaves it out.
    getOrCreate(map, 'a', () => undefined);
    expect(map.has('a')).toBe(true);
  });
});
