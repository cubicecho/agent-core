import { describe, expect, it } from 'vitest';
import type { CatalogServer } from '../src/catalog.ts';
import {
  CALL_TOOL,
  carryOver,
  catalogPrompt,
  expandNames,
  holdsDefinitions,
  inCatalog,
  LOAD_TOOLS,
  loadedTools,
  loadResult,
  MAX_CARRIED,
  MAX_PER_LOAD,
  orderTools,
  PROXY_TOOLS,
  proxiedCall,
  proxyCatalogPrompt,
  proxyLoadResult,
  requestedNames,
  shownCall,
} from '../src/tool-loading.ts';
import { FUNCTION_TOOL, SchemaType } from '../src/wire.ts';
import { catalog, catalogTool } from './helpers.ts';

describe('expandNames and loadResult', () => {
  it('matches exact names and unambiguous bare ones', () => {
    const resolved = expandNames(['gmail__send_email', 'list_labels'], catalog);
    expect(resolved.matched.sort()).toEqual(['gmail__list_labels', 'gmail__send_email']);
    expect(resolved.unknown).toEqual([]);
  });

  it('a bare name matching two servers is not guessed at', () => {
    const ambiguous: CatalogServer[] = [
      { id: '1', label: 'A', tools: [catalogTool('a__read_file')] },
      { id: '2', label: 'B', tools: [catalogTool('b__read_file')] },
    ];
    expect(expandNames(['read_file'], ambiguous)).toMatchObject({
      matched: [],
      unknown: ['read_file'],
    });
  });

  it('a wildcard expands, by prefix or by suffix', () => {
    expect(expandNames(['gmail__*'], catalog).matched).toHaveLength(3);
    // The model dropped the server prefix; `__gmail` still finds the group.
    expect(expandNames(['files__read*'], catalog).matched).toEqual(['files__read_file']);
  });

  it('an over-broad wildcard is refused with its hits listed', () => {
    const many: CatalogServer[] = [
      {
        id: '1',
        label: 'Gmail',
        tools: Array.from({ length: MAX_PER_LOAD + 1 }, (_, i) => catalogTool(`gmail__tool_${i}`)),
      },
    ];
    const resolved = expandNames(['gmail__*'], many);
    expect(resolved.matched).toEqual([]);
    expect(resolved.overBroad[0].hits).toHaveLength(MAX_PER_LOAD + 1);

    const report = loadResult(resolved, many);
    expect(report).toMatch(new RegExp(`more than the ${MAX_PER_LOAD}`));
    expect(report).toContain('gmail__tool_0');
  });

  it('loading reports the descriptions the catalogue withheld', () => {
    const resolved = expandNames(['gmail__send_email', 'nope'], catalog);
    const report = loadResult(resolved, catalog);
    expect(report).toContain('gmail__send_email: does gmail__send_email');
    expect(report).toContain('Not in the catalogue: nope');
    expect(loadResult(expandNames([], catalog), catalog)).toBe('No tool names were given.');
  });

  it('loading a tool already loaded says so instead of loading it again', () => {
    const resolved = expandNames(['gmail__send_email', 'files__read_file'], catalog);
    const report = loadResult(resolved, catalog, new Set(['gmail__send_email']));
    expect(report).toContain('Loaded 1 tool(s)');
    expect(report).toContain('files__read_file: does files__read_file');
    expect(report).not.toContain('gmail__send_email: does');
    expect(report).toContain('Already loaded and in your tool list: gmail__send_email');
    expect(loadResult(resolved, catalog)).toContain('Loaded 2 tool(s)');
  });

  it('a name that matches nothing is reported, and a match is never counted twice', () => {
    const { matched, unknown } = expandNames(['gmail__send_email', 'gmail__*', 'nope'], catalog);
    expect(matched).toHaveLength(3);
    expect(unknown).toEqual(['nope']);
  });

  it('loading says which names it could not place', () => {
    expect(
      loadResult({ matched: [], unknown: ['nope'], overBroad: [], deferred: [], maxPerLoad: MAX_PER_LOAD }, catalog),
    ).toContain('Not in the catalogue: nope');
  });

  it('an over-broad wildcard comes back with the names it would have loaded', () => {
    const wide: CatalogServer[] = [
      {
        id: '3',
        label: 'Mail',
        tools: Array.from({ length: MAX_PER_LOAD + 5 }, (_, i) => catalogTool(`mail__tool_${i}`)),
      },
    ];
    const text = loadResult(expandNames(['mail__*'], wide), wide);
    expect(text).toContain(`more than the ${MAX_PER_LOAD} one call may load`);
    expect(text).toContain('mail__tool_3');
  });

  it('the load cap is what one call may load, not what one name may match', () => {
    const dozen = (prefix: string) => Array.from({ length: MAX_PER_LOAD }, (_, i) => catalogTool(`${prefix}__t${i}`));
    const wide: CatalogServer[] = [
      { id: '1', label: 'A', tools: dozen('a') },
      { id: '2', label: 'B', tools: dozen('b') },
      { id: '3', label: 'C', tools: dozen('c') },
    ];

    const resolved = expandNames(['a__*', 'b__*', 'c__*'], wide);
    expect(resolved.matched).toHaveLength(MAX_PER_LOAD);
    // A dozen apiece is exactly what one call may hold, so neither is too broad to ask for —
    // they just cannot have this call. The budget is still what stops them.
    expect(resolved.deferred).toEqual(['b__*', 'c__*']);
    expect(resolved.overBroad).toEqual([]);
    expect(loadResult(resolved, wide)).toContain('Ask for them on your next step');
  });

  it('a precise name that only misses the budget is not called over-broad', () => {
    const wide: CatalogServer[] = [
      {
        id: '4',
        label: 'Many',
        tools: Array.from({ length: MAX_PER_LOAD + 1 }, (_, i) => catalogTool(`many__t${i}`)),
      },
    ];
    const asked = wide[0].tools.map((t) => t.name);
    const resolved = expandNames(asked, wide);

    expect(resolved.matched).toHaveLength(MAX_PER_LOAD);
    expect(resolved.deferred).toEqual([`many__t${MAX_PER_LOAD}`]);
    expect(resolved.overBroad).toEqual([]);

    // The old message told it this one exact name matched one tool, "more than the twelve one
    // call may load", and to pick from a list holding only that name — nothing it could act on
    // but sending the same call again.
    const text = loadResult(resolved, wide);
    expect(text).not.toContain('Name the ones you need from:');
    expect(text).toContain(`This call is full at ${MAX_PER_LOAD} tools`);
    expect(text).toContain(`many__t${MAX_PER_LOAD}`);
  });

  it('a name that only repeats an earlier match does not spend budget', () => {
    const resolved = expandNames(['gmail__send_email', 'send_email', 'gmail__*'], catalog);
    expect(resolved.matched.sort()).toEqual(['gmail__list_labels', 'gmail__read_email', 'gmail__send_email']);
    expect(resolved.overBroad).toEqual([]);
  });

  it('a bare wildcard is answered with the names rather than the whole catalogue', () => {
    const resolved = expandNames(['*'], catalog);
    expect(resolved.matched).toEqual([]);
    expect(resolved.overBroad).toHaveLength(1);
    expect(resolved.overBroad[0].hits).toHaveLength(5);
    expect(loadResult(resolved, catalog)).toContain('Name the ones you need from:');
  });

  it("a caller's own cap is what the resolution is held to and what it reports", () => {
    const resolved = expandNames(['gmail__*'], catalog, 2);
    expect(resolved.matched).toEqual([]);
    expect(resolved.overBroad[0].name).toBe('gmail__*');
    expect(resolved.maxPerLoad).toBe(2);
    // Carried on the resolution rather than read again from the module, so the number the model is
    // told about is the number it was actually held to.
    expect(loadResult(resolved, catalog)).toContain('more than the 2 one call may load');
  });

  it("a caller's own cap defers what does not fit it", () => {
    const resolved = expandNames(['gmail__send_email', 'files__read_file'], catalog, 1);
    expect(resolved.matched).toEqual(['gmail__send_email']);
    expect(resolved.deferred).toEqual(['files__read_file']);
    expect(loadResult(resolved, catalog)).toContain('This call is full at 1 tools');
  });
});

describe('catalogPrompt', () => {
  it('the catalogue lists names only, marking what is already loaded', () => {
    const prompt = catalogPrompt(catalog, new Set(['gmail__send_email']));
    expect(prompt).toContain('Gmail:');
    expect(prompt).toContain('  gmail__send_email (loaded)');
    expect(prompt).toContain('  gmail__read_email');
    // Descriptions are the expensive half; they arrive on load, not here.
    expect(prompt).not.toContain('does gmail__read_email');
    expect(catalogPrompt([])).toBe('');
  });

  it('the catalogue marks nothing unless asked, so it reads the same after a load', () => {
    expect(catalogPrompt(catalog)).not.toContain('(loaded)');
    expect(catalogPrompt(catalog)).toBe(catalogPrompt(catalog));
  });

  it('an empty catalogue produces no prompt at all', () => {
    // Not a heading with nothing under it: a run with no servers must not be told about a
    // mechanism it has nothing to use it on.
    expect(catalogPrompt([])).toBe('');
  });

  it('a server with no tools is not given a heading with nothing under it', () => {
    const empty: CatalogServer[] = [{ id: '1', label: 'Gmail', tools: [] }];
    expect(catalogPrompt(empty)).toBe('');

    const mixed: CatalogServer[] = [{ id: '1', label: 'Gmail', tools: [] }, ...catalog];
    const prompt = catalogPrompt(mixed);
    expect(prompt).not.toContain('Gmail:\n\n');
    expect(prompt).toContain('Files:');
    // The one Gmail heading present is the real server's, not the empty one's.
    expect(prompt.match(/^Gmail:$/gm)).toHaveLength(1);
  });
});

describe('loadedTools', () => {
  it('loaded definitions are appended in load order, never moved', () => {
    const definition = (name: string) => ({
      type: FUNCTION_TOOL,
      function: { name, parameters: { type: SchemaType.Object } },
    });
    const [a, b, c] = [definition('a'), definition('b'), definition('c')];
    const previous = [c, a];
    const names = (list: { type: string; function?: { name: string } }[]) => list.map((item) => item.function?.name);
    expect(names(loadedTools(previous, [b, a, b]))).toEqual(['c', 'a', 'b']);
    expect(names(previous)).toEqual(['c', 'a']);
  });
});

describe('orderTools', () => {
  it('orderTools sorts by name, keeps the definitions themselves, and obeys a comparator', () => {
    const definition = (name: string) => ({
      type: FUNCTION_TOOL,
      function: { name, parameters: { type: SchemaType.Object } },
    });
    const [a, b, c] = [definition('a'), definition('b'), definition('c')];
    const names = (list: { type: string; function?: { name: string } }[]) => list.map((item) => item.function?.name);
    const given = [c, a, b];
    expect(names(orderTools(given))).toEqual(['a', 'b', 'c']);
    // By identity, so `sanitizeTools` still answers from its cache rather than rebuilding.
    expect(orderTools(given)[0]).toBe(a);
    expect(names(given)).toEqual(['c', 'a', 'b']);
    expect(orderTools(given, false)).toBe(given);
    // Already in order, so nothing is copied.
    const sorted = [a, b, c];
    expect(orderTools(sorted)).toBe(sorted);
    expect(names(orderTools(given, (x, y) => y.localeCompare(x)))).toEqual(['c', 'b', 'a']);
  });
});

describe('requestedNames', () => {
  it('load_tools arguments are read defensively', () => {
    expect(requestedNames({ names: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(requestedNames({ tools: 'a' })).toEqual(['a']);
    expect(requestedNames({ name: ['a', 2] })).toEqual(['a']);
    expect(requestedNames({})).toEqual([]);
  });

  // `requestedNames` is also given a bare string where the schema says array — models do this.
  it('load_tools accepts a single name where an array was asked for', () => {
    expect(requestedNames({ names: 'a' })).toEqual(['a']);
    expect(requestedNames({ names: [1, 'a'] })).toEqual(['a']);
  });
});

describe('inCatalog', () => {
  it('inCatalog knows a tool the model called without loading', () => {
    expect(inCatalog(catalog, 'files__write_file')).toBe(true);
    expect(inCatalog(catalog, 'files__delete_file')).toBe(false);
  });
});

describe('carryOver', () => {
  it('carry-over keeps what was used, newly used last', () => {
    expect(carryOver(['a', 'b'], new Set(['b', 'c']))).toEqual(['a', 'b', 'c']);
  });

  it('carry-over leaves a carried tool where it was when it is used again', () => {
    // Moving it to the end reorders the tool array between turns, and loses the prompt cache.
    expect(carryOver(['a', 'b', 'c'], new Set(['a']))).toEqual(['a', 'b', 'c']);
  });

  it('carry-over drops the earliest unused before anything used this turn', () => {
    expect(carryOver(['a', 'b', 'c'], new Set(['a', 'd']), 3)).toEqual(['a', 'c', 'd']);
  });

  it('carry-over drops the least recently used past the cap', () => {
    const previous = Array.from({ length: MAX_CARRIED }, (_, i) => `old_${i}`);
    const out = carryOver(previous, new Set(['fresh']));
    expect(out).toHaveLength(MAX_CARRIED);
    expect(out.at(-1)).toBe('fresh');
    expect(out).not.toContain('old_0');
  });

  it('carry-over carries as many as it was asked to', () => {
    expect(carryOver(['a', 'b', 'c'], new Set(['d']), 2)).toEqual(['c', 'd']);
    // A cap of nobody's is not a cap of none: `slice(-0)` is the whole array, which is the one
    // answer a caller asking for zero cannot have meant.
    expect(carryOver(['a', 'b', 'c'], new Set(['d']), 0)).toEqual(['d']);
  });
});

describe('the proxied tools', () => {
  const definition = (name: string) => ({
    type: FUNCTION_TOOL,
    function: {
      name,
      description: `does ${name}`,
      parameters: { type: SchemaType.Object, properties: { id: { type: SchemaType.String } }, required: ['id'] },
    },
  });

  it('the proxied tool array is load_tools and call_tool, frozen, with open arguments', () => {
    const names = PROXY_TOOLS.map((tool) => (tool.type === FUNCTION_TOOL ? tool.function.name : ''));
    expect(names).toEqual([LOAD_TOOLS, CALL_TOOL]);
    expect(Object.isFrozen(PROXY_TOOLS)).toBe(true);
    const call = PROXY_TOOLS[1];
    if (call.type !== FUNCTION_TOOL) {
      throw new Error('unreachable');
    }
    expect(Object.isFrozen(call.function)).toBe(true);
    expect(call.function.parameters).toMatchObject({
      properties: { arguments: { type: SchemaType.Object, additionalProperties: true } },
      required: ['name', 'arguments'],
    });
  });

  it('the proxied catalogue points at call_tool, and never at a tool list', () => {
    const prompt = proxyCatalogPrompt(catalog);
    expect(prompt).toContain('run them with `call_tool`');
    expect(prompt).toContain('gmail__send_email');
    expect(prompt).not.toContain('tool list');
    expect(proxyCatalogPrompt([{ id: '1', label: 'Empty', tools: [] }])).toBe('');
  });

  it("a proxied load answers with each new tool's whole definition", () => {
    const resolved = expandNames(['gmail__send_email', 'files__read_file'], catalog);
    const send = definition('gmail__send_email');
    const read = definition('files__read_file');
    const result = proxyLoadResult(resolved, catalog, [send, read]);
    expect(result.split('\n')).toEqual([
      'Loaded 2 tool(s). Run them with `call_tool`.',
      '',
      JSON.stringify({
        name: 'gmail__send_email',
        description: 'does gmail__send_email',
        parameters: send.function.parameters,
      }),
      '',
      JSON.stringify({
        name: 'files__read_file',
        description: 'does files__read_file',
        parameters: read.function.parameters,
      }),
    ]);
  });

  it('a proxied load points back at what is loaded, and says what it could not define', () => {
    const resolved = expandNames(['gmail__send_email', 'files__read_file', 'files__write_file', 'nope'], catalog);
    const result = proxyLoadResult(
      resolved,
      catalog,
      [definition('gmail__send_email'), definition('files__read_file')],
      new Set(['gmail__send_email']),
    );
    expect(result).toContain('Loaded 1 tool(s). Run them with `call_tool`.');
    expect(result).not.toContain('"name":"gmail__send_email"');
    expect(result).toContain(
      'Already loaded earlier in this conversation: gmail__send_email. Run them with `call_tool`; do not load them again.',
    );
    expect(result).toContain('No definition is available for: files__write_file.');
    expect(result).toContain('Not in the catalogue: nope.');
  });

  it("a proxied load that matched nothing is refused in on-demand's words", () => {
    for (const names of [[], ['*'], ['nope']]) {
      const resolved = expandNames(names, catalog);
      expect(proxyLoadResult(resolved, catalog, [])).toBe(loadResult(resolved, catalog));
    }
  });

  it('only a proxied load carrying definitions is one a prune has to keep', () => {
    const resolved = expandNames(['gmail__send_email'], catalog);
    const send = definition('gmail__send_email');
    expect(holdsDefinitions(proxyLoadResult(resolved, catalog, [send]))).toBe(true);
    // A pointer back, a refusal and on-demand's own result all leave the model nothing to lose.
    expect(holdsDefinitions(proxyLoadResult(resolved, catalog, [send], new Set(resolved.matched)))).toBe(false);
    expect(holdsDefinitions(proxyLoadResult(expandNames(['nope'], catalog), catalog, []))).toBe(false);
    expect(holdsDefinitions(loadResult(resolved, catalog))).toBe(false);
  });

  it('call_tool is read as the tool it names, with arguments as an object or as JSON', () => {
    expect(proxiedCall({ name: 'files__read_file', arguments: { path: 'a' } }, catalog)).toEqual({
      name: 'files__read_file',
      input: { path: 'a' },
    });
    expect(proxiedCall({ name: 'files__read_file', arguments: '{"path":"a"}' }, catalog).input).toEqual({ path: 'a' });
    expect(proxiedCall({ name: 'files__read_file' }, catalog).input).toEqual({});
  });

  it('call_tool refuses what it cannot run, in words the model can act on', () => {
    expect(() => proxiedCall({ arguments: {} }, catalog)).toThrow('call_tool needs a name');
    expect(() => proxiedCall({ name: 'shell', arguments: {} }, catalog)).toThrow('Not in the catalogue: shell.');
    expect(() => proxiedCall({ name: 'files__read_file', arguments: '{oops' }, catalog)).toThrow(
      'call_tool arguments for files__read_file are not valid JSON',
    );
    expect(() => proxiedCall({ name: 'files__read_file', arguments: [] }, catalog)).toThrow('must be an object');
    expect(() => proxiedCall({ name: 'files__read_file', arguments: 3 }, catalog)).toThrow('must be an object');
  });

  it('a call is shown as the tool a call_tool ran, and otherwise as it came', () => {
    expect(shownCall(CALL_TOOL, '{"name":"files__read_file","arguments":{"path":"a"}}')).toEqual({
      name: 'files__read_file',
      input: '{"path":"a"}',
    });
    expect(shownCall(CALL_TOOL, '{not json')).toEqual({ name: CALL_TOOL, input: '{not json' });
    expect(shownCall('files__read_file', '{"name":"x"}')).toEqual({
      name: 'files__read_file',
      input: '{"name":"x"}',
    });
  });
});
