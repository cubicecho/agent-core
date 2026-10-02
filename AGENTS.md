# AGENTS.md

`@cubicecho/agent-core` — the parts of an OpenAI-compatible agent loop that are the same
everywhere: client pooling, capability negotiation, retry, streaming, tool loading, run events.
Node >= 22, `openai` as a peer dependency.

The generic rules — TypeScript, Biome, doc comments, commits and releases — are in the
`cubicecho_typescript` skill, and how a refactor is run is in the `coding-standards` skill. This file
holds only what is true of this repo.

## Commands

| | |
| --- | --- |
| `npm run check` | `check:biome`, then `check:types` |
| `npm run check:biome` | biome, writing its fixes; CI runs `npx biome ci .`, which writes none |
| `npm run check:types` | `tsc --noEmit` over src, tests and bench |
| `npm test` | vitest, one pass |
| `npm run build` | emits `dist/`, then regenerates `llms.txt` |

`prepack` runs `build`, so the package is built when it is packed or published and not on
`npm ci`. CI runs `npm run build` itself and then checks `llms.txt` with
`git diff --exit-code -- llms.txt`, not with `npm run llms:check` (that would compare the file
against the one the build just wrote). Anything added to `build` runs at publish time too; keep
unstable APIs out of it. An install from a git URL gets no `dist/`: install from npm.

`tsconfig.json` checks everything and emits nothing; `tsconfig.build.json` is the only config
that emits.

## Layout

`src/` has one folder for each concept the package is about, and a module lives in the folder of
the concept it is part of. `tests/` has the same folders: the test for `src/endpoint/client.ts` is
`tests/endpoint/client.test.ts`.

| Folder | The concept | Modules |
| --- | --- | --- |
| `core` | what every other folder shares, and no concept of its own | `guards` `platform` `digest` `scope` `config` |
| `wire` | what is sent, what comes back, and how it fails | `wire` `stream` `thinking` `tool-calls` `tokens` `retry` `errors` |
| `endpoint` | one server, and what it turned out to support | `client` `capabilities` `calibration` `schema-compat` |
| `turn` | one request, negotiated and retried | `run-turn` `continuation` `side-task` |
| `tools` | which tools the model is shown | `catalog` `tool-loading` `preselect` |
| `hooks` | what a host is told, and what it may inject | `hooks` `hook-events` |
| `context` | keeping a run inside its window | `ledger` `compaction` |
| `run` | the loop, and watching it | `agent-loop` `run-calls` `request-body` `events` |
| `runtime` | the process's state: scoping it, clearing it, saving it | `runtime` `reset` `snapshot` |
| `spec` | an agent as a document | `spec` |

`src/index.ts` is the only file that re-exports. A folder has no `index.ts` of its own; a module
imports another by its full path (`../core/guards.ts`). Biome sorts the exports in `index.ts` by
path, so they are grouped by folder, and `llms.txt` lists them in that order.

`tests/helpers.ts` and `tests/refusals.ts` are at the root of `tests/` because every folder uses
them. A test that covers two modules sits with the one that calls the other.

## Documentation

The first sentence of a doc comment stands alone, because `scripts/llms-txt.mjs` takes it
verbatim as the index entry for that export. `npm run llms` reports how many exports have one
and names any that do not.
