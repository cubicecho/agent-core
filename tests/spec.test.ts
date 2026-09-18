import { describe, expect, it } from "vitest";
import type { AgentLoopOptions } from "../src/agent-loop.ts";
import { HOOK_EVENTS } from "../src/hooks.ts";
import {
  AGENT_SPEC,
  type AgentSpec,
  exportSpec,
  parseSpec,
  type ResolvedAgent,
  resolveAgentSpec,
  SPEC_EVENTS,
} from "../src/spec.ts";

/** A document that parses cleanly, which each test then bends in one direction. */
const doc = (extra: Record<string, unknown> = {}) => ({ spec: AGENT_SPEC, ...extra });

/** The parsed spec, insisting the document survived so a test never asserts against null. */
function parsed(document: unknown, options?: Parameters<typeof parseSpec>[1]): AgentSpec {
  const result = parseSpec(document, options);
  expect(result.errors).toEqual([]);
  if (!result.spec) throw new Error("unreachable");
  return result.spec;
}

describe("parseSpec", () => {
  it("refuses a document it cannot identify, and nothing else", () => {
    // The four hard errors, each on its own document: everything outside this list drops a field.
    expect(parseSpec(null).errors).toEqual(["spec: must be an object"]);
    expect(parseSpec("{}").errors).toEqual(["spec: must be an object"]);
    expect(parseSpec({}).errors).toEqual([`spec: must be "${AGENT_SPEC}"`]);
    expect(parseSpec({ spec: "openai.assistant/1" }).errors).toEqual([
      `spec: must be "${AGENT_SPEC}"`,
    ]);
    expect(parseSpec({ spec: "cubicecho.agent/2" }).errors).toEqual([
      "spec: is version 2, and this build reads version 1",
    ]);
    expect(parseSpec(doc({ prompt: {} })).errors).toEqual(["prompt: must be an array"]);
    expect(parseSpec(doc({ tasks: [] })).errors).toEqual(["tasks: must be an object"]);
    expect(parseSpec(doc({ hooks: {} })).errors).toEqual(["hooks: must be an array"]);
  });

  it("reports every problem at once rather than one per round trip", () => {
    const result = parseSpec(doc({ model: { temperature: 9, maxTokens: "lots" } }));
    expect(result.spec).not.toBeNull();
    expect(result.warnings).toEqual([
      "model.maxTokens: must be a number, and was dropped",
      "model.temperature: must be between 0 and 2, and was dropped",
    ]);
  });

  it("drops an out-of-range number instead of clamping it", () => {
    // A clamp invents a number the author did not write; dropping falls back to one somebody did.
    const spec = parsed(doc({ model: { model: "m", temperature: 4 } }));
    expect(spec.model).toEqual({ model: "m" });
    expect(spec.model?.temperature).toBeUndefined();
  });

  it("keeps a meaningful zero, because there is no inherit sentinel", () => {
    const spec = parsed(
      doc({
        model: { temperature: 0, maxTokens: 0, contextLength: 0 },
        retry: { maxRetries: 0 },
        endpoint: { baseUrl: "http://box/v1", requestTimeoutSeconds: 0 },
      }),
    );
    expect(spec.model).toEqual({ temperature: 0, maxTokens: 0, contextLength: 0 });
    expect(spec.retry).toEqual({ maxRetries: 0 });
    expect(spec.endpoint?.requestTimeoutSeconds).toBe(0);
  });

  it("reads null as absent, because a nullable column round-trips as null", () => {
    const spec = parsed(doc({ name: null, model: { model: "m", temperature: null } }));
    expect(spec.name).toBeUndefined();
    expect(spec.model).toEqual({ model: "m" });
  });

  it("refuses to carry a credential at any depth", () => {
    const result = parseSpec(doc({ endpoint: { baseUrl: "http://box/v1", apiKey: "sk-live-1" } }));
    expect(result.spec?.endpoint).toEqual({ baseUrl: "http://box/v1" });
    expect(JSON.stringify(result.spec)).not.toContain("sk-live-1");
    expect(result.warnings).toEqual([
      "endpoint.apiKey: is not part of this format — a document carries no credentials, and was dropped",
    ]);
  });

  it("keeps a variable reference as the literal it is, and says so", () => {
    // Never expanded, so the lint rule warning about exactly this shape is the wrong one here.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal is the subject of the test
    const literal = "${OPENAI_BASE_URL}";
    const result = parseSpec(doc({ endpoint: { baseUrl: literal } }));
    expect(result.spec?.endpoint?.baseUrl).toBe(literal);
    expect(result.warnings).toEqual([
      "endpoint.baseUrl: looks like a variable reference, which is never expanded",
    ]);
  });

  it("drops the body fields the loop owns and keeps the rest", () => {
    const result = parseSpec(
      doc({ model: { extraBody: { top_k: 20, min_p: 0.05, id_slot: 3, messages: [] } } }),
    );
    expect(result.spec?.model?.extraBody).toEqual({ top_k: 20, min_p: 0.05, id_slot: 3 });
    expect(result.warnings).toEqual([
      "model.extraBody.messages: is the loop's to set, and was dropped",
    ]);
  });

  it("carries a key from a later 1.x rather than erasing it", () => {
    const result = parseSpec(doc({ id: "a", memory: { store: "vector" } }));
    expect(result.spec?.memory).toEqual({ store: "vector" });
    expect(result.warnings).toEqual([
      "memory: is not a key this version names, and was carried through unread",
    ]);
  });

  it("never warns about extensions, which is the point of them", () => {
    const result = parseSpec(
      doc({ extensions: { "com.cubicecho.min-agent": { speakReplies: false } } }),
    );
    expect(result.warnings).toEqual([]);
    expect(result.spec?.extensions).toEqual({
      "com.cubicecho.min-agent": { speakReplies: false },
    });
  });

  it("refuses a requirement this host does not understand, and allows one it does", () => {
    expect(parseSpec(doc({ requires: ["com.example.sandbox"] })).errors).toEqual([]);
    expect(
      parseSpec(doc({ requires: ["com.example.sandbox"] }), { understands: [] }).errors,
    ).toEqual(['requires[0]: "com.example.sandbox" is not understood by this host']);
    expect(
      parseSpec(doc({ requires: ["com.example.sandbox"] }), {
        understands: ["com.example.sandbox"],
      }).errors,
    ).toEqual([]);
  });
});

describe("parseSpec tools.servers", () => {
  // The single most likely bug: two consumers spell an empty scope in opposite directions today.
  it("keeps absent, empty and a list as three different answers", () => {
    expect(parsed(doc({ tools: { discovery: "eager" } })).tools?.servers).toBeUndefined();
    expect(parsed(doc({ tools: { servers: [] } })).tools?.servers).toEqual([]);
    expect(parsed(doc({ tools: { servers: ["git", "fs"] } })).tools?.servers).toEqual([
      "git",
      "fs",
    ]);
  });

  it("round-trips all three through resolve and back into a document", () => {
    for (const servers of [undefined, [], ["git"]]) {
      const tools = servers === undefined ? { maxIterations: 8 } : { servers };
      const spec = parsed(doc({ tools }));
      const resolved = resolveAgentSpec([spec]);
      expect(resolved.servers).toEqual(servers);
      const again = parsed(
        doc({ tools: { ...(resolved.servers && { servers: resolved.servers }) } }),
      );
      expect(again.tools?.servers).toEqual(servers);
    }
  });
});

describe("parseSpec hooks", () => {
  const hook = (extra: Record<string, unknown>) => ({
    id: "h1",
    server: "git",
    tool: "status",
    ...extra,
  });

  it("reads a hook whole", () => {
    const spec = parsed(
      doc({ hooks: [hook({ on: "sessionStart", inject: true, args: { path: "{{cwd}}" } })] }),
    );
    expect(spec.hooks).toEqual([
      {
        id: "h1",
        on: "sessionStart",
        server: "git",
        tool: "status",
        inject: true,
        args: { path: "{{cwd}}" },
      },
    ]);
  });

  it("drops an inject on an event that runs after the model answered", () => {
    const result = parseSpec(doc({ hooks: [hook({ on: "afterTurn", inject: true })] }));
    expect(result.spec?.hooks?.[0]?.inject).toBeUndefined();
    expect(result.warnings).toEqual([
      'hooks[0].inject: "afterTurn" runs after the model has already answered, and was dropped',
    ]);
  });

  it("drops a veto anywhere but beforeCompact", () => {
    expect(
      parsed(doc({ hooks: [hook({ on: "beforeCompact", veto: true })] })).hooks?.[0]?.veto,
    ).toBe(true);
    expect(
      parsed(doc({ hooks: [hook({ on: "beforeTurn", veto: true })] })).hooks?.[0]?.veto,
    ).toBeUndefined();
  });

  it("notes an event this host never fires rather than refusing the agent", () => {
    // task_server rejects a beforeCompact hook at save time today, which makes a good agent
    // unimportable. The hook is kept; the operator is told.
    const result = parseSpec(doc({ hooks: [hook({ on: "beforeCompact" })] }), {
      events: ["sessionStart", "beforeTurn"],
    });
    expect(result.errors).toEqual([]);
    expect(result.spec?.hooks).toHaveLength(1);
    expect(result.warnings).toEqual(['hooks[0].on: "beforeCompact" is never fired by this host']);
  });

  it("drops a hook that is not an event at all", () => {
    const result = parseSpec(doc({ hooks: [hook({ on: "onTuesday" })] }));
    expect(result.spec?.hooks).toEqual([]);
    expect(result.warnings).toEqual(['hooks[0].on: "onTuesday" is not an event, and was dropped']);
  });

  it("binds to the same events the host side fires", () => {
    // SPEC_EVENTS is restated so this module pulls no `node:crypto`. This is what stops it drifting.
    expect([...SPEC_EVENTS].sort()).toEqual([...HOOK_EVENTS].sort());
  });
});

describe("parseSpec bundle", () => {
  const bundle = {
    mcpServers: [
      {
        slug: "fs",
        label: "Files",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/scans"],
        env: { TOKEN: "sk-live-1" },
        maxResultChars: 40000,
      },
    ],
  };

  it("drops a bundle unless the caller asked for one", () => {
    // Executable by proxy: a bundled server is a command line, so the unsafe path is never default.
    const result = parseSpec(doc({ bundle }));
    expect(result.spec?.bundle).toBeUndefined();
    expect(result.warnings).toEqual([
      "bundle: carries a command line, so it is only read with { bundle: true }, and was dropped",
    ]);
  });

  it("passes a server's unknown keys through untouched", () => {
    // Restating the pool's config would silently delete this server's 40k result cap on a round trip.
    const spec = parsed(doc({ bundle }), { bundle: true });
    expect(spec.bundle?.mcpServers?.[0]).toEqual(bundle.mcpServers[0]);
  });

  it("needs a name, and refuses a second server with the same one", () => {
    const result = parseSpec(
      doc({ bundle: { mcpServers: [{ label: "nameless" }, { slug: "fs" }, { slug: "fs" }] } }),
      { bundle: true },
    );
    expect(result.spec?.bundle?.mcpServers).toEqual([{ slug: "fs" }]);
    expect(result.warnings).toEqual([
      "bundle.mcpServers[0]: needs an id or a slug, and was dropped",
      'bundle.mcpServers[2]: is a second server called "fs", and was dropped',
    ]);
  });
});

describe("exportSpec", () => {
  const spec = parsed(
    doc({
      id: "ocr",
      bundle: {
        mcpServers: [
          { slug: "fs", command: "npx", env: { TOKEN: "sk-live-1" }, headers: { A: "b" } },
        ],
      },
    }),
    { bundle: true },
  );

  it("strips a bundled server's secrets and leaves the server", () => {
    const out = exportSpec(spec);
    expect(out.bundle?.mcpServers).toEqual([{ slug: "fs", command: "npx" }]);
    expect(JSON.stringify(out)).not.toContain("sk-live-1");
  });

  it("keeps them when the caller says so", () => {
    expect(exportSpec(spec, { secrets: true }).bundle?.mcpServers?.[0]?.env).toEqual({
      TOKEN: "sk-live-1",
    });
  });

  it("produces a document that is still a valid spec", () => {
    // The property worth having: redacting must not make an agent unimportable.
    const again = parseSpec(exportSpec(spec), { bundle: true });
    expect(again.errors).toEqual([]);
    expect(again.spec?.id).toBe("ocr");
    expect(again.spec?.bundle?.mcpServers).toEqual([{ slug: "fs", command: "npx" }]);
  });
});

describe("resolveAgentSpec", () => {
  it("is the flat shape the loop already takes", () => {
    const resolved = resolveAgentSpec([parsed(doc({ model: { model: "m" } }))]);
    // The type-level claim the whole design rests on: no adapter between here and the loop.
    const config: AgentLoopOptions["config"] = resolved;
    expect(config.model).toBe("m");
  });

  it("layers settings under an agent, keeping a zero the agent meant", () => {
    const settings = parsed(
      doc({
        endpoint: { baseUrl: "https://api.openai.com/v1", requestTimeoutSeconds: 120 },
        model: { model: "gpt-4o", maxTokens: 8192, temperature: 0.7, contextLength: 128000 },
        tools: { discovery: "eager", maxIterations: 20 },
        tasks: { toolSelect: { model: "gpt-4o-mini" } },
        retry: { maxRetries: 3 },
      }),
    );
    const agent = parsed(
      doc({
        id: "a3f2",
        name: "Reviewer",
        endpoint: { baseUrl: "http://localhost:8080/v1" },
        model: { model: "qwen3-coder:30b", temperature: 0 },
        prompt: [{ id: "identity", text: "You are a careful code reviewer." }],
        tools: { servers: ["git", "fs"] },
      }),
    );

    expect(resolveAgentSpec([settings, agent])).toMatchObject({
      id: "a3f2",
      name: "Reviewer",
      baseUrl: "http://localhost:8080/v1",
      // Its own box, so it gets no key: a document must not be able to point this host's
      // provider key at somebody else's endpoint.
      apiKey: "",
      requestTimeoutSeconds: 120,
      model: "qwen3-coder:30b",
      maxTokens: 8192,
      temperature: 0,
      contextLength: 128000,
      toolDiscovery: "eager",
      toolSelectModel: "gpt-4o-mini",
      maxToolIterations: 20,
      maxRetries: 3,
      systemPrompt: "You are a careful code reviewer.",
      servers: ["git", "fs"],
    });
  });

  it("stacks different prompt ids and replaces a repeated one", () => {
    const base = parsed(
      doc({
        prompt: [
          { id: "project", text: "This is the agent-core library." },
          { id: "identity", text: "You research thoroughly." },
        ],
      }),
    );
    const task = parsed(doc({ prompt: [{ id: "identity", text: "You audit licences." }] }));
    const step = parsed(doc({ prompt: [{ id: "lane", text: "Only the files on the card." }] }));

    const resolved = resolveAgentSpec([base, task, step]);
    expect(resolved.systemPrompt).toBe(
      "This is the agent-core library.\n\nYou audit licences.\n\nOnly the files on the card.",
    );
    expect(resolved.prompt.map((part) => part.id)).toEqual(["project", "identity", "lane"]);
  });

  it("lets an empty text delete a part a layer below contributed", () => {
    const base = parsed(doc({ prompt: [{ id: "lane", text: "Only the card." }] }));
    const over = parsed(doc({ prompt: [{ id: "lane", text: "" }] }));
    expect(resolveAgentSpec([base, over]).systemPrompt).toBe("");
  });

  it("validates a prompt reference without ever resolving it", () => {
    const spec = parsed(
      doc({ prompt: [{ id: "identity", ref: { type: "file", value: "./p.md" } }] }),
    );
    const resolved = resolveAgentSpec([spec]);
    expect(resolved.prompt[0]?.ref).toEqual({ type: "file", value: "./p.md" });
    // Nothing was read, so it contributes no text — the host resolves it and re-resolves.
    expect(resolved.systemPrompt).toBe("");
    expect(
      parseSpec(doc({ prompt: [{ id: "i", ref: { type: "http", value: "x" } }] })).warnings,
    ).toEqual([
      'prompt[0].ref: must be { type: "file" | "url", value }, and was dropped',
      "prompt[0]: has neither text nor a reference, and was dropped",
    ]);
  });

  it("replaces a server list whole rather than unioning it", () => {
    const base = parsed(doc({ tools: { servers: ["git", "fs", "web"] } }));
    const narrow = parsed(doc({ tools: { servers: ["git"] } }));
    expect(resolveAgentSpec([base, narrow]).servers).toEqual(["git"]);
    expect(resolveAgentSpec([base, parsed(doc({ tools: { servers: [] } }))]).servers).toEqual([]);
  });

  it("puts a side task on another machine than the main model", () => {
    const spec = parsed(
      doc({
        endpoint: { baseUrl: "http://192.168.1.40:8080/v1", firstTokenSeconds: 300 },
        model: { model: "qwen2.5-vl:7b" },
        tasks: {
          compaction: { model: "qwen3:0.6b", endpoint: { baseUrl: "http://192.168.1.41:8080/v1" } },
          title: { model: "qwen3:0.6b" },
        },
      }),
    );
    const { tasks } = resolveAgentSpec([spec]);
    expect(tasks.compaction?.endpoint).toEqual({
      baseUrl: "http://192.168.1.41:8080/v1",
      apiKey: "",
      firstTokenSeconds: 300,
    });
    // A task that named no endpoint is reached through the agent's.
    expect(tasks.title?.endpoint.baseUrl).toBe("http://192.168.1.40:8080/v1");
  });

  it("lets a layer decline a task a layer below it configured", () => {
    const settings = parsed(
      doc({ tasks: { toolSelect: { model: "gpt-4o-mini" }, title: { model: "qwen3:0.6b" } } }),
    );
    const agent = parsed(doc({ tasks: { toolSelect: { model: "" } } }));
    const resolved = resolveAgentSpec([settings, agent]);
    expect(Object.keys(resolved.tasks)).toEqual(["title"]);
    // "" already means don't preselect, so the flattened field says the same thing.
    expect(resolved.toolSelectModel).toBe("");
  });

  it("merges extraBody and extensions by top-level key", () => {
    const base = parsed(
      doc({ model: { extraBody: { top_k: 20, min_p: 0.05 } }, extensions: { a: 1, b: 2 } }),
    );
    const over = parsed(doc({ model: { extraBody: { top_k: 40 } }, extensions: { b: 3 } }));
    const resolved = resolveAgentSpec([base, over]);
    expect(resolved.extraBody).toEqual({ top_k: 40, min_p: 0.05 });
    expect(resolved.extensions).toEqual({ a: 1, b: 3 });
  });

  it("unions requires, so a layer above cannot quietly drop one below it", () => {
    const base = parsed(doc({ requires: ["com.example.sandbox"] }));
    const over = parsed(doc({ requires: ["com.example.audit"] }));
    expect(resolveAgentSpec([base, over]).requires).toEqual([
      "com.example.sandbox",
      "com.example.audit",
    ]);
  });

  it("merges hooks by id and carries bundled servers through", () => {
    const base = parsed(
      doc({
        hooks: [{ id: "h1", on: "sessionStart", server: "git", tool: "status" }],
        bundle: { mcpServers: [{ slug: "fs", command: "npx" }] },
      }),
      { bundle: true },
    );
    const over = parsed(
      doc({
        hooks: [{ id: "h1", on: "sessionStart", server: "git", tool: "log", enabled: false }],
      }),
    );
    const resolved = resolveAgentSpec([base, over]);
    expect(resolved.hooks).toEqual([
      { id: "h1", on: "sessionStart", server: "git", tool: "log", enabled: false },
    ]);
    expect(resolved.mcpServers).toEqual([{ slug: "fs", command: "npx" }]);
  });

  it("falls back only where no layer said anything", () => {
    const resolved: ResolvedAgent = resolveAgentSpec([parsed(doc())]);
    expect(resolved).toMatchObject({
      baseUrl: "",
      apiKey: "",
      model: "",
      maxTokens: 0,
      temperature: 0.7,
      contextLength: 0,
      toolDiscovery: "eager",
      maxToolIterations: 20,
      maxRetries: 0,
      systemPrompt: "",
    });
    // Absent stays absent rather than becoming a number nobody asked for.
    expect(resolved.requestTimeoutSeconds).toBeUndefined();
    expect(resolved.servers).toBeUndefined();
    expect(resolved.name).toBe("");
  });
});
