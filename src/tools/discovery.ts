import type OpenAI from 'openai';
import type { Endpoint, ToolPolicy } from '../core/config.ts';
import { ToolDiscovery } from '../core/config.ts';
import type { OnNotice } from '../endpoint/capabilities.ts';
import { type SideTask, taskCall } from '../turn/side-task.ts';
import { PartType, Role } from '../wire/wire.ts';
import type { CatalogServer } from './catalog.ts';
import { type KeywordPreselectOptions, preselect } from './preselect.ts';

/**
 * How a run finds its tools: every definition each time, loaded from the catalogue when asked
 * for, or loaded and called through two fixed tools; and the shortlist it opens with.
 */

/** What choosing a run's discovery mode and shortlist reads of the run's options. */
export interface DiscoveryOptions {
  /** The run's config, read for the mode, the preselector it names and its own endpoint and model. */
  config: Endpoint & { model: string; tasks?: Readonly<Record<string, SideTask>> } & Partial<
      Pick<ToolPolicy, 'toolDiscovery' | 'toolSelectModel'>
    >;
  /** The transcript, whose last user message is what a preselection is asked about. */
  messages: readonly OpenAI.ChatCompletionMessageParam[];
  /** The connected servers' tools. Empty is eager, whatever the mode says. */
  catalog?: CatalogServer[];
  /** Tools carried from an earlier question. */
  loaded?: Iterable<string>;
  /** A shortlist the host already chose. Given, empty included, nothing is asked. */
  preselected?: readonly string[];
  /** Has the loop make the preselection itself; an object passes `keywords` and `maxPerLoad` through. */
  preselect?: boolean | { keywords?: boolean | KeywordPreselectOptions; maxPerLoad?: number };
  /** What the preselection is asked about, in place of the last user message's text. */
  preselectQuery?: string;
  /** Abandons the preselection. */
  signal?: AbortSignal;
}

/** How a run finds its tools, and what it starts with in hand. See `discoverTools`. */
export interface Discovered {
  /** Proxied: definitions come back as `load_tools` results and run through `call_tool`. */
  proxied: boolean;
  /** On demand or proxied, with a catalogue to load from. */
  onDemand: boolean;
  /** What was carried and then the shortlist. Empty when eager or proxied. */
  loaded: Set<string>;
  /** The shortlist. Empty in eager mode. */
  preselected: string[];
}

/**
 * A message's words, as the preselector is asked about them: its string, or its text parts.
 *
 * @param message - The message to read. Absent, or with content that is neither a string nor
 * parts, reads as empty.
 * @returns The string as it is, or the text parts joined by newlines with parts of any other kind
 * left out. Not trimmed.
 */
const userText = (message: OpenAI.ChatCompletionMessageParam | undefined): string => {
  const content = message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.flatMap((part) => (part.type === PartType.Text ? part.text : [])).join('\n');
};

/**
 * The loop's own preselection: by the task where the config carries one, and by the flattened
 * name on its own endpoint where it does not.
 *
 * @param options - The run's options. Read for the config, the catalogue, the signal, what
 * `preselect` passes through, and `preselectQuery` or else the last user message, whose text is
 * what is asked about.
 * @param notice - Hears the preselector's notices, a failure among them.
 * @returns The names picked. Empty where the query is blank or there is no user message — nothing
 * is asked — and where the preselection picked nothing or failed. An aborted request still rejects.
 *
 * @remarks
 * With no preselector named the main model is asked, on the config's own endpoint.
 */
async function chooseTools(options: DiscoveryOptions, notice: OnNotice): Promise<string[]> {
  const { config, catalog = [], signal } = options;
  const prompt = options.preselectQuery ?? userText(options.messages.findLast((message) => message.role === Role.User));
  if (!prompt.trim()) {
    return [];
  }
  const asked = {
    ...(typeof options.preselect === 'object' ? options.preselect : {}),
    signal,
    onNotice: notice,
  };
  const selector = config.tasks?.toolSelect;
  if (!selector?.model) {
    return preselect(config, config.toolSelectModel || config.model, catalog, prompt, asked);
  }
  const call = taskCall(selector, asked, config);
  return preselect(call.endpoint, call.model, catalog, prompt, call.options);
}

/** What opens the notice naming the loop's own picks, ahead of the names. */
export const PRESELECTED_NOTICE = 'tools picked before the run: ';

/**
 * How this run finds its tools, and what it starts with in hand: the loop's own preselection
 * where it was asked for and the host has not already decided, and what an earlier question
 * carried over.
 *
 * @param options - The run's options. Read for the discovery mode, the catalogue, `loaded`,
 * `preselected` and `preselect`.
 * @param notice - Hears what the loop's own preselection has to say, and then what it picked,
 * by name. A shortlist the host gave is not told back to it.
 * @returns `proxied` and `onDemand`, the second true of both modes and both false where `catalog`
 * is empty; `preselected`, the shortlist, empty in eager mode; and `loaded`, a new set of what was
 * carried and then the shortlist — empty when eager or proxied.
 */
export async function discoverTools(options: DiscoveryOptions, notice: OnNotice): Promise<Discovered> {
  const { config, catalog = [] } = options;
  // On demand, but with a tool array that never changes: definitions come back as `load_tools`
  // results and run through `call_tool`. `onDemand` is true of both.
  const proxied = config.toolDiscovery === ToolDiscovery.Proxy && catalog.length > 0;
  const onDemand = proxied || (config.toolDiscovery === ToolDiscovery.OnDemand && catalog.length > 0);
  // Proxied, `loaded` is what this run has put a definition in the history for, and starts empty.
  const loaded = new Set(onDemand && !proxied ? (options.loaded ?? []) : []);
  const chooses = options.preselect && options.preselected === undefined;
  let preselected: string[] = [];
  if (onDemand && chooses) {
    preselected = await chooseTools(options, notice);
    if (preselected.length > 0) {
      notice(`${PRESELECTED_NOTICE}${preselected.join(', ')}`);
    }
  } else if (onDemand) {
    preselected = [...(options.preselected ?? [])];
  }
  if (!proxied) {
    for (const name of preselected) {
      loaded.add(name);
    }
  }
  return { proxied, onDemand, loaded, preselected };
}
