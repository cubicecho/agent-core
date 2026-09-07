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
