import { describe, expect, it } from 'vitest';
import { baseUrlKey, normalizeBaseUrl } from '../../src/core/config.ts';

describe('normalizeBaseUrl', () => {
  it('keeps an http or https URL, less its trailing slashes and surrounding whitespace', () => {
    expect(normalizeBaseUrl(' http://local/v1/ ')).toBe('http://local/v1');
    expect(normalizeBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(normalizeBaseUrl('http://local:8080//')).toBe('http://local:8080');
  });

  it('writes the scheme and host in lower case and drops a default port, but leaves the path', () => {
    expect(normalizeBaseUrl('HTTP://Local:80/V1')).toBe('http://local/V1');
    expect(normalizeBaseUrl('https://local:443/v1')).toBe('https://local/v1');
  });

  it('refuses anything that is not a plain http or https URL', () => {
    for (const raw of [
      '',
      'local/v1',
      'ftp://local/v1',
      'file:///etc/passwd',
      'http://user:pass@local/v1',
      'http://user@local/v1',
      'http://local/v1?key=sk-1',
      'http://local/v1#models',
    ]) {
      expect(normalizeBaseUrl(raw)).toBeNull();
    }
  });
});

describe('baseUrlKey', () => {
  it('answers what normalizeBaseUrl does for a URL it keeps', () => {
    expect(baseUrlKey(' HTTP://Local:80/v1/ ')).toBe('http://local/v1');
  });

  it('trims a URL normalizeBaseUrl refuses of whitespace and trailing slashes, and nothing else', () => {
    expect(baseUrlKey(' http://local/v1?a=1// ')).toBe('http://local/v1?a=1');
    expect(baseUrlKey('HTTP://user@Local/v1/')).toBe('HTTP://user@Local/v1');
    expect(baseUrlKey('local/v1/')).toBe('local/v1');
  });
});
