import type OpenAI from 'openai';
import type { ToolCall } from './tool-calls.ts';
import { Role } from './wire.ts';

/**
 * The ids of tool calls the loop makes up itself, and keeping every id in a transcript its own.
 *
 * A server that streams a call with no id, a call recovered from text, and a proxied run's
 * preselected load all need an id nobody sent. The shape is the strictest any server holds them
 * to: Mistral's tokenizers before V13 take exactly nine characters from `[A-Za-z0-9]` and refuse
 * the request otherwise, and nine alphanumerics are also inside OpenAI's forty and anything
 * llama.cpp or Ollama reads. The id has to be unique across the conversation, not just the turn:
 * vLLM's harmony path and Ollama find a result's tool by its id across the whole history, and
 * Anthropic, behind a proxy, refuses a repeated one.
 */

/** What a minted id is drawn from: the characters every server takes in one. */
const CALL_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** How long a minted id is: exactly what Mistral's tokenizers before V13 take. */
const CALL_ID_LENGTH = 9;

/** How many times a minter is asked for an id not already taken before it is given up on. */
const MINT_ATTEMPTS = 32;

/** One more than the largest unsigned 32-bit integer, which turns one into a fraction of one. */
const UINT32_RANGE = 4_294_967_296;

/** The constants of mulberry32: its Weyl step, the odd terms of its mix, and its three shifts in order. */
const MULBERRY = { step: 0x6d2b79f5, first: 1, second: 61, right: 15, left: 7, last: 14 } as const;

/** Makes up the id of a tool call: nine characters from `[A-Za-z0-9]` each time it is called. */
export type CallIdMinter = () => string;

/**
 * A repeatable sequence of fractions in `[0, 1)` from one seed, for a test that wants the same ids
 * on every run.
 *
 * @param seed - Where the sequence starts. Read as an unsigned 32-bit integer.
 * @returns The next fraction each time it is called.
 *
 * @remarks
 * mulberry32: small, fast and well spread, which is all an id wants. It is not for anything that
 * must not be guessed.
 */
function seededFractions(seed: number): () => number {
  let state = seed >>> 0;
  const { right, left, last } = MULBERRY;
  return () => {
    state = (state + MULBERRY.step) >>> 0;
    let mixed = Math.imul(state ^ (state >>> right), state | MULBERRY.first);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> left), mixed | MULBERRY.second);
    return ((mixed ^ (mixed >>> last)) >>> 0) / UINT32_RANGE;
  };
}

/**
 * A source of tool-call ids, each nine characters from `[A-Za-z0-9]`: random, or the same
 * sequence on every run for one seed.
 *
 * @param [seed] - Makes the sequence repeatable, for a test. Absent draws from `Math.random`.
 * @returns A minter, to pass as `mintCallId` wherever one is taken.
 *
 * @remarks
 * This is the shape vLLM's `MistralToolCall.generate_random_id` makes. Uniqueness within a run is
 * not left to chance: `distinctCallIds` checks each id against the transcript and asks again.
 */
export function callIdMinter(seed?: number): CallIdMinter {
  const fraction = seed === undefined ? Math.random : seededFractions(seed);
  return () => {
    let id = '';
    for (let at = 0; at < CALL_ID_LENGTH; at++) {
      id += CALL_ID_ALPHABET[Math.floor(fraction() * CALL_ID_ALPHABET.length)];
    }
    return id;
  };
}

/** The minter used where none is given. */
export const mintCallId: CallIdMinter = callIdMinter();

/**
 * Every tool-call id a transcript already uses: on an assistant message's calls, and on the tool
 * results that answer them.
 *
 * @param messages - The transcript. Not written to.
 * @returns The ids, as a set to add to.
 *
 * @remarks
 * A result is counted as well as its call, so a host history that kept a result whose call was
 * trimmed away still keeps its id from being handed out again.
 */
export function callIdsIn(messages: readonly OpenAI.ChatCompletionMessageParam[]): Set<string> {
  const taken = new Set<string>();
  for (const message of messages) {
    if (message.role === Role.Assistant) {
      for (const call of message.tool_calls ?? []) {
        taken.add(call.id);
      }
    } else if (message.role === Role.Tool) {
      taken.add(message.tool_call_id);
    }
  }
  return taken;
}

/**
 * An id from `mint` that `taken` does not hold, added to it.
 *
 * @param taken - The ids in use. Written to: the id returned is added.
 * @param [mint] - Where ids come from.
 * @returns The new id.
 * @throws {Error} Where `mint` gives only ids already taken, as one that returns a constant does.
 */
export function freshCallId(taken: Set<string>, mint: CallIdMinter = mintCallId): string {
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const id = mint();
    const isFree = taken.has(id) === false;
    if (isFree) {
      taken.add(id);
      return id;
    }
  }
  throw new Error(`mintCallId gave ${MINT_ATTEMPTS} ids in a row that the transcript already uses`);
}

/**
 * A turn's calls under ids no other call in the transcript has: the server's own kept wherever it
 * is free, and a minted one in place of a missing or repeated one.
 *
 * @param calls - The turn's calls. Not written to.
 * @param messages - The transcript the turn's assistant message is about to join. Not written to.
 * @param [mint] - Where a new id comes from.
 * @returns The calls, each the object it was where its id stood and a copy under a new id where
 * it did not.
 *
 * @remarks
 * A server's id is kept as sent, whatever its shape: it is the server's to read back, and a
 * Mistral server issues ones that fit its own rule. It is replaced only where it would answer for
 * two calls — empty, or already in the transcript, which a server that counts its ids from zero
 * on every turn does. That happens once, before the message is stored, so the assistant message
 * and the result that answers it carry the new id on every request after; the one request whose
 * cache it can cost is the next, and an id answered twice costs more than that.
 */
export function distinctCallIds(
  calls: readonly ToolCall[],
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  mint: CallIdMinter = mintCallId,
): ToolCall[] {
  const taken = callIdsIn(messages);
  return calls.map((call) => {
    const isFree = call.id !== '' && taken.has(call.id) === false;
    if (isFree) {
      taken.add(call.id);
      return call;
    }
    return { ...call, id: freshCallId(taken, mint) };
  });
}
