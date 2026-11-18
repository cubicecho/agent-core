import { describe, expect, it, vi } from 'vitest';
import { assignSettings, currentScope, inScope, rootScope, type Scope, scoped } from '../../src/core/scope.ts';

describe('currentScope', () => {
  it('is the root scope outside any runtime', () => {
    expect(currentScope()).toBe(rootScope);
  });
});

describe('inScope', () => {
  it('hands back what the function returned', () => {
    expect(inScope(new Map(), () => 7)).toBe(7);
  });

  it('carries the scope across an await', async () => {
    const scope: Scope = new Map();
    const seen = await inScope(scope, async () => {
      await Promise.resolve();
      return currentScope();
    });
    expect(seen).toBe(scope);
  });

  it('replaces the scope only for the nested call', () => {
    const outer: Scope = new Map();
    const inner: Scope = new Map();
    const seen = inScope(outer, () => [inScope(inner, () => currentScope()), currentScope()]);
    expect(seen[0]).toBe(inner);
    expect(seen[1]).toBe(outer);
  });
});

describe('scoped', () => {
  it('keeps one copy per scope, made on first read', () => {
    const create = vi.fn(() => new Set<string>());
    const store = scoped(create);
    expect(create).not.toHaveBeenCalled();
    const a: Scope = new Map();
    const b: Scope = new Map();
    inScope(a, () => store().add('a'));
    inScope(b, () => store().add('b'));
    expect(inScope(a, () => [...store()])).toEqual(['a']);
    expect(inScope(b, () => [...store()])).toEqual(['b']);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('resets only the current scope, which makes a fresh copy on the next read', () => {
    const store = scoped(() => new Set<string>());
    const a: Scope = new Map();
    const b: Scope = new Map();
    inScope(a, () => store().add('a'));
    inScope(b, () => store().add('b'));
    const before = inScope(a, () => store());
    inScope(a, () => store.reset());
    expect(inScope(a, () => store())).not.toBe(before);
    expect(inScope(a, () => store().size)).toBe(0);
    expect(inScope(b, () => [...store()])).toEqual(['b']);
  });

  it('gives two stores in one scope a copy each', () => {
    const first = scoped(() => new Set<string>());
    const second = scoped(() => new Set<string>());
    inScope(new Map(), () => {
      first().add('x');
      expect(second().size).toBe(0);
    });
  });
});

describe('assignSettings', () => {
  it('writes each usable field onto the settings in force and leaves the rest alone', () => {
    const held = { limit: 10, timeoutMs: 500 };
    assignSettings(held, { limit: 20 });
    expect(held).toEqual({ limit: 20, timeoutMs: 500 });
  });

  it('keeps the value in force where the new one fails its check', () => {
    const held = { limit: 10, timeoutMs: 500 };
    assignSettings(held, { limit: 0, timeoutMs: -1 });
    expect(held).toEqual({ limit: 10, timeoutMs: 500 });
  });

  it('ignores a key that is not one of the settings', () => {
    const held = { limit: 10 };
    // Cast on purpose: a typo, as an untyped config would carry it.
    const answer = assignSettings(held, { limt: 20 } as Partial<typeof held>);
    expect(held).toEqual({ limit: 10 });
    expect(answer).toEqual({ limit: 10 });
  });

  it('answers a copy of everything in force, not the settings themselves', () => {
    const held = { limit: 10, timeoutMs: 500 };
    const answer = assignSettings(held, { timeoutMs: 900 });
    expect(answer).toEqual({ limit: 10, timeoutMs: 900 });
    expect(answer).not.toBe(held);
  });

  it('asks the check about each value under its name', () => {
    const held = { name: 'a', limit: 10 };
    const usable = vi.fn((value: unknown, name: string) => name === 'name' && typeof value === 'string');
    assignSettings(held, { name: 'b', limit: 20 }, usable);
    expect(usable.mock.calls).toEqual([
      ['b', 'name'],
      [20, 'limit'],
    ]);
    expect(held).toEqual({ name: 'b', limit: 10 });
  });
});
