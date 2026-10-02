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
- Docs: `docs-comments.md` in the `cubicecho_typescript` skill; AGENTS.md adds only that the
  first sentence stands alone, because `llms.txt` takes it verbatim
- Code style: the `cubicecho_typescript` skill and the `refactor` skill's preferences P1–P17
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
Baseline on `refactor/preferences-pass`: lint clean, typecheck clean, 654 tests pass.
Not approved. Counts are for `src` unless they say otherwise.

#### R15 [sweep] — P15: every conditional and loop body is a braced block

**File:** 463 hits of Biome's `style/useBlockStatements`: 395 in `src`, 68 in `tests`, `bench`
and `scripts`.
**Change:** add `"useBlockStatements": "error"` to `biome.json`, then one run of
`biome check --write --unsafe` (the fix is one Biome calls unsafe; the formatter in the same
run breaks the lines). A commit of its own with nothing else in it.

#### R16 [sweep] — P4: `@param name - text`, and no default in a description

**File:** 290 `@param` tags, all written `@param name text`; 0 use the hyphen. 14 descriptions
state a default (`client.ts:577`, `hooks.ts:428`, `preselect.ts:37,69,87`, `request-body.ts:32`,
`run-calls.ts:41`, `scope.ts:72`, `side-task.ts:414`, `spec.ts:910`, `thinking.ts:100,215`,
`tool-loading.ts:231,260`).
**Change:** hyphen form throughout, `[name]` for an optional parameter, and the 14 reworded to
say what the parameter is. AGENTS.md no longer shows the old form.

#### R17 [sweep] — P16: magic values

**File:** 31 hits of Biome's `style/noMagicNumbers` in 10 files, and the strings it does not
look at.
- HTTP statuses: `retry.ts:99` (408, 409, 429, 500), `retry.ts:115` (400, 422),
  `retry.ts:128` (503), `client.ts:366` (404, 405, 501)
- seconds and milliseconds: `1000` in `client.ts:15`, `run-turn.ts:152,241`, `stream.ts:445`
  (R3 put the conversion in one place; these four still spell it)
- the length of a preview in an error message: `200`, four copies in `tool-calls.ts:140,146,147`
  and `tool-loading.ts:588` (one constant, P6)
- backoff: `8000`, `500`, `0.5` in `retry.ts:150`, which its `@param` also spells out
- `tokens.ts:37` (`1000`), `preselect.ts:166` (`3`), `preselect.ts:259` (`0.5` twice),
  `hooks.ts:411` (`12`), `events.ts:60` (`30 * 60_000`)
- strings: `"length"` compared 6 times, `"done"` 3, `"proxy"` and `"ondemand"` 2 each,
  `"beforeCompact"`, `"unavailable_error"`, `"refusal"`
**Open:** whether a string the compiler checks as a member of a union (`finishReason ===
"length"`, `role === "user"`) counts, and `typeof x === "string"`.

#### R18 [sweep] — P17: type assertions

**File:** about 40 in `src`: `spec.ts` 11, `client.ts` 5, `stream.ts` 4, `side-task.ts` 4,
`tool-loading.ts` 2, `schema-compat.ts` 2, `scope.ts` 2, `runtime.ts` 2, `capabilities.ts` 2,
one each in `events.ts` (`as unknown as`), `guards.ts`, `request-body.ts`, `retry.ts`,
`snapshot.ts`, `tokens.ts`, `tool-calls.ts`. Tests: 23 `as never` / `as any` / `as unknown`
(T3).
**Kinds:** reading an untyped reply (`as { data?: unknown }`, `as Record<string, unknown>`,
`as CacheUsage`): a guard that narrows; a string already checked against a list
(`on as HookEvent`, three times in `spec.ts:525–545`): a guard on the list; a generic that
returns `as T` (`scope.ts:54`, `spec.ts:352`, `side-task.ts:364`, `guards.ts:46`): the
signature, or one helper that holds it; building from `{} as T` (`spec.ts:352`).
**Note:** a guard where there was an assertion can add a runtime check. Each of those is a
`B` question, not part of the sweep.

#### R19 — P13: chains and loops by the size of the lambda

**File:** block-body callbacks to compare against a loop: `agent-loop.ts:838`,
`compaction.ts:301`, `run-calls.ts:69`, `run-calls.ts:285`, `tool-loading.ts:70`. Loops that
only push, to compare against a chain: `client.ts:459`, `hooks.ts:250,535`, `ledger.ts:190`,
`run-calls.ts:289`, `spec.ts:461`, `tool-calls.ts:361`, `tool-loading.ts:351,359,544`.
**Stays:** the loops R12 wrote (a side effect or a long body each), and `stream.ts:479`, which
runs per streamed chunk.

#### R20 — nested ternaries become `if` blocks

**File:** 9: `agent-loop.ts:689,902,904`, `capabilities.ts:449,549`, `events.ts:726`,
`stream.ts:286,288`, `tool-loading.ts:189`.

#### R21 [consistency] — `biome.json` against the skill's baseline

**File:** `biome.json` Double quotes and width 100 against single and 120 (a reformat-only
commit touching every file); `vcs` off; `noUnused*`, `useImportType`, `noCommonJs`, `noEnum`,
`noNamespace`, `noParameterProperties`, `useFilenamingConvention` not switched on (all have
zero hits today).

#### R22 [consistency] — script names

**File:** `package.json`, the CI workflow, AGENTS.md. `lint` / `format` / `typecheck` against
the skill's `check` / `check:biome` / `check:types`.

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

### D3 [sweep] — doc blocks that are paragraphs of prose

**File:** 264 of 887 doc blocks carry prose after the summary line. The skill asks for a
summary line and tags, and AGENTS.md no longer asks for the prose. Most of it is the reason
the code exists (a server's quirk, a failure it came from), which is written nowhere else.
Surveyed, not approved: keep, trim, or move under `@remarks`.

### D4 — functions with no doc block, and blocks with no `@returns`

**File:** 51 functions have no doc block: closures inside a function (`agent-loop.ts:664`,
`events.ts:397`, `stream.ts:425`), private methods (`thinking.ts:180,201`, `spec.ts:303–343`),
and the `parse*` family in `spec.ts:361–560`. 216 documented functions have no `@returns`.
Surveyed, not approved.

### D5 — `CLAUDE.md` as a symlink to `AGENTS.md`

**File:** repo root. The skill's `git.md` asks for it; this repo has none.

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

### A2 — `prepare` or `prepack`, and the tsconfig layout

**File:** `package.json`, `tsconfig*.json`. The skill builds on `prepack` and keeps emit
options out of the base tsconfig (`module: ESNext`, `moduleResolution: bundler`, `noEmit`).
This repo builds on `prepare`, which also runs on `npm ci` and when it is installed from git,
and its base tsconfig is `NodeNext` and emits. Moving to `prepack` would stop a git install
from getting a `dist/`.
