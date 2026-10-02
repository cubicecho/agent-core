import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { isGrammarError, relaxSchema, relaxTools, sanitizeSchema, sanitizeTools } from '../src/schema-compat.ts';
import { FUNCTION_TOOL, SchemaType } from '../src/wire.ts';

/** One function tool wrapping the parameters under test. */
const tool = (parameters?: OpenAI.FunctionParameters): OpenAI.ChatCompletionTool => ({
  type: FUNCTION_TOOL,
  function: { name: 'gmail__search', description: '', parameters },
});

const paramsOf = (tools: OpenAI.ChatCompletionTool[]) =>
  (tools[0] as { function: { parameters: Record<string, unknown> } }).function.parameters;

describe('sanitizeTools', () => {
  it('collapses a nullable union to its one real branch', () => {
    const out = paramsOf(
      sanitizeTools([
        tool({
          type: SchemaType.Object,
          properties: { after: { anyOf: [{ type: SchemaType.String }, { type: SchemaType.Null }] } },
        }),
      ]),
    );
    const properties = out.properties as Record<string, Record<string, unknown>>;
    expect(properties.after).toEqual({ nullable: true, type: SchemaType.String });
  });

  it('rewrites a list type and drops lookaround patterns', () => {
    const out = paramsOf(
      sanitizeTools([
        tool({
          type: SchemaType.Object,
          properties: {
            label: { type: [SchemaType.String, SchemaType.Null], pattern: '^(?!INBOX).+$' },
            count: { type: [SchemaType.String, SchemaType.Number] },
          },
        }),
      ]),
    );
    const properties = out.properties as Record<string, Record<string, unknown>>;
    expect(properties.label).toEqual({ nullable: true, type: SchemaType.String });
    expect(properties.count.anyOf).toEqual([{ type: SchemaType.String }, { type: SchemaType.Number }]);
  });

  it('repairs a bare type name where a schema belongs', () => {
    const out = paramsOf(
      sanitizeTools([
        tool({ type: SchemaType.Object, properties: { filter: SchemaType.Object, flag: SchemaType.Boolean } }),
      ]),
    );
    const properties = out.properties as Record<string, Record<string, unknown>>;
    expect(properties.filter).toEqual({ type: SchemaType.Object, properties: {} });
    expect(properties.flag).toEqual({ type: SchemaType.Boolean });
  });

  it('forces a usable object at the top level', () => {
    expect(paramsOf(sanitizeTools([tool(undefined)]))).toEqual({ type: SchemaType.Object, properties: {} });
    // Combinators at the root are rejected outright by strict backends.
    expect(paramsOf(sanitizeTools([tool({ allOf: [{ type: SchemaType.Object }], enum: ['a'] })]))).toEqual({
      type: SchemaType.Object,
      properties: {},
    });
  });

  it('leaves a reference standing alone, whatever it was wrapped in', () => {
    const out = paramsOf(
      sanitizeTools([
        tool({
          type: SchemaType.Object,
          properties: {
            // What a schema-generated server emits for an optional object argument. Collapsing the
            // union used to leave `nullable` beside the `$ref` that survived — a sibling this file
            // exists to remove, reintroduced two lines above the code that removes it.
            where: { anyOf: [{ $ref: '#/definitions/Filters' }, { type: SchemaType.Null }] },
            note: { $ref: '#/definitions/Note', description: 'ignored under draft-07', default: {} },
          },
          definitions: { Filters: { type: SchemaType.Object, properties: {} }, Note: { type: SchemaType.String } },
        }),
      ]),
    );
    const properties = out.properties as Record<string, Record<string, unknown>>;
    expect(properties.where).toEqual({ $ref: '#/definitions/Filters' });
    expect(properties.note).toEqual({ $ref: '#/definitions/Note' });
    // The targets are still there: the reference is narrowed, never severed.
    expect(Object.keys(out.definitions as object)).toEqual(['Filters', 'Note']);
  });

  it('a nullable union keeps the constraints of the branch that survives', () => {
    const out = paramsOf(
      sanitizeTools([
        tool({
          type: SchemaType.Object,
          properties: { name: { anyOf: [{ type: SchemaType.String, maxLength: 3 }, { type: SchemaType.Null }] } },
        }),
      ]),
    );
    const properties = out.properties as Record<string, Record<string, unknown>>;
    expect(properties.name).toEqual({ nullable: true, type: SchemaType.String, maxLength: 3 });
  });

  it('a union of two real branches is left as it was', () => {
    const anyOf = [{ type: SchemaType.String }, { type: SchemaType.Number }];
    const out = paramsOf(sanitizeTools([tool({ type: SchemaType.Object, properties: { a: { anyOf } } })]));
    expect((out.properties as Record<string, unknown>).a).toEqual({ anyOf });
  });

  it('a pattern a grammar can express is kept, and so are enums and descriptions', () => {
    const schema = {
      type: SchemaType.Object,
      properties: {
        hex: { type: SchemaType.String, pattern: '^#[0-9a-f]{6}$' },
        mode: { type: SchemaType.String, enum: ['a', 'b'], description: 'how' },
      },
      required: ['mode'],
    };
    expect(paramsOf(sanitizeTools([tool(schema)]))).toEqual(schema);
  });
});

describe('sanitizeTools on a root that is a reference or a combinator', () => {
  it('a root-level $ref is resolved rather than left dangling over no arguments', () => {
    const out = paramsOf(
      sanitizeTools([
        tool({
          $ref: '#/definitions/Args',
          definitions: {
            Args: { type: SchemaType.Object, properties: { query: { type: SchemaType.String } }, required: ['query'] },
          },
        }),
      ]),
    );

    expect(out.$ref).toBeUndefined();
    expect(out.properties).toEqual({ query: { type: SchemaType.String } });
    expect(out.required).toEqual(['query']);
  });

  it('a root $ref that resolves to nothing gives an honestly empty object', () => {
    for (const parameters of [
      { $ref: '#/definitions/Missing' },
      { $ref: 'https://example.com/schema.json' },
      { $ref: '#/definitions/Loop', definitions: { Loop: { $ref: '#/definitions/Loop' } } },
    ]) {
      expect(paramsOf(sanitizeTools([tool(parameters)]))).toEqual({ type: SchemaType.Object, properties: {} });
    }
  });

  it('a root allOf keeps its arguments instead of leaving required naming nothing', () => {
    const out = paramsOf(
      sanitizeTools([
        tool({
          allOf: [{ type: SchemaType.Object, properties: { a: { type: SchemaType.String } }, required: ['a'] }],
          properties: { b: { type: SchemaType.Number } },
        }),
      ]),
    );

    expect(out.allOf).toBeUndefined();
    expect(out.properties).toEqual({ a: { type: SchemaType.String }, b: { type: SchemaType.Number } });
    expect(out.required).toEqual(['a']);
  });

  it('required never names an argument the rewrites removed', () => {
    // A union of non-objects has no properties to fold in, so the combinator still goes and
    // `required` is left naming nothing.
    const out = paramsOf(
      sanitizeTools([tool({ type: SchemaType.Object, oneOf: [{ type: SchemaType.String }], required: ['z'] })]),
    );
    expect(out).toEqual({ type: SchemaType.Object, properties: {} });
  });

  it('a root union keeps its arguments, requiring only what every branch asks for', () => {
    const out = paramsOf(
      sanitizeTools([
        tool({
          anyOf: [
            {
              type: SchemaType.Object,
              properties: { a: { type: SchemaType.String }, id: { type: SchemaType.String } },
              required: ['a', 'id'],
            },
            {
              type: SchemaType.Object,
              properties: { b: { type: SchemaType.Number }, id: { type: SchemaType.String } },
              required: ['id'],
            },
          ],
        }),
      ]),
    );

    expect(out.anyOf).toBeUndefined();
    expect(out.properties).toEqual({
      a: { type: SchemaType.String },
      b: { type: SchemaType.Number },
      id: { type: SchemaType.String },
    });
    // `id` is asked for by both branches; `a` by only one, so the model must be free to omit it.
    expect(out.required).toEqual(['id']);
  });

  it('a single-branch root union is the named argument type, required and all', () => {
    const out = paramsOf(
      sanitizeTools([
        tool({ oneOf: [{ type: SchemaType.Object, properties: { a: { type: SchemaType.String } }, required: ['a'] }] }),
      ]),
    );
    expect(out).toEqual({ type: SchemaType.Object, properties: { a: { type: SchemaType.String } }, required: ['a'] });
  });

  it('a root union of references keeps the arguments its branches name', () => {
    // How a discriminated union actually arrives: the branches live in `$defs` and the root
    // points at them. Reading only inline branches left this advertising no arguments at all.
    const out = paramsOf(
      sanitizeTools([
        tool({
          type: SchemaType.Object,
          oneOf: [{ $ref: '#/$defs/ByPath' }, { $ref: '#/$defs/ByQuery' }],
          $defs: {
            ByPath: { type: SchemaType.Object, properties: { path: { type: SchemaType.String } }, required: ['path'] },
            ByQuery: {
              type: SchemaType.Object,
              properties: { query: { type: SchemaType.String } },
              required: ['query'],
            },
          },
        }),
      ]),
    );

    expect(out.properties).toEqual({ path: { type: SchemaType.String }, query: { type: SchemaType.String } });
    // Neither name is asked for by both branches, so the model must be free to omit either.
    expect(out.required).toBeUndefined();
  });

  it('a mixed root union reads the referenced half too', () => {
    const out = paramsOf(
      sanitizeTools([
        tool({
          anyOf: [
            { type: SchemaType.Object, properties: { a: { type: SchemaType.String } }, required: ['a', 'id'] },
            { $ref: '#/definitions/Other' },
          ],
          definitions: {
            Other: { type: SchemaType.Object, properties: { b: {} }, required: ['id'] },
          },
        }),
      ]),
    );

    expect(out.properties).toEqual({ a: { type: SchemaType.String }, b: {} });
    // `id` is asked for by both branches — but neither branch declares it as a property, so
    // `pruneRequired` takes it rather than leaving a name no caller can supply.
    expect(out.required).toBeUndefined();
  });

  it('a root allOf of references keeps the arguments its branches name', () => {
    // What Pydantic emits for a nested model: the type goes in `definitions` and `allOf` points
    // at it.
    const out = paramsOf(
      sanitizeTools([
        tool({
          allOf: [{ $ref: '#/definitions/Args' }],
          definitions: {
            Args: { type: SchemaType.Object, properties: { q: { type: SchemaType.String } }, required: ['q'] },
          },
        }),
      ]),
    );

    expect(out.properties).toEqual({ q: { type: SchemaType.String } });
    expect(out.required).toEqual(['q']);
  });

  it('a root union branch that resolves nowhere never claims a required name', () => {
    for (const branch of [
      { $ref: '#/definitions/Missing' },
      { $ref: 'https://example.com/schema.json' },
      { $ref: '#/definitions/Loop' },
    ]) {
      const out = paramsOf(
        sanitizeTools([
          tool({
            anyOf: [
              { type: SchemaType.Object, properties: { a: { type: SchemaType.String } }, required: ['a'] },
              branch,
            ],
            definitions: { Loop: { $ref: '#/definitions/Loop' } },
          }),
        ]),
      );

      expect(out.properties).toEqual({ a: { type: SchemaType.String } });
      expect(out.required).toBeUndefined();
    }
  });
});

describe('sanitizeTools on definitions', () => {
  it('definitions nothing points at any more do not go out', () => {
    // The union that referenced these is folded into `properties` and then deleted, so the
    // pointers are gone and the pools they named are pure token cost.
    const out = paramsOf(
      sanitizeTools([
        tool({
          type: SchemaType.Object,
          oneOf: [{ $ref: '#/$defs/ByPath' }, { $ref: '#/$defs/ByQuery' }],
          $defs: {
            ByPath: { type: SchemaType.Object, properties: { path: { type: SchemaType.String } } },
            ByQuery: { type: SchemaType.Object, properties: { query: { type: SchemaType.String } } },
          },
        }),
      ]),
    );

    expect(out.$defs).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('$defs/');
  });

  it('a definition a surviving reference reaches is kept, along with what it names', () => {
    const out = paramsOf(
      sanitizeTools([
        tool({
          type: SchemaType.Object,
          properties: { where: { $ref: '#/definitions/Filters' } },
          definitions: {
            Filters: { type: SchemaType.Object, properties: { by: { $ref: '#/definitions/Field' } } },
            Field: { type: SchemaType.String },
            Unused: { type: SchemaType.Object, properties: { x: { type: SchemaType.String } } },
          },
        }),
      ]),
    );

    // `Field` is reached only through `Filters`, which is why one pass is not enough.
    expect(Object.keys(out.definitions as object)).toEqual(['Filters', 'Field']);
  });

  it('a definition that only refers to itself goes with the rest', () => {
    const out = paramsOf(
      sanitizeTools([
        tool({
          type: SchemaType.Object,
          properties: { a: { type: SchemaType.String } },
          $defs: { Loop: { $ref: '#/$defs/Loop' } },
        }),
      ]),
    );

    expect(out.$defs).toBeUndefined();
  });
});

describe('relaxTools', () => {
  it('relaxing strips pattern and format at every depth', () => {
    const out = paramsOf(
      relaxTools([
        tool({
          type: SchemaType.Object,
          properties: {
            to: { type: SchemaType.Array, items: { type: SchemaType.String, format: 'email', pattern: '\\d+' } },
          },
        }),
      ]),
    );
    const items = (out.properties as Record<string, Record<string, unknown>>).to.items;
    expect(items).toEqual({ type: SchemaType.String });
  });

  it('relaxing keeps an argument that happens to be called format or pattern', () => {
    const out = paramsOf(
      relaxTools([
        tool({
          type: SchemaType.Object,
          properties: {
            format: { type: SchemaType.String, enum: ['json', 'csv'] },
            pattern: { type: SchemaType.String },
            keep: { type: SchemaType.String, format: 'email', pattern: '\\d+' },
          },
          required: ['format', 'pattern'],
        }),
      ]),
    );

    // The arguments survive; only the keywords on `keep` are stripped.
    expect(Object.keys(out.properties as object).sort()).toEqual(['format', 'keep', 'pattern']);
    expect((out.properties as Record<string, unknown>).keep).toEqual({ type: SchemaType.String });
    expect(out.required).toEqual(['format', 'pattern']);
  });

  it('relaxing does not reach into data that merely looks like schema', () => {
    const out = paramsOf(
      relaxTools([
        tool({
          type: SchemaType.Object,
          properties: {
            a: { type: SchemaType.String, default: { format: 'kept' }, enum: [{ pattern: 'x' }] },
          },
        }),
      ]),
    );
    expect((out.properties as Record<string, unknown>).a).toEqual({
      type: SchemaType.String,
      default: { format: 'kept' },
      enum: [{ pattern: 'x' }],
    });
  });
});

describe('sanitizeTools and relaxTools', () => {
  it('the same tool object is walked once, however often it is sent', () => {
    const declared = [
      tool({
        type: SchemaType.Object,
        properties: { q: { type: SchemaType.String, pattern: '^a', format: 'email' } },
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

  it('neither pass writes back into the tool it was given', () => {
    const parameters = {
      type: SchemaType.Object,
      properties: { q: { type: SchemaType.String, pattern: '^a' } },
    };
    const declared = [tool(parameters)];
    const before = JSON.stringify(parameters);
    relaxTools(sanitizeTools(declared));
    expect(JSON.stringify(parameters)).toBe(before);
  });
});

describe('sanitizeSchema and relaxSchema', () => {
  it("a bare schema is sanitised and relaxed exactly as a tool's parameters are", () => {
    const schema = {
      type: SchemaType.Object,
      properties: {
        when: { type: [SchemaType.String, SchemaType.Null], format: 'date-time', pattern: '^\\d{4}' },
        format: { anyOf: [{ type: SchemaType.String }, { type: SchemaType.Null }] },
      },
      required: ['when', 'gone'],
    };
    const before = JSON.stringify(schema);
    const sanitized = sanitizeSchema(schema);
    expect(sanitized).toEqual(paramsOf(sanitizeTools([tool(schema)])));
    expect(sanitized).toEqual({
      type: SchemaType.Object,
      properties: {
        when: { type: SchemaType.String, nullable: true, format: 'date-time', pattern: '^\\d{4}' },
        format: { nullable: true, type: SchemaType.String },
      },
      required: ['when'],
    });

    const relaxed = relaxSchema(sanitized);
    expect(relaxed).toEqual(paramsOf(relaxTools(sanitizeTools([tool(schema)]))));
    // The keywords go; the argument that happens to be called `format` stays.
    expect(relaxed.properties).toEqual({
      when: { type: SchemaType.String, nullable: true },
      format: { nullable: true, type: SchemaType.String },
    });
    expect(JSON.stringify(schema)).toBe(before);
  });

  it('what is not a schema at all comes back as an object taking nothing', () => {
    expect(sanitizeSchema(undefined)).toEqual({ type: SchemaType.Object, properties: {} });
    expect(sanitizeSchema(SchemaType.Object)).toEqual({ type: SchemaType.Object, properties: {} });
    expect(relaxSchema(null)).toEqual({ type: SchemaType.Object, properties: {} });
  });

  it('a bare schema is not remembered, so two calls give two objects', () => {
    const schema = { type: SchemaType.Object, properties: { q: { type: SchemaType.String } } };
    expect(sanitizeSchema(schema)).not.toBe(sanitizeSchema(schema));
  });
});

describe('isGrammarError', () => {
  it('recognises grammar failures but not a missing user turn', () => {
    expect(isGrammarError("error parsing grammar: expected '('")).toBe(true);
    expect(isGrammarError('Unrecognized schema: "object"')).toBe(true);
    expect(isGrammarError('Failed to initialize samplers: failed to parse grammar')).toBe(true);
    expect(isGrammarError('unable to generate parser from template: no user query found')).toBe(false);
    expect(isGrammarError('model not found')).toBe(false);
  });
});
