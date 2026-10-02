import { apiError } from './helpers.ts';

/**
 * The refusals more than one test file is answered with, worded as the servers word them.
 *
 * They are apart from `helpers.ts` because they are built when the file loads: a test file that
 * mocks the SDK whole has no `APIError` to build them with, and still wants the helpers.
 */

/** How llama.cpp words a grammar it could not compile. It answers with no status of its own. */
export const NO_GRAMMAR = new Error('Failed to initialize samplers: failed to parse grammar');

// The three fields a model refuses by name, as OpenAI words them.

/** The model takes no reasoning effort at all. */
export const NO_EFFORT = apiError(400, "Unsupported parameter: 'reasoning_effort' is not supported with this model.");

/** The model wants its output limit under the newer name. */
export const WANTS_COMPLETION_LIMIT = apiError(
  400,
  "Unsupported parameter: 'max_tokens' is not supported with this model. " + "Use 'max_completion_tokens' instead.",
);

/** The model runs at its own temperature and refuses any other. */
export const OWN_TEMPERATURE = apiError(
  400,
  "Unsupported value: 'temperature' does not support 0.3 with this model. " + 'Only the default (1) is supported.',
);
