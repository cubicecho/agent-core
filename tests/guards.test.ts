import { describe, expect, it } from 'vitest';
import { byCodeUnit } from '../src/guards.ts';

describe('byCodeUnit', () => {
  it('puts a capital before a lowercase letter, as their code units stand', () => {
    expect(['beta', 'Zeta', 'alpha'].sort(byCodeUnit)).toEqual(['Zeta', 'alpha', 'beta']);
  });

  it('answers zero for the same string', () => {
    expect(byCodeUnit('same', 'same')).toBe(0);
  });
});
