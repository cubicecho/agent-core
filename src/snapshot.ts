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
  /** Takes the no-thinking hints `ask` sends. */
  thinkingHints: boolean;
}

/** What one endpoint refused, and under it what each of its models did. */
export interface EndpointSnapshot {
  strictSchemas: boolean;
  usageInStream: boolean;
  models: Record<string, ModelSnapshot>;
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
  thinkingHints: true,
});

const refusedAnything = (model: ModelSnapshot) =>
  !model.reasoningEffort ||
  !model.legacyTokenLimit ||
  !model.chosenTemperature ||
  !model.thinkingHints ||
  model.refusedFields.length > 0;

/**
 * Every refusal this process has latched, as a JSON-safe blob to store and hand back on boot.
 *
 * Covers what `negotiate` latches on endpoints and models and the models `ask` found refusing the
 * no-thinking hints. Only what was actually refused is in it, so a snapshot of a process that met
 * no refusals has no endpoints. Endpoints are named by digest rather than URL and key, since the
 * blob is meant to be written somewhere and a key must not be written with it.
 */
export function exportCapabilities(): CapabilitySnapshot {
  const endpoints: Record<string, EndpointSnapshot> = {};
  const entry = (id: string) => {
    endpoints[id] ??= { strictSchemas: true, usageInStream: true, models: {} };
    return endpoints[id];
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
 * made on `savedAt` before importing, since a server behind a URL can be upgraded between boots.
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
    if (!isRecord(endpoint.models)) continue;
    for (const [name, model] of Object.entries(endpoint.models)) {
      if (!isRecord(model)) continue;
      const refused = modelCapabilitiesFor(supports, name);
      if (model.reasoningEffort === false) refused.reasoningEffort = false;
      if (model.legacyTokenLimit === false) refused.legacyTokenLimit = false;
      if (model.chosenTemperature === false) refused.chosenTemperature = false;
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
