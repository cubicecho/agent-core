import type OpenAI from "openai";

/**
 * JSON Schema compatibility for llama.cpp-backed servers.
 *
 * llama.cpp compiles every tool's parameter schema into one combined GBNF grammar, so a
 * single shape its converter dislikes fails the whole request — not just the offending
 * tool. MCP servers emit those shapes routinely. This mirrors what NousResearch/hermes-agent
 * does in `tools/schema_sanitizer.py` and `agent/error_classifier.py`:
 *
 *   1. Normalise the structurally hostile shapes up front, on every request.
 *   2. If the server still reports a grammar failure, strip the advisory `pattern` and
 *      `format` keywords and retry once.
 *
 * Cloud providers accept all of this, so step 2 never fires against them.
 */

type Schema = Record<string, unknown>;

const isObject = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Lookahead and lookbehind: `(?=`, `(?!`, `(?<=`, `(?<!`. */
const LOOKAROUND = /\(\?<?[=!]/;

const PRIMITIVES = new Set(["object", "string", "number", "integer", "boolean", "array", "null"]);
const EMPTY_OBJECT = () => ({ type: "object", properties: {} });

/** Keys whose value is a schema, or a list of them — several are spelled both ways. */
const SCHEMA_KEYS = new Set([
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "anyOf",
  "oneOf",
  "allOf",
  "prefixItems",
]);
/** Keys whose value is a name -> schema map. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

/**
 * Coerces one schema position. Malformed MCP output sometimes puts a bare type name where a
 * whole schema belongs, which the grammar converter reports as `Unrecognized schema: "object"`.
 */
function asSchema(node: unknown): unknown {
  if (typeof node === "string")
    return PRIMITIVES.has(node) && node !== "object" ? { type: node } : EMPTY_OBJECT();
  if (typeof node === "boolean") return node;
  if (!isObject(node)) return EMPTY_OBJECT();
  return normalize(node);
}

/** Recursively rewrites the shapes llama.cpp's grammar converter cannot represent. */
function normalize(node: Schema): Schema {
  const out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    // `type: ["string", "null"]` — the converter only accepts a single string type.
    if (key === "type" && Array.isArray(value)) {
      const names = value.filter((item): item is string => typeof item === "string");
      const concrete = names.filter((name) => name !== "null");
      if (names.includes("null")) out.nullable = true;
      if (concrete.length === 1) out.type = concrete[0];
      else if (concrete.length > 1) out.anyOf = concrete.map((name) => ({ type: name }));
      else out.type = "null";
    } else if (SCHEMA_KEYS.has(key)) {
      out[key] = Array.isArray(value) ? value.map(asSchema) : asSchema(value);
    } else if (SCHEMA_MAPS.has(key) && isObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, asSchema(sub)]),
      );
    } else {
      out[key] = value;
    }
  }

  collapseNullableUnion(out);

  // A grammar is context-free; lookaround is not expressible in one at all, so no converter
  // can accept it. Dropping it costs one advisory constraint on one string field.
  if (typeof out.pattern === "string" && LOOKAROUND.test(out.pattern)) delete out.pattern;
  // `{"type": "object"}` with no properties produces invalid GBNF.
  if (out.type === "object" && !isObject(out.properties)) out.properties = {};
  // Strict validators reject any sibling of `$ref`, and draft-07 ignores them, so a reference
  // stands alone or not at all. This is not hypothetical tidying: collapsing `anyOf: [{$ref},
  // {type: "null"}]` — the shape a schema-generated server emits at every optional argument —
  // lands `nullable` right next to the `$ref` that survived. Whatever is dropped here was
  // already unreadable to a conforming consumer; optionality still lives in the parent's
  // `required`.
  if ("$ref" in out) return { $ref: out.$ref };

  return out;
}

/**
 * `{anyOf: [{type: "string"}, {type: "null"}]}` is how Pydantic-backed MCP servers spell an
 * optional field. Optionality already lives in the parent's `required`, so keep the one real
 * branch. A union with two real branches is meaningful and is left alone.
 */
function collapseNullableUnion(node: Schema) {
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = node[key];
    if (!Array.isArray(variants)) continue;
    const concrete = variants.filter((item) => !(isObject(item) && item.type === "null"));
    if (concrete.length !== 1 || concrete.length === variants.length) continue;

    delete node[key];
    Object.assign(node, { nullable: true, ...(isObject(concrete[0]) ? concrete[0] : {}) });
  }
}

/** Combinators at the top level of a parameters schema; strict backends reject them outright. */
const TOP_LEVEL_COMBINATORS = ["allOf", "anyOf", "oneOf", "enum", "not"] as const;

function sanitizeParameters(parameters: unknown): Schema {
  if (!isObject(parameters)) return EMPTY_OBJECT();
  const out = normalize(parameters);

  for (const key of TOP_LEVEL_COMBINATORS) delete out[key];
  if (out.type !== "object") out.type = "object";
  if (!isObject(out.properties)) out.properties = {};
  return out;
}

const mapTools = (
  tools: OpenAI.ChatCompletionTool[],
  fn: (parameters: unknown) => Schema,
): OpenAI.ChatCompletionTool[] =>
  tools.map((tool) =>
    tool.type === "function"
      ? { ...tool, function: { ...tool.function, parameters: fn(tool.function.parameters) } }
      : tool,
  );

/**
 * Cached against the tool object rather than recomputed.
 *
 * The agent loop rebuilds its tool array on every iteration of every step, and normalising a
 * couple of dozen MCP schemas is the only walk in a run that is neither a request nor a query.
 * The pool hands out the same definition objects for the life of a connection, so identity is
 * exactly the right key: a reconnect makes new ones and they are normalised again.
 */
const sanitized = new WeakMap<OpenAI.ChatCompletionTool, OpenAI.ChatCompletionTool>();

export const sanitizeTools = (tools: OpenAI.ChatCompletionTool[]) =>
  tools.map((tool) => {
    const hit = sanitized.get(tool);
    if (hit) return hit;
    const [clean] = mapTools([tool], sanitizeParameters);
    sanitized.set(tool, clean);
    return clean;
  });

/**
 * The retry shape: llama.cpp's converter rejects regex escape classes (`\d`, `\w`, `\s`) in
 * `pattern` and most `format` values, both of which only ever narrowed a string the tool
 * re-validates anyway.
 */
export function relaxTools(tools: OpenAI.ChatCompletionTool[]) {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!isObject(node)) return node;
    const out: Schema = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "pattern" || key === "format") continue;
      out[key] = strip(value);
    }
    return out;
  };
  return mapTools(tools, (parameters) => {
    const stripped = strip(parameters);
    return isObject(stripped) ? stripped : EMPTY_OBJECT();
  });
}

/**
 * Qwen chat templates raise this when the transcript has no user turn. Some servers wrap it
 * in the same "unable to generate parser" wording as a real schema failure, and stripping
 * keywords would not fix it.
 */
const NO_USER_QUERY = "no user query found";

/**
 * Does this failure look like the server could not build a grammar from our tool schemas?
 *
 * Every server words this differently — llama-server says "error parsing grammar", Lemonade
 * says "Failed to initialize samplers: failed to parse grammar", others surface the converter
 * by name. Since a grammar is only ever involved in constrained decoding, treat any mention of
 * one as ours; the retry is cheap and latches after a single request.
 */
export function isGrammarError(message: string): boolean {
  const text = message.toLowerCase();
  if (text.includes(NO_USER_QUERY)) return false;
  return (
    text.includes("grammar") ||
    text.includes("unrecognized schema") ||
    text.includes("json schema conversion failed") ||
    (text.includes("unable to generate parser") && text.includes("template"))
  );
}
