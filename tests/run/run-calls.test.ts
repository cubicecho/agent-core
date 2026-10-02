import { describe, expect, it } from 'vitest';
import { preview } from '../../src/run/run-calls.ts';

describe('preview', () => {
  it('cuts long text and says how long it was', () => {
    expect(preview('abc', 5)).toBe('abc');
    expect(preview('abcdefgh', 5)).toBe('abcde… (8 chars)');
  });
});
