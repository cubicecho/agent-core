/**
 * The checks a value read off the wire is put through before anything is read from it.
 *
 * A leaf with no imports, because the modules that need these — a browser-safe `spec`, the schema
 * walk, the tool-call reader, the snapshot importer — otherwise share nothing, and each had grown
 * its own copy.
 */

/**
 * Whether a value is a plain keyed object: not null, and not an array.
 *
 * @param value Anything, usually just parsed. An array is an object to `typeof` and not to this.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
