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
| `capabilities` | What an endpoint turned out not to support — and, under it, what one model on that endpoint did not — plus the loop that answers either when it says so. `capabilitiesFor`, `modelCapabilitiesFor`, `negotiate`. |
| `side-task` | One-shot calls that support a run without being one — small prompt, short answer, no tools, never worth failing the run over. |
| `events` | The in-memory bus a watcher reads while a run happens: `emit`, `watch`, `history`, `fold`. A watcher's backlog is capped and reports its own gaps. |
| `client` | A pooled `OpenAI` client per endpoint, plus the context-window listing and its cache. |
| `retry` | What to do when a request is lost, refused or too big: `isTransient`, `backoffMs`, `ContextOverflow`, `EndpointSilent`, `requestTokens`. |
| `config` | The structural interfaces every function here asks for. |
| `run-turn` | `runTurn`: one turn with the retry loop around the negotiation around the stream. The whole loop, for a caller that wants it rather than its parts. Sizes the request against an opt-in `contextLimit`. |
| `reset` | `resetAll`: drops every cache and latch in one call, so a teardown cannot forget one. |
| `tokens` | `estimateTokens`: characters over four, deliberately low, for everything here that has to guess at a window. |
| `errors` | `errorMessage`: a caught `unknown` turned into something a run row can hold. |
| `catalog` | `CatalogServer`: the name-only shape `tool-loading` reads a connected server as. |

What is **not** here is the work: orchestration, prompts, and whatever the run is about. That
is the caller's, and it is the part that actually differs between one server and the next.

`llms.txt` is the same surface as a flat index — every export with the first line of its own doc
comment. It is generated from `src/index.ts` by `npm run llms`, which the build runs, so it is
the exports rather than a second description of them; CI fails if the committed copy has drifted.

## A turn

`negotiate` wrapping `streamTurn` is the whole of one turn against an endpoint: the request is
re-sent for as long as the answer is this server refusing something the request can do without,
and nothing is re-sent once it has started answering.

```ts
import {
  capabilitiesFor, emit, getClient, negotiate, relaxTools, sanitizeTools, streamTurn, timeoutMs,
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

## What the model refuses, rather than the server

`strictSchemas` and `usageInStream` are facts about a server. Three more arrive through the same
channel — an error string on a chat completion — and are facts about a *model*: a
`reasoning_effort` it does not take, a ceiling it spells `max_completion_tokens`, a temperature
that is not ours to pick. They cannot latch on the endpoint, because one API key reaches every
model a provider offers: the first turn on `gpt-4o` would stop `gpt-5` ever being asked to reason
again, with the setting still reading `high` and nothing anywhere saying it had stopped.

So they hang off the endpoint under the name the endpoint knows the model by. Pass `model` and
the same loop answers both levels; leave it out and nothing changes.

```ts
const turn = await negotiate(supports, (supports, produced, model) =>
  streamTurn(
    getClient(config),
    {
      model: name, messages, stream: true,
      // Each rebuilt per attempt from what this model has already refused.
      ...(model?.reasoningEffort ? { reasoning_effort: effort } : {}),
      ...(model?.legacyTokenLimit ? { max_tokens: limit } : { max_completion_tokens: limit }),
      ...(model?.chosenTemperature ? { temperature } : {}),
      tools: supports.strictSchemas ? declared : relaxTools(declared),
    },
    { produced, signal },
  ),
  { model: name },
);
```

`runTurn` takes the same option and hands `request` the same second argument. Keying on
`(endpoint, model)` rather than the model name alone is the part worth keeping: `gpt-4o` at
OpenAI and `gpt-4o` behind a proxy need not be the same weights, and one that refused a reasoning
effort must not speak for the other.

`send` takes a callback rather than a body because the body has to be rebuilt from the latched
flags. `produced` is one box per attempt — `streamTurn` sets it as soon as the server says
anything, and the re-send reads it — so a caller with its own retry budget passes one in
(`{ produced }`) and reads it afterwards to decide whether the failure is worth another attempt.

`idleMs` is silence, not a deadline: the timer is rearmed on every chunk, so a model that is
still talking is never cut off however long it takes, and one that has stopped answering raises
`EndpointSilent` rather than hanging the run. `timeoutMs(config)` returns `undefined` for a
`requestTimeoutSeconds` of zero or absent, which waits forever — what a local model answering
slowly needs.

## Sizing a request before sending it

`runTurn` will refuse a request that cannot fit rather than spending a round trip finding out:

```ts
import { contextLimitFor, emit, runTurn } from "@cubicecho/agent-core";

const turn = await runTurn(client, supports, build, {
  maxRetries: 3,
  // Opt-in: the number is the caller's to find, because neither of these is network I/O a
  // turn should be doing. The second argument is the operator's own number and it wins
  // outright when set, so there is no need to check it yourself first.
  contextLimit: await contextLimitFor({ ...settings, model }, settings.contextLength),
  onNotice: (message) => emit(runId, { kind: "notice", text: message }),
});
```

The body is sized once, not per attempt: a downgraded request is strictly smaller than the one
before it and the transcript does not change between retries. A `ContextOverflow` from this is
neither a capability `negotiate` can answer nor something `isTransient` accepts, so it leaves
both loops on the first attempt.

## Watching a run

`watch` replays what the run has already emitted, then yields what happens next until `done`.
`emit` assigns `seq`, a per-run counter from 1, and that is what a client orders and
de-duplicates on.

```ts
import { watch } from "@cubicecho/agent-core";

for await (const event of watch(runId)) {
  render(event);
}
```

A watcher that stops keeping up is capped rather than left to grow. Its queue holds the most
recent 1000 events — trimmed in batches, so it runs a little over that before cutting back —
the oldest go, and what is dropped is released where it is dropped, not held until a consumer
that has already stalled next reads.

The gap is reported once, as a single `notice`, not once per lost event. It carries the `seq`
immediately before the event that follows it: inside the gap, where no real event will ever
appear. Sharing a `seq` with the event behind it would make the pair indistinguishable from a
repeat, and a client doing what `seq` is documented for would throw away one of the two.

`history` reads what a run has emitted without subscribing, `fold` collapses a token stream into
blocks for display, and `endRun` drops a finished run's buffer.

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
asks for the whole of `Endpoint`. `requestTimeoutSeconds` became optional in v2, so a consumer
with no timeout to give now leaves it out rather than inventing a `0`.

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
