# The agent spec

A versioned JSON document that defines an agent, which any application built on
`@cubicecho/agent-core` can load, validate and run.

This is a design document. Nothing in it is implemented yet; it exists to be agreed before code
is written, because three consumers have to live with the result.

## Why

Four applications sit on this package and each one spells "an agent" differently. `min-agent` has
a singleton settings row and no agent table at all. `kanban_server` has an `agents` table that is
deliberately jobless — its `systemPrompt` carries identity only, and the job arrives from three
other rows at run time. `task_server`'s `agents` is an override profile that resolves into a whole
synthesised settings object. None of the three can read another's agents, and there is no way to
hand an agent to another person.

Three clashes make that more than an inconvenience.

**"Inherit" is spelled three ways.** `maxTokens: 0` means *no ceiling* in `task_server`, *inherit
from settings* in `kanban_server`, and *a real ceiling of zero* in `min-agent`. `kanban_server`
needs both `0` and `-1` as sentinels because two of its numbers have a meaningful zero, and
`temperature: -1` exists only so that a deliberate `temperature: 0` survives the merge.

**An empty server list is inverted.** Empty means *no tools at all* in `kanban_server` and *every
enabled server* in `task_server`. The same stored value, opposite behaviour, in two applications
that share a runtime.

**`extraBody` is unpersisted everywhere.** No consumer can store `top_k`, `min_p`,
`repeat_penalty` or llama.cpp's `id_slot` — the fields that actually stop a small local model
looping — even though `ModelParams` has carried `extraBody` since the config seam was drawn.

There is nothing to adopt instead. Agent Plugins 1.0 standardised agent *packaging* and left agent
*definitions* out on purpose. OpenAI's Assistants API, the closest thing to a vendor-blessed JSON
agent object, shut down in August 2026, with Agent Builder following; Bedrock Agents Classic is
closed to new customers. Both vendors retreated from a declarative agent object back to code. A2A's
Agent Card describes an agent you *talk to* rather than one you *build*, and carries no model, no
prompt, no tools and no limits. The gap is real and nobody is going to close it for us.

## The file

`<name>.agent.json`, declaring itself with one token. `agents.json` and `agent.json` are both taken
several times over in the wider ecosystem, so neither is used here.

```ts
/** The token a document declares itself with. A loader refuses anything else. */
export const AGENT_SPEC = "cubicecho.agent/1";

/** The major version `AGENT_SPEC` pins. Raised only when a field changes meaning. */
export const AGENT_SPEC_VERSION = 1;

/** The side tasks this package has code for. Documentation and UI order, not a validator. */
export const AGENT_TASKS = ["compaction", "toolSelect", "title", "followups"] as const;
```

## The shape

```ts
export interface AgentSpec {
  /** Exactly `AGENT_SPEC`. Missing, mistyped or another major is refused. */
  spec: typeof AGENT_SPEC;
  /** A URL for an editor's autocompletion. Never fetched, never read, never validated against. */
  $schema?: string;

  /** A stable handle within a host: `reviewer`, `local-qwen`. Absent in a layer of pure defaults. */
  id?: string;
  /** What a person calls it. Absent falls back to `id`. */
  name?: string;
  /** One line for an operator choosing between agents. Never sent to a model — that is `prompt`. */
  description?: string;

  endpoint?: EndpointSpec;
  model?: ModelSpec;
  /** Ordered layers of system prompt, merged by `id` and joined with blank lines on resolve. */
  prompt?: PromptPart[];
  tools?: ToolsSpec;
  retry?: RetrySpec;
  /** Side tasks run on a model other than the agent's. Open by design; see `AGENT_TASKS`. */
  tasks?: Record<string, TaskSpec>;
  hooks?: AgentHook[];
  /** Definitions carried so an agent travels whole. Executable by proxy; see Trust. */
  bundle?: SpecBundle;

  /** Host payloads keyed by reverse domain. Carries no semantics and is never validated. */
  extensions?: Record<string, unknown>;
  /** Extension keys a host must understand, or it refuses to run this agent. */
  requires?: string[];
}

export interface EndpointSpec {
  /** Any OpenAI-compatible base URL. Absent inherits; absent everywhere means it cannot run. */
  baseUrl?: string;
  /** Seconds of silence allowed between chunks. Zero is no limit. */
  requestTimeoutSeconds?: number;
  /** Seconds allowed for the first chunk. Zero is no limit; absent is five times the above. */
  firstTokenSeconds?: number;
  // There is no credential field here, or at any other depth. See Secrets.
}

export interface ModelSpec {
  /** Absent inherits. Empty names no model, which cannot run. */
  model?: string;
  /** The reply's ceiling. Zero sends none and lets the server decide — a value, not a sentinel. */
  maxTokens?: number;
  /** Zero to two. Zero means zero. */
  temperature?: number;
  /** `reasoning_effort`. `"off"` and `""` send nothing; any other string passes through. */
  reasoningEffort?: string;
  /** What the operator says this model reads, in tokens. Zero asks the endpoint. */
  contextLength?: number;
  /** Request fields the interface cannot spell. `model`, `messages`, `stream`, `tools` are dropped. */
  extraBody?: Record<string, unknown>;
}

export interface PromptPart {
  /** Names this layer: `project`, `identity`, `role`, `lane`. Merging happens on it. */
  id: string;
  /** The text. Empty deletes the part a layer below contributed. Absent only when `ref` is given. */
  text?: string;
  /** Where the text lives instead. The shape is validated; the reference is never resolved. */
  ref?: { type: "file" | "url"; value: string };
}

export interface ToolsSpec {
  discovery?: "eager" | "ondemand";
  /** The hard stop on a tool loop. At least one. */
  maxIterations?: number;
  /**
   * The MCP servers this agent may reach, by effective slug (`row.slug ?? row.id`).
   * Absent is every server the host offers, `[]` is none, and a list is exactly those.
   * Three different answers, and a loader must never collapse one into another.
   */
  servers?: string[];
}

export interface RetrySpec {
  /** Re-sends of a request lost before the model produced anything. Zero is none — a value. */
  maxRetries?: number;
  /** Seconds to wait out a server loading its model. Zero is not at all; absent is two minutes. */
  loadingTimeoutSeconds?: number;
}

export interface TaskSpec {
  /** The model for this task. Empty turns it off, which is how a layer declines one below it. */
  model?: string;
  /** Where that model lives, when it is not on the agent's endpoint. */
  endpoint?: EndpointSpec;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
}

export interface AgentHook {
  /** Unique within the agent. Merging happens on it. */
  id: string;
  /** One of `HOOK_EVENTS`. An event this host never fires is a warning, not an error. */
  on: HookEvent;
  /** The server whose tool this is, by effective slug. */
  server: string;
  /** The server's own name for the tool, not the qualified one the model sees. */
  tool: string;
  /** Arguments as JSON, with `{{path}}` placeholders filled from the event's context. */
  args?: unknown;
  /** Hand what the tool returns to the model. Only `INJECT_EVENTS` may. */
  inject?: boolean;
  /** Let this hook decline what its event announces. `beforeCompact` only. */
  veto?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  /** `false` keeps the hook in the document without running it. */
  enabled?: boolean;
}

export interface SpecBundle {
  /**
   * Full MCP server definitions. Validated only as far as a round trip needs — an object, a
   * non-empty `id` or `slug`, no duplicate slugs — with every other key passed through untouched.
   * `env` and `headers` are stripped on export.
   */
  mcpServers?: Array<{ id?: string; slug?: string; [key: string]: unknown }>;
}
```

A document with every field set, as an operator would read it:

```jsonc
{
  "spec": "cubicecho.agent/1",
  "$schema": "https://cubicecho.dev/agent-spec/1.json",

  "id": "reviewer",
  "name": "Reviewer",
  "description": "Reads a diff and reports defects. Local model, git and files only.",

  "endpoint": {
    "baseUrl": "http://localhost:8080/v1",
    "requestTimeoutSeconds": 120,
    "firstTokenSeconds": 300
  },

  "model": {
    "model": "qwen3-coder:30b",
    "maxTokens": 8192,
    "temperature": 0,
    "reasoningEffort": "off",
    "contextLength": 128000,
    "extraBody": { "top_k": 20, "min_p": 0.05 }
  },

  "prompt": [
    { "id": "identity", "text": "You are a careful code reviewer." },
    { "id": "role", "ref": { "type": "file", "value": "./prompts/review.md" } }
  ],

  "tools": { "discovery": "eager", "maxIterations": 20, "servers": ["git", "fs"] },
  "retry": { "maxRetries": 3, "loadingTimeoutSeconds": 120 },

  "tasks": {
    "compaction": {
      "model": "qwen3:0.6b",
      "endpoint": { "baseUrl": "http://192.168.1.41:8080/v1" },
      "maxTokens": 1024
    },
    "toolSelect": { "model": "gpt-4o-mini" }
  },

  "hooks": [
    {
      "id": "remember",
      "on": "beforeTurn",
      "server": "memory",
      "tool": "recall",
      "args": { "query": "{{prompt}}" },
      "inject": true,
      "timeoutMs": 5000,
      "enabled": true
    }
  ],

  "bundle": {
    "mcpServers": [
      {
        "slug": "fs",
        "label": "Files",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/work"]
      }
    ]
  },

  "extensions": { "com.cubicecho.kanban": { "laneId": "review" } },
  "requires": []
}
```

## What resolution produces

A document nests because that is how a person reads it, and how `src/config.ts` already groups the
fields. Resolution flattens, because that is what the loop takes.

```ts
export interface ResolvedAgent extends AgentConfig {
  id: string;
  name: string;
  description: string;
  /** The tri-state preserved: absent is every server, empty is none. */
  servers?: readonly string[];
  /** Only the tasks the spec configured. `toolSelect`'s model also flattens to `toolSelectModel`. */
  tasks: Readonly<Record<string, ResolvedTask>>;
  hooks: readonly AgentHook[];
  extensions: Readonly<Record<string, unknown>>;
}

export interface ResolvedTask {
  model: string;
  /** This task's endpoint, which is the agent's unless the spec named another. */
  endpoint: Endpoint;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
}
```

`ResolvedAgent extends AgentConfig` (`src/config.ts:108`), so it already satisfies
`AgentLoopOptions["config"]` (`src/agent-loop.ts:241-245`) structurally. `getClient(resolved)` and
`runAgentLoop({ config: resolved })` take it unchanged and no adapter export is needed. The config
seam survives on one rule: the spec module imports from `config.ts`, and nothing else in `src/`
imports from the spec module.

## Absent, present, empty

**Inherit is an absent field, and nothing else means inherit.** `0`, `-1`, `""` and `[]` are values
that mean what they say. `null` reads as absent, because a nullable column round-trips through JSON
as `null` and refusing it would make every host write a stripper first.

| Field | absent | present | its empty value |
| --- | --- | --- | --- |
| `endpoint.baseUrl` | inherit | this endpoint | `""` — names none, cannot run |
| `endpoint.requestTimeoutSeconds` | inherit; nowhere is no limit | this many seconds | `0` — no limit |
| `endpoint.firstTokenSeconds` | inherit; nowhere is five times the above | this many | `0` — no limit |
| `model.model` | inherit | this model | `""` — names none, cannot run |
| `model.maxTokens` | inherit | this ceiling | `0` — send none, the server decides |
| `model.temperature` | inherit | this temperature | `0` — deterministic, not inherit |
| `model.contextLength` | inherit | this window | `0` — ask the endpoint |
| `model.extraBody` | inherit | merged key by key | `{}` — adds nothing |
| `prompt` | inherit | merged by part id | `[]` — adds nothing; `text: ""` deletes a part |
| `tools.servers` | **every server** | exactly these | `[]` — **no servers** |
| `tools.discovery` | inherit; nowhere is `eager` | as stated | — |
| `retry.maxRetries` | inherit; nowhere is `0` | this many | `0` — no retries |
| `tasks.<key>` | not configured | configured | `model: ""` — the task is off |
| `hooks` | inherit | merged by hook id | `[]` — adds none; `enabled: false` stops one |
| `requires` | nothing required | all must be understood | `[]` — nothing required |

An absent `tasks` key means the spec does not configure that task — not "use the main model".
That fallback is policy, and this package holds no policy.

## Layering

Hosts hand the resolver an ordered list of documents, weakest first: settings, then the agent, then
a task, then a step. Scalars take the last layer that has the key. `extraBody` and `extensions`
merge by top-level key. `prompt`, `hooks` and `tasks` merge by id, ordered by first appearance.
`tools.servers` replaces whole, since a tri-state cannot be unioned. `requires` unions, so a layer
above cannot quietly drop a requirement below it.

There is no `extends` field and no URL resolution: the package never fetches a layer. Which
documents layer is the host's call, the same answer `resolveApiKey` already gives about keys.

Merging by part id is what lets one rule express two behaviours that look unrelated today.
Different ids stack, which is `kanban_server` composing project, identity, role and lane. The same
id replaces, which is `task_server`'s settings to task to step chain. Neither host branches on
anything, and the join is `parts.map(trim).filter(Boolean).join("\n\n")` — byte-identical to
`systemPromptFor` today, so four sources survive a round trip instead of flattening into one blob
nobody can edit a third of.

## Servers, in two layers

The core document references servers by **effective slug**, `row.slug ?? row.id`. A slug exists in
all four repositories and is already what the model sees as `<slug>__<tool>`; a uuid is not
portable between two databases. Narrowing never widens: an unresolvable slug is dropped with a
warning, and if that empties a non-empty list the agent runs with no tools rather than falling back
to "all". Getting that backwards is how a scoped agent silently gains every tool on the box.

The optional `bundle.mcpServers` carries full definitions for an agent that must travel whole.
This package deliberately does **not** restate `McpServerConfig`. Restating a union it never reads
is a version-skew generator — the pool already carries `coerceArguments`, `maxResultChars` and
three separate timeouts, and a strict parse here would silently delete a server's ninety-second
call timeout on a round trip. Importing the pool's type is not an option either, since
`agent-mcp-pool` pulls the MCP SDK and this package keeps `openai` as its only peer dependency. The
cost, stated plainly: no editor completion on `command` or `url` inside a bundle, and one cast at
the line where a host hands them to the pool.

## Trust

A bundle carries a command line and an environment map, so loading one is equivalent to running a
program. It is exactly as dangerous as pasting somebody's `.mcp.json`, and hosts must gate import
behind the same decision.

There is **no credential field at any depth**, and a `${VAR}`-shaped string is never expanded — it
is kept as the literal it is and warned about. Interpolation is the universal prior art and the
weakest part of it: it hands whoever wrote the document the ability to read any variable the
process has, which is why the tools that support it need a credential denylist bolted on. A format
without interpolation needs no denylist. The attack this closes is a confused deputy — a document
naming `https://attacker.example/v1` that causes the host's own provider key to be sent there.

Resolution therefore yields `apiKey: ""`, which `getClient` turns into `NO_KEY` (`src/client.ts:10`).
A host that wants inheritance applies `resolveApiKey` (`src/agent-loop.ts:140`) afterwards — the
existing seam, deliberately not applied by the loop, unchanged. `exportSpec(spec, { secrets })`
mirrors `state({ secrets })` in the pool and strips every bundled server's `env` and `headers`,
with the property that **a redacted spec is still a valid spec**.

## Validation

Hand-rolled guards in the house style of `src/snapshot.ts`, reporting every problem at once in the
message shape `validateHooks` already uses (`temperature: must be between 0 and 2`), and
importable in a browser.

There are exactly four hard errors, all of them about the document rather than a value: it is not
an object; the `spec` token is missing or unrecognised; a `requires` entry is not understood; a
container is of the wrong kind, meaning `prompt` is not an array, `tasks` is not an object, or
`hooks` is not an array. Everything else drops the offending field and warns — the lesson
`coerceLlmConfig` learned the hard way when a stored out-of-range value stopped a server booting.

Out-of-range values are **dropped, not clamped**. A clamp invents a number the author did not
write, while dropping falls back to one somebody did. That is also the strongest argument for the
no-sentinel rule: with sentinels, an invalid field degrades to a default nobody chose; without
them, it degrades to the layer below.

Version handling is the deliberate opposite of `importCapabilities` (`src/snapshot.ts:128`), which
shrugs at a foreign version and returns `false`. *Degrade where the loss is performance; refuse
where the loss is identity.* A snapshot of the wrong version costs a few refused requests; an agent
of the wrong version is not the agent the author described. Additive optional fields need no bump,
per the same snapshot precedent.

`requires` is A2A's `AgentExtension.required` trimmed to its one working part. A host declares the
extension keys it understands, an unrecognised entry refuses the load, and an agent that must not
run without its sandbox extension can say so. It fails closed.

Unknown keys are ignored, warned about, and **never dropped from storage**. A host stores the
document as received and resolves on read, so a key from a later 1.x survives an edit-and-export
cycle instead of being erased by the first host that opens it. `extensions` is the escape hatch
that never warns.

A hook bound to an event this host never fires is a note rather than an error. `task_server`
currently refuses to save a `beforeCompact` hook because it never compacts, which makes an
otherwise good agent unimportable. The validator takes the host's fired-event set, defaulting to
`HOOK_EVENTS`, and warns.

## Side tasks

`tasks` generalises `min-agent`'s `taskModels`, and each entry may carry **its own endpoint** —
because every side task in this package already takes one: `summariser` (`src/compaction.ts:232`),
`preselect` (`src/agent-loop.ts`) and `ask` (`src/side-task.ts`). A 1.5B titler on a local
llama.cpp beside a frontier main model is expressible here, and no published format serves it. An
unknown task key is carried through untouched and not warned about, since a host may run tasks this
package has never heard of. `toolSelectModel` flattens from `tasks.toolSelect?.model ?? ""`, where
`""` already means do not preselect.

## Out of scope

Host scheduling, worker intervals, triggers, steps and decision trees, lanes, roles, boards,
projects, retention, pricing, voice and session state. Those are the parts that differ between one
server and the next, which is the same line `src/index.ts` already draws around this package.
Anything that must travel with a document goes in `extensions`.

Also out: agent-to-agent delegation, tool schemas, memory, evaluation, and — for now — compaction
thresholds, which wait until the `runCompaction` API stops moving.

## Worked examples

### min-agent, as it stands today

No agent table, one settings row, and everything this package does not name riding in `extensions`.

```jsonc
{
  "spec": "cubicecho.agent/1",
  "id": "default",
  "name": "min-agent",

  "endpoint": { "baseUrl": "http://localhost:11434/v1" },
  "model": {
    "model": "qwen3:8b", "maxTokens": 4096, "temperature": 0.7,
    "reasoningEffort": "off",
    "contextLength": 0            // ask the server; stored as `contextLimit` today
  },

  "prompt": [
    { "id": "identity", "text": "You are min-agent, a concise and careful assistant." }
  ],

  "tools": { "discovery": "ondemand", "maxIterations": 20 },
  //        no `servers` key at all, which is how "this host has no scoping" is spelled

  "tasks": {
    "compaction": { "model": "qwen3:1.7b" },
    "toolSelect": { "model": "qwen3:1.7b" },
    "title":      { "model": "qwen3:0.6b" },
    "followups":  { "model": "" }          // off
  },

  "extensions": {
    "com.cubicecho.min-agent": {
      "pricing": { "inputPer1M": 0, "outputPer1M": 0 },
      "voiceBaseUrl": "", "sttModel": "", "ttsModel": "", "ttsVoice": "", "speakReplies": false
    }
  }
}
```

`taskModels` becomes `tasks` and is now expressible by the other two applications; voice and
pricing survive a round trip without this package ever naming them; and `min-agent` gains a home
for `extraBody`.

### kanban_server, showing the layering

The settings row:

```jsonc
{
  "spec": "cubicecho.agent/1",
  "endpoint": { "baseUrl": "https://api.openai.com/v1", "requestTimeoutSeconds": 120 },
  "model": { "model": "gpt-4o", "maxTokens": 8192, "temperature": 0.7, "contextLength": 128000 },
  "tools": { "discovery": "eager", "maxIterations": 20 },
  "tasks": { "toolSelect": { "model": "gpt-4o-mini" } },
  "retry": { "maxRetries": 3 }
}
```

The agent row. Today it stores `temperature: -1`, `maxTokens: 0`, `maxRetries: -1`,
`contextLength: 0` and `toolDiscovery: "inherit"` to mean "do not change these". Here it simply
does not mention them:

```jsonc
{
  "spec": "cubicecho.agent/1",
  "id": "a3f2...", "name": "Reviewer",
  "endpoint": { "baseUrl": "http://localhost:8080/v1" },      // its own box
  "model": { "model": "qwen3-coder:30b", "temperature": 0 },  // zero is meant, not inherit
  "prompt": [ { "id": "identity", "text": "You are a careful code reviewer." } ],
  "tools": { "servers": ["git", "fs"] }
}
```

Resolved:

```jsonc
{
  "baseUrl": "http://localhost:8080/v1",
  "apiKey": "",              // its own baseUrl, so it does not inherit the OpenAI key
  "requestTimeoutSeconds": 120,
  "model": "qwen3-coder:30b",
  "maxTokens": 8192,
  "temperature": 0,          // the agent meant zero
  "contextLength": 128000,
  "toolDiscovery": "eager",
  "toolSelectModel": "gpt-4o-mini",
  "maxToolIterations": 20,
  "maxRetries": 3,
  "systemPrompt": "You are a careful code reviewer."
}
```

`temperature: 0` survives, which is the exact bug the `-1` sentinel exists to dodge. The agent
points at its own server, so it gets no key rather than somebody else's. And the resolved object is
the flat shape `runAgentLoop` already takes.

The job then composes on top as parts rather than one string:

```jsonc
"prompt": [
  { "id": "project",  "text": "This is the agent-core library. ESM, Node 22." },
  { "id": "identity", "text": "You are a careful code reviewer." },
  { "id": "role",     "text": "Review the diff. Report defects, not style." },
  { "id": "lane",     "text": "Only the files named on the card." }
]
```

Joined with blank lines that is byte-identical to today's output, but an exported agent can now be
edited a third at a time.

### task_server, four layers deep

```jsonc
// the agent profile
{ "spec": "cubicecho.agent/1", "id": "researcher",
  "model": { "model": "gpt-4o" },
  "prompt": [ { "id": "main", "text": "You research thoroughly and cite sources." } ],
  "tools": { "servers": ["web", "fs"] } }

// the task overrides the prompt
{ "spec": "cubicecho.agent/1",
  "prompt": [ { "id": "main", "text": "You are auditing dependency licences." } ] }

// the step overrides the model alone
{ "spec": "cubicecho.agent/1", "model": { "model": "gpt-4o-mini" } }
```

Resolves to `gpt-4o-mini`, the task's prompt, and the profile's servers. Replacement and
composition are the same rule seen from two angles.

### A shareable agent, self-contained

```jsonc
{
  "spec": "cubicecho.agent/1",
  "id": "ocr-desk",
  "name": "OCR desk",
  "description": "Transcribes scanned pages. Vision model on a local box.",

  "endpoint": { "baseUrl": "http://192.168.1.40:8080/v1", "firstTokenSeconds": 300 },
  //                                    prefill on a CPU box is minutes ^

  "model": {
    "model": "qwen2.5-vl:7b", "maxTokens": 2048, "temperature": 0.2, "contextLength": 32768,
    "extraBody": { "top_k": 20, "min_p": 0.05, "id_slot": 3 }
    //             none of which can be saved anywhere today ^
  },

  "prompt": [
    { "id": "identity", "ref": { "type": "file", "value": "./prompts/ocr.md" } }
  ],

  "tools": { "servers": ["fs"], "maxIterations": 8 },

  "tasks": {
    "compaction": {
      "model": "qwen3:0.6b",
      "endpoint": { "baseUrl": "http://192.168.1.41:8080/v1" }   // a different machine
    }
  },

  "bundle": {
    "mcpServers": [
      { "slug": "fs", "label": "Files", "transport": "stdio",
        "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/scans"] }
      // no `env`, no `headers` — stripped on export
    ]
  },

  "requires": []
}
```

A side task on a different machine from the main model, which no published format can express; a
reference this package validates and never resolves; and a bundle, which is the part that needs an
explicit trust decision before it is parsed.

## Coverage

| Thing | Covered | Where |
| --- | --- | --- |
| `min-agent`'s `taskModels` | yes | `tasks`, now open-ended |
| `min-agent`'s voice and pricing | yes | `extensions`, carried untouched |
| `kanban_server`'s identity-versus-job split | yes | `prompt` parts by id |
| `kanban_server`'s "no servers means no tools" | yes | `servers: []` |
| `task_server`'s "no servers means all" | yes | `servers` absent |
| `task_server`'s per-task and per-step overrides | yes | more layers, one function |
| `extraBody` | yes | the first place it can be stored |
| A side-task model on another host | yes | `tasks.<key>.endpoint` |
| Sentinel confusion | yes | absent inherits, and nothing else does |
| API keys | no, by design | no field; the host applies `resolveApiKey` after |
| Lanes, roles, triggers, retention | no, by design | host tables, or `extensions` |
| Compaction thresholds | not yet | deferred |

## Open questions

**Agent-level hooks in version 1 at all?** The pool puts hooks on server rows, shared by every
agent. Agent-level hooks are new capability, and the merge rule means an imported agent can add
tool calls the operator never configured.

**Bundle parsing.** Should the parser refuse a bundle unless the caller opts in, as
`parseSpec(document, { bundle: true })`, so that the unsafe path is never the default?

**Server identity.** Slug alone is portable; `{ slug, id? }` would make an intra-host round trip
lossless. Carrying both invites a host to prefer the id and lose portability quietly.

**Un-setting an inherited `extraBody` key.** A key-by-key merge gives no way to remove one. Is this
the single place `null` should mean "remove" rather than "absent"?

**A `.agent.md` surface form**, frontmatter plus body, parsing to the same object — a consumer's
business, or never?

## Before any of this is implemented

The design is checked against the real rows first, on paper, because that is far cheaper than
finding out afterwards.

Take a real `kanban_server` settings row and agent row and hand-resolve them through these rules;
the result must match what `resolveAgent` produces today, including the case where the agent names
its own `baseUrl` and gets `NO_KEY` rather than the inherited key. Repeat for `task_server`'s
`resolveConfig` across its sentinel matrix, and for a `min-agent` settings row round-tripping back
through `coerceLlmConfig` without a warning. If any of the three disagrees, the design is wrong.

The tri-state round trip is the likeliest single bug, since it is inverted between two consumers
today: `kanban_server`'s empty join must become `[]` and then no tools, while `task_server`'s null
`mcpServerIds` must become absent and then every server.

And the type-level claim the implementation carries as a test:
`ResolvedAgent satisfies AgentLoopOptions["config"]`. If that line cannot be written, the flat
resolution is wrong and an adapter is needed after all.
