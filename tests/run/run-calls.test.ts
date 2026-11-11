import { describe, expect, it } from 'vitest';
import { formatToolError, preview } from '../../src/run/run-calls.ts';

describe('preview', () => {
  it('cuts long text and says how long it was', () => {
    expect(preview('abc', 5)).toBe('abc');
    expect(preview('abcdefgh', 5)).toBe('abcde… (8 chars)');
  });
});

describe('formatToolError', () => {
  it('opens a failure with Error: so it cannot read as an answer', () => {
    expect(formatToolError(new Error('42'))).toBe('Error: 42');
    expect(formatToolError('no rows')).toBe('Error: no rows');
  });

  it('leaves a message that already opens with error as it was', () => {
    expect(formatToolError(new Error('Error: disk full'))).toBe('Error: disk full');
    expect(formatToolError(new Error('error 404 from upstream'))).toBe('error 404 from upstream');
    expect(formatToolError(new Error('Errors were found'))).toBe('Error: Errors were found');
  });

  it('says a failure that gave no message failed all the same', () => {
    expect(formatToolError(new Error(''))).toBe('Error: (no output)');
    expect(formatToolError(new Error('  \n'))).toBe('Error: (no output)');
  });
});
