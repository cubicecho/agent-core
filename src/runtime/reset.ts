import { resetCalibration } from '../endpoint/calibration.ts';
import { resetCapabilities } from '../endpoint/capabilities.ts';
import { resetClients } from '../endpoint/client.ts';
import { resetSlots } from '../endpoint/slots.ts';
import { resetHooks } from '../hooks/hooks.ts';
import { resetEvents } from '../run/events.ts';

/**
 * Forgets everything this package remembers between calls.
 *
 * @remarks
 * Six modules here keep state for the life of the runtime — the process's, unless this is called
 * as a method of one `createRuntime` made, which clears that one alone — each for a good reason
 * and each with its own seam: the pooled clients and their model listings, what endpoints and
 * models turned out not to take (the no-thinking hints among it), each model's measured characters
 * per token, the event bus, the hooks' configured budget and preface, and which session holds
 * which llama.cpp slot. `resetClients`, `resetCapabilities`, `resetCalibration`, `resetEvents`,
 * `resetHooks` and `resetSlots` stay exported, because a test that means to clear one thing
 * should say so, and so does `resetHints`, which clears one latch of the capabilities.
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
  resetEvents();
  resetHooks();
  resetSlots();
}
