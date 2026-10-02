import type OpenAI from 'openai';
import type { CatalogServer } from './catalog.ts';
import { isRecord } from './guards.ts';
import { ARGUMENT_PREVIEW_CHARS } from './tool-calls.ts';
import { FUNCTION_TOOL, SchemaType } from './wire.ts';

/**
 * On-demand tool loading.
 *
 * @remarks
 * A full tool definition is mostly JSON Schema, and it is sent on every request of every
 * iteration whether or not the model wants it — a couple of connected servers can cost more
 * tokens per request than the task's own prompt. So in on-demand mode the run starts with a
 * bare *catalogue*: tool names only, appended to the system prompt, plus this one meta-tool.
 * The model calls `load_tools` with what it needs, and the next round trip carries those real
 * definitions.
 *
 * Names alone cost roughly a fortieth of what the schemas cost, so a run that needs no tools
 * pays almost nothing, and a run that needs three pays for three.
 */
export const LOAD_TOOLS = 'load_tools';

/** Shallow freezing this one would leave `.function.description` — the part worth editing. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const held of Object.values(value)) {
      deepFreeze(held);
    }
  }
  return Object.freeze(value);
}

/**
 * One object for the life of the process — the agent loop asks for it on every iteration.
 *
 * @remarks
 * Frozen because it is shared: one mutable export reached by every consumer in the process
 * means a caller that edits the description in place has edited it for all of them, in a place
 * nobody would think to look for the change.
 */
export const LOAD_TOOLS_DEFINITION: OpenAI.ChatCompletionTool = deepFreeze({
  type: FUNCTION_TOOL,
  function: {
    name: LOAD_TOOLS,
    description:
      'Load the full definitions of tools listed in the tool catalogue so you can call them. ' +
      'Pass the exact names you need, or a trailing wildcard like `server__group__*` for a ' +
      'whole group. The tools become callable on your next step — load them, then call them. ' +
      'Load only what the task actually needs.',
    parameters: {
      type: SchemaType.Object,
      properties: {
        names: {
          type: SchemaType.Array,
          items: { type: SchemaType.String },
          description: 'Tool names from the catalogue. Wildcards may end with `*`.',
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
  },
});

/**
 * The catalogue as a plain grouped listing of names, loaded ones marked if asked.
 *
 * @param catalog - The connected servers. Ones with no tools are dropped.
 * @param [loaded] - Names to mark `(loaded)` rather than remove. Absent marks nothing, which keeps the
 * listing the same text for the whole run.
 *
 * @remarks
 * A server with no tools is dropped rather than titled: a pool hands one over whenever a
 * server is connected but has nothing to offer, and a label with nothing under it reads as a
 * listing that got cut off.
 */
export function catalogList(catalog: CatalogServer[], loaded?: ReadonlySet<string>): string {
  return catalog
    .filter((server) => server.tools.length > 0)
    .map((server) => {
      const names = server.tools.map((tool) => `  ${tool.name}${loaded?.has(tool.name) ? ' (loaded)' : ''}`);
      return `${server.label}:\n${names.join('\n')}`;
    })
    .join('\n');
}

/**
 * The catalogue block appended to the system prompt. Names only — descriptions arrive on load.
 *
 * @param catalog - The connected servers. A catalogue with no tools in it produces an empty string.
 * @param [loaded] - Names to mark `(loaded)`, for a caller that rebuilds its prompt per load and does
 * not mind the cache. Absent marks nothing.
 *
 * @remarks
 * `runAgentLoop` passes no `loaded`, so the block is the same text on every step. The system
 * prompt is the head of the request, and marking each load there threw away the prompt cache for
 * the whole transcript on every `load_tools` call. What is loaded is said where it does not move
 * the prefix instead: in the tool array, appended in load order (`loadedTools`), and in the
 * `load_tools` result, which answers a repeat load with "already loaded" (`loadResult`).
 *
 * Loaded tools are never removed from the list. That reads as the tool having vanished the moment
 * it was loaded, and the model loads again to get it back; hoisting them into a separate "already
 * loaded" section splits a server's tools apart, and the model picks a sibling from the longer
 * list instead.
 */
export function catalogPrompt(catalog: CatalogServer[], loaded?: ReadonlySet<string>): string {
  const list = catalogList(catalog, loaded);
  // Not `catalog.length`: a catalogue of nothing but empty servers has no names to offer, and
  // the preamble below would then explain a mechanism against an empty list.
  if (!list) {
    return '';
  }
  return [
    '# Tool catalogue',
    '',
    'These tools exist but are not loaded. Call `load_tools` with the names you need, then call',
    'them on the step after. Names are descriptive; load a tool to see its parameters. A tool',
    'already in your tool list is loaded — call it directly, do not load it again. Do not load',
    'tools the task does not need, and do not mention this mechanism in your answer.',
    '',
    list,
  ].join('\n');
}

const flatten = (catalog: CatalogServer[]) => catalog.flatMap((server) => server.tools);

/**
 * The name a tool definition is called by, or `undefined` for one that is not a function.
 *
 * @param tool - The definition, as a request declares it.
 *
 * @remarks
 * Undefined rather than empty, so a caller that skips such a tool and one that has to place it
 * somewhere each say which they mean — a sort and a positional comparison want `?? ""`, a lookup
 * by name wants the tool left out.
 */
export const toolName = (tool: OpenAI.ChatCompletionTool) =>
  tool.type === FUNCTION_TOOL ? tool.function.name : undefined;

/**
 * A tool array with newly loaded definitions appended, in the order they were loaded.
 *
 * @param previous - What the last request declared, `load_tools` included. Not written to.
 * @param matched - The definitions to add. Ones whose name is already declared, here or earlier in
 * this list, are skipped rather than moved.
 *
 * @remarks
 * Appended and never rebuilt from a set, so what a load adds is decided by the load and not by
 * the shape of whatever collection the definitions came out of. Where the appended array ends up
 * in the request is `orderTools`' business, which the loop applies after this.
 */
export function loadedTools(
  previous: readonly OpenAI.ChatCompletionTool[],
  matched: readonly OpenAI.ChatCompletionTool[],
): OpenAI.ChatCompletionTool[] {
  const declared = new Set(previous.map(toolName));
  const tools = [...previous];
  for (const tool of matched) {
    const name = toolName(tool);
    if (name !== undefined && declared.has(name)) {
      continue;
    }
    declared.add(name);
    tools.push(tool);
  }
  return tools;
}

/**
 * How a tool array is ordered before it is sent: `true` by name, `false` as the caller built it,
 * or a comparator over the two names.
 */
export type ToolOrder = boolean | ((a: string, b: string) => number);

/**
 * Orders two names by code unit.
 *
 * @param a - The name on the left.
 * @param b - The name on the right.
 * @returns Negative where `a` sorts first, positive where `b` does, zero where they are the same.
 *
 * @remarks
 * Rather than `localeCompare`, whose answer depends on the host's locale — which is the kind of
 * instability `orderTools` exists to remove.
 */
function byCodeUnit(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * The tool array in a stable order, so the same set of tools renders the same way twice.
 *
 * @param tools - The definitions to order. Not written to.
 * @param [order] - `true` for name order, `false` to leave it alone, or a comparator over the names.
 * A tool that is not a function orders as the empty name.
 * @returns `tools` itself when it is already in that order, so the common case copies nothing.
 *
 * @remarks
 * A chat template renders the declared tools ahead of the system prompt, which makes the tool
 * array the first thing a prompt cache has to match — and an array assembled from a map, from
 * database rows, or from the order servers happened to connect in changes between processes and
 * between reconnects. Every such change costs the cache for the whole transcript rather than for
 * the tools alone, and nothing about the request the model sees is different. Ordering by name
 * makes the array a property of the set instead of of how it was built, at the price of a load
 * inserting rather than appending. Definitions come back by identity, so `sanitizeTools` still
 * finds each one in its cache.
 *
 * `false` is for a caller that means its order: the model reads the array top to bottom, and a
 * host may be putting what it wants reached for first at the front.
 */
export function orderTools(tools: OpenAI.ChatCompletionTool[], order: ToolOrder = true): OpenAI.ChatCompletionTool[] {
  if (order === false) {
    return tools;
  }
  const nameOf = (tool: OpenAI.ChatCompletionTool) => toolName(tool) ?? '';
  const compare = typeof order === 'function' ? order : byCodeUnit;
  const sorted = [...tools].sort((a, b) => compare(nameOf(a), nameOf(b)));
  return sorted.some((tool, at) => tool !== tools[at]) ? sorted : tools;
}

/**
 * The most a single `load_tools` call may pull in.
 *
 * @remarks
 * A wildcard like `gmail__*` matches 33 tools, and loading them all puts the model right back
 * in the position on-demand loading exists to avoid — a tool array too large to choose from.
 * Over-broad requests are refused with the matching names listed, so the next call can be
 * precise.
 *
 * The default rather than the rule: twelve is what a small model chooses well from, and a caller
 * running a large one against a large window can say otherwise to `expandNames`, `preselection`
 * and `preselectSystem`. Whatever it says is carried on the resolution, so the refusal the model
 * reads names the number it was actually held to.
 */
export const MAX_PER_LOAD = 12;

/**
 * The most a conversation carries between turns. Bounds the tool array no matter how long the
 * conversation runs; past it, the earliest-declared names this turn did not use fall off first.
 *
 * @remarks
 * Only a multi-turn caller needs this — a run that starts from nothing each time has nothing to
 * carry. See `carryOver`, which takes another number if this one is not yours.
 */
export const MAX_CARRIED = 16;

/**
 * The tools to start the next turn with: last turn's where they were, then what this turn used.
 *
 * @param previous - Last turn's names, in the order they were declared.
 * @param used - What this turn called. Names not already carried are appended in the order given,
 * so pass them in load order to keep them where the tool array had them.
 * @param [max] - How many to carry. Past it, the earliest names not in
 * `used` go first, then the earliest of all. At least one: a cap of zero is read as one, not as
 * no cap and not as none.
 *
 * @remarks
 * Nothing carried moves. A template renders the tool array near the head of the prompt, and
 * moving each used tool to the end — which this did until it was found in a local server's cache
 * log — reordered the array between turns and re-prefilled the whole transcript from the first
 * moved definition. Kept in place, the next turn's array is this one's with only the unused
 * loads gone, a prefix of it when every load was used. Past `max`, dropping a name from the
 * middle costs the cache from there, so it happens only when the cap forces it.
 */
export function carryOver(previous: readonly string[], used: ReadonlySet<string>, max = MAX_CARRIED): string[] {
  const next = [...previous, ...[...used].filter((name) => !previous.includes(name))];
  const cap = Math.max(1, max);
  while (next.length > cap) {
    const stale = next.findIndex((name) => !used.has(name));
    next.splice(stale === -1 ? 0 : stale, 1);
  }
  return next;
}

/**
 * Resolves requested names against the catalogue, expanding trailing `*` wildcards.
 *
 * @param requested - What the model asked for. A trailing `*` expands.
 * @param catalog - The servers to resolve against.
 * @param [maxPerLoad] - The most this call may load. It comes back on
 * the resolution so `loadResult` reports the same number rather than a second opinion of it.
 * @returns The names that resolved, each once; the ones nothing matched; the asks too broad for
 * any call, with what they matched; and the ones that only did not fit this call.
 *
 * @remarks
 * Names are matched leniently. Catalogue entries are slug-qualified (`nas_fs__read_file`) and
 * models routinely ask for the bare tool name, so an exact miss falls back to a suffix match
 * on the `__` boundary — accepted only when it is unambiguous. Rejecting those outright just
 * buys a wasted round trip while the model guesses the prefix, and pushes it toward
 * shotgunning wildcards.
 */
export function expandNames(requested: string[], catalog: CatalogServer[], maxPerLoad = MAX_PER_LOAD) {
  const all = flatten(catalog);
  const matched = new Set<string>();
  const unknown: string[] = [];
  const overBroad: { name: string; hits: string[] }[] = [];
  const deferred: string[] = [];

  const known = new Set(all.map((tool) => tool.name));

  const resolve = (name: string): string[] => {
    if (name.endsWith('*')) {
      const stem = name.slice(0, -1);
      const direct = all.filter((tool) => tool.name.startsWith(stem));
      if (direct.length) {
        return direct.map((tool) => tool.name);
      }
      return all.filter((tool) => tool.name.includes(`__${stem}`)).map((tool) => tool.name);
    }
    if (known.has(name)) {
      return [name];
    }
    const suffix = all.filter((tool) => tool.name.endsWith(`__${name}`));
    return suffix.length === 1 ? [suffix[0].name] : [];
  };

  for (const raw of requested) {
    const name = raw.trim();
    if (!name) {
      continue;
    }
    // A bare `*` is not a guess at a name, it is a refusal to choose, and its empty stem
    // prefixes every tool in the catalogue. Answer it the way any other over-broad request is
    // answered: with the names, so the next call can pick from them.
    if (name === '*') {
      overBroad.push({ name, hits: all.map((tool) => tool.name) });
      continue;
    }
    const hits = resolve(name);
    if (!hits.length) {
      unknown.push(name);
      continue;
    }
    // The cap is what one call may load, not what one name may match: three wildcards of a
    // dozen each cleared a per-name check and still put thirty-six definitions in front of a
    // model that is meant to be choosing from twelve. Already-matched names are free, so a
    // name that only repeats an earlier one never spends budget.
    const fresh = hits.filter((hit) => !matched.has(hit));
    // Two different refusals, and answering both with "narrow it down" made one of them
    // impossible to act on. A name that would not fit an empty call is over-broad, and the
    // names are what the model needs. A name that only does not fit *this* call is precise
    // enough already — telling a model that asked for one exact tool that it matches one tool,
    // "more than the twelve one call may load", and to choose from a list holding just that
    // name, leaves it nothing to do but send the identical call again.
    if (fresh.length > maxPerLoad) {
      overBroad.push({ name, hits });
    } else if (matched.size + fresh.length > maxPerLoad) {
      deferred.push(name);
    } else {
      for (const hit of hits) {
        matched.add(hit);
      }
    }
  }

  return { matched: [...matched], unknown, overBroad, deferred, maxPerLoad };
}

/** Each block's lines on their own, and a blank line between one block and the next. */
const joinBlocks = (blocks: string[][]) => blocks.map((block) => block.join('\n')).join('\n\n');

/**
 * What `load_tools` reports back: the descriptions, now that they are worth their tokens.
 *
 * @param expanded - What `expandNames` resolved: the matches, the misses, and the over-broad asks.
 * @param catalog - The servers, read for the descriptions now worth their tokens.
 * @param [loaded] - What was loaded before this call. Absent reports every match as newly loaded.
 *
 * @remarks
 * A name that was loaded before this call is reported as already loaded rather than loaded
 * again. The catalogue no longer marks what is loaded — see `catalogPrompt` — so this is where a
 * model that asks twice finds out it need not have, and is told to call the tool instead.
 */
export function loadResult(
  { matched, unknown, overBroad, deferred, maxPerLoad }: ReturnType<typeof expandNames>,
  catalog: CatalogServer[],
  loaded?: ReadonlySet<string>,
): string {
  const byName = new Map(flatten(catalog).map((tool) => [tool.name, tool.description]));
  // One entry per thing the model is told, each a blank line from the next.
  const blocks: string[][] = [];
  const fresh = matched.filter((name) => !loaded?.has(name));
  const again = matched.filter((name) => loaded?.has(name));

  if (fresh.length) {
    blocks.push([
      `Loaded ${fresh.length} tool(s); they are callable on your next step.`,
      '',
      ...fresh.map((name) => `${name}: ${byName.get(name) ?? ''}`.trim()),
    ]);
  }
  if (again.length) {
    blocks.push([
      `Already loaded and in your tool list: ${again.join(', ')}. Call them directly; do not load them again.`,
    ]);
  }
  blocks.push(
    ...overBroad.map(({ name, hits }) => [
      `\`${name}\` matches ${hits.length} tools, more than the ${maxPerLoad} one call may load.`,
      'Name the ones you need from:',
      ...hits.map((hit) => `  ${hit}`),
    ]),
  );
  if (deferred.length) {
    blocks.push([
      `This call is full at ${maxPerLoad} tools, so these were not loaded: ${deferred.join(', ')}.`,
      'Ask for them on your next step.',
    ]);
  }
  if (unknown.length) {
    blocks.push([`Not in the catalogue: ${unknown.join(', ')}. Check the names and try again.`]);
  }
  return joinBlocks(blocks) || 'No tool names were given.';
}

/**
 * Whether the catalogue holds a tool by this name.
 *
 * @param catalog - The connected servers and the tools each one offers.
 * @param name - An exact name. Nothing is prefixed, trimmed or fuzzily matched.
 */
export const inCatalog = (catalog: CatalogServer[], name: string) =>
  catalog.some((server) => server.tools.some((tool) => tool.name === name));

/**
 * `load_tools` arguments, defensively — a model may send a bare string or a nested object.
 *
 * @param args - The tool call's arguments, exactly as the model sent them.
 */
export function requestedNames(args: Record<string, unknown>): string[] {
  const value = args.names ?? args.tools ?? args.name;
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

/**
 * The one tool a proxied run reaches every catalogued tool through.
 *
 * @remarks
 * Proxied discovery is on-demand loading with a tool array that never changes. On-demand mode
 * declares each tool as it is loaded, and a chat template renders the tool array in the system
 * turn, ahead of the whole conversation — so appending one definition there moves every token
 * after it, and on a model llama.cpp can only rewind to a saved checkpoint a single load
 * re-prefills the transcript from the first token. Proxied, the array is `load_tools` and
 * `call_tool` for the life of the session: a load answers with the definitions as its result, at
 * the end of the history where the cache already stops, and the model runs a loaded tool through
 * this one. The price is a level of indirection the model has to get right, which a small model
 * does less reliably than a native call.
 */
export const CALL_TOOL = 'call_tool';

/**
 * The whole tool array of a proxied run, `load_tools` then `call_tool`, frozen because it is
 * shared.
 *
 * @remarks
 * The load keeps `LOAD_TOOLS` as its name, so `requestedNames` and `expandNames` read its
 * arguments as they do on demand; only what it promises differs, which is why it is not
 * `LOAD_TOOLS_DEFINITION`. `call_tool`'s `arguments` says `additionalProperties: true` and has to:
 * `sanitizeTools` gives an object with no properties an empty property list, a grammar-constrained
 * server compiles that to `{}`, and without the keyword the model is left no way to pass an
 * argument at all.
 */
export const PROXY_TOOLS: readonly OpenAI.ChatCompletionTool[] = deepFreeze([
  {
    type: FUNCTION_TOOL,
    function: {
      name: LOAD_TOOLS,
      description:
        'Get the full definitions of tools listed in the tool catalogue: what each does and the ' +
        'arguments it takes. Pass the exact names you need, or a trailing wildcard like ' +
        '`server__group__*` for a whole group. Then run them with `call_tool`. Load only what ' +
        'the task actually needs.',
      parameters: {
        type: SchemaType.Object,
        properties: {
          names: {
            type: SchemaType.Array,
            items: { type: SchemaType.String },
            description: 'Tool names from the catalogue. Wildcards may end with `*`.',
          },
        },
        required: ['names'],
        additionalProperties: false,
      },
    },
  },
  {
    type: FUNCTION_TOOL,
    function: {
      name: CALL_TOOL,
      description:
        'Run a tool from the catalogue. Load it with `load_tools` first to learn its arguments, ' +
        'then pass its exact name and an arguments object matching its parameters.',
      parameters: {
        type: SchemaType.Object,
        properties: {
          name: { type: SchemaType.String, description: "The tool's exact name from the catalogue." },
          arguments: {
            type: SchemaType.Object,
            description: "The tool's arguments, as its definition describes them.",
            additionalProperties: true,
          },
        },
        required: ['name', 'arguments'],
      },
    },
  },
]);

/**
 * The catalogue block for a proxied run's system prompt, worded for `call_tool` rather than for a
 * tool list.
 *
 * @param catalog - The connected servers. A catalogue with no tools in it produces an empty string.
 *
 * @remarks
 * `catalogPrompt` tells the model a loaded tool is in its tool list, which proxied is never true —
 * a model told so looks for it there and calls it natively. The listing itself is the same, and
 * like that one it is never marked, so the head of the prompt is one text for the whole session.
 */
export function proxyCatalogPrompt(catalog: CatalogServer[]): string {
  const list = catalogList(catalog);
  if (!list) {
    return '';
  }
  return [
    '# Tool catalogue',
    '',
    'These tools exist. Call `load_tools` with the names you need to get their definitions, then',
    'run them with `call_tool`. Names are descriptive; load a tool to see its parameters. A tool',
    'whose definition is already in this conversation does not need loading again. Do not load',
    'tools the task does not need, and do not mention this mechanism in your answer.',
    '',
    list,
  ].join('\n');
}

/** How a proxied load result that carries definitions opens, with the count left open. */
const PROXY_LOADED = /^Loaded \d+ tool\(s\)\. Run them with `call_tool`\./;

/**
 * Whether a tool result is a proxied load carrying definitions, which is the only copy of them
 * the model has.
 *
 * @param result - The tool message's text. A load that only pointed back or refused is not one.
 *
 * @remarks
 * On demand the definitions are in the tool array and a load's result only repeats their
 * descriptions, so clearing it loses nothing. Proxied, the result is the schema, and
 * `pruneToolResults` asks this before it stubs one. Told by how `proxyLoadResult` opens, the way
 * a summary is told by `SUMMARY_LEAD`, because a `tool` message carries no tool name of its own.
 */
export const holdsDefinitions = (result: string) => PROXY_LOADED.test(result);

/**
 * What a proxied `load_tools` answers: each new tool's whole definition as a line of JSON, since
 * the result is the only place the model will ever see it.
 *
 * @param resolved - What the call asked for, from `expandNames`.
 * @param catalog - The servers, read for the refusals' wording.
 * @param definitions - The definitions of `resolved.matched`, as many as the host has. Ones that
 * are not functions are skipped.
 * @param [loaded] - What was loaded before this call. Absent reports every match as newly loaded.
 *
 * @remarks
 * A name loaded before this call is answered with a pointer back rather than its definition a
 * second time, and one the catalogue lists but `definitions` does not hold is said to have none,
 * so the model is not left waiting on a schema that is not coming. The refusals — too broad, over
 * the per-call cap, not in the catalogue, nothing asked for — are `loadResult`'s, worded the same
 * in both modes.
 */
export function proxyLoadResult(
  resolved: ReturnType<typeof expandNames>,
  catalog: CatalogServer[],
  definitions: readonly OpenAI.ChatCompletionTool[],
  loaded?: ReadonlySet<string>,
): string {
  const blocks: string[][] = [];
  const again = resolved.matched.filter((name) => loaded?.has(name));
  const fresh = definitions.flatMap((tool) =>
    tool.type === FUNCTION_TOOL && !loaded?.has(tool.function.name) ? [tool.function] : [],
  );
  const defined = new Set(fresh.map((tool) => tool.name));
  const missing = resolved.matched.filter((name) => !loaded?.has(name) && !defined.has(name));
  if (fresh.length) {
    blocks.push([`Loaded ${fresh.length} tool(s). Run them with \`${CALL_TOOL}\`.`]);
    blocks.push(
      ...fresh.map(({ name, description, parameters }) => [JSON.stringify({ name, description, parameters })]),
    );
  }
  if (again.length) {
    blocks.push([
      `Already loaded earlier in this conversation: ${again.join(', ')}. Run them with ` +
        `\`${CALL_TOOL}\`; do not load them again.`,
    ]);
  }
  if (missing.length) {
    blocks.push([`No definition is available for: ${missing.join(', ')}.`]);
  }
  const { overBroad, deferred, unknown, matched } = resolved;
  const hasMoreToSay = overBroad.length || deferred.length || unknown.length || !matched.length;
  if (hasMoreToSay) {
    blocks.push([loadResult({ ...resolved, matched: [] }, catalog)]);
  }
  return joinBlocks(blocks);
}

/**
 * The tool a `call_tool` names and the arguments to run it with, or a throw the model can read.
 *
 * @param args - The `call_tool` call's own arguments, parsed. An absent `arguments` is no arguments.
 * @param catalog - What may be called. The name is trimmed and then matched exactly.
 *
 * @remarks
 * `arguments` arrives as an object when the model follows the schema and as a JSON string when it
 * copies the shape of a native call instead; both are taken, since the intent is the same. A name
 * outside the catalogue is refused here rather than handed to a dispatcher, which is what keeps
 * `call_tool` from reaching anything the catalogue does not offer.
 */
export function proxiedCall(
  args: Record<string, unknown>,
  catalog: CatalogServer[],
): { name: string; input: Record<string, unknown> } {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    throw new Error(`${CALL_TOOL} needs a name; pass one from the tool catalogue.`);
  }
  if (!inCatalog(catalog, name)) {
    throw new Error(`Not in the catalogue: ${name}. Check the name and try again.`);
  }
  let input: unknown = args.arguments ?? {};
  if (typeof input === 'string') {
    const text = input;
    try {
      input = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `${CALL_TOOL} arguments for ${name} are not valid JSON: ${text.slice(0, ARGUMENT_PREVIEW_CHARS)}`,
      );
    }
  }
  if (!isRecord(input)) {
    throw new Error(`${CALL_TOOL} arguments for ${name} must be an object.`);
  }
  return { name, input };
}

/**
 * A tool call as a watcher should see it: a `call_tool` as the tool it ran, anything else as it
 * is.
 *
 * @param name - The name the model called.
 * @param input - The call's arguments as JSON text.
 * @returns The inner name and its arguments as JSON text — the string itself where the model
 * passed `arguments` as one.
 *
 * @remarks
 * The transcript keeps the `call_tool` the model wrote, since the next request has to repeat it
 * word for word to stay in the cache; only the display looks through it. Anything that does not
 * parse as a proxied call is left as it came.
 */
export function shownCall(name: string, input: string): { name: string; input: string } {
  if (name !== CALL_TOOL) {
    return { name, input };
  }
  try {
    const args = JSON.parse(input) as { name?: unknown; arguments?: unknown };
    if (typeof args.name !== 'string' || !args.name.trim()) {
      return { name, input };
    }
    const inner = args.arguments ?? {};
    return {
      name: args.name.trim(),
      input: typeof inner === 'string' ? inner : JSON.stringify(inner),
    };
  } catch {
    return { name, input };
  }
}
