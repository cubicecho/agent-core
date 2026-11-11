import type OpenAI from 'openai';
import { type Capabilities, type ModelCapabilities, modelCapabilitiesFor } from '../endpoint/capabilities.ts';
import { errorMessage } from '../wire/errors.ts';
import { ContextOverflow, refusesRequest } from '../wire/retry.ts';
import {
  addCounts,
  type InFlight,
  type PartialTurn,
  reasoningEntry,
  type Turn,
  type TurnUsage,
} from '../wire/stream.ts';
import { FinishReason, Role } from '../wire/wire.ts';
import { modelLabel, type RequestBuilder, type RunTurnOptions, runTurn } from './run-turn.ts';

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
   * How many more requests one answer may be given; zero continues nothing. The cap is what
   * stops a model that never reaches a stop token from looping on the ceiling.
   *
   * @defaultValue `1`
   */
  maxContinuations?: number;
  /**
   * Whether the prefill carries the reasoning the cut-off turn produced, under the field it arrived
   * in. A Qwen3.5+ template renders a think block on that message either way, empty without it, so
   * leaving it off tells the model it had no thoughts and misses the cache of what it generated.
   *
   * @defaultValue `true`
   */
  replayReasoning?: boolean;
}

/**
 * Whether a turn is one a continuation can finish: cut off at the ceiling, with an answer begun
 * and no tool call in it.
 *
 * @param turn - The turn as it came back.
 * @returns False for a turn that stopped for any reason but `length`, whose content is blank, or
 * that holds a tool call.
 *
 * @remarks
 * An answer not begun is a turn cut off in its scratchpad, and prefilling a half-closed fence is
 * the template's business rather than something this can do the same way everywhere — llama.cpp
 * refuses a prefill outright on a template with thinking enabled. A tool call is excluded because
 * its arguments are what was cut, and `parseToolArguments` already reports that truncation.
 */
export const isContinuable = (turn: Turn) =>
  turn.finishReason === FinishReason.Length && turn.content.trim() !== '' && turn.toolCalls.length === 0;

/**
 * The fields that tell vLLM a trailing assistant message is a prefill.
 *
 * @remarks
 * vLLM opens a fresh assistant turn after the message unless the request says both, and refuses
 * `continue_final_message` beside the default `add_generation_prompt: true`. llama.cpp reads the same two and continues a
 * trailing assistant message without them too, so they cost it nothing — and say so even where
 * `--no-prefill-assistant` is set. Ollama, like any server that decodes leniently, ignores them;
 * hosted OpenAI refuses them by name, which is the latch below.
 */
const PREFILL_FIELDS = { continue_final_message: true, add_generation_prompt: false } as const;

/** The names of `PREFILL_FIELDS`, which a refusal may take off the request. */
const PREFILL_KEYS = Object.keys(PREFILL_FIELDS);

/**
 * The prefill fields as this model takes them, to spread into a continuation's body.
 *
 * @param refused - What the model has refused. Absent is a model that has refused nothing.
 * @returns Both fields, or neither once the model has refused either: `add_generation_prompt:
 * false` without the other renders the reply closed off, which is not a prefill anywhere.
 */
const prefillFields = (refused: ModelCapabilities | undefined) =>
  PREFILL_KEYS.some((field) => refused?.refusedFields.has(field)) ? {} : PREFILL_FIELDS;

/**
 * Latches the prefill fields off for a model whose refusal names one of them, in a wording
 * `negotiate` did not read as an unknown field.
 *
 * @param refused - What the model has refused. Written to: both fields join `refusedFields`.
 * @param detail - The server's error text.
 * @returns `true` where it latched, and `false`, touching nothing, where the text names neither or
 * they were refused already — so a continuation is sent again without them at most once.
 */
function refusePrefillFields(refused: ModelCapabilities, detail: string): boolean {
  if (!PREFILL_KEYS.some((field) => detail.includes(field)) || prefillFields(refused) !== PREFILL_FIELDS) {
    return false;
  }
  for (const field of PREFILL_KEYS) {
    refused.refusedFields.add(field);
  }
  return true;
}

/** How much of the answer's opening a reply has to repeat to have started over. */
const RESTART_PROBE = 40;

/** The shortest opening worth testing for a restart; shorter ones are repeated by chance. */
const RESTART_MIN = 12;

/**
 * Whether the continuation began the answer again rather than carrying it on — how a server that
 * ignores the prefill shows itself, since it takes the request without complaint.
 *
 * @param answer - The answer so far, as it was sent back as the prefill.
 * @param continuation - The content the continuation came back with.
 * @returns True where the continuation opens with the answer's own opening, leading whitespace
 * aside on both. Never true for an answer whose opening is shorter than `RESTART_MIN`.
 */
const restarted = (answer: string, continuation: string) => {
  const opening = answer.trimStart().slice(0, RESTART_PROBE);
  return opening.length >= RESTART_MIN && continuation.trimStart().startsWith(opening);
};

/** The fields of a usage that add across two requests, when both reported them. */
const ADDED = [
  'uncached',
  'reasoningTokens',
  'promptMs',
  'predictedMs',
  'draftTotal',
  'draftAccepted',
  'wallMs',
  'retries',
  'timeouts',
] as const;

/** A rate, and the duration it was measured over, which is what weights it in a mean. */
const RATES = [
  ['promptTokensPerSecond', 'promptMs'],
  ['tokensPerSecond', 'predictedMs'],
] as const;

/**
 * Two requests' usage as one turn's.
 *
 * @param first - The turn so far, which may itself be a joined one. Not written to.
 * @param next - The continuation's usage. Not written to.
 * @returns A new usage: the four counts summed, `continuations` one more than `first` had, and a
 * rate both requests timed as the mean of the two, weighted by the time each was measured over.
 *
 * @remarks
 * The first request's own measurements and the loop's comparison with the request before it stay
 * as they were; a field only one of them reported is dropped rather than passed off as the total.
 */
function joinUsage(first: TurnUsage, next: TurnUsage): TurnUsage {
  const joined: TurnUsage = {
    ...first,
    ...addCounts(first, next),
    continuations: (first.continuations ?? 0) + 1,
  };
  for (const field of ADDED) {
    const a = first[field];
    const b = next[field];
    if (a !== undefined && b !== undefined) {
      joined[field] = a + b;
    } else {
      delete joined[field];
    }
  }
  for (const [rate, over] of RATES) {
    const a = first[rate];
    const b = next[rate];
    const aMs = first[over];
    const bMs = next[over];
    // Tokens over time for both together, which is each rate weighted by the time it held.
    const bothTimed = a !== undefined && b !== undefined && aMs !== undefined && bMs !== undefined;
    if (bothTimed && aMs + bMs) {
      joined[rate] = (a * aMs + b * bMs) / (aMs + bMs);
    } else {
      delete joined[rate];
    }
  }
  return joined;
}

/**
 * The answer so far with the piece a continuation in flight had added to it.
 *
 * @param sofar - The turn being continued, which may itself be a joined one. Not written to.
 * @param [piece] - What the continuation had said. Absent adds nothing.
 * @returns The two joined as `continueTurn` joins turns: content and reasoning in order, and the
 * continuation's own calls. `reasoning` and `toolCalls` are left out where empty.
 */
function joinPartial(sofar: Turn, piece: PartialTurn | undefined): PartialTurn {
  const reasoning = sofar.reasoning + (piece?.reasoning ?? '');
  return {
    content: sofar.content + (piece?.content ?? ''),
    ...(reasoning ? { reasoning } : {}),
    ...(piece?.toolCalls ? { toolCalls: piece.toolCalls } : {}),
  };
}

/**
 * Carries on an answer the token ceiling cut off, by sending the transcript again with the answer
 * so far as a trailing assistant message, and joins the pieces into one turn.
 *
 * @param client - The pooled client for this endpoint.
 * @param supports - What the endpoint has already refused.
 * @param request - Builds the body the cut-off turn was sent, exactly as `runTurn` was given it. The
 * prefill is appended to what it builds.
 * @param turn - The turn that came back cut off.
 * @param [options] - `runTurn`'s options, with `model` needed for the latch — without one nothing is
 * latched and each continuation finds out again — and the cap on continuations.
 * @returns `turn` itself where nothing was joined to it; otherwise a new turn, with the last
 * continuation's `finishReason` and tool calls.
 *
 * @remarks
 * Only a turn cut off at the ceiling, with an answer begun and no tool call in it, is continued;
 * any other comes back as it was. Content and reasoning are joined in order, the tool calls a continuation makes are kept, and usage is summed
 * across the requests with `continuations` counting them. The continuation is read as starting in
 * the answer, whatever `startInReasoning` says: a template that opens a fence for a fresh reply
 * does not open one for a prefill. Its tokens reach `onOutput` as they arrive, so a watcher sees
 * one answer carry on rather than two.
 *
 * The request also says `continue_final_message: true` and `add_generation_prompt: false`, without
 * which vLLM answers afresh. They are this request's rather than the conversation's, so they win
 * over a key of the same name in what `request` builds: vLLM refuses `add_generation_prompt: true`
 * beside the other. A model that refuses either by name stops being sent both, latched in its
 * `refusedFields`, and the continuation is sent again without them before anything is concluded
 * about the prefill.
 *
 * Whether the server continues at all is latched per model as `assistantPrefill`. A refusal of the
 * request latches it off, and so does a continuation that begins the answer again, which is how a
 * server that takes the request and ignores the prefill — hosted OpenAI among them — shows itself;
 * that check is only as good as a restart being word for word. Either way the answer so far is
 * kept, with a notice. So is it when the continuation fails any other way, since the tokens
 * already in hand are worth more than the error; only a stop is thrown. An `inFlight` box reads
 * the answer so far with the continuation's piece joined on, so a stop mid-continuation keeps it
 * all.
 */
export async function continueTurn(
  client: OpenAI,
  supports: Capabilities,
  request: RequestBuilder,
  turn: Turn,
  { maxContinuations = 1, replayReasoning = true, ...options }: ContinueTurnOptions = {},
): Promise<Turn> {
  const refused = options.model === undefined ? undefined : modelCapabilitiesFor(supports, options.model);
  const who = modelLabel(options.model);
  // The caller's box reads the whole answer, not only the piece the continuation streams.
  const outer = options.inFlight;
  const piece: InFlight = {};
  const told = outer ? { inFlight: piece } : {};
  let joined = turn;
  const droppable = [...(options.droppable ?? []), ...PREFILL_KEYS];
  for (let count = 0; count < maxContinuations && isContinuable(joined); count++) {
    if (refused?.assistantPrefill === false) {
      break;
    }
    const answer = joined.content;
    const thought = replayReasoning ? reasoningEntry(joined.reasoning, joined.reasoningField) : {};
    if (outer) {
      const sofar = joined;
      piece.read = undefined;
      outer.read = () => joinPartial(sofar, piece.read?.());
    }
    let next: Turn;
    try {
      next = await runTurn(
        client,
        supports,
        (capabilities, forModel) => {
          const body = request(capabilities, forModel);
          const scratchpad = forModel?.reasoningContent === false ? {} : thought;
          return {
            ...body,
            ...prefillFields(forModel),
            messages: [...body.messages, { role: Role.Assistant, content: answer, ...scratchpad }],
          };
        },
        { ...options, ...told, droppable, startInReasoning: false },
      );
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      if (error instanceof ContextOverflow) {
        options.onNotice?.('no room left in the window to continue the cut-off reply');
      } else if (refused && refusesRequest(error) && refusePrefillFields(refused, errorMessage(error))) {
        // The fields were what it refused, not the trailing message: the attempt is not spent.
        options.onNotice?.(`${who} does not take ${PREFILL_KEYS.join(', ')}; continuing without them`);
        count--;
        continue;
      } else if (refusesRequest(error)) {
        if (refused) {
          refused.assistantPrefill = false;
        }
        options.onNotice?.(
          `${who} refused a trailing assistant message (${errorMessage(error)}); keeping the cut-off reply`,
        );
      } else {
        options.onNotice?.(`could not continue the cut-off reply: ${errorMessage(error)}`);
      }
      break;
    }
    if (restarted(answer, next.content)) {
      if (refused) {
        refused.assistantPrefill = false;
      }
      options.onNotice?.(`${who} answered afresh instead of continuing its reply; keeping the cut-off reply`);
      break;
    }
    joined = {
      content: joined.content + next.content,
      toolCalls: next.toolCalls,
      usage: joinUsage(joined.usage, next.usage),
      finishReason: next.finishReason,
      reasoning: joined.reasoning + next.reasoning,
      ...(joined.reasoningField || next.reasoningField
        ? { reasoningField: joined.reasoningField ?? next.reasoningField }
        : {}),
    };
  }
  return joined;
}
