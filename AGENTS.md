# AGENTS.md

`@cubicecho/agent-core` — the parts of an OpenAI-compatible agent loop that are the same
everywhere: client pooling, capability negotiation, retry, streaming, tool loading, run events.
ESM only, Node >= 22, `openai` as a peer dependency.

## Commands

| | |
| --- | --- |
| `npm run lint` | biome, check only |
| `npm run format` | biome, writing |
| `npm run typecheck` | tsc over src and tests |
| `npm test` | vitest, one pass |
| `npm run build` | emits `dist/`, then regenerates `llms.txt` |

`prepare` runs `build`, so `npm ci` regenerates `llms.txt` — which means CI checks it with
`git diff --exit-code -- llms.txt`, not with `npm run llms:check` (that would compare the file
against itself). Anything added to `build` runs at publish time too; keep unstable APIs out of it.

`CHANGELOG.md` and the version in `package.json` belong to semantic-release. Do not edit either.

## Documentation

**Terse prose, plus a description for every parameter.** Both halves are the convention; neither
substitutes for the other.

Prose explains *why* — the constraint, the failure it came from, the thing about the ecosystem
that is not visible in the signature. It does not restate the types, which are right there. Lead
with one sentence that stands alone, because `scripts/llms-txt.mjs` takes it verbatim as the
index entry for that export. Sentences, em-dashes, no bullet lists, no "This function ...".

`@param` on every exported function that takes one, in signature order, after the prose and a
blank `*` line. Say what the caller has to decide — what a value means, what an absent one
defaults to, what happens at the edges — not what its type already says. One line where one line
does; destructured options get a single `@param options`.

```ts
/**
 * A delay an abort cuts short, rejecting rather than resolving early.
 *
 * @param ms How long to wait.
 * @param signal Abandons the wait. One already aborted rejects without waiting at all.
 */
export const sleep = (ms: number, signal?: AbortSignal) =>
```

Every exported symbol carries a doc comment; `npm run llms` reports the count and names anything
missing. Claims in a comment are load-bearing — verify each one against the implementation before
writing it, and fix the comment when the code moves out from under it.
