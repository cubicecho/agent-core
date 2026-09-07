import type OpenAI from "openai";
import { expect, test } from "vitest";
import { isGrammarError, relaxTools, sanitizeTools } from "../src/schema-compat.ts";

/** One function tool wrapping the parameters under test. */
const tool = (parameters: unknown): OpenAI.ChatCompletionTool => ({
  type: "function",
  function: { name: "gmail__search", description: "", parameters: parameters as never },
});

const paramsOf = (tools: OpenAI.ChatCompletionTool[]) =>
  (tools[0] as { function: { parameters: Record<string, unknown> } }).function.parameters;

test("collapses a nullable union to its one real branch", () => {
  const out = paramsOf(
    sanitizeTools([
      tool({
        type: "object",
        properties: { after: { anyOf: [{ type: "string" }, { type: "null" }] } },
      }),
    ]),
  );
  const properties = out.properties as Record<string, Record<string, unknown>>;
  expect(properties.after).toEqual({ nullable: true, type: "string" });
});

test("rewrites a list type and drops lookaround patterns", () => {
  const out = paramsOf(
    sanitizeTools([
      tool({
        type: "object",
        properties: {
          label: { type: ["string", "null"], pattern: "^(?!INBOX).+$" },
          count: { type: ["string", "number"] },
        },
      }),
    ]),
  );
  const properties = out.properties as Record<string, Record<string, unknown>>;
  expect(properties.label).toEqual({ nullable: true, type: "string" });
  expect(properties.count.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
});

test("repairs a bare type name where a schema belongs", () => {
  const out = paramsOf(
    sanitizeTools([tool({ type: "object", properties: { filter: "object", flag: "boolean" } })]),
  );
  const properties = out.properties as Record<string, Record<string, unknown>>;
  expect(properties.filter).toEqual({ type: "object", properties: {} });
  expect(properties.flag).toEqual({ type: "boolean" });
});

test("forces a usable object at the top level", () => {
  expect(paramsOf(sanitizeTools([tool(undefined)]))).toEqual({ type: "object", properties: {} });
  // Combinators at the root are rejected outright by strict backends.
  expect(paramsOf(sanitizeTools([tool({ allOf: [{ type: "object" }], enum: ["a"] })]))).toEqual({
    type: "object",
    properties: {},
  });
});

test("relaxing strips pattern and format at every depth", () => {
  const out = paramsOf(
    relaxTools([
      tool({
        type: "object",
        properties: {
          to: { type: "array", items: { type: "string", format: "email", pattern: "\\d+" } },
        },
      }),
    ]),
  );
  const items = (out.properties as Record<string, Record<string, unknown>>).to.items;
  expect(items).toEqual({ type: "string" });
});

test("recognises grammar failures but not a missing user turn", () => {
  expect(isGrammarError("error parsing grammar: expected '('")).toBe(true);
  expect(isGrammarError('Unrecognized schema: "object"')).toBe(true);
  expect(isGrammarError("Failed to initialize samplers: failed to parse grammar")).toBe(true);
  expect(isGrammarError("unable to generate parser from template: no user query found")).toBe(
    false,
  );
  expect(isGrammarError("model not found")).toBe(false);
});

test("leaves a reference standing alone, whatever it was wrapped in", () => {
  const out = paramsOf(
    sanitizeTools([
      tool({
        type: "object",
        properties: {
          // What a schema-generated server emits for an optional object argument. Collapsing the
          // union used to leave `nullable` beside the `$ref` that survived — a sibling this file
          // exists to remove, reintroduced two lines above the code that removes it.
          where: { anyOf: [{ $ref: "#/definitions/Filters" }, { type: "null" }] },
          note: { $ref: "#/definitions/Note", description: "ignored under draft-07", default: {} },
        },
        definitions: { Filters: { type: "object", properties: {} }, Note: { type: "string" } },
      }),
    ]),
  );
  const properties = out.properties as Record<string, Record<string, unknown>>;
  expect(properties.where).toEqual({ $ref: "#/definitions/Filters" });
  expect(properties.note).toEqual({ $ref: "#/definitions/Note" });
  // The targets are still there: the reference is narrowed, never severed.
  expect(Object.keys(out.definitions as object)).toEqual(["Filters", "Note"]);
});

test("a nullable union keeps the constraints of the branch that survives", () => {
  const out = paramsOf(
    sanitizeTools([
      tool({
        type: "object",
        properties: { name: { anyOf: [{ type: "string", maxLength: 3 }, { type: "null" }] } },
      }),
    ]),
  );
  const properties = out.properties as Record<string, Record<string, unknown>>;
  expect(properties.name).toEqual({ nullable: true, type: "string", maxLength: 3 });
});

test("a union of two real branches is left as it was", () => {
  const anyOf = [{ type: "string" }, { type: "number" }];
  const out = paramsOf(sanitizeTools([tool({ type: "object", properties: { a: { anyOf } } })]));
  expect((out.properties as Record<string, unknown>).a).toEqual({ anyOf });
});

test("a pattern a grammar can express is kept, and so are enums and descriptions", () => {
  const schema = {
    type: "object",
    properties: {
      hex: { type: "string", pattern: "^#[0-9a-f]{6}$" },
      mode: { type: "string", enum: ["a", "b"], description: "how" },
    },
    required: ["mode"],
  };
  expect(paramsOf(sanitizeTools([tool(schema)]))).toEqual(schema);
});

test("relaxing keeps an argument that happens to be called format or pattern", () => {
  const out = paramsOf(
    relaxTools([
      tool({
        type: "object",
        properties: {
          format: { type: "string", enum: ["json", "csv"] },
          pattern: { type: "string" },
          keep: { type: "string", format: "email", pattern: "\\d+" },
        },
        required: ["format", "pattern"],
      }),
    ]),
  );

  // The arguments survive; only the keywords on `keep` are stripped.
  expect(Object.keys(out.properties as object).sort()).toEqual(["format", "keep", "pattern"]);
  expect((out.properties as Record<string, unknown>).keep).toEqual({ type: "string" });
  expect(out.required).toEqual(["format", "pattern"]);
});

test("relaxing does not reach into data that merely looks like schema", () => {
  const out = paramsOf(
    relaxTools([
      tool({
        type: "object",
        properties: {
          a: { type: "string", default: { format: "kept" }, enum: [{ pattern: "x" }] },
        },
      }),
    ]),
  );
  expect((out.properties as Record<string, unknown>).a).toEqual({
    type: "string",
    default: { format: "kept" },
    enum: [{ pattern: "x" }],
  });
});

test("a root-level $ref is resolved rather than left dangling over no arguments", () => {
  const out = paramsOf(
    sanitizeTools([
      tool({
        $ref: "#/definitions/Args",
        definitions: {
          Args: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      }),
    ]),
  );

  expect(out.$ref).toBeUndefined();
  expect(out.properties).toEqual({ query: { type: "string" } });
  expect(out.required).toEqual(["query"]);
});

test("a root $ref that resolves to nothing gives an honestly empty object", () => {
  for (const parameters of [
    { $ref: "#/definitions/Missing" },
    { $ref: "https://example.com/schema.json" },
    { $ref: "#/definitions/Loop", definitions: { Loop: { $ref: "#/definitions/Loop" } } },
  ]) {
    expect(paramsOf(sanitizeTools([tool(parameters)]))).toEqual({ type: "object", properties: {} });
  }
});

test("a root allOf keeps its arguments instead of leaving required naming nothing", () => {
  const out = paramsOf(
    sanitizeTools([
      tool({
        allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }],
        properties: { b: { type: "number" } },
      }),
    ]),
  );

  expect(out.allOf).toBeUndefined();
  expect(out.properties).toEqual({ a: { type: "string" }, b: { type: "number" } });
  expect(out.required).toEqual(["a"]);
});

test("required never names an argument the rewrites removed", () => {
  // A union of non-objects has no properties to fold in, so the combinator still goes and
  // `required` is left naming nothing.
  const out = paramsOf(
    sanitizeTools([tool({ type: "object", oneOf: [{ type: "string" }], required: ["z"] })]),
  );
  expect(out).toEqual({ type: "object", properties: {} });
});

test("a root union keeps its arguments, requiring only what every branch asks for", () => {
  const out = paramsOf(
    sanitizeTools([
      tool({
        anyOf: [
          {
            type: "object",
            properties: { a: { type: "string" }, id: { type: "string" } },
            required: ["a", "id"],
          },
          {
            type: "object",
            properties: { b: { type: "number" }, id: { type: "string" } },
            required: ["id"],
          },
        ],
      }),
    ]),
  );

  expect(out.anyOf).toBeUndefined();
  expect(out.properties).toEqual({
    a: { type: "string" },
    b: { type: "number" },
    id: { type: "string" },
  });
  // `id` is asked for by both branches; `a` by only one, so the model must be free to omit it.
  expect(out.required).toEqual(["id"]);
});

test("a single-branch root union is the named argument type, required and all", () => {
  const out = paramsOf(
    sanitizeTools([
      tool({ oneOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }] }),
    ]),
  );
  expect(out).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
});

test("a root union of references keeps the arguments its branches name", () => {
  // How a discriminated union actually arrives: the branches live in `$defs` and the root
  // points at them. Reading only inline branches left this advertising no arguments at all.
  const out = paramsOf(
    sanitizeTools([
      tool({
        type: "object",
        oneOf: [{ $ref: "#/$defs/ByPath" }, { $ref: "#/$defs/ByQuery" }],
        $defs: {
          ByPath: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          ByQuery: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      }),
    ]),
  );

  expect(out.properties).toEqual({ path: { type: "string" }, query: { type: "string" } });
  // Neither name is asked for by both branches, so the model must be free to omit either.
  expect(out.required).toBeUndefined();
});

test("a mixed root union reads the referenced half too", () => {
  const out = paramsOf(
    sanitizeTools([
      tool({
        anyOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a", "id"] },
          { $ref: "#/definitions/Other" },
        ],
        definitions: {
          Other: { type: "object", properties: { b: {} }, required: ["id"] },
        },
      }),
    ]),
  );

  expect(out.properties).toEqual({ a: { type: "string" }, b: {} });
  // `id` is asked for by both branches — but neither branch declares it as a property, so
  // `pruneRequired` takes it rather than leaving a name no caller can supply.
  expect(out.required).toBeUndefined();
});

test("a root allOf of references keeps the arguments its branches name", () => {
  // What Pydantic emits for a nested model: the type goes in `definitions` and `allOf` points
  // at it.
  const out = paramsOf(
    sanitizeTools([
      tool({
        allOf: [{ $ref: "#/definitions/Args" }],
        definitions: {
          Args: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      }),
    ]),
  );

  expect(out.properties).toEqual({ q: { type: "string" } });
  expect(out.required).toEqual(["q"]);
});

test("a root union branch that resolves nowhere never claims a required name", () => {
  for (const branch of [
    { $ref: "#/definitions/Missing" },
    { $ref: "https://example.com/schema.json" },
    { $ref: "#/definitions/Loop" },
  ]) {
    const out = paramsOf(
      sanitizeTools([
        tool({
          anyOf: [
            { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
            branch,
          ],
          definitions: { Loop: { $ref: "#/definitions/Loop" } },
        }),
      ]),
    );

    expect(out.properties).toEqual({ a: { type: "string" } });
    expect(out.required).toBeUndefined();
  }
});

test("definitions nothing points at any more do not go out", () => {
  // The union that referenced these is folded into `properties` and then deleted, so the
  // pointers are gone and the pools they named are pure token cost.
  const out = paramsOf(
    sanitizeTools([
      tool({
        type: "object",
        oneOf: [{ $ref: "#/$defs/ByPath" }, { $ref: "#/$defs/ByQuery" }],
        $defs: {
          ByPath: { type: "object", properties: { path: { type: "string" } } },
          ByQuery: { type: "object", properties: { query: { type: "string" } } },
        },
      }),
    ]),
  );

  expect(out.$defs).toBeUndefined();
  expect(JSON.stringify(out)).not.toContain("$defs/");
});

test("a definition a surviving reference reaches is kept, along with what it names", () => {
  const out = paramsOf(
    sanitizeTools([
      tool({
        type: "object",
        properties: { where: { $ref: "#/definitions/Filters" } },
        definitions: {
          Filters: { type: "object", properties: { by: { $ref: "#/definitions/Field" } } },
          Field: { type: "string" },
          Unused: { type: "object", properties: { x: { type: "string" } } },
        },
      }),
    ]),
  );

  // `Field` is reached only through `Filters`, which is why one pass is not enough.
  expect(Object.keys(out.definitions as object)).toEqual(["Filters", "Field"]);
});

test("a definition that only refers to itself goes with the rest", () => {
  const out = paramsOf(
    sanitizeTools([
      tool({
        type: "object",
        properties: { a: { type: "string" } },
        $defs: { Loop: { $ref: "#/$defs/Loop" } },
      }),
    ]),
  );

  expect(out.$defs).toBeUndefined();
});

test("the same tool object is walked once, however often it is sent", () => {
  const declared = [
    tool({
      type: "object",
      properties: { q: { type: "string", pattern: "^a", format: "email" } },
    }),
  ];
  const sanitized = sanitizeTools(declared);
  expect(sanitizeTools(declared)[0]).toBe(sanitized[0]);

  // The path that matters: once `strictSchemas` latches off, this is what every request calls,
  // and its input is the stable output above rather than the caller's array.
  const relaxed = relaxTools(sanitized);
  expect(relaxTools(sanitized)[0]).toBe(relaxed[0]);
  expect(relaxed[0]).not.toBe(sanitized[0]);
});

test("neither pass writes back into the tool it was given", () => {
  const parameters = {
    type: "object",
    properties: { q: { type: "string", pattern: "^a" } },
  };
  const declared = [tool(parameters)];
  const before = JSON.stringify(parameters);
  relaxTools(sanitizeTools(declared));
  expect(JSON.stringify(parameters)).toBe(before);
});
