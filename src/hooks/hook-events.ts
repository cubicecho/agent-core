/**
 * The points in a session a hook can be bound to, apart from everything that runs one.
 *
 * A leaf with no imports, because two modules need these lists and only one of them may load
 * `node:crypto`: `hooks.ts` hashes a message into the uuid a memory server dedups on, and `spec.ts`
 * has to stay importable in a browser. Before this each kept its own copy, with a test holding
 * one pair together and nothing holding the other.
 */

/**
 * The points in a session a hook can be bound to, in the order a session meets them.
 *
 * @remarks
 * Named after Claude Code's hooks of the same shape, which each member names, plus
 * `sessionDelete`, which has no counterpart there.
 */
export const HookEvent = {
  /** A session opened. Claude Code's SessionStart. */
  SessionStart: 'sessionStart',
  /** An exchange is about to begin. Claude Code's UserPromptSubmit. */
  BeforeExchange: 'beforeExchange',
  /** An exchange was answered. Claude Code's Stop. */
  AfterExchange: 'afterExchange',
  /** Part of the transcript is about to be summarised away. Claude Code's PreCompact. */
  BeforeCompact: 'beforeCompact',
  /** A session closed. Claude Code's SessionEnd. */
  SessionEnd: 'sessionEnd',
  /** The app deleted a session's record. */
  SessionDelete: 'sessionDelete',
  /**
   * `BeforeExchange`, under its name before 5.0.0. It holds the new name, `'beforeExchange'`.
   *
   * @deprecated Use `HookEvent.BeforeExchange`.
   */
  BeforeTurn: 'beforeExchange',
  /**
   * `AfterExchange`, under its name before 5.0.0. It holds the new name, `'afterExchange'`.
   *
   * @deprecated Use `HookEvent.AfterExchange`.
   */
  AfterTurn: 'afterExchange',
} as const;

/** Any one of the events in `HookEvent`. */
export type HookEvent = (typeof HookEvent)[keyof typeof HookEvent];

/** Every event a hook can be bound to, each once, in the order a session meets them. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  HookEvent.SessionStart,
  HookEvent.BeforeExchange,
  HookEvent.AfterExchange,
  HookEvent.BeforeCompact,
  HookEvent.SessionEnd,
  HookEvent.SessionDelete,
];

/**
 * The events whose hooks run before a request, and so the only ones whose output can reach it.
 * Anything later runs once the model has already answered.
 */
export const INJECT_EVENTS: ReadonlySet<HookEvent> = new Set([HookEvent.SessionStart, HookEvent.BeforeExchange]);

/**
 * The exchange events under their names before 5.0.0, each to the name it has now.
 *
 * @remarks
 * Agent documents saved before the rename say these, and `parseSpec` reads them forever.
 */
export const LEGACY_HOOK_EVENTS: ReadonlyMap<string, HookEvent> = new Map([
  ['beforeTurn', HookEvent.BeforeExchange],
  ['afterTurn', HookEvent.AfterExchange],
]);
