/**
 * The words an agent's prompt parts are described in: the modes a part changes another by, the
 * layouts parts are written in, who wrote a part, and the shape stacking leaves parts in.
 *
 * A leaf: the document module, stacking and the layouts all read it, and it reads nothing, so the
 * `./spec` subpath stays browser-safe. `docs/agent-prompt-spec-v2.md` is the design.
 */

/** How a part changes the part with its name in a layer below: adds to it, or takes its place. */
export const PROMPT_MODES = Object.freeze({ extend: 'extend', replace: 'replace' } as const);

/** One of `PROMPT_MODES`. */
export type PromptMode = (typeof PROMPT_MODES)[keyof typeof PROMPT_MODES];

/** How the parts are written into the text the model reads. `plain` is the default. */
export const PROMPT_LAYOUTS = Object.freeze({ plain: 'plain', markdown: 'markdown', xml: 'xml' } as const);

/** One of `PROMPT_LAYOUTS`. */
export type PromptLayout = (typeof PROMPT_LAYOUTS)[keyof typeof PROMPT_LAYOUTS];

/** The roles a part may have, as a chat message's. Both are written into the system prompt alike. */
export const PROMPT_ROLES = Object.freeze({ system: 'system', developer: 'developer' } as const);

/** One of `PROMPT_ROLES`. */
export type PromptRole = (typeof PROMPT_ROLES)[keyof typeof PROMPT_ROLES];

/** Who wrote a part: the agent's author, or the app using the agent. */
export const PART_OWNERS = Object.freeze({ agent: 'agent', app: 'app' } as const);

/** One of `PART_OWNERS`. */
export type PartOwner = (typeof PART_OWNERS)[keyof typeof PART_OWNERS];

/** What stacking puts in front of every name an app sends: `lane` becomes `app_lane`. */
export const APP_PART_PREFIX = 'app_';

/** The part a request's leading system messages become, after the app's other parts. */
export const APP_SYSTEM_PART = 'app_system';

/** A part as stacking leaves it, ready for a layout to write. */
export interface StackedPart {
  role: PromptRole;
  /** Its own name: `identity`, `identity_2` for a part extending it, `app_lane`, `app_system`. */
  name: string;
  /** The text. Never empty: a deleted part is not stacked. */
  content: string;
  owner: PartOwner;
  /** The part this one adds to or takes the place of, by that part's name. */
  mark?: { mode: PromptMode; target: string };
  /** On an agent's part, the modes an app may use on it. Absent is `["extend"]`; `[]` locks it. */
  allowedModes?: readonly PromptMode[];
}

/** Why stacking dropped an app's part. */
export const STACK_RULES = Object.freeze({
  extendNotAllowed: 'extend-not-allowed',
  replaceNotAllowed: 'replace-not-allowed',
  reservedName: 'reserved-name',
} as const);

/** One of `STACK_RULES`. */
export type StackRule = (typeof STACK_RULES)[keyof typeof STACK_RULES];

/** A part stacking dropped, and why: what a reply's `agent_core.warnings` carries. */
export interface StackWarning {
  /** The name the app gave the part, before the prefix. */
  part: string;
  rule: StackRule;
  message: string;
}
