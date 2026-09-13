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
| `hooks` | The host's side of lifecycle hooks: `gather` before a request and `notify` after, the shared context budget, `withContext` to put what they add on the turn's question, and `turnMessages` to hand them a transcript. Running a hook is a runner the caller passes. |
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
and nothing is re-sent once the model has started answering.

```ts
import {
  capabilitiesFor, emit, getClient, negotiate, relaxTools, sanitizeTools, streamTurn, timeoutMs,
} from "@cubicecho/agent-core";

const declared = sanitizeTools(tools);
const supports = capabilitiesFor(config.baseUrl, config.apiKey);

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

The key is passed because it is part of what an endpoint *is* here, not only how it is paid
for: a router is free to send two keys to two different backends, and then what one of them
refused is not a fact about the other. Absent and empty read the same, so a local server with no
key is one entry however its caller spells it.

`Turn` is `content`, `toolCalls`, `usage` and `finishReason`. The last is worth reading: a turn
cut off at the token ceiling comes back looking exactly like a finished one, with truncated prose
or — the case that bites — a tool call whose `arguments` stop mid-JSON, so the caller meets a
parse failure with nothing to attribute it to. `finishReason` is `"length"` there, `""` where the
endpoint never said.

## What the model refuses, rather than the server

`strictSchemas` and `usageInStream` are facts about a server. Three more arrive through the same
channel — an error string on a chat completion — and are facts about a *model*: a
`reasoning_effort` it does not take, a ceiling it spells `max_completion_tokens`, a temperature
that is not ours to pick. They cannot latch on the endpoint, because one API key reaches every
model a provider offers: the first turn on `gpt-4o` would stop `gpt-5` ever being asked to reason
again, with the setting still reading `high` and nothing anywhere saying it had stopped.

So they hang off the endpoint under the name the endpoint knows the model by. Pass `model` and
the same loop answers both levels; leave it out and nothing changes.

A refusal of the *value* is not one of these, however alike the two read: an effort off a list
this package does not know, a `max_tokens` larger than the model's ceiling, a temperature out of
range. Dropping the field answers those too — at the model's own default, latched for the rest of
the process, with the settings row still reading what was typed and nothing saying it had stopped
meaning it. They are passed to the caller instead, where whoever typed the number can see it.

```ts
const turn = await negotiate(supports, (supports, produced, model) =>
  streamTurn(
    getClient(config),
    {
      model: name, messages, stream: true,
      // Each rebuilt per attempt from what this model has already refused.
      ...(model?.reasoningEffort ? { reasoning_effort: effort } : {}),
      ...(model?.legacyTokenLimit === false
        ? { max_completion_tokens: limit }
        : { max_tokens: limit }),
      ...(model?.chosenTemperature ? { temperature } : {}),
      tools: supports.strictSchemas ? declared : relaxTools(declared),
    },
    { produced, signal },
  ),
  { model: name },
);
```

The ceiling is the one of the three guarded on `=== false` rather than on truthiness, and it is
the only one that has to be. The other two *omit* a field where the flag is absent, so a caller
that leaves `model` out sends a smaller request and nothing else; both branches of this one are a
field, so truthiness picks the newer spelling for a caller who was told nothing would change —
and the newer spelling is exactly the one an older model or a llama.cpp-shaped endpoint rejects.
`modelCapabilitiesFor` starts a model at `legacyTokenLimit: true`, and an absent model has to read
the same way it does.

`runTurn` takes the same option and hands `request` the same second argument. Keying on
`(endpoint, model)` rather than the model name alone is the part worth keeping: `gpt-4o` at
OpenAI and `gpt-4o` behind a proxy need not be the same weights, and one that refused a reasoning
effort must not speak for the other.

`send` takes a callback rather than a body because the body has to be rebuilt from the latched
flags. `produced` is one box per attempt — `streamTurn` sets it on the first chunk that carries
text, reasoning or a piece of a tool call, and the re-send reads it — so a caller with its own
retry budget passes one in (`{ produced }`) and reads it afterwards to decide whether the failure
is worth another attempt. The content-free `{"role":"assistant"}` most servers open a stream with
does not set it: nothing has been shown to anybody yet, so an endpoint that primes the stream and
then wedges is retried like one that never answered at all.

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

`contextLimit` decides how early the caller hears, not what it hears. Without one, the endpoint
refuses instead — one round trip later — and `runTurn` reads that refusal back through
`isOverflow` and raises the same `ContextOverflow`, carrying the endpoint's own wording and the
original error as `cause`. A rate limit borrows those words and means the opposite ("Request too
large for gpt-4o ... on tokens per min"); that is ruled out and waited through as the 429 it is.

## Watching a run

`watch` replays what the run has already emitted, then yields what happens next until `done`.
`emit` assigns `seq`, a per-run counter from 1, and that is what a client orders and
de-duplicates on.

```ts
import { watch } from "@cubicecho/agent-core";

// The signal is how a watcher leaves early — a disconnected client, a page navigated away from.
for await (const event of watch(runId, request.signal)) {
  render(event);
}
```

Pass one for anything that can go away before the run ends. `watch` otherwise finishes only on
`done`, and returning the generator is not a substitute: waiting for the next event it is
suspended at an `await` rather than at a `yield`, so a `return()` queues behind a promise only
that event can settle. A watcher stuck there also holds its run's backlog past every deadline,
because the sweep skips any stream a listener is on.

A watcher that stops keeping up is capped rather than left to grow. Its queue holds the most
recent 1000 events by default — trimmed in batches, so it runs a little over that before cutting back —
the oldest go, and what is dropped is released where it is dropped, not held until a consumer
that has already stalled next reads.

The gap is reported once, as a single `notice`, not once per lost event. It carries the `seq`
immediately before the event that follows it: inside the gap, where no real event will ever
appear. Sharing a `seq` with the event behind it would make the pair indistinguishable from a
repeat, and a client doing what `seq` is documented for would throw away one of the two.

`history` reads what a run has emitted without subscribing, `fold` collapses a token stream into
blocks for display, and `endRun` drops a finished run's buffer.

The four numbers behind that — the backlog cap, the slack it is trimmed in batches of, and the two
deadlines the sweep reaps on — are defaults rather than decisions. `configureEvents` moves them,
and returns the whole set as it now stands:

```ts
import { configureEvents } from "@cubicecho/agent-core";

// A long-lived server with many concurrent runs, whose tool calls are minutes rather than hours.
configureEvents({ maxEvents: 200, retainUnendedMs: 5 * 60_000 });
```

It is module-level because the bus is: there is one of each per process, and a run does not carry
its own. A field left out keeps what it had, and so does one given something that is not a
positive number — nothing here has a meaningful zero, and a `0` standing in for "no opinion" must
not turn the backlog off. `resetEvents` (and `resetAll`) puts the defaults back, so one test's cap
is not the next one's.

`expandNames`, `carryOver`, `preselection`, `preselectInput` and `preselectSystem` take their caps
the same way — as a last argument defaulting to `MAX_PER_LOAD` or `MAX_CARRIED`. A resolution
carries the cap it was held to, so `loadResult` tells the model the number it was actually
measured against rather than the module's own.

## Hooks

A hook is something a host runs at a point in a session — `sessionStart` and `beforeTurn`, whose
output can reach the request, then `afterTurn`, `beforeCompact`, `sessionEnd` and `sessionDelete`,
which can only read what happened. What runs is not decided here. `gather` and `notify` take a
`HookRunner`, and `@cubicecho/agent-mcp-pool`'s `runHooks` is one as it stands: its types are the
shapes restated here, so its outcomes pass straight through without either package importing the
other.

```ts
import {
  emit,
  gather,
  type HookRunner,
  notify,
  turnIndex,
  turnMessages,
  withContext,
} from "@cubicecho/agent-core";

const run: HookRunner = (event, context, { signal }) =>
  pool.runHooks(event, context, { signal, servers: agent.mcpServers });

const context = { session: { id }, host: "my-host", prompt, turn: { index: turnIndex(messages) } };
const gathered = await gather(
  run,
  messages.length === 0 ? ["sessionStart", "beforeTurn"] : ["beforeTurn"],
  context,
  { signal, onNote: (note) => emit(runId, { kind: "notice", name: note.hookId, text: note.error ?? note.text }) },
);
messages.push({ role: "user", content: prompt });
const request = withContext(messages, messages.length - 1, gathered.context);
// ... the turn ...
void notify(run, "afterTurn", { ...context, reply, turn: { ...context.turn, messages: turnMessages(id, messages, turnStart) } });
```

The context goes on this turn's question and never into the system prompt — a prompt that changed
every turn would miss the prompt cache every turn — and `withContext` returns a new array, so a
host that stores what the user typed never stores the context as something they said. Every
injecting hook shares `HOOK_CONTEXT_TOKENS` (2000) by default, each held to its own `maxTokens`
inside that, so a generous hook cannot crowd out the conversation it was meant to inform.

Neither function rejects. A hook failing is an outcome, and a runner that throws outright is
noted once for its event and costs only that event's context. `notify` takes no signal: a reader
who leaves once the turn is answered has not asked for it not to be remembered.

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

## What is kept for the life of the process

Four caches outlive any one run: the `OpenAI` clients, the model listings, the latched
capabilities, and `side-task`'s no-thinking hints. All four are module-level and keyed on the same
notion of an endpoint — its base URL and its API key — and the clients' key carries the request
timeout as well, since that changes how a request is sent.

**They are keyed per deployment, not per request.** What belongs in them is an endpoint an
operator configured: a settings row, an agent definition, an environment variable. Everything
bounding them assumes that, and a consumer that mints an API key per *user* breaks the assumption
— each tenant gets its own client, its own connection pool and its own latches, held until
`resetAll`.

That is bounded rather than unbounded: the client pool is a 32-entry LRU, and an evicted client
costs its connection pool and nothing else, since the next request through that endpoint builds
another. But churning connection pools is not sharing them, and at that point a client of your
own, built and held per tenant, is the better answer than this.

The listings cache also remembers, for half a minute, that an endpoint did not name a model — the
case where a configured name never matches anything the server serves (a llama.cpp `-a` alias, an
OpenRouter `:free` suffix, a typo) would otherwise fetch the listing on every call and answer the
same zero each time. Half a minute later it asks again, so a model pulled onto a box that has been
up a week is still picked up without a restart.

`resetAll` drops all four, and `reset.ts` names each seam separately for a test that wants one.

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
