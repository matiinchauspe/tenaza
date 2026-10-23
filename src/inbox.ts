import type { Action } from "./contract/event";
import { readAllSessionEvents } from "./log";
import { tenazaHome } from "./paths";

/** A denied Action awaiting the human, carrying the exact command to run. */
export interface InboxItem {
  id: number;
  session: string;
  ts: string;
  action: Action;
}

/**
 * Derive the Inbox from the logs — nothing is kept beside them (no daemon,
 * ADR 0002). Every `human`-effect deny across every Session's log becomes an
 * item, ordered by when it happened and numbered from 1 in that order, so
 * the id a denied agent was told matches what `status` shows afterwards.
 *
 * Resolving an item (ticket 02) will need to exclude it here once it is no
 * longer open; v1 has no resolution path yet, so every deny is open.
 */
export function deriveInbox(home: string = tenazaHome()): InboxItem[] {
  const denies = readAllSessionEvents(home)
    .filter((event) => event.type === "action.decided")
    .filter((event) => event.data.decision === "deny" && event.data.rule.effect === "human")
    .sort((a, b) => a.ts.localeCompare(b.ts));

  return denies.map((event, index) => ({
    id: index + 1,
    session: event.session,
    ts: event.ts,
    action: event.data.action,
  }));
}
