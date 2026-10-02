# Project Todos

Findings from the refactor workflow. IDs are stable — don't renumber when items are removed.
`(unverified)` marks items inferred from docs or naming rather than confirmed in code.
Nothing here is implemented until approved.

The model these items come from (M1–M6) lives in the description of PR #141.

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
- Test helpers live in: `tests/helpers.ts` once a second file needs one; `bench/fixtures.ts` for
  the bench
- Test layout: `describe` named for the export, `it` for each case; a test lives in the file of
  the module that owns the code
- Generated files and the command that rebuilds them: `llms.txt` → `npm run build`
- Docs: `docs-comments.md` in the `cubicecho_typescript` skill; AGENTS.md adds only that the
  first sentence stands alone, because `llms.txt` takes it verbatim
- Code style: the `cubicecho_typescript` skill and the `coding-standards` skill's preferences P1–P21
- `CHANGELOG.md` and the `package.json` version belong to semantic-release

## Refactoring

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

### Left as they are, and why

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

### Preferences pass, 2026-10-02

Surveyed against the skills as they stand after P13 was rewritten and P15–P17 were added.
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

Answers given at the gate, which the items follow (all recorded in the skills):

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

---

## Tests

Approved 2026-10-02: T1–T4. Done, except the half of T3 that is a question. 654 tests before
and after each, and the same titles.

| ID | What | Commit |
| --- | --- | --- |
| T4 | a test lives in the file of the module that owns the code: `tokens`, `request-body`, `run-calls`, `preselect` test files; `resolveApiKey` in `client.test.ts` | `2422b39` |
| T1 | what more than one file builds lives in `tests/helpers.ts` | `ee84a0a` |
| T3 | `schema-compat`'s tool helper takes typed parameters instead of a cast | `eb9c239` |
| T2 | every file groups its tests under `describe`, and says `it` | `840ba0e` |

### Left as they are, and why

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

---

## Docs

D1–D5 are done. D2: nine lead sentences say what the export is before why it is (`725a6a8`).
D5: `CLAUDE.md` is a symlink to `AGENTS.md` (`835b7e3`).

---

## Bugs

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

Answers given, which the items follow:

- An order the program depends on compares by code unit. `localeCompare` is for text sorted for
  a person to read.
- A value a guard has narrowed is kept and passed on, not looked up again and asserted.
- A pattern written in two places for the same thing is one named constant, even where the two
  spellings accept the same text.
- A fake in a test is typed as the thing it stands in for, and a builder fills in what the test
  is not about.

The first three are in the `coding-standards` skill's preferences (P21, and added to P17 and
P16); the fourth is in its `tests.md`.

### Left as they are, and why

- **B2** — `isAbort` is in `retry.ts` rather than `guards.ts`, which has no imports and would
  need the SDK. It looks at the error only, so `tryAsk` asks the signal as well; a host calling
  `tryAsk` itself has to hand it the signal to get that.

### B6 — `getOrCreate` reads a stored `undefined` as a miss: accepted (`a226ead`)

**File:** `guards.ts`. Changed by R18 to drop an assertion (`has` then `get as V`). No caller
stores `undefined`. Answered 2026-10-02: accept it, and have the type say so. The value type
is bounded (`V extends {}`) in `getOrCreate` and in `scoped`, so a map that could hold
`undefined` does not compile, and a test holds that with `@ts-expect-error`.

---

## API changes (need a decision)

### A1 — exports nothing outside the package uses

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

Still open: the types and functions no host uses, not yet listed per export.

### A2 — `prepack` and the skill's tsconfig layout: done (`0c35470`)

Decided 2026-10-02: follow the skill. `tsconfig.json` checks src, tests and bench and emits
nothing (`module: ESNext`, `moduleResolution: bundler`, `noEmit`); `tsconfig.build.json` is the
only config that emits, and `tsconfig.tests.json` is gone. The build runs on `prepack`, and CI
builds explicitly. `dist/` came out byte for byte the same.

What it costs: an install from a git URL gets no `dist/`. No consumer in the org installs it
that way; all ten depend on a published version.
