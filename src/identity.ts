import { createHash } from "node:crypto";

/**
 * Inbox item identity (decision 03, ADR 0005, ticket 06): an Inbox item is
 * identified by its Session and the LINE its own `action.decided` Event
 * landed on in that Session's log — stable by construction, computed by
 * the denying hook alone (`log.ts`'s `appendEventAtLine`), no lock. This
 * module hashes that pair into one opaque, git-style identity string and
 * shortens it for display — the two concerns ticket 06 actually asks for,
 * kept apart from WHERE the (session, line) pair itself comes from.
 */

/** A sha1 hex digest is always exactly this long — the full, permanent identity. Anything shorter is a DISPLAY prefix, never stored as a Resolution's own ref. */
export const FULL_HASH_LENGTH = 40;

/** The shortest a displayed/typed hash prefix may ever be (decision 03). */
export const MIN_SHORT_HASH_LENGTH = 4;

/**
 * The permanent, full-length identity hash for one Inbox item: a sha1 of
 * its (Session, line) pair. Hashed rather than shown as the raw pair so
 * every item — across every Session — keys off ONE flat hex string the
 * CLI, the notifier and the Live surface all agree on, git-style.
 */
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
 * Git-style shortest-unique-prefix length for every hash in `hashes`, same
 * order as given — never shorter than `minLength`, never longer than the
 * hash itself. Two hashes that collide outright (byte-identical — see
 * `log.ts`'s own doc on the one known, accepted edge case this can arise
 * from) both come back at full length, since no prefix could ever tell
 * them apart; `resolvePrefix` below reports that case as ambiguous rather
 * than ever guessing one.
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
 * Resolve a human-typed hash or prefix against the full population of
 * known identity hashes (decision 03: "the hash, or any unique prefix").
 * Case-insensitive (hex). Never guesses: more than one match is reported
 * as `ambiguous`, carrying every matching index so the caller can list
 * them, exactly as the decision demands — "refused with both candidates
 * listed." This is a pure matcher with no length floor of its own; the
 * CLI layer enforces `MIN_SHORT_HASH_LENGTH` on raw user input before
 * ever reaching here.
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
