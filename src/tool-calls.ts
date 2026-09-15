import type OpenAI from "openai";

/**
 * Reading what a model meant by a tool call when it did not write one cleanly.
 *
 * Local models get tool calls wrong in two ways a hosted one rarely does. The arguments come back
 * almost-JSON — single quotes, Python's `True`, a trailing comma, a string holding the JSON
 * rather than the JSON — or cut off at the ceiling. And the call comes back not as a call at all
 * but as text, in the model's own template, because the server's tool-call parser was written for
 * a different one. Both were being handled in every consumer, differently, or not at all.
 */

/** A tool call as the loop handles it, recovered or streamed. */
export type ToolCall = OpenAI.ChatCompletionMessageFunctionToolCall;

/**
 * Tool arguments that could not be read as an object, with why.
 *
 * `truncated` is a call cut off at the reply ceiling, which no repair can finish and the fix for
 * is a larger `maxTokens`; `malformed` is one the model wrote wrongly, which it can be told about
 * and try again.
 */
export class ToolArgumentsError extends Error {
  /** Whether the model ran out of room or wrote something unreadable. */
  readonly kind: "truncated" | "malformed";

  /**
   * @param kind Why the arguments could not be read.
   * @param message What the model is handed back as the tool's result.
   */
  constructor(kind: "truncated" | "malformed", message: string) {
    super(message);
    this.name = "ToolArgumentsError";
    this.kind = kind;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Rewrites the almost-JSON local models write into JSON, in one pass that knows where strings are.
 *
 * Single-quoted strings become double-quoted, Python's `True`, `False` and `None` become their JSON
 * spellings, bare keys are quoted, and a comma before a closing bracket is dropped. Nothing inside
 * a string is touched, so an argument that happens to say `True` or `a, }` survives.
 */
function repairJson(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const char = text[i];
    if (char === '"' || char === "'") {
      let body = "";
      let j = i + 1;
      for (; j < text.length && text[j] !== char; j++) {
        if (text[j] === "\\" && j + 1 < text.length) {
          // `\'` means nothing in JSON; a quote that needed escaping in single quotes does not.
          body += char === "'" && text[j + 1] === "'" ? "'" : text[j] + text[j + 1];
          j++;
        } else {
          body += char === "'" && text[j] === '"' ? '\\"' : text[j];
        }
      }
      out += `"${body}"`;
      i = j + 1;
      continue;
    }
    if (char === ",") {
      const next = text.slice(i + 1).match(/^\s*([\]}])?/);
      if (next?.[1]) {
        i++;
        continue;
      }
    }
    const word = /[A-Za-z_$]/.test(char)
      ? text.slice(i).match(/^[A-Za-z_$][\w$]*/)?.[0]
      : undefined;
    if (word) {
      const python = { True: "true", False: "false", None: "null" }[word];
      if (/^\s*:/.test(text.slice(i + word.length))) out += `"${word}"`;
      else out += python ?? word;
      i += word.length;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/** JSON as it was written, then repaired, then undefined. A string holding JSON is opened once. */
function looseJson(text: string): unknown {
  for (const candidate of [text, repairJson(text)]) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (typeof value !== "string") return value;
      const inner = value.trim();
      if (!/^[[{]/.test(inner)) return value;
      return looseJson(inner) ?? value;
    } catch {
      // The next candidate.
    }
  }
  return undefined;
}

/**
 * A tool call's arguments as the object the tool is handed. Empty is no arguments.
 *
 * Lenient where the model's meaning is plain and strict where it is not: an object already
 * parsed passes through, JSON inside a string is opened, and the almost-JSON local models write —
 * single quotes, `True`, bare keys, a trailing comma — is repaired. What is still not an object
 * throws a `ToolArgumentsError`, and the loop hands its message back to the model as the tool's
 * result so it can try again.
 *
 * @param raw The arguments as the model sent them: usually the streamed string, sometimes an
 * object a server parsed already. Null, absent or blank is no arguments.
 * @param options `finishReason`, the turn's. A turn that stopped at `"length"` makes a failure
 * `truncated`, since a call cut off at the ceiling reads exactly like a malformed one.
 */
export function parseToolArguments(
  raw: unknown,
  { finishReason }: { finishReason?: string | null } = {},
): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (raw === null || raw === undefined) return {};
  const text = typeof raw === "string" ? raw.trim() : JSON.stringify(raw);
  if (!text) return {};
  const parsed = looseJson(text);
  if (isRecord(parsed)) return parsed;
  if (finishReason === "length") {
    throw new ToolArgumentsError(
      "truncated",
      `the tool call was cut off at the reply ceiling before its arguments were complete; raise maxTokens: ${text.slice(0, 200)}`,
    );
  }
  throw new ToolArgumentsError(
    "malformed",
    parsed === undefined
      ? `model produced invalid tool arguments: ${text.slice(0, 200)}`
      : `model produced tool arguments that are not an object: ${text.slice(0, 200)}`,
  );
}

/**
 * Where the JSON value opening at `start` closes, one past its last character, or -1 when it
 * never does. Brackets inside either kind of string are not counted.
 */
function valueEnd(text: string, start: number): number {
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The JSON value opening at or after `at`, past whitespace, and where it ends. An unclosed one
 * runs to the end of the text; one that does not parse even repaired is undefined.
 */
function readValue(text: string, at: number): { value: unknown; end: number } | undefined {
  const start = at + (text.slice(at).match(/^\s*/)?.[0].length ?? 0);
  if (text[start] !== "{" && text[start] !== "[") return undefined;
  const closed = valueEnd(text, start);
  const end = closed < 0 ? text.length : closed;
  const value = looseJson(text.slice(start, end));
  return value === undefined ? undefined : { value, end };
}

/** One call in any of the shapes templates write: `{name, arguments}`, `{name, parameters}`, `{function: {...}}`. */
function toCall(entry: unknown): { name: string; arguments: string } | undefined {
  if (!isRecord(entry)) return undefined;
  const inner = isRecord(entry.function) ? entry.function : entry;
  const name = inner.name;
  if (typeof name !== "string" || !name) return undefined;
  const args = inner.arguments ?? inner.parameters ?? inner.args ?? {};
  return { name, arguments: typeof args === "string" ? args : JSON.stringify(args) };
}

/** Every call in a value that is one call or a list of them, or undefined if any entry is not one. */
function toCalls(value: unknown): { name: string; arguments: string }[] | undefined {
  const entries = Array.isArray(value) ? value : [value];
  const calls = entries.map(toCall);
  return calls.length && calls.every((call) => call)
    ? (calls as { name: string; arguments: string }[])
    : undefined;
}

/** A value read as text: JSON where it parses, the string where it does not. */
function scalar(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface Found {
  start: number;
  end: number;
  calls: { name: string; arguments: string }[];
}

/** `<tool_call>` blocks: Hermes and Qwen's JSON, and Qwen3-Coder's `<function=…>` markup. */
function taggedCalls(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(/<tool_call>/g)) {
    const at = match.index + match[0].length;
    const closing = /\s*<\/tool_call>/y;
    const xml = text.slice(at).match(/^\s*<function=([^>\s]+)>([\s\S]*?)<\/function>/);
    if (xml) {
      const args: Record<string, unknown> = {};
      for (const param of xml[2].matchAll(/<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
        args[param[1]] = scalar(param[2]);
      }
      closing.lastIndex = at + xml[0].length;
      const end = closing.test(text) ? closing.lastIndex : at + xml[0].length;
      found.push({
        start: match.index,
        end,
        calls: [{ name: xml[1], arguments: JSON.stringify(args) }],
      });
      continue;
    }
    const read = readValue(text, at);
    const calls = read && toCalls(read.value);
    if (!read || !calls) continue;
    closing.lastIndex = read.end;
    found.push({
      start: match.index,
      end: closing.test(text) ? closing.lastIndex : read.end,
      calls,
    });
  }
  return found;
}

/** Mistral's `[TOOL_CALLS] [...]`, and the newer `[TOOL_CALLS]name[ARGS]{...}`. */
function mistralCalls(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(/\[TOOL_CALLS\]/g)) {
    const at = match.index + match[0].length;
    const named = text.slice(at).match(/^\s*([\w.-]+)\[ARGS\]/);
    if (named) {
      const read = readValue(text, at + named[0].length);
      if (!read || !isRecord(read.value)) continue;
      found.push({
        start: match.index,
        end: read.end,
        calls: [{ name: named[1], arguments: JSON.stringify(read.value) }],
      });
      continue;
    }
    const read = readValue(text, at);
    const calls = read && toCalls(read.value);
    if (read && calls) found.push({ start: match.index, end: read.end, calls });
  }
  return found;
}

/** Llama 3's `<|python_tag|>{...}`, several calls separated by semicolons, up to `<|eom_id|>`. */
function pythonTagCalls(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(/<\|python_tag\|>/g)) {
    const calls: { name: string; arguments: string }[] = [];
    let end = match.index + match[0].length;
    for (;;) {
      const read = readValue(text, end);
      const more = read && toCalls(read.value);
      if (!read || !more) break;
      calls.push(...more);
      end = read.end;
      const separator = text.slice(end).match(/^\s*;/);
      if (!separator) break;
      end += separator[0].length;
    }
    const eom = text.slice(end).match(/^\s*<\|eom_id\|>/);
    if (eom) end += eom[0].length;
    if (calls.length) found.push({ start: match.index, end, calls });
  }
  return found;
}

/**
 * A bare JSON call — the whole reply, or its one fenced block — naming only tools that exist.
 * Without the names this is too easily an answer that happens to be JSON.
 */
function bareCalls(text: string, names: ReadonlySet<string>): Found[] {
  if (!names.size) return [];
  const known = (calls: { name: string; arguments: string }[] | undefined) =>
    calls?.every((call) => names.has(call.name)) ? calls : undefined;
  const start = text.search(/\S/);
  if (start >= 0 && (text[start] === "{" || text[start] === "[")) {
    const read = readValue(text, start);
    const calls = read && !text.slice(read.end).trim() ? known(toCalls(read.value)) : undefined;
    if (read && calls) return [{ start, end: read.end, calls }];
  }
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\n?([\s\S]*?)```/gi)];
  if (fences.length !== 1) return [];
  const [fence] = fences;
  const body = fence[1].trim();
  const read = /^[[{]/.test(body) ? readValue(body, 0) : undefined;
  const calls = read && !body.slice(read.end).trim() ? known(toCalls(read.value)) : undefined;
  return calls ? [{ start: fence.index, end: fence.index + fence[0].length, calls }] : [];
}

/**
 * Tool calls a model wrote into its reply as text, taken out of it and made into calls.
 *
 * A server whose tool-call parser does not match the model's chat template streams the call as
 * content, and the run ends on what reads like a finished answer. The templates' own markers are
 * looked for — `<tool_call>` (Hermes, Qwen, Qwen3-Coder's markup included), `[TOOL_CALLS]`
 * (Mistral, both spellings) and `<|python_tag|>` (Llama 3) — and, failing those, a reply that is
 * nothing but a JSON call, or holds one fenced one, provided every name in it is in `names`. Only
 * text after the last `</think>` is searched, since a model deliberating about a call is not making
 * one.
 *
 * @param content The turn's text.
 * @param options `names`, the tools that exist. Without them only the templates' markers count.
 * @returns The text with the calls taken out, and the calls, numbered `call_recovered_0` onward.
 * No calls leaves the text as it was.
 */
export function recoverToolCalls(
  content: string,
  { names = [] }: { names?: Iterable<string> } = {},
): { content: string; toolCalls: ToolCall[] } {
  const thought = content.toLowerCase().lastIndexOf("</think>");
  const from = thought < 0 ? 0 : thought + "</think>".length;
  const tail = content.slice(from);
  let found = [...taggedCalls(tail), ...mistralCalls(tail), ...pythonTagCalls(tail)];
  if (!found.length) found = bareCalls(tail, new Set(names));
  if (!found.length) return { content, toolCalls: [] };

  found.sort((a, b) => a.start - b.start);
  let rest = "";
  let cursor = 0;
  const toolCalls: ToolCall[] = [];
  for (const span of found) {
    if (span.start < cursor) continue;
    rest += tail.slice(cursor, span.start);
    cursor = span.end;
    for (const call of span.calls) {
      toolCalls.push({
        id: `call_recovered_${toolCalls.length}`,
        type: "function",
        function: call,
      });
    }
  }
  rest += tail.slice(cursor);
  return { content: `${content.slice(0, from)}${rest}`.trim(), toolCalls };
}
