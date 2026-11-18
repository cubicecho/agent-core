# Coding standards ledger

Findings from the `coding-standards` skill's refactor workflow. This file lives at
`.agents/coding-standards-todos.md`. IDs are stable — don't renumber when items are removed.
`(unverified)` marks items inferred from docs or naming rather than confirmed in code.
Nothing here is implemented until approved.

The domain model these items argue from is `.agents/domain-model.md`. It replaced the model that
lived only in the descriptions of PRs #140 and #141. This file replaces `.agents/todos.md`, whose
record is carried over below: its IDs stand, and new items continue each sequence (M7, R23, T5,
D6, B7, A3).

At the 2026-11-18 Gate 1 the model changes were shown as M1–M5 and the candidate bugs as B1–B13.
They are filed here as M7–M11 and B7–B19, so they don't collide with the October items:

| Shown at the gate | Filed as |
|---|---|
| M1–M5 | M7–M11 |
| B1–B13 (repros) | B7–B19 |
| Q1, Q2 | B23, B24 |

Baseline, 2026-11-18 at `2ff19b8`: `npx biome ci .` clean, `tsc --noEmit` clean, 1063 tests in 47
files pass. No benchmark was recorded. The hot path is `streamTurn`, and `runSteps` per step.

## Summary

| Prefix | Kind |
|---|---|
| `M` | Model change: a change to `.agents/domain-model.md`, made true by the items that implement it |
| `R` | Refactor: same behavior, better shape |
| `T` | Test work |
| `D` | Comment or doc that no longer matches the code |
| `B` | Bug, or near copies that behave differently |
| `A` | Public API change; needs a decision |

| ID | Kind | What it does | Buys | Needs | Status |
|---|---|---|---|---|---|
| M7 | Model change | The wire folder holds only what is sent and comes back; the run's failure record and the dispatcher's contract move to the run folder. | Removes the one dependency pointing the wrong way, and leaves `tool-calls` one concept | — | done (its R items) |
| R23 | Refactor [pattern] | Move the loop's failure classes and `failedRun` out of the wire folder into a run module of their own. | M7 | T7 | done (`9b27cff`) |
| R24 | Refactor [pattern] | Move the types a dispatcher is handed and answers with (request, answer, result, artifact, log entry) out of the call-reading module into a run module. | M7 | — | done (`1f0b765`, `19f503a`, `d0233a2`) |
| R44 | Refactor [reuse] | Give the loop's two failure classes one way to copy the run onto themselves, not two ten-line copies. | M7; one copy to keep in step | R23, T7 | done (`5ad2b5b`) |
| M8 | Model change | The plain-text helpers for message text and fencing untrusted text get a browser-safe home below hooks, tools and context. | Context and tools stop loading the hook module, and its crypto import, for two string helpers | — | done (its R items) |
| R25 | Refactor [pattern] | Move `textOf`, `untrusted` and `UNTRUSTED_PREFACE` out of `hooks.ts` into a wire module. | M8 | — | done (`83bb6a7`) |
| M9 | Model change | The loop module owns the loop: tool-discovery choice moves to tools, session pinning to slots, cache diagnosis to the ledger, and the result is built in one place. | A 2081-line file loses four concepts that have folders of their own | — | done (its R items) |
| R26 | Refactor [pattern] | Move the choice of discovery mode and the preselection call from the loop into the tools folder. | M9 | — | done (`bd78ae8`, `67d8fd5`) |
| R27 | Refactor [pattern] | Move pinning a run's session to a llama.cpp slot from the loop into the slots module. | M9 | — | done (`708aa8a`) |
| R28 | Refactor [pattern] | Move the guess at why a prompt cache broke from the loop into the ledger module. | M9 | — | done (`c667e5d`) |
| R29 | Refactor [reuse] | Build the run's result in one function used by both a failure and a finished run. | M9; the field list can no longer drift between the two | T12 | done (`00e5856`) |
| M10 | Model change | Capability latches have one store and one way to write them: the no-thinking-hints latch joins the others, and continuation and side tasks latch through the capabilities module. | Four writers in three folders become one owner; snapshot and reset stop reaching into turn | B20 | done (its R items) |
| R30 | Refactor [pattern] | Keep the side-task "refused the no-thinking hints" latch with the other capabilities, leaving the snapshot JSON unchanged. | M10 | T10 | done (`51f9a2b`, `d544f2e`, `d8bd2b9`, `39eb7e9`) |
| R31 | Refactor [pattern] | Have continuation and side tasks latch a refusal through the capabilities module's functions instead of setting fields themselves. | M10 | R30, B20 | done (`9190551`) |
| M11 | Model change | One word per concept in prose and private names, the glossary's word; public names go to a decision. | Five names for the scratchpad, four for the window and three for each timeout become one each | — | in progress (R33; A3 deferred) |
| R32 | Refactor [readability] | Rename private names that clash with another concept: `stepOutcome`, and the local `isRecord` in run-calls that shadows the guard. | M11 | — | done (`a4e4c7a`) |
| R33 | Refactor [readability] | Use the glossary's word for the window, the scratchpad and compaction in doc comments and comments. | M11 | M11 | in progress |
| A3 | API change | Rename the public names that mean two things or differ between modules (`compact`, `firstTokenMs`, `timeoutMs`, `startInReasoning`/`startInside`), with deprecated aliases. | M11, public half | M11 | done (6.0.0: `0d3c247`, `41e4222`) |
| B7 | Bug | Make `notify` and `consult` truly never reject when the host's note callback throws, as their docs say. | A buggy callback can no longer fail a compaction or a run, or crash a host that fires and forgets | — | done (`4c974a6`) |
| B8 | Bug | Re-check a hook's inject and veto flags after layers merge, so a merged hook can't carry a flag its event can't use. | The resolved agent describes itself truthfully | — | done (`168e6ba`) |
| B9 | Bug | Make an empty prompt-part text delete the part from the resolved prompt list, its file or URL reference included. | An operator can remove an inherited prompt part | — | done (`2f2ff14`) |
| B10 | Bug | Let an empty id, name or description in an upper layer override the one below, as `""` is a value. | The "absent vs empty" rule holds for every field | — | done (`1632605`) |
| B11 | Bug | Apply the #222 rule when layers are resolved too, so a layer built in code or from stored columns can't override the temperature or ceiling through extra body fields. | #222 holds on every path, not only `parseSpec` | — | done (`a7109e1`) |
| B12 | Bug | Have the text-call recoverer skip every scratchpad fence, not only `<think>`. | A direct caller no longer runs a call the model was only deliberating about | — | done (`21b3266`) |
| B13 | Bug | Pair tool results with their calls by id in the run metrics, not by tool name. | Tool time is no longer inflated by a handed-back call's human wait | — | done (`68c3b8d`) |
| B14 | Bug | Have a slot allocator read the current pool on each call, not the array it was made with. | Two runs are never pinned to one slot after the server's slot count changes | — | done (`e7b668e`) |
| B15 | Bug | Keep a waiting run's event stream alive on the bus, or keep its numbering, so a resumed run's events are not discarded. | A handed-back run that waits longer than 30 minutes still shows its answer | — | done (`15023f2`) |
| B16 | Bug | Key the client pool on the normalised URL, as the listings are. | One client per server, not one per spelling of its URL | B24 | done (6.0.0: `82c50b3`) |
| B17 | Bug (question) | Decide whether two fetch functions behind one URL share capability latches, as they do today, or are kept apart, as their listings are. | One backend's refusal stops degrading the other, if they are apart | B24 | done (6.0.0: `82c50b3`) |
| B18 | Bug | Report a dropped extension field's path so that two different paths can't print the same. | An import report a host can key on | — | done (`f6656b7`) |
| B19 | Bug | Keep a turn's scratchpad in the order it arrived when it came both as a field and fenced in the text. | The replayed scratchpad matches what a watcher was streamed | — | done (`90a83b1`) |
| B20 | Bug (question) | Decide which of the two rules latches a refused reasoning effort, since negotiation and side tasks latch it differently. | One rule for one latch; needed before R31 | — | done (`64ed163`) |
| B21 | Bug (question) | Decide whether a served window should expire like the slot count read from the same answer. | A restarted server's new window is picked up, if they expire alike | — | done (6.0.0: `9beedba`) |
| B22 | Bug (question) | Decide whether negotiation should use the shared "refused request" test or keep reading every error by its text. | One definition of a refusal, if merged | — | done (6.0.0: `42a063e` (documented)) |
| B23 | Bug (question) | Decide who owns a run's outcome: today the loop decides it and the metrics decide it again from a `done` only the host sends. | One owner, and an outcome on the events that agrees with the result | — | done (6.0.0: `9e7991d`, `e1bd44d`) |
| B24 | Bug (question) | Decide what "one endpoint" means across the caches; five caches key it five ways today. | One identity rule; settles B16 and B17 | — | done (6.0.0: `82c50b3`) |
| B25 | Bug (question) | Decide whether calls that end the run first, stop or never run are told to the host's callbacks and events, or the docs stop saying "every call". | Callbacks and docs that agree | — | answered: documented as it is (D9) |
| D6 | Docs | Bring `docs/agent-spec.md` up to date: it says nothing is implemented, lists answered questions, and has wrong counts, fields and line references. | A spec doc that describes the code | — | done (`f4f8b4a`) |
| D7 | Docs | Fix comments that are no longer true: test paths, counts, keying claims, history that no longer describes the code. | Comments a reader can trust | — | done (`d9794a8`, `c091ce4`) |
| D8 | Docs | Fix lead sentences that `llms.txt` publishes wrongly, attach the orphaned doc comment, and give `CallIds` its own doc. | The published index says what each export is | — | done (`afbfda0`, `cc33955`) |
| D9 | Docs | Say in the option docs where behaviour is narrower than "every": one-call-per-message turning parallel off, a remote agent ignoring `callIds`, dedupe keying on normalised arguments. | Options say what they do | — | done (`9007db3`) |
| D10 | Docs | Add `remote` to AGENTS.md's run row, and point AGENTS.md to the glossary in `.agents/domain-model.md`. | The layout table is complete; the terms have one home | — | done (`663dee0`) |
| R34 | Refactor [sweep] | Apply P6/P7: merge four duplicated helpers (clip text to a token budget, `absent`, "listing still fresh", the pruned-result marker). | Sweep; one copy each, and pruning can't silently re-prune after a wording change | — | done (`531d50d`, `eadb553`, `96e3864`, `d57384b`, `41f6640`) |
| R35 | Refactor [reuse] | Merge three spellings of "a positive finite number". | One check | — | done (`895cd98`) |
| R36 | Refactor [reuse] | Write the `load_tools` parameter schema once for the on-demand and proxied tools. | One schema to change | — | done (`213a608`) |
| R37 | Refactor [simplify] | Stop exporting module-level names only their own module reads. | A smaller internal surface | — | done (`8bea2db`) |
| R38 | Refactor [readability] | Replace a `map` with a side effect, and two `forEach` pushes, with loops. | P13 one-offs | — | done (`a9fd8c2`) |
| R39 | Refactor [readability] | Pick a run's outcome from its finish reason, and a hook setting's validator, from lookup tables. | P24 | — | done (`0acc178`) |
| R40 | Refactor [readability] | Remove the one source type assertion that has a fix in the types. | P17 | — | done (`0a7b7ff`) |
| R41 | Refactor [sweep] | Apply P14: derive the spec parser's closed-set checks from the vocabularies, and one list in the token breakdown. | Sweep; a new discovery mode or replay value is no longer dropped silently | — | done (`d78d3a6`) |
| R42 | Refactor [sweep] | Apply P1/P20 to the 64 conditions that really take reading: clock arithmetic, three or more clauses, and inline `=== false`. | Sweep | — | done (6.0.0: `80d2145`, `05d27b2`, `091e1c8`, `8ff298e`, `e564ba2`, `99de66c`) |
| R43 | Refactor [sweep] | Apply P19, worst first: the 38 doc blocks of seven or more sentences and the 16 `//` runs of five lines or more. | Sweep | — | done (6.0.0: `92c40e2`, `6511708`, `4333781`, `5e4923c`, `ec5be16`, `6a47470`) |
| T5 | Test [readability] | Type the 19 untyped SDK mocks, so about 45 casts in the tests go. | Fakes typed as what they stand in for | — | done (`e4f22f1`, `e0c6885`, `4fd07a9`) |
| T6 | Test [pin] | Give `scope.ts` and `config.ts` tests of their own. | Pins per-scope state and settings before M10 | — | done (`db97208`) |
| T7 | Test [pin] | Add a test file for the loop's failure classes and `failedRun`. | Pins them before R23 and R44 move them | — | done (`f2460fb`) |
| T8 | Test [pin] | Add a slots case to the reset test, and a drift test that every per-scope store has a reset and a runtime method. | A new store can't be left out of `resetAll` | — | done (`a089711`) |
| T9 | Test [pin] | Test `refusesRequest` and `isModelLoading`. | Pins two retry predicates before B22 | — | done (`eb14d41`) |
| T10 | Test [pin] | Pin the capability snapshot's JSON byte for byte, hints included. | R30 provably leaves the stored format alone | — | done (`5048de8`) |
| T12 | Test [pin] | Pin that a failure and a finished run carry the same run fields. | R29 provably changes nothing | — | done (`498717d`) |
| A4 | API change | Export `OnNotice` and `EndpointIdentity`, which public signatures already use. | Hosts can name the types they pass | — | done (`d522ecd`) |
| A5 | API change | Gather the tunables into one defaults module, internal ones first, host-imported ones as a separate decision. | P22; one place answers "what can be tuned" | — | approved (6.0.0, in progress) |
| A6 | API change | Retire the deprecated usage aliases and the deprecated hook `events` option (breaking). | P25; one name per count | — | done (`4593a50`) |
| A7 | API change | Stop exporting `AGENT_TASKS`, `PRESELECT_SYSTEM`, `requestIndex` and `SPEC_EVENTS`. | A smaller surface, if nobody relies on them | — | declined |
| A9 | API change (breaking, 5.0.0) | Rename the hook events `beforeTurn`/`afterTurn` to `beforeExchange`/`afterExchange`. | The one place "turn" meant an exchange | M11 | done (`79d61c8`) |
| A10 | API change (breaking, 5.0.0) | Rename everything that calls a turn a "step" to "turn": `beforeStep`, `StepWindow`, the `step` numbers on `AgentLoopRequest`, `beforeStep`, `onMessage` and `ArtifactFrom`. | Turn is the only word for one model reply and its tools | A9 | done (`4582bd6`) |
| A11 | API change (breaking, 5.0.0) | Name the events that mark exchanges inside a run after exchanges: `RunEventKind.Step`, `RunEvent.step` and `RunMetrics.steps`. | "Step" leaves the vocabulary entirely | A10 | done (`7f5bd1d`) |
| A12 | API change (breaking, 5.0.0; to decide) | Rename the public names that call an exchange a "run": `RunOutcome` on a loop result, and the outcome docs. | The code says exchange where the model does | A11, B23 | done (6.0.0: `e1bd44d`) |
| A8 | API change | Export the list of body fields a document may not set through extra body, so a host can apply #222 itself. | Hosts that build layers in code can follow the rule | B11 | declined (B11 covers documents; see B35) |
| B28 | Bug | Make `gather` survive an `onNote` that throws, as `notify` and `consult` now do. | One rule for every hook firing | — | done (6.0.0: `a49c6f7`) |
| B29 | Bug | Stop `assignSettings` writing keys that are not settings (`configureEvents({ bogus: 5 })` keeps `bogus` through a reset). | Settings hold only settings | — | done (6.0.0: `39d27d1`) |
| B30 | Bug | `recoverToolCalls` finds the fence in the lower-cased text and slices the original, which shifts on characters like `İ`; an unclosed fence is still searched. | Recovery never reads inside a scratchpad | — | done (6.0.0: `5f47709`) |
| B31 | Bug (question) | A lone fence close that moves earlier answer text into the scratchpad lands after field reasoning that arrived in between (B19 edge). | Arrival order in every case | — | done (6.0.0: `66f5ae9` (documented)) |
| B32 | Bug (question) | `parsePrompt` takes a part with both `text` and `ref`, and nothing says which wins; `text: ""` beside a `ref` deletes it. | One meaning per prompt part | — | done (6.0.0: `41aeb32`) |
| B33 | Bug · low value | A task key holding a dot reads ambiguously in `parseSpec`'s warnings (`dropped` now quotes it). | One path format | — | done (6.0.0: `0b130bb`) |
| B34 | Bug (question) | The remote-agent notice does not name `callIds` or `recoverToolCalls`, which it also sets aside. | The notice says everything it ignores | — | done (6.0.0: `f9d9c22`) |
| B35 | Bug (question) | An app can still put spelled or reserved fields into `ResolvedAgent.extraBody` after resolving; only `buildBody`'s reserved filter guards the request. | #222 holds past resolution | A8 | closed: by design (an app may override after resolving) |
| B36 | Bug (question) | After B20 a side task still retries once without the hints and the effort, so an effort the retry got past is sent again next time. Should the effort-only retry go? | One rule for a refused effort | — | done (6.0.0: `2ad1631`, `33595ed`, `86264e9`, `9189098`, `ab8e380`) |
| B37 | Bug (question) | A hook's veto is never honoured inside the loop: its own compaction does not pass `honourVeto` (`agent-loop.ts` ~1087), and `AgentLoopHooks` has no option for it. Should the loop honour a veto? | Hooks that can stop a summary do, wherever it runs | — | done (6.0.0: `1d7a346`) |
| A13 | API change (breaking) | Rename `AgentLoopResult.afterTurn`, which holds the `afterExchange` notes, to `afterExchange`. | The result says what the hooks are named | A9 | done (6.0.0: `c440a67`) |
| A14 | API change | Export `renamedEvent` (and `LEGACY_HOOK_EVENTS`) so apps that read stored 4.x events or documents themselves, like task_server's run stream and ai-router's timeline, use the same mapping. | One reading of old data | A9, A11 | done (6.0.0: `39e87c7`, `18e115c`) |
| B38 | Bug (question) | The text the model and watchers are sent still uses the old words: "your next step" in the tool-loading prompts, "the run stopped/ended first" in the placeholder results, "No tool call in this run", the `wait` notice's "host", `pruneNotice`'s "window" and "fold", and `record_artifact`'s "this run". Changing what models are sent needs a decision. | Model-facing text in the glossary's words | — | done (6.0.0: `eb680a4`) |
| B39 | Bug | Across layers, a prompt part with only a `ref` above one with only `text` resolves to a part with both (`resolveAgentSpec` merges `{ ...below, ...above }`); B32 fixed it within one document only. | One meaning per prompt part, layered too | B32 | open |
| B40 | Bug · low value | A dotted `extraBody` key is written unquoted in warning paths (`${path}.${key}`), unlike task keys since B33. | One path format | B33 | open |
| R49 | Refactor [simplify] | `ModelCapabilities.thinkingHints` is written only by importing a pre-6.0.0 snapshot, since the hints latch as a refused field; under A14's decision (no old-data handling) it and its snapshot field go. | No flag kept only for old data | B36 | approved (6.0.0) |
| R47 | Refactor [pattern] | Have `importCapabilities` latch through `latchModel`/`latchFields`, the last writer M10 left. | One writer for the latches | — | done (6.0.0: `dd8e5d2`) |
| R48 | Refactor [simplify] | Stop exporting `StepCalls`, which only `run-calls.ts` reads (R37's list missed it). | The module surface | — | done (6.0.0: `de2629e`) |
| T13 | Test [readability] | Narrow the SDK unions in tests without casts (`as OpenAI.ChatCompletionFunctionTool`, `.content as string`). | P17 in tests | — | done (6.0.0: `c310e96`) |
| T14 | Test [consistency] | `tests/turn/side-task-settings.test.ts` drives the whole loop and imports `run/`; move it to `tests/run/`. | The layout rule | — | done (6.0.0: `1793b04`) |
| D12 | Docs · low value | Start `discoverTools`'s doc with a verb. | A doc that matches its name | — | done (6.0.0: `1c0f691`) |
| R45 | Refactor [readability] · low value | Rename the private `positive` wrapper and fold `Capabilities.since`'s speculative remark. | Small | — | declined (low value) |
| R46 | Refactor [consistency] · low value | Write the `'*'` wildcard, the URL schemes and the redirect type as named words. | P16 one-offs | — | declined (low value) |
| D11 | Docs · low value | Have the README's module table point to the glossary for terms. | One home for terms | D10 | declined (low value) |
| T11 | Test [consistency] · low value | Move the test of negotiation over a streamed turn out of a file named for a module that does not exist. | The one-test-per-module layout | — | declined (low value) |
| B26 | Bug (question) · low value | Decide whether the loop's `userText` and the hooks' `textOf`, which join text and refusals differently, should agree. | One definition of a message's text | M8 | declined (low value) |
| B27 | Bug · low value (unverified) | Stop formatting a loading wait of 1000 seconds or more as "1.0ks". | A readable notice | — | declined (low value) |

Status is `open`, `proposed` (an `M` item awaiting Gate 1), `approved`, `deferred`, `declined` or `done`.
Gate 2 (2026-11-18) approved the recommended set; PR 1 carries the non-breaking items, PR 2 the 5.0.0 renames.
The open questions were then walked through with the user one by one (2026-11-18); every answer
is built in 6.0.0, and the item rows say how each was settled.

## Model changes

Changes to the domain model, `.agents/domain-model.md`, agreed or declined at Gate 1. The
domain model describes the code as it is, so a change waits here until the commit that makes it
true writes it into that file. Declined items stay, marked declined, so they aren't proposed
again.

M1–M6 (2026-10-01) are done; their record is under Refactoring.

### M7 — Move the run's failure record and the dispatcher contract out of `wire/`

As-is: `wire/errors.ts` holds `errorMessage` (used by six folders) beside `AgentLoopFailure`,
`AgentLoopError`, `AgentLoopOverflow`, `ToolIterationLimit` and `failedRun`, which only
`run/agent-loop.ts` builds. It imports `TokenLedger` from `context/`, the one dependency in the
package that points upward. `wire/tool-calls.ts` holds two concepts: reading calls out of a reply
(lines 1–527), and the contract between the loop and a dispatcher (528–781: `ToolCallRequest`,
`ToolCallOutcome`, `ToolCallResult`, `ResourceLink`, `ToolAnswer`, `EndedBy`, `ServerLogLevel`,
`ServerLogEntry`, `ToolCallReport`, `ArtifactSource`, `ArtifactAction`, `RunArtifact`). Only `run/`
uses those.
To-be: `wire/` is what is sent and what comes back. The failure record is a run module, and so is
the dispatcher contract. `errorMessage` stays in `wire/errors.ts`. Every export stays at the
package root under the same name.
Why it is simpler: every dependency points downward, and each module holds one concept.
Implemented by: R23, R24, R44. Status: done (2026-11-18): R23, R24 (with ResourceLink and ServerLogLevel, `19f503a`), R44.

### M8 — Give the message-text and untrusted-fence helpers a browser-safe home

As-is: `textOf`, `untrusted` and `UNTRUSTED_PREFACE` live in `hooks/hooks.ts` (365–456), which
imports `core/digest` (`node:crypto`). `context/compaction`, `run/request-body`, `run/agent-loop`
and `tools/instructions` load the hook module for them alone.
To-be: they live in a wire module, beside the message vocabulary they read, with no crypto
import. `hooks.ts` keeps firing hooks.
Why it is simpler: a string helper's users stop depending on hook firing, and the hook module is
one concept. Implemented by: R25. Status: done (2026-11-18).

### M9 — The loop module owns the loop

As-is: `run/agent-loop.ts` is 2081 lines. Beside the loop it owns:
- choosing the discovery mode and running preselection (`discovery`, 1420; `chooseTools`, 1123);
- pinning a session to a slot (`pinSession`, 1054–1122);
- diagnosing a cache break (`cacheDiagnosis`, 905–920);
- building the result twice, in `standing.read` (1002–) and in the return object (2053–2076),
  each listing the same fields.
To-be: discovery belongs to `tools/`, pinning to `endpoint/slots`, and cache diagnosis to
`context/ledger`. One builder makes the result for a failure and for a finished run.
Why it is simpler: each concept sits in the folder AGENTS.md names for it, and the result's fields
are written once. Implemented by: R26, R27, R28, R29. Status: done (2026-11-18); `discovery` became `discoverTools` (`67d8fd5`).

### M10 — Capability latches have one store and one writer

As-is: `ModelCapabilities` is written by `negotiate` (`endpoint/capabilities.ts`), `continueTurn`
(`turn/continuation.ts:101,316,328`), side-task `complete` (`turn/side-task.ts:341`) and
`runtime/snapshot.ts`. The no-thinking-hints latch is a separate `scoped` set in
`turn/side-task.ts:63`, so `runtime/reset.ts:7` and `runtime/snapshot.ts:10` import from `turn/`.
`reasoningEffort` is latched by two different rules (B20).
To-be: every capability, the hints latch included, lives in the capabilities store in
`endpoint/`, and the other modules latch through its functions. The snapshot JSON keeps its
shape.
Why it is simpler: one owner per piece of state ("Two writers" in modeling.md).
Implemented by: R30, R31. Needs: B20 answered, T10. Status: done (2026-11-18), B20 answered: negotiation's rule. `importCapabilities` still writes the latches itself (R47).

### M11 — One word per concept

As-is:
- The scratchpad goes by reasoning, thinking, scratchpad and deliberation.
- The window goes by `contextLength`, `contextLimit`, `limit`, `window` and n_ctx.
- Each wait has three names: `requestTimeoutSeconds`/`timeoutMs`/`idleMs`,
  `firstTokenSeconds`/`firstTokenMs`/`firstChunkMs`, and `loadingTimeoutSeconds`/`loadingMs`/
  `loadingTimeoutMs`.
- `firstTokenMs` is both an allowance (`endpoint/client.ts:234`) and a measurement
  (`TurnUsage.firstTokenMs`, `wire/stream.ts:107`).
- `compact` formats a number (`wire/tokens.ts:49`), next to compaction.
- `stepOutcome` returns a `RunOutcome`, not a `StepOutcome`.
- `run-calls.ts:1102` declares a local `isRecord` meaning "a record call", which shadows the
  guard `isRecord`.
To-be: prose and private names use the glossary's word; public names change only through A3
(P27). Settled with the user at Gate 1 (2026-11-18): the levels are **Session > Run > Exchange >
Turn**. A run is a whole job under one `runId`, an exchange is one input to its reply (one
`runAgentLoop` call), and a turn is one model reply plus running its tools. "Step" leaves the
vocabulary: the user approved a breaking 5.0.0 for A9–A11 in this pass.
Why it is simpler: a reader meets one name per idea. Implemented by: R32, R33, A3. Status:
proposed.

---

## Conventions

The canonical way this codebase does things. New code and refactors follow these.

- Missing lookups and failures: throw with a teaching message; error classes declare
  `override readonly name = "..."`
- Events: one bus in `events.ts`; run events are plain tagged objects
- Per-scope state: a `scoped()` store in the module that owns the concept, listed in
  `runtime.ts` `STATEFUL` and cleared through `reset.ts` `resetAll`
- Shared helpers live in: `guards.ts` (predicates and small value helpers, no imports),
  `retry.ts` (what an error is: transient, a refusal, an abort), `tokens.ts` (sizing), `scope.ts`
  (per-scope stores)
- Sorting: `byCodeUnit` wherever the order is relied on
- Test helpers live in: `tests/helpers.ts` once a second file needs one, and `tests/refusals.ts`
  for refusals built on the SDK; `bench/fixtures.ts` for the bench
- Test layout: `describe` named for the export, `it` for each case, verb first; a test lives in
  the file of the module that owns the code, in the same folder under `tests/`
- Source layout: one folder per concept (AGENTS.md's table); `src/index.ts` is the only file that
  re-exports
- Generated files and the command that rebuilds them: `llms.txt` → `npm run build` (CI checks
  it with `git diff --exit-code -- llms.txt`)
- Docs: `docs-comments.md` in the `cubicecho_typescript` skill; AGENTS.md adds only that the
  first sentence stands alone, because `llms.txt` takes it verbatim
- Code style: the `cubicecho_typescript` skill and the `coding-standards` skill's preferences
  P1–P28
- Domain terms: `.agents/domain-model.md`
- `CHANGELOG.md` and the `package.json` version belong to semantic-release

## Refactoring

### Record, 2026-10-01 and 2026-10-02

Approved 2026-10-01: M1–M6, R1–R10, D1, and the sweeps R11–R14. All done; one commit each.

| ID | What | Commit |
| --- | --- | --- |
| R1 | one get-or-create helper for Maps (`getOrCreate` in `guards.ts`) | `dd00948` |
| R2 | one non-mutating way to add two usages | `b12daa4` |
| R3 | seconds to milliseconds in one place | `108b9a0` |
| R4 | `ToolArgumentsError` names itself like the other errors; `Turn.toolCalls` is `ToolCall[]` | `7d90ec9` |
| R5 | `tool-calls.ts` uses `THINK_FENCE` | `eeb0ae0` |
| R6 | one list of reserved body keys | `d6efae0` |
| R7 | a named blank-line separator in `tool-loading.ts` | `6262e5a` |
| R8 | named callback types for notices and notes; a named options type for `preselect` | `c3bf27c` |
| R9 | one fallback label for an unnamed model | `51d8ad5` |
| R10 | long functions split where a piece earned a name | `72be9a2`, `b5cdc58`, `e40f59c`, `bb32c3c`, `62a3549`, `06d909c` |
| R11 | P8 — parameters are not written into | `d471f02`, `058d840` |
| R12 | P13 — plain loops where a chain hid a side effect or a long body | `a51a857` |
| R13 | P1 — conditions that took reading are named | `fd403d7` |
| R14 | P4 — `@returns` where the lead sentence did not say it | `74c71e0` |
| M1–M6 | the model's moves (see PR #140) | `d5a9a1b`, `56e9487`, `327555a`, `614c95c`, `916b809`, `ea637ff` |
| D1 | `config.ts` comment no longer true | `268532f` |

Approved 2026-10-02: R15–R22, D3, D4. All done.

| ID | What | Commit |
| --- | --- | --- |
| R21 | `biome.json` on the house baseline: single quotes, width 120, the rest of the lint rules | `13c72db`, `af7ffb0` |
| R15 | P15 — every conditional and loop body is a braced block | `b244b2d` |
| R22 | scripts named `check`, `check:biome`, `check:types` | `932c699` |
| R16 | P4 — `@param name - text`, and no default in a description | `268db26` |
| D3 | doc prose under `@remarks`, after the tags; a blank line after the summary; member defaults as `@defaultValue` | `ade1071`, `d2a71d4`, `a69f1e1` |
| R17 | P16 — magic values named; `wire.ts` and `platform.ts`; vocabularies exported; `noMagicNumbers` on | `9f1313d`, `01726ec` |
| R18 | P17 — type-level assertions replaced by types | `b79f82a` |
| R20 | nested ternaries become `if` blocks | `cde3733` |
| R19 | P13 — a loop that only pushes is a `map`; a large callback has a name | `5fffcfc` |
| D4 | every module-level function and method has `@param` and `@returns` (294 of 294) | `adb1bee` |

Answers given at the 2026-10-02 gate, which the items follow (all recorded in the skills):

- Doc prose that says why goes under `@remarks`, after the tags, with a blank line after the
  summary too. File-level comments stay as paragraphs.
- Every module-level function and every method, private ones too, has a doc block with
  `@param` and `@returns`. A closure inside a function body does not need one.
- A member's default is a `@defaultValue` tag on the member's own block, and a sentence that
  only explains the default is cut. A parameter's default is the signature's.
- A member of a union is named even though the compiler checks it, where it is built as well as
  where it is compared. Three or more members in use: one `as const` object and the type derived
  from it. One or two: flat constants.
- Wire and platform words are named in one module each, exported for hosts (`feat`), and tests
  use the names.
- Numbers that come as a set: each member is its own constant, and the set is built from them.
- Stay inline: `typeof` answers, checks against empty, a grammar's punctuation, property keys,
  text written for a reader unless it is reused, and a default written in a signature.
- A regex match is destructured rather than indexed.
- Assertions on an untyped reply stay. Only the ones with a fix in the types go.

#### Left as they are, and why

- **R10** — `watching` (`events.ts`), the body of one step in `runSteps` and the bulk of
  `complete` stay whole: every piece that could be cut out needs most of the function's locals.
- **R11** — these write into an argument on purpose and say so in their name or their doc:
  `getOrCreate`, `assignSettings`, `latchInto`, `collectRefs(node, into)`, `#emitInto`; the
  capability answers `negotiate` latches; the `Calling` a run's calls read and write back into
  (`run-calls.ts`); the `Produced` box and the `Standing` read (documented out-parameters); the
  bus's own `held.sweeping`. `Object.assign(turn.usage, …)` in `runTurn` and `runSteps` writes
  to a local the function just received and owns.
- **R12** — chains that are one transformation each stay chains: the `map`/`filter`/`join`
  renderers, the sums by `reduce`, and `flatMap` used as filter-and-map.
- **R13** — `compaction.ts:397` and `spec.ts:521` keep their inline tests, which are what
  narrows the types below them and already read as the sentence the error message says.
- **R14** — everything else on the public surface leads with a noun phrase that is the return
  value, which AGENTS.md says not to restate.
- **R17** — a literal inside a named table (`EFFORT_LADDER`, `AGENT_TASKS`, the schema-keyword
  tables, `TIMINGS`, `DEFAULTS`, `RESOLVED_DEFAULTS`, `PLAUSIBLE`) is named by the table and its
  key. Spec field paths and `tryAsk` labels are reader text. The hook `status` union has two
  members in use and stays a type. `HttpStatus`, `platform.ts` and `digest.ts` are internal.
- **R18** — casts on an untyped reply (`client.ts`, `retry.ts`, `stream.ts`, `tokens.ts`,
  `snapshot.ts`, `tool-loading.ts`, `side-task.ts`); the key type `Object.keys` and
  `Object.entries` lose (`capabilities.ts`, `scope.ts`, `spec.ts` `mergeModel`, `runtime.ts`);
  `as OpenAI.ReasoningEffort` in `request-body.ts`; body fields the SDK type lacks in
  `side-task.ts`; `taskCall`'s `{ ...options, ...stated } as Options`, which the compiler will
  not take without; the one assertion inside `kept` in `spec.ts`. `schema-compat.ts`
  `schema[key] as Schema` went with B4.
- **R19** — loops that do more than one thing per pass (`hooks.ts`, `ledger.ts`,
  `tool-calls.ts`) and two-line block lambdas.

### Survey, 2026-11-18

Surveyed after #222–#229 merged, against the preferences as they stand (P1–P28). Not re-filed:
what the record above left on purpose. In src, 40 of the 41 type assertions fall in R18's kept
categories, or are newer ones of the same kind (`columns.ts:340,357,368,375`,
`remote.ts:109,112,130,133`). None of the 27 writes to a parameter is new (R11). P5 has no hits.

### R23 [pattern] — Move function: the loop's failure record into `run/`

**File:** `src/wire/errors.ts:29-193` (`AgentLoopFailure`, `AgentLoopError`, `ToolIterationLimit`,
`AgentLoopOverflow`, `failedRun`). Only `src/run/agent-loop.ts:77` imports them. The other six
importers (`hooks.ts`, `run-calls.ts`, `capabilities.ts`, `run-turn.ts`, `continuation.ts`,
`side-task.ts`) take `errorMessage` alone. Target: `src/run/failure.ts`. `wire/errors.ts` keeps
`errorMessage` (lines 1–28), and the `context/ledger` import moves with the record.
`src/index.ts` re-exports from the new path; `llms.txt` regroups under `run`. Implements: M7.
Buys: removes the wire → context import. Needs: T7.

### R24 [pattern] — Move function: the dispatcher contract into `run/`

**File:** `src/wire/tool-calls.ts:528-781`. These types are imported only by `run/agent-loop.ts`,
`run/run-calls.ts`, `run/artifacts.ts`, `run/events.ts`, `wire/errors.ts` (which moves with R23)
and `index.ts`. Target: `src/run/dispatch.ts` ("what a dispatcher is handed and answers with").
`ToolCall` and the parsers stay in `wire/tool-calls.ts`. The docs at `tool-calls.ts:568-571`
(`ToolCallOutcome.id`, stale) are fixed in D7, not here. Implements: M7. Buys: `tool-calls.ts` is
one concept. Needs: — (types only; `tsc` is the check).

### R44 [reuse] — Consolidate to one owner: the two failure constructors

**File:** `src/wire/errors.ts:106-122` and `:162-178`. `AgentLoopError` and `AgentLoopOverflow`
copy the same ten fields in the same order. One `assignRun(this, run)` helper, documented as
in-place (R11's rule), serves both. The two classes stay separate: `AgentLoopOverflow` has to stay
a `ContextOverflow`. Implements: M7. Buys: one copy to keep in step as `AgentLoopFailure` grows
(it grew `artifacts`, `ledger` and `remoteRunId`). Needs: R23, T7.

### R25 [pattern] — Move function: `textOf`, `untrusted`, `UNTRUSTED_PREFACE`

**File:** `src/hooks/hooks.ts:365-456`. Users: `context/compaction.ts`, `run/request-body.ts`,
`run/agent-loop.ts` and `tools/instructions.ts`. Target: `src/wire/text.ts`, which has no
`core/digest` import. `turnMessages`/`turnIndex` stay with hooks: they number a transcript for a
hook, and digest each turn. Implements: M8. Buys: context and tools stop loading the hook module.
Needs: —.

### R26 [pattern] — Move function: discovery and preselection out of the loop

**File:** `src/run/agent-loop.ts:1420-` (`discovery`) and `:1123-` (`chooseTools`). These decide
the mode, the eager fallback when the catalogue is empty, and the shortlist merge. Target:
`src/tools/discovery.ts`, taking the options it reads, not `AgentLoopOptions` whole (unverified:
how many fields; `tools/` must not import `run/`). Implements: M9. Buys: the tools folder owns
discovery, which the glossary puts there. Needs: —; the loop's discovery tests cover it.

### R27 [pattern] — Move function: `pinSession` into `endpoint/slots`

**File:** `src/run/agent-loop.ts:1054-1122`. It reads `servedSlots` and `slotAllocator`, and sets
`SESSION_HEADER` (`src/endpoint/slots.ts:22`). Target: `src/endpoint/slots.ts`. The remote-agent
check stays a parameter the loop passes. Implements: M9. Buys: slot pinning lives with slots.
Needs: —; `tests/run/agent-loop-session.test.ts`.

### R28 [pattern] — Move function: `cacheDiagnosis` into `context/ledger`

**File:** `src/run/agent-loop.ts:905-920`. It compares two `RequestShape`s with `breakReason`,
which the ledger already owns. Target: `src/context/ledger.ts`. Implements: M9. Buys: cache
diagnosis is beside `breakReason`. Needs: —.

### R29 [reuse] — Consolidate to one owner: the run's result

**File:** `src/run/agent-loop.ts:1002-` (`standing.read`) and `:2053-2076` (the return). Both list
`messages`, `usage`, `toolCalls`, `artifacts`, `loaded: proxied ? [] : [...loaded]`, `used`,
`preselected`, `ledger` and `remoteRunOf(remote)`. One `runSoFar()` builds them, and the return
adds `turn`, `ended`/`pending`, `notes`, `context`, `preface`, `afterTurn` and `metrics`.
Implements: M9. Buys: the two lists can't drift. Needs: T12.

### R30 [pattern] — Consolidate to one owner: the no-thinking-hints latch

**File:** `src/turn/side-task.ts:63` (`noHints`), `src/runtime/snapshot.ts:10,178-179`,
`src/runtime/reset.ts:7`. Target: a field on the model's entry in the capabilities store,
written through `endpoint/capabilities.ts`. `exportCapabilities` keeps writing
`ModelSnapshot.thinkingHints` as today. Implements: M10. Buys: snapshot and reset stop importing
from `turn/`, and `snapshot.ts:179` stops parsing `modelKey`'s JSON tuple. Needs: T10.

### R31 [pattern] — Consolidate to one owner: latching from continuation and side tasks

**File:** `src/turn/continuation.ts:96-104,316,328` (`refusePrefillFields`, `assistantPrefill`)
and `src/turn/side-task.ts:316-343`. Target: each calls a named latch function exported from
`capabilities.ts` (`latchModel(…)`) instead of writing `ModelCapabilities` fields. Implements: M10.
Buys: one writer. Needs: R30, and B20 answered (two rules for `reasoningEffort`).

### R32 [readability] — Rename: private names that clash

**File:** `src/run/agent-loop.ts:1592` `stepOutcome` → `runOutcome`, since it returns a
`RunOutcome`, not a `StepOutcome`. `src/run/run-calls.ts:1102` local `isRecord` → `isRecordCall`,
since it shadows the guard imported at `:3`. Implements: M11. Buys: one name, one concept. Needs: —.

### R33 [readability] — Rename in prose: the glossary's words

**File:** doc comments and `//` comments across `src/`. The window is "context window", the
scratchpad is "scratchpad", and compaction is "compaction" ("fold" stays only as the glossary's
alias). No identifiers change. Implements: M11. Buys: a reader meets one word. Needs: M11 approved.
Size: grep before starting (unverified).

### R34 [sweep] — apply P6/P7 across src

Fixing P6/P7, "promote to a shared helper at two uses; extract when the name reads better than
the code". Four ideas, each written more than once:
- **Clip text to a token budget.** `hooks.ts:306` and `instructions.ts:93` are identical:
  ``${text.slice(0, cap * CHARS_PER_TOKEN - 1).trimEnd()}…``. Target: `clipToTokens` in
  `wire/tokens.ts`.
- **`absent`.** Defined at `spec.ts:335` and `columns.ts:205` (only the second is a type guard),
  and written out at `tool-calls.ts:179` and `stream.ts:399`. Target: the guard form in
  `core/guards.ts`. `spec.ts` must stay browser-loadable, and `guards.ts` is.
- **"The listing answer is still fresh".** `client.ts:665,737,1024`, each
  `Date.now() - X.at < poolLimits().listingMissMs`. Target: a private `isListingFresh(at)`.
- **Tool-result kinds recognised by text.**
  - The pruned stub is written at `compaction.ts:237` (`[result cleared, N chars]`) and tested
    with a separate literal at `:226`.
  - The proxied load's regex `PROXY_LOADED` (`tool-loading.ts:563`) must match the template at
    `:642`.
  - Target: one named prefix each, beside its writer, as `SUMMARY_LEAD` already is.

```
hits - 13 (the survey's 11, plus the two halves of the proxied-load prefix)
-- files --
src/endpoint/client.ts (3)
src/context/compaction.ts (2)
src/tools/tool-loading.ts (2)
src/hooks/hooks.ts (1)
src/tools/instructions.ts (1)
src/spec/spec.ts (1)
src/spec/columns.ts (1)
src/wire/tool-calls.ts (1)
src/wire/stream.ts (1)
```

(unverified) `run-calls.ts:70` `preview` marks a cut (`… (N chars)`), while
`tool-calls.ts:193,199,200` and `tool-loading.ts:696` cut at `ARGUMENT_PREVIEW_CHARS` without a
mark. Whether that is intended is a near-copy question, not part of this sweep.

### R35 [reuse] — Consolidate to one owner: "a positive finite number"

**File:** `src/core/guards.ts:32` (`isPositive`), `src/wire/tokens.ts:126` (`divisor`),
`src/endpoint/client.ts:317` (`positive`, a wrapper over `isPositive`). Target: `isPositive`
everywhere; check `divisor`'s fallback first. Buys: one check. Needs: —.

### R36 [reuse] — Consolidate to one owner: the `load_tools` parameter schema

**File:** `src/tools/tool-loading.ts:56-67` (`LOAD_TOOLS_DEFINITION.parameters`) and `:496-507`
(`PROXY_TOOLS[0].parameters`), identical literals. `catalogPrompt` (`:116-133`) and
`proxyCatalogPrompt` (`:545-560`) share their structure and differ only in their instruction
text; leave those two. Buys: one schema to change. Needs: —.

### R37 [simplify] — Delete dead code: exports only their own module reads

**File:** `src/endpoint/client.ts:225` `FIRST_TOKEN_FACTOR` (exported, not in `index.ts`, read
only in `client.ts`); `src/endpoint/capabilities.ts:151` `ModelFlag`; `src/turn/continuation.ts`
`isContinuable` (a module export since A1 made it private at the root); `src/run/run-calls.ts:128`
`ReadCall` and `:782` `HandedBack`; `src/run/remote.ts:180,196` `RemoteRunOptions` and
`RemoteRun`; `src/wire/wire.ts:123` `HttpStatus.Ok` (no reader). None is in `index.ts`, so nothing
public changes. Buys: the module surface says what other modules use. Needs: —.

### R38 [readability] — P13 one-offs

**File:** `src/wire/call-ids.ts:166`, a `map` that adds to `taken` as it goes (R12's reason for a
loop); `src/run/artifacts.ts:376,378`, `forEach` pushes inside a recursive walk. Target: `for…of`
loops. Buys: P13. Needs: —.

### R39 [readability] — P24: two lookup tables

**File:** `src/run/events.ts:876` `endingOf` (two `if`s from `FinishReason` to `RunOutcome`),
which becomes `OUTCOME_BY_FINISH[reason] ?? RunOutcome.Answered`. `src/hooks/hooks.ts:186`
`usableHookSetting`, a ternary over setting names, which becomes a table keyed by
`keyof HookOptions` (it also guards P14). Buys: P24. Needs: —.

### R40 [readability] — P17: the one source cast with a type fix

**File:** `src/spec/columns.ts:282`
`section = section[segment] as Record<string, unknown>`. Hold `isRecord(next) ? next : {}` in a
local, write it, then step into it. Buys: P17. Needs: —.

### R41 [sweep] — apply P14 across src

Fixing P14, "a list kept in sync by hand is derived, or guarded by a test". In
`src/spec/spec.ts:542` and `:679`, `parseSpec` spells out every member of `ReasoningReplay` and
`ToolDiscovery` with `||`, so a new member is dropped without a warning. The rest of the repo
derives these lists with `Object.values` (`hook-events.ts:36`, `remote.ts:51`, `events.ts:811`).
`ToolsSpec.discovery` is a literal union (`spec.ts:144`), not `ToolDiscovery`.
`src/wire/tokens.ts:428` writes `PARTS` less `'tools'` out again. The `resetAll` list is guarded
by a test instead (T8), as its doc argues the list is the seam.

```
hits - 4
-- files --
src/spec/spec.ts (3)
src/wire/tokens.ts (1)
```

### R42 [sweep] — apply P1/P20 to the conditions that take reading

Fixing P1, "name conditions before testing them", and P20, "a negated logic check is a positively
named const". Only bucket A of the survey is in scope: 31 conditions that mix arithmetic, a clock,
or three or more clauses. So are the 33 inline `=== false` tests in an `if`. The other ~330
conditions (single comparisons against a vocabulary member, combinations of named booleans,
`typeof` idioms, the character scanner) are out of scope: a name would only repeat them.
Examples: `client.ts:665` (clock arithmetic in a three-way test; R34's `isListingFresh` covers it),
`agent-loop.ts:1987`, `events.ts:386`, and `client.ts:928` `response.ok === false`.

```
hits - 64
-- files --
src/context/compaction.ts (6)
src/spec/columns.ts (6)
src/spec/spec.ts (6)
src/endpoint/client.ts (5)
src/run/agent-loop.ts (5)
src/tools/tool-loading.ts (5)
src/run/events.ts (4)
src/run/run-calls.ts (4)
src/runtime/snapshot.ts (4)
src/endpoint/capabilities.ts (4)
src/wire/stream.ts (3)
src/run/remote.ts (2)
src/context/ledger.ts (2)
src/turn/run-turn.ts (2)
src/turn/continuation.ts (2)
src/run/artifacts.ts (1)
src/run/request-body.ts (1)
src/tools/instructions.ts (1)
src/tools/preselect.ts (1)
```

(The per-file counts add the survey's bucket-A and `=== false` counts; the sweep reads each one
before naming it.)

### R43 [sweep] — apply P19 across src, worst first

Fixing P19, "comments are short: a doc description is up to four sentences". The house style is
long rationale, and the ledger never recorded that as a decision; `docs-comments.md` repeats the
four-sentence limit. In scope: the 38 doc blocks of seven sentences or more (29 of 7–9, 9 of 10+),
and the 16 `//` runs of five lines or more. History goes to the commit and usage to the README,
as P19's table says. Out of scope: the 67 blocks of 5–6 sentences, which carry a real "why" more
often than not. Worst: `runAgentLoop` (`agent-loop.ts:925`, about 25 sentences: a usage guide);
`resetAll` (`reset.ts:9`, about 10); `run-turn.ts:247` (a 10-line `//`). Committed as `docs:`, in
tranches by folder.

```
hits - 105 doc blocks over four sentences (38 in scope), 56 // runs over two lines (16 in scope)
-- files (doc blocks over four) --
src/run/agent-loop.ts (21)
src/endpoint/client.ts (11)
src/endpoint/capabilities.ts (8)
src/tools/tool-loading.ts (6)
src/context/compaction.ts (5)
src/run/events.ts (5)
src/spec/spec.ts (5)
src/core/config.ts (4)
src/hooks/hooks.ts (4)
src/turn/side-task.ts (4)
src/wire/tokens.ts (4)
src/endpoint/schema-compat.ts (3)
src/run/run-calls.ts (3)
src/tools/preselect.ts (3)
src/wire/tool-calls.ts (3)
src/turn/run-turn.ts (2)
src/wire/retry.ts (2)
src/wire/stream.ts (2)
src/context/ledger.ts (1)
src/endpoint/calibration.ts (1)
src/run/artifacts.ts (1)
src/runtime/reset.ts (1)
src/runtime/runtime.ts (1)
src/runtime/snapshot.ts (1)
src/tools/instructions.ts (1)
src/turn/continuation.ts (1)
src/wire/call-ids.ts (1)
src/wire/thinking.ts (1)
-- files (// runs over two) --
src/run/agent-loop.ts (10)
src/wire/stream.ts (10)
src/run/events.ts (9)
src/turn/side-task.ts (6)
src/endpoint/client.ts (4)
src/turn/run-turn.ts (4)
src/wire/tokens.ts (4)
src/tools/tool-loading.ts (3)
src/endpoint/capabilities.ts (2)
src/endpoint/schema-compat.ts (2)
src/run/run-calls.ts (1)
src/spec/spec.ts (1)
```

---

## Tests

### Record, 2026-10-02

Approved 2026-10-02: T1–T4. Done, except the half of T3 that is a question. 654 tests before
and after each, and the same titles.

| ID | What | Commit |
| --- | --- | --- |
| T4 | a test lives in the file of the module that owns the code: `tokens`, `request-body`, `run-calls`, `preselect` test files; `resolveApiKey` in `client.test.ts` | `2422b39` |
| T1 | what more than one file builds lives in `tests/helpers.ts` | `ee84a0a` |
| T3 | `schema-compat`'s tool helper takes typed parameters instead of a cast | `eb9c239` |
| T2 | every file groups its tests under `describe`, and says `it` | `840ba0e` |

#### Left as they are, and why

- **T1** — a helper that closes over the file's own mock stays in the file (`body`, `sentHints`,
  `create`, `list`), since `vi.mock` is hoisted per file. `calls` has three signatures in three
  files. The `config` of `ask-json`, `side-task-vision` and `snapshot` names a different
  endpoint on purpose, as does `endpoint(baseUrl)` in `side-task-hints`. `refusal` in `runtime`
  is built on a mocked SDK. Renamed so one name means one thing: `says` → `asking`
  (calibration), `reply` → `replies` (continuation), `stream` → `chunks` (agent-loop), `tool` →
  `catalogTool` (tool-loading), `answers` → `answer` (side-task-settings).
- **T1, closed** (`3d7926a`) — answered 2026-10-02: one shape, the SDK's. Every refusal
  that carries a status is built with `apiError`, and the four that two files share are in
  `tests/refusals.ts`, apart from `helpers.ts` because a file that mocks the SDK whole cannot
  build them on load. Doing it showed `apiError` wrapped the body once too often, so its
  message was the JSON of the body; it reads `400 rejected` now.
- **T2, closed** (`e98d4dc`) — answered 2026-10-02: reword them. Eighty-six titles led with
  a noun; each starts with the verb now and takes its subject from its `describe`, plural
  where the `describe` names two things. Titles only.
- **T3** — a cast that is the test stays: a wrong type handed in to see it refused (`'900' as
  never`, `'8' as never`, `[...] as never[]`, `emit(... as never)`, `reasoning_content`).

### T5 [readability] — A fake is typed as what it stands in for: the SDK `create` mocks

**File:** the 19 `const create = vi.fn();` in `tests/` (most in `tests/run/agent-loop*.test.ts`
and `tests/turn/continuation.test.ts`). Typed as
`vi.fn<(body: Body, options?: unknown) => unknown>()`, `mock.calls[n][0]` is a `Body`. That removes
40 `as Body` (`agent-loop.test.ts` 23, `agent-loop-transcript.test.ts` 8, `continuation.test.ts` 5,
and one each in `-artifacts`, `-hand-back`, `-host-tools` and `-input`) and 5
`as OpenAI.ChatCompletionCreateParamsStreaming`. The repo already does this with
`vi.fn<HookRunner>` (`hooks.test.ts:285`). (unverified) that the `mockResolvedValue` and
`mockReturnValueOnce` calls still compile. The 15 `as Message` casts on literals take
`satisfies Message` in the same commit. The `as never` ones stay (T3).

### T6 [pin] — `core/scope.ts` and `core/config.ts` get tests of their own

**File:** `tests/core/` has only `guards.test.ts`. `scoped`, `inScope`, `currentScope` and
`assignSettings` are tested only through the modules that use them. `normalizeBaseUrl` and
`baseUrlKey` are tested in `tests/endpoint/client.test.ts`. Behaviour to pin: a scoped store per
runtime, reset per scope, and an invalid setting keeping its value. Before M10.

### T7 [pin] — `tests/wire/errors.test.ts`

**File:** nothing tests `AgentLoopError`, `AgentLoopOverflow` (still `instanceof
ContextOverflow`), `ToolIterationLimit` or `failedRun` directly. Behaviour to pin: every
`AgentLoopFailure` field is copied, `failedRun` reads any of the three, and `errorMessage` works
on a non-Error. Before R23 and R44, at the module's new path afterwards.

### T8 [pin] — Reset covers every per-scope store

**File:** `tests/runtime/reset.test.ts` has no case for `resetSlots`, and nothing counts the
`scoped()` stores against `resetAll` (`reset.ts:36-44`) or `STATEFUL` (`runtime.ts:40-83`). The
stores are `client.ts:80,81,177`, `events.ts:85`, `hooks.ts:174`, `side-task.ts:63`, `slots.ts:55`,
`calibration.ts:39` and `capabilities.ts:204`. Add the slots case and a drift test (P14's "guarded
by a test" branch). (unverified) whether `STATEFUL` can be checked without listing it again by hand.

### T9 [pin] — `refusesRequest` and `isModelLoading`

**File:** `tests/wire/retry.test.ts` covers neither. Before B22.

### T10 [pin] — The capability snapshot's JSON, byte for byte

**File:** `tests/runtime/snapshot.test.ts` exists. (unverified) whether it pins the exact JSON,
`thinkingHints` included, or only the round trip. Pin the exported JSON for a store with latched
flags, refused fields and efforts, and refused hints. Before R30.

### T12 [pin] — A failure carries the same run fields as a result

**File:** `tests/run/agent-loop.test.ts`. Pin that a run thrown at step N and the same run finished
carry equal `messages`, `usage`, `toolCalls`, `artifacts`, `loaded`, `used`, `preselected`,
`ledger` and `remoteRunId`. Before R29. (T11 is filed under Low value.)

---

## Docs

D1–D5 are done. D2: nine lead sentences say what the export is before why it is (`725a6a8`).
D5: `CLAUDE.md` is a symlink to `AGENTS.md` (`835b7e3`).

### D6 — `docs/agent-spec.md` has drifted from the code

**File:** `docs/agent-spec.md`.
- `:6` "Nothing in it is implemented yet" and `:686` "Before any of this is implemented": both
  false.
- Open questions the code has answered: bundle opt-in is `parseSpec(doc, {bundle: true})`
  (`:674-675`, `spec.ts:996`), and agent-level hooks shipped (`:670`). "Un-setting an inherited
  `extraBody` key" (`:680`) is still open.
- The documented `ResolvedAgent` (`:275-285`) lacks `prompt`, `mcpServers` and `requires`
  (`spec.ts:269,274,277`).
- "Exactly four hard errors" (`:393-396`, also `spec.ts:921-923`): the code also fails on a
  `requires` that isn't an array, or holds a non-string (`spec.ts:968,972`).
- Stale line references: `config.ts:108` (now `:296`), `client.ts:10` (now `:20`),
  `snapshot.ts:128` (now `:202`), `compaction.ts:232` (now `:793`).
- `:301` says the spec module imports from `config.ts`. It also imports `core/guards` and
  `hooks/hook-events` (`spec.ts:8-9`), and the README's "imports nothing but types" is wrong the
  same way.
- The table row for `model.extraBody` (`:320`) doesn't mention the fields #222 drops.
- The kanban example (`:552`) implies `apiKey: ""` depends on `baseUrl`. The code returns `""`
  for every agent (`spec.ts:1227`).
- "An unresolvable slug is dropped with a warning" (`:355-357`) is the host's job: no code in
  `spec/` resolves slugs.

### D7 — Comments that are no longer true

**File:**
- `src/runtime/reset.ts:27` cites `tests/side-task-hints.test.ts`; the file is now
  `tests/turn/side-task-hints.test.ts`.
- `src/runtime/runtime.ts:102` says "the six narrower resets"; there are seven. Its
  `createRuntime` doc (`:143-144`) omits calibration and slots.
- `src/wire/tokens.ts:211` points at `tests/retry.test.ts`; the pin is in
  `tests/wire/tokens.test.ts`.
- `src/wire/tokens.ts:28-31` is history, and names only `hooks` as a reader.
- `src/wire/stream.ts:26` and `:670` describe what was exported "for this loop" (history).
- `src/wire/tool-calls.ts:568-571` says nothing stops an id repeating in a later step;
  `distinctCallIds` does.
- `src/run/artifacts.ts:288-293` says an id is distinct only within its step.
- `src/core/config.ts:181`: a sentence spliced mid-paragraph.
- `src/endpoint/capabilities.ts:830-833` says "the three" model answers; `ANSWERS` has nine.
- `src/endpoint/client.ts:405-406` says capabilities key on `endpointKey`; they key on
  `endpointId`.
- `src/turn/side-task.ts:49-50` says the client cache is keyed by `endpointId`; it isn't.
- `src/endpoint/client.ts:1058` (`resetClients`) leaves out windows, slot counts, refusals and
  `unserved`.
- `src/endpoint/schema-compat.ts:14-15` says "retry once"; the strip latches for the process.
- `negotiate`'s `@param options` (`capabilities.ts:1025-1026`) misses `droppable`.
- `src/run/events.ts:161` says `done` is "always last, and always sent"; the loop never sends it
  (see B23).
- `src/tools/tool-loading.ts:250` `MAX_CARRIED`'s doc tells callers to pass "another number",
  but it isn't exported from the root.
- `src/run/agent-loop.ts:130-139`: the module preamble tells the history of "three servers".
- `src/hooks/hooks.ts:579,620` say `notify` and `consult` never reject. This one is fixed by B7,
  or reworded if B7 is declined.

### D8 — Lead sentences and missing docs that `llms.txt` publishes

**File:**
- `src/turn/run-turn.ts:48`: `RunTurnOptions`' first sentence describes `onNotice`, and
  `llms.txt` publishes it as the type's entry.
- `src/endpoint/capabilities.ts:176-194`: a doc comment written for the `capabilities` map sits
  above `OnNotice`'s, attached to nothing.
- `src/wire/call-ids.ts:134`: the exported type `CallIds` has no doc of its own.
- `src/spec/spec.ts:284-287`: `RESOLVED_DEFAULTS` explains every default but `maxTokens: 0`.

Rebuild `llms.txt` in the same commit.

### D9 — Option docs that promise more than the code does

**File:** `src/run/agent-loop.ts`:
- `parallel` (509-527) doesn't say one-call-per-message runs calls one at a time
  (`run-calls.ts:1086`).
- `dedupeToolCalls` (530) says "the same arguments, word for word"; the key is the normalised
  JSON (`run-calls.ts:777`).
- `callIds` doesn't say a remote agent keeps the server's ids.
- `asRemoteAgent`'s notice (`remote.ts:289-295`) doesn't list `callIds` or `recoverToolCalls`, and
  `contextLength` is set to 0 without a word.
- `onToolCall` (581), `onToolResult` (594) and `toolCalls` (807) say "every call"; see B25.

### D10 — AGENTS.md: the `remote` module, and a pointer to the glossary

**File:** `AGENTS.md`. The `run` row lists `agent-loop run-calls artifacts request-body events`,
without `remote`. Add a line pointing to `.agents/domain-model.md` for the project's terms,
rather than repeating them (modeling.md, "Other docs point to it"). Done in the same commit as the
domain model, if approved with it.

---

## Bugs

### Record, 2026-10-02

Reviewed 2026-10-02, one answer each. Done on `fix/review-findings`, one commit each.

| ID | What | Commit |
| --- | --- | --- |
| B1 | `listModels` and the ranking tie-break order by code unit; `byCodeUnit` lives in `guards.ts` | `bcfa50e` |
| B2 | `tryAsk` lets through an abort that is the signal's own `AbortError`; `isAbort` in `retry.ts` | `06e7d5e` |
| B2 | `tryAsk` is handed the signal and asks it first, so a reason of the caller's own is an abort too | `2472cd5` |
| B3 | one `CODE_FENCE` pattern for `parseJson` and `bareCalls` (they matched the same text) | `a4cdfb0` |
| B4 | not a bug: `pruneDefs` had checked the pool and then cast it; it keeps what it checked | `7c095fd` |
| B5 | the keyword pass takes the smaller of its own cap and `preselect`'s ceiling | `a89dd86` |
| T3 | fake hook runners are typed `HookRunner`, built with `outcome()` from `tests/helpers.ts` | `38a85de` |
| B6 | `getOrCreate` reads a stored `undefined` as a miss: accepted, and the value type is bounded | `a226ead` |

Answers given, which the items follow:

- An order the program depends on compares by code unit. `localeCompare` is for text sorted for
  a person to read.
- A value a guard has narrowed is kept and passed on, not looked up again and asserted.
- A pattern written in two places for the same thing is one named constant, even where the two
  spellings accept the same text.
- A fake in a test is typed as the thing it stands in for, and a builder fills in what the test
  is not about.

#### Left as they are, and why

- **B2** — `isAbort` is in `retry.ts` rather than `guards.ts`, which has no imports and would
  need the SDK. It looks at the error only, so `tryAsk` asks the signal as well; a host calling
  `tryAsk` itself has to hand it the signal to get that.

### Reproduced, 2026-11-18

Each was reproduced at `2ff19b8` by a script in the session's scratchpad (`repro/`). Each fix
writes its repro as a regression test first. Severity is a guess from the impact on a host.

### B7 — `notify` and `consult` reject when `onNote` throws (confirmed; low–medium)

**File:** `src/hooks/hooks.ts:602` and `:639`. The `onNote?.(note)` loops run outside `runSafely`
(`:536-539`), which guards only the runner. The docs (`:578-579`, `:620`) say "never rejects, so a
host can fire it without awaiting it". In `src/context/compaction.ts:900` and `:906-909`
(`Promise.all` with the summary), a throwing `onNote` fails the compaction after the summary was
paid for. The loop rejects too, through `foldBeforeStep` (`agent-loop.ts:1237`).
`AgentLoopResult.afterTurn`'s doc (`agent-loop.ts:852-853`) already says it rejects if `onNote`
throws. Intended: catch `onNote` as `runSafely` catches the runner, and report it as a note or a
notice (to decide). Repro: `b1.ts`.

### B8 — A hook merged by id isn't re-checked (confirmed; low)

**File:** `src/spec/spec.ts:1107` (a shallow `mergeById`), `:1197-1200`. The checks live only in
`parseSpec` (`:807-815`). A lower `{id:'h', on:'beforeTurn', inject:true}` under an upper
`{id:'h', on:'afterTurn'}` resolves to `afterTurn` with `inject:true`, and `veto` likewise. The
same flags in a single layer are dropped with a warning. Run time still refuses them
(`assembleContext`, `INJECT_EVENTS`), so the harm is a resolved agent that misdescribes itself.
Intended: the per-hook checks run on the merged hook too. Repro: `b2-b4-spec.ts`.

### B9 — `text: ''` doesn't delete a prompt part (confirmed; medium for hosts that resolve refs)

**File:** `src/spec/spec.ts:1107` (the lower `ref` survives the merge) and `:1193-1196` (deleted
parts aren't filtered from `prompt`). The docs at `:132` and `docs/agent-spec.md:124,321` say empty
text deletes the part. `systemPrompt` leaves it out, but `ResolvedAgent.prompt` keeps
`{id, ref, text: ''}`, and a host that resolves refs from `prompt` brings the part back.
Intended: a deleted part is absent from `prompt`. Repro: `b2-b4-spec.ts`.

### B10 — An empty `id`, `name` or `description` never overrides (confirmed; low)

**File:** `src/spec/spec.ts:1218-1220`, `findLast((layer) => layer.id)`, which tests for a truthy
value. This contradicts `resolveAgentSpec`'s own remark (`:1162-1163`) that `""` is a value.
Intended: test for presence with `absent`. Repro: `b2-b4-spec.ts`.

### B11 — #222's rule holds only in `parseSpec` (confirmed; low–medium)

**File:** `src/spec/spec.ts:585-607` filters in `parseExtraBody` only. `mergeModel`
(`:1081-1082`) and `resolveTasks` (`:1131`) merge `extraBody` without it, and
`defineSpecColumns().toLayer` (`src/spec/columns.ts:360-376`) writes column values straight into
a layer. An in-code or `toLayer` layer with `extraBody.temperature: 0.9` sends 0.9 over a stated
0, and skips the negotiation. Intended: `resolveAgentSpec` drops the reserved and spelled fields
from the merged `extraBody` too. It has no warnings list, so the drop is silent unless one is
added (to decide). Repro: `b5-extrabody.ts`. See A8.

### B12 — `recoverToolCalls` skips only `</think>` (depends; low)

**File:** `src/wire/tool-calls.ts:494-496`. Called directly on raw text, a call inside a harmony
(`<|channel|>analysis<|message|>…<|end|>`) or Kimi (`◁think▷…◁/think▷`) fence is recovered as a
real call. Moot in the loop: `streamTurn` always splits with `DEFAULT_FENCES` first
(`stream.ts:966`). Intended: skip every fence in `DEFAULT_FENCES`. Repro: `b6-recover.ts`.

### B13 — `runMetrics` pairs results with calls by name (depends; low–medium)

**File:** `src/run/events.ts:942`, `:958`, `:969` key `pending` on `event.name`, though both events
carry `id`. Results arriving in reverse order still sum right. A call with no result throws the
total off: a handed-back call, an aborted run, or a backlog trimmed by the cap. A handed-back call
followed after a 60 s wait by another call of the same tool gives `toolMs` 60010 for 10. Intended:
pair by `id`. Repro: `b7-toolms.ts`.

### B14 — A slot allocator keeps the array it was made with (confirmed; low)

**File:** `src/endpoint/slots.ts:93-95` builds a new array (new objects past `known.length`), and
the closures at `:97-127` capture it. If a run holds slot 3 of 4, and later runs see 2 slots, then
4 again, slot 3 is handed out a second time while the first run still holds it. The loop makes
one allocator per run (`agent-loop.ts:1075-1076`), so only that regrow form reaches it. Intended:
read the pool's current slots on every acquire. Repro: `b8-slots.ts`.

### B15 — The bus reaps a waiting run and restarts its numbering (confirmed; medium for hand-back hosts)

**File:** `src/run/events.ts:386-387` (the reap), `:353-360` (a new stream starts at `seq: 0`),
`:446`. With no watcher attached, a stream without `done` is deleted after `retainUnendedMs`
(30 minutes). The next `emit` restarts `seq` at 1, so a client de-duplicating on `seq` (the
documented use) discards the resumed run's events, `done` included. A handed-back run whose
person answers after the client disconnected and the retention ran out hits exactly this. The
`wait` doc (`events.ts:153-158`) promises "the run goes on, under the same id". Intended: to
decide. Either a `wait` keeps its stream (or a longer retention), or a new stream continues the
old numbering. Repro: `b9-bus.ts`.

### B16 — The client pool keys on the raw URL (confirmed; low)

**File:** `src/endpoint/client.ts:269`
(`JSON.stringify([config.baseUrl, apiKey, timeout])`) against `endpointKey` (`:431-432`,
`baseUrlKey`). Four spellings of one URL (a trailing slash, upper case, `:80`, whitespace) make
four clients, which count against `maxClients`. The SDK is also handed the raw URL (`:279`).
Intended: key on `baseUrlKey`. Repro: `b10-client-key.ts`. Needs: B24.

### B17 — Capability latches ignore `fetch` (confirmed; a question)

**File:** `src/endpoint/capabilities.ts:204`, `:221-222`, `:264`; the latches at `:898` and `:918`;
calibration at `src/endpoint/calibration.ts:39`. Against the per-fetch caches in
`src/endpoint/client.ts:79-88` (`perFetch`), `:121`, `:376`, `:385`, `:402`, `:467`, `:477`, `:500`
and `:514`. Two `fetch` functions behind one URL and key get separate listings ("two functions may
reach two servers behind one URL", `:370-371`), but share one `Capabilities` object. So one
backend's refusal degrades the other. Is sharing intended? Repro: `b11-fetch-keys.ts`. Needs: B24.

### B18 — `dropped` paths are ambiguous (confirmed; low)

**File:** `src/spec/columns.ts:473`, and `:451` likewise. `path.join('.')` gives
`extensions['com.acme']` and `extensions.com.acme` the same text. `ExtensionPath` exists to avoid
exactly that (`:49-53`). Intended: report the segments (or quote a segment holding a dot).
Repro: `b12-dropped-paths.ts`.

### B19 — `Turn.reasoning` puts the field before the fence (confirmed; low)

**File:** `src/wire/stream.ts:971` (`reasoning.join('') + splitter.reasoning`), and the same in the
in-flight read at `:848`. Fenced reasoning that arrived first comes second, run together with no
separator, though `onThinking` saw the true order. Intended: arrival order. Repro:
`b13-reasoning-order.ts`.

### B20 — `reasoningEffort` is latched by two rules (a question)

**File:** `negotiate` latches it with `rejectsEffort` (`src/endpoint/capabilities.ts`), and side
tasks latch it on "a leftover 400 after the hints were not sent" (`src/turn/side-task.ts:316-343`).
Same latch, two rules. Is the difference intended? Needed before R31.

### B21 — A served window never expires; the slot count from the same answer does (a question)

**File:** `src/endpoint/client.ts:665` (a positive served window stands until `resetClients`) and
`:737` (the slot count expires after `listingMissMs`, "a server restarted with another
`--parallel`", `:474-476`). A server restarted with another `-c` keeps its old window. Intended?

### B22 — `negotiate` doesn't use `refusesRequest` (a question)

**File:** `src/wire/retry.ts:135-136` argues for the status test, and `side-task` and
`continuation` use it. `negotiate` reads every error by its text (`capabilities.ts:1068-1085`).
Whether `ANSWERS` filters by status is (unverified). One definition of a refusal, or two on
purpose? Needs: T9.

### B23 — Who owns a run's outcome (a question; becomes an `A` item if answered "the loop")

**File:** `stepOutcome` (`src/run/agent-loop.ts:1592`) writes `result.metrics.outcome`.
`runMetrics`/`outcomeOf` (`src/run/events.ts:858`, `:1025-1033`) work it out again from events,
but read `ended` off `done.name` and `failed` off `done.ok === false`, and only the host sends
`done`. Ending has no event kind of its own (a notice), where waiting has `wait`. `wallMs` has two
definitions (call to return, `agent-loop.ts:2071`; first event to last, `events.ts:1035`). A
thrown run carries no outcome, and `RunOutcome` has no value for a stop or a spent budget.
Question: should the loop send `done` itself, with an `ended` kind beside `wait`? That is a change
to the public events.
Note from Gate 1: under Session > Run > Exchange > Turn this is two levels rather than two
writers. `metrics.outcome` is an exchange's outcome, and `runMetrics` over the bus with the app's
`done` is a run's. The answer may be to name both, not to merge them. Left for after the first
pass, as the user asked.

### B24 — What "one endpoint" means across the caches (a question)

**File:** clients key on the raw URL, key and timeout (`client.ts:269`). Listings and windows key
on `endpointKey` and the fetch function (`:376-514`). Capabilities, calibration and the hints key
on `endpointId`, without fetch (`capabilities.ts:221-223`, `calibration.ts:39`,
`side-task.ts:311`). Slots key on the normalised URL and the model, without key or fetch
(`slots.ts:69`). One rule, or the differences on purpose? Settles B16 and B17.

### B25 — Calls the host is never told of (a question)

**File:** `src/run/run-calls.ts:1126-1128`, `:1151`. A handed-back call answered as `ENDED_CALL`,
and `UNRUN_CALL`/`STOPPED_CALL` calls, get no `tool-result` event and no `onToolResult`, and the
first gets no `onToolCall` either. Handed-back calls are told only at the end of the step
(`:1133`). The docs say "every call" (`agent-loop.ts:581`, `:594`, `:807`). Tell them, or reword
the docs (D9)?

---

## API changes (need a decision)

### A1 — exports nothing outside the package uses (done, 2026-10-02)

**Tuning constants: done (`bc6bbf9`), a breaking change.** Checked 2026-10-02 against
every repo under `~/code` that depends on the package (`kanban_server`, `task_server`,
`min-agent`, `telos`, `engrafo` and their worktrees). Eight defaults no host imports are no
longer exported: `CHARS_PER_TOKEN`, `FIRST_TOKEN_FACTOR`, `KEYWORD_DROPOFF`,
`KEYWORD_MIN_SCORE`, `LOADING_POLL_MS`, `LOADING_TIMEOUT_MS`, `MAX_CARRIED`, `MAX_PER_LOAD`.

Kept, and why:

- In use by a host: `COMPACT_AT`, `KEEP_RATIO`, `SUMMARY_PROMPT`, `SUMMARY_LEAD`,
  `HOOK_CONTEXT_TOKENS`, `SMALLEST_LIKELY_WINDOW`, `PRESELECT_SYSTEM`, `PRESELECT_SCHEMA`,
  `HOOK_PREFACE`, `NO_KEY`.
- No host imports them, but they are vocabulary a host builds or compares, which a library
  exports: `EFFORT_NONE`, `EFFORT_OFF`, `EFFORT_LADDER`, `FUNCTION_TOOL`, `JSON_SCHEMA_FORMAT`,
  `ARGUMENTS_MALFORMED`, `ARGUMENTS_TRUNCATED`, `SPLIT_OUTPUT`, `SPLIT_REASONING`, `REF_FILE`,
  `REF_URL`, `PRESELECT_APPEND`, `PRESELECT_EXCLUSIVE`, `AGENT_TASKS`, `SPEC_EVENTS`, the
  fences (`THINK_FENCE`, `DEFAULT_FENCES`, `ALL_FENCES`), the two version numbers,
  `RESOLVED_DEFAULTS`, and `UNTRUSTED_PREFACE`, which the README tells a host to use.

**Types and functions: done, a breaking change.** Listed per export on 2026-10-02 by
searching every host file that imports the package for each name: of 254 exports, 141 are named
by no host (57 types, 50 functions, 12 enums and classes, 22 constants).

- The types stay: each is in the signature of something exported. The enums and error classes
  stay: they are what a host compares and catches.
- 45 of the 50 functions are described in the README, so they are the API, not yet adopted.
- Four that the README never mentions are no longer exported: `summaryInput`,
  `isContinuable`, `sleep`, `toolsChars`.
- `resetHints` was the fifth and stays: it is one of the six narrower resets and a method on
  every `Runtime`. The README names it now.

### A2 — `prepack` and the skill's tsconfig layout: done (`0c35470`)

Decided 2026-10-02: follow the skill. `tsconfig.json` checks src, tests and bench and emits
nothing (`module: ESNext`, `moduleResolution: bundler`, `noEmit`); `tsconfig.build.json` is the
only config that emits, and `tsconfig.tests.json` is gone. The build runs on `prepack`, and CI
builds explicitly. `dist/` came out byte for byte the same.

What it costs: an install from a git URL gets no `dist/`. No consumer in the org installs it
that way; all ten depend on a published version.

### A3 — Rename the public names M11 found (P27: only if asked)

- `compact` (`src/wire/tokens.ts:49`) formats a token count, and sits beside compaction. It is
  also used to print seconds (`run-turn.ts:265`, see B27).
- `firstTokenMs(config)` (`src/endpoint/client.ts:234`) is the allowance, while
  `TurnUsage.firstTokenMs` is the measurement.
- `timeoutMs(config)` (`client.ts:36`) is the idle allowance, called `idleMs` in
  `StreamTurnOptions`.
- `startInReasoning` (`StreamTurnOptions`, `stream.ts:707`) and `startInside`
  (`FenceSplitterOptions`, `thinking.ts:77`) are one option under two names.

Path: new names beside the old, the old ones `@deprecated` (a `feat:`), and removal in the next
major. Decline to keep the names and record them as aliases in the glossary (they already are).

### A4 — Export `OnNotice` and `EndpointIdentity` (feat, non-breaking)

`OnNotice` (`src/endpoint/capabilities.ts:202`) types `RunTurnOptions.onNotice`,
`SideTaskOptions.onNotice` and others. `EndpointIdentity` types
`resetCapabilities(endpoint?)` (`:287`). Neither is exported from `index.ts`, so a host can't name
the type it passes. Also: `capabilitiesFor(baseUrl, apiKey?)` takes positional arguments where
its siblings take an `EndpointIdentity` (low; a separate decision).

### A5 — A defaults module (P22)

There is no `defaults.ts`. About 49 tunables sit in 17 files, in four group shapes, none frozen:
`HOOK_DEFAULTS` (`hooks.ts:168`), `DEFAULTS` (`events.ts:65`, the one without its concept's name),
`CLIENT_DEFAULTS` (`client.ts:170`), `RESOLVED_DEFAULTS` (`spec.ts:289`). The rest are lone
constants or signature defaults: `side-task.ts:261` (`maxTokens = 512, temperature = 0.3`),
`preselect.ts:401` (`maxTokens = 256`), `compaction.ts:213` (`maxChars = 256`), `run-calls.ts:70`
(`preview(text, limit = 2000)`). `LISTING_MISS_MS` (`client.ts:141`) is stored in ms, where P22
wants the unit a person edits. Per file: `compaction.ts` 8, `preselect.ts` 7, `retry.ts` 6,
`client.ts` 5, `events.ts` 4, `calibration.ts` 3, two each in `hooks.ts`, `tool-loading.ts`,
`continuation.ts`, `side-task.ts` and `spec.ts`, one each in six more.
Split: the internal tunables first (an `R` change, no API impact). Then the host-imported ones
(`COMPACT_AT`, `KEEP_RATIO`, `HOOK_CONTEXT_TOKENS`, `SMALLEST_LIKELY_WINDOW`), kept as re-exports
or renamed (P27). The `configure*` settings copied from a group need a design.

### A6 — Retire the deprecated aliases (P25; breaking)

`LoopUsage.prompt/completion/total/cached` (`src/wire/stream.ts:197-206`, `@deprecated` for the
`…Tokens` names), and `AgentLoopOptions.events` (`src/run/agent-loop.ts:219-222`, deprecated for
`fire`, still read by `firing`). Underneath, `TurnUsage` (`stream.ts:65`) uses
`prompt`/`completion`/`total` for what `UsageTotals` calls `…Tokens`. That pair is the root, and it
stays unless decided otherwise. Breaking; check the hosts first, as A1 did.

### A7 — Stop exporting `AGENT_TASKS`, `PRESELECT_SYSTEM`, `requestIndex`, `SPEC_EVENTS`

A1 decided three of these on 2026-10-02: `PRESELECT_SYSTEM` is in use by a host, and
`AGENT_TASKS` and `SPEC_EVENTS` are vocabulary a library exports. `requestIndex` is in the README
(`README.md:1230`, `:1633`), so it is the API. `SPEC_EVENTS` is `HOOK_EVENTS` under a second name
(`spec.ts:53`), which P25 would retire. Recommend decline, except for an optional deprecation of
`SPEC_EVENTS` in favour of `HOOK_EVENTS`.

### A8 — Export the fields `extraBody` may not set from a document

`SPELLED_BODY_FIELDS` (`src/spec/spec.ts:568`) isn't exported, so a host building layers in code
can't apply #222's rule itself. Unneeded if B11 makes `resolveAgentSpec` apply it. Needs: B11.

---

## Low value

Code that works, reads badly, and that nobody is about to change.

### R45 [readability] — The private `positive` wrapper, and a speculative remark

**File:** `src/endpoint/client.ts:317` `positive` forwards to `isPositive` (R35 may take it).
`src/endpoint/capabilities.ts:52-56`: `Capabilities.since`'s remark speculates about "stamping it
in four modules", a design that was never built.

### R46 [consistency] — P16 one-offs

**File:** `src/core/config.ts:104` (`'http:'`/`'https:'` inline), `src/endpoint/client.ts:910`
(`'opaqueredirect'`), `src/tools/tool-loading.ts:308,331` (the `'*'` wildcard written twice).
Tests: `role: 'user'` (`tests/endpoint/client-fetch.test.ts:68`), `'assistant'`/`'stop'`
(`tests/run/remote.test.ts:65`), `type: 'function'` (`tests/run/agent-loop-remote.test.ts:77,215`,
`tests/run/agent-loop-transcript.test.ts:470`, `tests/turn/side-task-settings.test.ts:599`).

### D11 — The README's module table repeats the concepts

**File:** `README.md:21-60`. "What is here" describes each module. The glossary lives in
`.agents/domain-model.md`, which the site doesn't publish, so the table stays the published
version. Point to the glossary only if the glossary is published (modeling.md, section 7). Needs:
D10.

### T11 [consistency] — `tests/endpoint/turn.test.ts` names no module

**File:** `tests/endpoint/turn.test.ts` tests `negotiate` over `streamTurn`; there is no
`src/endpoint/turn.ts`. By AGENTS.md's rule, a test of two modules sits with the one that calls
the other (`capabilities.test.ts`). Move it, titles unchanged.

### B26 — `userText` and `textOf` join a message's text differently (a question)

**File:** `src/run/agent-loop.ts:1098` `userText` joins parts with `\n` and keeps refusals.
`src/hooks/hooks.ts:410` `textOf` joins with `''` and drops them. Is the difference intended?
Needs: M8 (where `textOf` lands).

### B27 — A loading wait of 1000 s or more prints as "1.0ks" (unverified)

**File:** `src/turn/run-turn.ts:265`, `compact(loadingTimeoutMs / MS_PER_SECOND)`. `compact`
formats token counts with a `k` suffix. Inferred from the code, not run.

### A9 — Hook events `beforeTurn`/`afterTurn` become `beforeExchange`/`afterExchange` (breaking)

**File:** `src/hooks/hook-events.ts:17-29` (`HookEvent`, `INJECT_EVENTS`), every firing site
(`src/run/agent-loop.ts` `firing`, `tellAfterTurn`; `src/context/compaction.ts` is `beforeCompact`
only), `src/spec/spec.ts` (`parseHooks`, the veto rule), README and `docs/agent-spec.md` (about 20
mentions). Approved by the user at Gate 1. Shape:
- `HookEvent.BeforeExchange: 'beforeExchange'`, `HookEvent.AfterExchange: 'afterExchange'`; the
  old members stay as `@deprecated` aliases until the next major.
- `parseSpec` reads `beforeTurn`/`afterTurn` forever, renaming each with a warning, and
  `exportSpec` writes the new names. No stored document needs migrating (P28).
- A runner receives the new names, which is what breaks: `BREAKING CHANGE:` in the commit, with a
  migration note in the PR.
- Private names follow: `tellAfterTurn` → `tellAfterExchange`, `fired.afterTurn`, and the rest.

### A10 — "Step" meaning a turn becomes "turn" (breaking)

**File:** `src/run/agent-loop.ts:168-174` (`AgentLoopRequest.step`), `:269` (`StepWindow`), `:619`
(`beforeStep`), `:743` (`onMessage`'s `step`); `src/wire/tool-calls.ts:762` (`ArtifactFrom.step`);
private names `runSteps`, `stepOutcome`, `StepOutcome` (`run-calls.ts:1009`), `step` parameters in
`run-calls.ts`. Shape: `beforeTurn`, `TurnWindow`, `turn` for the number. Old public names stay as
`@deprecated` aliases where a type alias or a second option can carry them. The option becomes
`beforeTurn` only after A9 removes the hook of that name from the same API, in the same release.
Needs: A9.

### A11 — The exchange events (breaking)

**File:** `src/run/events.ts:115-117` (`RunEventKind.Step`, `Decision`), `:277` (`RunEvent.step`),
`:729`, `:915`, `:948` (`RunMetrics.steps`). task_server emits them (`server/runner/flow.ts:304`,
`:351`, `:395`) and reads them back (`web/components/run-stream.tsx`), and so does ai-router's run
timeline (`web/runs/timeline.ts:182-188`). Shape: `RunEventKind.Exchange` ("an exchange began"),
`RunEvent.exchange`, `RunMetrics.exchanges`; `Decision` stays. Both apps change in the same
upgrade. Needs: A10.

### A12 — Public names that call an exchange a "run" (to decide)

**File:** `RunOutcome` (`src/run/events.ts:817`) as `AgentLoopResult.metrics.outcome`, and the
docs that say "the run ended/waits". The bus's run, the `runId`, `RunEvent`, `RunMetrics` and
`runAgentLoop` stay: a run is still the whole job, and the loop is still the agent loop. Decide
with B23, since the same type serves both levels today.
