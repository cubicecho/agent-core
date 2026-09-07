import type OpenAI from "openai";
import { type Capabilities, type ModelCapabilities, negotiate } from "./capabilities.ts";
import { errorMessage } from "./errors.ts";
import {
  backoffMs,
  ContextOverflow,
  compact,
  isTransient,
  requestTokens,
  SMALLEST_LIKELY_WINDOW,
  sleep,
} from "./retry.ts";
import { type Produced, type StreamTurnOptions, streamTurn, type Turn } from "./stream.ts";

/**
 * One turn, given as many attempts as the caller allows.
 *
 * Two different things are being recovered from here, and they nest. The inner one is a
 * capability the endpoint turns out not to have — `stream_options`, a grammar keyword — or that
 * the model does not, given `model` below. Either is a refusal: it is answered by sending a
 * lesser request, and it latches for the life of the process against the endpoint or against
 * that one model on it, so it costs one failed call rather than one a run.
 * The outer one is the endpoint being unreachable, busy or silent, which is not about this
 * request at all and is worth simply waiting out.
 *
 * Both are bounded by the same rule: nothing is sent again once the server has started
 * answering. The tokens are already out and on their way to whoever is watching, and a second
 * attempt would say everything twice. That is what `produced` is, one box per attempt.
 */

/** A retry is not the same event as a downgrade, but a watcher wants to be told about both. */
export interface RunTurnOptions extends Omit<StreamTurnOptions, "produced"> {
  /**
   * How many times a lost request is worth sending again. Zero is one attempt, which is the
   * default because a caller with no retry budget in its settings should not inherit one.
   * A downgrade does not spend an attempt: it is a different request, not the same one again.
   */
  maxRetries?: number;
  /**
   * Told what was given up on and what is being waited out, for a watcher who would otherwise
   * see an unexplained pause. Carries both the capability notices and the retry notices.
   */
  onNotice?: (message: string) => void;
  /**
   * What the model will read, in tokens. Zero — the default — sends whatever it is given.
   *
   * With a limit, the request is sized before it is sent and a `ContextOverflow` is raised here
   * rather than by the endpoint one round trip later. It is opt-in because the number is the
   * caller's to find: `contextLimitFor` asks the endpoint, an operator's own setting overrides
   * it, and neither is something a turn should be doing network I/O to discover. A limit below
   * `SMALLEST_LIKELY_WINDOW` is not believed — a model with a window that small is rare enough
   * that the number is far more likely a caller threading a placeholder through, and refusing a
   * run over one would be the guard failing exactly the callers it was meant to help.
   */
  contextLimit?: number;
  /**
   * Which model the body names, so the refusals that are about the model rather than the server
   * are negotiated too — a reasoning effort it does not take, a token ceiling it spells the
   * other way, a temperature that is not ours to pick. Left out, only the endpoint's own are.
   *
   * It is given here rather than read off the body because the body is built from the answer:
   * `request` has to know what this model refused before it can build one that avoids it.
   */
  model?: string;
}

/**
 * `request` is a callback rather than a body because the body has to be rebuilt from whatever
 * the last attempt latched off: the tools it sends depend on `strictSchemas`, and `relaxTools`
 * has to apply to the schemas that were just sanitised. It is handed the same `Capabilities`
 * object throughout, and a caller that reads those from its own closure can ignore the argument.
 *
 * @param client The pooled client for this endpoint.
 * @param supports What the endpoint has already refused, threaded through the negotiation.
 * @param request Builds the body. Called again per attempt, since a downgrade changes it. Its
 * second argument is what the model named in `options.model` has refused, absent when none was.
 * @param options Retry budget, context limit, the model to negotiate for, notices, and the
 * stream's own callbacks.
 */
export async function runTurn(
  client: OpenAI,
  supports: Capabilities,
  request: (
    supports: Capabilities,
    model: ModelCapabilities | undefined,
  ) => OpenAI.ChatCompletionCreateParamsStreaming,
  { maxRetries = 0, onNotice, contextLimit = 0, model, ...stream }: RunTurnOptions = {},
): Promise<Turn> {
  // Sized once rather than per build. `request` is called again for every downgrade and every
  // retry, but a downgraded body is strictly smaller than the one before it and the transcript
  // does not change between attempts — so the first body is the one worth measuring, and
  // measuring the rest would only spend the walk again to reach the same answer.
  let sized = false;
  const measured = (capabilities: Capabilities, forModel: ModelCapabilities | undefined) => {
    const body = request(capabilities, forModel);
    if (!sized && contextLimit >= SMALLEST_LIKELY_WINDOW) {
      sized = true;
      const needed = requestTokens(body);
      // Not retried, and deliberately not a capability: `isTransient` refuses it and none of the
      // words below are ones `negotiate` reads as a refusal it can answer, so this leaves both
      // loops on the first attempt instead of being sent again to be refused again.
      if (needed > contextLimit) {
        throw new ContextOverflow(
          `the request is about ${compact(needed)} tokens, over this model's ${compact(contextLimit)}`,
        );
      }
    }
    return body;
  };

  for (let attempt = 0; ; attempt++) {
    const produced: Produced = { any: false };
    try {
      return await negotiate(
        supports,
        (capabilities, box, forModel) =>
          streamTurn(client, measured(capabilities, forModel), { ...stream, produced: box }),
        { produced, onNotice, model },
      );
    } catch (error) {
      // The abort is read before the classification, not after. A run stopped by its operator
      // can trip the idle watchdog on the way out, and `EndpointSilent` is transient by the
      // rules in `retry.ts` — so classifying first brings a cancelled run back from the dead.
      if (produced.any || stream.signal?.aborted) throw error;
      if (attempt >= maxRetries || !isTransient(error)) throw error;
      const wait = backoffMs(attempt);
      // Reported in whatever unit reads as a number: the first backoff is under a second, and
      // "retrying in 0s" is what rounding it to seconds says.
      const delay = wait < 1000 ? `${Math.round(wait)}ms` : `${Math.round(wait / 1000)}s`;
      onNotice?.(`${errorMessage(error)} — retrying in ${delay} (${attempt + 1}/${maxRetries})`);
      await sleep(wait, stream.signal);
    }
  }
}
