import {
  APP_PART_PREFIX,
  APP_SYSTEM_PART,
  PART_OWNERS,
  PROMPT_MODES,
  PROMPT_ROLES,
  type PromptMode,
  type PromptRole,
  STACK_RULES,
  type StackedPart,
  type StackRule,
  type StackWarning,
} from './parts.ts';

/**
 * Stacked prompt parts: an app's put on top of an agent's, how a part extending or replacing
 * another is named, and how the plain layout writes them.
 *
 * Browser-safe, as the rest of `src/spec/` is: it reads only `parts.ts`. `docs/agent-prompt-spec-v2.md`
 * is the design, sections 2 to 4.
 */

/** The number the first part extending or replacing another takes: `identity_2`, a second `identity`. */
const FIRST_NUMBER = 2;

/** What `plainPrompt` puts between two parts. */
const PART_SEPARATOR = '\n\n';

/** One part an app sends in a request's `agent_core.prompt`, for stacking on top of the agent's. */
export interface AppPart {
  /** As a chat message's. Both are written into the system prompt the same way. */
  role: PromptRole;
  /**
   * What the part is for, written plain, since stacking puts `app_` in front. With a mode, it names
   * the agent's part it changes.
   */
  name: string;
  /** The text. An empty one is dropped. */
  content: string;
  /** How it changes the agent's part with its name, where that part allows it. Absent adds a part. */
  mode?: PromptMode;
}

/** What `stackAppParts` hands back. */
export interface StackedPrompt {
  /** The agent's parts, then the app's, then `app_system`. */
  parts: StackedPart[];
  /** The app's parts that were dropped, and why. */
  warnings: StackWarning[];
}

/** The modes an app may use on an agent's part that lists none. */
const DEFAULT_ALLOWED_MODES: readonly PromptMode[] = Object.freeze([PROMPT_MODES.extend]);

/** The app part name that would become `APP_SYSTEM_PART`, and so is kept for the system messages. */
const RESERVED_APP_NAME = APP_SYSTEM_PART.slice(APP_PART_PREFIX.length);

/** The rule an app's part breaks by using a mode the agent's part does not allow. */
const NOT_ALLOWED_BY_MODE = {
  [PROMPT_MODES.extend]: STACK_RULES.extendNotAllowed,
  [PROMPT_MODES.replace]: STACK_RULES.replaceNotAllowed,
} satisfies Record<PromptMode, StackRule>;

/**
 * Puts an app's parts on top of an agent's, holding them to what each of the agent's parts allows.
 *
 * @param agent - The agent's parts, as `resolveAgentSpec` stacks them. Empty for a model with no agent.
 * @param app - The app's parts, in the order the request sent them.
 * @param [systemMessages] - The request's leading system messages, joined into one text.
 * @returns New parts in order (the agent's, the app's, then `app_system`) and the app's parts dropped.
 *
 * @remarks
 * Every app name gets `APP_PART_PREFIX`, so an app's part never meets an agent's: with no mode it is
 * an added part. With a mode on a name the agent has, it is marked against that part where the part's
 * `allowedModes` lists the mode, and dropped with a warning where it does not. A part with empty
 * content is dropped silently, the name `system` with a warning, and a repeated name is numbered.
 */
export function stackAppParts(
  agent: readonly StackedPart[],
  app: readonly AppPart[],
  systemMessages = '',
): StackedPrompt {
  const agentParts = new Map(agent.map((part) => [part.name, part]));
  const taken = new Set(agentParts.keys());
  const parts = agent.map((part) => ({ ...part }));
  const warnings: StackWarning[] = [];

  for (const part of app) {
    const isEmpty = part.content.trim() === '';
    if (isEmpty) {
      continue;
    }
    const isReserved = part.name.toLowerCase() === RESERVED_APP_NAME;
    if (isReserved) {
      const message = `The name "${part.name}" is kept for the request's system messages, so the part was dropped.`;
      warnings.push({ part: part.name, rule: STACK_RULES.reservedName, message });
      continue;
    }

    const { mode } = part;
    const target = agentParts.get(part.name);
    const isMarked = mode !== undefined && target !== undefined;
    const isRefused = isMarked && (target.allowedModes ?? DEFAULT_ALLOWED_MODES).includes(mode) === false;
    if (isRefused) {
      const message = `The agent's ${part.name} part does not let an app ${mode} it, so the part was dropped.`;
      warnings.push({ part: part.name, rule: NOT_ALLOWED_BY_MODE[mode], message });
      continue;
    }

    const prefixed = `${APP_PART_PREFIX}${part.name}`;
    const name = taken.has(prefixed) ? numberedName(prefixed, taken) : prefixed;
    taken.add(name);
    const stacked: StackedPart = { role: part.role, name, content: part.content, owner: PART_OWNERS.app };
    if (isMarked) {
      stacked.mark = { mode, target: target.name };
    }
    parts.push(stacked);
  }

  const hasSystemMessages = systemMessages.trim() !== '';
  if (hasSystemMessages) {
    parts.push({ role: PROMPT_ROLES.system, name: APP_SYSTEM_PART, content: systemMessages, owner: PART_OWNERS.app });
  }
  return { parts, warnings };
}

/**
 * The name a part extending or replacing another takes: the name it names, numbered.
 *
 * @param name - The name the part names: `identity`.
 * @param taken - The names already in use, a deleted one's included.
 * @returns The name with the first free number from 2 after it: `identity_2`, else `identity_3`.
 */
export function numberedName(name: string, taken: { has(name: string): boolean }): string {
  let number = FIRST_NUMBER;
  while (taken.has(`${name}_${number}`)) {
    number += 1;
  }
  return `${name}_${number}`;
}

/**
 * Writes stacked parts as the plain layout does: their contents, trimmed, joined by blank lines.
 *
 * @param parts - The parts, in order. Not written to.
 * @returns The text. Empty where no part has any.
 *
 * @remarks
 * The plain layout has no tags to tell the model which of two texts wins, so a part a later part
 * replaces is written with the replacer's content in its own place, the last replacer winning, and
 * the replacer is not written again. An extending part is written where it stands, so parts that
 * use no mode give exactly the texts joined by hand.
 */
export function plainPrompt(parts: readonly StackedPart[]): string {
  const firstIndex = new Map<string, number>();
  for (const [index, part] of parts.entries()) {
    if (firstIndex.has(part.name) === false) {
      firstIndex.set(part.name, index);
    }
  }

  // By the name of the part each replaces; a later replacer of the same part overwrites an earlier one.
  const replacerOf = new Map<string, StackedPart>();
  const replacers = new Set<StackedPart>();
  for (const [index, part] of parts.entries()) {
    const { mark } = part;
    const targetIndex = mark && firstIndex.get(mark.target);
    const replacesEarlierPart = mark?.mode === PROMPT_MODES.replace && targetIndex !== undefined && targetIndex < index;
    if (replacesEarlierPart) {
      replacerOf.set(mark.target, part);
      replacers.add(part);
    }
  }

  /**
   * The content written in a part's place: the last replacer's, followed down a chain of them.
   *
   * @param part - A part that is written in its own place.
   * @returns The content to write there.
   */
  const contentOf = (part: StackedPart) => {
    const seen = new Set<StackedPart>();
    let current = part;
    let replacer = replacerOf.get(current.name);
    while (replacer && seen.has(replacer) === false) {
      seen.add(current);
      current = replacer;
      replacer = replacerOf.get(current.name);
    }
    return current.content;
  };

  return parts
    .filter((part) => replacers.has(part) === false)
    .map((part) => contentOf(part).trim())
    .filter(Boolean)
    .join(PART_SEPARATOR);
}
