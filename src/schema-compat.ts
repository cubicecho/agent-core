import type OpenAI from 'openai';
import { getOrCreate, isRecord } from './guards.ts';
import { FUNCTION_TOOL, SchemaType } from './wire.ts';

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
 * Cloud providers accept all of this, so step 2 never fires against them — with one edge worth
 * knowing about, which is that `nullable` is OpenAPI's spelling rather than JSON Schema's.
 * OpenAI's ordinary function tools ignore a keyword they do not know; `strict: true` structured
 * tool calling rejects one. A caller on that path wants its own schemas rather than these.
 */

type Schema = Record<string, unknown>;

/** Lookahead and lookbehind: `(?=`, `(?!`, `(?<=`, `(?<!`. */
const LOOKAROUND = /\(\?<?[=!]/;

const PRIMITIVES: ReadonlySet<string> = new Set(Object.values(SchemaType));
/**
 * An object schema with no properties: what a position that holds no usable schema becomes.
 *
 * @returns A new object on every call, so no two callers share one.
 */
const EMPTY_OBJECT = () => ({ type: SchemaType.Object, properties: {} });

/** Keys whose value is a schema, or a list of them — several are spelled both ways. */
const SCHEMA_KEYS = new Set([
  'items',
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'anyOf',
  'oneOf',
  'allOf',
  'prefixItems',
]);
/** Keys whose value is a name -> schema map. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

/** The two spellings of a schema's own pool of named definitions. */
const POOL_KEYS = ['definitions', '$defs'] as const;

/**
 * One keyword's value with `fn` applied wherever it holds a schema, and untouched where it holds
 * data — which is what keeps a walk out of `default`, `enum` and `const`.
 *
 * @param key - The keyword the value sits under, which is what says whether it holds schemas.
 * @param value - What the keyword holds. Not mutated.
 * @param fn - The rewrite for one schema position. Handed whatever is there, schema or not.
 * @returns A new array or map of what `fn` gave back, or `fn`'s answer for a single schema. For
 * any other keyword, and for a map keyword that holds no map, `value` itself.
 */
const mapChildren = (key: string, value: unknown, fn: (node: unknown) => unknown): unknown => {
  if (SCHEMA_KEYS.has(key)) {
    return Array.isArray(value) ? value.map((sub) => fn(sub)) : fn(value);
  }
  // The keys here are argument names; only the values are schemas.
  if (SCHEMA_MAPS.has(key) && isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, fn(sub)]));
  }
  return value;
};

/**
 * The names a schema's `required` lists, without whatever in it is not a name.
 *
 * @param node - The schema whose `required` is read.
 * @returns A new array, empty where `required` is missing or is not a list.
 */
const requiredOf = (node: Schema): string[] =>
  Array.isArray(node.required) ? node.required.filter((name): name is string => typeof name === 'string') : [];

/**
 * Coerces one schema position.
 *
 * @param node - Whatever sits where a schema belongs. Not mutated.
 * @returns A boolean schema as it is, and an object normalised into a new one. A bare primitive
 * type name becomes `{ type }`; `"object"`, any other string and anything else at all become an
 * object with no properties.
 *
 * @remarks
 * Malformed MCP output sometimes puts a bare type name where a whole schema belongs, which the
 * grammar converter reports as `Unrecognized schema: "object"`.
 */
function asSchema(node: unknown): unknown {
  if (typeof node === 'string') {
    return PRIMITIVES.has(node) && node !== SchemaType.Object ? { type: node } : EMPTY_OBJECT();
  }
  if (typeof node === 'boolean') {
    return node;
  }
  if (!isRecord(node)) {
    return EMPTY_OBJECT();
  }
  return normalize(node);
}

/**
 * Recursively rewrites the shapes llama.cpp's grammar converter cannot represent.
 *
 * @param node - The schema as written. Not mutated.
 * @returns A new schema, rewritten at every schema position under it. Where it holds a `$ref`,
 * the reference alone.
 */
function normalize(node: Schema): Schema {
  const built: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    // `type: ["string", "null"]` — the converter only accepts a single string type.
    if (key === 'type' && Array.isArray(value)) {
      const names = value.filter((item): item is string => typeof item === 'string');
      const concrete = names.filter((name) => name !== SchemaType.Null);
      if (names.includes(SchemaType.Null)) {
        built.nullable = true;
      }
      if (concrete.length === 1) {
        built.type = concrete[0];
      } else if (concrete.length > 1) {
        built.anyOf = concrete.map((name) => ({ type: name }));
      } else {
        built.type = SchemaType.Null;
      }
    } else {
      built[key] = mapChildren(key, value, asSchema);
    }
  }

  const out = collapseNullableUnion(built);

  // A grammar is context-free; lookaround is not expressible in one at all, so no converter
  // can accept it. Dropping it costs one advisory constraint on one string field.
  if (typeof out.pattern === 'string' && LOOKAROUND.test(out.pattern)) {
    delete out.pattern;
  }
  // `{"type": "object"}` with no properties produces invalid GBNF.
  if (out.type === SchemaType.Object && !isRecord(out.properties)) {
    out.properties = {};
  }
  // Strict validators reject any sibling of `$ref`, and draft-07 ignores them, so a reference
  // stands alone or not at all. This is not hypothetical tidying: collapsing `anyOf: [{$ref},
  // {type: "null"}]` — the shape a schema-generated server emits at every optional argument —
  // lands `nullable` right next to the `$ref` that survived. Whatever is dropped here was
  // already unreadable to a conforming consumer; optionality still lives in the parent's
  // `required`.
  if ('$ref' in out) {
    return { $ref: out.$ref };
  }

  return out;
}

/**
 * `{anyOf: [{type: "string"}, {type: "null"}]}` is how Pydantic-backed MCP servers spell an
 * optional field.
 *
 * @param node - The schema whose `anyOf` and `oneOf` are looked at. Not mutated.
 * @returns `node` itself unless a union is one real branch beside `null` ones. Then a copy without
 * that union, marked `nullable`, with the real branch's keywords laid over its own.
 *
 * @remarks
 * Optionality already lives in the parent's `required`, so keep the one real branch. A union with
 * two real branches is meaningful and is left alone.
 */
function collapseNullableUnion(node: Schema): Schema {
  let out = node;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = out[key];
    if (!Array.isArray(variants)) {
      continue;
    }
    const concrete = variants.filter((item) => !(isRecord(item) && item.type === SchemaType.Null));
    if (concrete.length !== 1 || concrete.length === variants.length) {
      continue;
    }

    const { [key]: _collapsed, ...rest } = out;
    out = { ...rest, nullable: true, ...(isRecord(concrete[0]) ? concrete[0] : {}) };
  }
  return out;
}

/** Combinators at the top level of a parameters schema; strict backends reject them outright. */
const TOP_LEVEL_COMBINATORS = ['allOf', 'anyOf', 'oneOf', 'enum', 'not'] as const;

/** `#/definitions/Args` or `#/$defs/Args` — a pointer into this schema's own definitions. */
const LOCAL_POINTER = /^#\/(definitions|\$defs)\/([^/]+)$/;

/**
 * The `definitions` and `$defs` that a local pointer in this schema resolves against.
 *
 * @param parameters - The root schema, which is where the pools live.
 * @returns A new object holding whichever of the two the root has as an object — the pools
 * themselves, not copies. Empty where it has neither.
 */
function poolsOf(parameters: Schema): Schema {
  const defs: Schema = {};
  for (const key of POOL_KEYS) {
    if (isRecord(parameters[key])) {
      defs[key] = parameters[key];
    }
  }
  return defs;
}

/**
 * Follows a chain of local references to the schema it arrives at, or `undefined` where it
 * arrives at none — a pointer into another document, one that comes back around to itself, or a
 * name the pools do not hold.
 *
 * @param node - The schema position to resolve, reference or not.
 * @param defs - The pools to resolve against, as `poolsOf` collects them from the root.
 * @returns The schema arrived at — the object itself, not a copy — or `undefined`, which is also
 * the answer where the chain ends on something that is not an object.
 *
 * @remarks
 * An object that is not a reference resolves to itself, so a caller can hand this a branch without
 * first asking which spelling it is.
 */
function resolveRef(node: unknown, defs: Schema): Schema | undefined {
  const seen = new Set<string>();
  let current = node;
  while (isRecord(current) && typeof current.$ref === 'string') {
    const pointer = current.$ref;
    const [, poolKey, name] = LOCAL_POINTER.exec(pointer) ?? [];
    if (!name || seen.has(pointer)) {
      return undefined;
    }
    seen.add(pointer);
    const pool = defs[poolKey];
    current = isRecord(pool) ? pool[name] : undefined;
  }
  return isRecord(current) ? current : undefined;
}

/**
 * Replaces a root-level `$ref` with what it points at.
 *
 * @param parameters - The root schema. Not mutated.
 * @returns `parameters` itself where its `$ref` is not a string. Otherwise a new object: what the
 * pointer lands on with the root's pools laid over it, or an object with no properties where it
 * lands nowhere.
 *
 * @remarks
 * Dropping the siblings of a `$ref` is right at a nested position and wrong at this one: the
 * siblings here are the `definitions` the pointer needs, so the reference is left dangling and
 * `properties` is then backfilled empty below. The tool goes out advertising no arguments at
 * all — which the model cannot detect and the server has no reason to refuse. A schema
 * generator emits this shape whenever the argument object is a named type.
 */
function inlineRootRef(parameters: Schema): Schema {
  if (typeof parameters.$ref !== 'string') {
    return parameters;
  }
  const defs = poolsOf(parameters);
  const resolved = resolveRef(parameters, defs);
  // A pointer that lands nowhere has nothing here to resolve against. An object with no
  // properties is at least honest about taking none.
  // The definitions travel with what it did land on: whatever that refers to still lives in them.
  return resolved ? { ...resolved, ...defs } : EMPTY_OBJECT();
}

/**
 * Folds a root `allOf` into the root itself.
 *
 * @param schema - The root schema. Not mutated.
 * @returns `schema` itself where `allOf` is not a list, or where neither it nor the root has a
 * property. Otherwise a copy holding the root's properties with each branch's laid over them and
 * every `required` name unioned — `allOf` still on it, for `sanitizeSchema` to delete.
 *
 * @remarks
 * It is the other way a generated schema spells "the arguments are this named type", and
 * deleting it outright below threw the arguments away while leaving the `required` that named
 * them. A branch is far more often a reference than an inline object — a named type is exactly
 * what a generator puts in `$defs` — so each is resolved against this schema's own pools first.
 * One that resolves nowhere is not something to guess at, and falls through to `pruneRequired`,
 * which at least keeps the result self-consistent.
 */
function mergeRootAllOf(schema: Schema): Schema {
  const branches = schema.allOf;
  if (!Array.isArray(branches)) {
    return schema;
  }

  const defs = poolsOf(schema);
  const properties: Schema = isRecord(schema.properties) ? { ...schema.properties } : {};
  const required = new Set(requiredOf(schema));
  for (const raw of branches) {
    const branch = resolveRef(raw, defs);
    if (!branch) {
      continue;
    }
    if (isRecord(branch.properties)) {
      Object.assign(properties, branch.properties);
    }
    for (const name of requiredOf(branch)) {
      required.add(name);
    }
  }

  if (!Object.keys(properties).length) {
    return schema;
  }
  return { ...schema, properties, ...(required.size ? { required: [...required] } : {}) };
}

/**
 * Folds a root `anyOf` or `oneOf` into the root itself.
 *
 * @param schema - The root schema. Not mutated.
 * @returns `schema` itself where no union's branches hold a property. Otherwise a copy holding the
 * root's properties with the branches' laid over them, and the root's `required` plus the names
 * every branch asks for — the union still on it, for `sanitizeSchema` to delete.
 *
 * @remarks
 * The third spelling of "the arguments are this named type", after `$ref` and `allOf`, and the
 * one still going out empty: a union of real object shapes has no `null` branch for
 * `collapseNullableUnion` to take apart, so it reached the delete below intact and every
 * argument went with it. Properties are unioned because a caller satisfies any one branch;
 * `required` keeps only the names every branch asks for, since one that a branch does without
 * is one the model has to be free to omit. The branches of a discriminated union arrive as
 * references rather than inline — Pydantic, zod-to-json-schema and the MCP TypeScript SDK all
 * emit the shapes into `$defs` and point at them from the root — so each is resolved against
 * this schema's own pools first. One that resolves nowhere still cannot vouch for a name, so its
 * presence alone empties `required`.
 */
function mergeRootUnion(schema: Schema): Schema {
  const defs = poolsOf(schema);
  let out = schema;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = out[key];
    if (!Array.isArray(branches)) {
      continue;
    }

    const properties: Schema = {};
    // `null` until a branch has been read, which is what tells "no branches yet" apart from
    // "the branches agreed on nothing".
    let shared: Set<string> | null = null;
    for (const raw of branches) {
      const previous: Set<string> | null = shared;
      const branch = resolveRef(raw, defs);
      if (!branch) {
        shared = new Set<string>();
        continue;
      }
      if (isRecord(branch.properties)) {
        Object.assign(properties, branch.properties);
      }
      const names = requiredOf(branch);
      shared = previous === null ? new Set(names) : new Set(names.filter((n) => previous.has(n)));
    }

    if (!Object.keys(properties).length) {
      continue;
    }
    out = {
      ...out,
      properties: { ...(isRecord(out.properties) ? out.properties : {}), ...properties },
      ...(shared?.size ? { required: [...new Set([...requiredOf(out), ...shared])] } : {}),
    };
  }
  return out;
}

/**
 * Every `$ref` string anywhere under a node, walked as arbitrary JSON rather than as a schema.
 *
 * @param node - Anything. A value that is neither an array nor an object holds no pointer.
 * @param into - Where the pointers go. Written to, which is how the walk hands them back.
 *
 * @remarks
 * The keyword-aware walk `strip` does is the wrong way round for this one. Missing a pointer
 * here means deleting a definition that something still refers to, which breaks the schema;
 * finding one that was really a string sitting in a `default` or an `enum` costs a definition
 * that outlives its last real reference. So this errs the cheap way and reads every position.
 */
function collectRefs(node: unknown, into: Set<string>) {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRefs(item, into);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      into.add(value);
    } else {
      collectRefs(value, into);
    }
  }
}

/**
 * Drops the `definitions` and `$defs` entries that nothing points at any more.
 *
 * @param schema - The root schema, pools and all. Not mutated.
 * @returns `schema` itself where it has no pool, or every definition is still reached. Otherwise a
 * copy whose pools hold only what is reached, and that lacks a pool nothing reaches into.
 *
 * @remarks
 * The rewrites above delete whole subtrees — a root combinator once its branches are folded in,
 * every sibling of a `$ref`, the branch of a union that was only ever `null` — and the pointers
 * go with them while the pools they named stay behind. On a real Gmail or filesystem schema
 * those pools are most of the parameter bytes, re-sent for every tool on every turn of every
 * run, describing shapes the request no longer mentions anywhere.
 *
 * Reachability rather than a single pass, because a definition that is still pointed at can
 * name another; a cycle among them terminates on the `has` check, whether or not anything
 * outside it still refers in.
 */
function pruneDefs(schema: Schema): Schema {
  const pools = POOL_KEYS.filter((key) => isRecord(schema[key]));
  if (!pools.length) {
    return schema;
  }

  const live: Record<string, Set<string>> = {};
  const visit = (node: unknown) => {
    const pointers = new Set<string>();
    collectRefs(node, pointers);
    for (const pointer of pointers) {
      const target = LOCAL_POINTER.exec(pointer);
      if (!target) {
        continue;
      }
      const [, poolKey, name] = target;
      const pool = schema[poolKey];
      if (!isRecord(pool) || !(name in pool)) {
        continue;
      }
      live[poolKey] ??= new Set<string>();
      const names = live[poolKey];
      if (names.has(name)) {
        continue;
      }
      names.add(name);
      visit(pool[name]);
    }
  };

  // The pools themselves are not roots: a definition is reached from the schema body, or by
  // another definition that was, or not at all.
  const body = { ...schema };
  for (const key of pools) {
    delete body[key];
  }
  visit(body);

  let pruned = schema;
  for (const key of pools) {
    const names = live[key];
    if (!names?.size) {
      const { [key]: _unreached, ...rest } = pruned;
      pruned = rest;
      continue;
    }
    const pool = schema[key] as Schema;
    if (names.size === Object.keys(pool).length) {
      continue;
    }
    const reached = Object.entries(pool).filter(([name]) => names.has(name));
    pruned = { ...pruned, [key]: Object.fromEntries(reached) };
  }
  return pruned;
}

/**
 * A required argument that is not in `properties` is one no caller can supply and no strict
 * validator will accept.
 *
 * @param schema - The schema whose `required` is checked against its own `properties`. Not mutated.
 * @returns `schema` itself where `required` is not a list. Otherwise a copy whose `required` names
 * only what `properties` holds, or that has no `required` where no name is left.
 *
 * @remarks
 * Anything the rewrites above removed, `required` may still name.
 */
function pruneRequired(schema: Schema): Schema {
  if (!Array.isArray(schema.required)) {
    return schema;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const kept = schema.required.filter((name) => typeof name === 'string' && name in properties);
  if (kept.length) {
    return { ...schema, required: kept };
  }
  const { required: _unmet, ...rest } = schema;
  return rest;
}

/**
 * One JSON Schema as a strict server will accept it, for a schema that is not a tool's parameters.
 *
 * @param schema - The schema as written. Never mutated. Its root is held to an object, as a tool's
 * parameters are, and anything that is not a schema at all comes back as an object with no
 * properties.
 * @returns A new object: `type: "object"` with a `properties` map, no combinator at the root, no
 * `required` name without a property, and no definition that nothing points at.
 *
 * @remarks
 * What `sanitizeTools` does to each tool, without the tool: a `response_format` schema goes through
 * the same grammar converter a tool's parameters do, and a caller holding only the schema had to
 * wrap it in a definition to get here. Nothing is remembered — the cache is keyed on a tool
 * definition's identity, and a bare schema has no object that stands for it across requests.
 */
export function sanitizeSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return EMPTY_OBJECT();
  }
  // A copy of its own, so what is deleted and set below is this function's and nobody else's.
  const out = { ...mergeRootUnion(mergeRootAllOf(normalize(inlineRootRef(schema)))) };
  for (const key of TOP_LEVEL_COMBINATORS) {
    delete out[key];
  }
  if (out.type !== SchemaType.Object) {
    out.type = SchemaType.Object;
  }
  if (!isRecord(out.properties)) {
    out.properties = {};
  }
  return pruneDefs(pruneRequired(out));
}

/**
 * Rewrites one tool's parameters, leaving a non-function tool alone.
 *
 * @param tool - The definition. Not mutated.
 * @param fn - The rewrite. Handed the parameters as they are, a missing one included.
 * @returns A new definition with what `fn` gave back as its parameters, or `tool` itself where it
 * is not a function tool.
 */
const mapTool = (tool: OpenAI.ChatCompletionTool, fn: (parameters: unknown) => Schema): OpenAI.ChatCompletionTool =>
  tool.type === FUNCTION_TOOL
    ? {
        ...tool,
        function: { ...tool.function, parameters: fn(tool.function.parameters) },
      }
    : tool;

/**
 * Both rewrites are cached against the tool object rather than recomputed.
 *
 * @remarks
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

/**
 * Looks one up, computing and remembering it on a miss.
 *
 * @param cache - The memory of one rewrite, keyed on a definition's identity. Gains an entry for
 * every tool it did not hold.
 * @param tools - The definitions to look up. Not mutated.
 * @param fn - The rewrite the cache remembers, run on a tool's parameters only on a miss.
 * @returns A new array in the order of `tools`, whose entries are the remembered definitions — the
 * same object each time the same tool is asked for.
 */
const through = (
  cache: WeakMap<OpenAI.ChatCompletionTool, OpenAI.ChatCompletionTool>,
  tools: OpenAI.ChatCompletionTool[],
  fn: (parameters: unknown) => Schema,
) => tools.map((tool) => getOrCreate(cache, tool, () => mapTool(tool, fn)));

/**
 * Tool definitions a strict server will accept, remembered per definition object.
 *
 * @param tools - The definitions as the pool hands them over. Never mutated — where a schema
 * changed, a new definition is returned in its place.
 * @returns A new array in the same order. Each entry is the definition remembered for its tool, so
 * the same object on every call; a tool that is not a function tool is its own entry.
 *
 * @remarks
 * The first call on a connection's tools does the work and every later one is a lookup, so
 * calling this per request costs nothing.
 */
export const sanitizeTools = (tools: OpenAI.ChatCompletionTool[]) => through(sanitized, tools, sanitizeSchema);

/**
 * Walked as a schema rather than as arbitrary JSON, because `pattern` and `format` are keyword
 * names and perfectly ordinary argument names at once.
 *
 * @param node - A schema position, or a list of them. Not mutated.
 * @returns A copy without the `pattern` and `format` keywords, here and at every schema position
 * below. A value that is neither an array nor an object comes back as it is.
 *
 * @remarks
 * Matching on the key alone deleted a *property* called `format` along with the keyword, leaving
 * the parent's `required` naming an argument that no longer existed — which every strict validator
 * rejects, so the retry produced the failure it was reaching for. The same distinction keeps the
 * walk out of `default`, `enum` and `const`, whose contents are data, not schema.
 */
const strip = (node: unknown): unknown => {
  if (Array.isArray(node)) {
    return node.map(strip);
  }
  if (!isRecord(node)) {
    return node;
  }
  const out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'pattern' || key === 'format') {
      continue;
    }
    out[key] = mapChildren(key, value, strip);
  }
  return out;
};

/**
 * One schema without its `pattern` and `format` keywords, for a schema that is not a tool's.
 *
 * @param schema - Already sanitised. Relaxing is the retry, not a substitute for `sanitizeSchema`.
 * Never mutated; anything that is not a schema comes back as an object with no properties.
 * @returns A new object, the keywords gone from every schema position in it.
 *
 * @remarks
 * The retry `relaxTools` makes, on a bare schema. Only the keywords go: a property that happens to
 * be called `format` is an argument name and stays.
 */
export function relaxSchema(schema: unknown): Record<string, unknown> {
  const stripped = strip(schema);
  return isRecord(stripped) ? stripped : EMPTY_OBJECT();
}

/**
 * The retry shape: llama.cpp's converter rejects regex escape classes (`\d`, `\w`, `\s`) in
 * `pattern` and most `format` values, both of which only ever narrowed a string the tool
 * re-validates anyway.
 *
 * @param tools - Already sanitised. Relaxing is the retry, not a substitute for `sanitizeTools`.
 * Never mutated.
 * @returns A new array in the same order. Each entry is the relaxed definition remembered for its
 * tool, so the same object on every call; a tool that is not a function tool is its own entry.
 */
export const relaxTools = (tools: OpenAI.ChatCompletionTool[]) => through(relaxed, tools, relaxSchema);

/**
 * Qwen chat templates raise this when the transcript has no user turn. Some servers wrap it
 * in the same "unable to generate parser" wording as a real schema failure, and stripping
 * keywords would not fix it.
 */
const NO_USER_QUERY = 'no user query found';

/**
 * Does this failure look like the server could not build a grammar from our tool schemas?
 *
 * @param message - The server's error text. Matched case-insensitively.
 * @returns `true` for a grammar or schema-conversion failure. `false` for anything else, and
 * always for a chat template's "no user query found", whatever it is wrapped in.
 *
 * @remarks
 * Every server words this differently — llama-server says "error parsing grammar", Lemonade
 * says "Failed to initialize samplers: failed to parse grammar", others surface the converter
 * by name. Since a grammar is only ever involved in constrained decoding, treat any mention of
 * one as ours; the retry is cheap and latches after a single request.
 */
export function isGrammarError(message: string): boolean {
  const text = message.toLowerCase();
  if (text.includes(NO_USER_QUERY)) {
    return false;
  }
  return (
    text.includes('grammar') ||
    text.includes('unrecognized schema') ||
    text.includes('json schema conversion failed') ||
    (text.includes('unable to generate parser') && text.includes('template'))
  );
}
