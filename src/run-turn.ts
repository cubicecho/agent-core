import type OpenAI from "openai";
import { type Capabilities, negotiate } from "./capabilities.ts";
import { errorMessage } from "./errors.ts";
import { backoffMs, isTransient, sleep } from "./retry.ts";
import { type Produced, type StreamTurnOptions, streamTurn, type Turn } from "./stream.ts";

/**
 * One turn, given as many attempts as the caller allows.
 *
 * Two different things are being recovered from here, and they nest. The inner one is a
 * capability the endpoint turns out not to have — `stream_options`, a grammar keyword — which
 * is a refusal: it is answered by sending a lesser request, and it latches against that
 * endpoint for the life of the process, so it costs one failed call rather than one a run.
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
}

/**
 * `request` is a callback rather than a body because the body has to be rebuilt from whatever
 * the last attempt latched off: the tools it sends depend on `strictSchemas`, and `relaxTools`
 * has to apply to the schemas that were just sanitised. It is handed the same `Capabilities`
 * object throughout, and a caller that reads those from its own closure can ignore the argument.
 */
export async function runTurn(
  client: OpenAI,
  supports: Capabilities,
  request: (supports: Capabilities) => OpenAI.ChatCompletionCreateParamsStreaming,
  { maxRetries = 0, onNotice, ...stream }: RunTurnOptions = {},
): Promise<Turn> {
  for (let attempt = 0; ; attempt++) {
    const produced: Produced = { any: false };
    try {
      return await negotiate(
        supports,
        (capabilities, box) =>
          streamTurn(client, request(capabilities), { ...stream, produced: box }),
        { produced, onNotice },
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
