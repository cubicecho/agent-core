/**
 * The points in a session a hook can be bound to, apart from everything that runs one.
 *
 * A leaf with no imports, because two modules need these lists and only one of them may load
 * `node:crypto`: `hooks.ts` hashes a turn into the uuid a memory server dedups on, and `spec.ts`
 * has to stay importable in a browser. Before this each kept its own copy, with a test holding
 * one pair together and nothing holding the other.
 */

/**
 * A point in a session a hook can be bound to. Named after Claude Code's hooks of the same shape
 * — `sessionStart` (SessionStart), `beforeTurn` (UserPromptSubmit), `afterTurn` (Stop),
 * `beforeCompact` (PreCompact), `sessionEnd` (SessionEnd) — plus `sessionDelete`, for when the host
 * deletes a session's record.
 */
export type HookEvent =
  | "sessionStart"
  | "beforeTurn"
  | "afterTurn"
  | "beforeCompact"
  | "sessionEnd"
  | "sessionDelete";

/** Every event a hook can be bound to, in the order a session meets them. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "sessionStart",
  "beforeTurn",
  "afterTurn",
  "beforeCompact",
  "sessionEnd",
  "sessionDelete",
];

/**
 * The events whose hooks run before a request, and so the only ones whose output can reach it.
 * Anything later runs once the model has already answered.
 */
export const INJECT_EVENTS: ReadonlySet<HookEvent> = new Set(["sessionStart", "beforeTurn"]);
