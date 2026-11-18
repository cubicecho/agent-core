import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextOverflow } from '../../src/wire/retry.ts';
import { answer, apiError, type Create, reply } from '../helpers.ts';
import { NO_EFFORT, NO_HINTS, OWN_TEMPERATURE, WANTS_COMPLETION_LIMIT } from '../refusals.ts';

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

const { ask } = await import('../../src/turn/side-task.ts');
const { resetHints } = await import('../../src/index.ts');
const { modelCapabilitiesFor, capabilitiesFor, resetCapabilities } = await import('../../src/endpoint/capabilities.ts');

const endpoint = (baseUrl: string) => ({ baseUrl, apiKey: '', requestTimeoutSeconds: 60 });
const call = (config: ReturnType<typeof endpoint>, model = 'm') => ask(config, model, 'system', 'user');
/** Whether the hints rode along on the nth call. */
const sentHints = (nth: number) => 'chat_template_kwargs' in create.mock.calls[nth][0];

/** The opposite refusal: the model reasons, it just does not offer the `none` a side task wants. */
const NO_EFFORT_NONE = apiError(
  400,
  "Unsupported value: 'reasoning_effort' does not support 'none' with this model. " +
    "Supported values are: 'minimal', 'low', 'medium', and 'high'.",
);

/** What the nth call actually put in the body. */
const body = (nth: number) => create.mock.calls[nth][0];

describe('no-thinking hints', () => {
  // The latch outlives a test as surely as the mock does. Without this the suite only passed
  // because every test had been handed a hostname of its own.
  beforeEach(() => {
    create.mockReset();
    resetHints();
    // The latch `negotiate` keeps outlives a test the same way this module's does, and `ask`
    // now reads both.
    resetCapabilities();
  });

  it('reports the downgrade to a caller who asked, and to nobody who did not', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notices: string[] = [];
    create.mockRejectedValueOnce(NO_HINTS).mockResolvedValue(reply);
    await ask(endpoint('http://picky/v1'), 'm', 'system', 'user', {
      onNotice: (message) => notices.push(message),
    });
    expect(notices).toEqual(['m does not take chat_template_kwargs; retrying without it']);

    // A library that writes to the console has decided for its consumer where operator text
    // goes. The retry still happens; it just says so through the seam or not at all.
    resetHints();
    create.mockReset();
    create.mockRejectedValueOnce(NO_HINTS).mockResolvedValue(reply);
    await call(endpoint('http://picky/v1'));
    expect(create).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stops offering them to a model that refused them by name', async () => {
    create.mockRejectedValueOnce(NO_HINTS).mockResolvedValue(reply);
    await call(endpoint('http://picky/v1'));
    expect(sentHints(0)).toBe(true);
    expect(sentHints(1)).toBe(false);
    expect([...modelCapabilitiesFor(capabilitiesFor({ baseUrl: 'http://picky/v1' }), 'm').refusedFields]).toEqual([
      'chat_template_kwargs',
    ]);

    await call(endpoint('http://picky/v1'));
    expect(create).toHaveBeenCalledTimes(3);
    expect(sentHints(2)).toBe(false);
  });

  it('fails a refusal that names nothing, and latches nothing', async () => {
    // Negotiation drops only what a refusal names, as it does for an exchange. Guessing that a
    // bare 400 was about the hints, and retrying without them, was a side task's own rule.
    create.mockRejectedValueOnce(apiError(400));
    await expect(call(endpoint('http://vague/v1'))).rejects.toThrow('rejected');
    expect(create).toHaveBeenCalledTimes(1);

    create.mockResolvedValue(reply);
    await call(endpoint('http://vague/v1'));
    expect(sentHints(1)).toBe(true);
    expect(body(1).reasoning_effort).toBe('none');
  });

  it('fails an overflow at once, and latches nothing', async () => {
    const overflow = apiError(400, "This model's maximum context length is 4096 tokens");
    create.mockRejectedValueOnce(overflow);
    await expect(call(endpoint('http://small/v1'))).rejects.toBeInstanceOf(ContextOverflow);
    expect(create).toHaveBeenCalledTimes(1);

    create.mockResolvedValue(reply);
    await call(endpoint('http://small/v1'));
    expect(sentHints(1)).toBe(true);
    expect(body(1).reasoning_effort).toBe('none');
  });

  it('keeps sending the effort to a model that refused only the template kwargs', async () => {
    create.mockRejectedValueOnce(NO_HINTS).mockResolvedValue(reply);
    await call(endpoint('http://vllm/v1'));
    expect(body(1).reasoning_effort).toBe('none');

    await call(endpoint('http://vllm/v1'));
    expect(sentHints(2)).toBe(false);
    expect(body(2).reasoning_effort).toBe('none');
    const supports = capabilitiesFor({ baseUrl: 'http://vllm/v1' });
    expect(modelCapabilitiesFor(supports, 'm').reasoningEffort).toBe(true);
  });

  it('keeps offering them while a server that failed to answer is waited out', async () => {
    // A 503 or a rate limit is the server failing to answer, not refusing the fields. It is sent
    // again after a backoff, as an exchange's turn would be, hints and all.
    vi.useFakeTimers();
    try {
      for (const status of [503, 429]) {
        resetCapabilities();
        create.mockReset();
        create.mockRejectedValueOnce(apiError(status)).mockResolvedValue(reply);
        const asking = call(endpoint('http://flaky/v1'));
        await vi.advanceTimersByTimeAsync(8000);
        await expect(asking).resolves.toBe('ok');
        expect(create).toHaveBeenCalledTimes(2);
        expect(sentHints(1)).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one endpoint's refusal off another's calls", async () => {
    create.mockRejectedValueOnce(NO_HINTS).mockResolvedValue(reply);
    await call(endpoint('http://local/v1'));

    await call(endpoint('http://cloud/v1'));
    expect(sentHints(2)).toBe(true);
  });

  it("keeps one model's refusal off another model on the same host", async () => {
    // One base URL is routinely many models — a router, or vLLM serving several. Whether the
    // hints are understood belongs to the model, not to the route.
    create.mockRejectedValueOnce(NO_HINTS).mockResolvedValue(reply);
    await call(endpoint('http://router/v1'), 'picky-model');
    expect(sentHints(1)).toBe(false);

    await call(endpoint('http://router/v1'), 'other-model');
    expect(sentHints(2)).toBe(true);
  });

  it('names the model in the notice, so two on one host are told apart', async () => {
    const notices: string[] = [];
    const watched = (model: string) =>
      ask(endpoint('http://router/v1'), model, 'system', 'user', {
        onNotice: (message) => notices.push(message),
      });
    create.mockRejectedValueOnce(NO_HINTS).mockResolvedValue(reply);
    await watched('picky-model');
    create.mockReset();
    create.mockRejectedValueOnce(NO_HINTS).mockResolvedValue(reply);
    await watched('other-model');

    expect(notices).toEqual([
      'picky-model does not take chat_template_kwargs; retrying without it',
      'other-model does not take chat_template_kwargs; retrying without it',
    ]);
  });

  it('keeps them off a model that refused them', async () => {
    modelCapabilitiesFor(capabilitiesFor({ baseUrl: 'http://saved/v1' }), 'm').refusedFields.add(
      'chat_template_kwargs',
    );
    create.mockResolvedValue(reply);
    await call(endpoint('http://saved/v1'));
    expect(sentHints(0)).toBe(false);
    expect(body(0).reasoning_effort).toBe('none');
  });

  it('does not latch on a bad key or a missing model', async () => {
    for (const status of [401, 404]) {
      resetHints();
      create.mockReset();
      create.mockRejectedValueOnce(apiError(status));
      await expect(call(endpoint('http://auth/v1'))).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it('does not return a scratchpad that ran out of budget as the answer', async () => {
    create.mockResolvedValue(answer('<think>weighing it up and then the budget ran'));
    expect(await call(endpoint('http://reasoner/v1'))).toBe('');
  });

  it('falls back to reasoning_content when the content is all scratchpad', async () => {
    create.mockResolvedValue(answer('', { reasoning: 'deliberation — the answer' }));
    expect(await call(endpoint('http://split/v1'))).toBe('deliberation — the answer');
  });
});

describe('what the model refuses', () => {
  beforeEach(() => {
    create.mockReset();
    resetHints();
    resetCapabilities();
  });

  it('spells the ceiling the way the model wants it', async () => {
    // Every side task against an OpenAI reasoning model used to fail here: the hint retry is
    // not what a `max_tokens` refusal is about, so the same field went back out and came back
    // the same way, and `tryAsk` turned that into a session with no title.
    create.mockRejectedValueOnce(WANTS_COMPLETION_LIMIT).mockResolvedValue(reply);
    await expect(call(endpoint('https://api.openai.com/v1'), 'o3')).resolves.toBe('ok');
    expect(body(0).max_tokens).toBe(512);
    expect(body(1).max_completion_tokens).toBe(512);
    expect(body(1)).not.toHaveProperty('max_tokens');
    // And the run on the same model does not have to find this out for itself.
    const supports = capabilitiesFor({ baseUrl: 'https://api.openai.com/v1' });
    expect(modelCapabilitiesFor(supports, 'o3').legacyTokenLimit).toBe(false);
  });

  it('lets the model keep the temperature it was built with', async () => {
    create.mockRejectedValueOnce(OWN_TEMPERATURE).mockResolvedValue(reply);
    await expect(call(endpoint('https://api.openai.com/v1'), 'o3')).resolves.toBe('ok');
    expect(body(0).temperature).toBe(0.3);
    expect(body(1)).not.toHaveProperty('temperature');
  });

  it('drops the effort without dropping the other spelling of the same hint', async () => {
    // The two used to go out and be given up on as a bundle, so a model that had never heard of
    // `reasoning_effort` also stopped being told, in the spelling it does read, not to think.
    create.mockRejectedValueOnce(NO_EFFORT).mockResolvedValue(reply);
    await expect(call(endpoint('http://vllm/v1'), 'qwen')).resolves.toBe('ok');
    expect(create).toHaveBeenCalledTimes(2);
    expect(body(1)).not.toHaveProperty('reasoning_effort');
    expect(body(1)).toHaveProperty('chat_template_kwargs', { enable_thinking: false });
  });

  it('asks for the cheapest effort the model offers when it will not take none', async () => {
    // What sent a side task to its own fallback path and then latched the effort off for good:
    // the request failed outright, and every later call on the model ran with nothing said about
    // deliberating — on the models most inclined to deliberate.
    const notices: string[] = [];
    create.mockRejectedValueOnce(NO_EFFORT_NONE).mockResolvedValue(reply);
    await expect(
      ask(endpoint('https://api.openai.com/v1'), 'gpt-5', 'system', 'user', {
        onNotice: (message) => notices.push(message),
      }),
    ).resolves.toBe('ok');
    expect(create).toHaveBeenCalledTimes(2);
    expect(body(0).reasoning_effort).toBe('none');
    expect(body(1).reasoning_effort).toBe('minimal');
    expect(notices).toEqual(['gpt-5 does not reason at none; retrying at minimal']);
    // And the next call starts where this one left off rather than paying for it again.
    create.mockReset();
    create.mockResolvedValue(reply);
    await call(endpoint('https://api.openai.com/v1'), 'gpt-5');
    expect(create).toHaveBeenCalledTimes(1);
    expect(body(0).reasoning_effort).toBe('minimal');
  });

  it('does not spend a second call on what it was told the first time', async () => {
    create.mockRejectedValueOnce(WANTS_COMPLETION_LIMIT).mockResolvedValue(reply);
    await call(endpoint('https://api.openai.com/v1'), 'o3');
    create.mockReset();
    create.mockResolvedValue(reply);
    await call(endpoint('https://api.openai.com/v1'), 'o3');
    expect(create).toHaveBeenCalledTimes(1);
    expect(body(0).max_completion_tokens).toBe(512);
  });

  it('sends the effort a caller chose in place of the hints', async () => {
    // A compaction model pointed at a reasoning model on purpose: `enable_thinking: false` beside
    // `reasoning_effort: "high"` would be a request that contradicts itself.
    create.mockResolvedValue(reply);
    await ask(endpoint('http://thinker/v1'), 'm', 'system', 'user', { reasoningEffort: 'high' });
    expect(body(0).reasoning_effort).toBe('high');
    expect(body(0)).not.toHaveProperty('chat_template_kwargs');
  });

  it('reads off and empty as no choice, and keeps the hints', async () => {
    // Off is what the hints already ask for. Sending nothing, as the main model's `"off"` does,
    // would leave a local model to think by its server's default.
    create.mockResolvedValue(reply);
    for (const reasoningEffort of ['off', '', undefined]) {
      await ask(endpoint('http://quiet/v1'), 'm', 'system', 'user', { reasoningEffort });
    }
    for (const nth of [0, 1, 2]) {
      expect(body(nth).reasoning_effort).toBe('none');
      expect(body(nth)).toHaveProperty('chat_template_kwargs', { enable_thinking: false });
    }
  });

  it('drops a chosen effort the model does not take, and says which it dropped', async () => {
    const notices: string[] = [];
    create.mockRejectedValueOnce(NO_EFFORT).mockResolvedValue(reply);
    await expect(
      ask(endpoint('http://plain/v1'), 'm', 'system', 'user', {
        reasoningEffort: 'high',
        onNotice: (message) => notices.push(message),
      }),
    ).resolves.toBe('ok');
    expect(body(1)).not.toHaveProperty('reasoning_effort');
    expect(body(1)).not.toHaveProperty('chat_template_kwargs');
    expect(notices).toEqual(['m does not take a reasoning effort; retrying without one']);
    // The hints were never sent, so they are not what gets latched off.
    create.mockReset();
    create.mockResolvedValue(reply);
    await call(endpoint('http://plain/v1'));
    expect(sentHints(0)).toBe(true);
  });

  it('fails a chosen effort refused in words that name nothing, and latches nothing', async () => {
    create.mockRejectedValueOnce(apiError(400));
    const asked = { reasoningEffort: 'high' };
    await expect(ask(endpoint('http://plain/v1'), 'm', 'system', 'user', asked)).rejects.toThrow('rejected');
    expect(modelCapabilitiesFor(capabilitiesFor({ baseUrl: 'http://plain/v1' }), 'm').reasoningEffort).toBe(true);

    create.mockResolvedValue(reply);
    await ask(endpoint('http://plain/v1'), 'm', 'system', 'user', asked);
    expect(body(1).reasoning_effort).toBe('high');
  });

  it('sends no ceiling at all for a ceiling of zero', async () => {
    // What `maxTokens: 0` means on the main model, and what a spec's task says by it. Sent as
    // `max_tokens: 0` it asks for an empty reply.
    create.mockResolvedValue(reply);
    await ask(endpoint('http://open/v1'), 'm', 'system', 'user', { maxTokens: 0 });
    expect(body(0)).not.toHaveProperty('max_tokens');
    expect(body(0)).not.toHaveProperty('max_completion_tokens');
  });
});
