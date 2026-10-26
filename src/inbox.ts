import type { Action, ActionDecidedEvent } from "./contract/event";
import { readAllSessionEventsTolerant, readHumanEventsTolerant } from "./log";
import { tenazaHome } from "./paths";

/**
 * An Action that matched a `human` Rule, surfaced for the human. `blocked`
 * is true for an enforced deny (an Adapter with the `block` Capability
 * stopped the call — the classic case, awaiting the human's `run`) and
 * false for one a Capability-lacking caller COULD NOT deny (ADR 0001,
 * ticket 06): the command already ran, so this row exists purely so the
 * human still sees it happened — never to invite a second `run`.
 */
export interface InboxRow {
  id: number;
  session: string;
  ts: string;
  action: Action;
  blocked: boolean;
}

/** Alias kept for callers that only ever see the open Inbox (ticket 01's name). */
export type InboxItem = InboxRow;

/**
 * Pure row-builder: assign stable, 1-indexed ids by POSITION in the list
 * given — never recomputed from a subset. Callers sort first; this never
 * reorders. Ids must stay stable once assigned (resolving #1 must never
 * renumber #2), so this always runs over the FULL chronological history of
 * human-Rule matches, resolved or not — never over an already-filtered list.
 */
export function buildInboxRows(matches: ActionDecidedEvent[]): InboxRow[] {
  return matches.map((event, index) => ({
    id: index + 1,
    session: event.session,
    ts: event.ts,
    action: event.data.action,
    blocked: event.data.decision === "deny",
  }));
}

/** Pure: keep only rows whose id is NOT in the resolved-refs set — the outstanding-dedup. */
export function dedupOutstanding(rows: InboxRow[], resolvedRefs: ReadonlySet<string>): InboxRow[] {
  return rows.filter((row) => !resolvedRefs.has(String(row.id)));
}

/**
 * Every `human`-Rule match, enforced or not — a `flag` match never qualifies
 * (it was never about the human at all). Filtering on `rule.effect` alone,
 * rather than also requiring `decision === "deny"`, is what lets ticket 06's
 * Capability-lacking case surface here too (ADR 0001): `decideAction` only
 * ever writes `decision: "allow"` for a `human` Rule when it could not
 * actually be denied, so `rule.effect === "human"` already means exactly
 * "the human needs to see this," regardless of decision.
 *
 * Plus how many log lines could not be read while deriving this (ADR 0007,
 * ticket 01) — carried alongside the rows rather than silently dropped, so
 * a caller that needs it (`deriveInboxReport` below) gets it from the SAME
 * read, never a second, independent rescan of every Session's log.
 */
function allHumanMatchRowsReport(home: string): { rows: InboxRow[]; skipped: number } {
  const { events, skipped } = readAllSessionEventsTolerant(home);
  const matches = events
    .filter((event) => event.type === "action.decided")
    .filter((event) => event.data.rule.effect === "human")
    // Primary key `ts`; `session` breaks a tie DETERMINISTICALLY. Two matches
    // across different Sessions can share a millisecond-resolution `ts` (the
    // known race from ticket 01) — without a deterministic tiebreaker, the
    // resulting order (and so the ids built below) would depend on
    // `readAllSessionEventsTolerant`'s directory-enumeration order, which the
    // filesystem does not guarantee is stable across reads. Resolving an id
    // only works if the id means the same row every time it's derived.
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.session.localeCompare(b.session));

  return { rows: buildInboxRows(matches), skipped };
}

function allHumanMatchRows(home: string): InboxRow[] {
  return allHumanMatchRowsReport(home).rows;
}

function resolvedRefsReport(home: string): { refs: Set<string>; skipped: number } {
  const { events, skipped } = readHumanEventsTolerant(home);
  const refs = new Set(
    events.filter((event) => event.type === "approval.resolved").map((event) => event.data.ref),
  );
  return { refs, skipped };
}

function resolvedRefs(home: string): Set<string> {
  return resolvedRefsReport(home).refs;
}

/**
 * Derive the open Inbox from the logs — nothing is kept beside them (no
 * daemon, ADR 0002). Every `human`-effect match across every Session's log
 * becomes a row, numbered from 1 over the full chronological history
 * (`buildInboxRows`), then whatever a Resolution (ticket 02) has already
 * closed is removed (`dedupOutstanding`) — so the id a denied agent was told
 * matches what `status` shows afterwards, and closing one item never shifts
 * another's number.
 */
export function deriveInbox(home: string = tenazaHome()): InboxItem[] {
  return dedupOutstanding(allHumanMatchRows(home), resolvedRefs(home));
}

/**
 * Same derivation as `deriveInbox`, plus how many log lines (across every
 * Session's log and the human log) could not be read while doing it (ADR
 * 0007, ticket 01). Used ONLY by `decideAction`, which needs this number to
 * report a degraded answer on the SAME call that hit it — never as a
 * separate, independent full rescan of every log on every hook call
 * (that cost, unbounded in the number of Sessions, was exactly the thing
 * ticket 01's own review caught and this function exists to avoid).
 */
export function deriveInboxReport(home: string = tenazaHome()): { items: InboxItem[]; skipped: number } {
  const rows = allHumanMatchRowsReport(home);
  const refs = resolvedRefsReport(home);
  return { items: dedupOutstanding(rows.rows, refs.refs), skipped: rows.skipped + refs.skipped };
}

/** Find one Inbox row across the FULL history — resolved or not — by id. */
export function findInboxRow(home: string, id: number): InboxRow | undefined {
  return allHumanMatchRows(home).find((row) => row.id === id);
}

/** Whether a Resolution already closed the Inbox item with this id. */
export function isResolved(home: string, id: number): boolean {
  return resolvedRefs(home).has(String(id));
}
