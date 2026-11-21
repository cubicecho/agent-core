# The agent spec

A versioned JSON document that defines an agent, which any application built on
`@cubicecho/agent-core` can load, validate and run.

It is implemented in `src/spec/`. `parseSpec` reads a document, `resolveAgentSpec` layers documents
into the flat config the loop takes, `exportSpec` and `findSpecSecrets` prepare one to leave the
host, and `defineSpecColumns` maps an app's stored row to a layer and back.

**This page describes version 2, `cubicecho.agent/2`, which the code implements.** Version 1 is
kept as a record in [`agent-spec-v1.md`](agent-spec-v1.md). What changed is under
[Version 2](#version-2). How an agent's parts are stacked with an app's and
written for the model is [`agent-prompt-spec-v2.md`](agent-prompt-spec-v2.md).

## Why

Apps built on this package each spell "an agent" differently. One keeps a single settings row
and no agent table at all. Another has an `agents` table that is deliberately jobless: its system
prompt carries identity only, and the job arrives from other rows at run time. A third keeps an
override profile that resolves into a whole synthesised settings object. None can read another's
agents, and there is no way to hand an agent to another person.

Three clashes make that more than an inconvenience.

**"Inherit" is spelled three ways.** `maxTokens: 0` can mean *no ceiling* in one app, *inherit from
settings* in another, and *a real ceiling of zero* in a third. An app whose numbers have a
meaningful zero ends up with `0` and `-1` as sentinels, and `temperature: -1` exists only so that a
deliberate `temperature: 0` survives the merge.

**An empty server list is inverted.** Empty can mean *no tools at all* in one app and *every
enabled server* in another. The same stored value, opposite behaviour, in two applications that
share a runtime.

**`extraBody` goes unstored.** Without a document, an app has nowhere to keep `top_k`, `min_p`,
`repeat_penalty` or llama.cpp's `id_slot` — the fields that actually stop a small local model
looping — even though `ModelParams` has carried `extraBody` since the config seam was drawn.

How particular apps map onto this format is in
[`prompt-implementations.md`](prompt-implementations.md).

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
export const AGENT_SPEC = "cubicecho.agent/2";

/** The major version `AGENT_SPEC` pins. Raised only when a field changes meaning. */
export const AGENT_SPEC_VERSION = 2;

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
  /** Ordered layers of system prompt, merged by part `name`. */
  prompt?: PromptPart[];
  /** How the parts are written for the model. Absent inherits; nowhere is `plain`. */
  promptLayout?: "plain" | "markdown" | "xml";
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

  /** Keys from a later 2.x, kept so an edit-and-export cycle does not erase them. */
  [key: string]: unknown;
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
  /** Which assistant messages replay the model's scratchpad. Absent is `all`. */
  reasoningReplay?: 'tool-loop' | 'all' | 'none';
  /** What the operator says this model reads, in tokens. Zero asks the endpoint. */
  contextLength?: number;
  /**
   * Request fields the interface cannot spell. `model`, `messages`, `stream` and `tools` are
   * dropped, and so are `temperature`, `max_tokens`, `max_completion_tokens` and
   * `reasoning_effort`, which the fields above spell: on parse, and again on resolve.
   */
  extraBody?: Record<string, unknown>;
  /**
   * Request fields a layer above this one may not change, by their wire names: `temperature`,
   * `max_tokens` (which covers `max_completion_tokens`), `reasoning_effort`, or any key that would
   * go in `extraBody`, such as `top_p`, `seed` or a provider's own field. Absent locks nothing:
   * every field is open by default.
   */
  lockedFields?: string[];
}

export interface PromptPart {
  /** As a chat message's. Both are written into the system prompt the same way. */
  role: "system" | "developer";
  /**
   * What the part is for: `identity`, `rules`, `format`, `lane`. Merging happens on it. A name
   * whose first word is `app` (`app_lane`, `app-lane`) is refused: that prefix is an app's.
   */
  name: string;
  /** The text. Empty deletes the part a layer below contributed, and every part that names it. */
  content: string;
  /**
   * How it changes the part below with its name. `extend` adds a part of its own marked as
   * adding to it; `replace`, one marked as taking its place. Absent overwrites in place.
   */
  mode?: "extend" | "replace";
  /** The modes an app may use on this part. Absent is `["extend"]`; `[]` locks it. */
  allowedModes?: Array<"extend" | "replace">;
}

export interface ToolsSpec {
  /**
   * How tool definitions reach the model: all of them on every request, a name-only catalogue
   * the model loads from, or that catalogue behind a fixed `load_tools` and `call_tool`.
   */
  discovery?: "eager" | "ondemand" | "proxy";
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
  /** As `model.extraBody`, for this task alone, and dropping the same fields. */
  extraBody?: Record<string, unknown>;
}

export interface AgentHook {
  /** Unique within the agent. Merging happens on it. */
  id: string;
  /** One of `SPEC_EVENTS`. An event this host never fires is a warning, not an error. */
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
  "spec": "cubicecho.agent/2",
  "$schema": "https://cubicecho.dev/agent-spec/2.json",

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
    "extraBody": { "top_k": 20, "min_p": 0.05 },
    "lockedFields": ["temperature", "top_k"]
  },

  "prompt": [
    { "role": "system", "name": "identity", "content": "You are a careful code reviewer." },
    { "role": "system", "name": "rules", "content": "Review the diff. Report defects, not style.", "allowedModes": ["extend"] }
  ],
  "promptLayout": "xml",

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
      "on": "beforeExchange",
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

  "extensions": { "com.example.board": { "laneId": "review" } },
  "requires": []
}
```

## What resolution produces

A document nests because that is how a person reads it, and how `src/core/config.ts` already groups the
fields. Resolution flattens, because that is what the loop takes.

```ts
export interface ResolvedAgent extends AgentConfig {
  id: string;
  name: string;
  description: string;
  /** The tri-state preserved: absent is every server the host offers, empty is none. */
  servers?: readonly string[];
  /** The merged prompt parts, in order, without the deleted ones; `systemPrompt` joins them. */
  prompt: readonly PromptPart[];
  /** The merged layout; `plain` where no layer set one. */
  promptLayout: "plain" | "markdown" | "xml";
  /** Only the tasks a layer configured and none declined. `toolSelect` also flattens to `toolSelectModel`. */
  tasks: Readonly<Record<string, ResolvedTask>>;
  /** Merged by id, less an `inject` or a `veto` the merged hook's event cannot honour. */
  hooks: readonly AgentHook[];
  /** Bundled server definitions, merged by effective slug. Empty unless a bundle was parsed. */
  mcpServers: readonly SpecServer[];
  extensions: Readonly<Record<string, unknown>>;
  /** Every layer's requirements, unioned, so a layer above cannot quietly drop one below it. */
  requires: readonly string[];
  /** Every layer's `model.lockedFields`, unioned, less the reserved fields; `max_tokens` for both spellings. */
  lockedFields: readonly string[];
}

export interface ResolvedTask {
  model: string;
  /** This task's endpoint, which is the agent's unless the spec named another. */
  endpoint: Endpoint;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  /** Merged key by key across the layers. The agent's `model.extraBody` never reaches it. */
  extraBody?: Record<string, unknown>;
}
```

`ResolvedAgent extends AgentConfig` (`src/core/config.ts`), so it already satisfies
`AgentLoopOptions["config"]` (`src/run/agent-loop.ts`) structurally. `getClient(resolved)` and
`runAgentLoop({ config: resolved })` take it unchanged and no adapter export is needed. The config
seam survives on one rule: the spec module imports only modules that need nothing from Node and
import nothing themselves (`core/config.ts`, `core/guards.ts`, `hooks/hook-events.ts`), and nothing
outside `src/spec/` imports it but `src/index.ts`.

The result is always whole. `apiKey` is `""` whatever the layers said (see Trust), and an empty
list of layers resolves to empty strings and `AGENT_DEFAULTS` rather than an error.

## Absent, present, empty

**Inherit is an absent field, and nothing else means inherit.** `0`, `-1`, `""` and `[]` are values
that mean what they say. `null` reads as absent, because a nullable column round-trips through JSON
as `null` and refusing it would make every host write a stripper first.

| Field | absent | present | its empty value |
| --- | --- | --- | --- |
| `id` | inherit; nowhere is `""` | this id | `""` — a value, not inherit |
| `name` | inherit; nowhere is the resolved `id` | this name | `""` — a value, not inherit |
| `description` | inherit; nowhere is `""` | this description | `""` — clears the one below |
| `endpoint.baseUrl` | inherit | this endpoint | `""` — names none, cannot run |
| `endpoint.requestTimeoutSeconds` | inherit; nowhere is no limit | this many seconds | `0` — no limit |
| `endpoint.firstTokenSeconds` | inherit; nowhere is five times the above | this many | `0` — no limit |
| `model.model` | inherit | this model | `""` — names none, cannot run |
| `model.maxTokens` | inherit | this ceiling | `0` — send none, the server decides |
| `model.temperature` | inherit | this temperature | `0` — deterministic, not inherit |
| `model.reasoningReplay` | inherit; nowhere is `all` | as stated | — |
| `model.contextLength` | inherit | this window | `0` — ask the endpoint |
| `model.extraBody` | inherit | merged key by key, less the fields the loop sets or the spec spells | `{}` — adds nothing |
| `model.lockedFields` | locks nothing: every field is open | these fields, unioned with the layers' below | `[]` — locks nothing, and unlocks nothing below |
| `prompt` | inherit | merged by part name, as each part's `mode` says | `[]` — adds nothing; `content: ""` deletes a part, and the parts that name it |
| `promptLayout` | inherit; nowhere is `plain` | as stated | — |
| `tools.servers` | **every server** | exactly these | `[]` — **no servers** |
| `tools.discovery` | inherit; nowhere is `eager` | as stated | — |
| `retry.maxRetries` | inherit; nowhere is `0` | this many | `0` — no retries |
| `tasks.<key>` | not configured | configured | `model: ""` — the task is off |
| `tasks.<key>.extraBody` | inherit | merged key by key, less the same fields | `{}` — adds nothing |
| `hooks` | inherit | merged by hook id | `[]` — adds none; `enabled: false` stops one |
| `requires` | nothing required | all must be understood | `[]` — nothing required |

An absent `tasks` key means the spec does not configure that task — not "use the main model".
That fallback is policy, and this package holds no policy.

## Layering

Hosts hand the resolver an ordered list of documents, weakest first: settings, then the agent, then
a task, then a step. Scalars take the last layer that has the key. `extraBody` and `extensions`
merge by top-level key. `prompt` merges by part name, and `hooks` and `tasks` by id, ordered by
first appearance.
`tools.servers` replaces whole, since a tri-state cannot be unioned. `requires` unions, so a layer
above cannot quietly drop a requirement below it, and so does `model.lockedFields`, so a layer
above cannot unlock a field (see [Locked fields](#locked-fields)).

There is no field for one document to extend another, and no URL resolution: the package never
fetches a layer. Which
documents layer is the host's call, the same answer `resolveApiKey` already gives about keys.

A part whose name a layer below has, with no `mode`, overwrites that part's content in its place.
With `mode: "extend"` or `"replace"` it adds a part of its own instead (`identity_2`), after the
parts already there, and the part it names stays where it was; see section 2 of
[`agent-prompt-spec-v2.md`](agent-prompt-spec-v2.md). An empty `content` deletes a prompt part,
and every part extending or replacing it. A layer above that names it again starts the part
afresh, in the place the name first had.

Resolving also holds two rules that `parseSpec` holds within one document. It holds them for a
layer that never went through `parseSpec` (one built in code, or by `defineSpecColumns().toLayer`
from a row) and for what the merge itself makes:

- `extraBody`, the agent's and each task's, loses `RESERVED_BODY_FIELDS` and the fields the spec
  spells (`temperature`, `max_tokens`, `max_completion_tokens`, `reasoning_effort`), so a row
  cannot send a temperature over the stated one, past the negotiation.
- A hook merged by id loses an `inject` or a `veto` its merged event cannot honour. A layer can
  move a hook from `beforeExchange` to `afterExchange` by id without restating it, and the `inject` from
  below would otherwise come with it.

Resolving has no warnings, so both drops are silent. `parseSpec` is where an operator is told.

Merging by part name is what lets one rule express two behaviours that look unrelated today.
Different names stack, which is an app composing project, identity, role and lane. The same name
replaces, which is a settings to task to step chain. Neither host branches on anything, and the
join is `parts.map(trim).filter(Boolean).join("\n\n")` — byte-identical to the same texts joined
by hand, so four sources survive a round trip instead of flattening into one blob nobody can edit
a third of.

## Locked fields

An agent's prompt parts say what an app may do to them (`allowedModes`); `model.lockedFields` says
the same of the request fields. A deterministic extractor locks `temperature` and `seed`, a
summariser locks `max_tokens`, and the list is kept in the document with the agent's revisions,
written by whoever writes the agent.

- **Open by default.** A field not listed is not locked, so nothing is locked by accident: an agent
  that must never run at another temperature lists `temperature`. A host's UI shows each field as a
  switch, off by default, and turning one on adds it here.
- **Names are wire names**, because that is what a host compares an app's request with:
  `temperature`, `max_tokens`, `reasoning_effort`, or any key that would go in `extraBody` (`top_p`,
  `seed`, a provider's own field). `max_tokens` and `max_completion_tokens` are one field, and
  `resolved.lockedFields` lists it as `max_tokens`. An `extraBody` key locks whole: locking
  `chat_template_kwargs` locks every entry in it.
- **Locks hold upward.** A lock binds the layers above the one that states it. The locking layer
  may still set the field; a layer above that sets it keeps the locking layer's value, or the one
  resolved below it. `lockedFields` unions, so a layer above can add a lock and never remove one.
- **Only the main model.** `tasks.<key>` has no list of its own yet; hosts already keep a request's
  sampling away from side tasks.
- **`parseSpec`** refuses a reserved name (`model`, `messages`, `stream`, `tools`), since the loop
  sets those, and a `lockedFields` that is not an array. It keeps any other name, which may be a
  provider's field, and warns about a name listed twice (`max_tokens` beside
  `max_completion_tokens` included), keeping it once. `exportSpec` round-trips the list.

Resolving has no warnings, so it drops what a layer above tries to change without saying so. A host
that takes fields from an app checks the request first with `checkLockedFields`, which either
refuses it or drops the locked fields and warns, as the host's `onLocked` option says:

```ts
const agent = resolveAgentSpec([settings, agentDoc]);

// The fields of the app's request the host passes on to the model, `extra_body` spread in.
// Refuses by default, throwing a `LockedFieldsError` whose `fields` names each one as sent:
const { fields } = checkLockedFields(agent, requested);

// Or drop them and tell the app:
const { fields, warnings } = checkLockedFields(agent, requested, { onLocked: "drop" });
// warnings: ["max_completion_tokens: locked by the agent, and was dropped"]
```

`lockedFieldsIn(agent, requested)` names the locked fields without acting on them. Both rules:

- **A field set to `null`, or left `undefined`, sets nothing**, so it is never named. Some clients
  send every parameter, with `null` for the unset ones.
- **Setting a locked field is changing it, whatever the value:** an app that restates the agent's
  own temperature is named too.
- **Pass only the fields that go to the model,** not the ones the host reads itself
  (`stream_options`, `parallel_tool_calls`, `tool_choice`, `agent_core`). agent-core sends some of
  those on every request, and resolving never touches them, so a lock on one would refuse every
  agent-core client and protect nothing.

This mirrors `stackAppParts`: agent-core decides the rule, the host decides how to tell the app.

With the reviewer above, which locks `temperature` and `top_k`:

| Layer | `temperature` | `top_k` | `top_p` |
| --- | --- | --- | --- |
| Settings | `0.7` | — | — |
| Reviewer, `lockedFields: ["temperature", "top_k"]` | `0` | `20` | — |
| App | `1` | `50` | `0.9` |
| **Resolved** | **`0`** | **`20`** | **`0.9`** |

`lockedFieldsIn(resolved, { temperature: 1, top_k: 50, top_p: 0.9 })` is `["temperature", "top_k"]`.

## Servers, in two layers

The core document references servers by **effective slug**, `row.slug ?? row.id`. A slug is already
what the model sees as `<slug>__<tool>`; a uuid is not portable between two databases. Turning slugs
into servers is the host's job, and nothing in `src/spec/` resolves one. A host that does it must
narrow, never widen: drop an unresolvable slug with a warning, and if that empties a non-empty list,
run the agent with no tools rather than falling back to "all". Getting that backwards is how a
scoped agent silently gains every tool on the box.

The optional `bundle.mcpServers` carries full definitions for an agent that must travel whole.
This package deliberately does **not** restate `McpServerConfig`. Restating a union it never reads
is a version-skew generator — an MCP pool's server config carries the likes of
`coerceArguments`, `maxResultChars` and several timeouts, and a strict parse here would silently
delete a server's ninety-second call timeout on a round trip. Importing a pool's type is not an
option either, since a pool pulls the MCP SDK and this package keeps `openai` as its only peer
dependency. The
cost, stated plainly: no editor completion on `command` or `url` inside a bundle, and one cast at
the line where a host hands them to the pool.

## Trust

A bundle carries a command line and an environment map, so loading one is equivalent to running a
program. It is exactly as dangerous as pasting somebody's `.mcp.json`, and hosts must gate import
behind the same decision. `parseSpec` reads `bundle` only when called as
`parseSpec(document, { bundle: true })`; otherwise it drops the section with a warning.

Agent-level hooks are in version 1, so an imported agent can bring tool calls the operator never
configured. A host reviews them on import as it would the servers they name.

There is **no credential field at any depth**, and a `${VAR}`-shaped string is never expanded — it
is kept as the literal it is and warned about. Interpolation is the universal prior art and the
weakest part of it: it hands whoever wrote the document the ability to read any variable the
process has, which is why the tools that support it need a credential denylist bolted on. A format
without interpolation needs no denylist. The attack this closes is a confused deputy — a document
naming `https://attacker.example/v1` that causes the host's own provider key to be sent there.

Resolution therefore yields `apiKey: ""`, which `getClient` turns into `NO_KEY` (`src/endpoint/client.ts`).
A host that wants inheritance applies `resolveApiKey` (`src/endpoint/client.ts`) afterwards — the
existing seam, deliberately not applied by the loop, unchanged. `exportSpec(spec, { secrets })`
mirrors `state({ secrets })` in the pool and strips every bundled server's `env` and `headers`,
with the property that **a redacted spec is still a valid spec**. A server can still carry a
credential where the format gives it no field, such as an `--api-key` among its `args` or a token
in its `url`. `exportSpec` keeps those, since cutting them would point the agent at another server,
and `findSpecSecrets` names where they are.

## Validation

Hand-rolled guards in the house style of `src/runtime/snapshot.ts`, reporting every problem at once in the
message shape `validateHooks` already uses (`model.temperature: must be between 0 and 2, and was
dropped`), and importable in a browser.

The hard errors are all about the document rather than a value: it is not an object; the `spec`
token is missing or names another format or major; a container is of the wrong kind, meaning
`prompt`, `hooks`, `requires` or `model.lockedFields` is not an array, or `tasks` is not an object;
a prompt part's name has `app` as its first word; a `model.lockedFields` entry is a reserved field;
or a `requires` entry is not a string, or names an extension this host
does not understand. Everything else drops the offending field and warns — the lesson
`coerceLlmConfig` learned the hard way when a stored out-of-range value stopped a server booting.

Out-of-range values are **dropped, not clamped**. A clamp invents a number the author did not
write, while dropping falls back to one somebody did. That is also the strongest argument for the
no-sentinel rule: with sentinels, an invalid field degrades to a default nobody chose; without
them, it degrades to the layer below.

Version handling is the deliberate opposite of `importCapabilities` (`src/runtime/snapshot.ts`), which
shrugs at a foreign version and returns `false`. *Degrade where the loss is performance; refuse
where the loss is identity.* A snapshot of the wrong version costs a few refused requests; an agent
of the wrong version is not the agent the author described. Additive optional fields need no bump,
per the same snapshot precedent. A version 1 document is refused like any other major; `upgradeSpec`
turns one into version 2 first (see [Version 2](#version-2)).

`requires` is A2A's `AgentExtension.required` trimmed to its one working part. A host declares the
extension keys it understands (`parseSpec`'s `understands` option), an unrecognised entry refuses
the load, and an agent that must not
run without its sandbox extension can say so. It fails closed.

Unknown keys are ignored, warned about, and **never dropped from storage**. A host stores the
document as received and resolves on read, so a key from a later 2.x survives an edit-and-export
cycle instead of being erased by the first host that opens it. `extensions` is the escape hatch
that never warns.

A hook bound to an event this host never fires is a note rather than an error. A host that never
compacts would otherwise refuse a `beforeCompact` hook, which makes an otherwise good agent
unimportable. The validator takes the host's fired-event set (the `events`
option), defaulting to `SPEC_EVENTS`, which is `HOOK_EVENTS`, and warns.

Before 5.0.0 the exchange's two events were named `beforeTurn` and `afterTurn`. Since 6.0.0 those
are unknown events like any other: a hook bound to one is dropped with a warning such as
`hooks[0].on: "beforeTurn" is not an event, and was dropped`. Rename them to `beforeExchange` and
`afterExchange` in stored documents once.

An `inject: true` on an event outside `INJECT_EVENTS`, or a `veto: true` on any event but
`beforeCompact`, is dropped with a warning and the hook is kept. Resolving drops the same flags
again from a hook merged by id (see Layering).

## Side tasks

`tasks` generalises a per-task model map, and each entry may carry **its own endpoint** —
because every side task in this package already takes one: `summariser` (`src/context/compaction.ts`),
`preselect` (`src/tools/preselect.ts`) and `ask` (`src/turn/side-task.ts`). A 1.5B titler on a local
llama.cpp beside a frontier main model is expressible here, and no published format serves it. An
unknown task key is carried through untouched and not warned about, since a host may run tasks this
package has never heard of. `toolSelectModel` flattens from `tasks.toolSelect?.model ?? ""`, where
`""` means do not preselect to `preselect` itself, and the main model to `runAgentLoop`'s
`preselect` option.

A task's settings are its own. `maxTokens`, `temperature`, `reasoningEffort` and `extraBody` are
resolved only where a layer stated them, and nothing is filled in from `model`: an absent field is the side
task's default — temperature 0.3, and the ceiling of whichever entry point runs it — so raising the
agent's temperature to 1.0 for the chat does not make its titler creative. Layers merge a task
field by field before an entry without a model is dropped, so a profile can set
`tasks.title.temperature` alone over a base that names the model; with no model beneath it, the
setting configures nothing and the task is absent.

`taskCall(task, options, agent)` in `src/turn/side-task.ts` is what carries them the rest of the way.
It turns a `ResolvedTask` into the endpoint, model and options that `ask`, `askJson`, `summariser`
and `preselect` take, with what the task states winning over the host's options. Given the agent's
endpoint it also keys a task on that endpoint as the agent is keyed, so the two share one
capability entry rather than learning each refusal twice, and passes it the agent's `fetch` where
the host gave one. That function is never in a document: the host adds it to the resolved endpoint,
and to a task's own endpoint where the task names another. `runAgentLoop` reads `tasks.toolSelect`
under its `preselect` option and `tasks.compaction` under `compact`, both off by default. Asked to
preselect with no `toolSelect` model, it asks the main model; asked to compact with no `compaction`
model, it folds nothing.

`reasoningEffort` does not read as `model.reasoningEffort` does. A side task is sent the
no-thinking hints unless told otherwise, so absent and `"off"` both keep them, where on the main
model they send nothing; a level is sent as `reasoning_effort` and the hints are left out.
`maxTokens: 0` is no ceiling on both. Sampling beyond temperature — `top_p`, `top_k`, the
penalties — goes in `tasks.<key>.extraBody`, which is sent and negotiated as `model.extraBody` is
for the main model. The agent's `model.extraBody` never reaches a task.

## Out of scope

Host scheduling, worker intervals, triggers, steps and decision trees, lanes, roles, boards,
projects, retention, pricing, voice and session state. Those are the parts that differ between one
server and the next, which is the same line `src/index.ts` already draws around this package.
Anything that must travel with a document goes in `extensions`.

Also out: agent-to-agent delegation, tool schemas, memory, evaluation, and — for now — compaction
thresholds, which wait until the `runCompaction` API stops moving.

## Version 2

What changed from version 1 ([`agent-spec-v1.md`](agent-spec-v1.md)), all of it in prompt parts:

| Version 1 | Version 2 |
| --- | --- |
| `{ "id": …, "text": … }` | `{ "role": "system", "name": …, "content": … }`: a part reads like a chat message |
| `ref`, a file or URL holding the text | Gone. An app that keeps prompts in files reads them itself |
| A matching id overwrites | The same, and a `mode` can extend or replace instead, adding a part of its own |
| — | `allowedModes`: what an app may do to the part |
| — | `promptLayout`: `plain`, `markdown` or `xml` |
| Any id | A name whose first word is `app` (`app_lane`, `app-lane`) is refused |

`upgradeSpec` turns a version 1 document into version 2: `id` becomes `name`, `text` becomes
`content`, `role` is `system`, and a part that had only a `ref` is dropped, with a warning. A host
that stores documents runs it once over what it keeps; one that takes documents from people runs
it on each.

## Worked examples

### A settings-only app

No agent table, one settings row, and everything this package does not name riding in `extensions`.

```jsonc
{
  "spec": "cubicecho.agent/2",
  "id": "default",
  "name": "Assistant",

  "endpoint": { "baseUrl": "http://localhost:11434/v1" },
  "model": {
    "model": "qwen3:8b", "maxTokens": 4096, "temperature": 0.7,
    "reasoningEffort": "off",
    "contextLength": 0            // ask the server; stored as `contextLimit` today
  },

  "prompt": [
    { "role": "system", "name": "identity", "content": "You are a concise and careful assistant." }
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
    "com.example.assistant": {
      "pricing": { "inputPer1M": 0, "outputPer1M": 0 },
      "voiceBaseUrl": "", "sttModel": "", "ttsModel": "", "ttsVoice": "", "speakReplies": false
    }
  }
}
```

A per-task model map becomes `tasks`, which any other app can read; voice and pricing survive a
round trip without this package ever naming them; and the app gains a home for `extraBody`.

### A settings row and an agent row

The settings row:

```jsonc
{
  "spec": "cubicecho.agent/2",
  "endpoint": { "baseUrl": "https://api.openai.com/v1", "requestTimeoutSeconds": 120 },
  "model": { "model": "gpt-4o", "maxTokens": 8192, "temperature": 0.7, "contextLength": 128000 },
  "tools": { "discovery": "eager", "maxIterations": 20 },
  "tasks": { "toolSelect": { "model": "gpt-4o-mini" } },
  "retry": { "maxRetries": 3 }
}
```

The agent row. An app with sentinels would store `temperature: -1`, `maxTokens: 0`,
`maxRetries: -1`, `contextLength: 0` and `toolDiscovery: "inherit"` to mean "do not change these".
Here it simply does not mention them:

```jsonc
{
  "spec": "cubicecho.agent/2",
  "id": "a3f2...", "name": "Reviewer",
  "endpoint": { "baseUrl": "http://localhost:8080/v1" },      // its own box
  "model": { "model": "qwen3-coder:30b", "temperature": 0 },  // zero is meant, not inherit
  "prompt": [ { "role": "system", "name": "identity", "content": "You are a careful code reviewer." } ],
  "tools": { "servers": ["git", "fs"] }
}
```

Resolved:

```jsonc
{
  "baseUrl": "http://localhost:8080/v1",
  "apiKey": "",              // resolution never gives a key
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

`temperature: 0` survives, which is the exact bug the `-1` sentinel exists to dodge. Resolution
gives every agent `apiKey: ""`, and `resolveApiKey` applied afterwards gives this one none either,
since it points at its own server rather than the one the OpenAI key is for. And the resolved
object is the flat shape `runAgentLoop` already takes.

The job then composes on top as parts rather than one string:

```jsonc
"prompt": [
  { "role": "system", "name": "project",  "content": "This is the agent-core library. ESM, Node 22." },
  { "role": "system", "name": "identity", "content": "You are a careful code reviewer." },
  { "role": "system", "name": "role",     "content": "Review the diff. Report defects, not style." },
  { "role": "system", "name": "lane",     "content": "Only the files named on the card." }
]
```

Joined with blank lines that is byte-identical to the one string an app would have built, but an
exported agent can now be edited a third at a time.

### Four layers deep

```jsonc
// the agent profile
{ "spec": "cubicecho.agent/2", "id": "researcher",
  "model": { "model": "gpt-4o" },
  "prompt": [ { "role": "system", "name": "main", "content": "You research thoroughly and cite sources." } ],
  "tools": { "servers": ["web", "fs"] } }

// the task overrides the prompt
{ "spec": "cubicecho.agent/2",
  "prompt": [ { "role": "system", "name": "main", "content": "You are auditing dependency licences." } ] }

// the step overrides the model alone
{ "spec": "cubicecho.agent/2", "model": { "model": "gpt-4o-mini" } }
```

Resolves to `gpt-4o-mini`, the task's prompt, and the profile's servers. Replacement and
composition are the same rule seen from two angles.

### A shareable agent, self-contained

```jsonc
{
  "spec": "cubicecho.agent/2",
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
    { "role": "system", "name": "identity", "content": "You transcribe scanned pages exactly, keeping line breaks. Mark a word you cannot read as [?]." }
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

A side task on a different machine from the main model, which no published format can express;
and a bundle, which is the part that needs an explicit trust decision before it is parsed.

## Coverage

| Thing | Covered | Where |
| --- | --- | --- |
| A per-task model map | yes | `tasks`, open-ended |
| Settings only one app reads, such as voice and pricing | yes | `extensions`, carried untouched |
| An identity kept apart from the job | yes | `prompt` parts by name |
| "No servers means no tools" | yes | `servers: []` |
| "No servers means all" | yes | `servers` absent |
| Per-task and per-step overrides | yes | more layers, one function |
| `extraBody` | yes | the first place it can be stored |
| Request fields an app may not change | yes | `model.lockedFields`, open by default |
| A side-task model on another host | yes | `tasks.<key>.endpoint` |
| Sentinel confusion | yes | absent inherits, and nothing else does |
| API keys | no, by design | no field; the host applies `resolveApiKey` after |
| Lanes, roles, triggers, retention | no, by design | host tables, or `extensions` |
| Compaction thresholds | not yet | deferred |

## Open questions

**Server identity.** Slug alone is portable; `{ slug, id? }` would make an intra-host round trip
lossless. Carrying both invites a host to prefer the id and lose portability quietly.

**Un-setting an inherited `extraBody` key.** A key-by-key merge gives no way to remove one. Is this
the single place `null` should mean "remove" rather than "absent"?

**A `.agent.md` surface form**, frontmatter plus body, parsing to the same object — a consumer's
business, or never? GitHub Copilot already uses `.agent.md` for its own agent files, so a form of
ours would need another name.

## Checking it against an app

The type-level claim is a test: `resolveAgentSpec` › `is the flat shape the loop already takes`
assigns a resolved agent to `AgentLoopOptions["config"]`. If that line stops compiling, the flat
resolution is wrong and an adapter is needed after all.

The check against real rows is each app's to make as it adopts the format: resolve its stored
rows and compare the result with what it resolves today, including an agent that names its own
`baseUrl` and so gets no inherited key. If they disagree, the format is wrong. The tri-state round
trip is the likeliest single bug: an empty server list that meant no tools must become `[]`, and
one that meant every server must become absent.
