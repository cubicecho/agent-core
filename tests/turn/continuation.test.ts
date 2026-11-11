import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, modelCapabilitiesFor, resetCapabilities } from '../../src/endpoint/capabilities.ts';
import { continueTurn, isContinuable } from '../../src/turn/continuation.ts';
import type { Turn } from '../../src/wire/stream.ts';
import { FinishReason, FUNCTION_TOOL, Role } from '../../src/wire/wire.ts';
import { apiError, type Body, chunks, clientOf } from '../helpers.ts';

/** A reply that says this, stops for this reason, and reports these counts and timings. */
const replies = (content: string, finish: FinishReason = FinishReason.Stop, timings?: Record<string, number>) =>
  chunks(
    { choices: [{ delta: { content }, finish_reason: finish }] },
    {
      choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      ...(timings ? { timings } : {}),
    },
  );

const question: Body = { model: 'm', stream: true, messages: [{ role: Role.User, content: 'why' }] };
const request = () => question;

/** A turn the ceiling cut off, with an answer begun. */
const cut = (content = 'The sky is blue because', extra: Partial<Turn> = {}): Turn => ({
  content,
  reasoning: 'thought',
  toolCalls: [],
  finishReason: FinishReason.Length,
  usage: { prompt: 40, completion: 100, total: 140, cached: 30 },
  ...extra,
});

const supports = () => capabilitiesFor('http://local/v1');

afterEach(() => resetCapabilities());

describe('isContinuable', () => {
  it('takes only an answer begun and cut off, with no call in it', () => {
    expect(isContinuable(cut())).toBe(true);
    expect(isContinuable(cut('done', { finishReason: FinishReason.Stop }))).toBe(false);
    expect(isContinuable(cut('  '))).toBe(false);
    const call = {
      id: 'c',
      type: FUNCTION_TOOL,
      function: { name: 't', arguments: '{"a":' },
    };
    expect(isContinuable(cut('calling', { toolCalls: [call] }))).toBe(false);
  });
});

describe('continueTurn', () => {
  it('sends the answer so far as a prefill and joins what comes back onto it', async () => {
    const create = vi.fn().mockReturnValue(replies(' of the way light scatters.', FinishReason.Stop));
    const turn = await continueTurn(clientOf(create), supports(), request, cut(), {
      model: 'm',
      startInReasoning: true,
    });
    expect(create).toHaveBeenCalledTimes(1);
    // What vLLM needs to read the trailing message as a prefill rather than open a fresh turn.
    expect(create.mock.calls[0][0]).toMatchObject({ continue_final_message: true, add_generation_prompt: false });
    expect((create.mock.calls[0][0] as Body).messages).toEqual([
      ...question.messages,
      { role: Role.Assistant, content: 'The sky is blue because', reasoning_content: 'thought' },
    ]);
    // Read as answer even though the fresh reply started in a scratchpad.
    expect(turn.content).toBe('The sky is blue because of the way light scatters.');
    expect(turn.reasoning).toBe('thought');
    expect(turn.finishReason).toBe(FinishReason.Stop);
    expect(turn.usage).toMatchObject({
      prompt: 90,
      completion: 110,
      total: 200,
      cached: 30,
      continuations: 1,
    });
  });

  it('writes the reasoning back under the field it came in, without it when asked or refused', async () => {
    const prefill = async (turn: Turn, options: { replayReasoning?: boolean } = {}) => {
      const create = vi.fn().mockReturnValue(replies(' more', FinishReason.Stop));
      await continueTurn(clientOf(create), supports(), request, turn, { model: 'm', ...options });
      return (create.mock.calls[0][0] as Body).messages.at(-1);
    };
    expect(await prefill(cut(undefined, { reasoningField: 'reasoning' }))).toEqual({
      role: Role.Assistant,
      content: 'The sky is blue because',
      reasoning: 'thought',
    });
    expect(await prefill(cut(), { replayReasoning: false })).toEqual({
      role: Role.Assistant,
      content: 'The sky is blue because',
    });
    expect(await prefill(cut(undefined, { reasoning: '' }))).not.toHaveProperty('reasoning_content');
    modelCapabilitiesFor(supports(), 'm').reasoningContent = false;
    expect(await prefill(cut())).not.toHaveProperty('reasoning_content');
  });

  it('drops a field only one request reported, and weights the rates by the time they held', async () => {
    const create = vi
      .fn()
      .mockReturnValue(replies(' more', FinishReason.Stop, { predicted_ms: 3000, predicted_per_second: 40 }));
    const first = cut();
    first.usage = { ...first.usage, predictedMs: 1000, tokensPerSecond: 80, wallMs: 5 };
    const turn = await continueTurn(clientOf(create), supports(), request, first, { model: 'm' });
    expect(turn.usage.predictedMs).toBe(4000);
    expect(turn.usage.tokensPerSecond).toBe(50);
    // The continuation's own runTurn measured a wall time too, so that one is summed.
    expect(turn.usage.wallMs).toBeGreaterThanOrEqual(5);
    expect(turn.usage).not.toHaveProperty('promptMs');
  });

  it('leaves a turn it cannot continue as it was, without a request', async () => {
    const create = vi.fn();
    const finished = cut('done', { finishReason: FinishReason.Stop });
    expect(await continueTurn(clientOf(create), supports(), request, finished)).toBe(finished);
    const empty = cut('');
    expect(await continueTurn(clientOf(create), supports(), request, empty)).toBe(empty);
    expect(await continueTurn(clientOf(create), supports(), request, cut(), { maxContinuations: 0 })).toMatchObject({
      finishReason: FinishReason.Length,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('stops at the cap on a model that never reaches a stop', async () => {
    const create = vi.fn(() => replies(' and on', FinishReason.Length));
    const once = await continueTurn(clientOf(create), supports(), request, cut());
    expect(create).toHaveBeenCalledTimes(1);
    expect(once.finishReason).toBe(FinishReason.Length);
    create.mockClear();
    const thrice = await continueTurn(clientOf(create), supports(), request, cut(), {
      maxContinuations: 3,
    });
    expect(create).toHaveBeenCalledTimes(3);
    expect(thrice.content).toBe('The sky is blue because and on and on and on');
    expect(thrice.usage.continuations).toBe(3);
  });

  it('latches the prefill off for the model when the endpoint refuses one', async () => {
    const notices: string[] = [];
    const create = vi
      .fn()
      .mockRejectedValue(apiError(400, 'Assistant response prefill is incompatible with enable_thinking.'));
    const turn = await continueTurn(clientOf(create), supports(), request, cut(), {
      model: 'm',
      onNotice: (n) => notices.push(n),
    });
    expect(turn.content).toBe('The sky is blue because');
    expect(turn.finishReason).toBe(FinishReason.Length);
    expect(modelCapabilitiesFor(supports(), 'm').assistantPrefill).toBe(false);
    expect(notices.at(-1)).toContain('refused a trailing assistant message');
    create.mockClear();
    await continueTurn(clientOf(create), supports(), request, cut(), { model: 'm' });
    expect(create).not.toHaveBeenCalled();
  });

  it('sends the prefill fields again without both once a model refuses them by name, and still continues', async () => {
    const notices: string[] = [];
    const create = vi
      .fn()
      .mockRejectedValueOnce(apiError(400, "Unknown parameter: 'continue_final_message'."))
      .mockReturnValue(replies(' of the way light scatters.'));
    const turn = await continueTurn(clientOf(create), supports(), request, cut(), {
      model: 'm',
      onNotice: (n) => notices.push(n),
    });
    expect(create).toHaveBeenCalledTimes(2);
    // Only one was named, and the other alone would close the reply off rather than prefill it.
    expect(create.mock.calls[1][0]).not.toHaveProperty('continue_final_message');
    expect(create.mock.calls[1][0]).not.toHaveProperty('add_generation_prompt');
    expect(turn.content).toBe('The sky is blue because of the way light scatters.');
    const refused = modelCapabilitiesFor(supports(), 'm');
    expect(refused.refusedFields.has('continue_final_message')).toBe(true);
    expect(refused.assistantPrefill).toBe(true);
    expect(notices).toEqual([expect.stringContaining('does not take continue_final_message')]);
    create.mockClear();
    await continueTurn(clientOf(create), supports(), request, cut(), { model: 'm' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).not.toHaveProperty('add_generation_prompt');
  });

  it('drops both on a refusal that names one in words negotiate does not read, before blaming the prefill', async () => {
    const notices: string[] = [];
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        apiError(
          422,
          '[{"type":"extra_forbidden","loc":["body","add_generation_prompt"],"msg":"Extra inputs are not permitted"}]',
        ),
      )
      .mockReturnValue(replies(' more.'));
    const turn = await continueTurn(clientOf(create), supports(), request, cut(), {
      model: 'm',
      onNotice: (n) => notices.push(n),
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty('continue_final_message');
    expect(turn.content).toBe('The sky is blue because more.');
    expect(modelCapabilitiesFor(supports(), 'm').assistantPrefill).toBe(true);
    expect(notices).toEqual([expect.stringContaining('continuing without them')]);
  });

  it('still latches the prefill off when the request is refused again without the fields', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        apiError(400, 'Unrecognized request arguments supplied: add_generation_prompt, continue_final_message'),
      )
      .mockRejectedValue(apiError(400, 'Assistant response prefill is incompatible with enable_thinking.'));
    const turn = await continueTurn(clientOf(create), supports(), request, cut(), { model: 'm' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(turn.content).toBe('The sky is blue because');
    expect(modelCapabilitiesFor(supports(), 'm').assistantPrefill).toBe(false);
  });

  it('says what a continuation needs over a prefill field the request already set', async () => {
    const create = vi.fn().mockReturnValue(replies(' more.'));
    const own = () => ({ ...question, add_generation_prompt: true }) as Body;
    await continueTurn(clientOf(create), supports(), own, cut(), { model: 'm' });
    expect(create.mock.calls[0][0]).toMatchObject({ continue_final_message: true, add_generation_prompt: false });
  });

  it('latches it off when the model answers afresh instead, and keeps the first answer', async () => {
    const notices: string[] = [];
    const create = vi.fn(() => replies('The sky is blue because of Rayleigh scattering.'));
    const turn = await continueTurn(clientOf(create), supports(), request, cut(), {
      model: 'm',
      onNotice: (n) => notices.push(n),
    });
    expect(turn.content).toBe('The sky is blue because');
    expect(modelCapabilitiesFor(supports(), 'm').assistantPrefill).toBe(false);
    expect(notices).toEqual([expect.stringContaining('answered afresh')]);
  });

  it('keeps the cut-off answer when there is no room to continue it', async () => {
    const notices: string[] = [];
    const create = vi.fn().mockRejectedValue(apiError(400, 'the request exceeds the available context size, tokens'));
    const turn = await continueTurn(clientOf(create), supports(), request, cut(), {
      model: 'm',
      onNotice: (n) => notices.push(n),
    });
    expect(turn.content).toBe('The sky is blue because');
    // No room is not a refusal of the prefill, so the next turn may still be continued.
    expect(modelCapabilitiesFor(supports(), 'm').assistantPrefill).toBe(true);
    expect(notices).toEqual([expect.stringContaining('no room')]);
  });

  it('throws a stop rather than keeping the answer', async () => {
    const controller = new AbortController();
    const create = vi.fn(() => {
      controller.abort();
      throw new OpenAI.APIUserAbortError();
    });
    await expect(
      continueTurn(clientOf(create), supports(), request, cut(), { signal: controller.signal }),
    ).rejects.toThrow();
  });
});
