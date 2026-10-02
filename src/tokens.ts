import type OpenAI from "openai";

/**
 * The characters one token is taken to be, where nothing has measured it.
 *
 * The fallback, not the rule: once a turn has come back with a reported prompt count, `runTurn`
 * divides by what that endpoint's model was measured at instead. See `charsPerTokenFor`.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Rough token count. Characters over four, because there is no tokenizer here and there is not
 * going to be one: a server that will not say how big its window is will not lend us its
 * vocabulary either.
 *
 * The estimate runs low on tool schemas — JSON packs more tokens into a character than prose
 * does — and that is the side to be wrong on wherever it guards a window, since the cost of
 * guessing high is a run refused that would have worked, and the cost of guessing low is the
 * endpoint's own refusal, which is where we were before the guard existed.
 *
 * Its own module because it is the one number several of these agree on. It was extracted from
 * `side-task` to break a cycle with `retry`; neither reads it now, but `hooks` does to cap a
 * context block, as does any consumer sizing its own prompt. Everything else that sizes a request
 * is below it — a message's characters, a tool block's, a request's, and the breakdown of a
 * window — so the module imports nothing but the SDK's types and anything may read it.
 *
 * @param text Prose or serialised JSON — both counted the same way, which is why JSON reads low.
 */
export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

/**
 * 1234 → "1.2k". The numbers in an overflow message are large and nobody reads the units digit.
 *
 * @param tokens The count to render.
 */
export const compact = (tokens: number) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

/** What `{"role":"","content":""},` costs around a message's own text, in characters. */
const ENVELOPE = 25;

/** The same for `{"id":"","type":"function","function":{"name":"","arguments":""}},` in a call. */
const CALL_ENVELOPE = 66;

// `ENVELOPE` is the two keys every message has. These are the three that only some do, and each
// is the key with its punctuation and the comma after the value it holds — the value's own
// length is counted where the value is read. Applying `ENVELOPE` alone to these shapes left the
// keys out, which cost 4.5 tokens on every tool result: the message a tool-using run has most
// of, and short in the direction that lets an overflow through the guard meant to catch it.

/** What `"name":"",` costs around a message's name. */
const NAME_KEY = 10;

/** The same for `"tool_call_id":"",` around a tool result's call id. */
const TOOL_CALL_ID_KEY = 18;

/** The same for `"tool_calls":[]` around the calls; each call's own comma is in `CALL_ENVELOPE`. */
const TOOL_CALLS_KEY = 15;

// A content part is an object in the body the same way a message is, and its two keys are in the
// request exactly as `tool_call_id` was. Charging only `part.text` left them out, which is 6.5
// tokens per part — short in proportion to how finely the content is split rather than to how
// much it says, so a transcript a client appends block by block is worst hit.

/** What `{"type":"text","text":""},` costs around a text part. */
const TEXT_PART = 26;

/** The same for `{"type":"refusal","refusal":""},` around a refusal part. */
const REFUSAL_PART = 32;

/**
 * The same for `"reasoning_content":"",` around an assistant message's scratchpad.
 *
 * Not in the SDK's types, and passed back by the caller who keeps it: gpt-oss and DeepSeek in
 * thinking mode want the analysis behind a tool call on the next request. Left uncounted, the
 * guard came up short by the whole scratchpad on exactly the runs that follow that rule.
 */
const REASONING_KEY = 23;

/** The same for `"reasoning":"",`, OpenRouter's spelling of it. */
const REASONING_ALT_KEY = 15;

/** What the two token estimates below take besides what they measure. */
export interface TokenEstimateOptions {
  /**
   * The divisor, `CHARS_PER_TOKEN` unless given — `charsPerTokenFor` for a model whose reported
   * usage has calibrated it. A value that is not a number above zero is ignored.
   */
  charsPerToken?: number;
}

/** The divisor an option asked for, or the fallback when it asked for nothing usable. */
const divisor = (charsPerToken: number | undefined) =>
  charsPerToken !== undefined && charsPerToken > 0 ? charsPerToken : CHARS_PER_TOKEN;

/**
 * How many characters one message is worth: its keys, and its content in whichever shape.
 *
 * @param message The message as it will be sent.
 */
export function messageChars(message: OpenAI.ChatCompletionMessageParam): number {
  let chars = message.role.length + ENVELOPE;
  const { content } = message;
  if (typeof content === "string") chars += content.length;
  else if (Array.isArray(content))
    for (const part of content) {
      // Text and refusal parts carry their own strings; an image or an audio part carries a URL
      // or a blob, and neither is priced by its length anyway — a vision model does not charge
      // an image by its base64 length, so counting the data URL would overshoot by more than
      // leaving the part out undershoots.
      if (part.type === "text") chars += TEXT_PART + part.text.length;
      else if (part.type === "refusal") chars += REFUSAL_PART + part.refusal.length;
    }

  if ("name" in message && typeof message.name === "string")
    chars += NAME_KEY + message.name.length;
  if ("tool_call_id" in message && typeof message.tool_call_id === "string")
    chars += TOOL_CALL_ID_KEY + message.tool_call_id.length;
  const { reasoning_content: reasoning, reasoning: alternate } = message as {
    reasoning_content?: unknown;
    reasoning?: unknown;
  };
  if (typeof reasoning === "string") chars += REASONING_KEY + reasoning.length;
  if (typeof alternate === "string") chars += REASONING_ALT_KEY + alternate.length;
  if ("tool_calls" in message && Array.isArray(message.tool_calls)) {
    chars += TOOL_CALLS_KEY;
    for (const call of message.tool_calls) {
      chars += CALL_ENVELOPE + call.id.length;
      if (call.type === "function")
        chars += call.function.name.length + call.function.arguments.length;
    }
  }
  return chars;
}

/**
 * The tools half, cached against the array.
 *
 * Serialising two dozen JSON schemas to measure them, on every turn, to get the same number every
 * time, was the more expensive half of this function.
 *
 * The array is the key, so this pays only a caller that hands the same one back. That is not what
 * a turn built through `sanitizeTools` or `relaxTools` does — both are a `map`, so each build
 * allocates a fresh array however stable the tools inside it are, and those builds miss here every
 * time. It is not free to change: keying on the tools instead would hit for them, at the cost of
 * the array-level memoisation `tests/retry.test.ts` pins, which deliberately holds a mutated array
 * to its first reading. Sizing happens once per turn either way, so the miss costs one walk of the
 * schemas rather than a walk per attempt.
 *
 * Characters rather than tokens, so a calibrated divisor applies to the schemas without walking
 * them again.
 */
const toolLengths = new WeakMap<OpenAI.ChatCompletionTool[], number>();

/**
 * How many characters a tool array is worth, measured once per array.
 *
 * @param tools The tool definitions as they will be sent. An empty array is worth nothing.
 */
export function toolsChars(tools: OpenAI.ChatCompletionTool[]): number {
  if (!tools.length) return 0;
  const hit = toolLengths.get(tools);
  if (hit !== undefined) return hit;
  // Schemas are arbitrarily shaped, so this one really is a serialisation — but it happens once
  // per tool array rather than once per turn.
  const length = JSON.stringify(tools).length;
  toolLengths.set(tools, length);
  return length;
}

/**
 * How many characters a request is worth: the walk `requestTokens` divides, without the division.
 *
 * What calibration reads a reported prompt count against, since a ratio is only as good as the
 * character count it was taken over agreeing with the one it is later applied to.
 *
 * @param body The request as it was sent, tools included.
 */
export function requestChars(body: OpenAI.ChatCompletionCreateParamsStreaming): number {
  let chars = 0;
  for (const message of body.messages) chars += messageChars(message);
  return chars;
}

/**
 * What this request will cost the window, in tokens, near enough.
 *
 * See `estimateTokens` for why it is characters over four and which way it is wrong on purpose,
 * and `charsPerTokenFor` for the divisor a model's own reported usage has measured instead.
 *
 * Summed by walking the body rather than by serialising it. `JSON.stringify` on the messages
 * built the entire transcript into a string on every call and threw it away having read nothing
 * but its `.length` — against a transcript that grows by a turn each turn, and one the SDK is
 * about to serialise again to send. What the walk misses is JSON's own punctuation and the keys,
 * which the envelope constants put back — one per key and one per content part, rather than one
 * per message, since the keys only some shapes carry and the parts a client appends block by
 * block are most of what a tool-using transcript is made of. What is left is a message's
 * escaping, which is not a constant and is small against an estimate that is already characters
 * over four.
 *
 * @param body The request as it will be sent, tools included.
 * @param options The divisor, `CHARS_PER_TOKEN` when none is given.
 */
export const requestTokens = (
  body: OpenAI.ChatCompletionCreateParamsStreaming,
  { charsPerToken }: TokenEstimateOptions = {},
) => {
  // Characters first and the division once at the end, rather than a rounded count per message:
  // `Math.ceil` on every one of a few hundred messages is a few hundred tokens of pure rounding.
  // The tools are divided on their own, as they were when their tokens were cached, so the
  // uncalibrated count is the one it always was.
  const per = divisor(charsPerToken);
  return Math.ceil(requestChars(body) / per) + Math.ceil(toolsChars(body.tools ?? []) / per);
};

/**
 * What a request is made of, by the part of it a consumer can actually do something about.
 *
 * The question an operator asks is not how big the request is — the total already answers that —
 * but what is filling the window, and the only useful answer names a lever: a system prompt to
 * shorten, a tool list to load on demand instead of declaring whole, a transcript to compact,
 * results to prune. So the cut follows the levers rather than the roles: `toolResults` is exactly
 * what `pruneToolResults` can shrink, and `history` is everything `planCompaction` folds, the
 * arguments of the calls in it included.
 */
export interface ContextBreakdown {
  /** Every system and developer message, wherever it sits in the transcript. */
  system: number;
  /** The declared tool schemas, which a chat template renders ahead of the system prompt. */
  tools: number;
  /** What was said: the user and assistant messages, and the calls the assistant asked for. */
  history: number;
  /** What the tools handed back — the `tool` messages, and nothing else. */
  toolResults: number;
  /** The four above, summed. */
  total: number;
}

/** The parts, in the order a readout reads them. */
const PARTS = ["system", "tools", "history", "toolResults"] as const;

/**
 * What each part of a request is worth in characters, by the same walk `requestTokens` divides.
 *
 * Exact and additive: the parts sum to `total`, which is `requestChars` plus `toolsChars`. The
 * conversion to tokens is `contextTokens`' business, because that is where an estimate and a
 * reported count have to be told apart.
 *
 * @param body The request as it will be sent, tools included.
 */
export function contextChars(body: OpenAI.ChatCompletionCreateParamsStreaming): ContextBreakdown {
  const out: ContextBreakdown = {
    system: 0,
    tools: toolsChars(body.tools ?? []),
    history: 0,
    toolResults: 0,
    total: 0,
  };
  for (const message of body.messages) {
    const chars = messageChars(message);
    // Every system message and not just the leading one: a host that appends guidance, or a
    // hook that injects a preface, has put more of the window there and wants to be told so.
    if (message.role === "system" || message.role === "developer") out.system += chars;
    else if (message.role === "tool") out.toolResults += chars;
    else out.history += chars;
  }
  out.total = out.system + out.tools + out.history + out.toolResults;
  return out;
}

/** What `contextTokens` takes besides the request. */
export interface ContextBreakdownOptions extends TokenEstimateOptions {
  /**
   * The prompt count the endpoint reported for this request, if it has answered. Given one, the
   * parts are shares of it and the breakdown sums to what was actually charged rather than to an
   * estimate; left out, they are shares of `requestTokens`.
   */
  promptTokens?: number;
}

/**
 * Shares `total` out over these parts by their character counts, the largest absorbing the
 * rounding so they add up to it exactly rather than to within a few tokens of it.
 */
function share(
  chars: ContextBreakdown,
  over: readonly (keyof ContextBreakdown)[],
  total: number,
): ContextBreakdown {
  const out: ContextBreakdown = { system: 0, tools: 0, history: 0, toolResults: 0, total };
  const measured = over.reduce((sum, part) => sum + chars[part], 0);
  if (measured <= 0 || total <= 0) return out;
  const absorber = over.reduce((a, b) => (chars[b] > chars[a] ? b : a));
  let assigned = 0;
  for (const part of over) {
    if (part === absorber) continue;
    out[part] = Math.round((chars[part] / measured) * total);
    assigned += out[part];
  }
  out[absorber] = Math.max(0, total - assigned);
  return out;
}

/**
 * What each part of a request costs the window, in tokens, adding up to the whole.
 *
 * Shares rather than four independent estimates, because a readout whose parts do not add up to
 * the total beside them is a readout nobody trusts. Nothing in the round trip reports anything
 * finer than a prompt count — a completion says how many tokens it read and not a word about
 * where they came from — so the proportions are an estimate whatever the total is.
 *
 * Without a reported count the total is `requestTokens`, and the tools are counted the way it and
 * `TurnMetrics.toolSchemaTokens` count them rather than shared out, so the two agree by
 * construction and an operator does not read one number for the tool block in the metrics and a
 * different one here. With a reported count every part is a share of it, the tools included:
 * that number is the server's, and the point of using it is that the parts sum to what was
 * charged.
 *
 * @param body The request as it will be sent, tools included.
 * @param options The divisor, and the reported prompt count when there is one.
 */
export function contextTokens(
  body: OpenAI.ChatCompletionCreateParamsStreaming,
  { charsPerToken, promptTokens }: ContextBreakdownOptions = {},
): ContextBreakdown {
  const chars = contextChars(body);
  if (promptTokens !== undefined && promptTokens > 0) return share(chars, PARTS, promptTokens);
  const per = divisor(charsPerToken);
  const tools = Math.ceil(chars.tools / per);
  const rest = Math.ceil((chars.total - chars.tools) / per);
  const out = share(chars, ["system", "history", "toolResults"], rest);
  out.tools = tools;
  out.total = rest + tools;
  return out;
}

/**
 * One message's estimated tokens, by the same count `requestTokens` sums for a whole request.
 *
 * For the arithmetic that weighs part of a transcript against a window — `planCompaction`'s kept
 * tail — where `estimateTokens` on the text alone would leave out the calls and the envelope.
 *
 * @param message The message as it will be sent.
 * @param options The divisor, `CHARS_PER_TOKEN` when none is given.
 */
export const messageTokens = (
  message: OpenAI.ChatCompletionMessageParam,
  { charsPerToken }: TokenEstimateOptions = {},
) => Math.ceil(messageChars(message) / divisor(charsPerToken));
