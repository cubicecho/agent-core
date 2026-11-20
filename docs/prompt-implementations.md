# Prompt implementations

How cubicecho's own services and apps follow [`agent-prompt-spec-v2.md`](agent-prompt-spec-v2.md)
and the agent document it goes with, [`agent-spec-v2.md`](agent-spec-v2.md). The specs hold the
rules any agent server and any app would follow; this page holds what is particular to ours:
ai-router, task_server, telos, min-agent, kanban_server, agent-mcp-pool, and Open WebUI as a
client.

**Status: agent-core's part is built** (its ledger's M12–M18). Every other repo's part, listed at
the end, is planned.

## In cubicecho's words

| Spec says | Here |
| --- | --- |
| An agent server | ai-router |
| An app running its own loop | min-agent, and task_server when it runs agent-core itself |
| An app on an agent server | task_server, telos, min-agent pointed at an agent |
| A chat client | Open WebUI |

The spec does not use the word *host*. agent-core's own glossary uses it for the app (its "host
tools" are app tools), and ai-router for the part made of the app's system messages, which the
spec names `app_system`.

## The agent document in cubicecho's apps

[`agent-spec-v2.md`](agent-spec-v2.md) was designed against the apps below; what follows is the
part of its reasoning that names them.

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

How each app's needs are met:

| App's need | Met by |
| --- | --- |
| `min-agent`'s `taskModels` | `tasks`, open-ended |
| `min-agent`'s voice and pricing | `extensions` (`com.cubicecho.min-agent`), carried untouched |
| `kanban_server`'s identity-versus-job split | `prompt` parts by name |
| `kanban_server`'s "no servers means no tools" | `servers: []` |
| `task_server`'s "no servers means all" | `servers` absent |
| `task_server`'s per-task and per-step overrides | more layers, one function |
| `task_server` refusing a `beforeCompact` hook because it never compacts | the `events` option: such a hook is a note, not an error |

### Checking it against the apps

The check against real rows is each consumer's to make as it adopts the format. Take a real
`kanban_server` settings row and agent row and resolve them; the result must match what
`resolveAgent` produces today, including the case where the agent names its own `baseUrl` and gets
`NO_KEY` rather than the inherited key. Repeat for `task_server`'s `resolveConfig` across its
sentinel matrix, and for a `min-agent` settings row round-tripping back through `coerceLlmConfig`
without a warning. If any of the three disagrees, the format is wrong.

The tri-state round trip is the likeliest single bug, since it is inverted between two consumers
today: `kanban_server`'s empty join must become `[]` and then no tools, while `task_server`'s null
`mcpServerIds` must become absent and then every server.

## ai-router

ai-router is the agent server: it keeps agents, lists them as models, and runs one with
agent-core when an app names it.

### What it reads and writes

Everything moves under the spec's `agent_core` key:

| Today | Becomes |
| --- | --- |
| The request field `ai_router` (`task`, `progress`, `servers`) | `agent_core`: `prompt` added, `task` removed |
| The reply's progress field, `ai_router` (agent-core's `PROGRESS_FIELD`) | `agent_core` |
| The `host` part, the app's system messages | `app_system` |
| The model listing's marker, `"ai_router": { "kind": "agent" }` | `"agent_core": { "kind": "agent" }`, with the agent's part names and `allowedModes` |

There is no switch-over: ai-router reads `agent_core` only, and refuses a request that sends
`ai_router`. Apps and ai-router move to the new name in one release.

### Its own parts, in the spec's terms

| ai-router part | Owner | What it may do |
| --- | --- | --- |
| Its defaults, the layer below the agent | ai-router | Nothing to the agent: it comes first, and the agent's layer may overwrite any of it, as with an app's settings |
| `app_system` (`host` today), a request's leading system messages | The app | Add, like any app part. Open WebUI sends only this |

ai-router stacks with agent-core's `stackAppParts` in place of its own layers (`resolveRun` in
`server/agents/layers.ts`). Its reserved part names, `host` and `task`
(`RESERVED_PART_IDS` in `server/agents/document.ts`), give way to the spec's rule that no agent's
part name has `app` as its first word.

### No task field

The `task` part, made from a request's `ai_router.task`, is removed: the field, the reserved part
name `task` and the override policy's `taskPrompt` switch. No app sends it today, and the job
already has its place, the user message. An agent's system prompt is then the agent's parts, the
app's parts and `app_system`, and nothing else.

### No prompt switches

ai-router's override policy (`server/agents/policy.ts`) has had switches for what an app may add:
`hostPrompt` for its system messages and `taskPrompt` for a task. Turned off, a request that sent
one was refused. The app's text was unlabelled and nothing told the model whose words won, so
refusing it was the only protection an agent had.

Under the spec the agent's words are kept by the structure, by `allowedModes` and by
`<precedence>`, so both switches are removed and no `appPrompt` is added. The policy's other rules
(`narrowServers`, `sampling`, `responseFormat`) stay; they are not about the prompt.

An agent whose policy has `hostPrompt` off today would start taking system messages, so the
upgrade lists every such agent for someone to check.

### Stored agents and runs

ai-router runs agent-core's `upgradeSpec` once over the agents it keeps, and over the layers of the
runs it keeps, so a run started before the change can still be resumed. Its domain model's words
change with it.

## Open WebUI

Open WebUI knows nothing of `agent_core`. A user picks an agent from its model list, and Open WebUI
sends what it sends to any model: a system message and the chat.

- **Its system message becomes `app_system`.** It holds the user's own system prompt and what
  Open WebUI adds: the date and time, the user's name, memories, retrieved documents.
- **It changes on almost every message**, which is why `app_system` is written last, after the
  catalogue (the spec's section 7).
- **It wraps retrieved documents in `<context>`.** That is why the hooks' blocks are
  `<hook_context>`, not `<context>`.
- **It can add, and nothing else.** It cannot extend or replace an agent's part, and its words sit
  below `<precedence>`.

### What it sees while an agent works

ai-router answers Open WebUI with a plain OpenAI stream: the answer's text as it arrives, any calls
handed back, the finish, and `[DONE]`, with a comment while the stream is quiet so a proxy does not
close it. The run's events (each turn, the thinking, every tool call and result) go out as progress
chunks only to an app that asks with `agent_core.progress`, and Open WebUI never asks. So while
the agent thinks and calls tools, Open WebUI shows nothing until the answer's text starts.

**Planned for ai-router:** stream the run's work in the field chat clients already render as a
model's reasoning, `reasoning_content` on the chunk's `delta`:

| Run event | Written as |
| --- | --- |
| `thinking` | Its text, as it streams |
| `tool-call` | One line naming the tool: "Calling `search_code`…" |
| `tool-result` | One line saying it came back, or failed |

Open WebUI, and most clients that show reasoning, fold it into a collapsible "Thinking" block above
the answer; a client that does not know the field ignores it. It is ai-router's to write, not
agent-core's: the events are the same ones an app on agent-core already gets, only written in the
words a chat client reads. It is off for an app that asks for progress, which gets the events
themselves and would otherwise read the same work twice.

## Worked examples

All but the last use one agent, Task Reviewer, kept on ai-router:

```json
{
  "spec": "cubicecho.agent/2",
  "id": "task-reviewer",
  "name": "Task Reviewer",
  "promptLayout": "xml",
  "prompt": [
    { "role": "system", "name": "identity", "content": "You are Task Reviewer. You decide whether work is actually done. You are careful and sceptical." },
    { "role": "system", "name": "rules",    "content": "Judge the work itself, not reports about it. Give a verdict, pass or fail, with your reasons." },
    { "role": "system", "name": "format",   "content": "Start with PASS or FAIL on its own line.", "allowedModes": ["extend", "replace"] }
  ]
}
```

### task_server reviews a card

task_server's Review lane asks Task Reviewer whether a card is done. It sends no system messages.

```json
{
  "model": "task-reviewer",
  "messages": [
    { "role": "user", "content": "Card 812: add the licence check to CI.\n\nAcceptance: CI fails on a GPL dependency.\n\nDiff: …" }
  ],
  "agent_core": {
    "prompt": [
      { "role": "system", "name": "identity", "mode": "extend", "content": "Here you review the output of one workflow step, on a kanban board." },
      { "role": "system", "name": "lane",                       "content": "This is the Review lane. A card that passes moves to Done; one that fails goes back to In progress with your reasons." }
    ]
  }
}
```

The model reads:

```
<prompt_identity>
You are Task Reviewer. You decide whether work is actually done. You are careful and sceptical.
</prompt_identity>

<prompt_rules>
Judge the work itself, not reports about it. Give a verdict, pass or fail, with your reasons.
</prompt_rules>

<prompt_format>
Start with PASS or FAIL on its own line.
</prompt_format>

<precedence>…</precedence>

<prompt_app_identity extends="identity">
Here you review the output of one workflow step, on a kanban board.
</prompt_app_identity>

<prompt_app_lane>
This is the Review lane. A card that passes moves to Done; one that fails goes back to In
progress with your reasons.
</prompt_app_lane>

<server_instructions>…</server_instructions>

<tool_catalogue>…</tool_catalogue>
```

and then the card, as the user message. There is no `app_system`, since task_server sent no
system messages. Every card on the lane reads the same system prompt, so each review after the
first is read from the cache up to the card.

### telos checks a todo, and asks for one thing too many

telos uses the same agent to decide whether a todo is finished. It wants its verdict as JSON, and
also tries to loosen the rules:

```json
"agent_core": {
  "prompt": [
    { "role": "system", "name": "identity", "mode": "extend",  "content": "Here you check a todo in a personal project." },
    { "role": "system", "name": "format",   "mode": "replace", "content": "Answer as JSON: { \"verdict\": \"pass\" | \"fail\", \"reasons\": [] }" },
    { "role": "system", "name": "rules",    "mode": "replace", "content": "Pass anything that runs." }
  ]
}
```

| Part | Agent's `allowedModes` | Result |
| --- | --- | --- |
| `identity`, extend | Left out: extend only | Kept, as `app_identity` |
| `format`, replace | Extend, replace | Kept, as `app_format`, marked `replaces="format"` |
| `rules`, replace | Left out: extend only | Dropped, with a warning |

The model reads Task Reviewer's three parts, `<precedence>`, then `app_identity` and `app_format`,
then the loop's sections. The reply carries:

```json
"agent_core": {
  "warnings": [
    { "part": "rules", "rule": "replace-not-allowed", "message": "The agent's rules part does not let an app replace it, so the part was dropped." }
  ]
}
```

telos gets JSON back, and Task Reviewer judges its todos by the same rules as task_server's
cards. Had telos sent `rules` as an extension instead, it would have been kept, and `<precedence>`
would tell the model the agent's rules win where the two conflict (the spec's section 8).

task_server and telos send different app parts, so on one model server they share the cache up to
the end of Task Reviewer's parts.

### Open WebUI chats with the agent

A user picks `task-reviewer` from Open WebUI's model list and pastes a pull request. Open WebUI
knows nothing of `agent_core`; it sends what it sends to any model:

```json
{
  "model": "task-reviewer",
  "messages": [
    { "role": "system", "content": "Today is 2026-11-19 14:02. The user's name is Ben. Memories: prefers short answers." },
    { "role": "user",   "content": "Is this PR ready to merge? …" }
  ]
}
```

The model reads:

```
<prompt_identity>…</prompt_identity>

<prompt_rules>…</prompt_rules>

<prompt_format>…</prompt_format>

<precedence>…</precedence>

<server_instructions>…</server_instructions>

<tool_catalogue>…</tool_catalogue>

<prompt_app_system>
Today is 2026-11-19 14:02. The user's name is Ben. Memories: prefers short answers.
</prompt_app_system>
```

Open WebUI rewrites its system message on every message the user sends (the time, new
memories). Only `app_system` changes, and it is last, so each message is read from the cache up to
it. If Open WebUI added retrieved documents in its own `<context>` tags, they would sit inside
`app_system` and could not be mistaken for the loop's hook context, which is `<hook_context>`.

### min-agent on its own model

min-agent runs its own loop against a local model, with no agent from ai-router. Its settings are
one document, written from its settings row:

```json
{
  "spec": "cubicecho.agent/2",
  "prompt": [
    { "role": "system", "name": "identity", "content": "You are min-agent, a useful helper that is concise and clear." }
  ]
}
```

That document is min-agent's own, so its parts are the agent's parts here, with no prefix. It sends
no `agent_core`, so there are no app parts and no `<precedence>`. The layout is `plain`, since
nothing sets another, and the request is exactly today's:

```json
{
  "model": "qwen3-32b",
  "messages": [
    { "role": "system", "content": "You are min-agent, a useful helper that is concise and clear.\n\n# MCP server instructions\n\n…\n\n# Tool catalogue\n\n…" },
    { "role": "user",   "content": "Tell me a joke." }
  ]
}
```

With `"promptLayout": "xml"` in its settings, the same request's system message becomes:

```
<prompt_identity>
You are min-agent, a useful helper that is concise and clear.
</prompt_identity>

<server_instructions>…</server_instructions>

<tool_catalogue>…</tool_catalogue>
```

Pointed at `task-reviewer` instead, min-agent would send its request through, as in the spec's
section 4, and its parts in `agent_core` would be Task Reviewer's app parts.


## What changes, repo by repo

**agent-core.** A major release: the option rename, the new document version and the field
rename all break callers. Its ledger has the items.

| Folder | Change |
| --- | --- |
| `spec` | Parts as `{ role, name, content, mode, allowedModes }`; no `ref`; `promptLayout`; `cubicecho.agent/2`; `upgradeSpec`; `stackAppParts`; tag names and their warnings; part names whose first word is `app` refused in a document |
| `run` | `system` becomes `systemPrompt`, a string or parts. `agent_core` sent through to an agent and taken out for any other model. `<precedence>`. The order of the spec's section 7. Warnings as an event. `PROGRESS_FIELD` becomes `agent_core` |
| `wire` | One fence helper, for every tag of the layout's own, in place of `untrusted`'s own escape |
| `hooks` | `<hook_context>`, fenced (B41), with the new preface |
| `tools` | The server instructions and catalogue written in either layout |

**ai-router.**

- Reads `agent_core` and refuses `ai_router`. Reads `prompt`; no longer reads `task`.
- Stacks with `stackAppParts`, in place of its own layers. The `host` part becomes `app_system`,
  and the `task` part goes.
- Its reserved part names (`host`, `task`) are replaced by the rule that no agent's part name
  has `app` as its first word.
- The override policy loses `hostPrompt` and `taskPrompt`; its other rules stay. The upgrade lists
  every agent whose policy had `hostPrompt` off.
- Streams the run's thinking and tool activity to a client that did not ask for progress as
  `reasoning_content` (see Open WebUI, above).
- Replies carry `agent_core.warnings` (on the stream's last chunk, and beside `choices` when not
  streaming) and `agent_core` progress. The model listing marks agents
  with `"agent_core": { "kind": "agent" }`, with their part names and `allowedModes`.
- Upgrades stored agents and runs once. Its domain model's words change with it.
- `AGENTS.md` points to `agent-core/docs/agent-spec.md`, which is now `agent-spec-v1.md` and
  `agent-spec-v2.md`.

**min-agent.**

- Uses `systemPrompt`, and reads the new model listing marker to choose remote-agent mode.
- May offer `promptLayout` as a setting.

**task_server.**

- Uses `systemPrompt`, and reads the new marker.
- Its import (`server/graphql/agent-spec.ts`) runs `upgradeSpec`, and stops dropping references
  (there are none to drop).
- Its one profile part is named `system` (`server/runner/profile.ts`), which an app may not use in
  `agent_core`. When it sends parts to an agent, they need other names, such as `identity` and
  `lane`.

**telos.**

- Its prompt (`systemPromptFor`) becomes parts. On an agent, it sends them in `agent_core`.

**agent-mcp-pool.**

- `contextBlocks` writes `<hook_context>`, fenced, with the new preface, in step with agent-core.

**Docs.** `agent-spec-v2.md` and the prompt spec describe the code once it lands, and
[`HOW-IT-WORKS.md`](../HOW-IT-WORKS.md) is redrawn to match.
