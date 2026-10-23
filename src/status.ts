import { deriveInbox, type InboxItem } from "./inbox";
import { tenazaHome } from "./paths";

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
 * The minimal `tenaza status` body: the Inbox. The Session tree (ticket 03)
 * and the Inbox's second line — project / ticket / session / age / `tenaza
 * run <id>` (ticket 02) — extend this; v1 only needs the Inbox listed.
 */
export function renderStatus(home: string = tenazaHome()): string {
  const inbox = deriveInbox(home);
  if (inbox.length === 0) {
    return "Inbox: (empty)\n";
  }
  const lines = ["Inbox:", ...inbox.map((item) => `  ${formatInboxLine(item)}`)];
  return `${lines.join("\n")}\n`;
}
