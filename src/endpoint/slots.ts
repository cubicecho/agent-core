import { baseUrlKey, type Endpoint } from '../core/config.ts';
import { getOrCreate } from '../core/guards.ts';
import { scoped } from '../core/scope.ts';
import { capabilitiesFor, modelCapabilitiesFor, type OnNotice } from './capabilities.ts';
import { modelKey, servedSlots } from './client.ts';

/**
 * Which slot of a multi-slot llama.cpp server each session is on, so concurrent runs stop
 * evicting each other's prompt cache.
 *
 * `llama-server --parallel N` keeps one KV cache per slot, and a turn that lands on a slot holding
 * another run's prefix is prefilled again from the top. The server's own choice is a guess by
 * prompt similarity; this hands each session a slot of its own for as long as it holds it, and
 * the same one again next time where it is still free.
 */

/** The request field that names a llama.cpp slot. */
export const SLOT_FIELD = 'id_slot' as const;

/** The request field that asks llama.cpp to reuse the slot's cached prefix. On by default there. */
export const CACHE_PROMPT_FIELD = 'cache_prompt' as const;

/** The header llm-router's sticky affinity reads first, which keeps a session on one provider. */
export const SESSION_HEADER = 'X-Session-Id' as const;

/** One slot as the allocator remembers it. */
interface Slot {
  /** The session holding it now. Absent is free. */
  holder?: string;
  /** The session that held it last, whose prefix its cache still holds. */
  last?: string;
  /** When it was last released, as a counter rather than a clock, so two releases never tie. */
  released: number;
}

/** One endpoint and model's slots: every one it has had, and how many it has now. */
interface SlotPool {
  /** Never shortened, so a slot held across a shrink keeps its holder. */
  slots: Slot[];
  /** How many of `slots`, from the first, may be handed out. */
  total: number;
}

/** Hands one endpoint's slots to sessions. See `slotAllocator`. */
export interface SlotAllocator {
  /** How many slots the endpoint last said it has, through any allocator for it. */
  readonly total: number;
  /**
   * Gives a session a slot for as long as it holds it.
   *
   * @param session - The run's own key: a run id, a conversation id.
   * @returns The slot, from zero: the one this session last held where it is free, else a free
   * one. `undefined` where every slot is held, or this session holds one already.
   */
  acquire(session: string): number | undefined;
  /**
   * Frees the slot a session holds. A session holding none is a no-op.
   *
   * @param session - The key it was acquired under.
   */
  release(session: string): void;
}

/** Each endpoint and model's slots, and the counter releases are ordered by. */
const pools = scoped(() => ({ slots: new Map<string, SlotPool>(), clock: 0 }));

/**
 * The slots one endpoint has, as the allocator keeps them.
 *
 * @param endpoint - The server, read for `baseUrl` alone.
 * @param model - The model, which a llama.cpp router serves from a process with slots of its own.
 * @returns The key: the base URL as `baseUrlKey` writes it, and the model.
 *
 * @remarks
 * The API key is left out where every other per-endpoint cache keys on it. Two keys reaching
 * different servers through one URL cost only a slot left unused; two keys reaching the same
 * server under two allocators hand one slot to two runs, which is the collision this exists to stop.
 */
const poolKey = (endpoint: { baseUrl: string }, model: string) => modelKey(baseUrlKey(endpoint.baseUrl), model);

/**
 * The slot allocator for one endpoint and model, sized to what its `/props` said.
 *
 * @param endpoint - The server, read for `baseUrl` alone.
 * @param model - The model the requests name.
 * @param total - The slots it has, as `servedSlots` reads them. Zero or less leaves none to hand out.
 * @returns The live allocator: two calls for one endpoint and model share every slot, and each
 * hands out only what the latest `total` allows. A slot past a smaller `total` stays held.
 *
 * @remarks
 * A free slot is chosen in this order: the one the session last held, then one nobody has held,
 * then the one released longest ago, so a session that has just finished keeps its cache for its
 * next step as long as a free slot can be found elsewhere. More sessions than slots get no pin and
 * are not queued; llama.cpp places them by its own guess, which is what every run had before.
 */
export function slotAllocator(endpoint: { baseUrl: string }, model: string, total: number): SlotAllocator {
  const key = poolKey(endpoint, model);
  const pool = pools();
  const size = Math.max(0, Math.floor(total));
  const known = getOrCreate(pool.slots, key, () => ({ slots: [], total: 0 }));
  // Grown onto the same slot objects and never shrunk, so a slot held across a resize is still
  // held, and is not handed to a second session when the count grows back.
  for (let index = known.slots.length; index < size; index++) {
    known.slots.push({ released: 0 });
  }
  known.total = size;

  // Read on every call, so an allocator made before a resize hands out only what the pool has now.
  const acquire = (session: string): number | undefined => {
    const holdsOne = known.slots.some((slot) => slot.holder === session);
    if (holdsOne) {
      return undefined;
    }
    const free = known.slots
      .slice(0, known.total)
      .map((slot, index) => ({ slot, index }))
      .filter(({ slot }) => slot.holder === undefined);
    const own = free.find(({ slot }) => slot.last === session);
    const unused = free.find(({ slot }) => slot.last === undefined);
    const oldest = free.reduce<(typeof free)[number] | undefined>(
      (best, entry) => (best === undefined || entry.slot.released < best.slot.released ? entry : best),
      undefined,
    );
    const chosen = own ?? unused ?? oldest;
    if (!chosen) {
      return undefined;
    }
    chosen.slot.holder = session;
    chosen.slot.last = session;
    return chosen.index;
  };

  const release = (session: string) => {
    const held = known.slots.find((slot) => slot.holder === session);
    if (!held) {
      return;
    }
    held.holder = undefined;
    pool.clock++;
    held.released = pool.clock;
  };

  return {
    get total() {
      return known.total;
    },
    acquire,
    release,
  };
}

/** What a run's `session` adds to its requests, and the slot it holds while it runs. */
export interface SessionPin {
  /** Laid under the config's `extraBody`: `id_slot` and `cache_prompt`, or nothing unpinned. */
  fields: Record<string, unknown>;
  /** Sent with every request: the session as `SESSION_HEADER`. */
  headers: Record<string, string>;
  /** The server reports slots, so each turn says whether it was `pinned`. */
  slotted: boolean;
  /** Frees the slot, where one is held. */
  release: () => void;
}

/** What `pinSession` takes besides the endpoint and the session. */
export interface PinOptions {
  /** Abandons the `/props` lookup, which then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** The server picks its own slots, as a remote agent's does: the run is never pinned. */
  serverPins?: boolean;
  /** Told which slot the run was pinned to, or that none was free. */
  onNotice?: OnNotice;
}

/**
 * Pins a run to a llama.cpp slot where it has a session and the server has slots to hand out.
 *
 * @param config - The endpoint and the model its requests name. An `extraBody` naming `id_slot` pins itself.
 * @param session - The run's own key. Absent pins nothing.
 * @param [options] - Cancellation, whether the server pins its own, and where notices go.
 * @returns The pin, unpinned on a server without slots, one that refused `id_slot` or whose slots
 * are all held. `undefined` without a session. Rejects only with the reason of `signal`.
 */
export async function pinSession(
  config: Endpoint & { model: string; extraBody?: Record<string, unknown> },
  session: string | undefined,
  { signal, serverPins = false, onNotice }: PinOptions = {},
): Promise<SessionPin | undefined> {
  if (!session) {
    return undefined;
  }
  const headers = { [SESSION_HEADER]: session };
  const unpinned: SessionPin = { fields: {}, headers, slotted: false, release: () => {} };
  const pinsItself = config.extraBody !== undefined && SLOT_FIELD in config.extraBody;
  if (pinsItself || serverPins) {
    return unpinned;
  }
  const total = await servedSlots(config, { signal });
  if (total === 0) {
    return unpinned;
  }
  const refused = modelCapabilitiesFor(capabilitiesFor(config.baseUrl, config.apiKey), config.model);
  if (refused.refusedFields.has(SLOT_FIELD)) {
    return { ...unpinned, slotted: true };
  }
  const slots = slotAllocator(config, config.model, total);
  const slot = slots.acquire(session);
  if (slot === undefined) {
    onNotice?.(`no free slot of ${total} for this session; running unpinned`);
    return { ...unpinned, slotted: true };
  }
  onNotice?.(`pinned to slot ${slot} of ${total}`);
  return {
    fields: { [SLOT_FIELD]: slot, [CACHE_PROMPT_FIELD]: true },
    headers,
    slotted: true,
    release: () => slots.release(session),
  };
}

/** Forgets every endpoint's slots, held ones included. For tests, and `resetAll`. */
export function resetSlots() {
  pools.reset();
}
