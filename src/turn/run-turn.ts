import type OpenAI from 'openai';
import { MS_PER_SECOND } from '../core/consts.ts';
import { MODEL_SERVER_DEFAULTS, REQUEST_SIZE_DEFAULTS } from '../core/defaults.ts';
import { calibrate, charsPerTokenFor } from '../endpoint/calibration.ts';
import { type Capabilities, type ModelCapabilities, negotiate, type OnNotice } from '../endpoint/capabilities.ts';
import { errorMessage } from '../wire/errors.ts';
import {
  backoffMs,
  ContextOverflow,
  EndpointSilent,
  isModelLoading,
  isOverflow,
  isTransient,
  sleep,
} from '../wire/retry.ts';
import { type Produced, type StreamTurnOptions, streamTurn, type Turn } from '../wire/stream.ts';
import { formatTokens, requestTokens } from '../wire/tokens.ts';

/**
 * One request, given as many attempts as the caller allows.
 *
 * It recovers from two things, nested: a capability the model server or the model turns out not to
 * have, answered with a lesser request and latched for the life of the process, and the model
 * server being unreachable, busy or silent, which is waited out. A request too big for the context
 * window is neither, and comes out as `ContextOverflow` whether the `contextLimit` guard or the model
 * server found it. Nothing is sent again once the model has started answering (`produced`, set by a
 * chunk that carried something), since a second attempt would say everything twice.
 */

/** What `runTurn` takes besides the client, the capabilities and the request. */
export interface RunTurnOptions extends Omit<StreamTurnOptions, 'produced'> {
  /**
   * How many times a lost request is worth sending again. Zero is one attempt, which is the
   * default because a caller with no retry budget in its settings should not inherit one.
   * A downgrade does not spend an attempt: it is a different request, not the same one again.
   */
  maxRetries?: number;
  /**
   * Told what was given up on and what is being waited out, for a watcher who would otherwise
   * see an unexplained pause. Carries both the capability notices and the retry notices: a retry
   * is not the same event as a downgrade, but a watcher wants to be told about both.
   */
  onNotice?: OnNotice;
  /**
   * What the model will read, in tokens. Zero sends whatever it is given.
   *
   * @defaultValue `0`
   *
   * @remarks
   * Given one, the request is sized before it is sent — the prompt plus the reply ceiling the body
   * carries, since that is what the model server weighs — and a `ContextOverflow` is raised here
   * rather than by the model server one round trip later. It is opt-in because the number is the
   * caller's to find: `contextLimitFor` asks the model server, an operator's own setting overrides
   * it, and neither is something a turn should be doing network I/O to discover. A context window
   * below `REQUEST_SIZE_DEFAULTS.smallestLikelyWindowTokens` is not believed — a model with one that small is rare enough
   * that the number is far more likely a caller threading a placeholder through, and refusing an
   * exchange over one would be the guard failing exactly the callers it was meant to help.
   */
  contextLimit?: number;
  /**
   * Which model the body names, so the refusals that are about the model rather than the server
   * are negotiated too — a reasoning effort it does not take, a token ceiling it spells the
   * other way, a temperature that is not ours to pick. Left out, only the model server's own are.
   *
   * @remarks
   * It is given here rather than read off the body because the body is built from the answer:
   * `request` has to know what this model refused before it can build one that avoids it.
   */
  model?: string;
  /**
   * The body fields a refusal may take away when the model server has never heard of them — the
   * keys of `extraBody`, ordinarily. See `NegotiateOptions.droppable`; it needs `model` too.
   */
  droppable?: Iterable<string>;
  /**
   * How long to wait on a server answering that the model is still loading; zero gives up on the
   * first such answer like any other 503.
   *
   * @defaultValue `120000`
   *
   * @remarks
   * Polled every `MODEL_SERVER_DEFAULTS.loadingPollSeconds` without spending `maxRetries`, and
   * announced once rather than per poll. A consumer that starts alongside its llama.cpp, or asks a router for a model it
   * has to swap in, meets this on its first request every time.
   */
  loadingTimeoutMs?: number;
}

/**
 * What a notice calls the model, where the caller did not say which one it is.
 *
 * @param model - The model's name. Absent reads as "the model", which is all there is to say.
 * @returns The name as given, an empty one included, or the stand-in.
 */
export const modelLabel = (model: string | undefined) => model ?? 'the model';

/**
 * Builds a turn's request body from what the model server and the model have refused so far.
 *
 * @remarks
 * A function rather than a body because a downgrade changes what is sent, so it is called again
 * per attempt. Its second argument is absent where no model was named.
 */
export type RequestBuilder = (
  supports: Capabilities,
  model: ModelCapabilities | undefined,
) => OpenAI.ChatCompletionCreateParamsStreaming;

/**
 * Throws `ContextOverflow` for a request that will not fit its context window, before it is sent.
 *
 * @param body - The request about to go out. Its prompt is estimated, and its reply ceiling read
 * from `max_completion_tokens`, or failing that `max_tokens`.
 * @param contextLimit - The model's context window, in tokens. A request of exactly that many is
 * let through.
 * @param charsPerToken - The ratio the prompt is estimated at.
 *
 * @remarks
 * The model server refuses on the prompt plus the reply — llama.cpp sizes the slot with `n_predict`
 * in, OpenAI with the ceiling — so a prompt that fits the context window but not what the ceiling
 * leaves of it was let through here to be refused one round trip later, which is the trip this
 * guard exists to save. The reserve is read off the body under whichever spelling was chosen, and
 * no ceiling reserves nothing: the server then gives the reply what is left.
 */
function refuseOversized(
  body: OpenAI.ChatCompletionCreateParamsStreaming,
  contextLimit: number,
  charsPerToken: number,
): void {
  const needed = requestTokens(body, { charsPerToken });
  const reserve = Math.max(0, body.max_completion_tokens ?? body.max_tokens ?? 0);
  const fitsWindow = needed + reserve <= contextLimit;
  if (fitsWindow) {
    return;
  }
  // Not retried, and deliberately not a capability: `isTransient` refuses it and none of the
  // words below are ones `negotiate` reads as a refusal it can answer, so this leaves both
  // loops on the first attempt instead of being sent again to be refused again.
  const reserved = reserve ? ` plus ${formatTokens(reserve)} reserved for the reply` : '';
  throw new ContextOverflow(
    `the request is about ${formatTokens(needed)} tokens${reserved}, over this model's ${formatTokens(contextLimit)}`,
  );
}

/**
 * A backoff in whatever unit reads as a number: the first is under a second, and "retrying in
 * 0s" is what rounding it to seconds says.
 *
 * @param ms - The wait, in milliseconds.
 * @returns Whole milliseconds, as `250ms`, under a second, and whole seconds, as `4s`, from there.
 */
const shownDelay = (ms: number) => (ms < MS_PER_SECOND ? `${Math.round(ms)}ms` : `${Math.round(ms / MS_PER_SECOND)}s`);

/**
 * One request seen through to an answer: negotiated with the model server, retried where the
 * failure is transient, and waited for where the model is still loading.
 *
 * @param client - The pooled client for this model server.
 * @param supports - What the model server has already refused, threaded through the negotiation.
 * @param request - Builds the body. Called again per attempt, since a downgrade changes it. Its
 * second argument is what the model named in `options.model` has refused, absent when none was.
 * @param [options] - Retry budget, context window, the model to negotiate for, notices, and the
 * stream's own callbacks.
 * @returns The reply the attempt that got through produced, its usage carrying what every attempt
 * together cost: `wallMs`, `retries` and `timeouts`.
 *
 * @remarks
 * `request` is a callback rather than a body because the body has to be rebuilt from whatever
 * the last attempt latched off: the tools it sends depend on `strictSchemas`, and `relaxTools`
 * has to apply to the schemas that were just sanitised. It is handed the same `Capabilities`
 * object throughout, and a caller that reads those from its own closure can ignore the argument.
 */
export async function runTurn(
  client: OpenAI,
  supports: Capabilities,
  request: RequestBuilder,
  {
    maxRetries = 0,
    onNotice,
    contextLimit = 0,
    model,
    droppable,
    loadingTimeoutMs = MODEL_SERVER_DEFAULTS.loadingTimeoutSeconds * MS_PER_SECOND,
    ...stream
  }: RunTurnOptions = {},
): Promise<Turn> {
  // Sized once rather than per build. `request` is called again for every downgrade and every
  // retry, but a downgraded body is strictly smaller than the one before it and the transcript
  // does not change between attempts — so the first body is the one worth measuring, and
  // measuring the rest would only spend the walk again to reach the same answer.
  let sized = false;
  // The body the answer was given to, for the calibration once it is in hand.
  let sent: OpenAI.ChatCompletionCreateParamsStreaming | undefined;
  const measured = (capabilities: Capabilities, forModel: ModelCapabilities | undefined) => {
    const body = request(capabilities, forModel);
    sent = body;
    if (!sized && contextLimit >= REQUEST_SIZE_DEFAULTS.smallestLikelyWindowTokens) {
      sized = true;
      refuseOversized(body, contextLimit, charsPerTokenFor(supports, body.model));
    }
    return body;
  };

  // When the server first said it was loading. Unset until then, and never reset: a model that
  // loads, fails and loads again has had its allowance.
  let loadingSince: number | undefined;
  const started = Date.now();
  let retries = 0;
  let timeouts = 0;
  for (let attempt = 0; ; attempt++) {
    const produced: Produced = { any: false };
    try {
      const turn = await negotiate(
        supports,
        (capabilities, box, forModel) =>
          streamTurn(client, measured(capabilities, forModel), { ...stream, produced: box }),
        { produced, onNotice, model, droppable },
      );
      if (sent) {
        calibrate(supports, sent, turn.usage.prompt);
      }
      Object.assign(turn.usage, { wallMs: Date.now() - started, retries, timeouts });
      return turn;
    } catch (error) {
      // The abort is read before the classification, not after. An exchange stopped by its operator
      // can trip the idle watchdog on the way out, and `EndpointSilent` is transient by the rules
      // in `retry.ts` — so classifying first brings a cancelled exchange back from the dead.
      if (produced.any || stream.signal?.aborted) {
        throw error;
      }
      // Classified here so one failure has one error type whether or not the caller gave a
      // `contextLimit`; the original is the `cause`, since its wording names the number.
      if (!(error instanceof ContextOverflow) && isOverflow(errorMessage(error))) {
        throw new ContextOverflow(errorMessage(error), { cause: error });
      }
      if (isModelLoading(error) && loadingTimeoutMs > 0) {
        const now = Date.now();
        if (loadingSince === undefined) {
          loadingSince = now;
          onNotice?.(
            `${modelLabel(model)} is still loading — waiting up to ${formatTokens(loadingTimeoutMs / MS_PER_SECOND)}s`,
          );
        }
        const canKeepWaiting = now - loadingSince < loadingTimeoutMs;
        if (canKeepWaiting) {
          // Not an attempt: the request was never looked at, and a two-minute load would
          // otherwise have to be bought with a retry budget meant for dropped connections.
          attempt--;
          await sleep(MODEL_SERVER_DEFAULTS.loadingPollSeconds * MS_PER_SECOND, stream.signal);
          continue;
        }
      }
      if (attempt >= maxRetries || !isTransient(error)) {
        throw error;
      }
      retries++;
      if (error instanceof EndpointSilent) {
        timeouts++;
      }
      const wait = backoffMs(attempt);
      onNotice?.(`${errorMessage(error)} — retrying in ${shownDelay(wait)} (${attempt + 1}/${maxRetries})`);
      await sleep(wait, stream.signal);
    }
  }
}
