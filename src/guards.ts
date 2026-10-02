/**
 * The checks a value read off the wire is put through before anything is read from it.
 *
 * A leaf with no imports, because the modules that need these — a browser-safe `spec`, the schema
 * walk, the tool-call reader, the snapshot importer — otherwise share nothing, and each had grown
 * its own copy. `getOrCreate` is here for the same reason and is the one thing that is not a
 * check: every cache in the package fills itself on a miss, and each had written that out.
 */

/**
 * Whether a value is a plain keyed object: not null, and not an array.
 *
 * @param value Anything, usually just parsed. An array is an object to `typeof` and not to this.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a value is a number above zero, which is what a limit has to be to be one.
 *
 * `Infinity` passes and `NaN` does not, so a caller lifting a bound and one handing over a
 * half-built config are told apart without either being asked.
 *
 * @param value Anything, usually a setting that may be absent, zero or mistyped.
 */
export const isPositive = (value: unknown): value is number =>
  typeof value === "number" && value > 0;

/** What `getOrCreate` needs of a map, so a `WeakMap` serves as well as a `Map`. */
interface Lookup<K, V> {
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): unknown;
}

/**
 * What a map holds under a key, made and stored first where it holds nothing.
 *
 * @param map Where to look. Gains an entry on a miss, which is the point of calling this.
 * @param key What to look under.
 * @param create Builds the value on a miss, and is not called on a hit.
 */
export function getOrCreate<K, V>(map: Lookup<K, V>, key: K, create: () => V): V {
  if (!map.has(key)) map.set(key, create());
  return map.get(key) as V;
}
