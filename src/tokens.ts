/**
 * Rough token count. Characters over four, because there is no tokenizer here and there is not
 * going to be one: a server that will not say how big its window is will not lend us its
 * vocabulary either.
 *
 * The estimate runs low on tool schemas — JSON packs more tokens into a character than prose
 * does — and that is the side to be wrong on wherever it guards a window, since the cost of
 * guessing high is a run refused that would have worked, and the cost of guessing low is the
 * endpoint's own refusal, which is where we were before the guard existed.
 *
 * Its own module because it is the one number several of these agree on, and the module that
 * owns it should not be one that also does something. It was extracted from `side-task` to
 * break a cycle with `retry`; `side-task` no longer reads it, but `retry` and any consumer
 * sizing its own prompt still do, and a leaf with no imports is the right home for it.
 */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
