import { deriveInbox, type InboxItem } from "./inbox";
import { tenazaHome } from "./paths";
import { renderSessionTree } from "./sessions";

/**
 * `#id  Tool: command` — the Inbox's per-item line, from the spec's
 * Visibility section. v1 only normalizes `shell` Actions, each carrying the
 * originating tool's name (e.g. "Bash") for this display.
 */
export function formatInboxLine(item: InboxItem): string {
  const { action } = item;
  return `#${item.id}  ${action.tool}: ${action.command}`;
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
