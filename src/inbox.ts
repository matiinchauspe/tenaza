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
 * An Action that matched a `human` Rule. `blocked` is false only for one a
 * Capability-lacking caller could not actually deny — the command already
 * ran, so the row exists purely so the human sees it happened, never to
 * invite a second `run`.
 *
 * `id` is the item's permanent full identity hash; what a human sees and
 * types is a shortened prefix, computed only at display/CLI time
 * (`shortHashIndex`, `resolvePrefix`) — never stored.
 */
export interface InboxRow {
  id: string;
  session: string;
  ts: string;
  action: Action;
  blocked: boolean;
  /**
   * Raw decision off `action.decided`: `"held"` while the hook still polls
   * for a live answer, `"deny"` for an enforced match, `"allow"` for the
   * Capability-lacking case. Callers telling a live hold apart from a
   * plain pending match read this instead of `blocked`.
   */
  decision: Decision;
}

/** Alias kept for callers that only ever see the open Inbox. */
export type InboxItem = InboxRow;

/** One `action.decided` human-Rule match, tagged with the line it occupies in its own Session's log — what `buildInboxRows` hashes into an identity. */
export interface HumanMatchLine {
  line: number;
  event: Extract<Event, { type: "action.decided" }>;
}

/**
 * Hashes each match's (session, line) into its permanent identity, never
 * a list position — a later-written but earlier-timed deny would
 * otherwise renumber every item after it. Never reorders; callers sort
 * for display separately.
 */
export function buildInboxRows(matches: HumanMatchLine[]): InboxRow[] {
  return matches.map(({ event, line }) => ({
    id: inboxIdentityHash(event.session, line),
    session: event.session,
    ts: event.ts,
    action: event.data.action,
    // "held" is exactly as blocked as "deny" from the human's own vantage,
    // so this stays `decision !== "allow"` rather than the narrower
    // `=== "deny"`.
    blocked: event.data.decision !== "allow",
    decision: event.data.decision,
  }));
}

/** Pure: keep only rows whose id is not in the resolved-refs set — the outstanding-dedup. */
export function dedupOutstanding(rows: InboxRow[], resolvedRefs: ReadonlySet<string>): InboxRow[] {
  return rows.filter((row) => !resolvedRefs.has(row.id));
}

/**
 * True only for a legacy positional id ("1", "2", …), never a hash
 * (always `FULL_HASH_LENGTH` hex chars) — a decimal string that long is
 * astronomically unlikely.
 */
function isLegacyRef(ref: string): boolean {
  return ref.length !== FULL_HASH_LENGTH && /^\d+$/.test(ref);
}

/**
 * Translates a legacy positional ref into its hash by replaying the rule
 * that assigned it: 1-indexed position in chronological order (`ts` then
 * `session`), over only the rows at or before `resolutionTs`.
 *
 * The bound matters: `chronological` is re-derived fresh on every read, so
 * a missing or unparseable Session log shifts every later position down
 * by one. Unbounded, a legacy "7" could then land on a brand-new item the
 * human never touched — silently closing a live reserved action. Bounding
 * by `resolutionTs` rules that out: nothing newer than the Resolution can
 * ever enter the slice.
 *
 * It does not protect against a shift within the already-existing rows
 * (an older sibling log also going missing) — a stale ref can still land
 * on the wrong old row, or none. Either way loses a stale ref's mark,
 * never opens a fresh one.
 *
 * No match in the bounded slice → `undefined`, never a guess.
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

/** Every `approval.resolved` ref in `events`, translating a legacy positional ref against `chronological` (the full, ts-ordered match history) first. */
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
 * Every `human`-Rule match, enforced or not, chronological — a `flag`
 * match never qualifies, since it was never about the human. Filtering on
 * `rule.effect` alone (not also `decision === "deny"`) is what surfaces
 * the Capability-lacking case too: `decideAction` only writes
 * `decision: "allow"` for a `human` Rule when it could not be denied, so
 * `rule.effect === "human"` already means "the human needs this."
 *
 * This order is only what the legacy-ref translation replays and what
 * callers display — never what an id derives from.
 *
 * `skipped` carries unreadable log lines alongside the rows, so a caller
 * needing it avoids a second rescan.
 *
 * `cache` is the Daemon's per-process log cache, used only by
 * `deriveInbox` below — a one-shot process gains nothing from it.
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
    // `session` breaks a `ts` tie deterministically — without it, display
    // order and the legacy-ref translation above would depend on
    // directory-enumeration order, which isn't guaranteed stable.
    .sort((a, b) => a.event.ts.localeCompare(b.event.ts) || a.event.session.localeCompare(b.event.session));

  return { rows: buildInboxRows(matches), skipped };
}

function allHumanMatchRows(home: string): InboxRow[] {
  return allHumanMatchRowsReport(home).rows;
}

/** Every identity hash ever assigned, across the full history (resolved or not) — the universe display-shortening and CLI prefix-matching both resolve against, so a hash a human has already seen never needs to shrink or collide later. */
export function allInboxIdentityHashes(home: string = tenazaHome()): string[] {
  return allHumanMatchRows(home).map((row) => row.id);
}

/** `shortHashIndex` (identity.ts) over the current full history — one scan, reused for every row a render loops over. */
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
 * Derives the open Inbox from the logs — nothing is kept beside them.
 * Every `human`-effect match becomes a row by its own (session, line)
 * hash, then whatever a Resolution already closed is removed, so a
 * denied agent's id matches what `status` shows after.
 *
 * `cache` is the Daemon's per-process log cache — `buildBoardPayload` is
 * the one caller that passes one; a one-shot process gains nothing from
 * it otherwise.
 */
export function deriveInbox(home: string = tenazaHome(), cache?: SessionLogCache): InboxItem[] {
  const chronological = allHumanMatchRowsReport(home, cache).rows;
  return dedupOutstanding(chronological, resolvedRefsReport(home, chronological).refs);
}

/**
 * Same derivation as `deriveInbox`, plus how many log lines couldn't be
 * read, and the full set of identity hashes ever assigned — `decideAction`
 * uses this one read for its skip-count warning and the population it
 * shortens a freshly-opened id against, never a second rescan.
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

/** Find one Inbox row across the full history — resolved or not — by its full identity hash. */
export function findInboxRow(home: string, id: string): InboxRow | undefined {
  return allHumanMatchRows(home).find((row) => row.id === id);
}

/** Whether a Resolution already closed the Inbox item with this full identity hash. */
export function isResolved(home: string, id: string): boolean {
  return resolvedRefs(home).has(id);
}

/**
 * One past resolution, resolved from the raw log Event into the kind the
 * trace tells apart. `undefined` for any other Event type, so a future
 * human-log Event type never silently joins the trace.
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
 * Every past resolution grouped by the Session it resolves, newest first
 * — read from the human log alone, never a Session's own log. Tolerant of
 * a torn line: cosmetic, so a skip is dropped rather than tracked as a
 * warning.
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
