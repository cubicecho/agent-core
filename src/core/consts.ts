/**
 * The facts more than one module needs and none of them owns, each under a name.
 *
 * A leaf with no imports, beside `defaults.ts`: that one holds what somebody chose, and this one
 * what could not be otherwise. Settings are in seconds because that is what a person types, timers
 * are in milliseconds because that is what the platform takes, and each module that crossed between
 * the two had written the thousand out.
 */

/** How many milliseconds a second is. */
export const MS_PER_SECOND = 1000;

/** How many milliseconds a minute is. */
export const MS_PER_MINUTE = 60_000;
