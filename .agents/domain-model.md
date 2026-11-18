# Domain model

What `@cubicecho/agent-core` is made of: its concepts, who may change them, and what always
holds. This file lives at `.agents/domain-model.md` and describes the code **as it is on this
branch**. Proposed changes are `M` items in `.agents/coding-standards-todos.md` and in the pull
request that makes them; they are written in here by the commit that makes them true. The one
exception is an approved rename: the glossary uses the new word at once and says, after
`Owner:`, what the code still calls it and which item renames it. Use these terms, and only
these, in code, tests, docs and reviews.

## Purpose

The part of an AI agent that is the same in every application: talking to an OpenAI-compatible
model server, coping with what it refuses or loses, running the model's tool calls, keeping a long
conversation within what the model can read, and reporting what happened. An application brings
its own prompts, tools and work.

## Four levels

The work comes in four sizes, each made of the next:

```
Session    one conversation over time
└ Run      one whole job, from trigger to finish (one runId on the event bus)
  └ Exchange   one input through to the reply it gets
    └ Turn     one model reply, plus running any tools it asked for
```

A person writes "get me some info about my email". That message starts an **exchange**. In
**turn 1** the model reads it and replies "call `search_email`", and the package runs that tool.
In **turn 2** the model reads the results and writes the answer, and the exchange is over: one
exchange, two turns. In a chat app the **run** holds just that exchange, and the **session** is
the whole conversation it belongs to. An app with a workflow, such as a task made of a triage
stage and a fix stage, runs one exchange per stage inside a single run.

## Flow

```
agent settings (optional document) ──┐
the app's tools and callbacks ───────┼→ exchange: ask the model → run the tools it asked for → repeat → result
                                     └→ events: the exchange's start, each turn, its end → anyone watching
```

- **An exchange:** given a conversation ending in a question, ask the model, run the tools it
  asks for, add their results and ask again, until it answers, a tool says the job is done, a
  call is handed back to the app, or something fails. (`runAgentLoop`)
- **One request:** built from what this server and model accept, resent without whatever it
  refuses or when it is lost, and read as it streams in. (`runTurn`)
- **A side task:** a small one-off question, such as naming a conversation, picking tools or
  writing a summary, that never makes the main exchange fail. It is sent as one request, the same
  way a turn's is. (`ask`, through `runTurn`)
- **Settings from a document:** an agent written as JSON layers (app defaults, the agent, one
  task) is checked and merged into an exchange's settings. (`resolveAgentSpec`)
- **A remote agent:** when the server runs its own agent, the package only passes the app's tools
  back and forth and relays the server's progress reports.
- **Pausing for the app:** an exchange can stop until the app answers some tool calls itself
  (say, by asking a person), then start again from where it stopped.

The folders stack from general to specific, and a folder only uses those below it, so the basic
pieces never depend on the loop built from them. From the bottom: `core`, `wire`, `endpoint`,
`turn`, then `tools` and `hooks` side by side, then `context` (which uses both), then `run`, then
`runtime`. `spec`, the
agent document, stands apart and uses only a few small pieces, so it also loads in a browser.

## Actors

| Actor | Is | Reaches the package through | Can affect |
|---|---|---|---|
| App | the application using the package | the settings and callbacks it passes in | everything an exchange starts from: the model, the conversation, the tools; it can rewrite the conversation before each turn, add a message mid-exchange, and decide whether a paused exchange continues. It alone announces that a run is over (the `done` event), and it names each exchange the loop runs |
| Model | the AI model on the server | its replies | what it says, which tools it calls and with what arguments, and which extra tools it loads. It cannot end or pause an exchange, except by replying without asking for tools |
| Model server | the server the model runs on | its answers and errors | which request features are used from then on (a refused feature is not sent again), how big requests are estimated to be, and whether a reply was cut short or filtered |
| Remote agent's server | a server that runs its own agent loop | progress reports streamed with its replies | what watchers see of its own turns, the ids of the calls it hands back, and the id of its own run |
| Tool runner | the app's function that runs one tool call | one call in, its result out | what the model is told that call returned, and whether that answer ends the exchange. It never sees the rest of the conversation |
| Hook runner | the app's function that runs agent hooks | the package asking at fixed moments | extra context added to the question, short notes about what the hooks did, and whether a planned summary goes ahead: the loop's own summaries ask for its veto unless the app opts out, and an app's own ask when it says so. Never the conversation itself |
| Watcher | anything reading a run's events | the event stream | nothing; it only reads |
| Operator | a person writing an agent document | the document's layers, or stored settings rows | the agent's settings, prompt, side tasks, hooks and which tool servers it may use. Never a password or key: exporting a document strips them |

## Lifecycles

### An exchange

From a question to what the app is told at the end.

- Starting → Running (a server slot may be reserved; tools may be shortlisted)
- Running → Answered (replied without asking for tools), Cut short (length limit) or Filtered
- Running → Ended (a tool's answer said the job is done; the turn's other calls still finish)
- Running → Waiting (calls were handed back to the app and no tool ended the exchange)
- Running → Running (tools answered and turns remain, or the app had a new message waiting)
- Running → Failed with "too many turns" (the turn limit ran out)
- Any → Failed (the app stopped it, a callback threw, a request failed, or it overflowed)
- Any → Stopped (the app's signal aborted it, and it throws)
- Waiting → Starting (the app answers the waiting calls and starts again: a new exchange)

The loop says the exchange started, with an `exchange` event, and how it ended, with an
`exchange-end` that carries the outcome, on every way out: a failed or stopped exchange sends it
just before it throws. The outcome is on the result too; a failed exchange throws and has none
there. A reserved slot is always released.

### A turn

One round of asking the model and running what it asked for:

- Before asking: take any waiting message from the app, let the app rewrite the conversation,
  and trim or summarise it if it is getting too long.
- Asking: send the request; if the reply was cut off at the length limit, ask the model to go on.
- After the reply: give each tool call a unique id, set aside those handed back to the app, and
  add the model's message.
- Running the calls: one at a time, or in groups where `parallel` allows (never for models that
  take one call per message); results go in the order asked.

### A tool call

From the model asking for a tool to its result in the conversation:

- Asked → Named (nameless calls dropped; calls written out as text picked up) → Given a unique id
  → Read (arguments parsed; unreadable ones become `{}` and an error result)
- → Handed back (no result while the exchange waits for the app; answered "not needed" if another
  call ended the exchange)
- → Answered by the package (loading tools, recording an artifact, refusing a bad call), or from an
  identical call earlier in the turn, or sent to the tool runner
- Sent → Answered, or Failed (the error, worded so the model knows), or Stopped (the app cancelled)
- The exchange stops part-way: a running call is answered "stopped", one not yet started "not run"

### What a server refuses

What each server and model turned out not to support, remembered so it is not asked twice.

- Unknown → Assumed supported (first use) → Not supported (refused, resent without it, noticed)
- Not supported → Unknown again (a reset, or it expires); Unknown → As saved (a snapshot loaded)

While remembered, features only go from supported to not supported, and refusals only add up.

### Sending one request

How one request survives a busy, slow or overloaded server.

- Too big for the window, before or after sending → Fails as an overflow
- Sent → Answered (the size estimate is tuned from the reply)
- Failed after the reply had started, or cancelled → Fails (a half-sent reply is never resent)
- Server is still loading the model → Wait and ask again (doesn't count as a retry)
- Lost connection, timeout or busy server, retries left → Wait, longer each time, and resend
- Anything else → Fails

### A tool loaded on request

When tools load only as the model asks, each catalogued tool goes:

- Listed (the model sees only its name) → Loaded (shortlisted, or asked for, up to a limit each time)
- Listed → Still listed (too broad, not allowed yet, or unknown; the model is told why)
- Loaded → Used (the model called it) → Carried into the app's next exchange, or dropped
- Loaded through the proxy tools → Listed again (a trim or summary removed its definition from
  the conversation)

### Keeping the conversation inside the window

How a long exchange stays small enough for the model to read.

- Trimming: once the window is full enough, old tool results before a cut-off become one-line
  stubs; the cut-off only moves forward
- Summarising: the oldest stretch is picked → hooks are told, and may veto it when the app asks
  for that (`honourVeto`, which the loop's own summaries default to) → a summary is written
  and stored as a record → applying it puts the summary in that stretch's place, keeping the
  question and the rest (`compactTranscript` does both)

### Remembered state, reset and snapshot

What the package remembers between exchanges (clients, server refusals, event history).

- Not yet remembered → Remembered (on first use, per runtime) → Forgotten (a reset)
- Server refusals → Saved snapshot → Remembered again on load (not size estimates or slots)

### An agent document

From a JSON file, or a stored row, to the settings an exchange uses.

- Any input → Rejected (only if it isn't recognisably an agent document) or Accepted (bad fields
  dropped with warnings)
- Stored settings row → Layer (unchecked)
- Layers, weakest first → Merged settings → plus the app's key and transport → an exchange's settings
- Document → Exported copy without tool servers' secrets → checked for any secret that may remain

## Invariants

| Invariant | Enforced by |
|---|---|
| The SDK never retries a request itself | `getClient` (`maxRetries: 0`) |
| A client or lookup reached through one fetch function never answers for another | `perFetch` |
| A model server at a different URL never inherits the configured key | `resolveApiKey`, `taskCall` |
| A stored base URL is http(s) with no credentials, query, fragment or trailing slash | `normalizeBaseUrl` |
| A reply that has produced anything is never sent again | `Produced`, checked in `negotiate` and `runTurn` |
| The caller's abort is never reported as `EndpointSilent`, and an aborted stream never returns a reply | `streamTurn` |
| One refusal gets at most one answer, and negotiation ends | `negotiate` over `ANSWERS`, `flagsOf` |
| Capability flags and refused fields only latch off while their entry lives, except the no-thinking hints, which `resetHints` offers again | `endpointAnswer`, `latchModel`, `latchFields` |
| An effort is only stepped up the ladder, never down | `nextEffort`, `planEffortStep` |
| A refused field is latched only if the caller offered it as droppable | `droppedFieldsAnswer` |
| `extraBody` never sets `model`, `messages`, `stream` or `tools` | `extraFields`, `parseExtraBody` |
| A spec layer's `extraBody` never sets what the spec spells elsewhere, whether `parseSpec` read it or not | `parseExtraBody`, and `unownedFields` on resolve (`SPELLED_BODY_FIELDS`) |
| An absent ceiling or temperature is never sent; a ceiling of zero or less is never sent | `ceilingAndTemperature` |
| A loading wait never spends the retry budget | `runTurn` |
| A request is size-checked at most once, and never against a window below 8192 tokens | `runTurn` (`SMALLEST_LIKELY_WINDOW`) |
| An overflow, however found, stays a `ContextOverflow` | `refuseOversized`, `runTurn`, `AgentLoopOverflow` |
| A rate-limit message is never read as an overflow | `isOverflow` |
| Tool arguments handed to a dispatcher are always an object; replayed arguments are valid JSON | `parseToolArguments`, `readCall` |
| A call id is unique across the transcript (except on a remote agent, whose ids are kept) | `distinctCallIds`, `freshCallId` |
| Every call in the transcript has a result, except a waiting exchange's pending calls, which come last | `runCalls`, `splitHandedBack` |
| Results are written in the order asked, whatever order they finished in | `runCalls` |
| No tool result is empty, and a failed dispatch says so in its text | `nonEmpty`, `formatToolError` |
| A handed-back call is never dispatched, deduped, batched or counted as used | `splitHandedBack`, `markUsed` |
| A call that ends the exchange beats a hand-back, and an end does not stop the turn's other calls | `runCalls` |
| Dedupe never reaches across turns | `runCalls` (a fresh `answered` map per turn) |
| App tools are never catalogued, loaded or reached through `call_tool` | `hostToolsApart`, `lookThrough` |
| `call_tool` reaches only catalogued tools | `proxiedCall` |
| One `load_tools` call or preselection brings in at most `maxPerLoad` definitions | `expandNames`, `preselection` |
| Hook context goes on the request, never into the transcript or the system prompt | `withContext` on the request in `runTurns` |
| Only `sessionStart` and `beforeExchange` hook output can reach the model | `assembleContext` (`INJECT_EVENTS`) |
| A declaration is believed only where a call in the exchange touched the location; one artifact per location | `answerRecord`, `RunArtifacts` |
| The ledger indexes into the current transcript | `rebaseLedger`, each turn |
| A prune boundary only moves forward | `planPrune` |
| A failure carries the exchange as it stood | `standing.read`, `runAgentLoop` |
| At most `maxToolIterations` turns | `runTurns`, `ToolIterationLimit` |
| Event `seq` and `runId` are the bus's to give | `stamp` |
| Every exchange the loop runs opens with one `exchange` event and closes with one `exchange-end`, whether it returns or throws | `runAgentLoop`, `endedBy`, `exchangeEnd` |
| An exchange's end never moves a run off waiting | `emit` |
| A bus listener that throws never reaches the emitter | `emit` |
| A remote agent's turn events are not said twice, and its `exchange`, `exchange-end` and `done` are not forwarded | `remoteRun` (`SERVER_OWNED`, `UNFORWARDED`) |
| A remote agent's turn sends one idempotency key across its retries | `remoteRun.turnHeaders`, once per turn |
| Each runtime has its own copy of module state | `scoped`, `currentScope` |
| An absent or `null` spec field inherits; `0`, `""` and `[]` are values | `isAbsent` in `parseSpec` and `toLayer` (a `null` becomes absent), then `mergeLayers`, `mergeModel` and `resolveAgentSpec` |

## Glossary

### The four levels

- **Session:** one conversation over time, which may hold many runs; it starts, ends and can be
  deleted. Owner: the `sessionStart`, `sessionEnd` and `sessionDelete` hook events; the loop's
  `AgentLoopOptions.session` is its key, sent as `SESSION_HEADER` for router affinity and used to
  pin a slot.
- **Run:** one whole job, from what triggered it to its finish: every exchange in it, plus the
  app's own events, under one run id on the event bus. In a chat app a run holds one exchange; in
  a task workflow, one exchange per stage. Owner: the `runId` of `RunEvent`, `emit`, `watch`,
  `runMetrics`; the app chooses where a run starts and ends.
- **Exchange:** one input, from a person or a machine, through to the reply it gets, made of one
  or more turns. It ends answered, cut short, filtered, ended, waiting or failed. Owner:
  `runAgentLoop` (`src/run/agent-loop.ts`), whose result is `AgentLoopResult` and whose outcome is
  an `ExchangeOutcome`.
- **Turn:** one model reply, plus running any tools it asked for; usually one request, more when a
  reply cut off at the length limit is continued. Owner: the loop in `runTurns`; the `Turn` type
  (`src/wire/stream.ts`) is the reply part, run by `runTurn`, and the `turn` event and
  `RunMetrics.turns` count them. A turn's number, from zero, is `turn`: on `AgentLoopRequest` and
  `RunArtifact`, and the number `beforeTurn`, `onTurn` and `onMessage` are handed.
- **Exchange events:** where an exchange starts and how it ended, which exchange each event belongs
  to, and which arm a deciding exchange chose. The loop sends the start and the end of each
  exchange it runs, the end with its outcome even when it throws, and names every event with the
  app's name for the exchange; the app sends the choices. Owner: `RunEventKind.Exchange`,
  `RunEventKind.ExchangeEnd`, `RunEvent.exchange`, `RunEvent.outcome`, `AgentLoopOptions.exchange`,
  `RunMetrics.exchanges` and `RunEventKind.Decision`. A remote agent's own starts and ends are not
  passed on. Events stored or relayed before 5.0.0 say `step` for the first and third, and the
  package no longer reads them.

### Reaching a server

- **App:** the application using the package, which brings its own prompts, tools and work and
  decides what each exchange starts from. Owner: the caller of `runAgentLoop`; the code and README
  call it the host (`hostTools`).
- **Model server:** one OpenAI-compatible server as configured: where it is, the key that
  reaches it, how long to wait, and optionally a function its requests go through. Owner:
  `Endpoint` in `src/core/config.ts`; the code calls it an endpoint throughout.
- **Model server identity (endpoint identity):** the URL and key that tell two model servers
  apart. Owner: `EndpointIdentity`; spelled at runtime as `endpointKey` and its digest `endpointId`.
- **Fetch function:** a function a model server's requests are sent through instead of the network,
  so an app can answer them in process; each gets its own clients and caches. Owner:
  `Endpoint.fetch`, `perFetch` (`src/endpoint/client.ts`).
- **Client:** the pooled SDK client for one model server, made once and reused. Owner: `getClient`;
  settings in `ClientPoolOptions`, `configureClients`.
- **Key inheritance:** a model server with no key of its own borrows the configured one only when it
  points at the same server. Owner: `resolveApiKey`.
- **Idle timeout (request timeout):** how long a streamed reply may go quiet once it has started.
  Owner: `Endpoint.requestTimeoutSeconds`; also `timeoutMs`, `idleMs`.
- **First-token timeout:** how long to wait for a reply's first token. Owner:
  `Endpoint.firstTokenSeconds`; also `firstTokenMs(config)`, `firstChunkMs`.
- **Model listing:** the models a model server says it serves. Owner: `listModels`, `ModelInfo`.
- **Model server probe (endpoint probe):** a one-off listing of a model server a person is still
  typing into a form. Owner: `probeEndpoint`, `EndpointProbeError`.
- **Context window (window, context length, context limit):** how many tokens a model reads: the
  operator's declared number, else what a local server says it is serving, else what the listing
  says. Owner: `contextLimitFor`, `servedWindow`; `AgentConfig.contextLength`,
  `RunTurnOptions.contextLimit`, `CompactionOptions.limit`.
- **Slot (`id_slot`):** one of a llama.cpp server's parallel caches; a session is pinned to one to
  keep its prompt cache warm. Owner: `pinSession`, `slotAllocator` (`src/endpoint/slots.ts`),
  `servedSlots` (`src/endpoint/client.ts`).

### What a model server and a model refuse

- **Capabilities (latches):** what a model server turned out not to support, learned from its
  refusals and remembered. Owner: `Capabilities`, `capabilitiesFor` (`src/endpoint/capabilities.ts`).
- **Model capabilities:** the same, per model: effort, the ceiling's spelling, a chosen
  temperature, structured output, prefill, replayed reasoning, several calls per message, the
  no-thinking hints, and refused fields and efforts. Owner: `ModelCapabilities`,
  `modelCapabilitiesFor`.
- **Latch (downgrade):** turning a capability off for good after one refusal, so later requests
  are sent the lesser form at once. Owner: `latchModel`, `latchFields`, through which `negotiate`'s
  `Answer`s in `ANSWERS` and a continuation latch a model's capabilities.
- **Negotiation:** sending a request and re-sending it without whatever the server refused, until
  it answers or refuses something nothing can drop. A refusal that names nothing it can drop is
  not guessed at, for a side task as for a turn. Owner: `negotiate`, which `runTurn` calls for
  both.
- **Droppable field:** a request field the caller lets a refusal remove. Owner:
  `NegotiateOptions.droppable`, `refusedFields`.
- **Reasoning effort:** how hard a reasoning model should think; a refused level is stepped up to
  the cheapest one the model takes, and `off` sends nothing. Owner: `effortFor`, `EFFORT_LADDER`,
  `EFFORT_OFF`.
- **Reply ceiling (max tokens):** the most tokens a reply may use, sent under whichever name the
  model takes, or not at all. Owner: `ceilingAndTemperature`, `ModelParams.maxTokens`.
- **Notice:** a one-line message saying what was given up, waited out or retried. Owner:
  `OnNotice`, `RunEventKind.Notice`.
- **Capability snapshot:** the latches as JSON an app stores, so a restart need not learn them
  again. Owner: `exportCapabilities`, `importCapabilities` (`src/runtime/snapshot.ts`).
- **Schema sanitising and relaxing:** rewriting a tool's JSON Schema into shapes a strict server
  accepts, and also dropping `pattern` and `format` once a server failed to compile one. Owner:
  `sanitizeTools`, `relaxTools`, `isGrammarError` (`src/endpoint/schema-compat.ts`).

### A reply

- **Reply:** what the model sends back for one request: its text, tool calls, usage, finish
  reason and scratchpad. Owner: `Turn` (`src/wire/stream.ts`), read by `streamTurn`.
- **Finish reason:** why the model stopped: it was done, hit the ceiling, called tools, or was
  filtered. Owner: `FinishReason`; `Turn.finishReason`.
- **Request body:** the streamed request worked out from the config and what was refused. Owner:
  `buildBody` (`src/run/request-body.ts`).
- **Extra body:** request fields this package has no name for, sent last. Owner:
  `ModelParams.extraBody`; it may not set `RESERVED_BODY_FIELDS`.
- **Retry:** sending a lost request again after a backoff, only for a transient failure and only
  before anything came back. Owner: `runTurn`, `isTransient`, `backoffMs`.
- **Model loading:** a local server answering that it is still loading the model, waited out
  without spending retries. Owner: `isModelLoading`, `runTurn`.
- **Context overflow:** a request bigger than the model reads; never retried. Owner:
  `ContextOverflow`, `isOverflow` (`src/wire/retry.ts`).
- **Model server silent (endpoint silent):** the model server went quiet past its timeout. Owner:
  `EndpointSilent`.
- **Continuation:** carrying on a reply the ceiling cut off by sending it back as a trailing
  assistant message. Owner: `continueTurn` (`src/turn/continuation.ts`).
- **Scratchpad (reasoning, thinking):** what a model wrote while deliberating, kept apart from
  its answer. Owner: `Turn.reasoning`, `FenceSplitter`, `stripThinking` (`src/wire/thinking.ts`).
- **Fence:** the markers a model puts around a scratchpad inside its text, such as `<think>`.
  Owner: `Fence`, `DEFAULT_FENCES`.
- **Reasoning replay:** which assistant messages carry the scratchpad back to the model. Owner:
  `ReasoningReplay`, `dropReasoning`.
- **Turn usage:** what one reply cost: tokens, cache hits, timings and retries. Owner:
  `TurnUsage`; an exchange's totals are `LoopUsage` / `UsageTotals`.
- **Token estimate:** a rough count, characters over a calibrated ratio (four until learned).
  Owner: `estimateTokens`, `requestTokens` (`src/wire/tokens.ts`), `charsPerTokenFor`, `calibrate`.
- **Untrusted fence:** a wrapper marking text as data, not instructions; hooks and server
  instructions fence what nobody vouched for with it. Owner: `untrusted`, `UNTRUSTED_PREFACE`
  (`src/wire/text.ts`).

### Side tasks

- **Side task (task):** a small one-shot call that supports an exchange, such as naming it,
  choosing its tools or summarising, and is never worth failing it. It is one request sent by
  `runTurn`, as a turn's is: streamed, negotiated, retried, and waited out while the model loads.
  Owner: `ask`, `askReply`, `askJson` (`src/turn/side-task.ts`), whose `complete` builds the body;
  `TaskSpec` in a document, `SideTask` in code.
- **No-thinking hints:** fields sent so a reasoning model answers a side task directly, dropped
  per model once a refusal names them. Owner: `NO_THINKING`, offered to `negotiate` as droppable;
  the latch is `chat_template_kwargs` in `ModelCapabilities.refusedFields`.
  `ModelCapabilities.thinkingHints` is only read, for a snapshot from before 6.0.0 that latched it.
- **Structured answer:** a side task's reply as JSON for a schema. Owner: `askJson`, `parseJson`.
- **Forgiving side task:** a side task whose failure becomes "no answer" and a notice. Owner:
  `tryAsk`.
- **Task call:** a configured task turned into the call that honours its settings, borrowing the
  agent's key and fetch only on the agent's own server. Owner: `taskCall`.

### An exchange

- **Transcript (messages, history):** the exchange's messages, without the system prompt, which
  it appends to and hands back. Owner: `AgentLoopResult.messages`.
- **Question:** the user message the exchange is answering. Owner: `isQuestion`, `questionAt`.
- **System prompt:** the app's instruction, with server instructions and the catalogue added,
  sent first on every request. Owner: `AgentLoopOptions.system`.
- **Turn budget:** the most turns an exchange may take before it fails. Owner:
  `ToolPolicy.maxToolIterations`, `ToolIterationLimit`.
- **Input (mid-exchange input):** a message a person sent while the exchange was going, which it
  takes between turns. Owner: `AgentLoopOptions.takeInput`, `RunEventKind.Input`.
- **Before-turn rewrite:** the app's chance to replace the transcript before a turn. Owner:
  `AgentLoopOptions.beforeTurn`, `TurnWindow`.
- **Result:** what an exchange that did not throw hands back. Owner: `AgentLoopResult`; its
  `afterExchange` is the `afterExchange` hooks' notes, as a promise the loop does not wait for.
- **Outcome:** how an exchange ended: answered, cut short, filtered, ended, waiting, or (as events
  tell it) failed or stopped. A run's outcome is told in the same words: its last exchange's,
  unless the app's `done` says the run failed. Owner: `ExchangeOutcome` (`src/run/events.ts`),
  decided by `exchangeOutcome` and carried by `exchange-end`; a run's is `RunMetrics.outcome`.
- **Failure:** what an exchange throws, carrying it as it stood. Owner: `AgentLoopError`,
  `AgentLoopOverflow`, `ToolIterationLimit`, `failedRun` (`src/run/failure.ts`).
- **Stop (abort):** the app cancelling an exchange through its signal. Owner:
  `AgentLoopOptions.signal`, `isAbort`; a stopped exchange throws.

### Tool calls

- **Tool call:** one tool the model asked for, under its id, name and arguments. Owner:
  `ToolCall` (`src/wire/tool-calls.ts`), `ToolCallRequest` (`src/run/dispatch.ts`).
- **Call id:** the id pairing a call with its result: the server's where it is unused in the
  transcript, or always a fresh one under `callIds: 'minted'`. Owner: `distinctCallIds`,
  `CallIds`, `mintCallId` (`src/wire/call-ids.ts`); `callId` on `EndedBy` and `RunArtifact`.
- **Recovered call (call written as text):** a call the model wrote into its reply instead of
  making it, which the loop runs. Owner: `recoverToolCalls`.
- **Dispatcher:** the app's function that runs one call and returns what the model reads.
  Owner: `AgentLoopOptions.dispatch`, `ToolDispatch`.
- **Tool answer:** a dispatcher's reply when it has more than text: links, and whether it ends
  the exchange. Owner: `ToolAnswer` (`src/run/dispatch.ts`).
- **Tool result:** one call's answer as the transcript, the app and watchers get it. Owner:
  `ToolCallResult`, `ToolCallOutcome`; `formatToolError` words a failure, `(no output)` an empty one.
- **App tools (host tools):** tools the app answers itself, declared on every turn in every
  discovery mode and never catalogued. Owner: `AgentLoopOptions.hostTools`.
- **Parallel batch:** a group of a turn's calls that run together. Owner:
  `AgentLoopOptions.parallel`, `batchEnd`.
- **Dedupe:** answering an identical second call in one turn from the first. Owner:
  `dedupeToolCalls`.
- **One call per message:** writing each call in its own assistant message, for templates that
  take only one. Owner: `ModelParams.singleCallMessages`, `splitCalls`, `oneCallPerMessage`.
- **End (ended):** a tool's answer saying the job is done, which ends the exchange once the turn's
  calls are answered. Owner: `ToolAnswer.end`, `AgentLoopResult.ended`, `ExchangeOutcome.Ended`.
- **Hand back (pending, waiting):** leaving a call for the app to answer later; the exchange stops
  after the turn, waiting, with a `wait` event and then its end. Owner: `AgentLoopOptions.handBack`,
  `AgentLoopResult.pending`, `ExchangeOutcome.Waiting`, `RunEventKind.Wait`, `RunEvent.pending`.
- **Resume:** calling the loop again with a waiting exchange's transcript, its pending calls
  answered, and its ledger and loaded tools. Owner: the app; described on `AgentLoopResult.pending`.

### Tools the model is shown

- **Catalogue:** the connected servers' tool names and one-line descriptions, without schemas.
  Owner: `CatalogServer` (`src/tools/catalog.ts`).
- **Tool discovery:** how definitions reach the model: all of them every time (eager), loaded
  from the catalogue when asked for (on-demand), or loaded and called through two fixed tools
  (proxied). Owner: `ToolDiscovery` (`src/core/config.ts`); chosen for an exchange by `discoverTools`
  (`src/tools/discovery.ts`).
- **`load_tools`:** the tool the model calls to load definitions by name or wildcard. Owner:
  `LOAD_TOOLS`, `expandNames` (`src/tools/tool-loading.ts`).
- **`call_tool`:** the proxied tool that runs a catalogued tool by name. Owner: `CALL_TOOL`,
  `proxiedCall`.
- **Loaded tools:** the tools whose definitions the model has this exchange. Owner:
  `AgentLoopResult.loaded`, `loadedTools`.
- **Carry-over:** the loaded tools an app passes into its next exchange, used ones kept first.
  Owner: `carryOver`.
- **Used tools:** the tools the model actually called. Owner: `AgentLoopResult.used`.
- **Preselection (shortlist):** choosing an exchange's tools before it starts, by a small model or
  by keywords. Owner: `preselect`, `preselectByKeywords` (`src/tools/preselect.ts`); the loop's own
  is `chooseTools`, `PRESELECTED_NOTICE` (`src/tools/discovery.ts`).
- **Tool order:** sorting the tool array by name so the same set always reads the same to the
  prompt cache. Owner: `orderTools`.
- **Server instructions:** the guidance an MCP server sends on connect, added to the system
  prompt, attributed and fenced. Owner: `serverInstructionsPrompt` (`src/tools/instructions.ts`).

### Hooks

- **Hook event:** a moment a hook can be bound to: a session starting, before an exchange starts,
  after it has its reply, before a summary replaces old messages, and a session ending or being
  deleted. Owner: `HookEvent` (`src/hooks/hook-events.ts`); the exchange's two are
  `beforeExchange` and `afterExchange`.
- **Hook runner:** the app's function that runs an event's hooks; the package never runs one.
  Owner: `HookRunner` (`src/hooks/hooks.ts`).
- **Hook outcome:** what one hook did: its text, whether to inject it, its cap, and a veto.
  Owner: `HookOutcome`.
- **Injected context:** hook text put on the question's request, fenced and capped by a shared
  budget. Owner: `gather`, `assembleContext`, `withContext`.
- **Hook note:** one line saying what a hook added, why it failed, or that it vetoed. Owner:
  `HookNote`.
- **Gather, notify, consult:** firing hooks to collect context, to tell and move on, or to wait
  for a veto. Owner: `gather`, `notify`, `consult`.

### Keeping an exchange inside its context window

- **Token ledger:** the prompt sizes each request reported, used to measure what stretches of
  the transcript cost. Owner: `TokenLedger`, `recordRequest`, `tokensBetween`
  (`src/context/ledger.ts`).
- **Epoch:** a stretch of requests that only appended, within which two prompts can be compared.
  Owner: `LedgerEntry.epoch`.
- **Cache break:** a request whose prompt cache fell short of the one before, and the likely
  reason. Owner: `cacheDiagnosis`, `breakReason`, `CacheBreakReason`, `TurnUsage.cacheBroken`.
- **Prune:** replacing old, long tool results with a one-line stub. Owner: `pruneToolResults`,
  `planPrune` (`src/context/compaction.ts`).
- **Prune boundary:** the point before which tool results are sent as stubs; it only moves
  forward. Owner: `PrunePlan`, `pruneThrough`.
- **Compaction (fold, in older code and docs):** replacing the oldest stretch of the transcript with a written summary.
  Owner: `planCompaction`, `runCompaction`, `applyCompaction`, `compactTranscript`.
- **Compaction record:** one compaction as an app stores it and applies again. Owner: `CompactionRecord`.
- **Summary pair:** a compaction's summary as a user message and a fixed acknowledgement. Owner:
  `SUMMARY_LEAD`, `SUMMARY_ACK`.
- **Compact threshold:** how full the context window must be before pruning or compaction is
  considered.
  Owner: `COMPACT_AT`.

### Watching a run

- **Run event (event):** one thing that happened in a run, numbered within it. Owner: `RunEvent`,
  `RunEventKind`; `RunEventInput` is the unnumbered form.
- **Done:** the event that says a run is over; the app sends it, not the loop. Owner:
  `RunEventKind.Done`.
- **Bus:** the in-memory store of each run's events that watchers read, with a backlog for late
  ones. Owner: `emit`, `watch`, `history`, `endRun` (`src/run/events.ts`).
- **Stamp:** making a whole event from an input, with its run, number and time. Owner: `stamp`.
- **Metrics:** a run's totals, timings, cache findings and outcome, read off its events. Owner:
  `RunMetrics`, `runMetrics`; an exchange's own are on `AgentLoopResult.metrics`.
- **Artifact:** something an exchange's calls produced, one per location: linked by a tool's
  answer, declared by the model, or detected from a write. Owner: `RunArtifact`
  (`src/run/dispatch.ts`), `RunArtifacts` (`src/run/artifacts.ts`), `record_artifact`.
- **Server log:** a log line a tool's server sent during a call. Owner: `ServerLogEntry`,
  `ToolCallReport`.

### A remote agent

- **Remote agent:** a model that runs a whole agent loop of its own on the server and hands the
  app's tools back as calls. Owner: `RemoteAgentParams`, `remoteAgent: true` (`src/core/config.ts`);
  `asRemoteAgent`, `remoteRun` (`src/run/remote.ts`).
- **Progress:** the server's own events, carried beside the reply under one body field. Owner:
  `PROGRESS_FIELD` (`ai_router`), `RemoteAgentParams.progressField`; encoded and read by
  `progressChunk`, `withProgress`, `progressEvent`, `progressEvents`.
- **Idempotency key:** one key per turn, sent again on its retries, so a server does not start
  the same work twice. Owner: `IDEMPOTENCY_HEADER`.
- **Remote run id:** the server's own id for its run. Owner: `AgentLoopResult.remoteRunId`.

### An agent as a document

- **Agent document (agent spec, layer):** a versioned JSON document defining an agent, where each
  layer says only what it changes. Owner: `AgentSpec`, `AGENT_SPEC` (`src/spec/spec.ts`).
- **Layer:** one document in an ordered stack, weakest first, such as settings, agent, task and
  stage. Owner: `resolveAgentSpec`.
- **Inherit:** an absent or `null` field takes the layer below's value; `0`, `""` and `[]` are
  values. Owner: `isAbsent` (a `null` is read as absent when a layer is parsed), `mergeLayers`,
  `resolveAgentSpec`.
- **Parse:** checking any input into a document, dropping bad fields with warnings and refusing
  only what cannot be identified. Owner: `parseSpec`.
- **Resolved agent:** the flat config the layers come to, plus prompt parts, tasks, hooks and
  servers. Owner: `ResolvedAgent`, `RESOLVED_DEFAULTS`.
- **Prompt part:** one named piece of system prompt, text or a reference to a file. Owner:
  `PromptPart`.
- **Agent hook:** a tool call bound to a hook event, which the app runs. Owner: `AgentHook`.
- **Server scope:** which MCP servers an agent may reach: all, none, or exactly a list. Owner:
  `ToolsSpec.servers`.
- **Bundle:** full MCP server definitions an agent carries so it can travel whole. Owner:
  `parseBundle`, `SpecServer`.
- **Extensions and requires:** an app's own payloads, and the ones an app must understand to
  accept the agent. Owner: `AgentSpec.extensions`, `AgentSpec.requires`.
- **Export:** a copy of a document fit to leave the app, with credentials stripped. Owner:
  `exportSpec`, `findSpecSecrets`.
- **Spec columns:** a mapping between an app's stored row and a layer, both ways. Owner:
  `defineSpecColumns` (`src/spec/columns.ts`).

### Process state

- **Runtime:** one isolated set of the package's caches, with every stateful function as a
  method, for apps whose tenants must not share them. Owner: `createRuntime`, `defaultRuntime`
  (`src/runtime/runtime.ts`).
- **Reset:** forgetting everything the current runtime remembers. Owner: `resetAll`
  (`src/runtime/reset.ts`).

### Internals

- **Scope:** the map behind a runtime, each module's state under its own key, carried by async
  context. Owner: `Scope`, `scoped`, `inScope`, `rootScope` (`src/core/scope.ts`).
- **Stateful functions:** the exports that read or write runtime state and become its methods.
  Owner: `STATEFUL` (`src/runtime/runtime.ts`).
- **Produced:** the flag set once a reply carried anything, after which it is never re-sent.
  Owner: `Produced` (`src/wire/stream.ts`).
- **Partial reply:** what a reply had said when it failed or stopped. Owner: `PartialTurn`,
  `InFlight`.
- **Answer (refusal reading):** one way of reading a refusal, which latches and returns a
  notice. Owner: `Answer`, `ANSWERS`, `flagsOf`.
- **Request builder:** the function `runTurn` calls for each send's body. Owner: `RequestBuilder`.
- **Calling:** the per-exchange state every turn's calls read and write. Owner: `Calling`
  (`src/run/run-calls.ts`).
- **Read and prepared call:** a call with its arguments parsed, then resolved to who answers it
  and its dedupe key. Owner: `ReadCall`, `Prepared`, `prepare`, `lookThrough`.
- **Turn outcome:** what a turn's calls came to: the call that ended the exchange, or the pending
  calls. Owner: `TurnOutcome`.
- **Standing:** a live view of the exchange, read when a failure is built. Owner: `Standing`.
- **Recorder:** the loop's own copy of the events it emitted, for its metrics. Owner: `recorder`.
- **Placeholder results:** what a call gets when the exchange stops during it, before it, or ends
  first. Owner: `STOPPED_CALL`, `UNRUN_CALL`, `ENDED_CALL`.
- **Proxied shortlist load:** a proxied preselection written as a `load_tools` call the model
  never made. Owner: `loadShortlist`.
- **Remote stretch:** the per-exchange part of remote-agent mode: progress asked for and
  forwarded, turn events held back, keys per turn. Owner: `remoteRun`, `SERVER_OWNED`.
- **Per-fetch cache:** a cache kept once for the global fetch and once per app function. Owner:
  `perFetch`.
- **Merge rules:** how layers combine: scalars by last layer, `extraBody` by key, prompt parts and
  hooks by id, tasks field by field, server scope whole. Owner: `mergeLayers`, `mergeModel`,
  `mergeById`, `resolveTasks`.
- **Report:** the errors and warnings a parse collects. Owner: `Report` (`src/spec/spec.ts`).

## Explain test

An app gives the loop a model server, a model and a transcript ending in a question, and that
starts an exchange. Each turn, the loop sends one request (continued if the length limit cut it
off): it builds the request body from what
the model server's and model's capabilities allow, negotiates past refusals (latching each one),
retries what was lost, and streams the reply back, scratchpad apart. If the reply asks for tools,
the dispatcher answers each call the package does not answer itself or hand back, one at a time
or in batches where `parallel` allows, deduped, one call per message where the model needs it, and
the results go into the transcript in the order asked. The next turn
follows, until the model answers, a tool's answer ends the exchange, calls are handed back and the
exchange waits for the app to resume it, or the turn budget runs out and it fails. Tools reach the
model eagerly, or from a catalogue through `load_tools` (or `call_tool` when proxied), after an
optional preselection. Hooks add injected context to the question's request. Before a turn,
pruning and compaction keep the exchange inside its context window, sized from the last reported
prompt; the token ledger records each request's size, so an app can price stretches of the
transcript.
Side tasks name, choose and summarise without risking the exchange, each sent as one request the
way a turn's is. Every turn reports events through `onEvent`, which the app files on the
bus under the run they belong to, which may hold several exchanges, and watchers read them and
metrics are built from them; a remote agent's server can supply those events in the loop's place.
A session is the conversation around many runs. An operator can write the agent as a document
whose layers resolve into the config, and a runtime keeps one tenant's caches and latches apart
from another's until reset.
