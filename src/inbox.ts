import type { Action, ActionDecidedEvent } from "./contract/event";
import { readAllSessionEvents, readHumanEvents } from "./log";
import { tenazaHome } from "./paths";

/** A denied Action awaiting the human, carrying the exact command to run. */
export interface InboxRow {
  id: number;
  session: string;
  ts: string;
  action: Action;
}

/** Alias kept for callers that only ever see the open Inbox (ticket 01's name). */
export type InboxItem = InboxRow;

/**
 * Pure row-builder: assign stable, 1-indexed ids by POSITION in the list
 * given — never recomputed from a subset. Callers sort first; this never
 * reorders. Ids must stay stable once assigned (resolving #1 must never
 * renumber #2), so this always runs over the FULL chronological history of
 * denies, resolved or not — never over an already-filtered list.
 */
export function buildInboxRows(denies: ActionDecidedEvent[]): InboxRow[] {
  return denies.map((event, index) => ({
    id: index + 1,
    session: event.session,
    ts: event.ts,
    action: event.data.action,
  }));
}

/** Pure: keep only rows whose id is NOT in the resolved-refs set — the outstanding-dedup. */
export function dedupOutstanding(rows: InboxRow[], resolvedRefs: ReadonlySet<string>): InboxRow[] {
  return rows.filter((row) => !resolvedRefs.has(String(row.id)));
}

function allDenyRows(home: string): InboxRow[] {
  const denies = readAllSessionEvents(home)
    .filter((event) => event.type === "action.decided")
    .filter((event) => event.data.decision === "deny" && event.data.rule.effect === "human")
    // Primary key `ts`; `session` breaks a tie DETERMINISTICALLY. Two denies
    // across different Sessions can share a millisecond-resolution `ts` (the
    // known race from ticket 01) — without a deterministic tiebreaker, the
    // resulting order (and so the ids built below) would depend on
    // `readAllSessionEvents`'s directory-enumeration order, which the
    // filesystem does not guarantee is stable across reads. Resolving an id
    // only works if the id means the same row every time it's derived.
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.session.localeCompare(b.session));

  return buildInboxRows(denies);
}

function resolvedRefs(home: string): Set<string> {
  return new Set(
    readHumanEvents(home)
      .filter((event) => event.type === "approval.resolved")
      .map((event) => event.data.ref),
  );
}

/**
 * Derive the open Inbox from the logs — nothing is kept beside them (no
 * daemon, ADR 0002). Every `human`-effect deny across every Session's log
 * becomes a row, numbered from 1 over the full chronological history
 * (`buildInboxRows`), then whatever a Resolution (ticket 02) has already
 * closed is removed (`dedupOutstanding`) — so the id a denied agent was told
 * matches what `status` shows afterwards, and closing one item never shifts
 * another's number.
 */
export function deriveInbox(home: string = tenazaHome()): InboxItem[] {
  return dedupOutstanding(allDenyRows(home), resolvedRefs(home));
}

/** Find one Inbox row across the FULL history — resolved or not — by id. */
export function findInboxRow(home: string, id: number): InboxRow | undefined {
  return allDenyRows(home).find((row) => row.id === id);
}

/** Whether a Resolution already closed the Inbox item with this id. */
export function isResolved(home: string, id: number): boolean {
  return resolvedRefs(home).has(String(id));
}
