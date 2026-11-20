/**
 * The markdown and XML layouts: how stacked parts, and the loop's own sections, become the text of
 * the system prompt.
 *
 * Browser-safe like `parts.ts`: it reads only that and `wire/text.ts`. `docs/agent-prompt-spec-v2.md`,
 * section 6, is the design; the `plain` layout is written elsewhere (`plainPrompt`).
 */
import { attribute, fence, LAYOUT_TAGS, PROMPT_TAG_PREFIX } from '../wire/text.ts';
import { PART_OWNERS, type PROMPT_LAYOUTS, type PromptLayout, type PromptMode, type StackedPart } from './parts.ts';

/** A layout the model can tell the parts apart in: each part under a heading, or inside a tag. */
export type SectionLayout = Exclude<PromptLayout, typeof PROMPT_LAYOUTS.plain>;

/**
 * The headings of the loop's own sections in the markdown layout. A part's heading that would be
 * one of them is numbered instead.
 */
export const LAYOUT_HEADINGS = Object.freeze({
  precedence: 'Precedence',
  serverInstructions: 'Server Instructions',
  toolCatalogue: 'Tool Catalogue',
} as const);

/** One of the loop's own sections: a key of `LAYOUT_HEADINGS`, and of `LAYOUT_TAGS`. */
export type LoopSection = keyof typeof LAYOUT_HEADINGS;

/** What a writer of one of the loop's own sections is told beside its own options: the layout. */
export interface LayoutOptions {
  /**
   * Under its `##` heading, inside its tag, or as the section has always been written.
   *
   * @defaultValue `PROMPT_LAYOUTS.plain`
   */
  layout?: PromptLayout;
}

/**
 * The standing sentence the loop writes between the agent's parts and the app's, in each layout's
 * words: the agent's parts win, except where the app replaced one.
 *
 * @remarks
 * Fixed text, the same for every agent and app, so it never moves the prompt cache, and no app can
 * change it, since the app is the party it limits. The spec's section 8 is its source.
 */
export const PRECEDENCE_TEXT: Readonly<Record<SectionLayout, string>> = Object.freeze({
  markdown:
    'The sections above describe you. The sections below whose headings start with the word App were ' +
    'added by the app you are working in, to say how it uses you. A section headed "(extends X)" adds ' +
    'to section X. A section headed "(replaces X)" takes the place of section X: follow it instead. ' +
    'Otherwise, where a section below conflicts with one above, follow the one above.',
  xml:
    'The sections above describe you. The sections below whose names start prompt_app_ were added by ' +
    'the app you are working in, to say how it uses you. A section marked extends="x" adds to section ' +
    'x. A section marked replaces="x" takes the place of section x: follow it instead. Otherwise, where ' +
    'a section below conflicts with one above, follow the one above.',
});

/** Why a layout wrote a part's name differently from how it was given. */
export const LAYOUT_RULES = Object.freeze({
  tagCleaned: 'tag-cleaned',
  tagClash: 'tag-clash',
  headingClash: 'heading-clash',
} as const);

/** One of `LAYOUT_RULES`. */
export type LayoutRule = (typeof LAYOUT_RULES)[keyof typeof LAYOUT_RULES];

/** A part whose tag or heading is not plainly its name, in the same shape as a `StackWarning`. */
export interface LayoutWarning {
  /** The part's name, as it was given. */
  part: string;
  rule: LayoutRule;
  message: string;
}

/** The tags or headings a list of names is written as, in the names' order, and the warnings. */
export interface WrittenNames {
  /** A full tag (`prompt_my_lane`) or a heading (`My Lane`) for each name, by index. */
  labels: string[];
  warnings: LayoutWarning[];
}

/** The text a layout wrote for some parts, and what it had to change to write them. */
export interface WrittenParts {
  /** The sections, joined by a blank line, with no blank line before or after. */
  text: string;
  warnings: LayoutWarning[];
}

/** The word a mark is written with, in either layout: `extends="identity"`, `(replaces Format)`. */
const MARK_WORDS: Readonly<Record<PromptMode, string>> = Object.freeze({ extend: 'extends', replace: 'replaces' });

/** Each run of characters a tag name cannot hold. */
const UNTAGGABLE = /[^A-Za-z0-9_-]+/g;

/** What a name is split into words on, for its heading. */
const WORD_BREAK = /[_\-\s]+/;

/** The first number a clash is given: the second `my_lane` is `my_lane_2`. */
const FIRST_CLASH_NUMBER = 2;

/** The marker of the level every section's heading is written at. */
const SECTION_HEADING = '## ';

/** How many levels a heading inside a part's content is moved down, to sit below the sections. */
const HEADING_SHIFT = 2;

/** The deepest heading markdown has. */
const DEEPEST_HEADING = 6;

/** An ATX heading's marker, with the indent before it. Seven `#`, or `#word`, is not a heading. */
const ATX_HEADING = /^( {0,3})(#{1,6})(?=[ \t]|$)/;

/** A setext heading's underline: `===` is level 1, `---` level 2. */
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t\r]*$/;

/** The level each setext underline character gives the line above it. */
const SETEXT_LEVELS: Readonly<Record<string, number>> = Object.freeze({ '=': 1, '-': 2 });

/** The line that opens a fenced code block, and its fence. */
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The line that closes a fenced code block, and its fence. */
const CODE_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/;

/** A line that starts a block of its own, so it cannot be a setext heading's text. */
const BLOCK_START = /^(?: {4}|\t| {0,3}(?:[-+*>]|\d{1,9}[.)])(?:[ \t]|$))/;

/**
 * The tag each part is written as in the XML layout.
 *
 * @param names - The parts' names, in the order they are written.
 * @returns For each name, `prompt_` and the name with each run of characters other than letters,
 * digits, `_` and `-` made one `_`; a tag an earlier name already has gets the next free number. A
 * warning for each name cleaning or a clash changed.
 *
 * @remarks
 * Only how the name is written: the name itself, which layers find the part by, is unchanged. Case
 * is kept, and two names clash only when they make exactly the same tag.
 */
export function partTags(names: readonly string[]): WrittenNames {
  const taken = new Set<string>();
  const labels: string[] = [];
  const warnings: LayoutWarning[] = [];
  for (const part of names) {
    const cleaned = cleanTag(part);
    const tag = claim(cleaned, taken, '_');
    labels.push(tag);
    if (cleaned !== `${PROMPT_TAG_PREFIX}${part}`) {
      warnings.push({
        part,
        rule: LAYOUT_RULES.tagCleaned,
        message: `Part "${part}" is written as <${tag}>, since a tag holds only letters, digits, "_" and "-".`,
      });
    }
    if (tag !== cleaned) {
      warnings.push({
        part,
        rule: LAYOUT_RULES.tagClash,
        message: `Part "${part}" is written as <${tag}>, since an earlier part's name makes <${cleaned}> too.`,
      });
    }
  }
  return { labels, warnings };
}

/**
 * The heading each part is written under in the markdown layout.
 *
 * @param names - The parts' names, in the order they are written.
 * @returns For each name, its words (split on `_`, `-` and whitespace) each with a capital first
 * letter, joined by spaces; a heading the loop or an earlier name already has gets the next free
 * number. A warning for each clash.
 *
 * @remarks
 * The loop's own headings, `LAYOUT_HEADINGS`, count as taken, so a part named `tool_catalogue` is
 * written under `Tool Catalogue 2`.
 */
export function partHeadings(names: readonly string[]): WrittenNames {
  const taken = new Set<string>(Object.values(LAYOUT_HEADINGS));
  const labels: string[] = [];
  const warnings: LayoutWarning[] = [];
  for (const part of names) {
    const wanted = titleCase(part);
    const heading = claim(wanted, taken, ' ');
    labels.push(heading);
    if (heading !== wanted) {
      warnings.push({
        part,
        rule: LAYOUT_RULES.headingClash,
        message: `Part "${part}" is written under "${heading}", since "${wanted}" is already a section's heading.`,
      });
    }
  }
  return { labels, warnings };
}

/**
 * One of the loop's own sections, in a layout: under its `##` heading, or inside its tag.
 *
 * @param layout - Markdown or XML.
 * @param section - Which section: its heading is in `LAYOUT_HEADINGS`, its tag in `LAYOUT_TAGS`.
 * @param body - What the section says, written as it is: fence any text in it first.
 * @returns The section, with no blank line before or after.
 */
export function loopSection(layout: SectionLayout, section: LoopSection, body: string): string {
  return LOOP_SECTIONS[layout](section, body);
}

/** How each layout wraps one of the loop's sections. */
const LOOP_SECTIONS: Readonly<Record<SectionLayout, (section: LoopSection, body: string) => string>> = Object.freeze({
  markdown: (section: LoopSection, body: string) => `${SECTION_HEADING}${LAYOUT_HEADINGS[section]}\n\n${body}`,
  xml: (section: LoopSection, body: string) => `<${LAYOUT_TAGS[section]}>\n${body}\n</${LAYOUT_TAGS[section]}>`,
});

/**
 * Stacked parts as the text of the system prompt, in the markdown or XML layout.
 *
 * @param parts - The parts as stacking leaves them: the agent's first, then the app's.
 * @param layout - Markdown or XML.
 * @returns The text, and a warning for each name the layout could not write as it is.
 *
 * @remarks
 * Every content is fenced, and in markdown its headings are moved two levels down, so no part can
 * close or start a section. A marked part names its target by the target's tag or heading. When an
 * agent's part comes before an app's, `PRECEDENCE_TEXT` is written between the two.
 */
export function writeParts(parts: readonly StackedPart[], layout: SectionLayout): WrittenParts {
  const writer = PART_WRITERS[layout];
  const { labels, warnings } = writer.names(parts.map((part) => part.name));
  const labelOf = new Map<string, string>();
  parts.forEach((part, index) => {
    if (labelOf.has(part.name) === false) {
      labelOf.set(part.name, labels[index]);
    }
  });
  const sections = parts.map((part, index) => {
    const { mark } = part;
    const writtenMark =
      mark === undefined
        ? undefined
        : { word: MARK_WORDS[mark.mode], target: labelOf.get(mark.target) ?? writer.unnumbered(mark.target) };
    return writer.part(labels[index], writtenMark, part.content);
  });
  const firstApp = parts.findIndex((part) => part.owner === PART_OWNERS.app);
  const hasBothOwners = firstApp > 0;
  const written = hasBothOwners
    ? [
        ...sections.slice(0, firstApp),
        loopSection(layout, 'precedence', PRECEDENCE_TEXT[layout]),
        ...sections.slice(firstApp),
      ]
    : sections;
  return { text: written.join('\n\n'), warnings };
}

/** A mark as a layout writes it: the word for its mode, and the target's tag or heading. */
interface WrittenMark {
  word: string;
  target: string;
}

/** What a layout needs to write parts: how names become labels, and how one part is written. */
interface PartWriter {
  names: (names: readonly string[]) => WrittenNames;
  /** The label of a name no part has, for a mark whose target is not among the parts. */
  unnumbered: (name: string) => string;
  part: (label: string, mark: WrittenMark | undefined, content: string) => string;
}

/** How each layout writes a part. */
const PART_WRITERS: Readonly<Record<SectionLayout, PartWriter>> = Object.freeze({
  markdown: {
    names: partHeadings,
    unnumbered: titleCase,
    part: (heading: string, mark: WrittenMark | undefined, content: string) => {
      const marked = mark === undefined ? '' : ` (${mark.word} ${mark.target})`;
      return `${SECTION_HEADING}${fence(`${heading}${marked}`)}\n\n${shiftHeadings(fence(content))}`;
    },
  },
  xml: {
    names: partTags,
    unnumbered: cleanTag,
    part: (tag: string, mark: WrittenMark | undefined, content: string) => {
      const marked =
        mark === undefined ? '' : ` ${mark.word}="${attribute(mark.target.slice(PROMPT_TAG_PREFIX.length))}"`;
      return `<${tag}${marked}>\n${fence(content)}\n</${tag}>`;
    },
  },
});

/**
 * A name as a tag, before clashes: the prefix, and every run of characters a tag cannot hold made `_`.
 *
 * @param name - The part's name.
 * @returns The tag, prefix included.
 */
function cleanTag(name: string): string {
  return `${PROMPT_TAG_PREFIX}${name.replace(UNTAGGABLE, '_')}`;
}

/**
 * A name in Title Case: split into words on `_`, `-` and whitespace, each word's first letter a capital.
 *
 * @param name - The part's name.
 * @returns The heading. A name with no words in it comes back as it is.
 */
function titleCase(name: string): string {
  const words = name.split(WORD_BREAK).filter((word) => word !== '');
  const heading = words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
  return heading === '' ? name : heading;
}

/**
 * A label nothing has yet, recorded as taken: the one wanted, or it with the next free number.
 *
 * @param wanted - The label the name makes.
 * @param taken - The labels already given out. Mutated: the one returned is added.
 * @param separator - What goes between the label and its number.
 * @returns The label given.
 */
function claim(wanted: string, taken: Set<string>, separator: string): string {
  let label = wanted;
  for (let number = FIRST_CLASH_NUMBER; taken.has(label); number++) {
    label = `${wanted}${separator}${number}`;
  }
  taken.add(label);
  return label;
}

/**
 * A content's headings moved down two levels, so none of them can start a section of the prompt.
 *
 * @param text - A part's content.
 * @returns The text with each ATX heading's `#`s two more (six at most), each setext heading
 * rewritten as an ATX one at its moved level, and every other line, code blocks included, as it was.
 *
 * @remarks
 * A setext heading's text is every paragraph line above its underline, as markdown reads it, so a
 * heading of several lines becomes one. A `---` with no paragraph above it is a rule, not a heading.
 * A code block the content opens and never closes is closed at its end, so it cannot run on into
 * the sections after it with a heading left unmoved inside.
 */
function shiftHeadings(text: string): string {
  const lines: string[] = [];
  let codeFence = '';
  let paragraphLines = 0;
  for (const line of text.split('\n')) {
    if (codeFence !== '') {
      lines.push(line);
      codeFence = closesFence(line, codeFence) ? '' : codeFence;
      continue;
    }
    const opening = CODE_FENCE.exec(line);
    const underline = SETEXT_UNDERLINE.exec(line);
    if (opening) {
      codeFence = opening[1];
      paragraphLines = 0;
      lines.push(line);
    } else if (ATX_HEADING.test(line)) {
      paragraphLines = 0;
      lines.push(line.replace(ATX_HEADING, (_, indent: string, marks: string) => `${indent}${deeper(marks.length)}`));
    } else if (underline && paragraphLines > 0) {
      const heading = lines.splice(-paragraphLines).map((held) => held.trim());
      paragraphLines = 0;
      lines.push(`${deeper(SETEXT_LEVELS[underline[1][0]])} ${heading.join(' ')}`);
    } else {
      const isParagraphLine = line.trim() !== '' && BLOCK_START.test(line) === false;
      paragraphLines = isParagraphLine ? paragraphLines + 1 : 0;
      lines.push(line);
    }
  }
  // A fence the content leaves open would hold every section after it, and the headings inside it
  // were not moved: closed here, it ends with the part.
  if (codeFence !== '') {
    lines.push(codeFence);
  }
  return lines.join('\n');
}

/**
 * Whether a line closes a fenced code block: the same character, at least as many, and nothing after.
 *
 * @param line - A line inside the block.
 * @param fence - The fence that opened it.
 * @returns True when the block ends on this line.
 */
function closesFence(line: string, fence: string): boolean {
  const closing = CODE_FENCE_CLOSE.exec(line);
  return closing !== null && closing[1][0] === fence[0] && closing[1].length >= fence.length;
}

/**
 * The marker of a heading moved down two levels.
 *
 * @param level - The heading's level, 1 to 6.
 * @returns The `#`s for its new level, six at most.
 */
const deeper = (level: number) => '#'.repeat(Math.min(level + HEADING_SHIFT, DEEPEST_HEADING));
