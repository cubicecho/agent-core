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

/** What one endpoint turned out not to support. Both start optimistic and only ever latch off. */
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
 */
export function capabilitiesFor(baseUrl: string): Capabilities {
  let known = capabilities.get(baseUrl);
  if (!known) {
    known = { strictSchemas: true, usageInStream: true };
    capabilities.set(baseUrl, known);
  }
  return known;
}

/** Forgets every endpoint's capabilities. For tests, and for a settings change under test. */
export function resetCapabilities() {
  capabilities.clear();
}

/** `stream_options` is named in the refusal by every server that has not heard of it. */
const REJECTS_USAGE = /stream_options/i;

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
 */
export async function negotiate<T>(
  supports: Capabilities,
  send: (supports: Capabilities, produced: Produced) => Promise<T>,
  { produced = { any: false }, onNotice }: NegotiateOptions = {},
): Promise<T> {
  for (;;) {
    try {
      return await send(supports, produced);
    } catch (error) {
      if (produced.any) throw error;
      const detail = errorMessage(error);
      if (supports.strictSchemas && isGrammarError(detail)) {
        supports.strictSchemas = false;
        onNotice?.("server could not build a grammar; retrying without pattern/format");
      } else if (supports.usageInStream && REJECTS_USAGE.test(detail)) {
        supports.usageInStream = false;
        onNotice?.("server rejected stream_options; token counts unavailable");
      } else {
        throw error;
      }
    }
  }
}
