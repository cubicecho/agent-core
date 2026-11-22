import type OpenAI from 'openai';
import { isRecord } from '../core/guards.ts';
import { loopSection, PRECEDENCE_TEXT, writeParts } from '../spec/layout.ts';
import { APP_SYSTEM_PART, PART_OWNERS, PROMPT_LAYOUTS, type PromptLayout, type StackedPart } from '../spec/parts.ts';
import { parseAppParts } from '../spec/spec.ts';
import { plainPrompt, stackAppParts } from '../spec/stack.ts';
import { textOf } from '../wire/text.ts';
import { Role } from '../wire/wire.ts';
import { PROGRESS_FIELD } from './remote.ts';

/**
 * How the loop turns an app's prompt into one system message: the agent's parts and the app's,
 * stacked, then written in the agent's layout with the loop's own sections before `app_system`.
 *
 * `docs/agent-prompt-spec-v2.md` is the design: sections 4 (stacking), 6 (layouts) and 7 (order).
 */

/** What joins a request's leading system messages into `app_system`. */
const SYSTEM_JOIN = '\n\n';

/**
 * The roles whose leading messages become `app_system`: `developer` is an app's system prompt under
 * the newer name, and is the app's to say just as a `system` message is.
 */
const SYSTEM_ROLES: ReadonlySet<string> = new Set([Role.System, Role.Developer]);

/** An app's prompt, stacked and ready to write. */
export interface StackedRequest {
  /** A prompt given as one string, written as it is, before every part. Empty when parts were given. */
  lead: string;
  /** The agent's parts, the app's, and `app_system` last when the request had system messages. */
  parts: StackedPart[];
  /** How many of the conversation's first messages became `app_system`, to leave out of the request. */
  leading: number;
  /** What reading and stacking the app's parts dropped, in plain words. */
  warnings: string[];
}

/**
 * An app's prompt stacked: the agent's parts, the parts under `agent_core.prompt`, and the
 * conversation's leading system messages as `app_system`.
 *
 * @param systemPrompt - The loop's `systemPrompt`: one string, used as it is, or the agent's parts.
 * @param agentCore - The request's `agent_core` field, if any. Its `prompt` is read; the rest is
 * not this function's.
 * @param messages - The conversation. Its leading `system` and `developer` messages are read, not
 * written to. Pass none where they are the server's to read, as a remote agent's are.
 * @returns The stacked parts, the count of leading messages they took in, and every warning.
 */
export function stackRequest(
  systemPrompt: string | readonly StackedPart[],
  agentCore: unknown,
  messages: readonly OpenAI.ChatCompletionMessageParam[],
): StackedRequest {
  const agent = typeof systemPrompt === 'string' ? [] : systemPrompt;
  const lead = typeof systemPrompt === 'string' ? systemPrompt : '';
  const read = parseAppParts(isRecord(agentCore) ? agentCore.prompt : undefined);
  let leading = 0;
  while (leading < messages.length && SYSTEM_ROLES.has(messages[leading].role)) {
    leading += 1;
  }
  const systemText = messages
    .slice(0, leading)
    .map((message) => textOf(message.content))
    .join(SYSTEM_JOIN);
  const stacked = stackAppParts(agent, read.parts, systemText);
  const warnings = [...read.warnings.map((text) => `agent_core.${text}`), ...stacked.warnings.map((w) => w.message)];
  return { lead, parts: stacked.parts, leading, warnings };
}

/**
 * The system prompt stacked parts make, in order: the given string, the parts in the layout, the
 * loop's own sections, then `app_system`.
 *
 * @param stacked - What `stackRequest` gave.
 * @param layout - How the parts are written.
 * @param sections - The loop's sections, server instructions then catalogue, already written in
 * the same layout. Empty ones are left out.
 * @returns The text, blank-line separated, and the layout's warnings in plain words.
 *
 * @remarks
 * `app_system` comes last because it is what changes most: a chat client rewrites its system
 * message with the time and its memories, and written last a change costs the cache only what comes
 * after it. `<precedence>` sits between the agent's parts and the app's wherever the app has any,
 * `app_system` included. In `plain` there is no precedence, and a replace is an overwrite.
 */
export function writeSystemPrompt(
  stacked: StackedRequest,
  layout: PromptLayout,
  sections: readonly string[],
): { text: string; warnings: string[] } {
  const appSystem = stacked.parts.find((part) => part.name === APP_SYSTEM_PART && part.owner === PART_OWNERS.app);
  const body = stacked.parts.filter((part) => part !== appSystem);
  const pieces =
    layout === PROMPT_LAYOUTS.plain
      ? { head: [plainPrompt(body)], tail: appSystem?.content.trim() ?? '', warnings: [] }
      : laidOut(body, appSystem, layout);
  const text = [stacked.lead, ...pieces.head, ...sections, pieces.tail]
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .join('\n\n');
  return { text, warnings: pieces.warnings };
}

/**
 * The parts in the markdown or XML layout, with `app_system` written apart so it can go last.
 *
 * @param body - Every part but `app_system`.
 * @param appSystem - `app_system`, if the request had system messages.
 * @param layout - Markdown or XML.
 * @returns The head, the tail, and the layout's warnings in plain words.
 */
function laidOut(body: readonly StackedPart[], appSystem: StackedPart | undefined, layout: 'markdown' | 'xml') {
  const written = writeParts(body, layout);
  const hasAgentParts = body.some((part) => part.owner === PART_OWNERS.agent);
  const hasAppParts = body.some((part) => part.owner === PART_OWNERS.app);
  // `writeParts` puts the sentence before the first app part; with `app_system` the only one, it
  // has none to go before, so it is written here, straight after the agent's parts.
  const precedence =
    appSystem !== undefined && hasAgentParts && hasAppParts === false
      ? loopSection(layout, 'precedence', PRECEDENCE_TEXT[layout])
      : '';
  const tail = appSystem === undefined ? undefined : writeParts([appSystem], layout);
  const warnings = [...written.warnings, ...(tail?.warnings ?? [])].map((warning) => warning.message);
  return { head: [written.text, precedence], tail: tail?.text ?? '', warnings };
}

/**
 * A request body without its `agent_core` field, for a model that is not an agent.
 *
 * @param extraBody - The config's `extraBody`. Not written to.
 * @returns `extraBody` itself where it has no `agent_core`, and otherwise a copy without it.
 */
export function withoutAgentCore(extraBody: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (extraBody === undefined || PROGRESS_FIELD in extraBody === false) {
    return extraBody;
  }
  const { [PROGRESS_FIELD]: _taken, ...rest } = extraBody;
  return rest;
}
