/**
 * The checks a value read off the wire is put through before anything is read from it.
 *
 * A leaf with no imports, because the modules that need these — a browser-safe `spec`, the schema
 * walk, the tool-call reader, the snapshot importer — otherwise share nothing, and each had grown
 * its own copy. `getOrCreate`, `counted` and `byCodeUnit` are here for the same reason and are the
 * three things that are not checks: every cache in the package fills itself on a miss, and each had
 * written that out; a notice that counts something is written in more than one module; and so is a
 * sort whose order must not depend on the host.
 */

/**
 * Whether a value is a plain keyed object: not null, and not an array.
 *
 * @param value - Anything, usually just parsed. An array is an object to `typeof` and not to this.
 * @returns True for anything else `typeof` calls an object — a `Date`, a `Map` and a class
 * instance included, since the prototype is not looked at.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether a value is a number above zero, which is what a limit has to be to be one.
 *
 * @param value - Anything, usually a setting that may be absent, zero or mistyped.
 * @returns True only for a `number` greater than zero: a numeric string or a `bigint` is not one.
 *
 * @remarks
 * `Infinity` passes and `NaN` does not, so a caller lifting a bound and one handing over a
 * half-built config are told apart without either being asked.
 */
export const isPositive = (value: unknown): value is number => typeof value === 'number' && value > 0;

/** What `getOrCreate` needs of a map, so a `WeakMap` serves as well as a `Map`. */
interface Lookup<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): unknown;
}

/**
 * What a map holds under a key, made and stored first where it holds nothing.
 *
 * @param map - Where to look. Gains an entry on a miss, which is the point of calling this.
 * @param key - What to look under.
 * @param create - Builds the value on a miss, and is not called on a hit. A stored `undefined`
 * reads as a miss, so one that returns it is called every time.
 * @returns What the map holds under the key afterwards: the held value itself on a hit, what
 * `create` returned on a miss.
 */
export function getOrCreate<K, V>(map: Lookup<K, V>, key: K, create: () => V): V {
  const held = map.get(key);
  if (held !== undefined) {
    return held;
  }
  const made = create();
  map.set(key, made);
  return made;
}

/**
 * A count and its noun, plural unless the count is one: `1 tool`, `3 tools`.
 *
 * @param count - How many.
 * @param noun - The singular, which takes an `s` and nothing cleverer.
 * @returns The phrase. Only a count of exactly one is singular: zero reads `0 tools`.
 */
export const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Orders two strings by code unit, which is the same on every host.
 *
 * @param a - The string on the left.
 * @param b - The string on the right.
 * @returns Negative where `a` sorts first, positive where `b` does, zero where they are the same.
 *
 * @remarks
 * Rather than `localeCompare`, whose answer depends on the host's locale. An order the package
 * relies on — the tool array a prompt cache matches, a tie between two ranked tools, a listing a
 * host may key on — has to come out the same wherever it runs.
 */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
