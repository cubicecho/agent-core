import { AsyncLocalStorage } from 'node:async_hooks';
import { getOrCreate, isPositive } from './guards.ts';

/**
 * Everything one runtime remembers: each module's state, under a key only that module holds.
 *
 * @remarks
 * A map rather than a record of named caches, so a module that grows a cache declares it where
 * it is used and `runtime.ts` does not have to hear about it.
 */
export type Scope = Map<symbol, NonNullable<unknown>>;

/**
 * Which scope the code running now belongs to, carried across every `await` beneath a runtime's
 * method. Async context rather than a parameter, because the state is read five calls down —
 * `runAgentLoop` to `runTurn` to `negotiate` to `capabilitiesFor` — and threading it would put a
 * runtime argument on every exported function in between.
 */
const active = new AsyncLocalStorage<Scope>();

/** The default runtime's scope: what the top-level functions use when no runtime is running. */
export const rootScope: Scope = new Map();

/**
 * The scope of the runtime whose method is running, or the default one outside any.
 *
 * @returns The scope itself, not a copy — writing to it is writing to that runtime's state.
 */
export const currentScope = (): Scope => active.getStore() ?? rootScope;

/**
 * Runs `fn` with `scope` as the current one, for it and for everything it awaits or schedules.
 *
 * @param scope - The runtime's state. Nested calls replace it for their own duration only.
 * @param fn - What to run. Its return value, or what it throws, is handed straight back.
 * @returns What `fn` returned, as it returned it — from an async one the promise itself, unawaited.
 */
export const inScope = <T>(scope: Scope, fn: () => T): T => active.run(scope, fn);

/** One module's state, read from whichever scope is current. See `scoped`. */
export interface Scoped<T extends {}> {
  /** The current scope's copy, made on first use. */
  (): T;
  /** Drops the current scope's copy, so the next read makes a fresh one. */
  reset(): void;
}

/**
 * Declares a piece of module state that every runtime has its own copy of.
 *
 * @param create - Builds a fresh, empty copy. Called once per scope, and again after `reset`.
 * @returns A function that reads the copy of whichever scope is current when it is called, not
 * when this was, with a `reset` on it that drops that scope's copy.
 *
 * @remarks
 * What used to be `const cache = new Map()` at the top of a module is `scoped(() => new Map())`,
 * and each use reads `cache()`. The copy is made lazily, so a runtime pays only for the modules
 * it touches.
 */
export function scoped<T extends {}>(create: () => T): Scoped<T> {
  const key = Symbol();
  const read = (): T => {
    return getOrCreate(currentScope(), key, create) as T;
  };
  return Object.assign(read, {
    reset: () => {
      currentScope().delete(key);
    },
  });
}

/**
 * Writes what a caller gave onto the settings in force, field by field, skipping what is unusable.
 *
 * @param held - The settings in force. Written to — the same object the module goes on reading.
 * @param options - What to change. A field left out is left alone.
 * @param [usable] - Whether a value may be written under a name.
 * @returns A copy of everything in force afterwards, including what this call did not change.
 *
 * @remarks
 * The body of every `configure*`: a module's settings are one object per runtime, read where they
 * are used, so writing a field onto it is what makes the change apply from the next read. A field
 * that fails its check keeps what it had, which is how a half-built config narrows nothing.
 */
export function assignSettings<T extends object>(
  held: T,
  options: Partial<T>,
  usable: (value: unknown, name: string) => boolean = isPositive,
): T {
  for (const [name, value] of Object.entries(options)) {
    if (usable(value, name)) {
      held[name as keyof T] = value as T[keyof T];
    }
  }
  return { ...held };
}
