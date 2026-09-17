import OpenAI from "openai";
import { type Capabilities, type ModelCapabilities, modelCapabilitiesFor } from "./capabilities.ts";
import { errorMessage } from "./errors.ts";
import { ContextOverflow } from "./retry.ts";
import { type RunTurnOptions, runTurn } from "./run-turn.ts";
import type { Turn, TurnUsage } from "./stream.ts";

/**
 * Picking up an answer the token ceiling cut off, instead of keeping half of it.
 *
 * A turn that stops at `maxTokens` mid-answer comes back looking finished, and the half answer
 * becomes the answer. A server that renders a trailing assistant message as a prefill lets the
 * model carry on from the last token as if nothing had happened, which costs the rest of the
 * reply and a prefill the cache mostly already holds.
 */

/** What `continueTurn` takes besides what `runTurn` does. */
export interface ContinueTurnOptions extends RunTurnOptions {
  /**
   * How many more requests one answer may be given, 1 unless given; zero continues nothing.
   * The cap is what stops a model that never reaches a stop token from looping on the ceiling.
   */
  maxContinuations?: number;
}

/**
 * Whether a turn is one a continuation can finish: cut off at the ceiling, with an answer begun
 * and no tool call in it.
 *
 * An answer not begun is a turn cut off in its scratchpad, and prefilling a half-closed fence is
 * the template's business rather than something this can do the same way everywhere — llama.cpp
 * refuses a prefill outright on a template with thinking enabled. A tool call is excluded because
 * its arguments are what was cut, and `parseToolArguments` already reports that truncation.
 *
 * @param turn The turn as it came back.
 */
export const isContinuable = (turn: Turn) =>
  turn.finishReason === "length" && turn.content.trim() !== "" && turn.toolCalls.length === 0;

/** How much of the answer's opening a reply has to repeat to have started over. */
const RESTART_PROBE = 40;

/** The shortest opening worth testing for a restart; shorter ones are repeated by chance. */
const RESTART_MIN = 12;

/**
 * Whether the continuation began the answer again rather than carrying it on — how a server that
 * ignores the prefill shows itself, since it takes the request without complaint.
 */
const restarted = (answer: string, continuation: string) => {
  const opening = answer.trimStart().slice(0, RESTART_PROBE);
  return opening.length >= RESTART_MIN && continuation.trimStart().startsWith(opening);
};

/** The fields of a usage that add across two requests, when both reported them. */
const ADDED = [
  "uncached",
  "reasoningTokens",
  "promptMs",
  "predictedMs",
  "draftTotal",
  "draftAccepted",
  "wallMs",
  "retries",
  "timeouts",
] as const;

/** A rate, and the duration it was measured over, which is what weights it in a mean. */
const RATES = [
  ["promptTokensPerSecond", "promptMs"],
  ["tokensPerSecond", "predictedMs"],
] as const;

/**
 * Two requests' usage as one turn's. The first request's own measurements and the loop's
 * comparison with the request before it stay as they were; a field only one of them reported is
 * dropped rather than passed off as the total.
 */
function joinUsage(first: TurnUsage, next: TurnUsage): TurnUsage {
  const joined: TurnUsage = {
    ...first,
    prompt: first.prompt + next.prompt,
    completion: first.completion + next.completion,
    total: first.total + next.total,
    cached: first.cached + next.cached,
    continuations: (first.continuations ?? 0) + 1,
  };
  for (const field of ADDED) {
    const a = first[field];
    const b = next[field];
    if (a !== undefined && b !== undefined) joined[field] = a + b;
    else delete joined[field];
  }
  for (const [rate, over] of RATES) {
    const a = first[rate];
    const b = next[rate];
    const aMs = first[over];
    const bMs = next[over];
    // Tokens over time for both together, which is each rate weighted by the time it held.
    if (a !== undefined && b !== undefined && aMs !== undefined && bMs !== undefined && aMs + bMs)
      joined[rate] = (a * aMs + b * bMs) / (aMs + bMs);
    else delete joined[rate];
  }
  return joined;
}

/** Whether a failure is the endpoint refusing the request as written, rather than losing it. */
const refusesRequest = (error: unknown) =>
  error instanceof OpenAI.APIError && (error.status === 400 || error.status === 422);

/**
 * Carries on an answer the token ceiling cut off, by sending the transcript again with the answer
 * so far as a trailing assistant message, and joins the pieces into one turn.
 *
 * Only a turn `isContinuable` accepts is continued; any other comes back as it was. Content and
 * reasoning are joined in order, the tool calls a continuation makes are kept, and usage is summed
 * across the requests with `continuations` counting them. The continuation is read as starting in
 * the answer, whatever `startInReasoning` says: a template that opens a fence for a fresh reply
 * does not open one for a prefill. Its tokens reach `onOutput` as they arrive, so a watcher sees
 * one answer carry on rather than two.
 *
 * Whether the server continues at all is latched per model as `assistantPrefill`. A refusal of the
 * request latches it off, and so does a continuation that begins the answer again, which is how a
 * server that takes the request and ignores the prefill — hosted OpenAI among them — shows itself;
 * that check is only as good as a restart being word for word. Either way the answer so far is
 * kept, with a notice. So is it when the continuation fails any other way, since the tokens
 * already in hand are worth more than the error; only a stop is thrown.
 *
 * @param client The pooled client for this endpoint.
 * @param supports What the endpoint has already refused.
 * @param request Builds the body the cut-off turn was sent, exactly as `runTurn` was given it. The
 * prefill is appended to what it builds.
 * @param turn The turn that came back cut off.
 * @param options `runTurn`'s options, with `model` needed for the latch — without one nothing is
 * latched and each continuation finds out again — and the cap on continuations.
 */
export async function continueTurn(
  client: OpenAI,
  supports: Capabilities,
  request: (
    supports: Capabilities,
    model: ModelCapabilities | undefined,
  ) => OpenAI.ChatCompletionCreateParamsStreaming,
  turn: Turn,
  { maxContinuations = 1, ...options }: ContinueTurnOptions = {},
): Promise<Turn> {
  const refused =
    options.model === undefined ? undefined : modelCapabilitiesFor(supports, options.model);
  const who = options.model ?? "the model";
  let joined = turn;
  for (let count = 0; count < maxContinuations && isContinuable(joined); count++) {
    if (refused?.assistantPrefill === false) break;
    const answer = joined.content;
    let next: Turn;
    try {
      next = await runTurn(
        client,
        supports,
        (capabilities, forModel) => {
          const body = request(capabilities, forModel);
          return {
            ...body,
            messages: [...body.messages, { role: "assistant", content: answer }],
          };
        },
        { ...options, startInReasoning: false },
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error instanceof ContextOverflow) {
        options.onNotice?.("no room left in the window to continue the cut-off reply");
      } else if (refusesRequest(error)) {
        if (refused) refused.assistantPrefill = false;
        options.onNotice?.(
          `${who} refused a trailing assistant message (${errorMessage(error)}); keeping the cut-off reply`,
        );
      } else {
        options.onNotice?.(`could not continue the cut-off reply: ${errorMessage(error)}`);
      }
      break;
    }
    if (restarted(answer, next.content)) {
      if (refused) refused.assistantPrefill = false;
      options.onNotice?.(
        `${who} answered afresh instead of continuing its reply; keeping the cut-off reply`,
      );
      break;
    }
    joined = {
      content: joined.content + next.content,
      toolCalls: next.toolCalls,
      usage: joinUsage(joined.usage, next.usage),
      finishReason: next.finishReason,
      reasoning: joined.reasoning + next.reasoning,
    };
  }
  return joined;
}
