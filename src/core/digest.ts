/**
 * The one digest this package takes, of an endpoint's key and of a turn's text.
 *
 * Apart from `platform.ts` because it loads `node:crypto`, which a browser-safe module must not
 * come to import by reaching for a constant.
 */
import { createHash } from 'node:crypto';

/** The hash every digest here is taken with. */
const DIGEST_ALGORITHM = 'sha256';

/** How a digest is written out. */
const DIGEST_ENCODING = 'hex';

/**
 * A text's SHA-256, in hex.
 *
 * @param text - What to hash.
 * @returns Sixty-four hex characters, the same for the same text on any machine.
 */
export const digestOf = (text: string) => createHash(DIGEST_ALGORITHM).update(text).digest(DIGEST_ENCODING);
