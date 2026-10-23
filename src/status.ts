import { deriveInbox, type InboxItem } from "./inbox";
import { tenazaHome } from "./paths";
import { renderSessionTree } from "./sessions";

/**
 * The es-AR marker for an Inbox item a Capability-lacking caller could not
 * actually deny (ticket 06, ADR 0001) — the command already ran, so neither
 * `status`'s own line nor a notifier (ticket 08) should ever invite a second
 * `tenaza run` on it. Exported so the notifier reuses the EXACT same words
 * rather than a second, driftable copy.
 */
export const UNBLOCKED_MARKER = "(ya corrió — no se pudo bloquear)";

/**
 * `#id  Tool: command` — the Inbox's per-item line, from the spec's
 * Visibility section. v1 only normalizes `shell` Actions, each carrying the
 * originating tool's name (e.g. "Bash") for this display. Kept BYTE-FOR-BYTE
 * for a blocked item (tickets 01/02/03's own choice) — only an unblocked one
 * (ticket 06, ADR 0001: a `human` match a Capability-lacking caller could not
 * actually deny) appends the es-AR marker, since that command already ran
 * and `tenaza run` would run it a SECOND time.
 */
export function formatInboxLine(item: InboxItem): string {
  const { action } = item;
  const base = `#${item.id}  ${action.tool}: ${action.command}`;
  return item.blocked ? base : `${base}  ${UNBLOCKED_MARKER}`;
}

/**
 * `tenaza status`: the Session tree (ticket 03, variant D minus the context
 * bar) above the Inbox (ticket 01/02). The tree is empty when no Session
 * has ever been observed, so a fresh `TENAZA_HOME` renders exactly as
 * before ticket 03 — Inbox only. The Inbox's second line — project / ticket
 * / session / age / `tenaza run <id>` — is left for a later ticket.
 */
export function renderStatus(home: string = tenazaHome(), now: Date = new Date()): string {
  const tree = renderSessionTree(home, now);
  const inbox = deriveInbox(home);
  const inboxBlock =
    inbox.length === 0
      ? "Inbox: (empty)\n"
      : `${["Inbox:", ...inbox.map((item) => `  ${formatInboxLine(item)}`)].join("\n")}\n`;
  return tree ? `${tree}\n${inboxBlock}` : inboxBlock;
}
