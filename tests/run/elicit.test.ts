import { describe, expect, it, vi } from 'vitest';
import { ElicitAction, elicitor, type OnElicit } from '../../src/run/elicit.ts';
import { type RunEventInput, RunEventKind } from '../../src/run/events.ts';

/** A form asking for a colour and a password. */
const form = {
  message: 'Sign in?',
  requestedSchema: {
    type: 'object',
    properties: { colour: { type: 'string' }, password: { type: 'string', format: 'password' } },
  },
};

/**
 * Answers one request and keeps what was told.
 *
 * @param onElicit - The app's handler.
 * @param [args] - The call's arguments.
 * @param [signal] - The exchange's signal.
 * @returns The answer as the server reads it, and the events.
 */
async function answering(
  onElicit: OnElicit | undefined,
  args: Record<string, unknown> | undefined = form,
  signal?: AbortSignal,
) {
  const events: RunEventInput[] = [];
  const text = await elicitor('helper', onElicit, signal, (event) => events.push(event))('c1', args);
  return { answer: JSON.parse(text), events };
}

describe('elicitor', () => {
  it('hands the handler the agent, the request and a signal', async () => {
    const onElicit = vi.fn<OnElicit>(() => ({ action: ElicitAction.Decline }));
    await answering(onElicit);
    expect(onElicit).toHaveBeenCalledWith('helper', form, { signal: expect.any(AbortSignal) });
  });

  it('declines where the app has no handler', async () => {
    expect((await answering(undefined)).answer).toEqual({ action: ElicitAction.Decline });
  });

  it('declines a request it cannot show, without asking', async () => {
    const onElicit = vi.fn<OnElicit>();
    for (const args of [undefined, {}, { message: 3 }]) {
      const text = await elicitor('helper', onElicit, undefined, () => {})('c1', args);
      expect(JSON.parse(text)).toEqual({ action: ElicitAction.Decline });
    }
    expect(onElicit).not.toHaveBeenCalled();
  });

  it('tells the server what was typed, and an event only which fields were filled in', async () => {
    const content = { colour: 'blue', password: 'hunter2', extra: 'unasked' };
    const { answer, events } = await answering(() => ({ action: ElicitAction.Accept, content }));
    expect(answer).toEqual({ action: ElicitAction.Accept, content });
    expect(events).toEqual([
      { kind: RunEventKind.Elicit, id: 'c1', text: 'Sign in?' },
      { kind: RunEventKind.ElicitAnswer, id: 'c1', text: ElicitAction.Accept, fields: ['colour', 'password'] },
    ]);
    expect(JSON.stringify(events)).not.toContain('hunter2');
  });

  it('keeps a url out of its events', async () => {
    const url = 'https://auth.example/flow?token=s3cret';
    const { events } = await answering(() => ({ action: ElicitAction.Cancel }), {
      message: 'Open it',
      mode: 'url',
      url,
    });
    expect(JSON.stringify(events)).not.toContain('s3cret');
  });

  it('sends content on an accept alone', async () => {
    const onElicit = (() => ({ action: ElicitAction.Decline, content: { colour: 'blue' } })) as OnElicit;
    expect((await answering(onElicit)).answer).toEqual({ action: ElicitAction.Decline });
    expect((await answering(() => ({ action: ElicitAction.Accept }))).answer).toEqual({ action: ElicitAction.Accept });
  });

  it('reads a handler that throws, or returns no answer, as a cancel', async () => {
    const answers: OnElicit[] = [
      () => {
        throw new Error('no prompt');
      },
      async () => Promise.reject(new Error('no prompt')),
      // A JavaScript handler, off its type on purpose.
      (() => ({ action: 'maybe' })) as unknown as OnElicit,
      (() => ({ action: ElicitAction.Accept, content: 'blue' })) as unknown as OnElicit,
      (() => undefined) as unknown as OnElicit,
    ];
    for (const onElicit of answers) {
      expect((await answering(onElicit)).answer).toEqual({ action: ElicitAction.Cancel });
    }
  });

  it('stops with the exchange even where the handler never settles', async () => {
    const stop = new AbortController();
    const reason = new Error('stopped');
    const waiting = answering(() => new Promise(() => {}), form, stop.signal);
    stop.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });

  it('asks nothing of a handler once the exchange is stopped', async () => {
    const onElicit = vi.fn<OnElicit>();
    await expect(answering(onElicit, form, AbortSignal.abort())).rejects.toBeDefined();
    expect(onElicit).not.toHaveBeenCalled();
  });
});
