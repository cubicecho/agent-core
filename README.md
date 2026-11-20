# @cubicecho/agent-core

The endpoint-agnostic half of an OpenAI-compatible agent loop.

Site: <https://cubicecho.github.io/agent-core/>

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

How the pieces fit, in diagrams — prompt parts to system prompt, an exchange turn by turn, one
request — is in [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

| Module | What it does |
| --- | --- |
| `schema-compat` | Makes an MCP tool schema something a strict or grammar-constrained server will accept. `sanitizeTools`, `relaxTools`, `isGrammarError`, and `sanitizeSchema` and `relaxSchema` for a schema that is not a tool's. |
| `tool-loading` | On-demand tool discovery: a name-only catalogue plus a `load_tools` meta-tool, so an exchange pays for the schemas it asks for instead of all of them. Plus the proxied form of the same thing — `PROXY_TOOLS`, `proxyLoadResult`, `proxiedCall` — for a server whose prompt cache a growing tool array throws away. |
| `stream` | Reads one streamed reply back into a message: token callbacks, tool-call reassembly, a fenced scratchpad taken out of the answer, and the idle watchdog that turns a silent model server into `EndpointSilent`. |
| `capabilities` | What a model server turned out not to support — and, under it, what one model on that server did not — plus the loop that answers either when it says so. `capabilitiesFor`, `modelCapabilitiesFor`, `negotiate`. |
| `thinking` | Tells a scratchpad fenced inside `content` from the answer: `FenceSplitter` for a stream, `stripThinking` for a whole reply, and the fence tables both read. |
| `side-task` | One-shot calls that support an exchange without being one — small prompt, short answer, no tools, never worth failing the exchange over. Each is one request sent by `runTurn`, as a turn is. `askJson` holds the answer to a schema where the server can, and `taskCall` turns the settings an agent spec gives a task into the call that honours them. |
| `hooks` | The app's side of lifecycle hooks: `gather` before a request and `notify` after, the shared context budget, `withContext` to put what they add on the exchange's question, `untrusted` to fence text nobody vouched for, and `turnMessages` to hand them a transcript. Running a hook is a runner the caller passes. |
| `events` | The in-memory bus a watcher reads while a run happens: `emit`, `watch`, `history`, `fold`, `stamp` for an app that numbers its own, and `runMetrics` for what a run cost. A watcher's backlog is capped and reports its own gaps. |
| `client` | A pooled `OpenAI` client per model server, plus the context window: the served one where a local server says, the listed one otherwise, and their caches. And `resolveApiKey`, for a caller deciding which key a model server gets, and `probeEndpoint`, for listing one a form has not saved yet. |
| `retry` | What to do when a request is lost, refused or too big: `isTransient`, `isModelLoading`, `backoffMs`, `ContextOverflow`, `EndpointSilent`. |
| `calibration` | How many characters a token is worth on one model, learned from the prompt counts its model server reports: `charsPerTokenFor`, `calibrate`. |
| `continuation` | `continueTurn`: carries on an answer the token ceiling cut off, by prefilling it as a trailing assistant message. |
| `defaults` | Every number this package chose, grouped by what it tunes: `RETRY_DEFAULTS`, `COMPACTION_DEFAULTS`, `HOOK_DEFAULTS` and the rest, each a frozen object with a `…Settings` type. [Below](#the-numbers-it-was-written-with). |
| `config` | The structural interfaces every function here asks for, and `normalizeBaseUrl`, the one rule for when two base URLs are one model server. |
| `run-turn` | `runTurn`: one request with the retry loop around the negotiation around the stream. The whole loop, for a caller that wants it rather than its parts. Sizes the request against an opt-in `contextLimit`. |
| `agent-loop` | `runAgentLoop`: one exchange — `runTurn` per turn, the tools between, `load_tools` and preselection handled, until the model stops asking. |
| `remote` | Running against a remote agent, a model that runs its own loop: the progress-chunk codec (`progressChunk`, `withProgress`, `progressEvent`, `progressEvents`) and `IDEMPOTENCY_HEADER`. `runAgentLoop` reads it under `remoteAgent: true`. |
| `request-body` | `buildBody`: the one place a streamed request's body is decided from a config and what the model server and the model have refused. |
| `run-calls` | The tool half of a turn: its calls read, run and written into the transcript, with every call answered whatever happens. `preview` cuts a long argument or result for a watcher, and `formatToolError` words a failed call for the model. |
| `preselect` | Choosing an exchange's tools before it starts: `preselect` asks a small model, `preselectByKeywords` scores the request's own words against the tool names without one, and `preselectSystem`, `preselectInput` and `preselection` are the prompt and the reading of the reply for an app that makes the call itself. |
| `tool-calls` | Reading what a model meant by a tool call it did not write cleanly: `parseToolArguments` repairs almost-JSON arguments and says when they were cut off, `recoverToolCalls` finds calls written into the reply as text. Plus the shapes a call is handed round in: `ToolCallRequest`, `ToolCallResult`, `ToolCallOutcome`. |
| `compaction` | Keeping a long exchange inside its context window: `pruneToolResults` clears stale tool results, `planPrune` moves a boundary for them that keeps the prompt cache, `planCompaction` and `compactTranscript` replace the oldest stretch with a summary. |
| `ledger` | What stretches of a transcript cost, read off the prompt counts the server reported rather than estimated: `recordRequest`, `tokensBetween`, `estimateFrom`, `rebaseLedger`. |
| `snapshot` | `exportCapabilities` and `importCapabilities`: the latched refusals as a JSON blob a consumer stores, so a restart need not learn them again. |
| `spec` | `parseSpec`, `resolveAgentSpec` and `exportSpec`: an agent as a versioned JSON document, layered into the flat config the loop takes. Imports nothing but types, and is published separately at `@cubicecho/agent-core/spec`. `defineSpecColumns` maps a stored row onto a layer and back, at `@cubicecho/agent-core/spec/columns`. |
| `reset` | `resetAll`: drops every cache and latch in one call, so a teardown cannot forget one. |
| `runtime` | `createRuntime`: a second set of those caches, with the functions that use them as methods — for an app whose tenants must not share a client pool, a latch or an event bus. `defaultRuntime` is the one the top-level functions use. |
| `tokens` | How big a request is, estimated: `estimateTokens` — characters over four, deliberately low — and what is built on it for everything here that has to guess at a context window: `messageTokens`, `requestTokens`, `contextTokens`. |
| `errors` | `errorMessage`: a caught `unknown` turned into something a run row can hold. And what `runAgentLoop` throws, with the exchange as it stood: `AgentLoopError`, `ToolIterationLimit`, `AgentLoopOverflow`, and `failedRun` to read it off any of them. |
| `catalog` | `CatalogServer`: the name-only shape `tool-loading` reads a connected server as, with the server's own `instructions` beside it. |
| `instructions` | `serverInstructionsPrompt`: the servers' own `instructions` as one block for the system prompt, attributed by label, fenced by `untrusted` and cut to a budget per server. |

What is **not** here is the work: orchestration, prompts, and whatever the run is about. That
is the caller's, and it is the part that actually differs between one server and the next.

`llms.txt` is the same surface as a flat index — every export with the first line of its own doc
comment. It is generated from `src/index.ts` by `npm run llms`, which the build runs, so it is
the exports rather than a second description of them; CI fails if the committed copy has drifted.

## One request

`negotiate` wrapping `streamTurn` is the whole of one request to a model server: the request is
re-sent for as long as the answer is this server refusing something the request can do without,
and nothing is re-sent once the model has started answering.

```ts
import {
  capabilitiesFor, emit, getClient, idleTimeoutMs, negotiate, relaxTools, sanitizeTools, streamTurn,
} from "@cubicecho/agent-core";

const declared = sanitizeTools(tools);
const supports = capabilitiesFor(config);

const turn = await negotiate(supports, (supports, produced) =>
  streamTurn(
    getClient(config),
    {
      model, messages, stream: true,
      // Rebuilt per attempt: what the endpoint has refused is latched off by the line above.
      ...(supports.usageInStream ? { stream_options: { include_usage: true } } : {}),
      tools: supports.strictSchemas ? declared : relaxTools(declared),
    },
    { produced, signal, idleMs: idleTimeoutMs(config), onOutput: (text) => emit(runId, { kind: "output", text }) },
  ),
);
```

The key is passed because it is part of what a model server *is* here, not only how it is paid
for: a router is free to send two keys to two different backends, and then what one of them
refused is not a fact about the other. Absent and empty read the same, so a local server with no
key is one entry however its caller spells it.

`Turn` is `content`, `toolCalls`, `usage`, `finishReason` and `reasoning`, with `reasoningField` naming
the delta field the scratchpad came in, where one did. The fourth is worth
reading: a reply cut off at the token ceiling comes back looking exactly like a finished one, with
truncated prose or — the case that bites — a tool call whose `arguments` stop mid-JSON, so the
caller meets a parse failure with nothing to attribute it to. `finishReason` is `"length"` there,
`""` where the model server never said.

`usage` is `prompt`, `completion`, `total` and `cached`, always there and zero where the server
sent nothing. Everything else on it is there only when something measured it, and absent rather
than zero otherwise:

| Field | From |
| --- | --- |
| `uncached` | the prompt less `cached`, only where a cache count was reported, so a cold cache and no report read differently |
| `reasoningTokens` | `completion_tokens_details.reasoning_tokens`; never estimated from the streamed scratchpad |
| `promptMs`, `promptTokensPerSecond`, `predictedMs`, `tokensPerSecond`, `draftTotal`, `draftAccepted` | llama.cpp's `timings`, which also stands in for `cached` (`cache_n`) where the usage has no cache count |
| `firstTokenMs` | `streamTurn`, from the request to the first chunk that carried something |
| `wallMs`, `retries`, `timeouts` | `runTurn`: the whole request with its backoff, the lost requests sent again, and how many of those went silent |
| `continuations` | `continueTurn` |
| `cacheExpected`, `cacheBroken`, `cacheBreakReason`, `toolsDeclared`, `toolSchemaTokens`, `context` | `runAgentLoop`, below |

`reasoning` is the scratchpad `onThinking` was told, kept because some models want it back.
`runAgentLoop` writes it onto the assistant message under the field it arrived in, which
`reasoningField` on the reply names: llama.cpp reads back only `reasoning_content`, Ollama's `/v1`
only `reasoning`, and vLLM and OpenRouter either. A scratchpad split out of fenced `content` goes back
as `reasoning_content`, never glued into the text, since Qwen3.8's template no longer splits
`<think>` out of content itself. No scratchpad writes no field: never `null` or `""`, which llama.cpp
throws on and Kimi's template renders as `<think>None</think>`. `reasoningReplay` on the config says
which messages get it:

| `reasoningReplay` | Carries it | For |
| --- | --- | --- |
| `'all'` (default) | every assistant message, the answer included, never dropped | letting the template decide, which is where each model's rule already lives |
| `'tool-loop'` | each message that ends in tool calls, until the answer is written; the answer carries none, and the result's `messages` drop it from the question's tool loop | gpt-oss's harmony rule written client-side, for a server that renders whatever it is sent |
| `'none'` | nothing, as before 4.22 | a model that does not want it, since it is context paid for on every turn |

The default is `'all'` because stripping it client-side is the one choice that breaks somebody.
DeepSeek's API in thinking mode with `tools` wants every earlier assistant message's back, the
final answers included, and refuses the request without it. Qwen3.8 keeps the scratchpad of every turn
by default, and GLM-5.3 defaults `clear_thinking` to false. The templates that want less — Qwen3
through 3.6 and GLM-4.5/4.6 after the last user message, gpt-oss until a final answer, Kimi K2 after
the last plain assistant message — drop it themselves. And a prefix cache matches on rendered
tokens, so a replay that differs from what was generated is re-prefilled from that message on. 4.22
shipped with `'tool-loop'` as the default; 4.23 changed it.

**This is a change of default.** Before 4.22 no message carried it, and an exchange with a reasoning
model now sends its scratchpad back unless the app sets `reasoningReplay: 'none'`. `ModelParams` and
the spec's `model` section both take it, so an app exposes it as one setting. A model server that
refuses the field on a message — Groq, Mistral and `deepseek-reasoner` validate messages strictly —
is answered like any refusal here: latched off for that model as `reasoningContent`, and the request
sent again without it. `requestTokens`, `planCompaction` and the ledger count it as part of the
message it is on. A continuation's prefill carries it too, unless the policy is `'none'`: Qwen3.5+
renders a think block on that message either way, empty without it.

An app storing rows from `onMessage` gets the message as replayed, field and all; under
`'tool-loop'` the result's `messages` no longer carry it from the question on, and
`dropReasoning(rows, from)` does the same to the stored copy. History before the question is sent as
the app gave it.

Two providers hand back opaque state that has to go back byte for byte. OpenRouter streams
`reasoning_details`, a list of summary, signed-text and encrypted blocks, beside `reasoning`, and asks
for them back unmodified and in order. `streamTurn` puts them back together as `reasoningDetails` on
the reply: a text or summary block's pieces are joined, an index that differs or an encrypted block
starts a new one. `runAgentLoop` writes them back as `reasoning_details` under the same
`reasoningReplay` policy as the scratchpad, since they are part of it. `dropReasoning` and the
`reasoningContent` latch take them off with it. Gemini puts `extra_content.google.thought_signature`
on the first call of a turn, and refuses with a 400 a request that replays the turn without it. That
is not part of the scratchpad, so it stays on the call under every policy. The keys a call keeps are an
allowlist, `CALL_EXTRA_KEYS`, which is `extra_content` today, so no key a server merely added is sent
to a stricter one.

A server without a reasoning parser leaves the scratchpad in `content`, fenced, and then it is shown
as output, stored and sent back. `streamTurn` routes text inside a fence to `onThinking` and
`reasoning` instead, holding back the tail of a chunk that could be half a tag. `DEFAULT_FENCES` is
`<think>`, gpt-oss harmony's analysis channel served raw, and Kimi's `◁think▷`, none of which a
model writes as an answer; `ALL_FENCES` adds `<thinking>` and `<reasoning>`, which it can be
quoting, and is what the side tasks use. Pass `fences: []` to read `content` as all answer. A reply
cut off inside a fence has an empty `content`, not the scratchpad promoted to one. A template that
opens `<think>` in the prompt leaves only the closing tag, so everything before it is moved to
`reasoning` when it arrives; `startInScratchpad: true` says so up front, so `onOutput` is never told
it at all.

## What the model refuses, rather than the server

`strictSchemas` and `usageInStream` are facts about a server. Three more arrive through the same
channel — an error string on a chat completion — and are facts about a *model*: a
`reasoning_effort` it does not take, a ceiling it spells `max_completion_tokens`, a temperature
that is not ours to pick. They cannot latch on the model server, because one API key reaches every
model a provider offers: the first turn on `gpt-4o` would stop `gpt-5` ever being asked to reason
again, with the setting still reading `high` and nothing anywhere saying it had stopped.

So they hang off the model server under the name it knows the model by. Pass `model` and
the same loop answers both levels; leave it out and nothing changes.

A refusal of the *value* is not one of these, however alike the two read: a `max_tokens` larger
than the model's ceiling, a temperature out of range. Dropping the field answers those too — at
the model's own default, latched for the rest of the process, with the settings row still reading
what was typed and nothing saying it had stopped meaning it. They are passed to the caller
instead, where whoever typed the number can see it.

The effort is the exception, because there the model has said what it *would* take:
`Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values
are: 'minimal', 'low', 'medium', and 'high'.` `negotiate` latches the rung that was refused and
re-sends at the cheapest one above it, which is a request rather than a failure. Where the refusal
lists nothing it walks `EFFORT_LADDER` — `none`, `minimal`, `low`, `medium`, `high`, `xhigh` — a
rung per refusal. Both latch per `(endpoint, model)` and ride in the snapshot, so a restart does
not walk the ladder again.

A chat template's raise is read the same way, whether llama.cpp passes it on as a 500 or vLLM as a
400. Qwen3.8's says `Unexpected reasoning effort high. Supported types are xhigh (default), medium,
and low.` — so `high` is re-sent as `xhigh` and `minimal` as `low`, and the model's list is
latched. A generic `must be one of [...]` list is read too.

Only ever upward, and only from a value on the ladder. Answering a refused `xhigh` with `high`
would quietly reason less than whoever typed it asked for; stepping up from `none` only costs
tokens, and says so in a notice. When the ladder runs out, or the value is not on it, the refusal
goes to the caller as it did before.

`effortFor(model, asked)` is what a body builder calls to get the value to send — `buildBody` and
the side tasks both do — and it answers the empty string for a model that takes no effort at all,
for `"off"` and for an absent setting.

```ts
const turn = await negotiate(
  supports,
  (supports, produced, model) => {
    // Each rebuilt per attempt from what this model has already refused.
    const asked = effortFor(model, effort);
    return streamTurn(
      getClient(config),
      {
        model: name, messages, stream: true,
        ...(asked ? { reasoning_effort: asked } : {}),
        ...(model?.legacyTokenLimit === false
          ? { max_completion_tokens: limit }
          : { max_tokens: limit }),
        ...(model?.chosenTemperature ? { temperature } : {}),
        tools: supports.strictSchemas ? declared : relaxTools(declared),
      },
      { produced, signal },
    );
  },
  { model: name },
);
```

The ceiling is the one of the three guarded on `=== false` rather than on truthiness, and it is
the only one that has to be. The other two *omit* a field where the flag is absent, so a caller
that leaves `model` out sends a smaller request and nothing else; both branches of this one are a
field, so truthiness picks the newer spelling for a caller who was told nothing would change —
and the newer spelling is exactly the one an older model or a llama.cpp-shaped model server rejects.
`modelCapabilitiesFor` starts a model at `legacyTokenLimit: true`, and an absent model has to read
the same way it does.

`multiCallMessages` is the model's template refusing an assistant message with several tool calls,
answered by replaying one call per message — see
[A template that takes one call per message](#a-template-that-takes-one-call-per-message).

One more model flag is never answered by `negotiate`: `assistantPrefill`, whether the model
carries on a trailing assistant message rather than answering afresh after it. Only `continueTurn`
sends one, so only it latches the flag, and it is persisted in a snapshot like the rest.

`runTurn` takes the same option and hands `request` the same second argument. Keying on
`(endpoint, model)` rather than the model name alone is the part worth keeping: `gpt-4o` at
OpenAI and `gpt-4o` behind a proxy need not be the same weights, and one that refused a reasoning
effort must not speak for the other.

`send` takes a callback rather than a body because the body has to be rebuilt from the latched
flags. `produced` is one box per attempt — `streamTurn` sets it on the first chunk that carries
text, scratchpad or a piece of a tool call, and the re-send reads it — so a caller with its own
retry budget passes one in (`{ produced }`) and reads it afterwards to decide whether the failure
is worth another attempt. The content-free `{"role":"assistant"}` most servers open a stream with
does not set it: nothing has been shown to anybody yet, so a model server that primes the stream and
then wedges is retried like one that never answered at all.

`inFlight` is the other box `streamTurn` takes, for what an attempt had said once it has thrown:
each call sets its `read` as it starts, so after a retry it reads the attempt that failed last and
nothing of the one before. `runTurn` and `continueTurn` pass it through, the second with the
answer it is continuing joined on, and `runAgentLoop` reads it into a failure's `partial`.

`idleMs` is silence, not a deadline: the timer is rearmed on every chunk, so a model that is still
talking is never cut off however long it takes, and one that has stopped answering raises
`EndpointSilent` rather than hanging the exchange. `idleTimeoutMs(config)` returns `undefined` for a
`requestTimeoutSeconds` of zero or absent, which waits forever — what a local model answering slowly
needs.

The first chunk gets its own allowance, `firstChunkMs`, because the first wait is prefill: tens of
seconds for a long prompt on a local GPU, minutes on a CPU, and longer again when the server is
loading the model on demand. It holds until a chunk carries something, so an empty
`{"role":"assistant"}` sent before the prompt is read does not start the idle clock.
`firstTokenLimitMs(config)` reads `firstTokenSeconds` off the endpoint, and five times
`requestTimeoutSeconds` where that is absent. With a watchdog armed, the SDK's own timer is switched
off for the stream; it runs until the headers arrive, which is the end of prefill, and used to
abandon one at the idle number. `requestTimeoutSeconds` still bounds calls that do not stream, such
as model listings, the same way. A side task streams, and waits `requestTimeoutSeconds` for its first
chunk as well as between chunks.

## Structured side tasks

`askJson` is `ask` for an answer with a shape. It sends the schema as `response_format` of type
`json_schema`, which llama.cpp compiles into a grammar and vLLM, LM Studio, Ollama and OpenAI each
hold the reply to, so a small model that wraps JSON in prose on its own cannot do so here. The
schema is normalised the way a tool's parameters are, and relaxed where the model server could not
build a grammar, because llama.cpp reads both with the same converter. It also rides on the system
prompt, and the reply goes through `parseJson` either way — which finds the JSON inside prose or a
fence and repairs what a local model gets nearly right: single quotes, `True` and `None`, bare keys,
a trailing comma.

```ts
const picked = await askJson<{ tools: string[] }>(config, small, system, request, PRESELECT_SCHEMA, {
  name: "preselection",
  onNotice,
});                                              // undefined when no JSON came back
```

A model that refuses the field latches `structuredOutput` off, per `(endpoint, model)` like the
other refusals here, and is asked in words from then on. A server that finds the *schema* invalid
is not latched: that error is the caller's to see. `strict` defaults to true, which OpenAI takes to
mean every property required and `additionalProperties: false`; a looser schema wants it off there.
`preselect` is its first user, answering `{ tools: [...] }`, and `preselection` still takes the
bare array an older prompt produced.

### Showing a side task an image

`ask` and `askJson` take the user message as a string or as content parts, because an image reaches an
OpenAI-compatible server only as an `image_url` part beside the text. The parts are sent as given
and nothing here checks that the model can see: whether a text-only model rejects the image or
answers without it is up to the server, so pick a vision model.

```ts
const page: SideTaskInput = [
  { type: "text", text: "Transcribe this page." },
  { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
];
const text = await ask(config, visionModel, "You are an OCR engine.", page);
```

### Telling a finished reply from a cut-off one

`ask` returns the text alone, so a reply that ran into `maxTokens` reads like one that finished.
Where the reply is the product, `askReply` takes the same arguments and also returns the choice's
`finish_reason` as the server sent it, or `undefined` where it sent none. A model looping on a page
writes until the ceiling stops it, and a transcript saved from that is worse than none:

```ts
const { text, finishReason } = await askReply(config, visionModel, "You are an OCR engine.", page);
if (finishReason === FinishReason.Length) {
  // cut off: retry with a higher ceiling, or keep the OCR text already there
}
```

Nothing is thrown for a cut-off reply, since whether one is still worth keeping is the caller's
call. `askJson` needs no such variant: a reply cut off before its JSON closed does not parse, so it
comes back `undefined`, as a reply with no JSON in it does.

### How a side task is sent

A side task is one request sent by `runTurn`, the way an exchange's turn is: streamed, negotiated
past what the model server refuses, sent again when it is lost, waited out while a local server
loads the model, and measured for the next request's token estimate. What `ask` adds is the body:
the ceiling and temperature, a reasoning effort, the no-thinking hints, `extraBody`, and
`askJson`'s `response_format`.

- **A lost request** — a dropped connection, a 429 or 5xx, a model server gone silent — is sent
  again after a backoff, twice unless `maxRetries` says otherwise. A side task can therefore take
  longer than one round trip before it fails.
- **A model still loading** is waited out for up to two minutes, polled without spending a retry,
  with one notice.
- **A refusal** is answered by `negotiate` alone. The no-thinking hints (`chat_template_kwargs`) are
  a droppable field, latched into the model's `refusedFields` when a refusal names them, and the
  effort is latched or stepped up as an exchange's is. A refusal that names nothing is not guessed
  at: the side task fails, and `tryAsk` turns that into no answer and a notice.

```ts
const title = await tryAsk("title", () => ask(config, small, "Name this chat.", first, { onNotice, signal }), {
  onNotice,
  signal,
});                                              // undefined where it failed, after its retries
```

Before 6.0.0 a side task did not stream, retried nothing, and answered a 400 or 422 that
`negotiate` could not read by sending it once more without the hints and the effort, latching the
hints if that got through. Snapshots changed shape with it: 6.0.0 writes version 2, and a version 1
snapshot from before is not imported, so the latches are learned again.

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

`contextLimitFor` answers the operator's number when there is one. Otherwise it reads the
`/v1/models` listing first. A context window at the top of the model's entry (`context_length`,
`max_context_length`, `max_context_window`, `max_model_len`, `context_window` or `n_ctx`: vLLM's `max_model_len`,
OpenRouter's `context_length`) is taken as the one being served, and nothing else is asked.

Where the listing does not settle it, the server's own API is asked (`servedWindow`): llama.cpp's
`/props` (`default_generation_settings.n_ctx`), then LM Studio's `/api/v0/models`
(`loaded_context_length`). That covers a model listed with no context window, which is LM Studio, and one
listed with only `meta.n_ctx_train`, which is llama.cpp. The trained context window differs from the served
one in the case the guard exists for, a 256k model started at `-c 16384`, so it is used only when
neither native route gives a number. What a native route answers, a context window included, stands
for `listingMissMs`, so a server restarted with another `-c` is sized by its new one within the
interval. A server with neither route is latched and not asked again.
`/api/v0/models` is also dropped on its own: for the life of the process once it answers 404, 405
or 501, and for `listingMissMs` after any other error. A 200 that is not JSON counts as a missing
route: it is what a proxy with a web app of its own (llm-router) answers on every path it does not
route. Neither route is sent `NO_KEY` as a bearer; a model server with no key is asked with no
`Authorization` header at all.

An app that sizes the context window before each exchange passes the exchange's signal as the third
argument, so a stopped exchange does not wait on the lookup:

```ts
const contextLimit = await contextLimitFor({ ...settings, model }, settings.contextLength, { signal });
```

It rejects with the signal's reason, closes the request it had open, and remembers nothing of the
lookup. Nothing else makes it reject. `listModels` and `servedWindow` take the same option.

The lookup is also bounded on its own, at ten seconds across the listing and the native routes
together, or at the model server's request timeout where that is shorter. `requestTimeoutSeconds` is
how long to wait for a model to speak, and a model server that accepts the connection and then says
nothing would otherwise hold the lookup for that long, or for ever where there is none. Past the
bound `contextLimitFor` answers zero, as it does for a server it could not reach, and
`listModels` rejects with a `TimeoutError`.

### Listing a model server that is not saved yet

`listModels` is for a model server that is configured: it pools a client per URL and remembers what
came back. A settings form asking at each keystroke would leave a client behind for every
half-typed URL, so it asks `probeEndpoint` instead, which makes one plain request and remembers
nothing:

```ts
import { EndpointProbeError, ProbeFailure, probeEndpoint } from "@cubicecho/agent-core";

try {
  const models = await probeEndpoint({ baseUrl: typed, apiKey: typedKey }, { signal });
} catch (error) {
  if (error instanceof EndpointProbeError) {
    // error.kind: invalid-url, unreachable, timeout, unauthorized, redirected, not-openai, failed.
    // error.message is a sentence naming the endpoint by its origin, fit to show under the field.
    return { problem: error.message };
  }
  throw error; // the signal's own reason
}
```

It refuses a URL `normalizeBaseUrl` refuses before asking anybody, follows no redirect (so a typed
key is never carried on to a host nobody typed), reads both OpenAI's `{ data: [...] }` and
Ollama's native `{ models: [...] }` (by `name` where an entry has no `id`), and hands back each id
once, sorted, at most `limit` of them (500 unless told). It is bounded as a lookup is.

A top-level listing key is trusted without a second opinion, so on a server that puts a trained context
window there, pass `contextLength`. Ollama reports no context window on any route this reads, and truncates
an over-long prompt rather than refusing it, so on Ollama pass `contextLength` or there is no guard
at all.

What is weighed is the prompt plus the reply ceiling the body carries, under whichever spelling
was chosen, because that is what the model server weighs: a 30k prompt into a 32k context window with
`max_tokens: 4096` is refused there, so it is refused here. A body with no ceiling reserves
nothing, and the server gives the reply whatever the prompt leaves. A consumer that subtracted
`maxTokens` from the context window itself before calling in no longer needs to, and doing both reserves
the ceiling twice.

How many tokens the body is, is a guess: characters over a divisor. Four is right for English prose
and wrong for what a tool-using exchange is made of — JSON schemas and tool results pack closer to two or
three characters a token — so a request the guard let through was refused anyway. The divisor is
learned instead. Every reply `runTurn` returns comes with the model server's exact prompt count for a
body whose characters were already counted, and `calibrate` keeps that ratio per model server and model;
the next request to the same model is sized by `charsPerTokenFor`, which is four
until a reply has reported one. It is the highest of the model's last four readings, which is the
lowest token count: a count that comes out high refuses a request that would have fit, and one that
comes out low only costs the round trip the guard was saving. A reading from a request carrying an
image, or outside one to eight characters a token, is not taken.

`requestTokens` and `messageTokens` take `{ charsPerToken }`, and so does `planCompaction`, so a
caller sizing its own work can use the same number:

```ts
const charsPerToken = charsPerTokenFor(capabilitiesFor(config), config.model);
const plan = planCompaction(messages, { limit, used, charsPerToken });
```

The ratio is a measurement rather than a refusal, so it is not a capability latch and is not in
`exportCapabilities`: it moves every turn, and a restarted process learns it again from its first
one. llama.cpp's `/tokenize` would count exactly, but only after `/apply-template` renders the
prompt — two round trips before every guarded request, on one server — so it is not used.

The body is sized once, not per attempt: a downgraded request is strictly smaller than the one
before it and the transcript does not change between retries. A `ContextOverflow` from this is
neither a capability `negotiate` can answer nor something `isTransient` accepts, so it leaves
both loops on the first attempt.

`contextLimit` decides how early the caller hears, not what it hears. Without one, the model server
refuses instead — one round trip later — and `runTurn` reads that refusal back through
`isOverflow` and raises the same `ContextOverflow`, carrying the model server's own wording and the
original error as `cause`. A rate limit borrows those words and means the opposite ("Request too
large for gpt-4o ... on tokens per min"); that is ruled out and waited through as the 429 it is.

A server still loading the model is waited for on its own clock. llama.cpp answers 503 `Loading
model` (type `unavailable_error`) until the weights are mapped, thirty to ninety seconds for a large
model from a cold cache, and a router build says the same while it swaps models; `backoffMs` would
give up inside fifteen. `isModelLoading` recognises it, and `runTurn` polls every three seconds
for up to `loadingTimeoutMs` (two minutes by default, zero to turn it off) without spending
`maxRetries`, with one notice at the start. `runAgentLoop` reads it as `loadingTimeoutSeconds` off
the config. A 503 that says nothing about loading stays on the ordinary backoff.

### What is filling the context window

A total tells an operator a request is close to the edge and nothing about what to do next, so
`contextTokens` cuts the same body four ways, along the four levers there are: `system` is the
system and developer messages, which means shortening the prompt; `tools` is the declared schemas,
which means loading them on demand instead of declaring them whole; `toolResults` is exactly the
`tool` messages, which is precisely what `pruneToolResults` shrinks; and `history` is everything
else, which is what compaction summarises, the arguments of the calls in it included.

```ts
const { system, tools, history, toolResults, total } = contextTokens(body, {
  charsPerToken: charsPerTokenFor(supports, config.model),
  // Optional: what the endpoint said the prompt cost, once a turn has come back.
  promptTokens: turn.usage?.prompt_tokens,
});
```

The parts are shares of one total rather than four separate estimates, because a readout whose
parts do not add up to the number beside them is one nobody trusts; the largest part absorbs the
rounding, so they sum exactly. Nothing in the round trip reports anything finer than a prompt
count — a completion says how many tokens it read and not a word about where they came from — so
the proportions are a guess whatever the total is, and `contextChars` is there for a caller that
wants the exact characters underneath them.

Given a `promptTokens` the total is what was charged and every part is a share of it. Without one
the total is `requestTokens`, and the tool block is counted the way `requestTokens` and
`TurnMetrics.toolSchemaTokens` count it rather than shared out, so the breakdown and the metrics
line cannot disagree about the same tool list.

An app on `runAgentLoop` has no body to hand it, since the loop builds the request. It does not
need one: each `usage` event's `turn.context` is this breakdown for that turn, and `onRequest` is
handed the request itself for an app that cuts it some other way. Both are under the loop, below.

## The loop

`runAgentLoop` is the part of an agent that three servers had each written, and that had drifted
the way a single request had before `runTurn`: one noticed a reply cut off at the ceiling and two did not,
one tested the ceiling's spelling the other way round, one sent a reasoning effort and two never
did. What it does not know is what the run is for — the prompt, the tools, and what a tool call
*does* are the caller's.

```ts
import { runAgentLoop, emit } from "@cubicecho/agent-core";

const { turn, messages, usage, loaded } = await runAgentLoop({
  config,                         // Endpoint & ModelParams & { maxToolIterations, toolDiscovery?, maxRetries?, loadingTimeoutSeconds?, contextLength? }
  systemPrompt,                   // sent as the first message; on-demand and proxied modes append the catalogue
  messages: history,              // ending in the question; not written to
  tools,                          // every tool the run may reach
  catalog,                        // the same, name-only, for on-demand and proxied loading
  hostTools,                      // the host's own, declared in every mode and never catalogued
  serverInstructions: true,       // the catalogue's `instructions` after `systemPrompt`; off by default
  preselected,                    // from `preselect`, if a small model chose
  dispatch: ({ name, args }, signal) => pool.call(name, args, signal),
  hooks: { run, context: { session: { id } } },
  signal,
  onEvent: (event) => emit(runId, event),
});
```

Each turn is one `runTurn` with the body from `buildBody`, so everything `negotiate` answers is
answered here too, and a request that is too big throws `ContextOverflow` whichever side found
out. Then the loop runs the turn's calls: sequentially by default, together with `parallel: true`, or
reads together and writes in order with a predicate (below).
Either way an identical call — the same name and arguments, byte for byte — is made once and its
answer handed to the repeat, and two still in flight share the request. A call that threw is
forgotten rather than cached, so asking again is a real retry. What a tool throws is what the model
reads, behind `Error: ` — chat completions has no `is_error`, so a failure the text does not announce
reads as an answer — unless the message opens with `error` already; `formatToolError` replaces that
wording, and the default is exported under the same name. Arguments that did not parse, and the
loop's other refusals, are read in their own words. A result is never empty: one with nothing in it,
failed or not, is `(no output)`, as agent-mcp-pool writes an empty MCP result.

The scope is the turn, not the exchange: between turns other tools have run, and the file the model read
may be the file it has since written. `dedupeToolCalls: false` dispatches everything, and a
predicate is asked per call — which is how `send_email` opts out, since twice is two emails and
nothing in an OpenAI tool definition says which tools those are. A pool that reads the MCP
`readOnlyHint` and `idempotentHint` annotations can answer it; this package cannot.

`parallel` takes a predicate for the same reason. Consecutive calls it passes run together, and a
call it fails is a barrier: it waits for every call before it and every call after waits for it,
so a read asked for after a write sees what the write did.

```
read A, read B, write C, read D, read E   →   [A ‖ B] → C → [D ‖ E]
```

Results go into the transcript in the order the model asked, and inside a batch `onToolResult` and
the events arrive as calls finish, as with `parallel: true`. The calls the loop answers itself —
`load_tools`, unreadable arguments, an identical repeat — are not put to the predicate and count
as reads. `@cubicecho/agent-mcp-pool` (3.10.0 and later) answers both predicates from the
annotations of a server whose row sets `trustAnnotations`, and the worst case — run alone, send
every time — for everything else:

```ts
const reads = (call: ToolCallRequest) => pool.readsOnly(call.name, { servers });
await runAgentLoop({ ...options, parallel: reads, dedupeToolCalls: reads });
```

### A template that takes one call per message

Some chat templates cannot render an assistant message with several calls. Llama 3.1, 3.2 and
3.3 raise `This model only supports single tool-calls at once!`, and gpt-oss's HF jinja reads
`tool_calls[0]` and answers every result as that call. A reply with two calls — which vLLM's
`llama3_json` parser hands back by default, and which recovery can find in the text on any server —
then fails the *next* request, after its calls have already run.

`singleCallMessages: true` on the config writes each call as an `assistant`/`tool` pair of its own,
in the order asked, and runs them one at a time whatever `parallel` says. The first message keeps
the text and the scratchpad, and each one after it is `content: null` and one call, under the id
the model gave it:

```
assistant [A, B], tool A, tool B   →   assistant [A], tool A, assistant [B], tool B
```

Every request then also sends `parallel_tool_calls: false` beside its tools — vLLM acts only on an
explicit `false`, and OpenAI refuses the field with no tools — and replays any earlier message with
several calls split the same way (`oneCallPerMessage`, exported for an app's stored transcript).
A refusal that names the field, in whatever words, drops it for the model and sends again, since
vLLM's `hf` parser refuses `false`. An `extraBody` that sets it wins.

Without the option the template's refusal is answered the way the others in this file are: it
latches `multiCallMessages` off for that model on that model server, says so in a notice, and sends the
same request again split. From then on the loop writes split, and the latch rides in the snapshot.

The split is made as each call is written, not only as the request is built, so the result's
`messages` and every row an app stores from `onMessage` are already a transcript the model can be
sent, and each later request replays the same messages byte for byte, which keeps the prefix cache.
The split on send is the same function, idempotent on a split transcript, so it costs nothing
there and only reshapes what was written before the latch. Each pair is one call and its result,
so templates that pair results by position rather than by id — Qwen, GLM, DeepSeek V3.2 — read the
same transcript. `onMessage` hears the first piece with the reply and `written`, whose `raw` is still
the whole reply, and the rest without either. An exchange stopped part-way ends at the last pair: a call
whose message was never written is not answered either.

Three kinds of call never reach `dispatch`: `load_tools`, which the loop answers itself, a call
whose arguments could not be read, and that identical repeat. An app that draws each call as a
card and fills it in when the result lands hears of those through `onToolCall` and `onToolResult`,
which are told of every call the model made — the request as `dispatch` would have been handed it
(with empty `args` where they could not be read), then `{ id, name, ok, content }` with the whole
text the model reads. A repeat gets a result of its own under its own id, carrying the answer it
shares. Neither is awaited. A handed-back call is told at the end of its turn, with no result to
follow; a call stopped part-way gets no result, and one never run, or handed back in a turn another
call ended, is not told at all. The `tool-call` and `tool-result` events carry the same `id`, with
`text` still cut by `preview`, and so does each entry of the result's `toolCalls` — which is what
tells two calls to one tool apart when `parallel` lands their results out of order. An id is
distinct across the transcript (`distinctCallIds`), except on a remote agent, whose ids are kept as
sent.

```ts
await runAgentLoop({
  // ...
  onToolCall: ({ id, name, args }) => send({ type: "tool_use", id, name, input: args }),
  onToolResult: ({ id, ok, content }) =>
    send({ type: "tool_result", toolUseId: id, content, isError: !ok }),
});
```

### What the calls made

A tool that wrote a document or saved a file can say so, and `dispatch` can pass that on: it
resolves to a `ToolAnswer`, `{ text, links }`, in place of the string. `text` is the whole of
what goes into the transcript, so the request, the prompt cache, pruning and compaction never see
the links. `links` are `ResourceLink`s, MCP's own shape declared structurally, so what
agent-mcp-pool's `call` answers with `links: true` is a dispatcher's answer as it stands.

```ts
const { artifacts } = await runAgentLoop({
  // ...
  dispatch: ({ name, args }, signal) => pool.call(name, args, { signal, links: true }),
});
// [{ link: { uri, name, title?, ... }, callId, tool, turn, count }]
```

The loop collects them into the exchange's `artifacts`: one per uri in the order first seen, each with
the call, tool and turn that first linked to it and the number of calls that did. A link is what
one call answered with; an artifact is what the exchange made. `onToolResult` hears a call's `links`
beside its `content`, an `artifact` event goes out the first time each uri appears — `name` the
tool, `text` the title or else the uri, and `link` the link — and `runMetrics` counts those events
as `artifacts`. A deduplicated repeat shares the first call's answer and links but adds nothing to
the count, since nothing was made twice. A call that threw made nothing. A failed exchange carries what
its calls made on the error too, read off with `failedRun`.

A link meant for the model alone — one whose MCP `audience` leaves out `"user"` — is the
dispatcher's to drop, since that is MCP's rule and this package knows nothing of MCP.

A link is the only source that takes no guessing, and the default. For servers that never send
one, `artifacts` turns on the two that do, each off unless asked for:

```ts
const { artifacts } = await runAgentLoop({
  // ...
  artifacts: { declare: true, detect: true },
});
// [{ link, callId, tool, turn, count, source: "declared", action: "updated", sizeBytes }]
```

- **`declare`** puts `record_artifact` (`RECORD_ARTIFACT_TOOL`) beside `hostTools` on every turn,
  in every mode, and the loop answers it without `dispatch` seeing it. It takes `location`,
  `title`, `description` and `mediaType`. A declaration is believed only where some successful
  call in the exchange was given or answered with that location — otherwise a model with no file tools
  "saves" its answer to a file it never wrote — and the refusal is the call's answer, for the model
  to read. A believed one is put down to the latest call that touched the location. In a
  `parallel` batch it waits for the batch's other calls, so a write beside it counts.
- **`detect`** reads every successful call for the shape of a write: a verb at the front of the
  tool's own name (`write`, `create`, `save`, `upload`, `edit`, `move`, `delete`…) and a path in
  its arguments (`destination`, `path`, `file_path`, `uri`…). Creating a folder is not an artifact.
  A predicate in place of `true` reads only the calls it passes, which is how an app keeps its own
  tools' writes off the list. `detectArtifact` is the same reading, for an app to call itself.

One artifact per location per exchange, whichever sources found it. A later write moves `action`
(`created`, `updated`, `moved`, `deleted`) and `sizeBytes` on; a declaration over a detection
fills in the title and description and takes the `source` over, and never turns an `updated` back
into `created`. A link is the server's word: a declaration over one fills only what it left out,
and a link over either guess takes over. `source` is absent on a linked artifact, so the shape
from before reads the same — `artifactSource` reads it as `linked`. The `artifact` event goes out
once per location; the result's `artifacts` say what each ended as.

### A call that ends the exchange

A tool whose call is the end of the job — handing off, asking a person — says so with `end` on
its `ToolAnswer`, `true` or `{ reason }`. The loop answers every call of that turn, sends no
further request, and resolves with `ended`; aborting the exchange's signal from inside `dispatch` was
the way out before, and that is a failure the app then has to dig the exchange back out of.

```ts
const result = await runAgentLoop({
  // ...
  dispatch: async ({ name, args }, signal) =>
    name === "ask_person"
      ? { text: "Asked. This run ends here.", end: { reason: String(args.question) } }
      : pool.call(name, args, { signal }),
});
if (result.ended) {
  // { callId, name: "ask_person", reason }
  const { callId, name, reason = "" } = result.ended;
  emit(runId, { kind: RunEventKind.Done, ok: true, id: callId, name, text: reason });
}
```

The turn's other calls still run, whichever side of the end the model asked for them and however
`parallel` batches them: they were asked for in the same reply, and a model that says "write the
file, then hand off" wants the file written in either order. Where two calls end it, `ended` is
the first in the order asked, and an end in the last turn `maxToolIterations` allows resolves too,
since nothing was left undone. Everything else is a finished exchange's — `usage`, `metrics`,
`messages`, `artifacts`, the `afterExchange` hooks — with `metrics.outcome` `ended` and a notice
saying which tool ended it. `turn` is the reply that made the call, so its `content` is whatever
the model wrote beside its calls, often nothing; the exchange's answer is what the ending tool took.
The tool, its definition and its wording stay the app's: this is only the exit.

The exchange's `exchange-end` event carries the call as well — `id`, `name` the tool, `text` the
reason — and its `outcome` is `ended`, so `runMetrics` reads the same outcome off the events as the
result has.

Arguments go through `parseToolArguments`, which is lenient where the model's meaning is plain:
JSON held in a string is opened, and the almost-JSON local models write — single quotes, Python's
`True` and `None`, bare keys, a trailing comma — is repaired, without touching what is inside a
string. What still is not an object throws a `ToolArgumentsError` whose `kind` is `truncated` when
the reply stopped at the ceiling, with a message telling the model so, and `malformed` otherwise.
The repaired JSON is what the transcript keeps, and an unreadable call is replayed as `{}`, because
a server that parses replayed arguments refuses the originals on every later request. `dispatch`
is still handed the model's own text as `raw`, with `repaired` true where reading it took a repair
— whitespace and blank arguments do not count — and the dedupe compares repaired arguments, so
`{'a': 1}` and `{"a": 1}` are one call. A call recovered from text, below, is always `repaired`,
and its `raw` is the arguments recovery read out of the reply, as JSON.

A server whose tool-call parser was written for another template streams the model's call as
plain text, and the exchange ends on a reply that is nothing but a call nobody made. Unless
`recoverToolCalls: false`, a reply with no calls, some text, and tools to call is passed through
`recoverToolCalls`, which finds `<tool_call>` blocks (Hermes, Qwen, Qwen3-Coder's markup),
`[TOOL_CALLS]` (Mistral, both spellings) and `<|python_tag|>` (Llama 3) after the last close of a
`DEFAULT_FENCES` scratchpad (`</think>`, harmony's `<|end|>`, Kimi's `◁/think▷`), and — naming only tools that exist — a reply that is only a JSON call or holds one fenced one.
Found calls are run under ids of their own, the text is what is left, `onTurn` and the
result see the reply that way, and a notice says so, since the real fix is the server's parser.

Every id the loop makes up — for a call recovered from text, a streamed call the server sent
without one, and a proxied preselection's load — is nine characters from `[A-Za-z0-9]`, which is
the strictest rule any server holds them to (Mistral's tokenizers before V13 refuse anything else)
and inside every other's. Each is checked against every id in the transcript, the app's history
included, so one id answers for one call across the whole transcript: vLLM's harmony path and Ollama find
a result's tool by its id across the history, and Anthropic behind a proxy refuses a repeat. A
server's own id is kept as sent unless it is empty or the transcript already uses it, as a server
that numbers its calls from zero on every turn does; then it is replaced once, before the message
is stored, so the call and its result carry the new id on every later request. `mintCallId` takes
the source of ids — `callIdMinter(seed)` gives a repeatable sequence for a test — and
`distinctCallIds` is the same check for an app with its own loop.

An id unique within one transcript is not unique across several: two exchanges with a server that counts
from zero both hold a `call_0`. An app that hands calls out of the exchange and matches the answers back
by id passes `callIds: 'minted'`, and every call gets a minted id before its message is stored, so
the transcript, the events, `onToolResult` and `toolCalls` all carry the one the app hands out.

Every request declares its tools in name order, whichever way the caller assembled the array. A
chat template renders the tool block ahead of the system prompt, so the tool array is the first
thing a prompt cache has to match, and an array built from a map, from database rows, or from the
order servers happened to connect in is a different array on the next boot — the same tools, the
same run, and the cache for the whole transcript thrown away. Ordering by name makes it a property
of the set instead. `toolOrder: false` sends the caller's order, for an app that means it — a model
reads the array top to bottom — and a comparator orders it another way. `orderTools` is the same
thing for a caller with its own loop, and `buildBody` takes the order as its last argument.

With `toolDiscovery: "ondemand"` and a catalogue, the request declares `load_tools` and what has
been loaded, and the catalogue rides on the system prompt
unmarked, the same text on every turn. Marking loads there rewrote the head of the prompt and lost
the prompt cache for the whole transcript on each one; a model that loads a tool twice is told in
the `load_tools` result that it already has it. A model that calls
a catalogued tool without loading it first is right about what it wants, and gets it loaded and
run. A preselection shapes the first turn alone: those tools, no catalogue, no `load_tools` —
a model with the menu still in front of it shops, reloading what it has or picking a sibling —
and everything is back from the second turn on.

That first turn has a request head of its own — a different system prompt and a different tool
array from the last exchange's final request, and from this exchange's second turn — so a prompt cache
misses the whole transcript twice on a question that has a preselection. `preselectRouting:
"append"` drops the separate head: the shortlist is loaded as a `load_tools` call would have loaded
it, after whatever `loaded` carried and without declaring a carried name twice, and the first turn
is sent like every other, catalogue and `load_tools` included. The trade is the menu back in front
of the model on the turn the shortlist was meant to settle. Neither cost has been measured against
the other, so `"exclusive"` stays the default.

Appended is where the tools go before `toolOrder` orders them. With `toolOrder: false` a carried
tool array stays a strict prefix of the new one. With name order, the default, a preselected tool
is sorted in and moves every definition after it — the first turn still matches the second, but
the last exchange's cache holds only as far as the first new name.

`toolDiscovery: "proxy"` is the same catalogue behind a tool array that never changes. A chat
template renders the tool array in the system message, so on a server that caches by prefix —
llama.cpp, and anything built on it — a `load_tools` that appends a definition changes the head of
the prompt and the whole transcript is prefilled again, on the very turn that was meant to save
tokens. Proxied, every turn declares `PROXY_TOOLS` and nothing else: `load_tools`, and `call_tool`,
which takes `{ name, arguments }`. A load answers with each new tool's name, description and
parameters as a line of JSON, since no request will ever declare them, and with a pointer back for
one whose definition is already in the conversation. Whether it still is, after a `beforeTurn`, a
prune or a compaction, is read off the transcript's text, so only a definition one of them took out is
sent again. A `call_tool` is refused for a name outside
the catalogue, takes `arguments` as an object or as JSON in a string, and reaches `dispatch` as the
tool it names — the inner name and arguments, under the call's own id — so a dispatcher, a watcher
and `used` see the same thing in every mode. The transcript keeps the `call_tool` the model wrote.

```ts
const { messages, used } = await runAgentLoop({
  config: { ...config, toolDiscovery: "proxy" },
  messages: history,
  tools,                          // never declared; a load answers with them
  catalog,
  preselected,                    // written into the transcript, not into the tool array
  dispatch: ({ name, args }, signal) => pool.call(name, args, signal),
});
```

A preselection has no tool array to go into there, and no turn of its own. It is written into the
transcript after the question as a `load_tools` call the model did not make, and the result that
call would have had:

```ts
{ role: "assistant", content: null, tool_calls: [{ id: "q7Rk2mXa9", type: "function",
    function: { name: "load_tools", arguments: '{"names":["files__read_file"]}' } }] },
{ role: "tool", tool_call_id: "q7Rk2mXa9", content: "Loaded 1 tool(s). Run them with `call_tool`.\n\n{...}" },
```

The pair is in the `messages` the loop hands back, to be stored like any other, and is reported as
a `tool-call` and a `tool-result` event, told to `onToolCall` and `onToolResult`, and counted in
`toolCalls` and in the `load_tools` metrics. The
id is minted like any other the loop makes up, and checked against the transcript, so two questions
do not share one. A name
with no definition in `tools`, or outside the catalogue, is left out, and none left writes no pair.

An app with tools of its own — a question for a person, a resource read — passes them as
`hostTools`, and they are declared on every turn in every mode: after `PROXY_TOOLS` proxied, after
`load_tools` and ahead of anything loaded on demand, after `tools` in eager mode, and after the
shortlist on a preselected first turn. They reach `dispatch` like any other call and are kept out
of discovery: taken out of `catalog`, `loaded` and `preselected` before the exchange starts, never
counted as a load, and a `call_tool` naming one is refused with a pointer to call it directly.
Proxied and eager, the array is one set for the whole exchange, so the cache holds whatever `toolOrder`
does with it; on demand, `toolOrder: false` keeps them in the prefix every load appends after.

```ts
await runAgentLoop({
  config: { ...config, toolDiscovery: "proxy" },
  messages: history,
  tools: pool.tools(),
  catalog: pool.catalog(),
  hostTools: [ASK_PERSON_DEFINITION], // declared beside load_tools and call_tool, on every turn
  dispatch: (call, signal) =>
    call.name === ASK_PERSON ? ask(call.args) : pool.call(call.name, call.args, signal),
});
```

### Calls handed back to the app

Some calls are answered from outside the exchange, later: an app's own tool that a router hands back to
the app as `finish_reason: "tool_calls"`, an approval a person gives tomorrow. Ending the exchange on
them loses it, so `handBack` leaves them unanswered and the exchange waits instead. `true` hands back
every call to one of `hostTools`; a predicate is asked of every call that would reach `dispatch`,
with the name and arguments it would be dispatched with.

```ts
const result = await runAgentLoop({ ...options, hostTools: appTools, handBack: true });
if (result.pending) {
  // [{ id, name, args, raw, repaired }], in the order the model asked.
  await store.wait(runId, {
    messages: result.messages,
    pending: result.pending,
    ledger: result.ledger,
    loaded: result.loaded,
  });
}
```

The turn's other calls still run first, and are answered as usual; the handed-back ones are not
dispatched, get no result and no `tool-result` event, are not counted in `used`, and the loop sends
nothing after the turn.
Each is told as a `tool-call` event and to `onToolCall`, then one `wait` event says the exchange is
waiting. `wait` is not `done`: the run goes on under the same id, and `watch` keeps following it.
The exchange's `exchange-end` follows the `wait`, with `outcome` `waiting` and the calls' ids in
`pending`. `metrics.outcome` is `waiting`, and `runMetrics` reads it so until the next exchange
begins. The
`afterExchange` hooks are not told, and under `reasoningReplay: "tool-loop"` the scratchpads stay,
since the tool loop is not over. A wait in the last turn `maxToolIterations` allows resolves like any other.

The transcript holds the turn's calls with the handed-back ones last, whatever order the model
asked in, so `messages` end in the results of the calls the loop ran and an app that appends one
tool message per pending call, in `pending` order, answers every call in its order. A template
that pairs calls with results by position (Qwen, GLM, DeepSeek V3.2) reads that right. Written one
call a message, the handed-back calls share one assistant message after the pairs, which
`oneCallPerMessage` splits once their answers follow it.

An app that finds the waiting exchange by the id an answer comes back with, across many runs, passes
`callIds: 'minted'` as well: a server that counts its ids from zero gives two waiting exchanges the same
`call_0`, and a minted id is unique wherever it is handed out.

- **`parallel`.** A handed-back call is never put to the predicate and is no barrier: it does not
  run. A call the model asked for after it runs before the app has answered it.
- **`dedupeToolCalls`.** Never asked of a handed-back call. Two identical ones are both pending,
  each under its own id: only the app knows whether asking twice means twice.
- **A call that ends the exchange.** The end wins. The calls that would have been handed back are
  answered `Not needed: the task finished first.`, nothing is pending, and the result has `ended`.
- **Arguments that do not parse.** Answered by the loop with the parse error, as always, so the
  model fixes them: a call is handed back only where it would have been dispatched.

To go on, call the loop again with the stored transcript and the answers appended. It is the same
run as far as the app is concerned; the loop sees a transcript that ends in tool messages, which
it has always taken.

```ts
const waiting = await store.waiting(runId);
const result = await runAgentLoop({
  ...options,
  messages: [
    ...waiting.messages,
    ...waiting.pending.map(({ id }) => ({ role: "tool", tool_call_id: id, content: answers.get(id) })),
  ],
  ledger: waiting.ledger,   // its indexes are all before the answers, so no rebase
  loaded: waiting.loaded,   // what was loaded on demand; proxied runs keep theirs in the history
  hostTools: appTools,
  handBack: true,
  session: runId,           // the same slot and cache affinity as before
});
```

What an app keeps for a resume is the result's `messages`, `pending`, `ledger` and `loaded`, and
whatever it built the first call from that the transcript does not hold: the system prompt, the
tools, and the config. A resume also needs:

- **No second preselection.** Pass no `preselect`, or `preselected: []`. A proxied shortlist would
  otherwise be written after the answers.
- **The hooks told once.** Fire only `afterExchange` and `beforeCompact` on a resume, with
  `question` the question as typed, and put the first call's `context` back with `withContext`, as for any
  later call (see `hooks`).
- **Its own budget.** `maxToolIterations` counts per call, and `usage` and `metrics` are per call
  too; `runMetrics` over every stretch's events sums the run.
- **An estimate on its first turn.** The ledger carries, but the loop's own `prune` and `compact`
  plan the first turn of any call from an estimate: a figure carried from an earlier call cannot
  be checked against a transcript the app may have compacted since. An app planning in `beforeTurn`
  can measure with `estimateFrom(window.ledger, messages)`.

### Input that arrives while it runs

A person who types while the exchange is working — "use the other file", "also check the tests" — is
steering it, and `takeInput` is how the loop hears them. The loop asks it at the top of every turn,
which is after the last turn's calls have all answered and before the next request, and once more
when the model answers without calls. A user message it hands back is appended, told to
`onMessage` and as an `input` event, and the exchange goes on with it: a call already running is never
cut short for it, and an answer the input arrived during is followed by another turn that answers
the input too.

```ts
const inbox: string[] = [];
const result = await runAgentLoop({
  config,
  messages: history,
  dispatch,
  // Several typed between two boundaries go as one message: some chat templates refuse two
  // user messages in a row.
  takeInput: () =>
    inbox.length ? { role: "user", content: inbox.splice(0).join("\n\n") } : undefined,
});
// Anything still in `inbox` came after the last boundary: the host's to send as the next turn.
```

Input that comes when no turn is left, after a call that ended the exchange, or with calls handed
back, stays where it is: the
loop returns without asking, and the app sends it as an exchange of its own. The question the hooks
were gathered onto is still the question after input lands behind it, rebuilt transcript or not.

### What the servers said on the way

A server can log while a call runs — a warning that the cache was stale, an error it recovered
from — and that is often why the call went the way it did. `dispatch` is handed a third argument,
`report`, and `report.log(entry)` tells watchers of one such message as a `server-log` event for
the call: `id` the call's, `name` the tool, `level` the server's, and `text` the message's `data`,
as it was where a string and as JSON otherwise, cut by `preview`. The entry is MCP's
`notifications/message` params, `{ level, logger?, data }`, declared structurally, so
agent-mcp-pool's `onLog` takes `report.log` as it stands:

```ts
dispatch: (call, signal, report) =>
  pool.call(call.name, call.args, { servers, signal, onLog: report.log }),
```

None of it reaches the transcript: it is for the person watching, not the model. A call the loop
answers itself never logs, a deduplicated repeat reports nothing of its own, and a message heard
after the call has answered is dropped rather than landing after the result it explains.
`runMetrics` counts `warning` as `serverWarnings` and `error` and above as `serverErrors`, so a
summary can say the server complained without the events. A dispatcher written for
`(call, signal)` needs no change. `report` is an object so that what a call can report — progress
is next — grows there without `dispatch` changing again.

### What the servers say about themselves

An MCP server may send `instructions` when it connects — "resolve the library id before querying
docs" — and agent-mcp-pool puts them on each `catalog()` entry. `serverInstructions: true` writes
them into the system prompt after `systemPrompt` and before the catalogue, as `serverInstructionsPrompt`
builds them: a heading, one sentence saying what the block is, and a section per server that said
anything, under its label, with the text inside an `untrusted` fence. The text is a third party's,
in the one place a model most takes literally, so it is named rather than folded into the
operator's prompt: the model can weigh one server's advice against what the user asked, and a
surprising turn can be traced back to where the instruction came from. A text over
`maxTokensPerServer` (`TOOL_DISCOVERY_DEFAULTS.serverInstructionTokens`, 1000, by default; zero keeps it whole) is cut,
and the cut is said after the fence.

```ts
await runAgentLoop({ ...options, catalog: pool.catalog(), serverInstructions: { maxTokensPerServer: 500 } });
```

It is off by default, so no app's prompt changes on upgrade, and it reads `catalog` in every mode,
eager included. The block comes from the catalogue rather than from what is loaded, so it is the same
text on every turn and the prompt cache holds, and it covers a server none of whose tools is loaded
yet, whose guidance is often about when to load them. A preselected first turn keeps it while
dropping the catalogue, so that turn's system prompt is the head of the next one's. Behind
mcp-router a router's members arrive as one entry, and their instructions as one section under the
router's name. An app that assembles its own prompt calls `serverInstructionsPrompt(catalog)`.

What is loaded there is what the history holds, so `loaded` comes back empty and the `loaded`
option is not read: there is nothing to carry, and a definition a compaction took away has to be
loadable again. For the same reason a `beforeTurn` that returns a different array makes the loop
forget what it loaded, which costs a definition sent twice at worst. `call_tool` is honoured in
`ondemand` mode as well — a session switched out of proxied mode still has it in its history, and
a model copies what it has seen work — unless the app has a tool of that name, which is then the
app's. Eager mode does not know it.

That preselection costs a round trip to a model, which on a local box is a few seconds before the
exchange has started, spent on a model doing term matching. `preselect(..., { keywords: true })` does
the matching directly and spends the model only on what the words cannot settle:

```ts
const preselected = await preselect(config, config.toolSelectModel, catalog, prompt, {
  keywords: true, // or { minScore, dropoff } to move the bar
  onNotice,
});
```

`preselectByKeywords` is the matcher on its own, ranking every tool against the request by BM25
over its name, its server's label and its one-line description. BM25 rather than counting shared
words, because a catalogue is full of words every tool uses — "list", "get", "file" — and an
overlap count hands the top of the ranking to whichever tool has the longest description. English
function words are dropped outright: the inverse document frequency is meant to handle them, and
over a real corpus it would, but twenty one-line descriptions are few enough that "for" lands in
one of them and scores as the most distinctive word in the request.

What a caller acts on is `confident`, which is deliberately hard to earn: something more
distinctive than a word the catalogue shares has to have matched, and the tools the cap left out
have to score well below the ones it kept — a hit just under the line scoring nearly as much as
one just over it means the ranking chose arbitrarily, which is the case a model is worth spending
on. Matching nothing is not confident either, since the words cannot tell a request that needs no
tools from one whose words are not in the catalogue. An empty model still means no preselection
at all, words included. `preselect` also takes a `temperature` and a
`reasoningEffort` and an `extraBody`, read as `ask` reads them, and `runAgentLoop({ preselect: true })` makes the call
itself — see "Its side tasks" below.

A reply with nothing to say is still written as a message the next request can carry: `content` is
`null` only beside `tool_calls`, and `""` without them, any scratchpad kept on it. A reply that
thought and stopped, or said nothing, is the answer, with the notice `the model ended its turn with
no answer`; `{ role: "assistant", content: null }` with no calls is what Ollama refuses as `invalid
message content type`, and an app's stored transcript would carry it into the next exchange. A reply the
provider's content filter withheld (`finish_reason: "content_filter"`) is said so as a notice, and a
exchange that ends on one has `metrics.outcome` `filtered`, not `answered`. A reply that finished for
`tool_calls` and sent none is not an answer: with nothing said either, the same request is sent once
more and nothing of the empty reply is written, while a turn is left to send it in; a second one, or
one that said something, is taken as the answer with a notice. Calls are run from their presence,
never from the finish reason.

A reply cut off at `maxTokens` is said so as a notice, and with `maxContinuations` above zero it is
continued first. `continueTurn` is the same thing for a caller with its own loop:

```ts
let turn = await runTurn(client, supports, build, options);
turn = await continueTurn(client, supports, build, turn, { ...options, maxContinuations: 2 });
```

It sends the transcript again with the answer so far as a trailing assistant message, its
scratchpad on it under the field it arrived in (`replayReasoning: false` leaves it off), which
llama.cpp renders as a prefill: the model carries on from the last token, and the cache holds all
of the prompt and most of the reply. vLLM only does so given `continue_final_message: true` and
`add_generation_prompt: false`, so the continuation sends both; llama.cpp reads the same two, and a
lenient server such as Ollama ignores them. A model whose model server refuses either by name — hosted
OpenAI's `Unrecognized request argument` — stops being sent both, latched in its `refusedFields`,
and the continuation is sent again without them before the prefill is judged. The pieces come
back as one reply — content and scratchpad joined, token counts summed, `continuations` counting the
extra requests, timings summed or weighted, a field only one piece reported dropped. Only an answer
begun and cut off is continued. A reply cut off in its scratchpad is left alone, since llama.cpp
refuses a prefill outright on a template with thinking on, and so is one ending in a tool call,
whose truncated arguments `parseToolArguments` already reports.

Whether it works is latched per model as `assistantPrefill`. A 400 or 422 for the request latches it
off, and so does a continuation that starts the answer over word for word — how hosted OpenAI, which
takes a trailing assistant message and ignores it, shows itself. Either way, and on any other
failure short of a stop, the cut-off answer is kept with a notice. The cap is one continuation for
`continueTurn` and none for the loop, since it spends a request, and on a server that does not
continue, one to find out.

Every turn ends in a `usage` event, whether or not the model server reported tokens. Its totals are the
exchange's so far — `promptTokens`, `completionTokens`, `totalTokens`, `cachedTokens` and
`cacheReported`, the `UsageTotals` spelling that `result.usage` and a failed exchange's `usage` share. A
`cachedTokens` of zero is a miss only where `cacheReported` is true; false is a model server that never
said; `reportsCache` asks the same of one turn's `TurnUsage`. Its `turn` is that turn's own `TurnUsage` and `finishReason`, with the `contextLength` the loop
was told. The loop adds what only
it can know: `toolsDeclared` and `toolSchemaTokens` for the tool block it sent, and, from the second
request on, `cacheExpected` (the previous prompt plus its reply) and — where a cache count was
reported — `cacheBroken`, a hit short of 90% of the previous prompt. A broken cache is given a
`cacheBreakReason` read off the request against the one before: `tools-changed`, `system-changed`,
`history-rewritten` (a compaction or a prune in `beforeTurn`), or `none-known` where the new request
only appended, which points at the server — a slot evicted, a template that re-renders the tail.

The same `turn` carries `context`, the request cut by `contextTokens` into `system`, `tools`,
`history` and `toolResults`: shares of the prompt the model server reported for it, adding up to it, or
an estimate where it reported none. An app that wants a different cut — the catalogue apart from the
prompt it rides on, this turn's messages apart from the ones before — takes the request from
`onRequest` and measures it itself:

```ts
await runAgentLoop({
  ...options,
  onRequest: ({ messages, tools, turn }) => measure(turn, messages, tools),
});
```

It is called once a turn, before the request goes out, with the messages and tools as the client
is about to be sent them. It is for reading: `beforeTurn` is where the transcript is changed. What
it reports is the request as first built. A retry sends that again, but a refusal is answered with
a lesser body and a continuation with the reply so far on the end, and neither is reported — and
`context` is measured on the same first request, against the first prompt reported for the turn.

`runMetrics(events)` adds a run up from those events — tokens, cache hit ratio and breaks by
reason, prefill, decode and tool time, the slowest turn, mean time to first token, draft
acceptance, the largest prompt against its context window, turns cut off, tool errors by name, what
`load_tools` resolved to (`toolsLoaded`, `redundantLoads`, `unknownToolNames`, off each load's
result as `loads`), and an `outcome`, an `ExchangeOutcome`: `answered`, `truncated`, `filtered`,
`ended`, `waiting`, `failed` or `stopped`. The loop returns it as `metrics`, where `outcome` is
always set and is the exchange's own. Every turn carries its own context
window and every load its own counts, so an app that runs one loop per stage gets the whole run from
`runMetrics` over all the loops' events, with no per-loop result to merge. It is a sibling of `fold`
rather than part of it, since `fold`'s blocks are for display and a summary is not one:

```ts
const metrics = runMetrics(history(runId), { contextLength: config.contextLength });
```

Counts are always present; every other field is absent where no turn reported what it is made of.
`exchanges` counts the `exchange` events, one for each loop and any the app sends of its own, and
`outcome` is the run's: its last `exchange-end`'s, or `failed` where the app's `done` was not ok
and that exchange had not already failed or stopped. It is absent while an exchange is going. What
it cannot say: whether the app compacted, which is not in the events.

`beforeTurn` is handed the transcript before each request and may return a replacement, which is
where compaction goes (below). Its third argument is `{ used, limit, ledger }` — the prompt the
exchange's last request reported, the context window, and the token ledger so far — so an app can compact
mid-exchange without tracking usage itself; `used` is absent before the first turn and where the
model server reported nothing. Hooks are gathered once, onto the question, and never written into
the transcript that comes back; `afterExchange` is told the reply without the exchange waiting on
it.

That leaves an earlier question's context to the app, because the loop only ever touches the
current one. A question sent with `<context>` blocks in one exchange and bare in the next is a different
prompt from that message on, and the server's prefix cache is lost behind it — on every exchange. So
the result hands back what it said, `context` and the `preface` above it, for the app to keep
beside the question and put back with `withContext` on every later call:

```ts
import { runAgentLoop, withContext } from "@cubicecho/agent-core";

// Stored: what the user typed, and what the hooks added to it the turn it was asked.
const history = session.messages.reduce(
  (sent, message, at) => withContext(sent, at, message.hookContext ?? "", message.hookPreface),
  session.messages.map(({ hookContext, hookPreface, ...message }) => message),
);
const result = await runAgentLoop({
  config,
  messages: [...history, { role: "user", content: prompt }],
  dispatch,
  hooks: { run, context: { session: { id }, prompt } },
});
session.messages.push(
  { role: "user", content: prompt, hookContext: result.context, hookPreface: result.preface },
  ...result.messages.slice(history.length + 1),
);
await result.afterExchange; // only if its notes are wanted, or the process is about to exit
```

`withContext` with those two arguments builds the question exactly as the loop sent it, whatever
`configureHooks` has since been told, so the next request is the last one with its tail added.
`result.messages` is the transcript the loop was given plus what the exchange added — earlier questions
as the app passed them, this one as typed — which is why the snippet stores only the new tail.

`afterExchange` on the result is the `afterExchange` hooks' notes as a promise. The loop still returns
without waiting; an app that stores those notes with the exchange, or would otherwise exit before the
exchange is remembered, awaits it once the answer is out.

The loop gathers before its first request, beside its own preselection when `preselect` asked for
one, and nothing else of the app's can run beside those. An app with work before the exchange to overlap with
the hooks — a compaction — calls `gather` itself and applies `withContext` to the current question
as well (see [Hooks](#hooks)). Such an app passes the question as it was typed as `preselectQuery`
too, or the preselector is shown the context in front of it and picks tools for what was recalled
rather than what was asked.

It can still leave `afterExchange` to the loop, with three things the transcript it handed over
cannot say. `hooks.question` is the question as typed, which the hooks are told in place of the one with
the recall on it — at the same position, so its uuid is the stored question's — and as `prompt`
where the context has none. `hooks.turnBase` is the user messages of the app's transcript that the
loop's does not hold, added to `turn.index`: what a compaction took and did not send again, or the exchanges
before one that starts from a transcript of its own. `hooks.offset` numbers the messages, as it
does for `beforeCompact`. The question is found by reference, and by role — the last user message
that is not a summary — where `beforeTurn` rebuilt the transcript from a store and the object went
with it.

```ts
await runAgentLoop({
  ...options,
  messages: request, // from the store, the recall already on the question
  beforeTurn: () => rebuild(),
  hooks: {
    run,
    context,
    fire: [HookEvent.BeforeCompact, HookEvent.AfterExchange], // beforeExchange is the host's
    question: prompt,
    turnBase: foldedQuestions, // stored user messages the fold took and did not send again
    offset: turnStart - requestIndex(turnStart, fold), // the request's numbering onto the store's
  },
});
```

`hooks.fire` says which events the loop fires itself, and it fires no others: `sessionStart` and
`beforeExchange` gathered before the first request, `beforeCompact` ahead of each compaction
`compact` makes, `afterExchange` once answered. Left out, it is `beforeExchange`, `beforeCompact`
and `afterExchange`: every event the loop has a point for but `sessionStart`. An app that fires the
exchange's events around a stage of its own still hands the loop its hooks for compaction:

```ts
await runAgentLoop({
  ...options,
  compact: true,
  // beforeExchange and afterExchange are the host's.
  hooks: { run, context, fire: [HookEvent.BeforeCompact] },
});
```

An event left out of `fire` is one the result has nothing for: the result's `afterExchange` is resolved
and empty without `afterExchange`, and `notes` and `context` are empty without an injecting event,
since the app's own `gather` and `notify` hold those. `sessionEnd` and `sessionDelete` have no point in a
loop and are ignored there.

An app that stores its transcript — a row per message, so a crash or a stop mid-exchange still leaves
readable history — gets each message as the loop appends it, and the exchange as it stood when the loop
throws:

```ts
try {
  await runAgentLoop({
    ...options,
    // Awaited: the row is written before the tools run, and before the next request is sent.
    onMessage: (message) => store.add(sessionId, message),
  });
} catch (error) {
  const run = failedRun(error); // messages, partial, usage, toolCalls, loaded, used, preselected, ledger — or undefined
  if (run) await store.keep(sessionId, { usage: run.usage, loaded: run.loaded, ledger: run.ledger });
  if (signal.aborted) return; // a stop, told by the signal as it always was
  if (error instanceof ContextOverflow) return compactAndRetry(run?.messages);
  if (error instanceof ToolIterationLimit) return outOfTurns();
  throw error; // an AgentLoopError: the message is the cause's, and the cause is on `cause`
}
```

`onMessage` hears the assistant message as it will be replayed — recovered calls folded in, and
arguments repaired, which the reply `onTurn` is handed does not show — together with that `Turn`,
and then each tool result, in transcript order. Beside an assistant message the model wrote comes a
fourth argument, `{ raw }`: the same message as the model produced it, its text whole with any call
written into it left there, and its calls' arguments exactly as streamed, under the same ids. Store
or show `raw` to keep what the model said; replay `message` to keep what a model server will take back.
The loop's own messages — a proxied exchange's preselected load — come without it. `onTurn` is not awaited and never sees a tool
result; this is the one to store from. What it returns is ignored, since `beforeTurn` is the one way to rewrite
the transcript, and what it throws ends the exchange.

Everything the loop throws carries the exchange. A spent `maxToolIterations` is a `ToolIterationLimit`,
with the message it always had. A request too big for the context window is an `AgentLoopOverflow`, which
is a `ContextOverflow`, so a `catch` written for one still catches it. Anything else — a stop, a
refused request, a dropped stream — is an `AgentLoopError` whose `cause` is what was caught and
whose message is the cause's own. It is a wrapper and not fields on the error that was caught
because a stop throws the signal's reason, one object for every exchange under that signal. A stop is
still recognised by the signal the app aborted.

A failure while a turn's tools are running leaves a transcript that can be sent again. The results
that came back are kept, a call the exchange was stopped during is answered `Stopped before this call
finished.`, and one the loop never reached `Not run: stopped before this call started.` — a call with no
result is a transcript a model server refuses. Those are announced through `onMessage` like any other
result. The reply of a request that was in flight when the exchange stopped or failed — a stop, the
model server going silent, a stream that broke after its first token — is not in `messages`, because it
is not a reply a model server will take back. It is on the failure as `partial`: its `content`, its
`reasoning` and the `toolCalls` it had begun, assembled as far as they had arrived, with a
continuation's piece joined onto the answer it was continuing and, after a retry, only the attempt
that was in flight. A request that had said nothing leaves no `partial`, and neither does a
failure while the tools run, since that turn's reply is already in `messages`. Whether half an
answer belongs in the history is the app's call.

`resolveApiKey` is exported and not applied, because which key a model server gets is a rule a
consumer states and a library guessing it could send one where it was not meant to go. The rule
it encodes is the conservative one: a model server's own key wins; one that names a base URL of its
own, different from the settings it inherits from, gets `NO_KEY` rather than the operator's key or
`$OPENAI_API_KEY`; anything else inherits.

"Different" is decided by `normalizeBaseUrl`, the same rule `endpointKey` and every cache here
compares by: http or https, no credentials, query or fragment, scheme and host in lower case, no
default port and no trailing slash. An app storing a base URL should store what it returns, and
refuse a URL it answers `null` for. A URL it refuses still equals itself, trimmed of whitespace
and trailing slashes, so a row saved before the rule still finds its own key.

## Running against a remote agent

A remote agent is a model that runs a whole agent loop of its own behind the chat completions API —
ai-router serves one per agent name — and hands the app's own tools back with
`finish_reason: "tool_calls"`. `runAgentLoop` runs against one as a plain tool loop, with the app's
`tools`, `hostTools`, `dispatch` and `onEvent` as they are, once the config says so:

```ts
// `isAgent` from the model entry: ai-router marks its agents `"ai_router": { "kind": "agent" }`.
const result = await runAgentLoop({
  config: {
    baseUrl, apiKey, model: "helper", maxToolIterations: 20,
    remoteAgent: true,
    ...(chosen.temperature === undefined ? {} : { temperature: chosen.temperature }),
  },
  messages,
  hostTools: [askUser],
  dispatch,
  onEvent: (event) => emit(runId, event),
});
result.remoteRunId; // the server's run, for its `GET /runs/<id>`
```

`remoteAgent: true` (`RemoteAgentParams`) changes this much:

- **Sampling is the agent's own.** `temperature` and `maxTokens` are optional, and absent sends
  none, so an agent tuned with its own is not overridden by an app's default; `extraBody` is sent as
  given. An app that fills these from its settings sends only what was chosen for this call.
- **The server's work stays on the server.** Compaction, pruning, preselection, on-demand loading
  (tools go out eagerly, so `load_tools` never hides the app's), continuations, recovering calls
  from the answer's text, minted call ids and the context-window guard are all set aside, with one
  notice (`REMOTE_AGENT_NOTICE`) naming those the app had asked for. They are ignored rather than refused:
  the flag comes from the model entry and the options from the app's code, so a refusal would have
  every app branch on it. A session still sends its header, but no llama.cpp slot is probed or
  pinned.
- **Progress is asked for**, as `ai_router: { progress: true }` laid under the app's own
  `extraBody.ai_router` (its `task`, `servers`), and an app's `progress: false` turns it off.
  `ai_router` is `PROGRESS_FIELD`, the default; a server that reads another names it as
  `progressField`, and the loop asks and reads under that instead.
- **The server says its own turns.** Each progress chunk's event goes to `onEvent` whole, under the
  server's `runId` and `seq` (`'seq' in event` tells one from the loop's), and the loop then says no
  `turn`, `thinking`, `output`, `tool-call`, `tool-result` or `usage` of its own: the server already
  tells a handed-back call's `tool-call`, and its `tool-result` when the answer resumes the run, so
  neither is shown twice. The loop's own notices, `input`, and the `artifact` and `server-log` of the
  app's own dispatches are still said. The server's `exchange`, `exchange-end` and `done` are not
  forwarded: the loop's own start and end say the app's exchange, and the run's end is the app's to
  say. A forwarded event that names no exchange gets the loop's `exchange`. `emit` files a forwarded event under the app's
  run and numbering and keeps its `at`; with progress off, the loop says everything itself.
- **Call ids are kept as the server sent them**, never renamed by `distinctCallIds`, because the
  next request resumes the server's run by them.
- **Each turn carries an `Idempotency-Key`** (`IDEMPOTENCY_HEADER`), the same on every retry of a
  request lost before its first chunk and a new one on the next turn, so a resend is answered with
  the run the first attempt started. A progress chunk does not count as the model answering, so it
  costs the turn no retry.
- **The run id** is the result's `remoteRunId`, and a failure's, read off the events. Without
  progress there are none; an app that wants `X-Run-Id` reads it in its endpoint's `fetch`.

The wire shape is one codec, here, so a server and the loop cannot drift: `progressChunk(event,
head)` writes an event as a chunk with empty `choices` and `ai_router: { event }`, which a standard
client skips as it skips a usage chunk; `withProgress(completion, runId, events)` puts
`ai_router: { runId, events }` beside the `choices` of an answer that is not streamed; and
`progressEvent` and `progressEvents` read them back, dropping an event that is malformed or of a
kind this version does not know. Each takes the field as its last argument, `PROGRESS_FIELD` where
it is left out. A server numbering its own events makes each with `stamp`.

## Fields this interface cannot spell

`ModelParams` has `temperature`, `maxTokens`, `reasoningEffort`, `reasoningReplay` and `singleCallMessages`. Everything else a model card or
a server asks for — `top_k`, `min_p`, `repeat_penalty`, llama.cpp's `id_slot`, `cache_prompt` and
`reasoning_budget` — goes in `extraBody`, which `buildBody` merges in last. It can override
`temperature` but not `model`, `messages`, `stream` or `tools`, which are the loop's. An agent
document's `extraBody` can do neither: `parseSpec` drops `temperature`, `max_tokens`,
`max_completion_tokens` and `reasoning_effort` from it, with a warning naming the field that sets
each, so the value a document states is the one sent.

A local server ignores a field it does not know. OpenAI refuses it — `Unrecognized request
argument supplied: min_p` — and so do some proxies, as `Unknown parameter: 'min_p'`. Given the
names it may drop as `droppable` (`runTurn` takes the same option, and `runAgentLoop` passes the
`extraBody` keys),
`negotiate` reads either wording, latches the name off for that model on that model server, and sends
again without it, with a notice naming it. A nested name is dropped at its top-level field. A
refused field nobody said was droppable is passed on, since dropping it would change the request
behind the caller's back.

On a llama.cpp server started with `--parallel`, give `runAgentLoop` a `session` — a run id, a
conversation id — and the exchange is pinned to a slot of its own. `servedSlots` reads `total_slots` off
`/props` (the request `servedWindow` already makes), `slotAllocator` hands each session a free
slot, the one it last held where that is still free, and every request of the exchange carries
`id_slot` and `cache_prompt: true` until the loop returns or throws. The slot keeps that session's
KV cache warm against every other session on the server, which is the difference between a cached
prefill on every turn and a full one — but only while the prefix stays the same from turn to turn;
see #63, and the caution on compaction below.

More sessions than slots run unpinned rather than wait, and so does a second loop under a key
that holds a slot already. A notice says `pinned to slot 0 of 4`, or that no slot was free, and each
turn of an exchange with a session, on a server with slots, reports `pinned`, which `runMetrics`
counts as `unpinnedTurns` beside `cacheHitRatio`. A server that refuses `id_slot` is latched off it
like any other `extraBody` field, and an `extraBody` that names `id_slot` itself is the app pinning
by hand and is left alone. On a server without `total_slots` none of this happens. Whatever the
server, the session also goes out as an `X-Session-Id` header (`SESSION_HEADER`), which llm-router's
sticky affinity reads first, so a session behind a router keeps both its provider and its slot.

Ollama's `options` object is not read on its OpenAI-compatible `/v1` route, so sampling set there
does nothing; send the fields at the top level.

## Keeping a long exchange inside its context window

Two ways to make a transcript smaller, cheap first.

`pruneToolResults(messages, { keepLast: 5, maxChars: 256 })` replaces every tool result but the
latest five with a stub — `[result cleared, 10,412 chars]`. A 40k-character `read_file` is 10k
tokens on every turn after it, and by then the model has usually taken what it wanted; the stub
keeps the call answered and says how much was there. A proxied `load_tools` result that carries
definitions is never cleared, however old: it is the only copy of the schema the model has, and
`holdsDefinitions` is the test for an app with a prune of its own.

`planCompaction(messages, { limit, used })` says where to replace the oldest stretch with a summary,
once `used` (the last turn's prompt tokens, or the estimate) is past three quarters of the context
window. The kept tail fills at most 35% of it and starts on a user message, since a transcript
resuming mid-loop is one servers refuse; leading system prompts are never compacted, and an earlier
summary is continued rather than summarised. `compactTranscript` writes the summary and tells
`beforeCompact` hooks what is going while it does.

The summary is written as conversation, not as a second system prompt: a `user` message opening
with `SUMMARY_LEAD`, then an `assistant` reply, `SUMMARY_ACK`, ahead of the kept tail. The Qwen3.5
and later templates, and Devstral's, raise "System message must be at the beginning." on any
`system` message after the first, and a request is a system prompt put ahead of whatever compaction
returned. As conversation, the system prompt stays the same text across a compaction, so a server's
cached prefix for it and its tool block still matches; the reply is there because Mistral's v0.3
template refuses two user messages in a row. A summary stored as a `system` message by an earlier
version is still read back and continued. `runAgentLoop` also sends an app's leading `system`
messages as one with its own `system` prompt, a blank line apart. A `system` message further down
an app's transcript is sent where the app put it, and is the app's to move.

An exchange that is one question and a long tool loop has no user message to cut at, so there the plan
cuts inside the loop instead: the question is kept whole (the plan's `question`), the calls and
results after it are compacted up to an assistant message, and the request becomes the summary, the
question, then the rest of the loop — every tool result still after its call. A transcript with a
user message to cut at is planned as before. `runAgentLoop({ compact: true })` compacts such an exchange on
its own; an app that numbers messages across exchanges passes `hooks.offset`, the stored index of the
exchange's first message, so the ids `beforeCompact` is told match its own.

```ts
beforeTurn: async (messages, turn) => {
  const plan = planCompaction(messages, { limit: config.contextLength ?? 0, used: lastPromptTokens });
  if (!plan) return;
  return compactTranscript(
    pruneToolResults(messages),
    plan,
    summariser(config, config.model, { signal }),
    { hooks: { run, context } },
  );
},
```

A hook can ask for a compaction not to happen — its runner sets `veto` on the outcome — and by default
nobody listens: the hooks run beside the summary, so a slow one costs the exchange nothing. Pass
`honourVeto: true` with the hooks and they run first — the summary waits on them — and a veto from
any hook that ran leaves the transcript as it was, with a note naming the hook. One that failed
vetoes nothing. A compaction passed `forced: true`, because a request was already refused as too
big, goes ahead regardless: a veto there only trades the summary for a `ContextOverflow`.
`consult` is the same wait for an app that compacts its own way.

`runAgentLoop({ compact: true })` honours a veto by default: its hooks run ahead of the summary, and
a veto leaves the exchange uncompacted, with a notice naming the hooks that made it. Pass
`hooks.honourVeto: false` to run them beside the summary instead and read no veto.

```ts
const compacted = await compactTranscript(messages, plan, summarise, {
  hooks: { run, context, onNote, honourVeto: true },
  forced: retryingAfterOverflow, // the last request came back as a ContextOverflow
});
```

**Both rewrite the prefix.** A prompt cache matches from the first token, so a transcript whose
early messages change is re-processed whole — on a local server that is the entire prefill, every
time. Run them rarely and together, at the point `planCompaction` says the context window is filling, so
the cache is lost once rather than a little on every turn. Pruning on every turn is the expensive
way to save tokens.

`pruneToolResults` keeps the transcript's indexes, so a plan made before pruning still applies to
what it returns, as above.

### A prune boundary that keeps the cache

`pruneToolResults` keeps a sliding window: applied on every turn, each new result pushes an older
one out and rewrites a message in the middle of the history, so the cache misses from there once
per tool call. `planPrune` plans a boundary instead. The app stores its `through`, sends
`pruneThrough(messages, through)` on every request, and between moves each request is the one
before it with only its tail added.

```ts
const plan = planPrune(messages, config.contextLength ?? 0, { through: stored, used: lastPromptTokens });
if (plan) {
  stored = plan.through;
  notice(pruneNotice(plan)); // cleared 4 old tool results (~9,120 tokens) as the context window filled
}
const sent = pruneThrough(messages, stored);
```

A plan never moves the boundary backwards and never moves it for nothing. It moves to the earliest
of the latest `keepLast` (`PRUNE_DEFAULTS.keepLastResults`, 5) results once the context window is past
`at` (`COMPACTION_DEFAULTS.compactAtShare`, compaction's own line) — by the larger of `used` and the estimate, since a report does not count the
results that came after it — and only when what it clears is at least `minShare`
(`PRUNE_DEFAULTS.minShare`, a tenth) of the context window. `compacted: true`, beside a compaction that has rewritten the head
anyway, skips both gates: the cache is already lost, so the move is free. `from` leaves out results
a compaction has already taken out of the request. `at: 0` with a larger `minShare` is a pure
hysteresis on what is won back.

`runAgentLoop({ prune: true })` does this itself: after `beforeTurn`, ahead of `compact`, which
then plans from what is left — so a prune that brings the request back under the line spares it the
summary — and again with `compacted` after a compaction. Each move is a `notice` with the counts. Its
stubs stay in the loop's transcript and in the result's `messages`, as a compaction's summary does; an
app that keeps the transcript whole calls `planPrune` in its own `beforeTurn` and stores the
boundary. An object moves `at`, `minShare`, `keepLast` and `maxChars`.

### What the messages cost, measured

`planCompaction` decides where to cut by estimating each message, and a calibrated divisor fixes
only the average: a transcript is tool results, JSON arguments, code and prose, each at its own
ratio, plus whatever the chat template adds per message. The server has already said what they
cost. A request that only appended to the one before it differs from it by exactly the cost of what
was appended, so two reported prompts and a subtraction give a number with no tokenizer in it — the
template's tokens and a tool result's real density included, and the scratchpad counted only where it
is replayed.

`runAgentLoop` keeps that as a ledger — one `{ through, prompt, epoch }` per request: the index of
the request's last message, the prompt it reported, and an epoch that changes whenever the prefix
did. It comes back as `result.ledger`, rides on every `usage` event, and is handed to `beforeTurn`;
pass it back as `ledger` on the next exchange and it is continued. It is a plain array of three numbers
an entry, so it stores as two columns on the message row `through` names or as JSON beside the
session.

```ts
const result = await runAgentLoop({
  ...options,
  ledger: session.ledger,
  beforeTurn: async (messages, turn, { used, limit, ledger }) => {
    const plan = planCompaction(messages, {
      limit,
      used,
      target: 0.5,
      estimate: estimateFrom(ledger, messages, { charsPerToken }),
    });
    if (!plan) return;
    return compactTranscript(messages, plan, summarise);
  },
});
session.ledger = result.ledger;
```

`tokensBetween(ledger, from, to, messages)` is the cost of `messages.slice(from, to)`. Between two
boundaries recorded in one epoch it is the subtraction, and exact. A boundary falls after a question
and after each turn's tool results, never after an assistant message, so a stretch that starts or
ends inside a group gets that group's total by character share, the way `contextTokens` divides a
reported prompt. Whatever no pair of entries covers is the calibrated estimate: the messages before
the first entry, the group either side of an epoch's end, and what has not been sent yet.
`estimateFrom(ledger, messages)` is the same thing one message at a time, which is the function
`planCompaction` already takes as `estimate`.

`target` is the share of the context window the whole request should come down to. `keepRatio` bounds the
kept tail alone, with the system prompt, the tool schemas and the summary sitting on top of it
uncounted; given a `target`, the cut is the first user message at which `used`, less what is
compacted, plus the summary's ceiling (`summaryTokens`, 1024 unless given) is at or under it, and the
plan's `after` says what that leaves. Where no cut reaches it the plan compacts as far as the last
user message and `after` says how far short it fell. An earlier summary the new one replaces is not
credited, so `after` errs high by at most that much. Without `target` nothing changes.

A new epoch starts whenever a request did more than append: a compaction or a prune in `beforeTurn`, a
system prompt that moved, and a tool array that grew — a `load_tools` in on-demand mode adds a
schema to the head, so the group beside it is left unmeasured rather than charged for it. When
`beforeTurn` returns a different transcript the loop moves the entries that still stand to their new
indexes with `rebaseLedger(ledger, before, after)`, which an app that compacts between exchanges calls
itself. Differences inside an old epoch stay good, since the prefix they shared cancels.

What is not measured: the first request of every exchange starts an epoch, because the loop cannot see
whether the exchange before it had the same system prompt and tools, so an exchange's question and the answer
before it are estimated; a turn whose prompt was not reported has no entry, and the next one that
does is measured across it; and the prompt recorded is the first request's, before any continuation.
A difference of zero or less is not trusted, and neither is a prompt reported smaller than its own
cache count — both are how a server reporting `prompt_tokens` net of its cache would show up.
Whether any model server does that has not been checked, and one whose net counts kept rising would not
be caught. An app with its own loop keeps a ledger with `recordRequest(ledger, previous, next)`.

### A compaction you store, instead of a transcript you rewrite

`compactTranscript` hands back a new array, which is the whole answer for an app whose transcript
*is* that array. An app that keeps its messages append-only — rows in a database, every one still
shown in the chat — wants the other half: what the compaction was, as something to store on the session.
`runCompaction` is `compactTranscript` without the rewrite. It returns `{ summary, through, at }`,
or `undefined` when a hook vetoed or the summary came back empty, and `compactTranscript` is built
out of it, so there is one summariser and one cut rather than two that drift.

```ts
const from = session.fold?.through ?? 0;
const plan = planCompaction(session.messages, {
  limit,
  used,
  from, // where the last fold ended, rather than scanning for it
  previous: session.fold?.summary,
});
if (!plan) return;
const fold = await runCompaction(session.messages, plan, summarise, { hooks: { run, context } });
if (fold) await save(session.id, fold); // the messages themselves are never touched
```

`planCompaction` takes `from` and `previous` because its defaults are a *recovery*: it skips the
leading `system` messages, and reads an earlier summary back out of a `SUMMARY_LEAD` message among
them. An app whose system prompt is a separate argument and whose summary is a column has neither
in the array, and knows both exactly. Given them, nothing is scanned.

`applyCompaction(messages, fold)` is the way back — the summary and its reply, then the
compaction's `question` if it was made inside one, then everything from `through` — and it writes the same `SUMMARY_LEAD` `planCompaction` looks for, so
the next compaction continues those notes rather than summarising them a second time. No compaction yet hands
back the messages themselves.

```ts
const request = [systemMessage, ...applyCompaction(session.messages, session.fold)];
```

**Two numberings.** A stored transcript keeps its indexes and a compacted request does not, so
anything naming a position has to say which one it means. `requestIndex(index, fold)` maps the
stored index onto the request — for `withContext`'s index, or a range being shown to a hook.
The summary takes two places in the request, so with nothing kept ahead of it the first message
kept whole is at index 2.
`turnMessages` takes an `offset`, the stored index of the array's first message, so a message keeps
the uuid it had before the compaction and a memory server deduping on it files that exchange once rather than
twice; `turnIndex` takes one too, for the exchanges a compaction took out of the array it is counting.
Planning over the stored transcript, as above, sidesteps both: the plan's indexes are the app's
already, and so are the ones `runCompaction` hands the `beforeCompact` hooks.

## Watching a run

`watch` replays what the run has already emitted, then yields what happens next until `done`.
A `wait` is not an end: a run that hands calls back goes on under the same id once they are
answered, so its watcher stays.
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

An app that numbers and stores a run's events itself — a run that waits on an answer can outlive this
bus, and the process too, and its `seq` must never start again — makes each event with `stamp`,
which is what `emit` does too. The empty defaults (`text`, `name` and `exchange` `""`, `ok` and
`usage` `null`) go under what the input says, and the run id and sequence over it, so the stored events
keep `RunEvent`'s shape as it grows:

```ts
import { stamp } from "@cubicecho/agent-core";

const event = stamp(input, runId, ++lastSeq, Date.now()); // an `at` on the input wins
```

Each exchange says where it starts and ends. `runAgentLoop` sends an `exchange` event first and an
`exchange-end` last, on every way out: with `outcome` and, where a call ended it, that call, or the
handed-back calls' ids in `pending`; and just before it throws, with `outcome` `failed`, or
`stopped` where the app's signal aborted, and the error's message as `text`. Given an `exchange`
name — a task's stage — it names the start with it and puts it on every event of the exchange that
names none, so a watcher can group a run of several exchanges the way the work is written and
`fold` never joins text across two of them. `runMetrics` counts the starts as `exchanges` and reads
the outcome off the ends. A `wait` stays what keeps a run that handed calls back on the waiting
clock; its exchange's end follows it.

```ts
await runAgentLoop({ ...options, exchange: "triage", onEvent: (event) => emit(runId, event) });
```

Before 5.0.0 these were the `step` kind and the
`step` field, and since 6.0.0 nothing reads events stored or relayed that way: an app that keeps
them renames them when it reads them back.

The five numbers behind that — the backlog cap, the slack it is trimmed in batches of, and the
three deadlines the sweep reaps on (a finished run, an unended one, and one waiting on calls it
handed back) — are defaults rather than decisions. `configureEvents` moves them,
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
the same way — as a last argument, which is 12 tools a load and 16 carried unless given. A resolution
carries the cap it was held to, so `loadResult` tells the model the number it was actually
measured against rather than the module's own.

## Hooks

A hook is something an app runs at a point in a session — `sessionStart` and `beforeExchange`, whose
output can reach the request, then `afterExchange`, `beforeCompact`, `sessionEnd` and `sessionDelete`,
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
  messages.length === 0 ? ["sessionStart", "beforeExchange"] : ["beforeExchange"],
  context,
  { signal, onNote: (note) => emit(runId, { kind: "notice", name: note.hookId, text: note.error ?? note.text }) },
);
messages.push({ role: "user", content: prompt });
const request = withContext(messages, messages.length - 1, gathered.context);
// ... the turn ...
void notify(run, "afterExchange", { ...context, reply, turn: { ...context.turn, messages: turnMessages(id, messages, turnStart) } });
```

The context goes on this exchange's question and never into the system prompt — a prompt that changed
every exchange would miss the prompt cache every exchange — and `withContext` returns a new array, so a
app that stores what the user typed never stores the context as something they said. It is stored
beside the question instead, and put back on every later request: a question that loses its blocks
on the next exchange rewrites the prompt from there on, and the server's prefix cache with it.
`runAgentLoop` hands back `context` and `preface` for the same purpose. Every
injecting hook shares `HOOK_DEFAULTS.contextTokens` (2000) by default, each held to its own `maxTokens`
inside that, so a generous hook cannot crowd out the conversation it was meant to inform.

The budget is the caller's to move, at either level. `configureHooks` sets it for the process, and
`maxTokens` on `gather` (or the second argument to `assembleContext`) sets it for one request and
wins over it — the one to reach for when the budget follows the model, since a 128k context window can
afford more recall than an 8k one:

```ts
import { configureHooks, gather } from "@cubicecho/agent-core";

configureHooks({ contextTokens: 4000 });
const gathered = await gather(run, ["beforeExchange"], context, { maxTokens: contextLimit / 20 });
```

Either one given something that is not a number above zero keeps what was there, as
`configureEvents` does, so a `0` threaded through for "no opinion" does not switch recall off.
`resetHooks` (and `resetAll`) puts the default back.

The preface said above the blocks moves the same way. `HOOK_DEFAULTS.preface` names no app, so an app that
wants its own name says so once with `configureHooks({ preface })`, and a `preface` passed to
`withContext` (or on `runAgentLoop`'s `hooks`) wins over it for one request. An empty string is a
preface of nothing — the blocks lead the question on their own, with no blank line above them —
and anything that is not a string keeps what was there:

```ts
configureHooks({ preface: "Added by my-host's hooks — background, not the user's words:" });
const request = withContext(messages, messages.length - 1, gathered.context); // says it
withContext(messages, messages.length - 1, gathered.context, ""); // says nothing
```

Neither function rejects. A hook failing is an outcome, and a runner that throws outright is
noted once for its event and costs only that event's context. `notify` takes no signal: a reader
who leaves once the exchange is answered has not asked for it not to be remembered.

### Untrusted text

Hook context is not the only text in a prompt that nobody vouched for. A fetched page, an email, a
submitted card and a tool result all reach the model in the same words as the operator's own, and
`untrusted` gives the model a fence it can see around them. Put `UNTRUSTED_PREFACE` in the system
prompt once, where it costs the prompt cache nothing, and wrap each piece where it is pasted in:

```ts
import { UNTRUSTED_PREFACE, untrusted } from "@cubicecho/agent-core";

const system = `${instructions}\n\n${UNTRUSTED_PREFACE}`;
const content = `Summarise this page.\n\n${untrusted(page, { source: url })}`;
```

Any `untrusted` tag inside the text, opening or closing and in any case, has its `<` escaped, so a
page that writes `</untrusted>` followed by an instruction leaves that instruction inside the
block. This is one layer and not a defence on its own. A model can still be talked out of a fence,
and the tool policy is what decides what the text can make the agent do. `withContext` does not
fence hook blocks this way, because they have to stay identical to the MCP pool's `contextBlocks`.

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

The seam is not finished. `idleTimeoutMs` narrows to the one field it reads, but `getClient` still
asks for the whole of `Endpoint`. `requestTimeoutSeconds` became optional in v2, so a consumer
with no timeout to give now leaves it out rather than inventing a `0`.

### A model server answered in process

`Endpoint.fetch` sends that model server's requests through a function of the app's instead of the
global `fetch`: the SDK client's chat calls, streamed or not, the model listing, the native routes
`servedWindow` and `servedSlots` ask, and `probeEndpoint`. An app that keeps its model servers
behind its own forwarding code, a router counting usage per run, answers them there with no HTTP
door onto them, and a test answers them with no server on a port. Absent, nothing changes.

```ts
const config = { ...resolveAgentSpec(layers), fetch: forward };  // forward: typeof fetch
const result = await runAgentLoop({ config, messages, dispatch });
```

It is runtime only. `parseSpec` never reads one, `exportSpec` never writes one, `resolveAgentSpec`
never produces one, and it is not part of `EndpointIdentity`, `endpointKey` or `endpointId`, so a
digest is what it was. The app adds it to the resolved endpoint, as it adds the key.

Nothing found through one function answers for another, or for the global `fetch`. Every cache of a
model server, the client pool, the listings and native-route answers, the capability latches (the
no-thinking hints among them) and the calibrated characters per token, is held once for the global
`fetch` and once per function, in a `WeakMap` under the function. Two endpoints with one URL and
different functions never share a client, a listing or a refusal, and a function the app drops
takes its copies with it. An app that makes a function per run makes a client per run too, which is
cheap when the function is in process, and learns each refusal again per run.

A snapshot cannot hold a function, so `exportCapabilities` and `importCapabilities` take the one to
read or write the latches for, a whole endpoint being fine, and the global `fetch`'s when given none:

```ts
importCapabilities(settings.capabilities, config);   // on boot, with this process's `forward`
settings.capabilities = exportCapabilities(config);  // the latches learned through `forward`
```

A side task is a streamed request like any other, so a function that answers one in process answers
it as a stream. It reaches the same function in two ways. `taskCall`, and so the loop's own `preselect` and
`compact`, gives a task on the agent's model server the agent's `fetch` as it gives it the agent's key.
A task on another model server is never given it, since an app's function may add that server's
credentials; an app answering every model server itself sets its function on each task's endpoint:

```ts
const tasks = Object.fromEntries(
  Object.entries(resolved.tasks).map(([key, task]) => [key, { ...task, endpoint: { ...task.endpoint, fetch: forward } }]),
);
await runAgentLoop({ config: { ...resolved, tasks, fetch: forward }, messages, dispatch, preselect: true });
```

## An agent as a document

The seam above says what a *running* agent is. `@cubicecho/agent-core/spec` says what a **stored**
one is: a versioned JSON document that any app on this package can read, layer and hand to the
loop. It exists because the applications here spell "an agent" three incompatible ways — `maxTokens: 0`
means *no ceiling* in one, *inherit* in the next and *a real ceiling of zero* in the third, and an
empty server list means *no tools* in one and *every tool* in another. `docs/agent-spec-v1.md` argues
the whole thing out.

```ts
import { parseSpec, resolveAgentSpec } from "@cubicecho/agent-core/spec";

const { spec, errors, warnings } = parseSpec(JSON.parse(text));
if (!spec) throw new Error(errors.join("\n"));

const config = resolveAgentSpec([settingsSpec, spec]); // weakest layer first
const { systemPrompt } = config;                       // the loop's option of the same name
const result = await runAgentLoop({ config, systemPrompt, ... }); // already the shape the loop takes
```

**Absent inherits, and nothing else does.** There is no inherit sentinel at any depth: `0`, `-1`,
`""` and `[]` are values that mean what they say, and `null` reads as absent because a nullable
column round-trips through JSON that way. `tools.servers` keeps its tri-state — absent is every
server the app offers, `[]` is none, a list is exactly those — and layering replaces it whole
rather than unioning, since a union of "these two" and "none" is "these two", which silently widens
a scoped agent. `prompt`, `hooks` and `tasks` merge by id, which is one rule expressing two
behaviours: different ids stack, the same id replaces.

`parseSpec` reports every problem at once and refuses only four things, all of them about the
document rather than a value: it is not an object, the `spec` token is missing or of another major,
a `requires` entry this app does not understand, or a container is of the wrong kind. Everything
else is dropped with a warning — including an out-of-range number, which is **dropped rather than
clamped**, because a clamp invents a value the author did not write while dropping falls back to one
somebody did.

The document carries **no credential at any depth**, and a `${VAR}`-shaped string is kept as the
literal it is rather than expanded — a format with no interpolation needs no credential denylist.
Resolution yields `apiKey: ""`, which `getClient` turns into `NO_KEY`; an app that wants inheritance
applies `resolveApiKey` afterwards, so a document naming somebody else's model server cannot make this
app send its own provider key there. `exportSpec(spec)` strips a bundled server's `env` and
`headers`, and a redacted document is still a valid one.

Those two fields are where the format puts a bundled server's credentials, and not the only place a
pasted `.mcp.json` has them: an `--api-key` among the `args`, a `?token=` or a `user:pass@` in the
`url`. `exportSpec` keeps those, since a server with its query string cut off is a different
server, and `findSpecSecrets` says where they may be so an app can warn before it calls a file safe
to share:

```ts
const out = exportSpec(spec);
for (const { path, server, sign } of findSpecSecrets(out)) {
  warn(`${server}: ${path} may hold a credential (${sign})`); // bundle.mcpServers[0].args[2] … (flag)
}
```

A hint is a place and a reason — `SecretSign.Userinfo`, `Query`, `Flag`, `Value` or `Field` — and
never the value. It is a guess in both directions: a credential in a positional argument with no
telling prefix is missed, and a flag called `--keyboard` is named. A `${VAR}` is a reference, and is
not reported.

`bundle.mcpServers` is parsed only under `parseSpec(document, { bundle: true })`. A bundled server
is a command line and an environment map, so importing one is equivalent to running a program, and
that is a decision an app makes rather than inherits from a default.

The subpath is separate from the main entry for one reason: `client.ts` and `hooks.ts` import
`node:crypto`, and `spec.ts` imports only modules that need nothing from Node and import nothing
themselves, so a browser validating a pasted document in a form can load it. Its entry,
`src/spec/entry.ts`, is `spec.ts` and `AGENT_DEFAULTS`, the fallbacks `resolveAgentSpec` fills in,
which live with the other groups in `core/defaults.ts`. Nothing outside
`src/spec/` imports it — the same direction the config seam runs, which is what lets a document
travel between apps without the loop growing an opinion about where an agent comes from.

### From a row, and back

A document has one spelling of "inherit" — the field is absent — and a database row cannot leave a
column out, so every app stores a marker instead: `""` for a text column, `-1` where zero is a real
answer, the word `inherit` in an enum, `null` in a nullable one. `defineSpecColumns` is the table
from those columns to the fields they feed, with each column's marker a parameter, so the projection
is declared once rather than written out in both directions:

```ts
import { defineSpecColumns } from "@cubicecho/agent-core/spec/columns";

const profile = defineSpecColumns<Agent>(
  {
    model: { path: "model.model", inherit: "" },
    maxTokens: { path: "model.maxTokens", inherit: -1 },
    temperature: { path: "model.temperature", inherit: null },
    toolDiscovery: { path: "tools.discovery", inherit: "inherit" },
    systemPrompt: { path: "prompt.system", inherit: "" },
    compactionModel: { path: "tasks.compaction.model", inherit: "" },
    toolExecution: { path: ["extensions", "com.example.host", "toolExecution"], inherit: "inherit" },
  },
  { handled: ["bundle", "tools.servers"] },
);

resolveAgentSpec([settings.toLayer(settingsRow), profile.toLayer(agentRow)]); // markers say nothing
const row = profile.fromLayer(spec);   // an absent field comes back as its column's marker
const lost = profile.dropped(spec);    // [{ path: "model.extraBody", value: {...} }, ...]
```

The table is keyed by column, so a column the row does not have, a marker of the wrong type and a
path the format has no field at are all type errors. A column with no `inherit` says every value it
holds, which is an app's bottom layer; `null` and `undefined` are absent whatever the marker. A
column that stores something other than its field — a switch for a discovery mode — converts with
`toSpec` and `fromSpec`, and either returning `undefined` says nothing: that is how a marker that
is a range (a trimmed blank, any negative) is spelled, and how a column refuses a value it cannot
hold. `prompt.<id>` is one part's text; an extension's reverse-domain key has dots of its own, so
its path is written as segments.

`dropped` is the import preview's list: what a document says that `fromLayer` will not keep, in the
document's order, and never silently. A field with no column is reported at its path, a task or
extension with nothing mapped in it whole, and a value a column's `fromSpec` refused carries that
column's name. What the app reads by hand — a bundle, `tools.servers` resolved to its own row ids —
goes in `handled` and is left out.

### Its side tasks

`tasks.<key>` configures a side task apart from the main model — its own model, model server, ceiling,
temperature, reasoning effort and `extraBody` — and resolution hands each back as a `ResolvedTask` holding only
what a layer stated. `taskCall` turns one into the arguments `ask`, `askJson`, `summariser` and
`preselect` already take, so a setting added to a task later arrives without the app's call
changing:

```ts
const title = taskCall(config.tasks.title, { signal, onNotice }, config);
const name = await ask(title.endpoint, title.model, "Name this chat.", firstMessage, title.options);
```

**An absent setting is the side task's own default, never the agent's.** A titler under an agent
running at temperature 1.0 is still sent 0.3, and its ceiling is still `ask`'s 512, `summariser`'s
1024 or `preselect`'s 256. What the task does state wins over the same field in the options beside
it, so the options are where an app puts its own default for a task that names none. `maxTokens: 0`
sends no ceiling, as it does on the main model.

`reasoningEffort` is the one that reads differently from the main model's. A side task is sent the
no-thinking hints by default, and absent or `"off"` keeps them; a level — `"low"`, `"high"` — is
sent as `reasoning_effort` in their place, for a compaction model an operator pointed at a model
that should deliberate.

`extraBody` carries the sampler fields a model card asks for, as it does on the main model: `ask`,
`askJson`, `summariser` and `preselect` all take one in their options, merge it in after the
temperature, and offer its keys to `negotiate` as `droppable`, so a field the model server refuses by
name is latched off for that model and the request is sent again without it. The agent's own
`model.extraBody` is never sent to a side task, and `taskCall` lays a task's over the app's key by
key.

The third argument is the model server the main exchange uses. Given it, a task on the same model server is
sent the agent's spelling of the URL and, having no key of its own, the agent's key, so the two
share one entry in `capabilitiesFor` and a refusal learned by either is known to both; a task on
another model server is sent only a key of its own, as `resolveApiKey` has it. The agent's `fetch`
follows the key: a task on the agent's model server with none of its own sends through it, and a task
on another model server sends through that server's own
([A model server answered in process](#a-model-server-answered-in-process)).

The loop reads two of them when asked to. `preselect: true` has `runAgentLoop` make the
preselection itself with `tasks.toolSelect` — or with `toolSelectModel` on the agent's model server,
which stays the flattened spelling for an app that is not on the spec — and `compact: true` has it
compact the transcript before a turn, once `planCompaction` says the `contextLength` context window
is filling, with `tasks.compaction` writing the summary and no falling back to the main model
without it. Both are off by default: an app that already calls `preselect` or compacts in
`beforeTurn` is not sent a second request.

The preselector falls back to the main model. With neither `tasks.toolSelect` nor
`toolSelectModel` naming one, `preselect: true` asks `config.model` on the agent's own model server at
`preselect`'s defaults: an app that opted in has asked for a preselection, and an empty name is a
setting nobody filled in. Compaction has no such fallback. An app that wants no preselection passes
no `preselect`. A spec layer that declines the task with `model: ""` leaves it absent from the
resolved agent, as one nobody configured is, so under `preselect: true` the main model is asked
there too.

What it asks about is the question as written: the last user message of `messages`, which the hooks'
context never reaches because the loop puts that on the request. An app that put context on the
question itself passes `preselectQuery`. The preselection and the hooks' `gather` run side by side,
since neither reads the other, so asking for both costs the first request one round trip rather
than two.

What the loop picked it says twice. A `notice` event names the tools before the first `turn` event
— `PRESELECTED_NOTICE` and then the names, comma-separated — and the result's `preselected` is the
shortlist the exchange opened with, the app's own where it gave one and empty where nothing was picked.
An exchange that fails carries it too, beside `loaded` and `used`.

Called directly, `preselect` reads an empty model as no preselection and says nothing about it; it
is only the loop that falls back. An app calling it itself whose settings read `""` as "use the
run's model" says so in the call:

```ts
await preselect(config, settings.toolSelectModel || settings.model, catalog, prompt, options);
```

```ts
const result = await runAgentLoop({ config, preselect: { keywords: true }, compact: true, ... });
```

## The numbers it was written with

Every value here that somebody chose — a limit, a wait, a share of the context window, a retry
count — is in one module, `src/core/defaults.ts`, as a member of a group named for what it tunes.
Each group is a frozen object of plain JSON values with a written-out `…Settings` type, and all of
them are exported, so "what can be changed about compaction?" has one answer:

```ts
import { configureEvents, EVENT_BUS_DEFAULTS } from "@cubicecho/agent-core";

// Tool calls that take an hour want twice the unended retention, whatever the default is.
configureEvents({ retainUnendedMs: EVENT_BUS_DEFAULTS.retainUnendedMs * 2 });
```

| Group | Tunes |
| --- | --- |
| `CLIENT_POOL_DEFAULTS` | the client pool: `maxClients`, `listingMissMs`, `lookupTimeoutMs` |
| `MODEL_SERVER_DEFAULTS` | waiting on a model server: the first token, the probe's listing, a model loading |
| `RETRY_DEFAULTS` | the backoff between attempts at a lost request |
| `REQUEST_SIZE_DEFAULTS` | sizing a request with no tokenizer: the ratio, its calibration, the smallest window believed |
| `CONTINUATION_DEFAULTS` | carrying on a cut-off answer |
| `TOOL_CALL_DEFAULTS` | quoting a call back, and minting an id for one |
| `SIDE_TASK_DEFAULTS` | a side task's ceiling, temperature and retries |
| `PRESELECT_DEFAULTS` | choosing tools before an exchange, by model or by keyword |
| `TOOL_DISCOVERY_DEFAULTS` | how many tools a load takes and a conversation carries, and a server's instruction budget |
| `HOOK_DEFAULTS` | the context hooks share, and the preface above it |
| `COMPACTION_DEFAULTS` | when to compact, how much to keep, what a summary may cost |
| `PRUNE_DEFAULTS` | what a prune leaves whole, and what it has to win back |
| `TOKEN_LEDGER_DEFAULTS` | telling a kept prompt cache from a broken one |
| `EVENT_BUS_DEFAULTS` | what the bus keeps of a run, and for how long |
| `AGENT_DEFAULTS` | what `resolveAgentSpec` gives a field no layer set (also on `@cubicecho/agent-core/spec`) |

Nothing reads a group as a switch. A function a caller varies takes the setting as an option, and
its default is the member: `ask`'s `maxTokens` is `SIDE_TASK_DEFAULTS.maxTokens` until a call says
otherwise. The three process-wide ones are moved by `configureClients`, `configureEvents` and
`configureHooks` (or a runtime's options), which take a `Partial` of the group's settings and hand
back what is in force. A group itself never changes while the program runs. A unit is in each
member's name, in the unit a person would edit, except where an app already sets the value by name:
`retainMs` and `listingMissMs` stayed in milliseconds rather than break every `configureEvents` call.

The facts that could not be otherwise, `MS_PER_SECOND` and `MS_PER_MINUTE`, are beside it in
`src/core/consts.ts`, and are not exported.

## What is kept for the life of the process

Three caches outlive any one run: the `OpenAI` clients, the model listings, and the latched
capabilities, which include the models that refused a side task's no-thinking hints. A fourth, the
characters per token each model was measured at, is keyed on the model server's capabilities object, so
it goes with them. All three are
held once per runtime — once per process, unless you make another, [below](#a-runtime-of-its-own)
— and keyed on the same notion of a model server: its base URL as `baseUrlKey` writes it, its API
key, and its `Endpoint.fetch` ([above](#a-model-server-answered-in-process)). The clients' key
carries the request timeout as well, since that changes how a request is sent. The slots a session
is pinned to are the one exception: they are one server's physical caches, so they are kept per URL
and model alone.

**They are keyed per deployment, not per request.** What belongs in them is a model server an
operator configured: a settings row, an agent definition, an environment variable. Everything
bounding them assumes that, and a consumer that mints an API key per *user* breaks the assumption
— each tenant gets its own client, its own connection pool and its own latches, held until
`resetAll`.

That is bounded rather than unbounded: the client pool is a 32-entry LRU, and an evicted client
costs its connection pool and nothing else, since the next request through that model server builds
another. But churning connection pools is not sharing them, and at that point a runtime per
tenant, [below](#a-runtime-of-its-own), is the better answer than this.

The listings cache also remembers, for half a minute, that a model server did not name a model — the
case where a configured name never matches anything the server serves (a llama.cpp `-a` alias, an
OpenRouter `:free` suffix, a typo) would otherwise fetch the listing on every call and answer the
same zero each time. Half a minute later it asks again, so a model pulled onto a box that has been
up a week is still picked up without a restart.

Which session holds which llama.cpp slot is kept as well, keyed on the base URL and the model but
not the key: two keys reaching one server under two allocators would hand one slot to two sessions,
which is the collision the allocator is there to stop. It is bounded by the slots the server
reported, and the slot count itself is asked for again every half minute, so a server restarted
with another `--parallel` is not sent a slot it no longer has. `resetSlots` clears it, and
`resetAll` with the rest.

Both numbers are defaults, as is the ten seconds a context-window lookup is given
(`lookupTimeoutMs`). `configureClients` moves them for the process, the way `configureEvents`
and `configureHooks` do — a multi-tenant app raising the pool so tenants stop evicting each other,
a dev box shortening the miss window so a model it has just pulled shows up sooner:

```ts
import { configureClients } from "@cubicecho/agent-core";

configureClients({ maxClients: 256, listingMissMs: 2_000 });
```

A field left out, or given anything that is not a number above zero, keeps what it has, and the
call returns everything in force. Lowering `maxClients` below the pool's current size evicts down to
it at once, least recently used first. `resetClients` (and `resetAll`) puts the defaults back.

An app that keeps its own state per model server should key it on `endpointKey` — the JSON of the base
URL as `normalizeBaseUrl` writes it and the key, an absent key read as `NO_KEY` — rather than rebuilding that string, so the two
cannot drift. `endpointKey` holds the key in the clear; `endpointId`, its SHA-256 digest, is the one
that is safe to write down.

`resetAll` drops all four, and each has a seam of its own for a test that wants one —
`resetCalibration` for the measured ratios, `resetHints` for the models that refused the
no-thinking hints, leaving the other latches.

The latches can outlive the process as well, because otherwise every restart spends one refused
request per model server and model learning the same facts again. `exportCapabilities` returns every
refusal as a JSON-safe `CapabilitySnapshot`, and `importCapabilities` takes one back:

```ts
importCapabilities(settings.capabilities);          // on boot; false if the version moved on
// ...
settings.capabilities = exportCapabilities();       // on shutdown, or after a notice
```

A snapshot names model servers by `endpointId`, a SHA-256 digest of the URL and key, so it can be
written to a settings row or a file without a credential going with it. It holds the latches of the
model servers that send through the global `fetch`; an app with a function of its own passes it on
both sides ([A model server answered in process](#a-model-server-answered-in-process)). Importing merges and only
latches off, the same as a refusal does. A snapshot of another `version` is ignored. How old is too
old is left to the consumer, who can read `savedAt` first: a server upgraded between boots may
accept what it used to refuse, and nothing latched ever unlatches on its own.

It unlatches when you say so. A server upgraded behind the same URL — a newer llama.cpp that
compiles the grammar, a proxy that has learned `stream_options` — keeps being sent the downgraded
request until something forgets what it refused, and `resetCapabilities` takes the model server to
forget:

```ts
resetCapabilities(row);                                           // this one changed, through its fetch
expireCapabilities(6 * 60 * 60_000);                              // anything half a day old
```

`resetCapabilities` with no argument still clears every model server, which is what `resetAll` and a
test mean by it; with one it clears that model server alone, so an upgraded local box does not cost the
cloud model server beside it its latches, and returns whether there was anything to forget. Call it
where the app already knows something changed: a settings row saved, a health check reading a new
build string, an operator pressing a button.

`expireCapabilities(maxAgeMs)` covers the case where nobody knows, dropping every model server older
than that and returning how many. An expiry does not probe anything — it stops suppressing, so the
next request carries the field again and a server that still refuses it refuses it once, which
`negotiate` answers as it always did. At an age measured in hours that is a few extra round trips a
day against a downgrade that would otherwise last as long as the process. Nothing calls it on a
timer; when to sweep is yours, the same way how stale a snapshot is too stale is.

A model server's age is when it was first met, not when a flag latched, and `exportCapabilities`
carries it in the snapshot so an imported latch keeps its real age instead of being born again on
every boot. Importing takes the older of the two ages, and a snapshot written before this field
existed reads as met now.

### A runtime of its own

Everything above is the *default runtime*: one set of caches, shared by every caller in the
process. `createRuntime` makes another, with its own clients, listings, latches, hints, measured
ratios, event bus and hook settings, and the functions that use them as methods of the same names
and signatures:

```ts
import { createRuntime } from "@cubicecho/agent-core";

const runtime = createRuntime({ clients: { maxClients: 8 }, events: { maxEvents: 200 } });

const run = await runtime.runAgentLoop({ config, messages, dispatch });
for await (const event of runtime.watch(runId)) send(event);
runtime.resetAll();                 // this runtime's caches, and nobody else's
```

It is for the app the section above warns off — one that mints a key per tenant, where a shared
pool has tenants evicting each other's clients and a shared bus makes one tenant's run id readable
by another — and for tests, where a runtime per case needs no `resetAll` between cases and lets
them run in parallel. An app with one deployment's worth of model servers needs none: the top-level
functions are the default runtime's methods, and nothing about them has changed.

The runtime travels by async context (`AsyncLocalStorage`), not by argument. A method runs its
function with the runtime current, and it stays current across every `await` beneath it — so
`runtime.runAgentLoop` uses the runtime's clients and latches all the way down, and so does a
top-level function your code calls from inside it: an `emit` in `onEvent`, an `ask` in `dispatch`,
a `gather` in a hook. `runtime.run(fn)` does the same for code that calls the top-level functions
itself:

```ts
await runtime.run(async () => {
  const limit = await contextLimitFor(config);   // the runtime's listing cache
  emit(runId, { kind: "output", text: "…" });    // the runtime's bus
});
```

Outside a method or `run`, a top-level function is the default runtime's again. That is the one
thing to keep straight: a request handler that watches or emits to a run a runtime started is not
inside it, and calls `runtime.watch` or `runtime.emit`. What a method hands back keeps its runtime
— the iterator from `runtime.watch`, the function from `runtime.summariser` — wherever it is read.

A new runtime starts from the package's defaults plus what `createRuntime` was given; it does not
inherit what `configureClients` and the others set on the default one. Nothing needs closing: a
runtime is garbage once nothing holds it. `defaultRuntime` is the process's own as an object, for
code that takes a `Runtime` and should be handed the shared one.

The two schema caches (`sanitizeTools`, `relaxTools`) and `requestTokens`' tool-length cache stay
process-wide. They are memoised pure functions keyed on the caller's own objects, so there is
nothing in them for one tenant to learn about another.

## Where the merged behaviour came from

- `schema-compat` — `kanban_server`/`task_server`'s version, which strips **every** sibling of a
  `$ref` rather than just `default`. `min-agent`'s did the latter, which leaves `nullable` beside
  the surviving `$ref` on `anyOf: [{$ref}, {type: "null"}]` — the shape a schema-generated server
  emits at every optional argument — and a strict validator rejects the tool.
- `tool-loading` — theirs, plus `min-agent`'s `carryOver`/`MAX_CARRIED`, which bounds the tool
  array across the exchanges of a conversation. Both suites' assertions are kept.
- `events` — `kanban_server`'s `usage` totals **and** `task_server`'s exchange grouping, including
  its `fold` fix: two blocks in different stages are not one block.
- `retry` — `kanban_server`'s, which is the only one of the three with the `ContextOverflow`
  guard. `min-agent` had no retry layer at all.
- `agent-loop` — `task_server`'s `length` notice and abort checks, `min-agent`'s parallel dispatch
  with its dedupe (as an option) and its handling of nameless call fragments and empty stored
  arguments, and the ceiling test `task_server` and `kanban_server` agreed on rather than
  `min-agent`'s inverted one.
- `compaction` — `min-agent`'s arithmetic and `SUMMARY_PROMPT`, the only implementation of the
  three. Pruning had none.
