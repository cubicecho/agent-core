import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Everything one runtime remembers: each module's state, under a key only that module holds.
 *
 * A map rather than a record of named caches, so a module that grows a cache declares it where
 * it is used and `runtime.ts` does not have to hear about it.
 */
export type Scope = Map<symbol, unknown>;

/**
 * Which scope the code running now belongs to, carried across every `await` beneath a runtime's
 * method. Async context rather than a parameter, because the state is read five calls down —
 * `runAgentLoop` to `runTurn` to `negotiate` to `capabilitiesFor` — and threading it would put a
 * runtime argument on every exported function in between.
 */
const active = new AsyncLocalStorage<Scope>();

/** The default runtime's scope: what the top-level functions use when no runtime is running. */
export const rootScope: Scope = new Map();

/** The scope of the runtime whose method is running, or the default one outside any. */
export const currentScope = (): Scope => active.getStore() ?? rootScope;

/**
 * Runs `fn` with `scope` as the current one, for it and for everything it awaits or schedules.
 *
 * @param scope The runtime's state. Nested calls replace it for their own duration only.
 * @param fn What to run. Its return value, or what it throws, is handed straight back.
 */
export const inScope = <T>(scope: Scope, fn: () => T): T => active.run(scope, fn);

/** One module's state, read from whichever scope is current. See `scoped`. */
export interface Scoped<T> {
  /** The current scope's copy, made on first use. */
  (): T;
  /** Drops the current scope's copy, so the next read makes a fresh one. */
  reset(): void;
}

/**
 * Declares a piece of module state that every runtime has its own copy of.
 *
 * What used to be `const cache = new Map()` at the top of a module is `scoped(() => new Map())`,
 * and each use reads `cache()`. The copy is made lazily, so a runtime pays only for the modules
 * it touches.
 *
 * @param create Builds a fresh, empty copy. Called once per scope, and again after `reset`.
 */
export function scoped<T>(create: () => T): Scoped<T> {
  const key = Symbol();
  const read = (): T => {
    const scope = currentScope();
    if (!scope.has(key)) scope.set(key, create());
    return scope.get(key) as T;
  };
  return Object.assign(read, {
    reset: () => {
      currentScope().delete(key);
    },
  });
}
