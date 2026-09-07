import { errorMessage } from "./errors.ts";
import { isGrammarError } from "./schema-compat.ts";
import type { Produced } from "./stream.ts";

/**
 * What an endpoint turned out not to support, and answering it when it says so.
 *
 * This package knew *how* to answer a refusal — `isGrammarError`, `relaxTools`, `sanitizeTools`
 * — but not that it had already answered one, so each consumer kept its own memory of what an
 * endpoint could not do and wrote the negotiation around it separately. Both of those are facts
 * about the server on the other end rather than about this process, which is what makes them
 * this package's to hold.
 */

/**
 * What one endpoint turned out not to support. Both flags start optimistic and only ever latch
 * off; what is about the model rather than the server hangs off `models`.
 */
export interface Capabilities {
  /**
   * llama.cpp-backed servers compile every tool schema into one grammar and reject keywords
   * their converter cannot express — one bad shape from one MCP server fails the whole request.
   * Once we have seen that, the advisory keywords stay off rather than costing every later run
   * a failed call first. See `relaxTools`.
   */
  strictSchemas: boolean;
  /**
   * `stream_options` is how a streamed request asks for its token counts, and a server that has
   * not heard of it rejects the whole request rather than the option. Dropped for good once that
   * happens: the counts are worth one failed call to find out about, not one per run.
   */
  usageInStream: boolean;
  /**
   * What each model reached through this endpoint turned out not to support, by the name the
   * endpoint knows it as. A second level rather than two more flags beside these, because one
   * API key reaches every model a provider offers: a flag here would let the first turn on a
   * model that cannot reason latch "no reasoning" for every later turn on one that can, which
   * stops asking for it with the setting still reading `high` and nothing anywhere saying it
   * stopped. Empty until `modelCapabilitiesFor` is asked about a model.
   */
  models: Map<string, ModelCapabilities>;
}

/**
 * What one model on that endpoint turned out not to support. All start optimistic and only ever
 * latch off, the same as the endpoint's own.
 *
 * These arrive through the same channel as the endpoint's — an error string on a chat
 * completion — which is why they are negotiated by the same loop rather than a second one. What
 * makes them the model's is that the answer differs between two models the same key reaches.
 */
export interface ModelCapabilities {
  /**
   * Takes a `reasoning_effort` at all. A model that cannot reason refuses the field rather than
   * ignoring it, so the whole request fails over a setting that means nothing to it.
   */
  reasoningEffort: boolean;
  /**
   * Spells its ceiling `max_tokens`. The reasoning models want `max_completion_tokens` instead,
   * and they are exactly the models anyone sets an effort on.
   */
  legacyTokenLimit: boolean;
  /**
   * Takes a temperature we picked, rather than only the one it was built with. A reasoning model
   * refuses any other value, including the one a settings row has been showing all along.
   */
  chosenTemperature: boolean;
}

/**
 * What each endpoint cannot do, remembered for the life of the process.
 *
 * Keyed by base URL, because these are facts about the server on the other end and not about
 * this one. A llama.cpp box that cannot compile a grammar and a cloud API that can are both
 * reachable from one settings row over its lifetime — an operator retargets it from Ollama this
 * afternoon to OpenAI this evening — and the first one's refusal must not quietly strip
 * pattern/format from the second one's requests, or silently cost it its token counts, for the
 * rest of the process. Bounded by the number of endpoints ever configured, which is a settings
 * row's worth.
 */
const capabilities = new Map<string, Capabilities>();

/**
 * What this endpoint is known not to support. The same object every time, so what `negotiate`
 * latches off stays off.
 *
 * @param baseUrl Identifies the endpoint. The two flags on it are per-server; what is
 * per-model hangs off `models`, which `modelCapabilitiesFor` reads.
 */
export function capabilitiesFor(baseUrl: string): Capabilities {
  let known = capabilities.get(baseUrl);
  if (!known) {
    known = { strictSchemas: true, usageInStream: true, models: new Map() };
    capabilities.set(baseUrl, known);
  }
  return known;
}

/**
 * What this model on this endpoint is known not to support. The same object every time, so what
 * `negotiate` latches off stays off.
 *
 * Nested under the endpoint rather than keyed by name alone, because `gpt-4o` at OpenAI and
 * `gpt-4o` behind a proxy need not be the same weights — and a proxy is free to answer to a name
 * it does not really serve. One that refused a reasoning effort must not speak for the other.
 * Bounded by the models actually asked for on that endpoint, which is what a dropdown holds.
 *
 * @param supports The endpoint's own, as `capabilitiesFor` hands it over.
 * @param model The name the endpoint knows the model as — whatever goes in the request body,
 * since that is the only name the refusal is about.
 */
export function modelCapabilitiesFor(supports: Capabilities, model: string): ModelCapabilities {
  let known = supports.models.get(model);
  if (!known) {
    known = { reasoningEffort: true, legacyTokenLimit: true, chosenTemperature: true };
    supports.models.set(model, known);
  }
  return known;
}

/** Forgets every endpoint's capabilities. For tests, and for a settings change under test. */
export function resetCapabilities() {
  capabilities.clear();
}

/**
 * Every latching flag in play on one attempt, endpoint and model together, in a stable order.
 * Read positionally and only against another reading of the same two objects: what it answers is
 * whether anything moved while the request was out, and a flag added to either interface later is
 * compared without an edit here. `models` is not one of them — it is the second level, not a
 * flag, and the map is the same object throughout.
 */
const flagsOf = (supports: Capabilities, model: ModelCapabilities | undefined): boolean[] => [
  ...Object.values(supports).filter((value) => typeof value === "boolean"),
  ...(model ? Object.values(model) : []),
];

/** `stream_options` is named in the refusal by every server that has not heard of it. */
const REJECTS_USAGE = /stream_options/i;

/**
 * A refusal of the *value* rather than of the field, which names the field either way.
 *
 * `Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported
 * values are: 'minimal', 'low', 'medium', and 'high'.` A model that answers this reasons
 * perfectly well; it was handed an effort off a list this package does not know. Dropping the
 * field succeeds, at the model's own default effort, which is neither what the caller asked for
 * nor something it can see — and the drop latches, so every later turn on that model reasons at
 * the default with the setting still reading what the operator typed.
 */
const REFUSED_VALUE = /unsupported value|invalid value|supported values/i;

/**
 * A model that cannot reason refuses the field by name — and only the field. See `REFUSED_VALUE`
 * for the refusal that names it too and means the opposite, which is the caller's to see rather
 * than ours to work around. `does not support` is deliberately not the marker: a proxy that
 * words a real field refusal as `this model does not support reasoning_effort` has to keep
 * latching.
 */
const rejectsEffort = (detail: string) =>
  /reasoning_effort/i.test(detail) && !REFUSED_VALUE.test(detail);

/**
 * Read only alongside the name it is asking for: `'max_tokens' is not supported with this model.
 * Use 'max_completion_tokens' instead.`
 *
 * A bare `max_tokens` complaint is also how a server says the *number* was too large —
 * `max_tokens is too large: 200000. This model supports at most 16384.` — and the answer to that
 * is not to send the same number under a different name. It is to let the error out, where
 * whoever typed the number can see it.
 */
const wantsCompletionLimit = (detail: string) =>
  /max_tokens/i.test(detail) && /max_completion_tokens/i.test(detail);

/**
 * `'temperature' does not support 0.7 with this model. Only the default (1) is supported.`
 *
 * The qualifier is load-bearing. A temperature out of range is the caller's mistake to see
 * rather than ours to work around, and dropping the field would hide it.
 */
const refusesChosenTemperature = (detail: string) =>
  /temperature/i.test(detail) && /only the default|does not support/i.test(detail);

/** What `negotiate` takes besides the request. Both optional, both about telling someone. */
export interface NegotiateOptions {
  /**
   * The flag `send` will be given, for a caller that has to read it after `negotiate` returns.
   *
   * An outer retry loop needs it: nothing is retried once the server has started answering, and
   * by the time a rejected promise is in hand the turn is over. Callers without one can leave
   * this out and take the flag from `send`'s second argument, which is the same object.
   */
  produced?: Produced;
  /** Told what was given up on, for a watcher who would otherwise see an unexplained pause. */
  onNotice?: (message: string) => void;
  /**
   * Which model this request is for, by the name the endpoint knows it as.
   *
   * Given one, the refusals that are about the model rather than the server are answered too,
   * and `send` is handed what that model has already refused. Left out, nothing changes — which
   * is the point of it being here rather than a third positional argument: a caller with one
   * model per endpoint, or one that only ever meets the endpoint's own refusals, needs no edit.
   */
  model?: string;
}

/**
 * Sends a request, re-sending it each time the answer is this endpoint refusing something the
 * request can do without. Returns once the endpoint has answered, or throws if the refusal is
 * not one of ours.
 *
 * A loop rather than one retry. A server that has heard of neither `stream_options` nor a
 * grammar keyword complains about them one at a time, and answering only the first leaves the
 * second to fail the request — so the first run against such an endpoint is spent discovering
 * what the second one starts knowing. It terminates in at most one pass per capability, since
 * each pass either latches one off for good or rethrows.
 *
 * One loop over both levels, because a refusal arrives the same way whichever it is about and
 * one request can meet both. An OpenAI reasoning model has two waiting on its own — the ceiling
 * is spelled the other way, and then the temperature is not ours to pick — so a loop that
 * stopped after the first answer would hand the caller the second.
 *
 * `send` is a thunk rather than a request body because the body has to be rebuilt from the
 * latched flags: `relaxTools` applies to the tools that were just sanitised, and
 * `stream_options` is present or absent rather than adjusted. It is generic over what it
 * resolves, so a caller whose request resolves a stream object before any chunk is read is the
 * same shape as one that resolves a finished turn.
 *
 * It is handed the `produced` flag rather than being expected to close over one. There is only
 * ever one flag in a turn — the same box `streamTurn` sets and the re-send below reads — and a
 * caller that passed it to only one of the two got a turn that had already streamed tokens sent
 * again, silently, with the watcher seeing every one of them twice.
 *
 * @param supports What this endpoint has already refused. Latched off further as it refuses more.
 * @param send Builds and sends the request. Called again per downgrade, never once tokens
 * have arrived. Its third argument is what the named model has refused, absent when no model
 * was named.
 * @param options `produced` for a caller with its own retry budget, `onNotice` for a watcher,
 * `model` to negotiate the model's refusals alongside the endpoint's.
 */
export async function negotiate<T>(
  supports: Capabilities,
  send: (
    supports: Capabilities,
    produced: Produced,
    model: ModelCapabilities | undefined,
  ) => Promise<T>,
  { produced = { any: false }, onNotice, model: name }: NegotiateOptions = {},
): Promise<T> {
  const model = name === undefined ? undefined : modelCapabilitiesFor(supports, name);
  for (;;) {
    // What this attempt was built with. `capabilitiesFor` and `modelCapabilitiesFor` hand one
    // object per endpoint and per model to everyone on them, so a run starting alongside this
    // one may latch a flag off while this call is in flight — and the branches below are guarded
    // on the flag still being set.
    const sent = flagsOf(supports, model);
    try {
      return await send(supports, produced, model);
    } catch (error) {
      if (produced.any) throw error;
      const detail = errorMessage(error);
      if (supports.strictSchemas && isGrammarError(detail)) {
        supports.strictSchemas = false;
        onNotice?.("server could not build a grammar; retrying without pattern/format");
      } else if (supports.usageInStream && REJECTS_USAGE.test(detail)) {
        supports.usageInStream = false;
        onNotice?.("server rejected stream_options; token counts unavailable");
      } else if (model?.reasoningEffort && rejectsEffort(detail)) {
        model.reasoningEffort = false;
        onNotice?.("model does not take a reasoning effort; retrying without one");
      } else if (model?.legacyTokenLimit && wantsCompletionLimit(detail)) {
        model.legacyTokenLimit = false;
        onNotice?.("model wants max_completion_tokens; retrying with the limit spelled that way");
      } else if (model?.chosenTemperature && refusesChosenTemperature(detail)) {
        model.chosenTemperature = false;
        onNotice?.("model takes only its own temperature; retrying without ours");
      } else if (flagsOf(supports, model).every((flag, index) => flag === sent[index])) {
        throw error;
      }
      // Otherwise the refusal was answered by whoever got there first, and this attempt was
      // built before the answer existed. Two runs opening on a fresh llama.cpp box both get the
      // grammar error; the first latches it off and re-sends, and the second used to find the
      // flag already clear, fall through to the throw and die on an error the process had just
      // learned to fix — `isTransient` refuses a 400, so `runTurn` would not send it again
      // either. Sending it again is the whole of the fix: flags only ever latch off, so this
      // gives up after one pass per flag.
    }
  }
}
