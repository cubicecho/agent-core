/**
 * The `@cubicecho/agent-core/spec` entry: an agent as a document, and what it falls back to.
 *
 * The second file in the package that re-exports, after `src/index.ts`. The subpath used to serve
 * `spec.ts` itself, which made the fallbacks `resolveAgentSpec` reads a constant of that module;
 * they are `AGENT_DEFAULTS` in `core/defaults.ts` now, beside every other group, and this entry
 * puts them back on the subpath. Everything here is browser-safe: `spec.ts` and `defaults.ts`
 * import nothing that needs Node.
 */

export { AGENT_DEFAULTS, type AgentSettings } from '../core/defaults.ts';
export * from './parts.ts';
export * from './spec.ts';
