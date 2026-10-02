import type { OnNotice } from "./capabilities.ts";
import type { CatalogServer } from "./catalog.ts";
import type { Endpoint } from "./config.ts";
import { counted } from "./guards.ts";
import { askJson, tryAsk } from "./side-task.ts";
import {
  type KeywordPreselectOptions,
  MAX_PER_LOAD,
  PRESELECT_SCHEMA,
  preselectByKeywords,
  preselectInput,
  preselection,
  preselectSystem,
} from "./tool-loading.ts";

/** What `preselect` may be told beyond the question: how to stop it, and how to ask. */
export interface PreselectOptions {
  /** Abandons the side task. */
  signal?: AbortSignal;
  /** Hears how the choice was made, and what was given up on along the way. */
  onNotice?: OnNotice;
  /** The reply's ceiling, 256 when absent. */
  maxTokens?: number;
  /** As `SideTaskOptions.temperature`: absent is 0.3. */
  temperature?: number;
  /** As `SideTaskOptions.reasoningEffort`: absent keeps the no-thinking hints. */
  reasoningEffort?: string;
  /** The most tools the choice may name, `MAX_PER_LOAD` when absent. */
  maxPerLoad?: number;
  /**
   * Try `preselectByKeywords` first and spend the model only on what it cannot settle. `true`
   * takes its defaults; an object tunes the thresholds. An empty `model` still means no
   * preselection at all, words included — that is what `toolSelectModel: ""` asks for.
   */
  keywords?: boolean | KeywordPreselectOptions;
}

/**
 * The tools a request is likely to need, picked by a small model before the run starts, or none.
 *
 * On-demand loading otherwise spends a round trip on reading the catalogue and calling
 * `load_tools`; a small model reading the same catalogue usually names the right tools, and the
 * task model opens with them in hand. A wrong guess costs a few hundred tokens for one run, and
 * a failed one costs nothing — it is reported through `onNotice` and answered with an empty list,
 * since a side task is never worth failing the run. A stop still throws.
 *
 * With `keywords`, the request's own words are matched against the catalogue first and the model
 * is spent only on what they cannot settle, which on a local box is the difference between a run
 * starting now and starting in a few seconds. The words have to be clear about it; see
 * `preselectByKeywords` for what that means.
 *
 * @param config The endpoint the preselector is reached through.
 * @param model The preselector. An empty name picks nothing, which is what `toolSelectModel`
 * means by empty.
 * @param catalog The servers to choose from.
 * @param prompt The request being planned for. Only its head is read; see `preselectInput`.
 * @param options Cancellation, notices, the reply ceiling (256), the temperature and reasoning
 * effort as `ask` reads them (0.3 and none when absent), the cap the choice is held to
 * (`MAX_PER_LOAD`), and whether to try the words first.
 */
export async function preselect(
  config: Endpoint,
  model: string,
  catalog: CatalogServer[],
  prompt: string,
  {
    signal,
    onNotice,
    maxTokens = 256,
    temperature,
    reasoningEffort,
    maxPerLoad = MAX_PER_LOAD,
    keywords,
  }: PreselectOptions = {},
): Promise<string[]> {
  if (!model || !catalog.some((server) => server.tools.length > 0)) return [];
  if (keywords) {
    const guess = preselectByKeywords(catalog, prompt, {
      maxPerLoad,
      ...(keywords === true ? {} : keywords),
    });
    if (guess.confident) {
      onNotice?.(`chose ${counted(guess.names.length, "tool")} by name`);
      return guess.names;
    }
  }
  const reply = await tryAsk(
    "preselect",
    () =>
      askJson<unknown>(
        config,
        model,
        preselectSystem(maxPerLoad),
        preselectInput(catalog, prompt),
        PRESELECT_SCHEMA,
        { name: "preselection", maxTokens, temperature, reasoningEffort, signal, onNotice },
      ),
    { onNotice },
  );
  return preselection(reply, catalog, maxPerLoad);
}
