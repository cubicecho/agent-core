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
- Shared helpers live in: `guards.ts` (predicates and small value helpers), `tokens.ts`
  (sizing), `scope.ts` (per-scope stores)
- Test helpers live in: each test file today; `bench/fixtures.ts` is the only shared one
- Generated files and the command that rebuilds them: `llms.txt` → `npm run build`
- Docs: AGENTS.md — terse prose that explains why, `@param` on every exported function,
  first sentence stands alone
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

---

## Tests

Surveyed, not approved.

### T1 [reuse] — shared builders for the fake client, API errors and stream chunks

**File:** `tests/*` `clientOf` in 5 files, `apiError` in 4, `chunk` in 3.

### T2 [consistency] — one layout

**File:** three files use flat `test()`, 25 use `describe`.

### T3 [readability] — `as never` casts

**File:** 19 in 8 files.

### T4 [consistency] — tests that stayed behind when their code moved

**File:** `tests/retry.test.ts` (sizing, moved by M1), `tests/agent-loop.test.ts` (`buildBody`,
`preview`, `resolveApiKey`, moved by M3), `tests/tool-loading.test.ts` (preselection, moved by
M4). Only their import paths changed, so that no commit moved a test and the code it pins.

---

## Docs

D1 is done (above).

### D2 — lead sentences that do not stand alone as an index entry

**File:** `runTurn`, `relaxTools`, `fold`, `timeoutMs`, `tryAsk`, `parseJson`, `compact`,
`backoffMs`, `isGrammarError` Each opens with the reason rather than what the export is, and
`llms.txt` takes that sentence verbatim. Surveyed, not approved.

---

## Bugs

Open questions, not approved.

### B1 — sorting with `localeCompare` where a comment promises a stable byte order

**File:** `tool-loading.ts:878`, `client.ts:442`, comment at `tool-loading.ts:187`.

### B2 — `tryAsk` recognises an abort by error class, the rest by the signal

**File:** `side-task.ts:334`

### B3 — two regexes for a code fence that accept different things

**File:** `side-task.ts:352`, `tool-calls.ts:316` Is the difference intended?

---

## API changes (need a decision)

### A1 — exports with no user inside the package or its tests (unverified)

To be listed per export before the next breaking release.
