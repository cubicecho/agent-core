import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FinishReason } from '../../src/wire/wire.ts';
import { answer, endpoint } from '../helpers.ts';

const create = vi.fn();
/**
 * The SDK-touching half of the client module, replaced. Partial rather than whole: the rest of
 * it is pure — `endpointKey` is what every cache in this package agrees an endpoint is — and a
 * blanket mock takes those out from under the modules under test too.
 */
vi.mock('../../src/endpoint/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/endpoint/client.ts')>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { ask, askReply } = await import('../../src/turn/side-task.ts');

/** What the caller gets back when the model replies with this content. */
const answerTo = (content: string) => {
  create.mockResolvedValue(answer(content));
  return ask(endpoint, 'm', 'system', 'user');
};

describe('the scratchpad a reasoning model fences off', () => {
  beforeEach(() => create.mockReset());

  it('drops a fence that closes', async () => {
    expect(await answerTo('<think>weighing it up</think>Real Answer')).toBe('Real Answer');
  });

  it('drops a fence that never closes', async () => {
    // Cut off mid-deliberation by `max_tokens`, so there is no answer to find.
    expect(await answerTo('<think>weighing it up and running out of')).toBe('');
  });

  it('drops a fence that never opens', async () => {
    // The opening tag was put at the end of the prompt by the chat template rather than written
    // by the model, so only the close comes back. This used to return the whole deliberation as
    // the answer, and a session title or a suggestion list was made out of it.
    expect(await answerTo('weighing it up</think>Real Answer')).toBe('Real Answer');
  });

  it('leaves an answer that has no fence in it alone', async () => {
    expect(await answerTo('Real Answer')).toBe('Real Answer');
  });

  it('keeps what sits either side of a fence in the middle', async () => {
    // The close here is the one its own open paired off with, not an orphan, so the rule for
    // the never-opened fence must not reach back and eat `before`.
    expect(await answerTo('before<think>weighing it up</think>after')).toBe('beforeafter');
  });
});

describe('why a side task stopped', () => {
  beforeEach(() => create.mockReset());

  it('says a reply ran into the ceiling, and still hands back what it wrote', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: 'page text page text page' }, finish_reason: FinishReason.Length }],
    });
    expect(await askReply(endpoint, 'm', 'system', 'user')).toEqual({
      text: 'page text page text page',
      finishReason: FinishReason.Length,
    });
  });

  it('passes on a reason it has no name for as the server sent it', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: 'done' }, finish_reason: 'eos' }] });
    expect(await askReply(endpoint, 'm', 'system', 'user')).toEqual({ text: 'done', finishReason: 'eos' });
  });

  it('reads a null or missing reason as none', async () => {
    create.mockResolvedValueOnce({ choices: [{ message: { content: 'a' }, finish_reason: null }] });
    create.mockResolvedValueOnce(answer('b'));
    create.mockResolvedValueOnce({ choices: [] });
    expect(await askReply(endpoint, 'm', 'system', 'user')).toEqual({ text: 'a', finishReason: undefined });
    expect(await askReply(endpoint, 'm', 'system', 'user')).toEqual({ text: 'b', finishReason: undefined });
    expect(await askReply(endpoint, 'm', 'system', 'user')).toEqual({ text: '', finishReason: undefined });
  });

  it('strips the thinking from the text as ask does', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: '<think>hmm</think> Answer ' }, finish_reason: FinishReason.Stop }],
    });
    expect(await askReply(endpoint, 'm', 'system', 'user')).toEqual({
      text: 'Answer',
      finishReason: FinishReason.Stop,
    });
    expect(await ask(endpoint, 'm', 'system', 'user')).toBe('Answer');
  });
});
