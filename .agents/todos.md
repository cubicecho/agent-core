# Project Todos

Findings from the refactor workflow. IDs are stable — don't renumber when items are removed.
`(unverified)` marks items inferred from docs or naming rather than confirmed in code.
Nothing here is implemented until approved.

The model these items come from (M1–M6) lives in the description of PR #140.

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

Approved 2026-10-01: M1–M6, R1–R10, D1, and the sweeps R11–R14.

### R1 [reuse] — one get-or-create helper for Maps

**File:** `capabilities.ts:202`, `capabilities.ts:218`, `calibration.ts:91`, `snapshot.ts`
Four hand-written "look up, create and store if absent" blocks. Target: one helper in
`guards.ts`.

### R2 [reuse] — one way to add two usages

**File:** `agent-loop.ts` `accumulate`, `continuation.ts` `joinUsage` Two adders for the
same record, one of which mutates its argument (P8). Target: one non-mutating adder.

### R3 [consistency] — seconds to milliseconds in one place

**File:** `agent-loop.ts` (`loadingTimeoutMs`), `client.ts` `limitMs` The loop multiplies by
1000 inline where the client has a helper.

### R4 [consistency] — `ToolArgumentsError` names itself like the other errors; `Turn.toolCalls` uses `ToolCall`

**File:** `tool-calls.ts:34`, `stream.ts:168` Variants: `override readonly name` ×4,
`this.name =` ×1. Majority wins.

### R5 [reuse] — `tool-calls.ts` uses `THINK_FENCE`

**File:** `tool-calls.ts:345-346` The closing fence is spelled out beside the constant that
owns it.

### R6 [reuse] — one list of reserved body keys

**File:** `agent-loop.ts` `RESERVED`, `spec.ts` `RESERVED_BODY`

### R7 [readability] — a named blank-line separator in `tool-loading.ts`

**File:** `tool-loading.ts` seven copies of `if (lines.length) lines.push("")`.

### R8 [consistency] — named callback types for notices and notes; a named options type for `preselect`

**File:** `capabilities.ts`, `agent-loop.ts`, `side-task.ts`, `run-turn.ts`, `compaction.ts`,
`hooks.ts` `(message: string) => void` is written out nine times under two names.

### R9 [reuse] — one fallback label for an unnamed model

**File:** `continuation.ts:142`, `run-turn.ts:212`

### R10 [readability] — split the long functions where a piece earns a name

**File:** `runSteps`, `streamTurn`, `runTurn`, `resolveAgentSpec`, `watching`, `complete`
Stop when the next piece would need most of the function's locals.

### R11 [sweep] — apply P8 (never mutate parameters) across `src`

### R12 [sweep] — apply P13 (plain loops over chains) across `src`

**Hits:** 121 chain calls against 116 `for` loops; 29 chains span several lines.

### R13 [sweep] — apply P1 (name conditions) across `src`

**Hits:** about 250 of 453 `if`s test an inline comparison or compound.

### R14 [sweep] — apply P4 (`@returns`) across the public surface

AGENTS.md says prose does not restate the types, so `@returns` says what the caller has to
know and is left off where the lead sentence already says it.

---

## Tests

Surveyed, not approved.

### T1 [reuse] — shared builders for the fake client, API errors and stream chunks

**File:** `tests/*` `clientOf` in 5 files, `apiError` in 4, `chunk` in 3.

### T2 [consistency] — one layout

**File:** three files use flat `test()`, 25 use `describe`.

### T3 [readability] — `as never` casts

**File:** 19 in 8 files.

---

## Docs

### D1 — `config.ts:106` says nothing in the package asks for a value the package now reads

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
