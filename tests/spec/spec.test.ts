import { describe, expect, it } from 'vitest';
import { ReasoningReplay, ToolDiscovery } from '../../src/core/config.ts';
import { HOOK_EVENTS, HookEvent } from '../../src/hooks/hook-events.ts';
import type { AgentLoopOptions } from '../../src/run/agent-loop.ts';
import { PART_OWNERS, PROMPT_LAYOUTS, PROMPT_MODES, PROMPT_ROLES } from '../../src/spec/parts.ts';
import {
  AGENT_SPEC,
  type AgentSpec,
  exportSpec,
  findSpecSecrets,
  lockedFieldsIn,
  parseAppParts,
  parseSpec,
  type ResolvedAgent,
  resolveAgentSpec,
  SecretSign,
  SPEC_EVENTS,
  upgradeSpec,
} from '../../src/spec/spec.ts';

/** A document that parses cleanly, which each test then bends in one direction. */
const doc = (extra: Record<string, unknown> = {}) => ({ spec: AGENT_SPEC, ...extra });

/** The token of version 1, which this build refuses. */
const SPEC_V1 = 'cubicecho.agent/1';

/** A system part, as a document writes one. */
const part = (name: string, content: string, extra: Record<string, unknown> = {}) => ({
  role: PROMPT_ROLES.system,
  name,
  content,
  ...extra,
});

/** The parsed spec, insisting the document survived so a test never asserts against null. */
function parsed(document: unknown, options?: Parameters<typeof parseSpec>[1]): AgentSpec {
  const result = parseSpec(document, options);
  expect(result.errors).toEqual([]);
  if (!result.spec) {
    throw new Error('unreachable');
  }
  return result.spec;
}

describe('parseSpec', () => {
  it('refuses a document it cannot identify, and nothing else', () => {
    // The four hard errors, each on its own document: everything outside this list drops a field.
    expect(parseSpec(null).errors).toEqual(['spec: must be an object']);
    expect(parseSpec('{}').errors).toEqual(['spec: must be an object']);
    expect(parseSpec({}).errors).toEqual([`spec: must be "${AGENT_SPEC}"`]);
    expect(parseSpec({ spec: 'openai.assistant/1' }).errors).toEqual([`spec: must be "${AGENT_SPEC}"`]);
    expect(parseSpec({ spec: 'cubicecho.agent/3' }).errors).toEqual([
      'spec: is version 3, and this build reads version 2',
    ]);
    expect(parseSpec({ spec: SPEC_V1 }).errors).toEqual([
      'spec: is version 1, and this build reads version 2, which upgradeSpec converts it to',
    ]);
    expect(parseSpec(doc({ prompt: {} })).errors).toEqual(['prompt: must be an array']);
    expect(parseSpec(doc({ tasks: [] })).errors).toEqual(['tasks: must be an object']);
    expect(parseSpec(doc({ hooks: {} })).errors).toEqual(['hooks: must be an array']);
  });

  it('reports every problem at once rather than one per round trip', () => {
    const result = parseSpec(doc({ model: { temperature: 9, maxTokens: 'lots' } }));
    expect(result.spec).not.toBeNull();
    expect(result.warnings).toEqual([
      'model.maxTokens: must be a number, and was dropped',
      'model.temperature: must be between 0 and 2, and was dropped',
    ]);
  });

  it('takes each way tools can reach the model, and drops one it has not heard of', () => {
    for (const discovery of Object.values(ToolDiscovery)) {
      expect(parsed(doc({ tools: { discovery } })).tools).toEqual({ discovery });
    }
    const result = parseSpec(doc({ tools: { discovery: 'lazy', maxIterations: 3 } }));
    expect(result.spec?.tools).toEqual({ maxIterations: 3 });
    expect(result.warnings).toEqual(['tools.discovery: must be "eager", "ondemand" or "proxy", and was dropped']);
  });

  it('takes each reasoning replay policy, drops one it has not heard of, and resolves the last layer', () => {
    for (const reasoningReplay of Object.values(ReasoningReplay)) {
      expect(parsed(doc({ model: { reasoningReplay } })).model).toEqual({ reasoningReplay });
    }
    const result = parseSpec(doc({ model: { model: 'm', reasoningReplay: 'some' } }));
    expect(result.spec?.model).toEqual({ model: 'm' });
    expect(result.warnings).toEqual(['model.reasoningReplay: must be "all", "tool-loop" or "none", and was dropped']);
    const base = parsed(doc({ model: { reasoningReplay: ReasoningReplay.None } }));
    const over = parsed(doc({ model: { reasoningReplay: ReasoningReplay.All } }));
    expect(resolveAgentSpec([base, over]).reasoningReplay).toBe(ReasoningReplay.All);
    // Absent stays absent, which the loop reads as `all`.
    expect(resolveAgentSpec([parsed(doc())])).not.toHaveProperty('reasoningReplay');
  });

  it('drops an out-of-range number instead of clamping it', () => {
    // A clamp invents a number the author did not write; dropping falls back to one somebody did.
    const spec = parsed(doc({ model: { model: 'm', temperature: 4 } }));
    expect(spec.model).toEqual({ model: 'm' });
    expect(spec.model?.temperature).toBeUndefined();
  });

  it('keeps a meaningful zero, because there is no inherit sentinel', () => {
    const spec = parsed(
      doc({
        model: { temperature: 0, maxTokens: 0, contextLength: 0 },
        retry: { maxRetries: 0 },
        endpoint: { baseUrl: 'http://box/v1', requestTimeoutSeconds: 0 },
      }),
    );
    expect(spec.model).toEqual({ temperature: 0, maxTokens: 0, contextLength: 0 });
    expect(spec.retry).toEqual({ maxRetries: 0 });
    expect(spec.endpoint?.requestTimeoutSeconds).toBe(0);
  });

  it('reads null as absent, because a nullable column round-trips as null', () => {
    const spec = parsed(doc({ name: null, model: { model: 'm', temperature: null } }));
    expect(spec.name).toBeUndefined();
    expect(spec.model).toEqual({ model: 'm' });
  });

  it('refuses to carry a credential at any depth', () => {
    const result = parseSpec(doc({ endpoint: { baseUrl: 'http://box/v1', apiKey: 'sk-live-1' } }));
    expect(result.spec?.endpoint).toEqual({ baseUrl: 'http://box/v1' });
    expect(JSON.stringify(result.spec)).not.toContain('sk-live-1');
    expect(result.warnings).toEqual([
      'endpoint.apiKey: is not part of this format — a document carries no credentials, and was dropped',
    ]);
  });

  it('keeps a variable reference as the literal it is, and says so', () => {
    // Never expanded, so the lint rule warning about exactly this shape is the wrong one here.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal is the subject of the test
    const literal = '${OPENAI_BASE_URL}';
    const result = parseSpec(doc({ endpoint: { baseUrl: literal } }));
    expect(result.spec?.endpoint?.baseUrl).toBe(literal);
    expect(result.warnings).toEqual(['endpoint.baseUrl: looks like a variable reference, which is never expanded']);
  });

  it('drops the body fields the loop owns and keeps the rest', () => {
    const result = parseSpec(doc({ model: { extraBody: { top_k: 20, min_p: 0.05, id_slot: 3, messages: [] } } }));
    expect(result.spec?.model?.extraBody).toEqual({ top_k: 20, min_p: 0.05, id_slot: 3 });
    expect(result.warnings).toEqual(["model.extraBody.messages: is the loop's to set, and was dropped"]);
  });

  it('drops the body fields the spec spells elsewhere, naming the field that does', () => {
    const result = parseSpec(
      doc({
        model: {
          temperature: 0,
          extraBody: { top_k: 20, temperature: 0.9, max_tokens: 5, max_completion_tokens: 6, reasoning_effort: 'high' },
        },
        tasks: { title: { model: 'm', extraBody: { min_p: 0.05, temperature: 1 } } },
      }),
    );
    expect(result.spec?.model?.extraBody).toEqual({ top_k: 20 });
    expect(result.spec?.tasks?.title?.extraBody).toEqual({ min_p: 0.05 });
    expect(result.warnings).toEqual([
      "model.extraBody.temperature: is model.temperature's to set, and was dropped",
      "model.extraBody.max_tokens: is model.maxTokens's to set, and was dropped",
      "model.extraBody.max_completion_tokens: is model.maxTokens's to set, and was dropped",
      "model.extraBody.reasoning_effort: is model.reasoningEffort's to set, and was dropped",
      "tasks.title.extraBody.temperature: is tasks.title.temperature's to set, and was dropped",
    ]);
    // So the resolved agent carries the temperature the document states, zero meaning zero, and
    // nothing in its `extraBody` that `buildBody` would spread over it.
    const resolved = resolveAgentSpec([parsed(doc({ model: { temperature: 0, extraBody: { temperature: 0.9 } } }))]);
    expect(resolved.temperature).toBe(0);
    expect(resolved).not.toHaveProperty('extraBody.temperature');
  });

  it("reads a task's extraBody by the same rules", () => {
    const result = parseSpec(
      doc({ tasks: { title: { model: 'm', extraBody: { top_k: 20, tools: [] } }, other: { extraBody: 3 } } }),
    );
    expect(result.spec?.tasks?.title?.extraBody).toEqual({ top_k: 20 });
    expect(result.spec?.tasks?.other).toEqual({});
    expect(result.warnings).toEqual([
      "tasks.title.extraBody.tools: is the loop's to set, and was dropped",
      'tasks.other.extraBody: must be an object, and was dropped',
    ]);
  });

  it('quotes a task key that holds a dot, as columns do', () => {
    const result = parseSpec(
      doc({ tasks: { 'vision.v2': { model: 3, extraBody: { temperature: 0.2 } }, 'odd.one': 'x' } }),
    );
    expect(result.warnings).toEqual([
      'tasks["vision.v2"].model: must be a string, and was dropped',
      `tasks["vision.v2"].extraBody.temperature: is tasks["vision.v2"].temperature's to set, and was dropped`,
      'tasks["odd.one"]: must be an object, and was dropped',
    ]);
  });

  it('carries a key from a later 2.x rather than erasing it', () => {
    const result = parseSpec(doc({ id: 'a', memory: { store: 'vector' } }));
    expect(result.spec?.memory).toEqual({ store: 'vector' });
    expect(result.warnings).toEqual(['memory: is not a key this version names, and was carried through unread']);
  });

  it('never warns about extensions, which is the point of them', () => {
    const result = parseSpec(doc({ extensions: { 'com.cubicecho.min-agent': { speakReplies: false } } }));
    expect(result.warnings).toEqual([]);
    expect(result.spec?.extensions).toEqual({
      'com.cubicecho.min-agent': { speakReplies: false },
    });
  });

  it('refuses a requirement this host does not understand, and allows one it does', () => {
    expect(parseSpec(doc({ requires: ['com.example.sandbox'] })).errors).toEqual([]);
    expect(parseSpec(doc({ requires: ['com.example.sandbox'] }), { understands: [] }).errors).toEqual([
      'requires[0]: "com.example.sandbox" is not understood by this host',
    ]);
    expect(
      parseSpec(doc({ requires: ['com.example.sandbox'] }), {
        understands: ['com.example.sandbox'],
      }).errors,
    ).toEqual([]);
  });
});

describe('parseSpec prompt', () => {
  it('reads a part written as a chat message, with its mode and the modes an app may use', () => {
    const prompt = [
      part('identity', 'You are Task Reviewer.', { allowedModes: [PROMPT_MODES.extend, PROMPT_MODES.replace] }),
      { role: PROMPT_ROLES.developer, name: 'rules', content: 'Judge the work.', mode: PROMPT_MODES.extend },
      part('format', 'PASS or FAIL.', { allowedModes: [] }),
    ];
    const result = parseSpec(doc({ prompt }));
    expect(result.warnings).toEqual([]);
    expect(result.spec?.prompt).toEqual(prompt);
  });

  it('reads a missing or unknown role as system, and says so', () => {
    const result = parseSpec(
      doc({
        prompt: [
          { name: 'a', content: 'A.' },
          { role: 'user', name: 'b', content: 'B.' },
        ],
      }),
    );
    expect(result.spec?.prompt).toEqual([part('a', 'A.'), part('b', 'B.')]);
    expect(result.warnings).toEqual([
      'prompt[0].role: is missing, and was read as "system"',
      'prompt[1].role: must be "system" or "developer", and was read as "system"',
    ]);
  });

  it('drops a mode it has not heard of, and an allowed mode, keeping the list', () => {
    const result = parseSpec(
      doc({
        prompt: [
          part('a', 'A.', { mode: 'append' }),
          part('b', 'B.', { allowedModes: ['Replace', PROMPT_MODES.extend] }),
          part('c', 'C.', { allowedModes: ['overwrite'] }),
          part('d', 'D.', { allowedModes: 'extend' }),
        ],
      }),
    );
    expect(result.spec?.prompt).toEqual([
      part('a', 'A.'),
      part('b', 'B.', { allowedModes: [PROMPT_MODES.extend] }),
      // A list that loses every entry locks the part: a mistake lets an app do less, never more.
      part('c', 'C.', { allowedModes: [] }),
      part('d', 'D.'),
    ]);
    expect(result.warnings).toEqual([
      'prompt[0].mode: must be "extend" or "replace", and was dropped',
      'prompt[1].allowedModes[0]: must be "extend" or "replace", and was dropped',
      'prompt[2].allowedModes[0]: must be "extend" or "replace", and was dropped',
      'prompt[3].allowedModes: must be an array of modes, and was dropped',
    ]);
  });

  it('drops a part with no name or no content, and keeps an empty content, which deletes', () => {
    const result = parseSpec(
      doc({
        prompt: [
          'text',
          part('', 'A.'),
          { role: PROMPT_ROLES.system, name: 'b' },
          part('c', ''),
          part('d', '', { mode: 'extend' }),
        ],
      }),
    );
    expect(result.spec?.prompt).toEqual([part('c', ''), part('d', '')]);
    expect(result.warnings).toEqual([
      'prompt[0]: must be an object, and was dropped',
      'prompt[1]: has no name, and merging happens on the name, and was dropped',
      'prompt[2]: has no content, and was dropped',
      'prompt[4].mode: means nothing beside an empty content, which deletes the part, and was dropped',
    ]);
  });

  it('refuses a part name whose first word is app, whatever joins it to the next', () => {
    for (const name of ['app', 'app_lane', 'app-lane', 'App lane', 'APP_system', '_app_lane']) {
      expect(parseSpec(doc({ prompt: [part(name, 'X.')] })).errors).toEqual([
        `prompt[0].name: "${name}" has "app" as its first word, which only an app's parts may`,
      ]);
    }
    const names = ['apple', 'application', 'lane_app', 'apps'];
    expect(parsed(doc({ prompt: names.map((name) => part(name, 'X.')) })).prompt?.map((held) => held.name)).toEqual(
      names,
    );
  });

  it('takes each layout, drops one it has not heard of, and resolves the last layer', () => {
    for (const promptLayout of Object.values(PROMPT_LAYOUTS)) {
      expect(parsed(doc({ promptLayout })).promptLayout).toBe(promptLayout);
    }
    const result = parseSpec(doc({ promptLayout: 'html' }));
    expect(result.spec).not.toHaveProperty('promptLayout');
    expect(result.warnings).toEqual(['promptLayout: must be "plain", "markdown" or "xml", and was dropped']);
    const base = parsed(doc({ promptLayout: PROMPT_LAYOUTS.xml }));
    const over = parsed(doc({ promptLayout: PROMPT_LAYOUTS.markdown }));
    expect(resolveAgentSpec([base, over]).promptLayout).toBe(PROMPT_LAYOUTS.markdown);
    expect(resolveAgentSpec([base, parsed(doc())]).promptLayout).toBe(PROMPT_LAYOUTS.xml);
    expect(resolveAgentSpec([]).promptLayout).toBe(PROMPT_LAYOUTS.plain);
  });
});

describe('upgradeSpec', () => {
  it('writes each version 1 part as a version 2 one, which parseSpec then reads', () => {
    const v1 = {
      spec: SPEC_V1,
      id: 'reviewer',
      prompt: [
        { id: 'identity', text: 'You are a careful code reviewer.' },
        { id: 'role', ref: { type: 'file', value: 'role.md' } },
        { id: 'lane', text: '', ref: { type: 'url', value: 'https://x/lane.md' } },
      ],
      tools: { servers: ['git'] },
    };
    const before = structuredClone(v1);
    const { document, upgraded, warnings } = upgradeSpec(v1);
    expect(upgraded).toBe(true);
    expect(document).toEqual({
      spec: AGENT_SPEC,
      id: 'reviewer',
      prompt: [part('identity', 'You are a careful code reviewer.'), part('lane', '')],
      tools: { servers: ['git'] },
    });
    expect(warnings).toEqual([
      'prompt[1]: had only a reference, which version 2 does not read, and was dropped',
      'prompt[2].ref: is a reference, which version 2 does not read, and was dropped',
    ]);
    // The document handed in is left as it was.
    expect(v1).toEqual(before);
    expect(parseSpec(document)).toMatchObject({ errors: [], warnings: [] });
  });

  it('hands back anything that is not a version 1 document untouched', () => {
    const v2 = doc({ prompt: [part('identity', 'X.')] });
    for (const document of [v2, { spec: 'cubicecho.agent/3' }, null, 'text', { prompt: [] }]) {
      const result = upgradeSpec(document);
      expect(result).toEqual({ document, upgraded: false, warnings: [] });
      expect(result.document).toBe(document);
    }
  });

  it('leaves what it cannot convert to parseSpec to report', () => {
    const { document } = upgradeSpec({ spec: SPEC_V1, prompt: ['text', { text: 'No id.' }] });
    expect(document).toEqual({ spec: AGENT_SPEC, prompt: ['text', { role: PROMPT_ROLES.system, content: 'No id.' }] });
    expect(parseSpec(document).warnings).toEqual([
      'prompt[0]: must be an object, and was dropped',
      'prompt[1]: has no name, and merging happens on the name, and was dropped',
    ]);
  });
});

describe('parseSpec tools.servers', () => {
  // The single most likely bug: two consumers spell an empty scope in opposite directions today.
  it('keeps absent, empty and a list as three different answers', () => {
    expect(parsed(doc({ tools: { discovery: ToolDiscovery.Eager } })).tools?.servers).toBeUndefined();
    expect(parsed(doc({ tools: { servers: [] } })).tools?.servers).toEqual([]);
    expect(parsed(doc({ tools: { servers: ['git', 'fs'] } })).tools?.servers).toEqual(['git', 'fs']);
  });

  it('round-trips all three through resolve and back into a document', () => {
    for (const servers of [undefined, [], ['git']]) {
      const tools = servers === undefined ? { maxIterations: 8 } : { servers };
      const spec = parsed(doc({ tools }));
      const resolved = resolveAgentSpec([spec]);
      expect(resolved.servers).toEqual(servers);
      const again = parsed(doc({ tools: { ...(resolved.servers && { servers: resolved.servers }) } }));
      expect(again.tools?.servers).toEqual(servers);
    }
  });
});

describe('parseSpec hooks', () => {
  const hook = (extra: Record<string, unknown>) => ({
    id: 'h1',
    server: 'git',
    tool: 'status',
    ...extra,
  });

  it('reads a hook whole', () => {
    const spec = parsed(
      doc({ hooks: [hook({ on: HookEvent.SessionStart, inject: true, args: { path: '{{cwd}}' } })] }),
    );
    expect(spec.hooks).toEqual([
      {
        id: 'h1',
        on: HookEvent.SessionStart,
        server: 'git',
        tool: 'status',
        inject: true,
        args: { path: '{{cwd}}' },
      },
    ]);
  });

  it('drops an inject on an event that runs after the model answered', () => {
    const result = parseSpec(doc({ hooks: [hook({ on: HookEvent.AfterExchange, inject: true })] }));
    expect(result.spec?.hooks?.[0]?.inject).toBeUndefined();
    expect(result.warnings).toEqual([
      'hooks[0].inject: "afterExchange" runs after the model has already answered, and was dropped',
    ]);
  });

  it('drops a veto anywhere but beforeCompact', () => {
    expect(parsed(doc({ hooks: [hook({ on: HookEvent.BeforeCompact, veto: true })] })).hooks?.[0]?.veto).toBe(true);
    expect(
      parsed(doc({ hooks: [hook({ on: HookEvent.BeforeExchange, veto: true })] })).hooks?.[0]?.veto,
    ).toBeUndefined();
  });

  it('notes an event this host never fires rather than refusing the agent', () => {
    // task_server rejects a beforeCompact hook at save time today, which makes a good agent
    // unimportable. The hook is kept; the operator is told.
    const result = parseSpec(doc({ hooks: [hook({ on: HookEvent.BeforeCompact })] }), {
      events: [HookEvent.SessionStart, HookEvent.BeforeExchange],
    });
    expect(result.errors).toEqual([]);
    expect(result.spec?.hooks).toHaveLength(1);
    expect(result.warnings).toEqual(['hooks[0].on: "beforeCompact" is never fired by this host']);
  });

  it('drops a hook bound to the name an exchange event had before 5.0.0, as any unknown event', () => {
    const result = parseSpec(doc({ hooks: [hook({ on: 'beforeTurn' }), hook({ id: 'keep', on: 'afterTurn' })] }));
    expect(result.errors).toEqual([]);
    expect(result.spec?.hooks).toEqual([]);
    expect(result.warnings).toEqual([
      'hooks[0].on: "beforeTurn" is not an event, and was dropped',
      'hooks[1].on: "afterTurn" is not an event, and was dropped',
    ]);
  });

  it('drops a hook that is not an event at all', () => {
    const result = parseSpec(doc({ hooks: [hook({ on: 'onTuesday' })] }));
    expect(result.spec?.hooks).toEqual([]);
    expect(result.warnings).toEqual(['hooks[0].on: "onTuesday" is not an event, and was dropped']);
  });

  it('binds to the same events the host side fires', () => {
    // SPEC_EVENTS is HOOK_EVENTS from a leaf that pulls no `node:crypto`, so the two cannot drift.
    expect([...SPEC_EVENTS].sort()).toEqual([...HOOK_EVENTS].sort());
  });
});

describe('parseSpec bundle', () => {
  const bundle = {
    mcpServers: [
      {
        slug: 'fs',
        label: 'Files',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/scans'],
        env: { TOKEN: 'sk-live-1' },
        maxResultChars: 40000,
      },
    ],
  };

  it('drops a bundle unless the caller asked for one', () => {
    // Executable by proxy: a bundled server is a command line, so the unsafe path is never default.
    const result = parseSpec(doc({ bundle }));
    expect(result.spec?.bundle).toBeUndefined();
    expect(result.warnings).toEqual([
      'bundle: carries a command line, so it is only read with { bundle: true }, and was dropped',
    ]);
  });

  it("passes a server's unknown keys through untouched", () => {
    // Restating the pool's config would silently delete this server's 40k result cap on a round trip.
    const spec = parsed(doc({ bundle }), { bundle: true });
    expect(spec.bundle?.mcpServers?.[0]).toEqual(bundle.mcpServers[0]);
  });

  it('needs a name, and refuses a second server with the same one', () => {
    const result = parseSpec(doc({ bundle: { mcpServers: [{ label: 'nameless' }, { slug: 'fs' }, { slug: 'fs' }] } }), {
      bundle: true,
    });
    expect(result.spec?.bundle?.mcpServers).toEqual([{ slug: 'fs' }]);
    expect(result.warnings).toEqual([
      'bundle.mcpServers[0]: needs an id or a slug, and was dropped',
      'bundle.mcpServers[2]: is a second server called "fs", and was dropped',
    ]);
  });
});

describe('exportSpec', () => {
  const spec = parsed(
    doc({
      id: 'ocr',
      bundle: {
        mcpServers: [{ slug: 'fs', command: 'npx', env: { TOKEN: 'sk-live-1' }, headers: { A: 'b' } }],
      },
    }),
    { bundle: true },
  );

  it("strips a bundled server's secrets and leaves the server", () => {
    const out = exportSpec(spec);
    expect(out.bundle?.mcpServers).toEqual([{ slug: 'fs', command: 'npx' }]);
    expect(JSON.stringify(out)).not.toContain('sk-live-1');
  });

  it('keeps them when the caller says so', () => {
    expect(exportSpec(spec, { secrets: true }).bundle?.mcpServers?.[0]?.env).toEqual({
      TOKEN: 'sk-live-1',
    });
  });

  it('produces a document that is still a valid spec', () => {
    // The property worth having: redacting must not make an agent unimportable.
    const again = parseSpec(exportSpec(spec), { bundle: true });
    expect(again.errors).toEqual([]);
    expect(again.spec?.id).toBe('ocr');
    expect(again.spec?.bundle?.mcpServers).toEqual([{ slug: 'fs', command: 'npx' }]);
  });
});

describe("an endpoint's fetch", () => {
  const fetch = async () => new Response('{}');
  const spec = parsed(
    doc({
      endpoint: { baseUrl: 'http://router.internal/v1', fetch },
      model: { model: 'big' },
      tasks: { title: { model: 'tiny', endpoint: { baseUrl: 'http://side.internal/v1', fetch } } },
    }),
  );

  it('is never read from a document', () => {
    expect(spec.endpoint).toEqual({ baseUrl: 'http://router.internal/v1' });
    expect(spec.tasks?.title?.endpoint).toEqual({ baseUrl: 'http://side.internal/v1' });
  });

  it('is never written into an exported one', () => {
    const out = exportSpec(spec);
    expect(out.endpoint).toEqual({ baseUrl: 'http://router.internal/v1' });
    expect(out.tasks?.title?.endpoint).toEqual({ baseUrl: 'http://side.internal/v1' });
  });

  it('is never produced by resolving one, for the agent or a task', () => {
    const resolved = resolveAgentSpec([spec]);
    expect('fetch' in resolved).toBe(false);
    expect(resolved.tasks.title?.endpoint).toEqual({ baseUrl: 'http://side.internal/v1', apiKey: '' });
  });
});

describe('findSpecSecrets', () => {
  /** The hints for a document bundling `servers`, as `path sign` lines. */
  const found = (...servers: Record<string, unknown>[]) =>
    findSpecSecrets(parsed(doc({ id: 'ocr', bundle: { mcpServers: servers } }), { bundle: true })).map(
      (hint) => `${hint.path} ${hint.sign}`,
    );

  it('names the value after a flag that reads as a credential, and a flag carrying its own', () => {
    expect(found({ slug: 'a', command: 'npx', args: ['some-mcp', '--api-key', 'abc123', '--token=abc123'] })).toEqual([
      'bundle.mcpServers[0].args[2] flag',
      'bundle.mcpServers[0].args[3] flag',
    ]);
  });

  it('names a URL with userinfo or a credential in its query, as a field or an argument', () => {
    expect(
      found(
        { slug: 'a', url: 'https://mcp.example.com/sse?token=abc123' },
        { slug: 'b', url: 'https://user:pass@mcp.example.com/' },
        { slug: 'c', command: 'npx', args: ['mcp-remote', 'https://mcp.example.com/sse?api_key=abc123'] },
      ),
    ).toEqual([
      'bundle.mcpServers[0].url query',
      'bundle.mcpServers[1].url userinfo',
      'bundle.mcpServers[2].args[1] query',
    ]);
  });

  it("names a header written as an argument, and a value with a key's shape wherever it is", () => {
    expect(
      found({
        slug: 'a',
        command: 'npx',
        args: ['mcp-remote', '--header', 'Authorization: Bearer abc123', 'sk-live-1', '--header', 'X-Api-Key:abc123'],
      }),
    ).toEqual([
      'bundle.mcpServers[0].args[2] flag',
      'bundle.mcpServers[0].args[3] value',
      'bundle.mcpServers[0].args[5] flag',
    ]);
  });

  it('names a command written as one line once, and a key of the server named like a credential', () => {
    expect(found({ slug: 'a', command: 'some-mcp --api-key abc123 --token abc123', apiKey: 'abc123' })).toEqual([
      'bundle.mcpServers[0].command flag',
      'bundle.mcpServers[0].apiKey field',
    ]);
  });

  it('names nothing in a server that shows no credential, or only a reference to one', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal is the subject of the test
    const reference = '${TOKEN}';
    expect(
      found(
        { slug: 'a', command: 'npx', args: ['-y', 'some-mcp', '--port', '8080', '--verbose', '/home/me/notes'] },
        { slug: 'b', url: 'https://mcp.example.com/sse?transport=sse&token=' },
        { slug: 'c', command: 'npx', args: ['mcp-remote', '--header', `Authorization: Bearer ${reference}`] },
        { slug: 'd', url: `https://mcp.example.com/sse?token=${reference}`, apiKey: reference, token: '' },
        // A flag named like a credential and followed by another flag has no value to name.
        { slug: 'e', command: 'npx', args: ['some-mcp', '--token', '--verbose', 7, 'not a url: at all'] },
      ),
    ).toEqual([]);
    expect(findSpecSecrets(parsed(doc({ id: 'ocr' })))).toEqual([]);
  });

  it('leaves env and headers to exportSpec, and says the same of a document before and after it', () => {
    const spec = parsed(
      doc({
        id: 'ocr',
        bundle: {
          mcpServers: [{ id: 'fs', command: 'npx', args: ['--token', 'abc123'], env: { TOKEN: 'sk-live-1' } }],
        },
      }),
      { bundle: true },
    );
    const hints = [{ path: 'bundle.mcpServers[0].args[1]', server: 'fs', sign: SecretSign.Flag }];
    expect(findSpecSecrets(spec)).toEqual(hints);
    expect(findSpecSecrets(exportSpec(spec))).toEqual(hints);
    // The report says where, and never what.
    expect(JSON.stringify(hints)).not.toContain('abc123');
  });

  it('is what exportSpec leaves in: the export still points at the same server', () => {
    const spec = parsed(
      doc({ id: 'ocr', bundle: { mcpServers: [{ slug: 'a', url: 'https://mcp.example.com/sse?token=abc123' }] } }),
      { bundle: true },
    );
    expect(exportSpec(spec).bundle?.mcpServers).toEqual(spec.bundle?.mcpServers);
  });
});

describe('resolveAgentSpec', () => {
  it('is the flat shape the loop already takes', () => {
    const resolved = resolveAgentSpec([parsed(doc({ model: { model: 'm' } }))]);
    // The type-level claim the whole design rests on: no adapter between here and the loop.
    const config: AgentLoopOptions['config'] = resolved;
    expect(config.model).toBe('m');
  });

  it('layers settings under an agent, keeping a zero the agent meant', () => {
    const settings = parsed(
      doc({
        endpoint: { baseUrl: 'https://api.openai.com/v1', requestTimeoutSeconds: 120 },
        model: { model: 'gpt-4o', maxTokens: 8192, temperature: 0.7, contextLength: 128000 },
        tools: { discovery: ToolDiscovery.Eager, maxIterations: 20 },
        tasks: { toolSelect: { model: 'gpt-4o-mini' } },
        retry: { maxRetries: 3 },
      }),
    );
    const agent = parsed(
      doc({
        id: 'a3f2',
        name: 'Reviewer',
        endpoint: { baseUrl: 'http://localhost:8080/v1' },
        model: { model: 'qwen3-coder:30b', temperature: 0 },
        prompt: [part('identity', 'You are a careful code reviewer.')],
        tools: { servers: ['git', 'fs'] },
      }),
    );

    expect(resolveAgentSpec([settings, agent])).toMatchObject({
      id: 'a3f2',
      name: 'Reviewer',
      baseUrl: 'http://localhost:8080/v1',
      // Its own box, so it gets no key: a document must not be able to point this host's
      // provider key at somebody else's endpoint.
      apiKey: '',
      requestTimeoutSeconds: 120,
      model: 'qwen3-coder:30b',
      maxTokens: 8192,
      temperature: 0,
      contextLength: 128000,
      toolDiscovery: ToolDiscovery.Eager,
      toolSelectModel: 'gpt-4o-mini',
      maxToolIterations: 20,
      maxRetries: 3,
      systemPrompt: 'You are a careful code reviewer.',
      servers: ['git', 'fs'],
    });
  });

  it('stacks different prompt names and overwrites a repeated one in its place', () => {
    const base = parsed(
      doc({
        prompt: [part('project', 'This is the agent-core library.'), part('identity', 'You research thoroughly.')],
      }),
    );
    const task = parsed(doc({ prompt: [part('identity', 'You audit licences.')] }));
    const step = parsed(doc({ prompt: [part('lane', 'Only the files on the card.')] }));

    const resolved = resolveAgentSpec([base, task, step]);
    expect(resolved.systemPrompt).toBe(
      'This is the agent-core library.\n\nYou audit licences.\n\nOnly the files on the card.',
    );
    expect(resolved.prompt.map((held) => held.name)).toEqual(['project', 'identity', 'lane']);
  });

  it('lets an empty content delete a part a layer below contributed', () => {
    const base = parsed(doc({ prompt: [part('lane', 'Only the card.')] }));
    const over = parsed(doc({ prompt: [part('lane', '')] }));
    const resolved = resolveAgentSpec([base, over]);
    expect(resolved.systemPrompt).toBe('');
    expect(resolved.prompt).toEqual([]);
  });

  it('starts a deleted part afresh in the place its name first had', () => {
    const base = parsed(doc({ prompt: [part('role', 'Review.'), part('identity', 'You are X.')] }));
    const over = parsed(doc({ prompt: [part('role', '')] }));
    const back = parsed(doc({ prompt: [part('role', 'Audit.')] }));
    expect(resolveAgentSpec([base, over, back]).prompt.map((held) => held.content)).toEqual(['Audit.', 'You are X.']);
  });

  describe('prompt modes', () => {
    /** A resolved part as the agent's, as the resolver stacks one. */
    const agentPart = (name: string, content: string, extra: Record<string, unknown> = {}) => ({
      ...part(name, content),
      owner: PART_OWNERS.agent,
      ...extra,
    });

    it("resolves the prompt spec's three layers as its section 2 shows", () => {
      const settings = parsed(
        doc({
          prompt: [part('identity', 'You are a helpful assistant.'), part('format', 'Answer in full sentences.')],
        }),
      );
      const agent = parsed(
        doc({
          prompt: [
            part('identity', 'You are Task Reviewer. You decide whether work is actually done.'),
            part('rules', 'Judge the work itself, not reports about it.'),
          ],
        }),
      );
      const task = parsed(
        doc({
          prompt: [
            part('identity', 'Here you review the output of one workflow step.', { mode: PROMPT_MODES.extend }),
            part('format', 'Start with PASS or FAIL on its own line.', { mode: PROMPT_MODES.replace }),
            part('checklist', 'Check the tests, the changelog and the licence.'),
          ],
        }),
      );
      const resolved = resolveAgentSpec([settings, agent, task]);
      expect(resolved.prompt).toEqual([
        agentPart('identity', 'You are Task Reviewer. You decide whether work is actually done.'),
        agentPart('format', 'Answer in full sentences.'),
        agentPart('rules', 'Judge the work itself, not reports about it.'),
        agentPart('identity_2', 'Here you review the output of one workflow step.', {
          mark: { mode: PROMPT_MODES.extend, target: 'identity' },
        }),
        agentPart('format_2', 'Start with PASS or FAIL on its own line.', {
          mark: { mode: PROMPT_MODES.replace, target: 'format' },
        }),
        agentPart('checklist', 'Check the tests, the changelog and the licence.'),
      ]);
      // The plain layout writes a replace as an overwrite, in the replaced part's place.
      expect(resolved.systemPrompt).toBe(
        [
          'You are Task Reviewer. You decide whether work is actually done.',
          'Start with PASS or FAIL on its own line.',
          'Judge the work itself, not reports about it.',
          'Here you review the output of one workflow step.',
          'Check the tests, the changelog and the licence.',
        ].join('\n\n'),
      );
    });

    it('keeps an extension attached when its target is overwritten, and deletes it with the target', () => {
      const base = parsed(doc({ prompt: [part('identity', 'You are X.'), part('rules', 'Be careful.')] }));
      const extend = parsed(doc({ prompt: [part('identity', 'Here, review.', { mode: PROMPT_MODES.extend })] }));
      const overwrite = parsed(doc({ prompt: [part('identity', 'You are Y.')] }));
      const extendAgain = parsed(doc({ prompt: [part('identity_2', 'And audit.', { mode: PROMPT_MODES.extend })] }));
      const remove = parsed(doc({ prompt: [part('identity', '')] }));

      expect(resolveAgentSpec([base, extend, overwrite]).prompt).toEqual([
        agentPart('identity', 'You are Y.'),
        agentPart('rules', 'Be careful.'),
        agentPart('identity_2', 'Here, review.', { mark: { mode: PROMPT_MODES.extend, target: 'identity' } }),
      ]);
      // A part marked against `identity_2` goes with it, and it with `identity`.
      const chained = resolveAgentSpec([base, extend, extendAgain]);
      expect(chained.prompt.map((held) => held.name)).toEqual(['identity', 'rules', 'identity_2', 'identity_2_2']);
      expect(resolveAgentSpec([base, extend, extendAgain, remove]).prompt).toEqual([agentPart('rules', 'Be careful.')]);
    });

    it('lets a later layer overwrite or delete an added part by its own name', () => {
      const base = parsed(doc({ prompt: [part('identity', 'You are X.')] }));
      const extend = parsed(doc({ prompt: [part('identity', 'Here, review.', { mode: PROMPT_MODES.extend })] }));
      const overwrite = parsed(doc({ prompt: [part('identity_2', 'Here, audit.')] }));
      const remove = parsed(doc({ prompt: [part('identity_2', '')] }));
      expect(resolveAgentSpec([base, extend, overwrite]).prompt).toEqual([
        agentPart('identity', 'You are X.'),
        agentPart('identity_2', 'Here, audit.', { mark: { mode: PROMPT_MODES.extend, target: 'identity' } }),
      ]);
      expect(resolveAgentSpec([base, extend, remove]).prompt).toEqual([agentPart('identity', 'You are X.')]);
    });

    it('numbers an added part with the first number no name has taken, a deleted one included', () => {
      const base = parsed(doc({ prompt: [part('identity', 'You are X.'), part('identity_2', 'Mine.')] }));
      const extend = parsed(
        doc({
          prompt: [
            part('identity', 'One.', { mode: PROMPT_MODES.extend }),
            part('identity', 'Two.', { mode: PROMPT_MODES.replace }),
          ],
        }),
      );
      expect(resolveAgentSpec([base, extend]).prompt.map((held) => held.name)).toEqual([
        'identity',
        'identity_2',
        'identity_3',
        'identity_4',
      ]);
      const removeMine = parsed(doc({ prompt: [part('identity_2', '')] }));
      expect(resolveAgentSpec([base, removeMine, extend]).prompt.map((held) => held.name)).toEqual([
        'identity',
        'identity_3',
        'identity_4',
      ]);
    });

    it('adds a part with a mode as an ordinary one where no layer below has its name', () => {
      const base = parsed(doc({ prompt: [part('identity', 'You are X.')] }));
      const over = parsed(doc({ prompt: [part('format', 'PASS or FAIL.', { mode: PROMPT_MODES.replace })] }));
      expect(resolveAgentSpec([base, over]).prompt).toEqual([
        agentPart('identity', 'You are X.'),
        agentPart('format', 'PASS or FAIL.'),
      ]);
      // So does one whose name was deleted below it.
      const remove = parsed(doc({ prompt: [part('identity', '')] }));
      const extend = parsed(doc({ prompt: [part('identity', 'You are Y.', { mode: PROMPT_MODES.extend })] }));
      expect(resolveAgentSpec([base, remove, extend]).prompt).toEqual([agentPart('identity', 'You are Y.')]);
    });

    it('carries the modes an app may use, an overwrite without them keeping the ones below', () => {
      const modes = [PROMPT_MODES.extend, PROMPT_MODES.replace];
      const base = parsed(doc({ prompt: [part('format', 'Prose.', { allowedModes: modes })] }));
      const overwrite = parsed(doc({ prompt: [part('format', 'PASS or FAIL.')] }));
      const lock = parsed(doc({ prompt: [part('format', 'PASS or FAIL.', { allowedModes: [] })] }));
      expect(resolveAgentSpec([base, overwrite]).prompt).toEqual([
        agentPart('format', 'PASS or FAIL.', { allowedModes: modes }),
      ]);
      expect(resolveAgentSpec([base, lock]).prompt).toEqual([
        agentPart('format', 'PASS or FAIL.', { allowedModes: [] }),
      ]);
      // An added part's modes are its own, not its target's.
      const extend = parsed(doc({ prompt: [part('format', 'In English.', { mode: PROMPT_MODES.extend })] }));
      expect(resolveAgentSpec([base, extend]).prompt[1]).not.toHaveProperty('allowedModes');
    });

    it('never moves a part: what a layer below wrote keeps its order, and what is added follows it', () => {
      const base = parsed(doc({ prompt: ['a', 'b', 'c', 'd', 'e'].map((name) => part(name, `${name}.`)) }));
      const layers = [
        parsed(doc({ prompt: [part('d', 'D.'), part('b', 'B.', { mode: PROMPT_MODES.extend }), part('z', 'Z.')] })),
        parsed(doc({ prompt: [part('c', ''), part('a', 'A.', { mode: PROMPT_MODES.replace }), part('y', 'Y.')] })),
        parsed(doc({ prompt: [part('e', 'E.'), part('c', 'C again.'), part('b_2', 'B, later.')] })),
      ];
      const names = resolveAgentSpec([base, ...layers]).prompt.map((held) => held.name);
      // `c` was deleted and named again, so it is back in the place it first had.
      expect(names).toEqual(['a', 'b', 'c', 'd', 'e', 'b_2', 'z', 'a_2', 'y']);
    });

    it('writes exactly the joined texts where no part uses a mode', () => {
      const texts = ['  This is the agent-core library.  ', 'You are a reviewer.\n', '', 'Only the card.'];
      const spec = parsed(doc({ prompt: texts.map((content, index) => part(`p${index}`, content || ' ')) }));
      const joined = texts
        .map((text) => text.trim())
        .filter(Boolean)
        .join('\n\n');
      expect(resolveAgentSpec([spec]).systemPrompt).toBe(joined);
    });
  });

  it('replaces a server list whole rather than unioning it', () => {
    const base = parsed(doc({ tools: { servers: ['git', 'fs', 'web'] } }));
    const narrow = parsed(doc({ tools: { servers: ['git'] } }));
    expect(resolveAgentSpec([base, narrow]).servers).toEqual(['git']);
    expect(resolveAgentSpec([base, parsed(doc({ tools: { servers: [] } }))]).servers).toEqual([]);
  });

  it('puts a side task on another machine than the main model', () => {
    const spec = parsed(
      doc({
        endpoint: { baseUrl: 'http://192.168.1.40:8080/v1', firstTokenSeconds: 300 },
        model: { model: 'qwen2.5-vl:7b' },
        tasks: {
          compaction: { model: 'qwen3:0.6b', endpoint: { baseUrl: 'http://192.168.1.41:8080/v1' } },
          title: { model: 'qwen3:0.6b' },
        },
      }),
    );
    const { tasks } = resolveAgentSpec([spec]);
    expect(tasks.compaction?.endpoint).toEqual({
      baseUrl: 'http://192.168.1.41:8080/v1',
      apiKey: '',
      firstTokenSeconds: 300,
    });
    // A task that named no endpoint is reached through the agent's.
    expect(tasks.title?.endpoint.baseUrl).toBe('http://192.168.1.40:8080/v1');
  });

  it('lets a layer decline a task a layer below it configured', () => {
    const settings = parsed(doc({ tasks: { toolSelect: { model: 'gpt-4o-mini' }, title: { model: 'qwen3:0.6b' } } }));
    const agent = parsed(doc({ tasks: { toolSelect: { model: '' } } }));
    const resolved = resolveAgentSpec([settings, agent]);
    expect(Object.keys(resolved.tasks)).toEqual(['title']);
    // "" already means don't preselect, so the flattened field says the same thing.
    expect(resolved.toolSelectModel).toBe('');
  });

  it("lets a layer set a task's temperature and leave its model to the layer below", () => {
    // Fields merge across layers before an entry without a model is dropped, so "titles at
    // temperature 0" does not have to repeat the model.
    const settings = parsed(doc({ tasks: { title: { model: 'qwen3:0.6b' } } }));
    const profile = parsed(doc({ tasks: { title: { temperature: 0 } } }));
    expect(resolveAgentSpec([settings, profile]).tasks.title).toEqual({
      model: 'qwen3:0.6b',
      endpoint: { baseUrl: '', apiKey: '' },
      temperature: 0,
    });
    // With no model under it the setting configures nothing, and the task is not there.
    expect(resolveAgentSpec([profile]).tasks).toEqual({});
  });

  it("fills nothing in on a task from the agent's own model", () => {
    const spec = parsed(
      doc({
        model: { model: 'big', temperature: 1, maxTokens: 4096, reasoningEffort: 'high', extraBody: { top_k: 40 } },
        tasks: { title: { model: 'qwen3:0.6b' } },
      }),
    );
    // Absent stays absent, which is what leaves it to the side task's own default.
    expect(resolveAgentSpec([spec]).tasks.title).toEqual({
      model: 'qwen3:0.6b',
      endpoint: { baseUrl: '', apiKey: '' },
    });
  });

  it('merges extraBody and extensions by top-level key', () => {
    const base = parsed(doc({ model: { extraBody: { top_k: 20, min_p: 0.05 } }, extensions: { a: 1, b: 2 } }));
    const over = parsed(doc({ model: { extraBody: { top_k: 40 } }, extensions: { b: 3 } }));
    const resolved = resolveAgentSpec([base, over]);
    expect(resolved.extraBody).toEqual({ top_k: 40, min_p: 0.05 });
    expect(resolved.extensions).toEqual({ a: 1, b: 3 });
  });

  it("merges a task's extraBody by top-level key across the layers", () => {
    const base = parsed(doc({ tasks: { vision: { model: 'qwen', extraBody: { top_p: 0.8, top_k: 20 } } } }));
    const over = parsed(doc({ tasks: { vision: { extraBody: { top_k: 40, presence_penalty: 1.5 } } } }));
    expect(resolveAgentSpec([base, over]).tasks.vision?.extraBody).toEqual({
      top_p: 0.8,
      top_k: 40,
      presence_penalty: 1.5,
    });
    // An empty one adds nothing, and the task carries none.
    const empty = parsed(doc({ tasks: { vision: { model: 'qwen', extraBody: {} } } }));
    expect(resolveAgentSpec([empty]).tasks.vision).not.toHaveProperty('extraBody');
  });

  it('drops the body fields the loop owns or the spec spells from a layer that skipped parseSpec', () => {
    // Built in code, so parseSpec never saw it: the rule has to hold at resolve time as well.
    const owned = {
      temperature: 0.9,
      max_tokens: 9999,
      max_completion_tokens: 1,
      reasoning_effort: 'high',
      stream: false,
    };
    const layer: AgentSpec = {
      spec: AGENT_SPEC,
      model: { model: 'm', temperature: 0, extraBody: { ...owned, top_k: 40 } },
      tasks: { title: { model: 't', extraBody: { ...owned } } },
    };
    const resolved = resolveAgentSpec([layer]);
    expect(resolved.temperature).toBe(0);
    expect(resolved.extraBody).toEqual({ top_k: 40 });
    // Nothing is left, so the task carries none.
    expect(resolved.tasks.title).not.toHaveProperty('extraBody');
  });

  it('unions requires, so a layer above cannot quietly drop one below it', () => {
    const base = parsed(doc({ requires: ['com.example.sandbox'] }));
    const over = parsed(doc({ requires: ['com.example.audit'] }));
    expect(resolveAgentSpec([base, over]).requires).toEqual(['com.example.sandbox', 'com.example.audit']);
  });

  it('merges hooks by id and carries bundled servers through', () => {
    const base = parsed(
      doc({
        hooks: [{ id: 'h1', on: HookEvent.SessionStart, server: 'git', tool: 'status' }],
        bundle: { mcpServers: [{ slug: 'fs', command: 'npx' }] },
      }),
      { bundle: true },
    );
    const over = parsed(
      doc({
        hooks: [{ id: 'h1', on: HookEvent.SessionStart, server: 'git', tool: 'log', enabled: false }],
      }),
    );
    const resolved = resolveAgentSpec([base, over]);
    expect(resolved.hooks).toEqual([
      { id: 'h1', on: HookEvent.SessionStart, server: 'git', tool: 'log', enabled: false },
    ]);
    expect(resolved.mcpServers).toEqual([{ slug: 'fs', command: 'npx' }]);
  });

  it('drops an inject or a veto the merged hook can no longer honour', () => {
    const hook = { id: 'h', server: 'mem', tool: 'recall' };
    const injects = parsed(doc({ hooks: [{ ...hook, on: HookEvent.BeforeExchange, inject: true }] }));
    const vetoes = parsed(doc({ hooks: [{ ...hook, on: HookEvent.BeforeCompact, veto: true }] }));
    const after = parsed(doc({ hooks: [{ ...hook, on: HookEvent.AfterExchange }] }));
    expect(resolveAgentSpec([injects, after]).hooks).toEqual([{ ...hook, on: HookEvent.AfterExchange }]);
    expect(resolveAgentSpec([vetoes, after]).hooks).toEqual([{ ...hook, on: HookEvent.AfterExchange }]);
    // A flag the merged event still honours is kept.
    const sessionStart = parsed(doc({ hooks: [{ ...hook, on: HookEvent.SessionStart }] }));
    expect(resolveAgentSpec([injects, sessionStart]).hooks).toEqual([
      { ...hook, on: HookEvent.SessionStart, inject: true },
    ]);
  });

  it('lets an empty id, name or description override the layer below', () => {
    const base = parsed(doc({ id: 'base', name: 'Base', description: 'Base agent' }));
    const over = parsed(doc({ id: '', name: '', description: '' }));
    expect(resolveAgentSpec([base, over])).toMatchObject({ id: '', name: '', description: '' });
    // Absent still inherits.
    expect(resolveAgentSpec([base, parsed(doc())])).toMatchObject({
      id: 'base',
      name: 'Base',
      description: 'Base agent',
    });
  });

  it('falls back only where no layer said anything', () => {
    const resolved: ResolvedAgent = resolveAgentSpec([parsed(doc())]);
    expect(resolved).toMatchObject({
      baseUrl: '',
      apiKey: '',
      model: '',
      maxTokens: 0,
      temperature: 0.7,
      contextLength: 0,
      toolDiscovery: ToolDiscovery.Eager,
      maxToolIterations: 20,
      maxRetries: 0,
      systemPrompt: '',
    });
    // Absent stays absent rather than becoming a number nobody asked for.
    expect(resolved.requestTimeoutSeconds).toBeUndefined();
    expect(resolved.servers).toBeUndefined();
    expect(resolved.name).toBe('');
  });
});

describe('model.lockedFields', () => {
  /** Settings, an agent that locks, and an app above them, each naming every field it sets. */
  const settings = doc({ model: { model: 'm', temperature: 0.7, maxTokens: 4096, extraBody: { seed: 1 } } });
  const agent = (lockedFields: unknown) =>
    doc({ model: { temperature: 0, extraBody: { seed: 7, top_p: 0.9 }, lockedFields } });
  const app = doc({ model: { temperature: 1, maxTokens: 256, extraBody: { seed: 99, top_p: 0.5 } } });

  it("keeps any name, a provider's own field included, without a warning", () => {
    const result = parseSpec(agent(['temperature', 'max_completion_tokens', 'seed', 'x_provider_mode']));
    expect(result.spec?.model?.lockedFields).toEqual([
      'temperature',
      'max_completion_tokens',
      'seed',
      'x_provider_mode',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('refuses a reserved name, and a list that is not an array', () => {
    expect(parseSpec(agent(['seed', 'stream'])).errors).toEqual([
      `model.lockedFields[1]: "stream" is the loop's to set, so it cannot be locked`,
    ]);
    expect(parseSpec(agent('temperature')).errors).toEqual([
      'model.lockedFields: must be an array of request-field names',
    ]);
  });

  it('warns about a name listed twice, max_tokens and max_completion_tokens being one, and keeps it once', () => {
    const result = parseSpec(agent(['seed', 'max_tokens', 'seed', 'max_completion_tokens', 3]));
    expect(result.spec?.model?.lockedFields).toEqual(['seed', 'max_tokens']);
    expect(result.warnings).toEqual([
      'model.lockedFields[2]: "seed" is listed already, as "seed", and was dropped',
      'model.lockedFields[3]: "max_completion_tokens" is listed already, as "max_tokens", and was dropped',
      'model.lockedFields[4]: must be a string, and was dropped',
    ]);
  });

  it('keeps an empty list as the value it is', () => {
    expect(parsed(agent([])).model?.lockedFields).toEqual([]);
  });

  it('locks nothing when absent, so an app overrides every field', () => {
    const resolved = resolveAgentSpec([parsed(settings), parsed(agent(undefined)), parsed(app)]);
    expect(resolved).toMatchObject({ temperature: 1, maxTokens: 256, extraBody: { seed: 99, top_p: 0.5 } });
    expect(resolved.lockedFields).toEqual([]);
  });

  it("keeps the locking layer's value, or the one below it, over a layer above", () => {
    const locks = ['temperature', 'max_completion_tokens', 'seed'];
    const resolved = resolveAgentSpec([parsed(settings), parsed(agent(locks)), parsed(app)]);
    // max_tokens was never the agent's: the settings' ceiling is what it locked.
    expect(resolved).toMatchObject({ temperature: 0, maxTokens: 4096, extraBody: { seed: 7, top_p: 0.5 } });
    expect(resolved.lockedFields).toEqual(['temperature', 'max_tokens', 'seed']);
  });

  it('cannot be unlocked by a layer above, whose own locks are added', () => {
    const above = doc({ model: { temperature: 1, lockedFields: [], extraBody: { top_p: 0.1 } } });
    const top = doc({ model: { extraBody: { top_p: 0.2 }, lockedFields: ['top_p'] } });
    const resolved = resolveAgentSpec([parsed(agent(['temperature'])), parsed(above), parsed(top)]);
    expect(resolved.temperature).toBe(0);
    // The top layer's lock binds only what is above it, so its own value still lands.
    expect(resolved.extraBody).toEqual({ seed: 7, top_p: 0.2 });
    expect(resolved.lockedFields).toEqual(['temperature', 'top_p']);
  });

  it('never locks a reserved field, even from a layer built in code', () => {
    const resolved = resolveAgentSpec([
      { spec: AGENT_SPEC, model: { model: 'a', lockedFields: ['model'] } },
      { spec: AGENT_SPEC, model: { model: 'b' } },
    ]);
    expect(resolved.model).toBe('b');
    expect(resolved.lockedFields).toEqual([]);
  });

  it('names the locked fields a request sets, as the request spells them', () => {
    const resolved = resolveAgentSpec([parsed(agent(['max_tokens', 'seed', 'temperature']))]);
    const body = { model: 'agent', messages: [], max_completion_tokens: 10, seed: 3, top_p: 1 };
    expect(lockedFieldsIn(resolved, Object.keys(body))).toEqual(['max_completion_tokens', 'seed']);
    // Restating the agent's own value is setting it all the same.
    expect(lockedFieldsIn(resolved, ['temperature'])).toEqual(['temperature']);
    expect(lockedFieldsIn(resolved, [])).toEqual([]);
  });

  it('survives an export and a parse unchanged', () => {
    const spec = parsed(agent(['temperature', 'seed']));
    expect(parsed(exportSpec(spec)).model?.lockedFields).toEqual(['temperature', 'seed']);
  });
});

describe('parseAppParts', () => {
  it("reads a request's parts as a document's, in the order sent", () => {
    const prompt = [
      part('identity', 'Here you review one workflow step.', { mode: PROMPT_MODES.extend }),
      { role: PROMPT_ROLES.developer, name: 'lane', content: 'This is the Review lane.' },
    ];
    expect(parseAppParts(prompt)).toEqual({ parts: prompt, warnings: [] });
    expect(parseAppParts(undefined)).toEqual({ parts: [], warnings: [] });
    expect(parseAppParts(null)).toEqual({ parts: [], warnings: [] });
  });

  it('drops what it cannot use, reading a missing role as system, and never refuses', () => {
    const result = parseAppParts([
      { name: 'lane', content: 'Review.' },
      part('format', 'JSON.', { mode: 'append' }),
      part('rules', 'Be quick.', { allowedModes: [PROMPT_MODES.replace] }),
      part('', 'No name.'),
      { role: PROMPT_ROLES.system, name: 'project' },
      7,
    ]);
    expect(result.parts).toEqual([part('lane', 'Review.'), part('format', 'JSON.'), part('rules', 'Be quick.')]);
    expect(result.warnings).toEqual([
      'prompt[0].role: is missing, and was read as "system"',
      'prompt[1].mode: must be "extend" or "replace", and was dropped',
      "prompt[2].allowedModes: is the agent's to set, and was dropped",
      'prompt[3]: has no name, and merging happens on the name, and was dropped',
      'prompt[4]: has no content, and was dropped',
      'prompt[5]: must be an object, and was dropped',
    ]);
    expect(parseAppParts({ identity: 'x' })).toEqual({
      parts: [],
      warnings: ['prompt: must be an array, and was dropped'],
    });
  });

  it("leaves the app's names to stacking, which prefixes them", () => {
    // `app_lane` is refused in a document; from an app it is only a name, which becomes `app_app_lane`.
    const { parts, warnings } = parseAppParts([part('app_lane', 'Review.'), part('system', 'Today.')]);
    expect(warnings).toEqual([]);
    expect(parts.map((held) => held.name)).toEqual(['app_lane', 'system']);
  });
});
