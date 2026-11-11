import { describe, expect, it } from 'vitest';
import { defineSpecColumns } from '../../src/spec/columns.ts';
import { AGENT_SPEC, type AgentSpec, parseSpec, resolveAgentSpec } from '../../src/spec/spec.ts';

/** One column per marker a host stores today, beside the same columns with none. */
interface Row {
  model: string;
  maxTokens: number;
  toolDiscovery: 'eager' | 'ondemand' | 'inherit';
  temperature: number | null;
}

const MARKED = defineSpecColumns<Row>({
  model: { path: 'model.model', inherit: '' },
  maxTokens: { path: 'model.maxTokens', inherit: -1 },
  toolDiscovery: { path: 'tools.discovery', inherit: 'inherit' },
  temperature: { path: 'model.temperature', inherit: null },
});

/** The parsed spec, insisting the document survived so a test never asserts against null. */
function parsed(document: unknown): AgentSpec {
  const result = parseSpec(document);
  expect(result.errors).toEqual([]);
  if (!result.spec) {
    throw new Error('unreachable');
  }
  return result.spec;
}

describe('defineSpecColumns', () => {
  // Each marker against the values a column holds that are easiest to mistake for it.
  it.each([
    { column: 'model', stored: '', said: undefined },
    { column: 'model', stored: ' ', said: ' ' },
    { column: 'model', stored: 'qwen', said: 'qwen' },
    { column: 'maxTokens', stored: -1, said: undefined },
    { column: 'maxTokens', stored: 0, said: 0 },
    { column: 'maxTokens', stored: 512, said: 512 },
    { column: 'toolDiscovery', stored: 'inherit', said: undefined },
    { column: 'toolDiscovery', stored: 'eager', said: 'eager' },
    { column: 'temperature', stored: null, said: undefined },
    { column: 'temperature', stored: 0, said: 0 },
    { column: 'temperature', stored: undefined, said: undefined },
  ] as const)(
    '$column at $stored is a field of $said, and reads back as the column held it',
    ({ column, stored, said }) => {
      const layer = MARKED.toLayer({ [column]: stored });
      const field = column === 'toolDiscovery' ? layer.tools?.discovery : layer.model?.[column];
      expect(field).toBe(said);
      expect(MARKED.fromLayer(layer)[column]).toBe(stored ?? null);
    },
  );

  it('leaves out a section nothing was said in, so an all-inherit row is an empty layer', () => {
    expect(MARKED.toLayer({ model: '', maxTokens: -1, toolDiscovery: 'inherit', temperature: null })).toEqual({
      spec: AGENT_SPEC,
    });
  });

  it('reads an empty layer back as every column at its marker', () => {
    expect(MARKED.fromLayer({ spec: AGENT_SPEC })).toEqual({
      model: '',
      maxTokens: -1,
      toolDiscovery: 'inherit',
      temperature: null,
    });
  });

  it('round-trips a row through a parsed layer unchanged', () => {
    const rows: Row[] = [
      { model: 'qwen', maxTokens: 0, toolDiscovery: 'ondemand', temperature: 0 },
      { model: '', maxTokens: 4096, toolDiscovery: 'inherit', temperature: null },
      { model: '', maxTokens: -1, toolDiscovery: 'inherit', temperature: null },
    ];
    for (const row of rows) {
      expect(MARKED.fromLayer(parsed(MARKED.toLayer(row)))).toEqual(row);
    }
  });

  it('round-trips the fields a table maps through a row unchanged', () => {
    const layer = parsed({ spec: AGENT_SPEC, model: { model: 'qwen', maxTokens: 0 }, tools: { discovery: 'eager' } });
    expect(MARKED.toLayer(MARKED.fromLayer(layer))).toEqual(layer);
  });

  it('says every value of a column with no marker, an empty one included', () => {
    const settings = defineSpecColumns<{ toolSelectModel: string; maxRetries: number }>({
      toolSelectModel: { path: 'tasks.toolSelect.model' },
      maxRetries: { path: 'retry.maxRetries' },
    });
    expect(settings.toLayer({ toolSelectModel: '', maxRetries: -1 })).toEqual({
      spec: AGENT_SPEC,
      tasks: { toolSelect: { model: '' } },
      retry: { maxRetries: -1 },
    });
    // With nothing to read an absent field back as, the column is left out rather than invented.
    expect(settings.fromLayer({ spec: AGENT_SPEC, retry: { maxRetries: 2 } })).toEqual({ maxRetries: 2 });
  });

  it('converts a column that stores something other than its field, both ways', () => {
    const telos = defineSpecColumns<{ toolDiscovery: boolean | null }>({
      toolDiscovery: {
        path: 'tools.discovery',
        inherit: null,
        toSpec: (on) => (on ? 'ondemand' : 'eager'),
        fromSpec: (mode) => (mode === 'ondemand' ? true : mode === 'eager' ? false : undefined),
      },
    });
    expect(telos.toLayer({ toolDiscovery: false }).tools).toEqual({ discovery: 'eager' });
    expect(telos.toLayer({ toolDiscovery: null })).toEqual({ spec: AGENT_SPEC });
    expect(telos.fromLayer({ spec: AGENT_SPEC, tools: { discovery: 'ondemand' } })).toEqual({ toolDiscovery: true });
    // A mode the switch cannot hold is the marker on the way in, and reported as the column's.
    const proxy: AgentSpec = { spec: AGENT_SPEC, tools: { discovery: 'proxy' } };
    expect(telos.fromLayer(proxy)).toEqual({ toolDiscovery: null });
    expect(telos.dropped(proxy)).toEqual([{ path: 'tools.discovery', value: 'proxy', column: 'toolDiscovery' }]);
  });

  it('lets a conversion say nothing, which is how a marker that is a range is spelled', () => {
    const table = defineSpecColumns<{ model: string; maxTokens: number }>({
      model: { path: 'model.model', inherit: '', toSpec: (value) => value.trim() || undefined },
      maxTokens: { path: 'model.maxTokens', inherit: -1, toSpec: (value) => (value < 0 ? undefined : value) },
    });
    expect(table.toLayer({ model: '  ', maxTokens: -5 })).toEqual({ spec: AGENT_SPEC });
    expect(table.toLayer({ model: ' qwen ', maxTokens: 0 }).model).toEqual({ model: 'qwen', maxTokens: 0 });
  });

  it("writes task-server's profile layer as its hand-written projection does", () => {
    const EXTENSION = 'com.cubicecho.task-server';
    const text = (value: string) => value.trim() || undefined;
    const number = (value: number) => (value < 0 ? undefined : value);
    const profile = defineSpecColumns<{
      baseUrl: string;
      model: string;
      maxTokens: number;
      systemPrompt: string;
      toolDiscovery: 'eager' | 'ondemand' | 'inherit';
      compactionModel: string;
      toolSelectModel: string;
      toolExecution: 'sequential' | 'parallel' | 'inherit';
      maxRetries: number;
    }>({
      baseUrl: { path: 'endpoint.baseUrl', inherit: '', toSpec: text },
      model: { path: 'model.model', inherit: '', toSpec: text },
      maxTokens: { path: 'model.maxTokens', inherit: -1, toSpec: number },
      systemPrompt: { path: 'prompt.system', inherit: '', toSpec: text },
      toolDiscovery: { path: 'tools.discovery', inherit: 'inherit' },
      compactionModel: { path: 'tasks.compaction.model', inherit: '', toSpec: text },
      toolSelectModel: { path: 'tasks.toolSelect.model', inherit: '', toSpec: text },
      toolExecution: { path: ['extensions', EXTENSION, 'toolExecution'], inherit: 'inherit' },
      maxRetries: { path: 'retry.maxRetries', inherit: -1, toSpec: number },
    });
    const layer = profile.toLayer({
      baseUrl: '',
      model: 'qwen',
      maxTokens: -1,
      systemPrompt: 'Be brief.',
      toolDiscovery: 'inherit',
      compactionModel: 'small',
      toolSelectModel: '',
      toolExecution: 'parallel',
      maxRetries: 0,
    });
    expect(layer).toEqual({
      spec: AGENT_SPEC,
      model: { model: 'qwen' },
      prompt: [{ id: 'system', text: 'Be brief.' }],
      tasks: { compaction: { model: 'small' } },
      extensions: { [EXTENSION]: { toolExecution: 'parallel' } },
      retry: { maxRetries: 0 },
    });
    // The extension survives the parser, which is why the column is there rather than under `tools`.
    expect(profile.fromLayer(parsed(layer))).toMatchObject({ toolExecution: 'parallel', systemPrompt: 'Be brief.' });

    const settings: AgentSpec = {
      spec: AGENT_SPEC,
      endpoint: { baseUrl: 'http://gpu:8080/v1' },
      model: { model: 'big' },
    };
    const resolved = resolveAgentSpec([settings, layer]);
    expect([resolved.baseUrl, resolved.model, resolved.systemPrompt]).toEqual([
      'http://gpu:8080/v1',
      'qwen',
      'Be brief.',
    ]);
  });

  it("writes min-agent's extension as one column holding an object", () => {
    const EXTENSION = 'com.cubicecho.min-agent';
    const table = defineSpecColumns<{ pricing: { inputPer1M: number }; speakReplies: boolean }>({
      pricing: { path: ['extensions', EXTENSION, 'pricing'] },
      speakReplies: { path: ['extensions', EXTENSION, 'speakReplies'] },
    });
    const layer = table.toLayer({ pricing: { inputPer1M: 0.5 }, speakReplies: false });
    expect(layer.extensions).toEqual({ [EXTENSION]: { pricing: { inputPer1M: 0.5 }, speakReplies: false } });
    expect(table.dropped(layer)).toEqual([]);
  });

  describe('dropped', () => {
    it('reports every field with no column, in the order the document has them', () => {
      const spec = parsed({
        spec: AGENT_SPEC,
        $schema: 'https://example.com/agent.json',
        id: 'reviewer',
        model: { model: 'qwen', reasoningEffort: 'high', extraBody: { top_k: 20, min_p: 0.05 } },
        retry: { loadingTimeoutSeconds: 30 },
        tasks: { title: { model: 'tiny', maxTokens: 64 } },
        hooks: [{ id: 'recall', on: 'beforeTurn', server: 'memory', tool: 'recall' }],
      });
      expect(MARKED.dropped(spec)).toEqual([
        { path: '$schema', value: 'https://example.com/agent.json' },
        { path: 'id', value: 'reviewer' },
        { path: 'model.reasoningEffort', value: 'high' },
        // A record nothing is mapped in is one loss, not one per key.
        { path: 'model.extraBody', value: { top_k: 20, min_p: 0.05 } },
        { path: 'retry.loadingTimeoutSeconds', value: 30 },
        { path: 'tasks.title', value: { model: 'tiny', maxTokens: 64 } },
        { path: 'hooks[0]', value: spec.hooks?.[0] },
      ]);
    });

    it('is empty for a layer the table wrote, and never reports the spec token', () => {
      const layer = MARKED.toLayer({ model: 'qwen', maxTokens: 0, toolDiscovery: 'eager', temperature: 0.2 });
      expect(MARKED.dropped(layer)).toEqual([]);
      expect(MARKED.dropped({ spec: AGENT_SPEC })).toEqual([]);
    });

    it('walks into a task or an extension only as far as a column is mapped in it', () => {
      const EXTENSION = 'com.example.host';
      const table = defineSpecColumns<{ compactionModel: string; execution: string }>({
        compactionModel: { path: 'tasks.compaction.model', inherit: '' },
        execution: { path: ['extensions', EXTENSION, 'execution'], inherit: '' },
      });
      const spec: AgentSpec = {
        spec: AGENT_SPEC,
        tasks: { compaction: { model: 'small', temperature: 0 }, followups: { model: 'tiny' } },
        extensions: { [EXTENSION]: { execution: 'parallel', colour: 'blue' }, 'org.other': { x: 1 } },
      };
      expect(table.dropped(spec).map((drop) => drop.path)).toEqual([
        'tasks.compaction.temperature',
        'tasks.followups',
        `extensions.${EXTENSION}.colour`,
        'extensions.org.other',
      ]);
    });

    it('takes a prompt part by its id, and reports the others and any reference', () => {
      const table = defineSpecColumns<{ systemPrompt: string }>({
        systemPrompt: { path: 'prompt.system', inherit: '' },
      });
      const spec: AgentSpec = {
        spec: AGENT_SPEC,
        prompt: [
          { id: 'project', text: 'Monorepo.' },
          { id: 'system', text: 'Be brief.', ref: { type: 'file', value: 'system.md' } },
        ],
      };
      expect(table.fromLayer(spec)).toEqual({ systemPrompt: 'Be brief.' });
      expect(table.dropped(spec)).toEqual([
        { path: 'prompt[0]', value: { id: 'project', text: 'Monorepo.' } },
        { path: 'prompt[1].ref', value: { type: 'file', value: 'system.md' } },
      ]);
    });

    it('reports a value a column refused against that column', () => {
      const table = defineSpecColumns<{ maxTokens: number }>({
        maxTokens: {
          path: 'model.maxTokens',
          inherit: -1,
          fromSpec: (value) => (Number.isInteger(value) ? (value as number) : undefined),
        },
      });
      const spec: AgentSpec = { spec: AGENT_SPEC, model: { maxTokens: 1.5 } };
      expect(table.fromLayer(spec)).toEqual({ maxTokens: -1 });
      expect(table.dropped(spec)).toEqual([{ path: 'model.maxTokens', value: 1.5, column: 'maxTokens' }]);
    });

    it('leaves alone what the host says it reads by hand', () => {
      const table = defineSpecColumns<Row>(
        { model: { path: 'model.model', inherit: '' } },
        { handled: ['bundle', 'hooks', 'tools.servers', ['extensions', 'com.example.host']] },
      );
      const spec = parsed({
        spec: AGENT_SPEC,
        tools: { servers: ['memory'], maxIterations: 4 },
        hooks: [{ id: 'recall', on: 'beforeTurn', server: 'memory', tool: 'recall' }],
        extensions: { 'com.example.host': { anything: true } },
      });
      expect(table.dropped(spec)).toEqual([{ path: 'tools.maxIterations', value: 4 }]);
    });

    it('reports a key from a later version of the format, which the parser carried through', () => {
      const spec = parsed({ spec: AGENT_SPEC, memory: { scope: 'task' } });
      expect(MARKED.dropped(spec)).toEqual([{ path: 'memory', value: { scope: 'task' } }]);
    });
  });

  it('refuses a table in which two columns write one field', () => {
    expect(() =>
      defineSpecColumns<{ a: string; b: string }>({ a: { path: 'model.model' }, b: { path: 'model.model' } }),
    ).toThrow('a and b write the same field');
    expect(() =>
      defineSpecColumns<{ a: unknown; b: string }>({
        a: { path: ['extensions', 'com.example.host'] },
        b: { path: ['extensions', 'com.example.host', 'b'] },
      }),
    ).toThrow('a and b write the same field');
    expect(() => defineSpecColumns<{ a: string }>({ a: { path: 'tasks..model' } })).toThrow('empty segment');
  });

  it('does not typecheck a column the row lacks, a marker of the wrong type, or a field the format lacks', () => {
    defineSpecColumns<Row>({
      // @ts-expect-error — a column the row does not have
      modle: { path: 'model.model' },
    });
    defineSpecColumns<Row>({
      // @ts-expect-error — a number column cannot store a string marker
      maxTokens: { path: 'model.maxTokens', inherit: '' },
    });
    defineSpecColumns<Row>({
      // @ts-expect-error — a path the format has no field at
      model: { path: 'model.name' },
    });
    defineSpecColumns<Row>({
      // @ts-expect-error — a task field the format does not have
      model: { path: 'tasks.compaction.modle' },
    });
  });
});
