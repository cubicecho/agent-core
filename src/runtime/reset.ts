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
 * Six modules keep state for the life of the runtime — the process's, or one `createRuntime` made
 * when this is called as its method — and each keeps its own exported reset for a test that means
 * to clear one thing. This is for every teardown: what they hold are latched refusals, and missing
 * one makes a suite order-dependent, passing locally and failing on another CI shard. A seventh
 * module with a cache is a seventh line here, and a test that builds a `createRuntime` per case has
 * nothing to tear down, the better answer where cases run in parallel.
 */
export function resetAll() {
  resetClients();
  resetCapabilities();
  resetCalibration();
  resetEvents();
  resetHooks();
  resetSlots();
}
