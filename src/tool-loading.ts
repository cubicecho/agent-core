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

/** One object for the life of the process — the agent loop asks for it on every iteration. */
export const LOAD_TOOLS_DEFINITION: OpenAI.ChatCompletionTool = {
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
};

/**
 * The catalogue as a plain grouped listing of names, loaded ones marked.
 *
 * A server with no tools is dropped rather than titled: a pool hands one over whenever a
 * server is connected but has nothing to offer, and a label with nothing under it reads as a
 * listing that got cut off.
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
 */
export const MAX_PER_LOAD = 12;

/**
 * The most a conversation carries between turns. Bounds the tool array no matter how long the
 * conversation runs; least-recently-used names fall off the front.
 *
 * Only a multi-turn caller needs this — a run that starts from nothing each time has nothing to
 * carry. See `carryOver`.
 */
export const MAX_CARRIED = 16;

/** The tools to start the next turn with: recently used, newest last, capped. */
export const carryOver = (previous: string[], used: Set<string>) =>
  [...previous.filter((name) => !used.has(name)), ...used].slice(-MAX_CARRIED);

/**
 * Resolves requested names against the catalogue, expanding trailing `*` wildcards.
 *
 * Names are matched leniently. Catalogue entries are slug-qualified (`nas_fs__read_file`) and
 * models routinely ask for the bare tool name, so an exact miss falls back to a suffix match
 * on the `__` boundary — accepted only when it is unambiguous. Rejecting those outright just
 * buys a wasted round trip while the model guesses the prefix, and pushes it toward
 * shotgunning wildcards.
 */
export function expandNames(requested: string[], catalog: CatalogServer[]) {
  const all = flatten(catalog);
  const matched = new Set<string>();
  const unknown: string[] = [];
  const overBroad: { name: string; hits: string[] }[] = [];

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
    if (matched.size + fresh.length > MAX_PER_LOAD) overBroad.push({ name, hits });
    else for (const hit of hits) matched.add(hit);
  }

  return { matched: [...matched], unknown, overBroad };
}

/** What `load_tools` reports back: the descriptions, now that they are worth their tokens. */
export function loadResult(
  { matched, unknown, overBroad }: ReturnType<typeof expandNames>,
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
      `\`${name}\` matches ${hits.length} tools, more than the ${MAX_PER_LOAD} one call may load.`,
      "Name the ones you need from:",
      ...hits.map((hit) => `  ${hit}`),
    );
  }
  if (unknown.length) {
    if (lines.length) lines.push("");
    lines.push(`Not in the catalogue: ${unknown.join(", ")}. Check the names and try again.`);
  }
  return lines.join("\n") || "No tool names were given.";
}

export const inCatalog = (catalog: CatalogServer[], name: string) =>
  catalog.some((server) => server.tools.some((tool) => tool.name === name));

/** `load_tools` arguments, defensively — a model may send a bare string or a nested object. */
export function requestedNames(args: Record<string, unknown>): string[] {
  const value = args.names ?? args.tools ?? args.name;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

/**
 * Tool preselection.
 *
 * On-demand loading otherwise costs a round trip every run: the model reads the catalogue,
 * calls `load_tools`, and only then can do the work. A small model reading the same catalogue
 * usually names the right tools outright, so the task model finds them already loaded and
 * starts working on its first step.
 *
 * A wrong guess is cheap — an unused definition is a few hundred tokens for one run — but a
 * broad guess is not, so the same `MAX_PER_LOAD` cap applies here as to a `load_tools` call.
 */
export const PRESELECT_SYSTEM =
  "You choose tools. Below is a catalogue of tool names, then a request. Reply with a JSON " +
  "array of the names the request is likely to need — exact names from the catalogue, at most " +
  `${MAX_PER_LOAD}, and as few as could do the job. Reply with \`[]\` if the request can be ` +
  "answered without tools. Reply with the array alone — no prose, no explanation.";

export const preselectInput = (catalog: CatalogServer[], prompt: string) =>
  `# Tool catalogue\n\n${catalogList(catalog)}\n\n# Request\n\n${prompt.slice(0, 2000)}`;

/** Resolves a preselection against the catalogue: unknown names dropped, count capped. */
export function preselection(names: unknown, catalog: CatalogServer[]): string[] {
  if (!Array.isArray(names)) return [];
  const wanted = names.filter((name): name is string => typeof name === "string");
  return expandNames(wanted, catalog).matched.slice(0, MAX_PER_LOAD);
}
