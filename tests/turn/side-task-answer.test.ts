import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FinishReason } from '../../src/wire/wire.ts';
import { answer, type Create, chunks, endpoint } from '../helpers.ts';

const create = vi.fn<Create>();
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

/** A reply with no choice in it. */
const noChoices = chunks();

describe('why a side task stopped', () => {
  beforeEach(() => create.mockReset());

  it('says a reply ran into the ceiling, and still hands back what it wrote', async () => {
    create.mockResolvedValue(answer('page text page text page', { finishReason: FinishReason.Length }));
    expect(await askReply(endpoint, 'm', 'system', 'user')).toEqual({
      text: 'page text page text page',
      finishReason: FinishReason.Length,
    });
  });

  it('passes on a reason it has no name for as the server sent it', async () => {
    create.mockResolvedValue(answer('done', { finishReason: 'eos' }));
    expect(await askReply(endpoint, 'm', 'system', 'user')).toEqual({ text: 'done', finishReason: 'eos' });
  });

  it('reads a null or missing reason as none', async () => {
    create.mockResolvedValueOnce(answer('a', { finishReason: null }));
    create.mockResolvedValueOnce(answer('b'));
    create.mockResolvedValueOnce(noChoices);
    expect(await askReply(endpoint, 'm', 'system', 'user')).toEqual({ text: 'a', finishReason: undefined });
    expect(await askReply(endpoint, 'm', 'system', 'user')).toEqual({ text: 'b', finishReason: undefined });
    expect(await askReply(endpoint, 'm', 'system', 'user')).toEqual({ text: '', finishReason: undefined });
  });

  it('strips the thinking from the text as ask does', async () => {
    create.mockResolvedValue(answer('<think>hmm</think> Answer ', { finishReason: FinishReason.Stop }));
    expect(await askReply(endpoint, 'm', 'system', 'user')).toEqual({
      text: 'Answer',
      finishReason: FinishReason.Stop,
    });
    expect(await ask(endpoint, 'm', 'system', 'user')).toBe('Answer');
  });
});
