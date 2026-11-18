import type { Endpoint } from '../core/config.ts';
import { isRecord } from '../core/guards.ts';
import {
  capabilitiesById,
  knownCapabilities,
  latchEfforts,
  latchEndpoint,
  latchFields,
  latchModel,
  MODEL_FLAGS,
  modelCapabilitiesFor,
  OPTIMISTIC_MODEL,
} from '../endpoint/capabilities.ts';

/**
 * What model servers and models refused, carried across a restart.
 *
 * Every latch here dies with the process, so each restart of a consumer spends one refused request
 * per model server and model learning the same facts again, with a notice each time — and on a
 * local reasoning model the first side task after boot is sent the hints, refused and sent again.
 * The package cannot know where a consumer keeps state, so it hands over a blob and takes one back.
 */

/** The version `importCapabilities` accepts. Raised when what is latched changes shape. */
export const CAPABILITY_SNAPSHOT_VERSION = 1;

/** What one model on a model server refused. `true` is not refused, as on `ModelCapabilities`. */
export interface ModelSnapshot {
  reasoningEffort: boolean;
  legacyTokenLimit: boolean;
  chosenTemperature: boolean;
  refusedFields: string[];
  structuredOutput: boolean;
  /**
   * Continues a trailing assistant message. Always written; a stored snapshot from before it was
   * latched lacks it, which `importCapabilities` reads as not refused.
   */
  assistantPrefill: boolean;
  /**
   * Takes `reasoning_content` on a replayed assistant message. Always written; a stored snapshot
   * from before it was latched lacks it, which `importCapabilities` reads as not refused.
   */
  reasoningContent: boolean;
  /**
   * Takes a replayed assistant message with several tool calls. Always written; a stored snapshot
   * from before it was latched lacks it, which `importCapabilities` reads as not refused.
   */
  multiCallMessages: boolean;
  /**
   * Takes the no-thinking hints `ask` sends. Only a snapshot from before 6.0.0 holds it off: a
   * refusal of the hints is now one of `refusedFields`.
   */
  thinkingHints: boolean;
  /**
   * Efforts refused by value rather than by field, so a restart does not spend a request per rung
   * walking the ladder again. Absent in a snapshot taken before they were latched, which reads as
   * none refused.
   */
  refusedEfforts?: string[];
  /** The efforts a refusal published as this model's, in the order it gave them. Absent is none published. */
  supportedEfforts?: string[];
}

/** What one model server refused, and under it what each of its models did. */
export interface EndpointSnapshot {
  strictSchemas: boolean;
  usageInStream: boolean;
  models: Record<string, ModelSnapshot>;
  /**
   * When this model server was first met, as epoch milliseconds, so `expireCapabilities` measures a
   * latch from when it was learned rather than from the boot that imported it. Absent in a snapshot
   * taken before it was written, which reads as met now — the behaviour of every release until this
   * one, and the reason no version bump is owed.
   */
  since?: number;
}

/** Every latched refusal in the process, JSON-safe. See `exportCapabilities`. */
export interface CapabilitySnapshot {
  version: number;
  /** When it was taken, as an ISO string, for the consumer to judge how stale is too stale. */
  savedAt: string;
  /** By `endpointId`: the model server's URL and key hashed together, so no key is in the blob. */
  endpoints: Record<string, EndpointSnapshot>;
}

/**
 * A model's snapshot as it starts out: every flag on, and both refused lists empty.
 *
 * @returns A fresh object each time, since `exportCapabilities` writes onto what it is given.
 */
const optimisticModel = (): ModelSnapshot => ({
  ...OPTIMISTIC_MODEL,
  refusedFields: [],
  refusedEfforts: [],
});

/**
 * Whether a model's snapshot holds a refusal, which is what earns it a place in the blob.
 *
 * @param model - The snapshot. Its `supportedEfforts` is not read: a published list latches
 * nothing.
 * @returns `true` where a flag is off, the hints included, or either refused list has an entry.
 */
const refusedAnything = (model: ModelSnapshot) =>
  MODEL_FLAGS.some((flag) => !model[flag]) || model.refusedFields.length > 0 || (model.refusedEfforts?.length ?? 0) > 0;

/**
 * The strings in a stored list, skipping what is not a list of them.
 *
 * @param stored - The list as the snapshot holds it.
 * @returns Its strings, in order. Anything but an array reads as none, and an entry that is not a
 * string is skipped on its own.
 */
const storedStrings = (stored: unknown): string[] =>
  Array.isArray(stored) ? stored.filter((value) => typeof value === 'string') : [];

/**
 * Every refusal this process has latched through one `fetch`, as a JSON-safe blob to store and hand
 * back on boot.
 *
 * @param [through] - Read for `fetch` alone: the latches of the model servers that send through
 * it, absent being the global `fetch`. A whole `Endpoint` will do.
 * @returns A fresh object that shares nothing with the live latches, its lists copied and the two
 * refused ones sorted.
 *
 * @remarks
 * Covers what `negotiate` latches on model servers and models, the no-thinking hints among the
 * refused fields. Only what was actually refused is in it. Model servers are named by digest rather
 * than URL and key, since a key must not be written with the blob, and each carries the `since` it
 * was learned at. A function cannot be written down, so the blob does not say which `fetch` it was
 * taken through: an app whose model servers send through one of its own exports and imports with
 * the same function on each side, and the latches of any other function are not in it.
 */
export function exportCapabilities(through: Pick<Endpoint, 'fetch'> = {}): CapabilitySnapshot {
  const endpoints: Record<string, EndpointSnapshot> = {};
  for (const [id, supports] of knownCapabilities(through.fetch)) {
    const models: Record<string, ModelSnapshot> = {};
    for (const [name, refused] of supports.models) {
      const model = optimisticModel();
      for (const flag of MODEL_FLAGS) {
        model[flag] = refused[flag];
      }
      model.refusedFields = [...refused.refusedFields].sort();
      model.refusedEfforts = [...refused.refusedEfforts].sort();
      // Only alongside a refusal, since on its own a published list latches nothing: the model
      // named it while refusing a rung, and that rung is in `refusedEfforts`.
      if (refused.supportedEfforts) {
        model.supportedEfforts = [...refused.supportedEfforts];
      }
      if (refusedAnything(model)) {
        models[name] = model;
      }
    }
    if (!supports.strictSchemas || !supports.usageInStream || Object.keys(models).length) {
      endpoints[id] = {
        strictSchemas: supports.strictSchemas,
        usageInStream: supports.usageInStream,
        models,
        since: supports.since,
      };
    }
  }
  return { version: CAPABILITY_SNAPSHOT_VERSION, savedAt: new Date().toISOString(), endpoints };
}

/**
 * Latches what a stored snapshot says was refused, on top of whatever this process has learned.
 *
 * @param snapshot - What `exportCapabilities` returned, as stored. Read defensively: a field of the
 * wrong type is skipped rather than trusted.
 * @param [through] - Read for `fetch` alone: the function whose model servers the latches are for,
 * absent being the global `fetch`, as `exportCapabilities` was given it.
 * @returns Whether the snapshot was of this version and applied.
 *
 * @remarks
 * Refusals only ever latch off, so importing merges rather than replaces: a flag already off stays
 * off whatever the snapshot says, and one the snapshot has off is turned off. A snapshot of another
 * version, or anything that is not one, is ignored — a stale shape costs the refused requests it
 * would have saved, which is what a restart cost before. How old is too old is the consumer's call,
 * made on `savedAt` before importing, or afterwards with `expireCapabilities`.
 */
export function importCapabilities(snapshot: unknown, through: Pick<Endpoint, 'fetch'> = {}): boolean {
  if (!isRecord(snapshot) || snapshot.version !== CAPABILITY_SNAPSHOT_VERSION) {
    return false;
  }
  if (!isRecord(snapshot.endpoints)) {
    return false;
  }
  for (const [id, endpoint] of Object.entries(snapshot.endpoints)) {
    if (!isRecord(endpoint)) {
      continue;
    }
    const supports = capabilitiesById(id, through.fetch);
    if (endpoint.strictSchemas === false) {
      latchEndpoint(supports, 'strictSchemas');
    }
    if (endpoint.usageInStream === false) {
      latchEndpoint(supports, 'usageInStream');
    }
    // Older of the two, so a snapshot ages an entry and never rejuvenates one: importing must not
    // be a way to keep a latch from ever reaching `expireCapabilities`.
    if (typeof endpoint.since === 'number' && endpoint.since < supports.since) {
      supports.since = endpoint.since;
    }
    if (!isRecord(endpoint.models)) {
      continue;
    }
    for (const [name, model] of Object.entries(endpoint.models)) {
      if (!isRecord(model)) {
        continue;
      }
      const refused = modelCapabilitiesFor(supports, name);
      for (const flag of MODEL_FLAGS) {
        if (model[flag] === false) {
          latchModel(refused, flag);
        }
      }
      // Replaced rather than merged: two lists of what one model takes are two readings of the
      // same fact, and the stored one is at least as recent as an empty absent.
      const listed = storedStrings(model.supportedEfforts);
      latchEfforts(refused, storedStrings(model.refusedEfforts), listed.length ? listed : undefined);
      latchFields(refused, storedStrings(model.refusedFields));
    }
  }
  return true;
}
