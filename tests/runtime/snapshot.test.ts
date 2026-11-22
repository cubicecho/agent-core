import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Create, reply } from '../helpers.ts';
import { NO_HINTS } from '../refusals.ts';

const create = vi.fn<Create>();
vi.mock('../../src/endpoint/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/endpoint/client.ts')>()),
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { capabilitiesFor, modelCapabilitiesFor } = await import('../../src/endpoint/capabilities.ts');
const { endpointId } = await import('../../src/endpoint/client.ts');
const { resetAll } = await import('../../src/runtime/reset.ts');
const { ask } = await import('../../src/turn/side-task.ts');
const { CAPABILITY_SNAPSHOT_VERSION, exportCapabilities, importCapabilities } = await import(
  '../../src/runtime/snapshot.ts'
);

const config = { baseUrl: 'http://box/v1', apiKey: 'sk-secret', requestTimeoutSeconds: 60 };

afterEach(() => {
  create.mockReset();
  resetAll();
});

describe('capability snapshots', () => {
  it('writes the same JSON byte for byte, the refused hints included, and reads it back to the same', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
    try {
      const other = { ...config, baseUrl: 'http://other/v1', apiKey: '' };
      const quiet = { ...config, baseUrl: 'http://quiet/v1' };

      const supports = capabilitiesFor(config);
      supports.strictSchemas = false;
      const big = modelCapabilitiesFor(supports, 'big');
      big.legacyTokenLimit = false;
      big.chosenTemperature = false;
      big.refusedFields.add('top_k').add('min_p');
      big.refusedEfforts.add('none');
      big.supportedEfforts = ['minimal', 'low', 'high'];
      // Asked about and refused nothing, so it is left out.
      modelCapabilitiesFor(supports, 'idle');
      capabilitiesFor(quiet).usageInStream = false;

      // The hints refused by a model with other refusals, by one with none, and on an endpoint
      // with nothing else latched.
      create.mockRejectedValueOnce(NO_HINTS).mockResolvedValueOnce(reply);
      await ask(config, 'big', 'system', 'user');
      create.mockRejectedValueOnce(NO_HINTS).mockResolvedValueOnce(reply);
      await ask(config, 'small', 'system', 'user');
      create.mockRejectedValueOnce(NO_HINTS).mockResolvedValueOnce(reply);
      await ask(other, 'tiny', 'system', 'user');

      const written = JSON.stringify(exportCapabilities(), null, 2);
      expect(written).toBe(`{
  "version": 2,
  "savedAt": "2026-01-02T03:04:05.000Z",
  "endpoints": {
    "${endpointId(config)}": {
      "strictSchemas": false,
      "usageInStream": true,
      "models": {
        "big": {
          "reasoningEffort": true,
          "legacyTokenLimit": false,
          "chosenTemperature": false,
          "structuredOutput": true,
          "assistantPrefill": true,
          "reasoningContent": true,
          "multiCallMessages": true,
          "refusedFields": [
            "chat_template_kwargs",
            "min_p",
            "top_k"
          ],
          "refusedEfforts": [
            "none"
          ],
          "supportedEfforts": [
            "minimal",
            "low",
            "high"
          ]
        },
        "small": {
          "reasoningEffort": true,
          "legacyTokenLimit": true,
          "chosenTemperature": true,
          "structuredOutput": true,
          "assistantPrefill": true,
          "reasoningContent": true,
          "multiCallMessages": true,
          "refusedFields": [
            "chat_template_kwargs"
          ],
          "refusedEfforts": []
        }
      },
      "since": 1767323045000
    },
    "${endpointId(quiet)}": {
      "strictSchemas": true,
      "usageInStream": false,
      "models": {},
      "since": 1767323045000
    },
    "${endpointId(other)}": {
      "strictSchemas": true,
      "usageInStream": true,
      "models": {
        "tiny": {
          "reasoningEffort": true,
          "legacyTokenLimit": true,
          "chosenTemperature": true,
          "structuredOutput": true,
          "assistantPrefill": true,
          "reasoningContent": true,
          "multiCallMessages": true,
          "refusedFields": [
            "chat_template_kwargs"
          ],
          "refusedEfforts": []
        }
      },
      "since": 1767323045000
    }
  }
}`);

      resetAll();
      expect(importCapabilities(JSON.parse(written))).toBe(true);
      expect(JSON.stringify(exportCapabilities(), null, 2)).toBe(written);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds nothing for a process that met no refusals', () => {
    capabilitiesFor(config);
    const snapshot = exportCapabilities();
    expect(snapshot.version).toBe(CAPABILITY_SNAPSHOT_VERSION);
    expect(Number.isNaN(Date.parse(snapshot.savedAt))).toBe(false);
    expect(snapshot.endpoints).toEqual({});
  });

  it('carries every latch across a restart, without the key', async () => {
    const supports = capabilitiesFor(config);
    supports.strictSchemas = false;
    const model = modelCapabilitiesFor(supports, 'big');
    model.legacyTokenLimit = false;
    model.refusedFields.add('min_p');
    create.mockRejectedValueOnce(NO_HINTS).mockResolvedValue(reply);
    await ask(config, 'small', 'system', 'user');

    const stored = JSON.stringify(exportCapabilities());
    expect(stored).not.toContain('sk-secret');
    expect(stored).not.toContain('http://box');

    resetAll();
    create.mockReset();
    expect(importCapabilities(JSON.parse(stored))).toBe(true);
    const restored = capabilitiesFor(config);
    expect(restored.strictSchemas).toBe(false);
    expect(modelCapabilitiesFor(restored, 'big')).toMatchObject({ legacyTokenLimit: false });
    expect([...modelCapabilitiesFor(restored, 'big').refusedFields]).toEqual(['min_p']);
    create.mockResolvedValue(reply);
    await ask(config, 'small', 'system', 'user');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).not.toHaveProperty('chat_template_kwargs');
  });

  it('only latches off, whatever the snapshot says', () => {
    const supports = capabilitiesFor(config);
    supports.usageInStream = false;
    const id = endpointId(config);
    importCapabilities({
      version: CAPABILITY_SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      endpoints: { [id]: { strictSchemas: true, usageInStream: true, models: {} } },
    });
    expect(supports.usageInStream).toBe(false);
    expect(capabilitiesFor(config)).toBe(supports);
  });

  it('keeps the older age, so importing never makes a latch young again', () => {
    // Otherwise a consumer that stores a snapshot and reads it back on every boot has an entry
    // that is permanently minutes old, and `expireCapabilities` never reaches it.
    const supports = capabilitiesFor(config);
    supports.strictSchemas = false;
    const stored = JSON.parse(JSON.stringify(exportCapabilities()));
    const id = endpointId(config);
    expect(stored.endpoints[id].since).toBe(supports.since);

    resetAll();
    expect(importCapabilities(stored)).toBe(true);
    expect(capabilitiesFor(config).since).toBe(stored.endpoints[id].since);

    // And a second import of a newer snapshot of the same endpoint does not undo that.
    const fresh = {
      ...stored,
      endpoints: { [id]: { ...stored.endpoints[id], since: Date.now() } },
    };
    expect(importCapabilities(fresh)).toBe(true);
    expect(capabilitiesFor(config).since).toBe(stored.endpoints[id].since);
  });

  it('treats a snapshot from before ages were written as met now', () => {
    const id = endpointId(config);
    const at = Date.now();
    expect(
      importCapabilities({
        version: CAPABILITY_SNAPSHOT_VERSION,
        savedAt: new Date().toISOString(),
        endpoints: { [id]: { strictSchemas: false, usageInStream: true, models: {} } },
      }),
    ).toBe(true);
    const restored = capabilitiesFor(config);
    expect(restored.strictSchemas).toBe(false);
    expect(restored.since).toBeGreaterThanOrEqual(at);
  });

  it('ignores another version, and anything that is not a snapshot', () => {
    const id = endpointId(config);
    const endpoints = { [id]: { strictSchemas: false, usageInStream: false, models: {} } };
    expect(importCapabilities({ version: 0, savedAt: '', endpoints })).toBe(false);
    expect(importCapabilities(null)).toBe(false);
    expect(importCapabilities('nope')).toBe(false);
    expect(importCapabilities({ version: CAPABILITY_SNAPSHOT_VERSION, endpoints: 'nope' })).toBe(false);
    expect(capabilitiesFor(config).strictSchemas).toBe(true);
  });

  it('skips a field of the wrong type, and keeps reading the rest', () => {
    const id = endpointId(config);
    expect(
      importCapabilities({
        version: CAPABILITY_SNAPSHOT_VERSION,
        endpoints: { [id]: { models: { m: { refusedFields: [1, 'top_k'] } } } },
      }),
    ).toBe(true);
    const model = modelCapabilitiesFor(capabilitiesFor(config), 'm');
    expect([...model.refusedFields]).toEqual(['top_k']);
    expect(model.reasoningEffort).toBe(true);
  });

  it('skips an endpoint, a model list or a model that is not an object', () => {
    const id = endpointId(config);
    const other = endpointId({ ...config, baseUrl: 'http://other/v1' });
    const quiet = endpointId({ ...config, baseUrl: 'http://quiet/v1' });
    expect(
      importCapabilities({
        version: CAPABILITY_SNAPSHOT_VERSION,
        endpoints: {
          broken: 3,
          [other]: { strictSchemas: false, models: 'nope' },
          [quiet]: { models: { m: 3 } },
          [id]: { models: { m: { reasoningEffort: false } } },
        },
      }),
    ).toBe(true);
    // The endpoint after the ones skipped is still read.
    expect(modelCapabilitiesFor(capabilitiesFor(config), 'm').reasoningEffort).toBe(false);
    // An endpoint's own flags are read before its model list is found wanting.
    expect(capabilitiesFor({ ...config, baseUrl: 'http://other/v1' }).strictSchemas).toBe(false);
    expect(capabilitiesFor({ ...config, baseUrl: 'http://quiet/v1' }).models.has('m')).toBe(false);
  });
});
