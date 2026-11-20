import { PROMPT_MODES, type StackedPart } from './parts.ts';

/**
 * Stacked prompt parts: how one that extends or replaces another is named, and how the plain
 * layout writes them.
 *
 * Browser-safe, as the rest of `src/spec/` is: it reads only `parts.ts`. `docs/agent-prompt-spec-v2.md`
 * is the design, sections 2 and 4.
 */

/** The number the first part extending or replacing another takes: `identity_2`, a second `identity`. */
const FIRST_NUMBER = 2;

/** What `plainPrompt` puts between two parts. */
const PART_SEPARATOR = '\n\n';

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
