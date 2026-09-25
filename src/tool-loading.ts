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
 * The catalogue as a plain grouped listing of names, loaded ones marked if asked.
 *
 * A server with no tools is dropped rather than titled: a pool hands one over whenever a
 * server is connected but has nothing to offer, and a label with nothing under it reads as a
 * listing that got cut off.
 *
 * @param catalog The connected servers. Ones with no tools are dropped.
 * @param loaded Names to mark `(loaded)` rather than remove. Absent marks nothing, which keeps the
 * listing the same text for the whole run.
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
 *
 * @param catalog The connected servers. A catalogue with no tools in it produces an empty string.
 * @param loaded Names to mark `(loaded)`, for a caller that rebuilds its prompt per load and does
 * not mind the cache. Absent marks nothing.
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
    "them on the step after. Names are descriptive; load a tool to see its parameters. A tool",
    "already in your tool list is loaded — call it directly, do not load it again. Do not load",
    "tools the task does not need, and do not mention this mechanism in your answer.",
    "",
    list,
  ].join("\n");
}

const flatten = (catalog: CatalogServer[]) => catalog.flatMap((server) => server.tools);

/**
 * A tool array with newly loaded definitions appended, in the order they were loaded.
 *
 * Appended and never rebuilt from a set, so what a load adds is decided by the load and not by
 * the shape of whatever collection the definitions came out of. Where the appended array ends up
 * in the request is `orderTools`' business, which the loop applies after this.
 *
 * @param previous What the last request declared, `load_tools` included. Not written to.
 * @param matched The definitions to add. Ones whose name is already declared, here or earlier in
 * this list, are skipped rather than moved.
 */
export function loadedTools(
  previous: readonly OpenAI.ChatCompletionTool[],
  matched: readonly OpenAI.ChatCompletionTool[],
): OpenAI.ChatCompletionTool[] {
  const nameOf = (tool: OpenAI.ChatCompletionTool) =>
    tool.type === "function" ? tool.function.name : undefined;
  const declared = new Set(previous.map(nameOf));
  const tools = [...previous];
  for (const tool of matched) {
    const name = nameOf(tool);
    if (name !== undefined && declared.has(name)) continue;
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
 * The tool array in a stable order, so the same set of tools renders the same way twice.
 *
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
 *
 * @param tools The definitions to order. Not written to.
 * @param order `true` for name order, `false` to leave it alone, or a comparator over the names.
 * A tool that is not a function orders as the empty name.
 * @returns `tools` itself when it is already in that order, so the common case copies nothing.
 */
export function orderTools(
  tools: OpenAI.ChatCompletionTool[],
  order: ToolOrder = true,
): OpenAI.ChatCompletionTool[] {
  if (order === false) return tools;
  const nameOf = (tool: OpenAI.ChatCompletionTool) =>
    tool.type === "function" ? tool.function.name : "";
  // Code-unit order rather than `localeCompare`, whose answer depends on the host's locale —
  // which is the kind of instability this exists to remove.
  const compare =
    typeof order === "function" ? order : (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...tools].sort((a, b) => compare(nameOf(a), nameOf(b)));
  return sorted.some((tool, at) => tool !== tools[at]) ? sorted : tools;
}

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
 * conversation runs; past it, the earliest-declared names this turn did not use fall off first.
 *
 * Only a multi-turn caller needs this — a run that starts from nothing each time has nothing to
 * carry. See `carryOver`, which takes another number if this one is not yours.
 */
export const MAX_CARRIED = 16;

/**
 * The tools to start the next turn with: last turn's where they were, then what this turn used.
 *
 * Nothing carried moves. A template renders the tool array near the head of the prompt, and
 * moving each used tool to the end — which this did until it was found in a local server's cache
 * log — reordered the array between turns and re-prefilled the whole transcript from the first
 * moved definition. Kept in place, the next turn's array is this one's with only the unused
 * loads gone, a prefix of it when every load was used. Past `max`, dropping a name from the
 * middle costs the cache from there, so it happens only when the cap forces it.
 *
 * @param previous Last turn's names, in the order they were declared.
 * @param used What this turn called. Names not already carried are appended in the order given,
 * so pass them in load order to keep them where the tool array had them.
 * @param max How many to carry, defaulting to `MAX_CARRIED`. Past it, the earliest names not in
 * `used` go first, then the earliest of all. At least one: a cap of zero is read as one, not as
 * no cap and not as none.
 */
export function carryOver(
  previous: readonly string[],
  used: ReadonlySet<string>,
  max = MAX_CARRIED,
): string[] {
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
 * A name that was loaded before this call is reported as already loaded rather than loaded
 * again. The catalogue no longer marks what is loaded — see `catalogPrompt` — so this is where a
 * model that asks twice finds out it need not have, and is told to call the tool instead.
 *
 * @param expanded What `expandNames` resolved: the matches, the misses, and the over-broad asks.
 * @param catalog The servers, read for the descriptions now worth their tokens.
 * @param loaded What was loaded before this call. Absent reports every match as newly loaded.
 */
export function loadResult(
  { matched, unknown, overBroad, deferred, maxPerLoad }: ReturnType<typeof expandNames>,
  catalog: CatalogServer[],
  loaded?: ReadonlySet<string>,
): string {
  const byName = new Map(flatten(catalog).map((tool) => [tool.name, tool.description]));
  const lines: string[] = [];
  const fresh = matched.filter((name) => !loaded?.has(name));
  const again = matched.filter((name) => loaded?.has(name));

  if (fresh.length) {
    lines.push(`Loaded ${fresh.length} tool(s); they are callable on your next step.`, "");
    for (const name of fresh) lines.push(`${name}: ${byName.get(name) ?? ""}`.trim());
  }
  if (again.length) {
    if (lines.length) lines.push("");
    lines.push(
      `Already loaded and in your tool list: ${again.join(", ")}. Call them directly; do not load them again.`,
    );
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
  'object whose "tools" array holds the names the request is likely to need — exact names from ' +
  `the catalogue, at most ${maxPerLoad}, and as few as could do the job. Reply with ` +
  '`{"tools": []}` if the request can be answered without tools. Reply with the object alone — ' +
  "no prose, no explanation.";

/**
 * The shape a preselector's answer is held to where the server takes a schema: `{ tools: [...] }`.
 *
 * An object around the array rather than the array, because a structured answer's root has to be
 * an object — OpenAI's strict mode and every tool-schema normaliser insist.
 */
export const PRESELECT_SCHEMA = {
  type: "object",
  properties: { tools: { type: "array", items: { type: "string" } } },
  required: ["tools"],
  additionalProperties: false,
};

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
 * @param names What the preselector replied: `{ tools: [...] }` as `PRESELECT_SCHEMA` has it, or
 * the bare array an older prompt asked for. Unvalidated: anything else gives none, and entries
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
  const list =
    names && typeof names === "object" && !Array.isArray(names)
      ? (names as { tools?: unknown }).tools
      : names;
  if (!Array.isArray(list)) return [];
  const wanted = list.filter((name): name is string => typeof name === "string");
  return expandNames(wanted, catalog, maxPerLoad).matched.slice(0, maxPerLoad);
}

/**
 * Saturation and length normalisation for the BM25 score. Robertson's usual values.
 *
 * Nothing here is tuned for this corpus, because tuning them against a catalogue of forty short
 * documents would be fitting noise. `dropoff` and `minScore` are the knobs worth turning.
 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * The least a best match may score and still be acted on without a model.
 *
 * A BM25 score, so it is read against the shape of the corpus rather than as a percentage: a
 * query term carried by half the catalogue is worth about 0.7, and one carried by a single tool
 * about 3. One at this floor is therefore "something more distinctive than a word every other
 * tool uses", which is the weakest evidence worth skipping a round trip on.
 *
 * A term is distinctive only against other terms, so a catalogue of three or four tools rarely
 * clears it. That is the right answer rather than a gap: a catalogue that small is not costing
 * enough tokens to be worth choosing from in the first place.
 */
export const KEYWORD_MIN_SCORE = 1;

/**
 * How far the best unpicked tool must fall below the last picked one for the cut to count clean.
 *
 * Half. The cap is the only reason a hit is dropped, so a hit just underneath it scoring nearly
 * as much as one just above means the ranking chose arbitrarily, which is exactly the case a
 * model should be spent on.
 */
export const KEYWORD_DROPOFF = 0.5;

/**
 * English function words, dropped before matching.
 *
 * The inverse document frequency is supposed to make this unnecessary, and over a real corpus it
 * would: a word carried by every document is worth nothing. But a tool catalogue is twenty
 * one-line descriptions, and at that size "for" or "on" is rare by accident — it lands in one
 * description, scores as the most distinctive term in the query, and a request that says "for me"
 * is answered with whichever tool happened to use the word. Only closure-class words are here;
 * "list", "get", "run" and "show" are what tools are called and stay.
 */
const NOISE = new Set(
  (
    "about all also am an and any are as at be been being but by can could do does for from had " +
    "has have how if in into is it its just me more most my no not of on or other our out over " +
    "please should so some such than that the their them then there these they this to too up us " +
    "very was we were what when where which who will with would you your"
  ).split(" "),
);

/**
 * A text as the matcher reads it: lowercase words, `server__tool_name` and camelCase split apart.
 *
 * Plurals are folded, crudely, by dropping a trailing `s`: a request says "read the files" and
 * the tool is called `read_file`, and without this the two do not meet. Nothing else is stemmed —
 * a real stemmer is a table of English morphology, and this is matching identifiers.
 */
const terms = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !NOISE.has(word))
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word,
    );

/** One tool's score against a request. */
export interface ToolMatch {
  name: string;
  /** Its BM25 score. Zero-scoring tools are not ranked at all. */
  score: number;
}

/** What `preselectByKeywords` found. */
export interface KeywordPreselection {
  /** The names, best first, capped at `maxPerLoad`. */
  names: string[];
  /** Whether the match is clear enough to run on without asking a model. */
  confident: boolean;
  /** Every tool that scored at all, best first — for a caller measuring its own threshold. */
  ranked: ToolMatch[];
}

/** What `preselectByKeywords` takes besides the catalogue and the request. */
export interface KeywordPreselectOptions {
  /** The most to pick, defaulting to `MAX_PER_LOAD`. The same cap the model is held to. */
  maxPerLoad?: number;
  /** The floor under a confident best match, defaulting to `KEYWORD_MIN_SCORE`. */
  minScore?: number;
  /** The gap a confident cut needs, defaulting to `KEYWORD_DROPOFF`. */
  dropoff?: number;
  /** Where the request is cut, defaulting to 2000 — the same head `preselectInput` reads. */
  maxPromptChars?: number;
}

/**
 * The tools a request's own words point at, ranked, and whether they point clearly enough.
 *
 * A preselection call costs a round trip to a model that is being asked to do term matching, and
 * on a local box that is seconds before the run has started. For a catalogue of a few dozen tools
 * the words usually decide it: a request that says "commit" and a tool called `git__commit` need
 * no reasoning to connect.
 *
 * BM25 rather than counting shared words, because the ranking has to survive the words every tool
 * uses. "list", "get" and "file" are in half the descriptions in a real catalogue, and a plain
 * overlap count hands the top of the ranking to whichever tool has the longest description. The
 * inverse document frequency makes a term worth what it distinguishes, and the length
 * normalisation stops a wordy description from outscoring the tool actually named.
 *
 * `confident` is what a caller acts on, and it is deliberately hard to earn: something more
 * distinctive than a word the whole catalogue shares has to have matched, and the tools left
 * unpicked have to score well below the ones picked. Anything else is ambiguous, and ambiguous is
 * what the model is for. Nothing matching is not confident either — the words cannot tell "this
 * request needs no tools" from "these words are not in the catalogue".
 *
 * @param catalog The servers to choose from. Each tool is matched on its name, its server's label
 * and its one-line description, which is everything the catalogue holds.
 * @param prompt The request being planned for. Only its head is read, as in `preselectInput`.
 * @param options The cap, the two confidence thresholds, and where the request is cut.
 */
export function preselectByKeywords(
  catalog: CatalogServer[],
  prompt: string,
  {
    maxPerLoad = MAX_PER_LOAD,
    minScore = KEYWORD_MIN_SCORE,
    dropoff = KEYWORD_DROPOFF,
    maxPromptChars = PRESELECT_PROMPT_CHARS,
  }: KeywordPreselectOptions = {},
): KeywordPreselection {
  const empty: KeywordPreselection = { names: [], confident: false, ranked: [] };
  const docs = catalog.flatMap((server) =>
    server.tools.map((tool) => ({
      name: tool.name,
      terms: terms(`${tool.name} ${server.label} ${tool.description}`),
    })),
  );
  // A query term repeated in the request is not worth more than one said once: the request is
  // prose about a task, not a document being matched against another document.
  const query = new Set(terms(prompt.slice(0, maxPromptChars)));
  if (!docs.length || !query.size) return empty;

  const length = docs.reduce((total, doc) => total + doc.terms.length, 0) / docs.length;
  const documents = new Map<string, number>();
  for (const doc of docs)
    for (const term of new Set(doc.terms)) documents.set(term, (documents.get(term) ?? 0) + 1);

  const ranked = docs
    .map((doc) => {
      const counts = new Map<string, number>();
      for (const term of doc.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
      let score = 0;
      for (const term of query) {
        const found = counts.get(term);
        if (!found) continue;
        const held = documents.get(term) ?? 0;
        const idf = Math.log(1 + (docs.length - held + 0.5) / (held + 0.5));
        const norm = BM25_K1 * (1 - BM25_B + (BM25_B * doc.terms.length) / length);
        score += (idf * found * (BM25_K1 + 1)) / (found + norm);
      }
      return { name: doc.name, score };
    })
    .filter((hit) => hit.score > 0)
    // Ties break on the name, not on where the tool sat in the catalogue, so reconnecting a
    // server in a different order does not change what a run opens with.
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  if (!ranked.length) return empty;

  const names = ranked.slice(0, maxPerLoad).map((hit) => hit.name);
  const cut = ranked[names.length - 1].score;
  const next = ranked[maxPerLoad]?.score ?? 0;
  return { names, confident: ranked[0].score >= minScore && next <= dropoff * cut, ranked };
}
