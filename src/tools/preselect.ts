import type { Endpoint } from '../core/config.ts';
import { PRESELECT_DEFAULTS } from '../core/defaults.ts';
import { byCodeUnit, counted, isRecord } from '../core/guards.ts';
import type { OnNotice } from '../endpoint/capabilities.ts';
import { askJson, tryAsk } from '../turn/side-task.ts';
import { SchemaType } from '../wire/wire.ts';
import type { CatalogServer } from './catalog.ts';
import { catalogList, expandNames, MAX_PER_LOAD } from './tool-loading.ts';

/**
 * Choosing an exchange's tools before it starts, from the request and the catalogue's names.
 *
 * On-demand loading spends the first round trip on the model reading the catalogue and asking for
 * what it wants. A shortlist made beforehand saves that trip, and there are two ways to make one:
 * a small model reading the same catalogue, or the request's own words scored against the tool
 * names, which costs nothing and is trusted only when the words are clear about it.
 */

const { bm25K1, bm25B, shortestPluralChars } = PRESELECT_DEFAULTS;

/**
 * The system prompt a preselector is given, holding it to the cap its answer will be held to.
 *
 * @param [maxPerLoad] - The most to ask for. Give `preselection` the
 * same number: this one is what the preselector is told, and that one is what it is held to.
 * @returns The prompt, with the cap written into it.
 *
 * @remarks
 * On-demand loading otherwise costs a round trip every exchange: the model reads the catalogue,
 * calls `load_tools`, and only then can do the work. A small model reading the same catalogue
 * usually names the right tools outright, so the task model finds them already loaded and
 * starts working on its first turn.
 *
 * A wrong guess is cheap — an unused definition is a few hundred tokens for one exchange — but a
 * broad guess is not, so the same cap applies here as to a `load_tools` call.
 */
export const preselectSystem = (maxPerLoad = MAX_PER_LOAD) =>
  'You choose tools. Below is a catalogue of tool names, then a request. Reply with a JSON ' +
  'object whose "tools" array holds the names the request is likely to need — exact names from ' +
  `the catalogue, at most ${maxPerLoad}, and as few as could do the job. Reply with ` +
  '`{"tools": []}` if the request can be answered without tools. Reply with the object alone — ' +
  'no prose, no explanation.';

/**
 * The shape a preselector's answer is held to where the server takes a schema: `{ tools: [...] }`.
 *
 * @remarks
 * An object around the array rather than the array, because a structured answer's root has to be
 * an object — OpenAI's strict mode and every tool-schema normaliser insist.
 */
export const PRESELECT_SCHEMA = {
  type: SchemaType.Object,
  properties: { tools: { type: SchemaType.Array, items: { type: SchemaType.String } } },
  required: ['tools'],
  additionalProperties: false,
};

/** The preselection system prompt at the default cap, for a caller that never changes it. */
export const PRESELECT_SYSTEM = preselectSystem();

/**
 * The user message for a preselection call: the catalogue, then the request.
 *
 * @param catalog - The connected servers, rendered as the name-only listing.
 * @param prompt - The request being planned for, truncated — choosing tools needs the shape of the
 * ask, not all of it.
 * @param [maxPromptChars] - Where the request is cut. A caller whose requests
 * carry the part that names the work at the end wants a larger one, and pays for it in the
 * preselector's prompt.
 * @returns The message text: the listing under a `# Tool catalogue` heading, then the cut request
 * under `# Request`.
 */
export const preselectInput = (
  catalog: CatalogServer[],
  prompt: string,
  maxPromptChars = PRESELECT_DEFAULTS.maxPromptChars,
) => `# Tool catalogue\n\n${catalogList(catalog)}\n\n# Request\n\n${prompt.slice(0, maxPromptChars)}`;

/**
 * Resolves a preselection against the catalogue: unknown names dropped, count capped.
 *
 * @param names - What the preselector replied: `{ tools: [...] }` as `PRESELECT_SCHEMA` has it, or
 * the bare array an older prompt asked for. Unvalidated: anything else gives none, and entries
 * that are not strings are dropped.
 * @param catalog - The servers to resolve against.
 * @param [maxPerLoad] - The most to keep. The same number
 * `preselectSystem` was given, or the model is being held to a cap it was never told about.
 * @returns Names as the catalogue spells them, each once, in the order they resolved, and never
 * more than `maxPerLoad`. Empty where nothing resolved.
 */
export function preselection(names: unknown, catalog: CatalogServer[], maxPerLoad = MAX_PER_LOAD): string[] {
  const list = isRecord(names) ? names.tools : names;
  if (!Array.isArray(list)) {
    return [];
  }
  const wanted = list.filter((name): name is string => typeof name === 'string');
  return expandNames(wanted, catalog, maxPerLoad).matched.slice(0, maxPerLoad);
}

/** What BM25 adds to both counts in its inverse document frequency, so a term every document holds still scores. */
const IDF_SMOOTHING = 0.5;

/** What the preselector's reply schema is called on the wire. */
const PRESELECT_SCHEMA_NAME = 'preselection';

/**
 * English function words, dropped before matching.
 *
 * @remarks
 * The inverse document frequency is supposed to make this unnecessary, and over a real corpus it
 * would: a word carried by every document is worth nothing. But a tool catalogue is twenty
 * one-line descriptions, and at that size "for" or "on" is rare by accident — it lands in one
 * description, scores as the most distinctive term in the query, and a request that says "for me"
 * is answered with whichever tool happened to use the word. Only closure-class words are here;
 * "list", "get", "run" and "show" are what tools are called and stay.
 */
const NOISE = new Set(
  (
    'about all also am an and any are as at be been being but by can could do does for from had ' +
    'has have how if in into is it its just me more most my no not of on or other our out over ' +
    'please should so some such than that the their them then there these they this to too up us ' +
    'very was we were what when where which who will with would you your'
  ).split(' '),
);

/**
 * A text as the matcher reads it: lowercase words, `server__tool_name` and camelCase split apart.
 *
 * @param text - A request, or a tool's name, server label and description run together.
 * @returns The words in the order they came, repeats kept. One-character words and the function
 * words in `NOISE` are left out, and anything but an ASCII letter or digit only separates words.
 *
 * @remarks
 * Plurals are folded, crudely, by dropping a trailing `s`: a request says "read the files" and
 * the tool is called `read_file`, and without this the two do not meet. Nothing else is stemmed —
 * a real stemmer is a table of English morphology, and this is matching identifiers.
 */
const terms = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !NOISE.has(word))
    .map((word) => {
      const isPlural = word.length > shortestPluralChars && word.endsWith('s') && word.endsWith('ss') === false;
      return isPlural ? word.slice(0, -1) : word;
    });

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
  /**
   * The most to pick. The same cap the model is held to.
   *
   * @defaultValue `12`
   */
  maxPerLoad?: number;
  /**
   * The floor under a confident best match.
   *
   * @defaultValue `1`
   */
  minScore?: number;
  /**
   * The gap a confident cut needs.
   *
   * @defaultValue `0.5`
   */
  dropoff?: number;
  /**
   * Where the request is cut — the same head `preselectInput` reads.
   *
   * @defaultValue `2000`
   */
  maxPromptChars?: number;
}

/**
 * The tools a request's own words point at, ranked, and whether they point clearly enough.
 *
 * @param catalog - The servers to choose from. Each tool is matched on its name, its server's label
 * and its one-line description, which is everything the catalogue holds.
 * @param prompt - The request being planned for. Only its head is read, as in `preselectInput`.
 * @param [options] - The cap, the two confidence thresholds, and where the request is cut.
 * @returns The ranking, the names picked from the top of it, and whether to act on them. No names
 * and not confident where the catalogue has no tools, the request has no word left to match on,
 * or nothing scored.
 *
 * @remarks
 * A preselection call costs a model round trip, seconds on a local box, for what is often term
 * matching: "commit" and `git__commit` need no reasoning to connect. BM25 rather than a count of
 * shared words, so a word every tool uses is worth only what it distinguishes and a wordy
 * description does not outscore the tool actually named. `confident` is deliberately hard to earn —
 * a distinctive word has to match and the unpicked tools have to score well below the picked — since
 * ambiguous is what the model is for (README, "What the servers say about themselves").
 */
export function preselectByKeywords(
  catalog: CatalogServer[],
  prompt: string,
  {
    maxPerLoad = MAX_PER_LOAD,
    minScore = PRESELECT_DEFAULTS.keywordMinScore,
    dropoff = PRESELECT_DEFAULTS.keywordDropoffShare,
    maxPromptChars = PRESELECT_DEFAULTS.maxPromptChars,
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
  if (!docs.length || !query.size) {
    return empty;
  }

  const length = docs.reduce((total, doc) => total + doc.terms.length, 0) / docs.length;
  const documents = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.terms)) {
      documents.set(term, (documents.get(term) ?? 0) + 1);
    }
  }

  const ranked: ToolMatch[] = [];
  for (const doc of docs) {
    const counts = new Map<string, number>();
    for (const term of doc.terms) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    let score = 0;
    for (const term of query) {
      const found = counts.get(term);
      if (!found) {
        continue;
      }
      const held = documents.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - held + IDF_SMOOTHING) / (held + IDF_SMOOTHING));
      const norm = bm25K1 * (1 - bm25B + (bm25B * doc.terms.length) / length);
      score += (idf * found * (bm25K1 + 1)) / (found + norm);
    }
    if (score > 0) {
      ranked.push({ name: doc.name, score });
    }
  }
  // Ties break on the name, not on where the tool sat in the catalogue, so reconnecting a
  // server in a different order does not change what an exchange opens with.
  ranked.sort((a, b) => b.score - a.score || byCodeUnit(a.name, b.name));
  if (!ranked.length) {
    return empty;
  }

  const names = ranked.slice(0, maxPerLoad).map((hit) => hit.name);
  const cut = ranked[names.length - 1].score;
  const next = ranked[maxPerLoad]?.score ?? 0;
  return { names, confident: ranked[0].score >= minScore && next <= dropoff * cut, ranked };
}

/** What `preselect` may be told beyond the question: how to stop it, and how to ask. */
export interface PreselectOptions {
  /** Abandons the side task. */
  signal?: AbortSignal;
  /** Hears how the choice was made, and what was given up on along the way. */
  onNotice?: OnNotice;
  /**
   * The reply's ceiling.
   *
   * @defaultValue `256`
   */
  maxTokens?: number;
  /**
   * As `SideTaskOptions.temperature`.
   *
   * @defaultValue `0.3`
   */
  temperature?: number;
  /** As `SideTaskOptions.reasoningEffort`: absent keeps the no-thinking hints. */
  reasoningEffort?: string;
  /** As `SideTaskOptions.extraBody`: sampler fields the options cannot spell. */
  extraBody?: Record<string, unknown>;
  /**
   * The most tools the choice may name.
   *
   * @defaultValue `12`
   */
  maxPerLoad?: number;
  /**
   * Try `preselectByKeywords` first and spend the model only on what it cannot settle. `true`
   * takes its defaults; an object tunes the thresholds. Its own `maxPerLoad` can ask the words
   * for fewer than `maxPerLoad` above, never for more. An empty `model` still means no
   * preselection at all, words included — that is what `toolSelectModel: ""` asks for.
   */
  keywords?: boolean | KeywordPreselectOptions;
}

/**
 * The tools a request is likely to need, picked by a small model before the exchange starts,
 * or none.
 *
 * @param config - The model server the preselector is reached through.
 * @param model - The preselector. An empty name picks nothing, silently, which is what
 * `toolSelectModel` means by empty: an app whose settings read `""` as "the exchange's model"
 * passes `toolSelectModel: settings.toolSelectModel || settings.model`.
 * @param catalog - The servers to choose from.
 * @param prompt - The request being planned for. Only its head is read; see `preselectInput`.
 * @param [options] - Cancellation, notices, the reply ceiling, the temperature, reasoning effort and
 * extra fields as `ask` reads them, the cap the choice is held to, and whether to try the words first.
 * @returns Names as the catalogue spells them, never more than `maxPerLoad`. Empty where `model` is
 * empty, the catalogue has no tools, the call failed, or its reply named nothing in the catalogue.
 *
 * @remarks
 * On-demand loading otherwise spends a round trip on reading the catalogue and calling
 * `load_tools`; a small model reading the same catalogue usually names the right tools, and the
 * task model opens with them in hand. A wrong guess costs a few hundred tokens for one exchange,
 * and a failed one costs nothing — it is reported through `onNotice` and answered with an empty
 * list, since a side task is never worth failing the exchange. A stop still throws.
 *
 * With `keywords`, the request's own words are matched against the catalogue first and the model
 * is spent only on what they cannot settle, which on a local box is the difference between an
 * exchange starting now and starting in a few seconds. The words have to be clear about it; see
 * `preselectByKeywords` for what that means.
 */
export async function preselect(
  config: Endpoint,
  model: string,
  catalog: CatalogServer[],
  prompt: string,
  {
    signal,
    onNotice,
    maxTokens = PRESELECT_DEFAULTS.maxTokens,
    temperature,
    reasoningEffort,
    extraBody,
    maxPerLoad = MAX_PER_LOAD,
    keywords,
  }: PreselectOptions = {},
): Promise<string[]> {
  if (!model || !catalog.some((server) => server.tools.length > 0)) {
    return [];
  }
  if (keywords) {
    const tuned = keywords === true ? {} : keywords;
    const guess = preselectByKeywords(catalog, prompt, {
      ...tuned,
      maxPerLoad: Math.min(maxPerLoad, tuned.maxPerLoad ?? maxPerLoad),
    });
    if (guess.confident) {
      onNotice?.(`chose ${counted(guess.names.length, 'tool')} by name`);
      return guess.names;
    }
  }
  const reply = await tryAsk(
    'preselect',
    () =>
      askJson<unknown>(config, model, preselectSystem(maxPerLoad), preselectInput(catalog, prompt), PRESELECT_SCHEMA, {
        name: PRESELECT_SCHEMA_NAME,
        maxTokens,
        temperature,
        reasoningEffort,
        extraBody,
        signal,
        onNotice,
      }),
    { onNotice, signal },
  );
  return preselection(reply, catalog, maxPerLoad);
}
