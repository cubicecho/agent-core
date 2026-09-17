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
| `stream` | Reads one streamed turn back into a message: token callbacks, tool-call reassembly, fenced reasoning taken out of the answer, and the idle watchdog that turns a silent endpoint into `EndpointSilent`. |
| `capabilities` | What an endpoint turned out not to support — and, under it, what one model on that endpoint did not — plus the loop that answers either when it says so. `capabilitiesFor`, `modelCapabilitiesFor`, `negotiate`. |
| `thinking` | Tells a scratchpad fenced inside `content` from the answer: `FenceSplitter` for a stream, `stripThinking` for a whole reply, and the fence tables both read. |
| `side-task` | One-shot calls that support a run without being one — small prompt, short answer, no tools, never worth failing the run over. `askJson` holds the answer to a schema where the server can. |
| `hooks` | The host's side of lifecycle hooks: `gather` before a request and `notify` after, the shared context budget, `withContext` to put what they add on the turn's question, `untrusted` to fence text nobody vouched for, and `turnMessages` to hand them a transcript. Running a hook is a runner the caller passes. |
| `events` | The in-memory bus a watcher reads while a run happens: `emit`, `watch`, `history`, `fold`, and `runMetrics` for what a run cost. A watcher's backlog is capped and reports its own gaps. |
| `client` | A pooled `OpenAI` client per endpoint, plus the context window: the served one where a local server says, the listed one otherwise, and their caches. |
| `retry` | What to do when a request is lost, refused or too big: `isTransient`, `isModelLoading`, `backoffMs`, `ContextOverflow`, `EndpointSilent`, `requestTokens`, `contextTokens`. |
| `calibration` | How many characters a token is worth on one model, learned from the prompt counts its endpoint reports: `charsPerTokenFor`, `calibrate`. |
| `continuation` | `continueTurn`: carries on an answer the token ceiling cut off, by prefilling it as a trailing assistant message. |
| `config` | The structural interfaces every function here asks for. |
| `run-turn` | `runTurn`: one turn with the retry loop around the negotiation around the stream. The whole loop, for a caller that wants it rather than its parts. Sizes the request against an opt-in `contextLimit`. |
| `agent-loop` | `runAgentLoop`: the loop above a turn — `runTurn` per step, the tools between, `load_tools` and preselection handled, until the model stops asking. Plus the parts it is made of: `buildBody`, `preselect`, `preview`, and `resolveApiKey` for a caller deciding which key an endpoint gets. |
| `tool-calls` | Reading what a model meant by a tool call it did not write cleanly: `parseToolArguments` repairs almost-JSON arguments and says when they were cut off, `recoverToolCalls` finds calls written into the reply as text. |
| `compaction` | Keeping a long run inside its window: `pruneToolResults` clears stale tool results, `planCompaction` and `compactTranscript` fold the oldest stretch into a summary. |
| `snapshot` | `exportCapabilities` and `importCapabilities`: the latched refusals as a JSON blob a consumer stores, so a restart need not learn them again. |
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

`Turn` is `content`, `toolCalls`, `usage`, `finishReason` and `reasoning`. The fourth is worth
reading: a turn cut off at the token ceiling comes back looking exactly like a finished one, with
truncated prose or — the case that bites — a tool call whose `arguments` stop mid-JSON, so the
caller meets a parse failure with nothing to attribute it to. `finishReason` is `"length"` there,
`""` where the endpoint never said.

`usage` is `prompt`, `completion`, `total` and `cached`, always there and zero where the server
sent nothing. Everything else on it is there only when something measured it, and absent rather
than zero otherwise:

| Field | From |
| --- | --- |
| `uncached` | the prompt less `cached`, only where a cache count was reported, so a cold cache and no report read differently |
| `reasoningTokens` | `completion_tokens_details.reasoning_tokens`; never estimated from the thinking stream |
| `promptMs`, `promptTokensPerSecond`, `predictedMs`, `tokensPerSecond`, `draftTotal`, `draftAccepted` | llama.cpp's `timings`, which also stands in for `cached` (`cache_n`) where the usage has no cache count |
| `firstTokenMs` | `streamTurn`, from the request to the first chunk that carried something |
| `wallMs`, `retries`, `timeouts` | `runTurn`: the whole turn with its backoff, the lost requests sent again, and how many of those went silent |
| `continuations` | `continueTurn` |
| `cacheExpected`, `cacheBroken`, `cacheBreakReason`, `toolsDeclared`, `toolSchemaTokens` | `runAgentLoop`, below |

`reasoning` is the scratchpad `onThinking` was told, kept because two common families want it
back. gpt-oss and DeepSeek in thinking mode read the analysis behind a tool call off the assistant
message on the next request: store it as `reasoning_content` on that message while it ends in a
tool call, and drop it once the model has answered. Any other model is better off without it,
since it is context paid for on every turn. `requestTokens` counts it either way.

A server without a reasoning parser leaves the scratchpad in `content`, fenced, and then it is shown
as output, stored and sent back. `streamTurn` routes text inside a fence to `onThinking` and
`reasoning` instead, holding back the tail of a chunk that could be half a tag. `DEFAULT_FENCES` is
`<think>`, gpt-oss harmony's analysis channel served raw, and Kimi's `◁think▷`, none of which a
model writes as an answer; `ALL_FENCES` adds `<thinking>` and `<reasoning>`, which it can be
quoting, and is what the side tasks use. Pass `fences: []` to read `content` as all answer. A reply
cut off inside a fence has an empty `content`, not the deliberation promoted to one. A template that
opens `<think>` in the prompt leaves only the closing tag, so everything before it is moved to
`reasoning` when it arrives; `startInReasoning: true` says so up front, so `onOutput` is never told
it at all.

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

One more model flag is never answered by `negotiate`: `assistantPrefill`, whether the model
carries on a trailing assistant message rather than answering afresh after it. Only `continueTurn`
sends one, so only it latches the flag, and it is persisted in a snapshot like the rest.

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

`idleMs` is silence, not a deadline: the timer is rearmed on every chunk, so a model that is still
talking is never cut off however long it takes, and one that has stopped answering raises
`EndpointSilent` rather than hanging the run. `timeoutMs(config)` returns `undefined` for a
`requestTimeoutSeconds` of zero or absent, which waits forever — what a local model answering slowly
needs.

The first chunk gets its own allowance, `firstChunkMs`, because the first wait is prefill: tens of
seconds for a long prompt on a local GPU, minutes on a CPU, and longer again when the server is
loading the model on demand. It holds until a chunk carries something, so an empty
`{"role":"assistant"}` sent before the prompt is read does not start the idle clock.
`firstTokenMs(config)` reads `firstTokenSeconds` off the endpoint, and five times
`requestTimeoutSeconds` where that is absent. With a watchdog armed, the SDK's own timer is switched
off for the stream; it runs until the headers arrive, which is the end of prefill, and used to
abandon one at the idle number. `requestTimeoutSeconds` still bounds calls that do not stream, side
tasks and model listings, the same way.

## Structured side tasks

`askJson` is `ask` for an answer with a shape. It sends the schema as `response_format` of type
`json_schema`, which llama.cpp compiles into a grammar and vLLM, LM Studio, Ollama and OpenAI each
hold the reply to, so a small model that wraps JSON in prose on its own cannot do so here. The
schema is normalised the way a tool's parameters are, and relaxed where the endpoint could not
build a grammar, because llama.cpp reads both with the same converter. It also rides on the system
prompt, and the reply goes through `parseJson` either way.

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

`ask` and `askJson` take the user turn as a string or as content parts, because an image reaches an
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

`contextLimitFor` answers the operator's number when there is one. Otherwise it asks for the window
the server is actually serving the model in (`servedWindow`): llama.cpp's `/props`
(`default_generation_settings.n_ctx`) and LM Studio's `/api/v0/models` (`loaded_context_length`).
That differs from the trained window in the case the guard exists for, a 256k model started at `-c
16384`. A server with neither route is latched and not asked again. Failing both, it reads the
`/v1/models` listing: `max_model_len` from vLLM, `context_length` from OpenRouter, and llama.cpp's
`meta.n_ctx_train`, which is only the trained window. Ollama reports no window on any route this
reads, and truncates an over-long prompt rather than refusing it, so on Ollama pass `contextLength`
or there is no guard at all.

What is weighed is the prompt plus the reply ceiling the body carries, under whichever spelling
was chosen, because that is what the endpoint weighs: a 30k prompt into a 32k window with
`max_tokens: 4096` is refused there, so it is refused here. A body with no ceiling reserves
nothing, and the server gives the reply whatever the prompt leaves. A consumer that subtracted
`maxTokens` from the limit itself before calling in no longer needs to, and doing both reserves
the ceiling twice.

How many tokens the body is, is a guess: characters over a divisor. Four is right for English prose
and wrong for what a tool-using run is made of — JSON schemas and tool results pack closer to two or
three characters a token — so a request the guard let through was refused anyway. The divisor is
learned instead. Every turn `runTurn` answers comes back with the endpoint's exact prompt count for a
body whose characters were already counted, and `calibrate` keeps that ratio per endpoint and model;
the next request to the same model is sized by `charsPerTokenFor`, which is `CHARS_PER_TOKEN` (4)
until a turn has reported one. It is the highest of the model's last four readings, which is the
lowest token count: a count that comes out high refuses a run that would have fit, and one that
comes out low only costs the round trip the guard was saving. A reading from a request carrying an
image, or outside one to eight characters a token, is not taken.

`requestTokens` and `messageTokens` take `{ charsPerToken }`, and so does `planCompaction`, so a
caller sizing its own work can use the same number:

```ts
const charsPerToken = charsPerTokenFor(capabilitiesFor(config.baseUrl, config.apiKey), config.model);
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

`contextLimit` decides how early the caller hears, not what it hears. Without one, the endpoint
refuses instead — one round trip later — and `runTurn` reads that refusal back through
`isOverflow` and raises the same `ContextOverflow`, carrying the endpoint's own wording and the
original error as `cause`. A rate limit borrows those words and means the opposite ("Request too
large for gpt-4o ... on tokens per min"); that is ruled out and waited through as the 429 it is.

A server still loading the model is waited for on its own clock. llama.cpp answers 503 `Loading
model` (type `unavailable_error`) until the weights are mapped, thirty to ninety seconds for a large
model from a cold cache, and a router build says the same while it swaps models; `backoffMs` would
give up inside fifteen. `isModelLoading` recognises it, and `runTurn` polls every `LOADING_POLL_MS`
for up to `loadingTimeoutMs` (two minutes by default, zero to turn it off) without spending
`maxRetries`, with one notice at the start. `runAgentLoop` reads it as `loadingTimeoutSeconds` off
the config. A 503 that says nothing about loading stays on the ordinary backoff.

### What is filling the window

A total tells an operator a run is close to the edge and nothing about what to do next, so
`contextTokens` cuts the same body four ways, along the four levers there are: `system` is the
system and developer messages, which means shortening the prompt; `tools` is the declared schemas,
which means loading them on demand instead of declaring them whole; `toolResults` is exactly the
`tool` messages, which is precisely what `pruneToolResults` shrinks; and `history` is everything
else, which is what compaction folds, the arguments of the calls in it included.

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

## The loop

`runAgentLoop` is the part of an agent that three servers had each written, and that had drifted
the way the turn had before `runTurn`: one noticed a turn cut off at the ceiling and two did not,
one tested the ceiling's spelling the other way round, one sent a reasoning effort and two never
did. What it does not know is what the run is for — the prompt, the tools, and what a tool call
*does* are the caller's.

```ts
import { runAgentLoop, emit } from "@cubicecho/agent-core";

const { turn, messages, usage, loaded } = await runAgentLoop({
  config,                         // Endpoint & ModelParams & { maxToolIterations, toolDiscovery?, maxRetries?, loadingTimeoutSeconds?, contextLength? }
  system,                         // sent as the first message; on-demand mode appends the catalogue
  messages: history,              // ending in the question; not written to
  tools,                          // every tool the run may reach
  catalog,                        // the same, name-only, for on-demand loading
  preselected,                    // from `preselect`, if a small model chose
  dispatch: ({ name, args }, signal) => pool.call(name, args, signal),
  hooks: { run, context: { session: { id } } },
  signal,
  onEvent: (event) => emit(runId, event),
});
```

Each step is one `runTurn` with the body from `buildBody`, so everything `negotiate` answers is
answered here too, and a request that is too big throws `ContextOverflow` whichever side found
out. Between steps the loop runs the calls: sequentially by default, or together with `parallel: true`.
Either way an identical call — the same name and arguments, byte for byte — is made once and its
answer handed to the repeat, and two still in flight share the request. A call that threw is
forgotten rather than cached, so asking again is a real retry. What a tool throws is what the model
reads, and so are arguments that did not parse.

The scope is the step, not the run: between steps other tools have run, and the file the model read
may be the file it has since written. `dedupeToolCalls: false` dispatches everything, and a
predicate is asked per call — which is how `send_email` opts out, since twice is two emails and
nothing in an OpenAI tool definition says which tools those are. A pool that reads the MCP
`readOnlyHint` and `idempotentHint` annotations can answer it; this package cannot.

Arguments go through `parseToolArguments`, which is lenient where the model's meaning is plain:
JSON held in a string is opened, and the almost-JSON local models write — single quotes, Python's
`True` and `None`, bare keys, a trailing comma — is repaired, without touching what is inside a
string. What still is not an object throws a `ToolArgumentsError` whose `kind` is `truncated` when
the turn stopped at the ceiling, with a message telling the model so, and `malformed` otherwise.
The repaired JSON is what the transcript keeps, and an unreadable call is replayed as `{}`, because
a server that parses replayed arguments refuses the originals on every later request. `dispatch`
is still handed the model's own text as `raw`, and the dedupe compares repaired arguments,
so `{'a': 1}` and `{"a": 1}` are one call.

A server whose tool-call parser was written for another template streams the model's call as
plain text, and the run ends on a reply that is nothing but a call nobody made. Unless
`recoverToolCalls: false`, a turn with no calls, some text, and tools to call is passed through
`recoverToolCalls`, which finds `<tool_call>` blocks (Hermes, Qwen, Qwen3-Coder's markup),
`[TOOL_CALLS]` (Mistral, both spellings) and `<|python_tag|>` (Llama 3) after the last `</think>`,
and — naming only tools that exist — a reply that is only a JSON call or holds one fenced one.
Found calls are run as `call_recovered_0` onward, the text is what is left, `onTurn` and the
result see the turn that way, and a notice says so, since the real fix is the server's parser.

Every request declares its tools in name order, whichever way the caller assembled the array. A
chat template renders the tool block ahead of the system prompt, so the tool array is the first
thing a prompt cache has to match, and an array built from a map, from database rows, or from the
order servers happened to connect in is a different array on the next boot — the same tools, the
same run, and the cache for the whole transcript thrown away. Ordering by name makes it a property
of the set instead. `toolOrder: false` sends the caller's order, for a host that means it — a model
reads the array top to bottom — and a comparator orders it another way. `orderTools` is the same
thing for a caller with its own loop, and `buildBody` takes the order as its last argument.

With `toolDiscovery: "ondemand"` and a catalogue, the request declares `load_tools` and what has
been loaded, and the catalogue rides on the system prompt
unmarked, the same text on every step. Marking loads there rewrote the head of the prompt and lost
the prompt cache for the whole transcript on each one; a model that loads a tool twice is told in
the `load_tools` result that it already has it. A model that calls
a catalogued tool without loading it first is right about what it wants, and gets it loaded and
run. A preselection shapes the first step alone: those tools, no catalogue, no `load_tools` —
a model with the menu still in front of it shops, reloading what it has or picking a sibling —
and everything is back from the second step on.

A turn cut off at `maxTokens` is said so as a notice, and with `maxContinuations` above zero it is
continued first. `continueTurn` is the same thing for a caller with its own loop:

```ts
let turn = await runTurn(client, supports, build, options);
turn = await continueTurn(client, supports, build, turn, { ...options, maxContinuations: 2 });
```

It sends the transcript again with the answer so far as a trailing assistant message, which
llama.cpp renders as a prefill: the model carries on from the last token, and the cache holds all
of the prompt and most of the reply. vLLM only does so given `continue_final_message: true` and
`add_generation_prompt: false` on that request, which nothing here sends yet. The pieces come
back as one turn — content and reasoning joined, token counts summed, `continuations` counting the
extra requests, timings summed or weighted, a field only one piece reported dropped. Only an answer
begun and cut off is continued. A turn cut off in its scratchpad is left alone, since llama.cpp
refuses a prefill outright on a template with thinking on, and so is one ending in a tool call,
whose truncated arguments `parseToolArguments` already reports.

Whether it works is latched per model as `assistantPrefill`. A 400 or 422 for the request latches it
off, and so does a continuation that starts the answer over word for word — how hosted OpenAI, which
takes a trailing assistant message and ignores it, shows itself. Either way, and on any other
failure short of a stop, the cut-off answer is kept with a notice. The cap is one continuation for
`continueTurn` and none for the loop, since it spends a request, and on a server that does not
continue, one to find out.

Every turn ends in a `usage` event, whether or not the endpoint reported tokens. Its totals are the
run's so far; its `turn` is that turn's own `TurnUsage` and `finishReason`. The loop adds what only
it can know: `toolsDeclared` and `toolSchemaTokens` for the tool block it sent, and, from the second
request on, `cacheExpected` (the previous prompt plus its reply) and — where a cache count was
reported — `cacheBroken`, a hit short of 90% of the previous prompt. A broken cache is given a
`cacheBreakReason` read off the request against the one before: `tools-changed`, `system-changed`,
`history-rewritten` (a compaction or a prune in `beforeStep`), or `none-known` where the new request
only appended, which points at the server — a slot evicted, a template that re-renders the tail.

`runMetrics(events)` adds a run up from those events — tokens, cache hit ratio and breaks by
reason, prefill, decode and tool time, the slowest turn, mean time to first token, draft
acceptance, the largest prompt against a `contextLength`, turns cut off, tool errors by name, and
an `outcome`. The loop returns it as `metrics`, with the `load_tools` counts only it can see
(`toolsLoaded`, `redundantLoads`, `unknownToolNames`). It is a sibling of `fold` rather than part
of it, since `fold`'s blocks are for display and a summary is not one:

```ts
const metrics = runMetrics(history(runId), { contextLength: config.contextLength });
```

Counts are always present; every other field is absent where no turn reported what it is made of.
What it cannot say: whether a failed run was stopped, errored or ran out of tool iterations, and
whether the host compacted — neither is in the events.

`beforeStep` is handed the transcript before each request and may return a replacement, which is
where compaction goes (below). Hooks are gathered once, onto the question, and never written into
the transcript that comes back; `afterTurn` is told the reply without the run waiting on it.

`resolveApiKey` is exported and not applied, because which key an endpoint gets is a rule a
consumer states and a library guessing it could send one where it was not meant to go. The rule
it encodes is the conservative one: an endpoint's own key wins; one that names a base URL of its
own, different from the settings it inherits from, gets `NO_KEY` rather than the operator's key or
`$OPENAI_API_KEY`; anything else inherits.

## Fields this interface cannot spell

`ModelParams` has `temperature`, `maxTokens` and `reasoningEffort`. Everything else a model card or
a server asks for — `top_k`, `min_p`, `repeat_penalty`, llama.cpp's `id_slot`, `cache_prompt` and
`reasoning_budget` — goes in `extraBody`, which `buildBody` merges in last. It can override
`temperature` but not `model`, `messages`, `stream` or `tools`, which are the loop's.

A local server ignores a field it does not know. OpenAI refuses it — `Unrecognized request
argument supplied: min_p` — and so do some proxies, as `Unknown parameter: 'min_p'`. Given the
names it may drop as `droppable` (`runTurn` takes the same option, and `runAgentLoop` passes the
`extraBody` keys),
`negotiate` reads either wording, latches the name off for that model on that endpoint, and sends
again without it, with a notice naming it. A nested name is dropped at its top-level field. A
refused field nobody said was droppable is passed on, since dropping it would change the request
behind the caller's back.

On a llama.cpp server started with `--parallel`, pin each session to a slot with
`extraBody: { id_slot: n }`. The slot keeps that session's KV cache warm, which is the difference
between a cached prefill on every turn and a full one — but only while the prefix stays the same
from turn to turn; see #63, and the caution on compaction below.

Ollama's `options` object is not read on its OpenAI-compatible `/v1` route, so sampling set there
does nothing; send the fields at the top level.

## Keeping a long run inside its window

Two ways to make a transcript smaller, cheap first.

`pruneToolResults(messages, { keepLast: 5, maxChars: 256 })` replaces every tool result but the
latest five with a stub — `[result cleared, 10,412 chars]`. A 40k-character `read_file` is 10k
tokens on every turn after it, and by then the model has usually taken what it wanted; the stub
keeps the call answered and says how much was there.

`planCompaction(messages, { limit, used })` says where to fold the oldest stretch into a summary,
once `used` (the last turn's prompt tokens, or the estimate) is past three quarters of the window.
The kept tail fills at most 35% of it and starts on a user message, since a transcript resuming
mid-exchange is one servers refuse; leading system prompts are never folded, and an earlier
summary is continued rather than summarised. `compactTranscript` writes the summary and tells
`beforeCompact` hooks what is going while it does. Because the cut lands on
a user message, one long tool run under a single question has nothing to fold — pruning is what
keeps that one going.

```ts
beforeStep: async (messages, step) => {
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
nobody listens: the hooks run beside the summary, so a slow one costs the run nothing. Pass
`honourVeto: true` with the hooks and they run first — the summary waits on them — and a veto from
any hook that ran leaves the transcript as it was, with a note naming the hook. One that failed
vetoes nothing. A compaction passed `forced: true`, because a request was already refused as too
big, goes ahead regardless: a veto there only trades the summary for a `ContextOverflow`.
`consult` is the same wait for a host that compacts its own way.

```ts
const compacted = await compactTranscript(messages, plan, summarise, {
  hooks: { run, context, onNote, honourVeto: true },
  forced: retryingAfterOverflow, // the last request came back as a ContextOverflow
});
```

**Both rewrite the prefix.** A prompt cache matches from the first token, so a transcript whose
early messages change is re-processed whole — on a local server that is the entire prefill, every
time. Run them rarely and together, at the point `planCompaction` says the window is filling, so
the cache is lost once rather than a little on every turn. Pruning on every step is the expensive
way to save tokens.

`pruneToolResults` keeps the transcript's indexes, so a plan made before pruning still applies to
what it returns, as above.

### A fold you store, instead of a transcript you rewrite

`compactTranscript` hands back a new array, which is the whole answer for a host whose transcript
*is* that array. A host that keeps its messages append-only — rows in a database, every one still
shown in the chat — wants the other half: what the fold was, as something to store on the session.
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
them. A host whose system prompt is a separate argument and whose summary is a column has neither
in the array, and knows both exactly. Given them, nothing is scanned.

`applyCompaction(messages, fold)` is the way back — the summary as a `system` message, then
everything from `through` — and it writes the same `SUMMARY_LEAD` `planCompaction` looks for, so
the next fold continues those notes rather than summarising them a second time. No fold yet hands
back the messages themselves.

```ts
const request = [systemMessage, ...applyCompaction(session.messages, session.fold)];
```

**Two numberings.** A stored transcript keeps its indexes and a folded request does not, so
anything naming a position has to say which one it means. `requestIndex(index, fold)` maps the
stored index onto the request — for `withContext`'s index, or a range being shown to a hook.
`turnMessages` takes an `offset`, the stored index of the array's first message, so a message keeps
the uuid it had before the fold and a memory server deduping on it files that turn once rather than
twice; `turnIndex` takes one too, for the turns a fold took out of the array it is counting.
Planning over the stored transcript, as above, sidesteps both: the plan's indexes are the host's
already, and so are the ones `runCompaction` hands the `beforeCompact` hooks.

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

The budget is the caller's to move, at either level. `configureHooks` sets it for the process, and
`maxTokens` on `gather` (or the second argument to `assembleContext`) sets it for one request and
wins over it — the one to reach for when the budget follows the model, since a 128k window can
afford more recall than an 8k one:

```ts
import { configureHooks, gather } from "@cubicecho/agent-core";

configureHooks({ contextTokens: 4000 });
const gathered = await gather(run, ["beforeTurn"], context, { maxTokens: contextLimit / 20 });
```

Either one given something that is not a number above zero keeps what was there, as
`configureEvents` does, so a `0` threaded through for "no opinion" does not switch recall off.
`resetHooks` (and `resetAll`) puts the default back.

The preface said above the blocks moves the same way. `HOOK_PREFACE` names no host, so a host that
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
who leaves once the turn is answered has not asked for it not to be remembered.

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

The seam is not finished. `timeoutMs` narrows to the one field it reads, but `getClient` still
asks for the whole of `Endpoint`. `requestTimeoutSeconds` became optional in v2, so a consumer
with no timeout to give now leaves it out rather than inventing a `0`.

## What is kept for the life of the process

Four caches outlive any one run: the `OpenAI` clients, the model listings, the latched
capabilities, and `side-task`'s no-thinking hints. A fifth, the characters per token each model was
measured at, is keyed on the endpoint's capabilities object, so it goes with them. All four are module-level and keyed on the same
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

Both numbers are defaults. `configureClients` moves them for the process, the way `configureEvents`
and `configureHooks` do — a multi-tenant host raising the pool so tenants stop evicting each other,
a dev box shortening the miss window so a model it has just pulled shows up sooner:

```ts
import { configureClients } from "@cubicecho/agent-core";

configureClients({ maxClients: 256, listingMissMs: 2_000 });
```

A field left out, or given anything that is not a number above zero, keeps what it has, and the
call returns everything in force. Lowering `maxClients` below the pool's current size evicts down to
it at once, least recently used first. `resetClients` (and `resetAll`) puts the defaults back.

A host that keeps per-endpoint state of its own should key it on `endpointKey` — the JSON of the base
URL and the key, an absent key read as `NO_KEY` — rather than rebuilding that string, so the two
cannot drift. `endpointKey` holds the key in the clear; `endpointId`, its SHA-256 digest, is the one
that is safe to write down.

`resetAll` drops all five, and `reset.ts` names each seam separately for a test that wants one —
`resetCalibration` for the measured ratios.

The latches can outlive the process as well, because otherwise every restart spends one refused
request per endpoint and model learning the same facts again. `exportCapabilities` returns every
refusal as a JSON-safe `CapabilitySnapshot`, and `importCapabilities` takes one back:

```ts
importCapabilities(settings.capabilities);          // on boot; false if the version moved on
// ...
settings.capabilities = exportCapabilities();       // on shutdown, or after a notice
```

A snapshot names endpoints by `endpointId`, a SHA-256 digest of the URL and key, so it can be
written to a settings row or a file without a credential going with it. Importing merges and only
latches off, the same as a refusal does. A snapshot of another `version` is ignored. How old is too
old is left to the consumer, who can read `savedAt` first: a server upgraded between boots may
accept what it used to refuse, and nothing latched ever unlatches on its own.

It unlatches when you say so. A server upgraded behind the same URL — a newer llama.cpp that
compiles the grammar, a proxy that has learned `stream_options` — keeps being sent the downgraded
request until something forgets what it refused, and `resetCapabilities` takes the endpoint to
forget:

```ts
resetCapabilities({ baseUrl: row.baseUrl, apiKey: row.apiKey });  // this one changed
expireCapabilities(6 * 60 * 60_000);                              // anything half a day old
```

`resetCapabilities` with no argument still clears every endpoint, which is what `resetAll` and a
test mean by it; with one it clears that endpoint alone, so an upgraded local box does not cost the
cloud endpoint beside it its latches, and returns whether there was anything to forget. Call it
where the host already knows something changed: a settings row saved, a health check reading a new
build string, an operator pressing a button.

`expireCapabilities(maxAgeMs)` covers the case where nobody knows, dropping every endpoint older
than that and returning how many. An expiry does not probe anything — it stops suppressing, so the
next request carries the field again and a server that still refuses it refuses it once, which
`negotiate` answers as it always did. At an age measured in hours that is a few extra round trips a
day against a downgrade that would otherwise last as long as the process. Nothing calls it on a
timer; when to sweep is yours, the same way how stale a snapshot is too stale is.

An endpoint's age is when it was first met, not when a flag latched, and `exportCapabilities`
carries it in the snapshot so an imported latch keeps its real age instead of being born again on
every boot. Importing takes the older of the two ages, and a snapshot written before this field
existed reads as met now.

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
- `agent-loop` — `task_server`'s `length` notice and abort checks, `min-agent`'s parallel dispatch
  with its dedupe (as an option) and its handling of nameless call fragments and empty stored
  arguments, and the ceiling test `task_server` and `kanban_server` agreed on rather than
  `min-agent`'s inverted one.
- `compaction` — `min-agent`'s arithmetic and `SUMMARY_PROMPT`, the only implementation of the
  three. Pruning had none.
