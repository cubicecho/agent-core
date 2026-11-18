import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Scoped } from '../../src/core/scope.ts';

/** One `scoped()` store as it was declared: the store, what builds it, and the module it is in. */
interface Declared {
  store: Scoped<NonNullable<unknown>>;
  create: () => NonNullable<unknown>;
  module: string;
}

const declared = vi.hoisted((): Declared[] => []);

/**
 * `scoped` as it is, but noting every store a module declares, so none can be left out. A store
 * `perFetch` builds is the module's that called `perFetch`.
 */
vi.mock('../../src/core/scope.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/scope.ts')>();
  return {
    ...actual,
    scoped: <T extends {}>(create: () => T) => {
      const store = actual.scoped(create);
      const frames = new Error().stack?.split('\n') ?? [];
      const module =
        frames
          .filter((frame) => frame.includes('perFetch') === false)
          .map((frame) => /\/src\/(\w+\/[\w-]+\.ts)/.exec(frame)?.[1])
          .find(Boolean) ?? '';
      declared.push({ store, create, module });
      return store;
    },
  };
});

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
for (const entry of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
  if (entry.endsWith('.ts')) {
    await import(/* @vite-ignore */ `../../src/${entry}`);
  }
}
const { createRuntime } = await import('../../src/runtime/runtime.ts');

const SENTINEL = Symbol('drift');
const KEY = {};
/** What a set is marked with: a weak reference, as the sets a reset walks hold (`perFetch`'s). */
const HELD = new WeakRef(KEY);
const NUMBER = -1;
const TEXT = 'drift';

/**
 * Writes a mark into every container and over every value a store holds.
 *
 * @param value - The store's copy. Written to.
 */
const dirty = (value: unknown) => {
  if (value instanceof Map) {
    value.set(SENTINEL, SENTINEL);
  } else if (value instanceof Set) {
    value.add(HELD);
  } else if (value instanceof WeakMap) {
    value.set(KEY, SENTINEL);
  } else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    for (const [name, member] of Object.entries(record)) {
      if (typeof member === 'number') {
        record[name] = NUMBER;
      } else if (typeof member === 'string') {
        record[name] = TEXT;
      } else if (typeof member === 'boolean') {
        record[name] = !member;
      } else {
        dirty(member);
      }
    }
  }
};

/**
 * Whether a store reads as freshly made: a new copy, or its old one with every mark gone.
 *
 * @param entry - The store.
 * @param before - Its copy as `dirty` left it.
 * @returns `true` where nothing written before the reset survived it.
 */
const isFresh = ({ store, create }: Declared, before: unknown) => {
  const now = store();
  if (now !== before) {
    return true;
  }
  if (now instanceof WeakMap) {
    return now.has(KEY) === false;
  }
  try {
    expect(now).toEqual(create());
    return true;
  } catch {
    return false;
  }
};

/** The modules that declare a store, each once. */
const modules = [...new Set(declared.map(({ module }) => module))].sort();

describe('every scoped store', () => {
  it('is declared where a module can be named for it', () => {
    expect(declared.length).toBeGreaterThan(0);
    expect(modules).not.toContain('');
  });

  it('is cleared by resetAll', () => {
    const runtime = createRuntime();
    const before = runtime.run(() =>
      declared.map((entry) => {
        const copy = entry.store();
        dirty(copy);
        return copy;
      }),
    );
    runtime.resetAll();
    const kept = runtime.run(() =>
      declared.filter((entry, index) => isFresh(entry, before[index]) === false).map(({ module }) => module),
    );
    expect(kept).toEqual([]);
  });

  it.each(modules)('in %s is cleared by the resets it exports, which a runtime has as methods', async (module) => {
    const exports: Record<string, unknown> = await import(/* @vite-ignore */ `../../src/${module}`);
    const resets = Object.keys(exports).filter((name) => /^reset[A-Z]/.test(name));
    expect(resets.length).toBeGreaterThan(0);
    const runtime = createRuntime();
    const methods = new Map<string, unknown>(Object.entries(runtime));
    for (const reset of resets) {
      expect(methods.get(reset), reset).toBeTypeOf('function');
    }

    const own = declared.filter((entry) => entry.module === module);
    const before = runtime.run(() =>
      own.map((entry) => {
        const copy = entry.store();
        dirty(copy);
        return copy;
      }),
    );
    for (const reset of resets) {
      const method = methods.get(reset);
      const isMethod = typeof method === 'function';
      if (isMethod) {
        method();
      }
    }
    const kept = runtime.run(() => own.filter((entry, index) => isFresh(entry, before[index]) === false));
    expect(kept).toHaveLength(0);
  });
});
