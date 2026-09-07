/**
 * What went wrong, as a string.
 *
 * Almost everything caught here ends up in a run row, a tool result or a log line, and a
 * `catch` binds `unknown` — so the same three-branch ternary was being written at every site
 * that had to say what happened.
 */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
