import { runAgentLoop } from './agent-loop.ts';
import { calibrate, charsPerTokenFor, resetCalibration } from './calibration.ts';
import { capabilitiesFor, expireCapabilities, resetCapabilities } from './capabilities.ts';
import {
  type ClientPoolOptions,
  configureClients,
  contextLimitFor,
  getClient,
  listModels,
  resetClients,
  servedWindow,
} from './client.ts';
import { compactTranscript, runCompaction, summariser } from './compaction.ts';
import { continueTurn } from './continuation.ts';
import { configureEvents, type EventBusOptions, emit, endRun, history, resetEvents, watch } from './events.ts';
import {
  assembleContext,
  configureHooks,
  consult,
  gather,
  type HookOptions,
  notify,
  resetHooks,
  withContext,
} from './hooks.ts';
import { preselect } from './preselect.ts';
import { resetAll } from './reset.ts';
import { runTurn } from './run-turn.ts';
import { inScope, rootScope, type Scope } from './scope.ts';
import { ask, askJson, resetHints, tryAsk } from './side-task.ts';
import { exportCapabilities, importCapabilities } from './snapshot.ts';

/**
 * Every exported function that reads or writes what a runtime remembers, itself or through what
 * it calls. The rest of the package is pure, and is the same function whichever runtime it is
 * called beside.
 */
const STATEFUL = {
  runAgentLoop,
  preselect,
  runTurn,
  continueTurn,
  ask,
  askJson,
  tryAsk,
  summariser,
  runCompaction,
  compactTranscript,
  getClient,
  listModels,
  contextLimitFor,
  servedWindow,
  configureClients,
  capabilitiesFor,
  expireCapabilities,
  exportCapabilities,
  importCapabilities,
  calibrate,
  charsPerTokenFor,
  emit,
  endRun,
  history,
  watch,
  configureEvents,
  configureHooks,
  gather,
  notify,
  consult,
  assembleContext,
  withContext,
  resetClients,
  resetCapabilities,
  resetCalibration,
  resetHints,
  resetEvents,
  resetHooks,
  resetAll,
};

/** What a runtime starts out configured with. Every field optional; see `createRuntime`. */
export interface RuntimeOptions {
  /** The client pool's bounds, as `configureClients` takes them. */
  clients?: ClientPoolOptions;
  /** The event bus's bounds, as `configureEvents` takes them. */
  events?: EventBusOptions;
  /** The hooks' budget and preface, as `configureHooks` takes them. */
  hooks?: HookOptions;
}

/**
 * One set of the package's caches, with the functions that use them as methods.
 *
 * Each method is the top-level function of the same name, with the same signature and doc
 * comment, run against this runtime's state instead of the process's: its pooled clients and
 * model listings, latched capabilities, measured characters per token, no-thinking hints, event
 * bus, and hook settings. `resetAll` and the six narrower resets clear this runtime alone.
 */
export type Runtime = typeof STATEFUL & {
  /**
   * Runs `fn` with this runtime current, so every top-level function it calls — directly, after
   * an `await`, or from a timer it sets — uses this runtime's state. What the methods do, for
   * code that calls the top-level functions itself.
   *
   * It does not reach a callback that outlives `fn` and is called from elsewhere — a generator
   * resumed later, a function handed back and called by someone else. Call a method there.
   *
   * @param fn - What to run. Its return value, or what it throws, is handed straight back.
   */
  run<T>(fn: () => T): T;
};

/** Makes the methods of the runtime whose state is `scope`. */
function bind(scope: Scope): Runtime {
  const within =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R =>
      inScope(scope, () => fn(...args));
  const methods = Object.fromEntries(
    Object.entries(STATEFUL).map(([name, fn]) => [name, within(fn as (...args: unknown[]) => unknown)]),
  ) as typeof STATEFUL;
  return {
    ...methods,
    // What it hands back is called later, by `compactTranscript` or by the host, and asks then.
    summariser: (...args) => within(summariser(...args)),
    run: (fn) => inScope(scope, fn),
  };
}

/**
 * A runtime of its own: separate clients, listings, capability latches, hints, event bus and hook
 * settings from the process's and from every other runtime's.
 *
 * For a host that must not share them — one that mints a key per tenant, where a shared pool has
 * tenants evicting each other's clients and a shared bus has one tenant's run id readable by
 * another — and for tests, where a runtime per case needs no `resetAll` between them and can run
 * in parallel. A host with one deployment's worth of endpoints does not need one: the top-level
 * functions are the default runtime's methods.
 *
 * The runtime is carried by async context rather than by argument, so `runAgentLoop` called as a
 * method uses this runtime all the way down, and so does a top-level function the host calls from
 * inside it — from `dispatch`, a hook, `onEvent`. Outside a method or `run`, a top-level function
 * is the default runtime's again; a request handler that emits to a run a runtime started calls
 * `runtime.emit`.
 *
 * Nothing needs closing. A runtime is garbage once nothing holds it; its one timer, the event
 * bus's sweep, is unreferenced and stops rescheduling when its last run has been swept.
 *
 * @param [options] - What to configure it with before first use. A part left out keeps the
 * defaults — not the default runtime's settings, which a new runtime does not inherit.
 */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const runtime = bind(new Map());
  if (options.clients) {
    runtime.configureClients(options.clients);
  }
  if (options.events) {
    runtime.configureEvents(options.events);
  }
  if (options.hooks) {
    runtime.configureHooks(options.hooks);
  }
  return runtime;
}

/**
 * The runtime the top-level functions use when no other is running.
 *
 * `defaultRuntime.getClient(endpoint)` and `getClient(endpoint)` are the same call outside any
 * runtime. Inside one they differ: the top-level function follows the runtime that is running,
 * and this always reaches the process-wide state.
 */
export const defaultRuntime: Runtime = bind(rootScope);
