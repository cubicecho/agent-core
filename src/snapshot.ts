import { capabilitiesById, knownCapabilities, modelCapabilitiesFor } from "./capabilities.ts";
import { hintKey, refusedHints } from "./side-task.ts";

/**
 * What endpoints and models refused, carried across a restart.
 *
 * Every latch here dies with the process, so each restart of a consumer spends one refused request
 * per endpoint and model learning the same facts again, with a notice each time — and on a local
 * reasoning model the first side task after boot is sent the hints, refused and sent again. The
 * package cannot know where a consumer keeps state, so it hands over a blob and takes one back.
 */

/** The version `importCapabilities` accepts. Raised when what is latched changes shape. */
export const CAPABILITY_SNAPSHOT_VERSION = 1;

/** What one model on an endpoint refused. `true` is not refused, as on `ModelCapabilities`. */
export interface ModelSnapshot {
  reasoningEffort: boolean;
  legacyTokenLimit: boolean;
  chosenTemperature: boolean;
  refusedFields: string[];
  structuredOutput: boolean;
  /**
   * Continues a trailing assistant message. Absent in a snapshot taken before it was latched, which
   * reads as not refused.
   */
  assistantPrefill: boolean;
  /** Takes the no-thinking hints `ask` sends. */
  thinkingHints: boolean;
  /**
   * Efforts refused by value rather than by field, so a restart does not spend a request per rung
   * walking the ladder again. Absent in a snapshot taken before they were latched, which reads as
   * none refused.
   */
  refusedEfforts?: string[];
  /** The efforts a refusal published as this model's, in ladder order. Absent is none published. */
  supportedEfforts?: string[];
}

/** What one endpoint refused, and under it what each of its models did. */
export interface EndpointSnapshot {
  strictSchemas: boolean;
  usageInStream: boolean;
  models: Record<string, ModelSnapshot>;
  /**
   * When this endpoint was first met, as epoch milliseconds, so `expireCapabilities` measures a
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
  /** By `endpointId`: the endpoint's URL and key hashed together, so no key is in the blob. */
  endpoints: Record<string, EndpointSnapshot>;
}

const optimisticModel = (): ModelSnapshot => ({
  reasoningEffort: true,
  legacyTokenLimit: true,
  chosenTemperature: true,
  refusedFields: [],
  structuredOutput: true,
  assistantPrefill: true,
  thinkingHints: true,
  refusedEfforts: [],
});

const refusedAnything = (model: ModelSnapshot) =>
  !model.reasoningEffort ||
  !model.legacyTokenLimit ||
  !model.chosenTemperature ||
  !model.thinkingHints ||
  !model.structuredOutput ||
  !model.assistantPrefill ||
  model.refusedFields.length > 0 ||
  (model.refusedEfforts?.length ?? 0) > 0;

/**
 * Every refusal this process has latched, as a JSON-safe blob to store and hand back on boot.
 *
 * Covers what `negotiate` latches on endpoints and models and the models `ask` found refusing the
 * no-thinking hints. Only what was actually refused is in it, so a snapshot of a process that met
 * no refusals has no endpoints. Endpoints are named by digest rather than URL and key, since the
 * blob is meant to be written somewhere and a key must not be written with it. Each carries the
 * `since` it was learned at, so importing it does not make an old latch young again.
 */
export function exportCapabilities(): CapabilitySnapshot {
  const endpoints: Record<string, EndpointSnapshot> = {};
  const entry = (id: string) => {
    const held = endpoints[id];
    if (held) return held;
    const fresh: EndpointSnapshot = { strictSchemas: true, usageInStream: true, models: {} };
    const since = knownCapabilities().get(id)?.since;
    if (since !== undefined) fresh.since = since;
    endpoints[id] = fresh;
    return fresh;
  };
  for (const [id, supports] of knownCapabilities()) {
    const models: Record<string, ModelSnapshot> = {};
    for (const [name, refused] of supports.models) {
      const model = {
        ...optimisticModel(),
        reasoningEffort: refused.reasoningEffort,
        legacyTokenLimit: refused.legacyTokenLimit,
        chosenTemperature: refused.chosenTemperature,
        refusedFields: [...refused.refusedFields].sort(),
        structuredOutput: refused.structuredOutput,
        assistantPrefill: refused.assistantPrefill,
        refusedEfforts: [...refused.refusedEfforts].sort(),
        // Only alongside a refusal, since on its own a published list latches nothing: the model
        // named it while refusing a rung, and that rung is in `refusedEfforts`.
        ...(refused.supportedEfforts ? { supportedEfforts: [...refused.supportedEfforts] } : {}),
      };
      if (refusedAnything(model)) models[name] = model;
    }
    if (!supports.strictSchemas || !supports.usageInStream || Object.keys(models).length) {
      Object.assign(entry(id), {
        strictSchemas: supports.strictSchemas,
        usageInStream: supports.usageInStream,
        models,
      });
    }
  }
  for (const key of refusedHints()) {
    const [id, name] = JSON.parse(key) as [string, string];
    const models = entry(id).models;
    models[name] ??= optimisticModel();
    models[name].thinkingHints = false;
  }
  return { version: CAPABILITY_SNAPSHOT_VERSION, savedAt: new Date().toISOString(), endpoints };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Latches what a stored snapshot says was refused, on top of whatever this process has learned.
 *
 * Refusals only ever latch off, so importing merges rather than replaces: a flag already off stays
 * off whatever the snapshot says, and one the snapshot has off is turned off. A snapshot of another
 * version, or anything that is not one, is ignored — a stale shape costs the refused requests it
 * would have saved, which is what a restart cost before. How old is too old is the consumer's call,
 * made on `savedAt` before importing, or afterwards per endpoint with `expireCapabilities`, since a
 * server behind a URL can be upgraded between boots.
 *
 * @param snapshot What `exportCapabilities` returned, as stored. Read defensively: a field of the
 * wrong type is skipped rather than trusted.
 * @returns Whether the snapshot was of this version and applied.
 */
export function importCapabilities(snapshot: unknown): boolean {
  if (!isRecord(snapshot) || snapshot.version !== CAPABILITY_SNAPSHOT_VERSION) return false;
  if (!isRecord(snapshot.endpoints)) return false;
  for (const [id, endpoint] of Object.entries(snapshot.endpoints)) {
    if (!isRecord(endpoint)) continue;
    const supports = capabilitiesById(id);
    if (endpoint.strictSchemas === false) supports.strictSchemas = false;
    if (endpoint.usageInStream === false) supports.usageInStream = false;
    // Older of the two, so a snapshot ages an entry and never rejuvenates one: importing must not
    // be a way to keep a latch from ever reaching `expireCapabilities`.
    if (typeof endpoint.since === "number" && endpoint.since < supports.since) {
      supports.since = endpoint.since;
    }
    if (!isRecord(endpoint.models)) continue;
    for (const [name, model] of Object.entries(endpoint.models)) {
      if (!isRecord(model)) continue;
      const refused = modelCapabilitiesFor(supports, name);
      if (model.reasoningEffort === false) refused.reasoningEffort = false;
      if (model.legacyTokenLimit === false) refused.legacyTokenLimit = false;
      if (model.chosenTemperature === false) refused.chosenTemperature = false;
      if (model.structuredOutput === false) refused.structuredOutput = false;
      if (model.assistantPrefill === false) refused.assistantPrefill = false;
      if (Array.isArray(model.refusedEfforts)) {
        for (const effort of model.refusedEfforts) {
          if (typeof effort === "string") refused.refusedEfforts.add(effort);
        }
      }
      // Replaced rather than merged: two lists of what one model takes are two readings of the
      // same fact, and the stored one is at least as recent as an empty absent.
      if (Array.isArray(model.supportedEfforts)) {
        const listed = model.supportedEfforts.filter((value) => typeof value === "string");
        if (listed.length) refused.supportedEfforts = listed;
      }
      if (Array.isArray(model.refusedFields)) {
        for (const field of model.refusedFields) {
          if (typeof field === "string") refused.refusedFields.add(field);
        }
      }
      if (model.thinkingHints === false) refusedHints().add(hintKey(id, name));
    }
  }
  return true;
}
