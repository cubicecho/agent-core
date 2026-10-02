import { resetCalibration } from './calibration.ts';
import { resetCapabilities } from './capabilities.ts';
import { resetClients } from './client.ts';
import { resetEvents } from './events.ts';
import { resetHooks } from './hooks.ts';
import { resetHints } from './side-task.ts';

/**
 * Forgets everything this package remembers between calls.
 *
 * @remarks
 * Six modules here keep state for the life of the runtime — the process's, unless this is called
 * as a method of one `createRuntime` made, which clears that one alone — each for a good reason
 * and each with its own seam: the pooled clients and their model listings, the endpoints that turned
 * out not to take `stream_options` or a grammar, each model's measured characters per token,
 * the models that refused the no-thinking hints, the event bus, and the hooks' configured
 * budget and preface. `resetClients`, `resetCapabilities`, `resetCalibration`, `resetHints`,
 * `resetEvents` and `resetHooks` stay exported, because a test that means to clear one thing
 * should say so.
 *
 * This is for the other case, which is every teardown. What they hold is *latched
 * refusals* — a fact one test taught the process about an endpoint, still true as far as the
 * next test can tell. Miss one and the suite becomes order-dependent in the way that passes
 * locally and fails in CI on a different shard: the test that latched it still passes, and the
 * one that reads the latch fails only when it happens to run second. `tests/side-task-hints.test.ts`
 * was written that way and only passed because every case had been handed a hostname of its own.
 *
 * It is also the seam that does not need finding again. A seventh module with a cache is a seventh
 * line here, rather than an edit to the teardown of three consumers who will not all notice.
 *
 * A test that builds a `createRuntime` per case has nothing to tear down, and is the better
 * answer where cases run in parallel: this clears state every concurrent caller is sharing.
 */
export function resetAll() {
  resetClients();
  resetCapabilities();
  resetCalibration();
  resetHints();
  resetEvents();
  resetHooks();
}
