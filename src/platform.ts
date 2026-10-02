/**
 * The platform's own numbers and words, each under a name.
 *
 * A leaf with no imports. Settings are in seconds because that is what a person types, timers are
 * in milliseconds because that is what the platform takes, and each module that crossed between
 * the two had written the thousand out.
 */

/** How many milliseconds a second is. */
export const MS_PER_SECOND = 1000;

/** How many milliseconds a minute is. */
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/** The event an `AbortSignal` fires when it aborts. */
export const ABORT_EVENT = 'abort';
