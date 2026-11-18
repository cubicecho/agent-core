import { describe, expect, it } from 'vitest';
import { errorMessage } from '../../src/wire/errors.ts';

describe('errorMessage', () => {
  it("reads an Error's message as it is, empty included", () => {
    expect(errorMessage(new Error('broke'))).toBe('broke');
    expect(errorMessage(new Error(''))).toBe('');
  });

  it('stringifies anything that is not an Error', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage({ message: 'not an error' })).toBe('[object Object]');
  });
});
