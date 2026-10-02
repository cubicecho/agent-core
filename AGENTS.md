# AGENTS.md

`@cubicecho/agent-core` — the parts of an OpenAI-compatible agent loop that are the same
everywhere: client pooling, capability negotiation, retry, streaming, tool loading, run events.
Node >= 22, `openai` as a peer dependency.

The generic rules — TypeScript, Biome, doc comments, commits and releases — are in the
`cubicecho_typescript` skill, and how a refactor is run is in the `refactor` skill. This file
holds only what is true of this repo.

## Commands

| | |
| --- | --- |
| `npm run check` | `check:biome`, then `check:types` |
| `npm run check:biome` | biome, writing its fixes; CI runs `npx biome ci .`, which writes none |
| `npm run check:types` | tsc over src and tests |
| `npm test` | vitest, one pass |
| `npm run build` | emits `dist/`, then regenerates `llms.txt` |

`prepare` runs `build`, so `npm ci` regenerates `llms.txt` — which means CI checks it with
`git diff --exit-code -- llms.txt`, not with `npm run llms:check` (that would compare the file
against itself). Anything added to `build` runs at publish time too; keep unstable APIs out of it.

## Documentation

The first sentence of a doc comment stands alone, because `scripts/llms-txt.mjs` takes it
verbatim as the index entry for that export. `npm run llms` reports how many exports have one
and names any that do not.
