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

/** `#/definitions/Args` or `#/$defs/Args` — a pointer into this schema's own definitions. */
const LOCAL_POINTER = /^#\/(definitions|\$defs)\/([^/]+)$/;

/**
 * Replaces a root-level `$ref` with what it points at.
 *
 * Dropping the siblings of a `$ref` is right at a nested position and wrong at this one: the
 * siblings here are the `definitions` the pointer needs, so the reference is left dangling and
 * `properties` is then backfilled empty below. The tool goes out advertising no arguments at
 * all — which the model cannot detect and the server has no reason to refuse. A schema
 * generator emits this shape whenever the argument object is a named type.
 */
function inlineRootRef(parameters: Schema): Schema {
  const defs: Schema = {};
  for (const key of ["definitions", "$defs"] as const)
    if (isObject(parameters[key])) defs[key] = parameters[key];

  const seen = new Set<string>();
  let node: Schema = parameters;
  while (typeof node.$ref === "string") {
    const pointer = node.$ref;
    const target = LOCAL_POINTER.exec(pointer);
    // A pointer at another document, or one that comes back to itself, has nothing here to
    // resolve against. An object with no properties is at least honest about taking none.
    if (!target || seen.has(pointer)) return EMPTY_OBJECT();
    seen.add(pointer);
    const pool = defs[target[1]];
    const resolved = isObject(pool) ? pool[target[2]] : undefined;
    if (!isObject(resolved)) return EMPTY_OBJECT();
    node = resolved;
  }
  // The definitions travel with it: whatever the target refers to still lives in them.
  return node === parameters ? parameters : { ...node, ...defs };
}

/**
 * Folds a root `allOf` into the root itself.
 *
 * It is the other way a generated schema spells "the arguments are this named type", and
 * deleting it outright below threw the arguments away while leaving the `required` that named
 * them. Branches that are references are not something to guess at — those fall through to
 * `pruneRequired`, which at least keeps the result self-consistent.
 */
function mergeRootAllOf(out: Schema) {
  const branches = out.allOf;
  if (!Array.isArray(branches)) return;

  const properties: Schema = isObject(out.properties) ? { ...out.properties } : {};
  const required = new Set<string>(
    Array.isArray(out.required) ? out.required.filter((name) => typeof name === "string") : [],
  );
  for (const branch of branches) {
    if (!isObject(branch) || "$ref" in branch) continue;
    if (isObject(branch.properties)) Object.assign(properties, branch.properties);
    if (Array.isArray(branch.required))
      for (const name of branch.required) if (typeof name === "string") required.add(name);
  }

  if (!Object.keys(properties).length) return;
  out.properties = properties;
  if (required.size) out.required = [...required];
}

/**
 * A required argument that is not in `properties` is one no caller can supply and no strict
 * validator will accept. Anything the rewrites above removed, `required` may still name.
 */
function pruneRequired(out: Schema) {
  if (!Array.isArray(out.required)) return;
  const properties = isObject(out.properties) ? out.properties : {};
  const kept = out.required.filter((name) => typeof name === "string" && name in properties);
  if (kept.length) out.required = kept;
  else delete out.required;
}

function sanitizeParameters(parameters: unknown): Schema {
  if (!isObject(parameters)) return EMPTY_OBJECT();
  const out = normalize(inlineRootRef(parameters));

  mergeRootAllOf(out);
  for (const key of TOP_LEVEL_COMBINATORS) delete out[key];
  if (out.type !== "object") out.type = "object";
  if (!isObject(out.properties)) out.properties = {};
  pruneRequired(out);
  return out;
}

/** Rewrites one tool's parameters, leaving a non-function tool alone. */
const mapTool = (
  tool: OpenAI.ChatCompletionTool,
  fn: (parameters: unknown) => unknown,
): OpenAI.ChatCompletionTool =>
  tool.type === "function"
    ? {
        ...tool,
        function: { ...tool.function, parameters: fn(tool.function.parameters) as Schema },
      }
    : tool;

/**
 * Both rewrites are cached against the tool object rather than recomputed.
 *
 * The agent loop rebuilds its tool array on every iteration of every step, and normalising a
 * couple of dozen MCP schemas is the only walk in a run that is neither a request nor a query.
 * The pool hands out the same definition objects for the life of a connection, so identity is
 * exactly the right key: a reconnect makes new ones and they are normalised again.
 *
 * Two maps rather than one, because the two answer different questions about the same tool and a
 * relaxed schema is reached by way of a sanitised one. `relaxed` is the load-bearing half: an
 * endpoint that has refused a grammar once has `strictSchemas` off for the life of the process
 * (see `capabilities.ts`), so from that point every request takes this path and only this path.
 * Caching the call that happens once per connection and not the one that happens on every request
 * had it exactly the wrong way round.
 *
 * The contract both rely on is that a tool definition is not mutated in place. Nothing can evict
 * an entry here — a caller that edits `tool.function.parameters` after the fact keeps the schema
 * it had at first sight. Build a new definition object instead.
 */
const sanitized = new WeakMap<OpenAI.ChatCompletionTool, OpenAI.ChatCompletionTool>();
const relaxed = new WeakMap<OpenAI.ChatCompletionTool, OpenAI.ChatCompletionTool>();

/** Looks one up, computing and remembering it on a miss. */
const through = (
  cache: WeakMap<OpenAI.ChatCompletionTool, OpenAI.ChatCompletionTool>,
  tools: OpenAI.ChatCompletionTool[],
  fn: (parameters: unknown) => unknown,
) =>
  tools.map((tool) => {
    const hit = cache.get(tool);
    if (hit) return hit;
    const built = mapTool(tool, fn);
    cache.set(tool, built);
    return built;
  });

/**
 * Tool definitions a strict server will accept, remembered per definition object.
 *
 * The first call on a connection's tools does the work and every later one is a lookup, so
 * calling this per request costs nothing.
 *
 * @param tools The definitions as the pool hands them over. Never mutated — where a schema
 * changed, a new definition is returned in its place.
 */
export const sanitizeTools = (tools: OpenAI.ChatCompletionTool[]) =>
  through(sanitized, tools, sanitizeParameters);

/**
 * Walked as a schema rather than as arbitrary JSON, because `pattern` and `format` are keyword
 * names and perfectly ordinary argument names at once. Matching on the key alone deleted a
 * *property* called `format` along with the keyword, leaving the parent's `required` naming an
 * argument that no longer existed — which every strict validator rejects, so the retry produced
 * the failure it was reaching for. The same distinction keeps the walk out of `default`, `enum`
 * and `const`, whose contents are data, not schema.
 *
 * At module scope rather than inside `relaxTools`, so the closure is made once rather than per
 * call — which, on the path this is on, is per request.
 */
const strip = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(strip);
  if (!isObject(node)) return node;
  const out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "pattern" || key === "format") continue;
    if (SCHEMA_KEYS.has(key)) out[key] = Array.isArray(value) ? value.map(strip) : strip(value);
    else if (SCHEMA_MAPS.has(key) && isObject(value))
      // The keys here are argument names; only the values are schemas.
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, strip(sub)]));
    else out[key] = value;
  }
  return out;
};

/**
 * The retry shape: llama.cpp's converter rejects regex escape classes (`\d`, `\w`, `\s`) in
 * `pattern` and most `format` values, both of which only ever narrowed a string the tool
 * re-validates anyway.
 *
 * @param tools Already sanitised. Relaxing is the retry, not a substitute for `sanitizeTools`.
 */
export const relaxTools = (tools: OpenAI.ChatCompletionTool[]) =>
  through(relaxed, tools, (parameters) => {
    const stripped = strip(parameters);
    return isObject(stripped) ? stripped : EMPTY_OBJECT();
  });

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
 *
 * @param message The server's error text. Matched case-insensitively.
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
