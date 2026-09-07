# @cubicecho/agent-core

The endpoint-agnostic half of an OpenAI-compatible agent loop.

Extracted from three servers that had each written it separately — `kanban_server`,
`task_server` and `min-agent` — after the copies drifted far enough that a fix in one was a bug
still live in another. See [`standards/extraction-backlog.md`](../standards/extraction-backlog.md).

## What is here

| Module | What it does |
| --- | --- |
| `schema-compat` | Makes an MCP tool schema something a strict or grammar-constrained server will accept. `sanitizeTools`, `relaxTools`, `isGrammarError`. |
| `tool-loading` | On-demand tool discovery: a name-only catalogue plus a `load_tools` meta-tool, so a run pays for the schemas it asks for instead of all of them. |
| `side-task` | One-shot calls that support a run without being one — small prompt, short answer, no tools, never worth failing the run over. |
| `events` | The in-memory bus a watcher reads while a run happens. |
| `client` | A pooled `OpenAI` client per endpoint, plus the context-window listing and its cache. |
| `retry` | What to do when a request is lost, refused or too big: `isTransient`, `backoffMs`, `ContextOverflow`, `EndpointSilent`. |
| `config` | The structural interfaces every function here asks for. |

What is **not** here is the work: orchestration, prompts, and whatever the run is about. That
is the caller's, and it is the part that actually differs between one server and the next.

## The config seam

Nothing here imports a config type from a consumer, and no function asks for a whole
configuration. Each takes the narrowest shape it reads — `Endpoint`, `ModelParams`,
`ToolPolicy`, `RetryPolicy` — and a caller satisfies it structurally:

```ts
import { getClient, type Endpoint } from "@cubicecho/agent-core";

// A Drizzle settings row, a resolved agent, or a zod-inferred config: all three already are one.
const client = getClient(settings satisfies Endpoint);
```

This matters because the three consumers do not agree on the fields. `task_server`'s settings
row has no `contextLength`; `min-agent` spells it `contextLimit` and has no timeout or retry
budget at all. A single god interface would have forced two of them to grow columns they have
no use for.

## Where the merged behaviour came from

- `schema-compat` — `kanban_server`/`task_server`'s version, which strips **every** sibling of a
  `$ref` rather than just `default`. `min-agent`'s did the latter, which leaves `nullable` beside
  the surviving `$ref` on `anyOf: [{$ref}, {type: "null"}]` — the shape a schema-generated server
  emits at every optional argument — and a strict validator rejects the tool.
- `tool-loading` — theirs, plus `min-agent`'s `carryOver`/`MAX_CARRIED`, which bounds the tool
  array across a multi-turn conversation. Both suites' assertions are kept.
- `events` — `kanban_server`'s `usage` totals **and** `task_server`'s `step` grouping, including
  its `fold` fix: two blocks in different steps are not one block.
- `retry` — `kanban_server`'s, which is the only one of the three with the `ContextOverflow`
  guard. `min-agent` had no retry layer at all.
