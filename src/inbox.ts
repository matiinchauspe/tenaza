import type { Action, Decision, Event } from "./contract/event";
import { FULL_HASH_LENGTH, inboxIdentityHash, shortHashIndex } from "./identity";
import {
  type LoggedEvent,
  type SessionLogCache,
  readAllSessionEventsWithLinesTolerant,
  readAllSessionLogsCached,
  readHumanEvents,
  readHumanEventsTolerant,
} from "./log";
import { tenazaHome } from "./paths";

/**
 * An Action that matched a `human` Rule, surfaced for the human. `blocked`
 * is true for an enforced deny (an Adapter with the `block` Capability
 * stopped the call — the classic case, awaiting the human's `run`) and
 * false for one a Capability-lacking caller COULD NOT deny (ADR 0001,
 * ticket 06): the command already ran, so this row exists purely so the
 * human still sees it happened — never to invite a second `run`.
 *
 * `id` is the item's FULL identity hash (decision 03, ADR 0005, ticket
 * 06) — (Session, the line its own `action.decided` landed on), hashed.
 * Permanent and unambiguous; what a human actually sees and types is a
 * SHORTENED prefix of it, computed only at display/CLI time
 * (`shortHashIndex`, `resolvePrefix` in `identity.ts`) — never stored.
 */
export interface InboxRow {
  id: string;
  session: string;
  ts: string;
  action: Action;
  blocked: boolean;
  /**
   * Ticket 10: the row's own RAW decision, straight off its `action.decided`
   * Event — `"held"` while the hook still polls for a live answer, `"deny"`
   * for a plain enforced match, `"allow"` for the ADR 0001
   * Capability-lacking case. `blocked` stays `decision !== "allow"` (every
   * pre-ticket-10 caller that only ever wrote "allow"/"deny" sees IDENTICAL
   * behavior); callers that need to tell a live hold apart from a plain
   * pending match read THIS field instead.
   */
  decision: Decision;
}

/** Alias kept for callers that only ever see the open Inbox (ticket 01's name). */
export type InboxItem = InboxRow;

/** One `action.decided` human-Rule match, tagged with the line it occupies in its OWN Session's log — what `buildInboxRows` hashes into an identity. */
export interface HumanMatchLine {
  line: number;
  event: Extract<Event, { type: "action.decided" }>;
}

/**
 * Pure row-builder: hash each match's (session, line) into its permanent
 * identity (decision 03, ADR 0005) — never a position in the list given,
 * which is exactly the v0.1 scheme ticket 06 replaces (a later-written but
 * earlier-timed deny used to renumber every item after it, M4). Callers
 * sort first for DISPLAY order; this never reorders, and the ids it
 * produces don't depend on the order it was called with at all.
 */
export function buildInboxRows(matches: HumanMatchLine[]): InboxRow[] {
  return matches.map(({ event, line }) => ({
    id: inboxIdentityHash(event.session, line),
    session: event.session,
    ts: event.ts,
    action: event.data.action,
    // Ticket 10: "held" is exactly as blocked as "deny" from the human's
    // own vantage — the agent's call is paused either way, awaiting the
    // human — so this stays `decision !== "allow"` rather than a narrower
    // `=== "deny"`, which keeps every pre-ticket-10 caller (every row ever
    // written was "allow" or "deny") byte-for-byte unaffected.
    blocked: event.data.decision !== "allow",
    decision: event.data.decision,
  }));
}

/** Pure: keep only rows whose id is NOT in the resolved-refs set — the outstanding-dedup. */
export function dedupOutstanding(rows: InboxRow[], resolvedRefs: ReadonlySet<string>): InboxRow[] {
  return rows.filter((row) => !resolvedRefs.has(row.id));
}

/**
 * True for a ref that could only be a v0.1 POSITIONAL id ("1", "2", …) —
 * never for a v0.2 identity hash, which is always exactly
 * `FULL_HASH_LENGTH` hex characters. A v0.1 install's refs are short
 * decimal strings; this never confuses the two (a decimal string that
 * happened to ALSO be `FULL_HASH_LENGTH` digits long is astronomically
 * unlikely — no real install gets anywhere near that many denies).
 *
 * This only tells a legacy ref apart from a v0.2 hash — it says nothing
 * about which POSITION a legacy ref names; see `translateLegacyRef` for
 * that, and for why "position" is bounded rather than a plain index into
 * the current full history.
 */
function isLegacyRef(ref: string): boolean {
  return ref.length !== FULL_HASH_LENGTH && /^\d+$/.test(ref);
}

/**
 * Translate one v0.1 positional ref into its v0.2 hash, faithful to what
 * v0.1 itself could ever have seen (orchestrator review on this ticket,
 * 2026-10-26): a v0.1 Resolution could only have named an item that
 * EXISTED at the moment that Resolution was written, so this replays the
 * frozen v0.1 rule — 1-indexed position in CHRONOLOGICAL order (`ts`, then
 * `session` to break a tie), byte-for-byte the shape the old
 * `buildInboxRows` used to assign ids in directly — over a BOUNDED slice
 * of `chronological`: only the rows whose own `ts` is at or before
 * `resolutionTs`, the Resolution's OWN timestamp.
 *
 * This bound is load-bearing, not cosmetic. `chronological` is the FULL
 * history, re-derived fresh on every read — if a Session's log later goes
 * missing, or a line in it stops parsing, that row silently drops out of
 * every later read, and every position AFTER it shifts down by one. Over
 * an UNBOUNDED replay, a legacy "7" could then land on whatever row
 * happens to sit at index 6 NOW — which, as the history keeps growing,
 * can eventually be a brand-new v0.2 item the human never touched,
 * silently closing (hiding) a live reserved action. Bounding by
 * `resolutionTs` rules that out structurally: nothing with a LATER `ts`
 * than the Resolution can ever enter the slice a legacy ref indexes into,
 * so a legacy ref can never resolve to an item newer than itself, no
 * matter how much the log grows afterward.
 *
 * What this bound does NOT protect against — and the ticket accepts as
 * the cost of the human deleting their own history, not a bug to fix
 * here — is a SHIFT WITHIN the already-existing (pre-Resolution) rows: if
 * an OLDER sibling Session's log also goes missing, a legacy ref can
 * still end up pointing at a different OLD row than the one it meant, or
 * at nothing. Either way is a stale ref losing its mark (at worst,
 * reopening an old item) — never a newly-opened one going dark.
 *
 * A ref naming no position within the bounded slice (corrupt, past the
 * end, or the slice itself came up empty) translates to `undefined`
 * rather than guessing.
 */
function translateLegacyRef(
  ref: string,
  resolutionTs: string,
  chronological: readonly InboxRow[],
): string | undefined {
  const position = Number(ref);
  if (!Number.isInteger(position) || position < 1) return undefined;
  const existedByThen = chronological.filter((row) => row.ts <= resolutionTs);
  return existedByThen[position - 1]?.id;
}

/** Every `approval.resolved` ref in `events`, translating any legacy v0.1 positional ref — bounded by THAT Resolution's own `ts` (`translateLegacyRef`) — against `chronological` (the full, ts-ordered match history) first. */
function resolvedRefsFromEvents(events: Event[], chronological: readonly InboxRow[]): Set<string> {
  const refs = new Set<string>();
  for (const event of events) {
    if (event.type !== "approval.resolved") continue;
    const ref = event.data.ref;
    const resolved = isLegacyRef(ref) ? translateLegacyRef(ref, event.ts, chronological) : ref;
    if (resolved !== undefined) refs.add(resolved);
  }
  return refs;
}

/**
 * Every `human`-Rule match, enforced or not, in CHRONOLOGICAL order — a
 * `flag` match never qualifies (it was never about the human at all).
 * Filtering on `rule.effect` alone, rather than also requiring
 * `decision === "deny"`, is what lets ticket 06's Capability-lacking case
 * surface here too (ADR 0001): `decideAction` only ever writes
 * `decision: "allow"` for a `human` Rule when it could not actually be
 * denied, so `rule.effect === "human"` already means exactly "the human
 * needs to see this," regardless of decision.
 *
 * This chronological order is ONLY what the legacy-ref translation above
 * replays (the frozen v0.1 rule) and what callers use for DISPLAY — never
 * what an id is derived from anymore (`buildInboxRows` hashes each row's
 * OWN (session, line) instead, independent of this order).
 *
 * Plus how many log lines could not be read while deriving this (ADR
 * 0007, ticket 01) — carried alongside the rows rather than silently
 * dropped, so a caller that needs it (`deriveInboxReport` below) gets it
 * from the SAME read, never a second, independent rescan of every
 * Session's log.
 *
 * `cache` (ticket 13, criterion 3) is the Daemon's own per-process log
 * cache, passed through ONLY by `deriveInbox` below — every other caller
 * (the CLI, the hook path, `deriveInboxReport`) stays on the uncached read,
 * exactly as before this ticket: a one-shot process gains nothing from a
 * memoization that dies with it.
 */
function allHumanMatchRowsReport(
  home: string,
  cache?: SessionLogCache,
): { rows: InboxRow[]; skipped: number } {
  const { rows: logged, skipped } = cache
    ? readAllSessionLogsCached(home, cache)
    : readAllSessionEventsWithLinesTolerant(home);
  const matches: HumanMatchLine[] = logged
    .filter((row): row is { event: Extract<Event, { type: "action.decided" }>; line: number } =>
      row.event.type === "action.decided" && row.event.data.rule.effect === "human",
    )
    // Primary key `ts`; `session` breaks a tie DETERMINISTICALLY. Two
    // matches across different Sessions can share a millisecond-resolution
    // `ts` — without a deterministic tiebreaker, DISPLAY order (and the
    // legacy-ref translation's own frozen numbering) would depend on
    // `readAllSessionEventsWithLinesTolerant`'s directory-enumeration
    // order, which the filesystem does not guarantee is stable across
    // reads.
    .sort((a, b) => a.event.ts.localeCompare(b.event.ts) || a.event.session.localeCompare(b.event.session));

  return { rows: buildInboxRows(matches), skipped };
}

function allHumanMatchRows(home: string): InboxRow[] {
  return allHumanMatchRowsReport(home).rows;
}

/** Every identity hash ever assigned, across the FULL history (resolved or not) — the universe display-shortening and CLI prefix-matching both resolve against (decision 03), so a hash a human has already seen never needs to shrink or collide later. */
export function allInboxIdentityHashes(home: string = tenazaHome()): string[] {
  return allHumanMatchRows(home).map((row) => row.id);
}

/** `shortHashIndex` (identity.ts) over the current FULL history — one scan, reused for every row a render loops over. */
export function shortIdIndex(home: string = tenazaHome()): Map<string, string> {
  return shortHashIndex(allInboxIdentityHashes(home));
}

function resolvedRefsReport(home: string, chronological: readonly InboxRow[]): { refs: Set<string>; skipped: number } {
  const { events, skipped } = readHumanEventsTolerant(home);
  return { refs: resolvedRefsFromEvents(events, chronological), skipped };
}

function resolvedRefs(home: string): Set<string> {
  return resolvedRefsReport(home, allHumanMatchRows(home)).refs;
}

/**
 * Derive the open Inbox from the logs — nothing is kept beside them (no
 * daemon, ADR 0002). Every `human`-effect match across every Session's log
 * becomes a row, identified by its own (session, line) hash
 * (`buildInboxRows`), then whatever a Resolution (ticket 02) has already
 * closed is removed (`dedupOutstanding`) — so the id a denied agent was
 * told matches what `status` shows afterwards, and closing one item never
 * changes another's.
 *
 * `cache` (ticket 13): the Daemon's own per-process log cache, passed
 * through to `allHumanMatchRowsReport` — `daemon.ts`'s `buildBoardPayload`
 * is the one caller that has one. Omitted, this is byte-for-byte the same
 * derivation every other caller already got.
 */
export function deriveInbox(home: string = tenazaHome(), cache?: SessionLogCache): InboxItem[] {
  const chronological = allHumanMatchRowsReport(home, cache).rows;
  return dedupOutstanding(chronological, resolvedRefsReport(home, chronological).refs);
}

/**
 * Same derivation as `deriveInbox`, plus how many log lines (across every
 * Session's log and the human log) could not be read while doing it (ADR
 * 0007, ticket 01), and the FULL set of identity hashes ever assigned —
 * `decideAction` uses this one read for all three: its own skip-count
 * warning, AND (ticket 06) the population it shortens a freshly-opened
 * item's id against, never a second, independent rescan.
 */
export function deriveInboxReport(
  home: string = tenazaHome(),
): { items: InboxItem[]; skipped: number; allIds: string[] } {
  const rowsReport = allHumanMatchRowsReport(home);
  const refsReport = resolvedRefsReport(home, rowsReport.rows);
  return {
    items: dedupOutstanding(rowsReport.rows, refsReport.refs),
    skipped: rowsReport.skipped + refsReport.skipped,
    allIds: rowsReport.rows.map((row) => row.id),
  };
}

/** Find one Inbox row across the FULL history — resolved or not — by its FULL identity hash. */
export function findInboxRow(home: string, id: string): InboxRow | undefined {
  return allHumanMatchRows(home).find((row) => row.id === id);
}

/** Whether a Resolution already closed the Inbox item with this FULL identity hash. */
export function isResolved(home: string, id: string): boolean {
  return resolvedRefs(home).has(id);
}

/**
 * Ticket 10: one past resolution of a request, resolved from the raw log
 * Event into exactly the kind the resolution trace tells apart. `undefined`
 * for any OTHER Event type — `deriveResolutionTraceBySession` below filters
 * on that, so adding a future human-log Event type never silently grows
 * the trace with something it was never meant to show.
 */
export interface ResolutionTraceEntry {
  id: string;
  kind: "ran" | "done" | "dismissed" | "failed" | "approved" | "rejected";
  ts: string;
  exitCode?: number;
}

function traceEntryFor(event: Event): ResolutionTraceEntry | undefined {
  if (event.type === "approval.resolved") {
    const { ref, outcome, via } = event.data;
    const kind: ResolutionTraceEntry["kind"] =
      outcome === "done"
        ? via === "live"
          ? "approved"
          : via === "run"
            ? "ran"
            : "done"
        : via === "live"
          ? "rejected"
          : "dismissed";
    return { id: ref, kind, ts: event.ts };
  }
  if (event.type === "run.failed") {
    return { id: event.data.ref, kind: "failed", ts: event.ts, exitCode: event.data.exitCode };
  }
  return undefined;
}

/**
 * Every past resolution, grouped by the SESSION that raised the request it
 * resolves (the envelope's own `session` — the item's owning Session, the
 * same convention `approvalResolvedEvent`/`runFailedEvent` already carry),
 * newest first. Read from the human log alone — `run.failed` and
 * `approval.resolved` both live there (`log.ts`'s own `appendHumanEvent`),
 * never a Session's own log. Tolerant of a torn line (ADR 0007's own
 * spirit): a trace is cosmetic, so a skip here is silently dropped rather
 * than threaded through as a `skippedLines` warning the way `decideAction`'s
 * own identity derivation must.
 */
export function deriveResolutionTraceBySession(
  home: string = tenazaHome(),
): Map<string, ResolutionTraceEntry[]> {
  const bySession = new Map<string, ResolutionTraceEntry[]>();
  for (const event of readHumanEvents(home)) {
    const entry = traceEntryFor(event);
    if (!entry) continue;
    const list = bySession.get(event.session) ?? [];
    list.push(entry);
    bySession.set(event.session, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => b.ts.localeCompare(a.ts));
  return bySession;
}
