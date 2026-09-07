# @cubicecho/agent-core

The endpoint-agnostic half of an OpenAI-compatible agent loop.

Extracted from three servers that had each written it separately — `kanban_server`,
`task_server` and `min-agent` — after the copies drifted far enough that a fix in one was a bug
still live in another.

## Install

```sh
npm install @cubicecho/agent-core openai
```

`openai` is a peer dependency (`>=6`) so the client this hands back is the same one your code
already imports — one SDK version in the tree, one `instanceof` that means what it says. ESM
only, Node >=22.

## What is here

| Module | What it does |
| --- | --- |
| `schema-compat` | Makes an MCP tool schema something a strict or grammar-constrained server will accept. `sanitizeTools`, `relaxTools`, `isGrammarError`. |
| `tool-loading` | On-demand tool discovery: a name-only catalogue plus a `load_tools` meta-tool, so a run pays for the schemas it asks for instead of all of them. |
| `stream` | Reads one streamed turn back into a message: token callbacks, tool-call reassembly, and the idle watchdog that turns a silent endpoint into `EndpointSilent`. |
| `capabilities` | What an endpoint turned out not to support, per endpoint, and the loop that answers it when it says so. `capabilitiesFor`, `negotiate`. |
| `side-task` | One-shot calls that support a run without being one — small prompt, short answer, no tools, never worth failing the run over. |
| `events` | The in-memory bus a watcher reads while a run happens. |
| `client` | A pooled `OpenAI` client per endpoint, plus the context-window listing and its cache. |
| `retry` | What to do when a request is lost, refused or too big: `isTransient`, `backoffMs`, `ContextOverflow`, `EndpointSilent`. |
| `config` | The structural interfaces every function here asks for. |
| `errors` | `errorMessage`: a caught `unknown` turned into something a run row can hold. |
| `catalog` | `CatalogServer`: the name-only shape `tool-loading` reads a connected server as. |

What is **not** here is the work: orchestration, prompts, and whatever the run is about. That
is the caller's, and it is the part that actually differs between one server and the next.

## A turn

`negotiate` wrapping `streamTurn` is the whole of one turn against an endpoint: the request is
re-sent for as long as the answer is this server refusing something the request can do without,
and nothing is re-sent once it has started answering.

```ts
import {
  capabilitiesFor, getClient, negotiate, relaxTools, sanitizeTools, streamTurn, timeoutMs,
} from "@cubicecho/agent-core";

const declared = sanitizeTools(tools);
const supports = capabilitiesFor(config.baseUrl);

const turn = await negotiate(supports, (supports, produced) =>
  streamTurn(
    getClient(config),
    {
      model, messages, stream: true,
      // Rebuilt per attempt: what the endpoint has refused is latched off by the line above.
      ...(supports.usageInStream ? { stream_options: { include_usage: true } } : {}),
      tools: supports.strictSchemas ? declared : relaxTools(declared),
    },
    { produced, signal, idleMs: timeoutMs(config), onOutput: (text) => emit(runId, { kind: "output", text }) },
  ),
);
```

`send` takes a callback rather than a body because the body has to be rebuilt from the latched
flags. `produced` is one box per attempt — `streamTurn` sets it as soon as the server says
anything, and the re-send reads it — so a caller with its own retry budget passes one in
(`{ produced }`) and reads it afterwards to decide whether the failure is worth another attempt.

`idleMs` is silence, not a deadline: the timer is rearmed on every chunk, so a model that is
still talking is never cut off however long it takes, and one that has stopped answering raises
`EndpointSilent` rather than hanging the run. `timeoutMs(config)` returns `undefined` for a
`requestTimeoutSeconds` of zero, which waits forever — what a local model answering slowly needs.

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
row has no `contextLength`; `min-agent` spells it `contextLimit` and carries no retry budget.
A single god interface would have forced two of them to grow columns they have no use for.

The seam is not finished. `timeoutMs` narrows to the one field it reads, but `getClient` still
asks for the whole of `Endpoint`, and `requestTimeoutSeconds` on it is required — so a consumer
that has no timeout to give must invent one (`0` means "no limit"). Making it optional is a
breaking change and is waiting for the next major.

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
