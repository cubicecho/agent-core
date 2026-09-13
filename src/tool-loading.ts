import type OpenAI from "openai";
import type { CatalogServer } from "./catalog.ts";

/**
 * On-demand tool loading.
 *
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
export const LOAD_TOOLS = "load_tools";

/** Shallow freezing this one would leave `.function.description` — the part worth editing. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") for (const held of Object.values(value)) deepFreeze(held);
  return Object.freeze(value);
}

/**
 * One object for the life of the process — the agent loop asks for it on every iteration.
 *
 * Frozen because it is shared: one mutable export reached by every consumer in the process
 * means a caller that edits the description in place has edited it for all of them, in a place
 * nobody would think to look for the change.
 */
export const LOAD_TOOLS_DEFINITION: OpenAI.ChatCompletionTool = deepFreeze({
  type: "function",
  function: {
    name: LOAD_TOOLS,
    description:
      "Load the full definitions of tools listed in the tool catalogue so you can call them. " +
      "Pass the exact names you need, or a trailing wildcard like `server__group__*` for a " +
      "whole group. The tools become callable on your next step — load them, then call them. " +
      "Load only what the task actually needs.",
    parameters: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Tool names from the catalogue. Wildcards may end with `*`.",
        },
      },
      required: ["names"],
      additionalProperties: false,
    },
  },
});

/**
 * The catalogue as a plain grouped listing of names, loaded ones marked.
 *
 * A server with no tools is dropped rather than titled: a pool hands one over whenever a
 * server is connected but has nothing to offer, and a label with nothing under it reads as a
 * listing that got cut off.
 *
 * @param catalog The connected servers. Ones with no tools are dropped.
 * @param loaded Names already loaded, marked in the listing rather than removed from it.
 */
export function catalogList(catalog: CatalogServer[], loaded?: ReadonlySet<string>): string {
  return catalog
    .filter((server) => server.tools.length > 0)
    .map((server) => {
      const names = server.tools.map(
        (tool) => `  ${tool.name}${loaded?.has(tool.name) ? " (loaded)" : ""}`,
      );
      return `${server.label}:\n${names.join("\n")}`;
    })
    .join("\n");
}

/**
 * The catalogue block appended to the system prompt. Names only — descriptions arrive on load.
 *
 * Loaded tools stay in the list, marked. Removing them reads as the tool having vanished the
 * moment it was loaded, and the model loads again to get it back; hoisting them into a separate
 * "already loaded" section splits a server's tools apart, and the model picks a sibling from
 * the longer list instead.
 *
 * @param catalog The connected servers. A catalogue with no tools in it produces an empty string.
 * @param loaded Names already loaded, marked in the listing.
 */
export function catalogPrompt(catalog: CatalogServer[], loaded?: ReadonlySet<string>): string {
  const list = catalogList(catalog, loaded);
  // Not `catalog.length`: a catalogue of nothing but empty servers has no names to offer, and
  // the preamble below would then explain a mechanism against an empty list.
  if (!list) return "";
  return [
    "# Tool catalogue",
    "",
    "These tools exist but are not loaded. Call `load_tools` with the names you need, then call",
    "them on the step after. Names are descriptive; load a tool to see its parameters. A name",
    "marked `(loaded)` is already in your tool list — call it directly, do not load it again. Do",
    "not load tools the task does not need, and do not mention this mechanism in your answer.",
    "",
    list,
  ].join("\n");
}

const flatten = (catalog: CatalogServer[]) => catalog.flatMap((server) => server.tools);

/**
 * The most a single `load_tools` call may pull in.
 *
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
 * conversation runs; least-recently-used names fall off the front.
 *
 * Only a multi-turn caller needs this — a run that starts from nothing each time has nothing to
 * carry. See `carryOver`, which takes another number if this one is not yours.
 */
export const MAX_CARRIED = 16;

/**
 * The tools to start the next turn with: recently used, newest last, capped.
 *
 * @param previous Last turn's names, oldest first.
 * @param used What this turn called. Moved to the end, so the oldest unused fall off.
 * @param max How many to carry, defaulting to `MAX_CARRIED`. At least one: a cap of zero is
 * read as no cap, which is what `slice` does with it and not what anybody asking for zero meant.
 */
export const carryOver = (previous: string[], used: Set<string>, max = MAX_CARRIED) =>
  [...previous.filter((name) => !used.has(name)), ...used].slice(-Math.max(1, max));

/**
 * Resolves requested names against the catalogue, expanding trailing `*` wildcards.
 *
 * Names are matched leniently. Catalogue entries are slug-qualified (`nas_fs__read_file`) and
 * models routinely ask for the bare tool name, so an exact miss falls back to a suffix match
 * on the `__` boundary — accepted only when it is unambiguous. Rejecting those outright just
 * buys a wasted round trip while the model guesses the prefix, and pushes it toward
 * shotgunning wildcards.
 *
 * @param requested What the model asked for. A trailing `*` expands.
 * @param catalog The servers to resolve against.
 * @param maxPerLoad The most this call may load, defaulting to `MAX_PER_LOAD`. It comes back on
 * the resolution so `loadResult` reports the same number rather than a second opinion of it.
 */
export function expandNames(
  requested: string[],
  catalog: CatalogServer[],
  maxPerLoad = MAX_PER_LOAD,
) {
  const all = flatten(catalog);
  const matched = new Set<string>();
  const unknown: string[] = [];
  const overBroad: { name: string; hits: string[] }[] = [];
  const deferred: string[] = [];

  const known = new Set(all.map((tool) => tool.name));

  const resolve = (name: string): string[] => {
    if (name.endsWith("*")) {
      const stem = name.slice(0, -1);
      const direct = all.filter((tool) => tool.name.startsWith(stem));
      if (direct.length) return direct.map((tool) => tool.name);
      return all.filter((tool) => tool.name.includes(`__${stem}`)).map((tool) => tool.name);
    }
    if (known.has(name)) return [name];
    const suffix = all.filter((tool) => tool.name.endsWith(`__${name}`));
    return suffix.length === 1 ? [suffix[0].name] : [];
  };

  for (const raw of requested) {
    const name = raw.trim();
    if (!name) continue;
    // A bare `*` is not a guess at a name, it is a refusal to choose, and its empty stem
    // prefixes every tool in the catalogue. Answer it the way any other over-broad request is
    // answered: with the names, so the next call can pick from them.
    if (name === "*") {
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
    if (fresh.length > maxPerLoad) overBroad.push({ name, hits });
    else if (matched.size + fresh.length > maxPerLoad) deferred.push(name);
    else for (const hit of hits) matched.add(hit);
  }

  return { matched: [...matched], unknown, overBroad, deferred, maxPerLoad };
}

/**
 * What `load_tools` reports back: the descriptions, now that they are worth their tokens.
 *
 * @param expanded What `expandNames` resolved: the matches, the misses, and the over-broad asks.
 * @param catalog The servers, read for the descriptions now worth their tokens.
 */
export function loadResult(
  { matched, unknown, overBroad, deferred, maxPerLoad }: ReturnType<typeof expandNames>,
  catalog: CatalogServer[],
): string {
  const byName = new Map(flatten(catalog).map((tool) => [tool.name, tool.description]));
  const lines: string[] = [];

  if (matched.length) {
    lines.push(`Loaded ${matched.length} tool(s); they are callable on your next step.`, "");
    for (const name of matched) lines.push(`${name}: ${byName.get(name) ?? ""}`.trim());
  }
  for (const { name, hits } of overBroad) {
    if (lines.length) lines.push("");
    lines.push(
      `\`${name}\` matches ${hits.length} tools, more than the ${maxPerLoad} one call may load.`,
      "Name the ones you need from:",
      ...hits.map((hit) => `  ${hit}`),
    );
  }
  if (deferred.length) {
    if (lines.length) lines.push("");
    lines.push(
      `This call is full at ${maxPerLoad} tools, so these were not loaded: ${deferred.join(", ")}.`,
      "Ask for them on your next step.",
    );
  }
  if (unknown.length) {
    if (lines.length) lines.push("");
    lines.push(`Not in the catalogue: ${unknown.join(", ")}. Check the names and try again.`);
  }
  return lines.join("\n") || "No tool names were given.";
}

/**
 * Whether the catalogue holds a tool by this name.
 *
 * @param catalog The connected servers and the tools each one offers.
 * @param name An exact name. Nothing is prefixed, trimmed or fuzzily matched.
 */
export const inCatalog = (catalog: CatalogServer[], name: string) =>
  catalog.some((server) => server.tools.some((tool) => tool.name === name));

/**
 * `load_tools` arguments, defensively — a model may send a bare string or a nested object.
 *
 * @param args The tool call's arguments, exactly as the model sent them.
 */
export function requestedNames(args: Record<string, unknown>): string[] {
  const value = args.names ?? args.tools ?? args.name;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

/**
 * Where a request is cut for the preselector, in characters.
 *
 * A tool choice is made on what the work is, which is the top of a request rather than all of
 * it — and the whole of a long one is paid for again in the preselection call. `preselectInput`
 * takes another number for a caller whose requests are not shaped that way.
 */
const PRESELECT_PROMPT_CHARS = 2000;

/**
 * The system prompt a preselector is given, holding it to the cap its answer will be held to.
 *
 * On-demand loading otherwise costs a round trip every run: the model reads the catalogue,
 * calls `load_tools`, and only then can do the work. A small model reading the same catalogue
 * usually names the right tools outright, so the task model finds them already loaded and
 * starts working on its first step.
 *
 * A wrong guess is cheap — an unused definition is a few hundred tokens for one run — but a
 * broad guess is not, so the same cap applies here as to a `load_tools` call.
 *
 * @param maxPerLoad The most to ask for, defaulting to `MAX_PER_LOAD`. Give `preselection` the
 * same number: this one is what the preselector is told, and that one is what it is held to.
 */
export const preselectSystem = (maxPerLoad = MAX_PER_LOAD) =>
  "You choose tools. Below is a catalogue of tool names, then a request. Reply with a JSON " +
  "array of the names the request is likely to need — exact names from the catalogue, at most " +
  `${maxPerLoad}, and as few as could do the job. Reply with \`[]\` if the request can be ` +
  "answered without tools. Reply with the array alone — no prose, no explanation.";

/** The preselection system prompt at the default cap, for a caller that never changes it. */
export const PRESELECT_SYSTEM = preselectSystem();

/**
 * The user message for a preselection call: the catalogue, then the request.
 *
 * @param catalog The connected servers, rendered as the name-only listing.
 * @param prompt The request being planned for, truncated — choosing tools needs the shape of the
 * ask, not all of it.
 * @param maxPromptChars Where the request is cut, defaulting to 2000. A caller whose requests
 * carry the part that names the work at the end wants a larger one, and pays for it in the
 * preselector's prompt.
 */
export const preselectInput = (
  catalog: CatalogServer[],
  prompt: string,
  maxPromptChars = PRESELECT_PROMPT_CHARS,
) =>
  `# Tool catalogue\n\n${catalogList(catalog)}\n\n# Request\n\n${prompt.slice(0, maxPromptChars)}`;

/**
 * Resolves a preselection against the catalogue: unknown names dropped, count capped.
 *
 * @param names What the preselector replied. Unvalidated: a non-array gives none, and entries
 * that are not strings are dropped.
 * @param catalog The servers to resolve against.
 * @param maxPerLoad The most to keep, defaulting to `MAX_PER_LOAD`. The same number
 * `preselectSystem` was given, or the model is being held to a cap it was never told about.
 */
export function preselection(
  names: unknown,
  catalog: CatalogServer[],
  maxPerLoad = MAX_PER_LOAD,
): string[] {
  if (!Array.isArray(names)) return [];
  const wanted = names.filter((name): name is string => typeof name === "string");
  return expandNames(wanted, catalog, maxPerLoad).matched.slice(0, maxPerLoad);
}
