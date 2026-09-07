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
 * Its own module because both `retry` and `side-task` need it and they now need each other:
 * leaving it in `side-task` made the pair a cycle.
 */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
