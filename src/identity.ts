import { createHash } from "node:crypto";

/**
 * An Inbox item is identified by its Session and the line its own
 * `action.decided` landed on — stable by construction, computed by the
 * denying hook alone, no lock. This module only hashes that pair and
 * shortens it for display.
 */

/** A sha1 hex digest is always exactly this long — the full, permanent identity. Anything shorter is a display prefix, never stored as a Resolution's own ref. */
export const FULL_HASH_LENGTH = 40;

/** The shortest a displayed/typed hash prefix may ever be. */
export const MIN_SHORT_HASH_LENGTH = 4;

/** A sha1 of the (Session, line) pair — one flat hex string every surface agrees on, git-style, rather than the raw pair. */
export function inboxIdentityHash(session: string, line: number): string {
  return createHash("sha1").update(`${session}\n${line}`).digest("hex");
}

/** How many leading characters `a` and `b` share, from the start. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/**
 * Git-style shortest-unique-prefix length for every hash in `hashes`. Two
 * byte-identical hashes both come back at full length, since no prefix
 * could ever tell them apart.
 */
export function shortestUniqueLengths(
  hashes: readonly string[],
  minLength: number = MIN_SHORT_HASH_LENGTH,
): number[] {
  const sorted = hashes
    .map((hash, index) => ({ hash, index }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const lengths = new Array<number>(hashes.length).fill(minLength);

  for (let pos = 0; pos < sorted.length; pos++) {
    const current = sorted[pos];
    if (!current) continue;
    let needed = minLength;

    const previous = pos > 0 ? sorted[pos - 1] : undefined;
    if (previous) needed = Math.max(needed, commonPrefixLength(current.hash, previous.hash) + 1);

    const next = pos < sorted.length - 1 ? sorted[pos + 1] : undefined;
    if (next) needed = Math.max(needed, commonPrefixLength(current.hash, next.hash) + 1);

    lengths[current.index] = Math.min(needed, current.hash.length);
  }

  return lengths;
}

/** The shortest unique display form of `hashes[index]`, against the full `hashes` population. */
export function shortHashAt(
  hashes: readonly string[],
  index: number,
  minLength: number = MIN_SHORT_HASH_LENGTH,
): string {
  const hash = hashes[index];
  if (hash === undefined) return "";
  const length = shortestUniqueLengths(hashes, minLength)[index] ?? hash.length;
  return hash.slice(0, length);
}

/** A map from every full hash in `hashes` to its own shortest-unique display form — computed once, reused for every row a render loops over. */
export function shortHashIndex(
  hashes: readonly string[],
  minLength: number = MIN_SHORT_HASH_LENGTH,
): Map<string, string> {
  const lengths = shortestUniqueLengths(hashes, minLength);
  const index = new Map<string, string>();
  hashes.forEach((hash, i) => index.set(hash, hash.slice(0, lengths[i] ?? hash.length)));
  return index;
}

export type PrefixMatch =
  | { kind: "unique"; index: number }
  | { kind: "ambiguous"; indices: number[] }
  | { kind: "not-found" };

/**
 * Resolves a human-typed hash or prefix against the full population.
 * Never guesses: more than one match comes back `ambiguous`, carrying
 * every matching index. No length floor of its own — the CLI enforces
 * `MIN_SHORT_HASH_LENGTH` before reaching here.
 */
export function resolvePrefix(prefix: string, hashes: readonly string[]): PrefixMatch {
  const needle = prefix.toLowerCase();
  const indices: number[] = [];
  hashes.forEach((hash, index) => {
    if (hash.startsWith(needle)) indices.push(index);
  });

  const [only, ...rest] = indices;
  if (only === undefined) return { kind: "not-found" };
  if (rest.length === 0) return { kind: "unique", index: only };
  return { kind: "ambiguous", indices };
}
