import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { RETRY_DEFAULTS } from '../../src/core/defaults.ts';
import {
  backoffMs,
  ContextOverflow,
  EndpointSilent,
  isAbort,
  isModelLoading,
  isOverflow,
  isTransient,
  refusesRequest,
  sleep,
} from '../../src/wire/retry.ts';
import { apiError } from '../helpers.ts';

describe('isTransient', () => {
  it('calls a lost or refused request worth sending again, and a complaint about it not', () => {
    expect(isTransient(new EndpointSilent('went quiet'))).toBe(true);
    expect(isTransient(new OpenAI.APIConnectionError({ message: 'ECONNREFUSED' }))).toBe(true);
    expect(isTransient(apiError(429))).toBe(true);
    expect(isTransient(apiError(503))).toBe(true);

    // A 400 for a malformed tool schema fails the same way every time.
    expect(isTransient(apiError(400))).toBe(false);
    expect(isTransient(apiError(404))).toBe(false);
    expect(isTransient(new Error('something else'))).toBe(false);
    // Its own class precisely so nothing retries it.
    expect(isTransient(new ContextOverflow('too big'))).toBe(false);
  });
});

describe('refusesRequest', () => {
  it('reads a 400 or a 422 as the request refused as written', () => {
    expect(refusesRequest(apiError(400))).toBe(true);
    expect(refusesRequest(apiError(422))).toBe(true);
  });

  it('reads no other status, and nothing lost or cancelled, as a refusal', () => {
    for (const status of [401, 404, 429, 500, 503]) {
      expect(refusesRequest(apiError(status))).toBe(false);
    }
    // Both are SDK errors with no status: neither says anything about the fields.
    expect(refusesRequest(new OpenAI.APIConnectionError({ message: 'ECONNREFUSED' }))).toBe(false);
    expect(refusesRequest(new OpenAI.APIUserAbortError())).toBe(false);
    expect(refusesRequest(new Error('400 rejected'))).toBe(false);
  });
});

describe('isModelLoading', () => {
  /** A 503 as llama.cpp sends it, the body unwrapped as the SDK hands it to the constructor. */
  const unavailable = (body: Record<string, unknown>, status = 503) =>
    new OpenAI.APIError(status, body, undefined, undefined);

  it("reads llama.cpp's 503 of type unavailable_error as the model loading, whatever it says", () => {
    expect(isModelLoading(unavailable({ message: 'Loading model', type: 'unavailable_error' }))).toBe(true);
    expect(isModelLoading(unavailable({ message: 'busy', type: 'unavailable_error' }))).toBe(true);
  });

  it('reads a 503 that says the model is loading as that, with no type', () => {
    expect(isModelLoading(apiError(503, 'Loading model'))).toBe(true);
    expect(isModelLoading(apiError(503, 'the model is loading, try again'))).toBe(true);
  });

  it('reads a plain 503, another status or what is not an SDK error as something else', () => {
    expect(isModelLoading(apiError(503, 'Service Unavailable'))).toBe(false);
    expect(isModelLoading(unavailable({ message: 'Loading model', type: 'unavailable_error' }, 500))).toBe(false);
    expect(isModelLoading(new Error('503 Loading model'))).toBe(false);
  });
});

describe('isAbort', () => {
  it("knows the SDK's abort and a signal's, and nothing else", () => {
    expect(isAbort(new OpenAI.APIUserAbortError())).toBe(true);
    expect(isAbort(AbortSignal.abort().reason)).toBe(true);
    expect(isAbort(new DOMException('too slow', 'TimeoutError'))).toBe(false);
    expect(isAbort(new Error('aborted'))).toBe(false);
    expect(isAbort(apiError(500))).toBe(false);
    expect(isAbort('AbortError')).toBe(false);
  });
});

describe('backoffMs', () => {
  it('grows, stays under the cap, and never waits the same time twice', () => {
    const { firstBackoffMs, maxBackoffMs, growthPerAttempt, jitterFloorShare } = RETRY_DEFAULTS;
    const waits = [0, 1, 2, 3, 9].map(backoffMs);
    for (const wait of waits) {
      expect(wait).toBeLessThanOrEqual(maxBackoffMs);
    }
    // Jittered into the top half of each step, so the steps stay ordered but two tasks failing
    // together do not come back in lockstep.
    expect(backoffMs(0)).toBeGreaterThanOrEqual(firstBackoffMs * jitterFloorShare);
    expect(backoffMs(3)).toBeGreaterThanOrEqual(firstBackoffMs * growthPerAttempt ** 3 * jitterFloorShare);
  });
});

describe('sleep', () => {
  it('is cut short by an abort rather than run out', async () => {
    const controller = new AbortController();
    const waited = sleep(60_000, controller.signal);
    controller.abort(new Error('stopped'));
    await expect(waited).rejects.toThrow('stopped');
  });
});

describe('isOverflow', () => {
  it("reads a server's own words for an over-long request as one", () => {
    expect(isOverflow("This model's maximum context length is 8192 tokens")).toBe(true);
    expect(isOverflow('the request exceeds the available context size (2000 tokens)')).toBe(true);
    // "Too long" about anything but the window is somebody else's error.
    expect(isOverflow('string too long for field name')).toBe(false);
    expect(isOverflow('rate limit exceeded')).toBe(false);
  });

  it('does not read a rate limit as an overflow, however it is worded', () => {
    // OpenAI's real one: "too large for" beside "tokens", which is both halves of the test
    // above, on a 429 that `isTransient` accepts and that succeeds on the next attempt.
    expect(
      isOverflow(
        'Request too large for gpt-4o in organization org-abc on tokens per min (TPM): ' +
          'Limit 30000, Requested 40000.',
      ),
    ).toBe(false);
    expect(isOverflow('Rate limit reached for gpt-4o: 200000 tokens per day')).toBe(false);
    expect(isOverflow('token quota exceeded, request too large for this key')).toBe(false);

    // The classifiers have to agree: nothing may be both.
    const tpm = new OpenAI.APIError(429, { error: {} }, 'Request too large for gpt-4o on TPM', undefined);
    expect(isTransient(tpm)).toBe(true);
    expect(isOverflow(tpm.message)).toBe(false);
  });
});
