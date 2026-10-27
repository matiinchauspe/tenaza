import type { Action } from "./contract/event";
import { deriveInbox, type InboxItem, shortIdIndex } from "./inbox";
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

/** How much of an `mcp` Action's argument summary to show before truncating — one noisy argument (a long SQL string, say) must never dominate the line. */
const MAX_MCP_ARGS_SUMMARY_LENGTH = 80;

/**
 * A short, single-line summary of an `mcp` Action's arguments (ticket 04):
 * primitive `key=value` pairs, space-separated. Display only — the Policy
 * itself never inspects argument content (SQL text and the like), and
 * neither does this: it just stringifies whatever is there.
 */
function summarizeMcpArgs(args: Record<string, unknown>): string {
  const summary = Object.entries(args)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return summary.length > MAX_MCP_ARGS_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_MCP_ARGS_SUMMARY_LENGTH)}…`
    : summary;
}

/**
 * One Action, described for a human (ticket 04): `Tool: command` for
 * `shell` (unchanged, byte-for-byte, from tickets 01-03), or the MCP tool's
 * own name plus a short argument summary for `mcp`. The same words both
 * `formatInboxLine` below and the 🟡 notification (`notify.ts`) use, so the
 * one piece of copy a human reads twice never disagrees with itself.
 */
export function describeAction(action: Action): string {
  if (action.kind === "shell") return `${action.tool}: ${action.command}`;
  const summary = summarizeMcpArgs(action.args);
  return summary ? `${action.tool}  ${summary}` : action.tool;
}

/**
 * `<id>  <described Action>` — the Inbox's per-item line, from the spec's
 * Visibility section. `id` (decision 03, ADR 0005, ticket 06) is the
 * item's git-style SHORT hash, the shortest prefix unique right now across
 * the full history — never the raw positional number v0.1 showed. Kept
 * byte-for-byte otherwise for a blocked `shell` item (tickets 01/02/03's
 * own choice) — only an unblocked one (ticket 06, ADR 0001: a `human`
 * match a Capability-lacking caller could not actually deny) appends the
 * es-AR marker, since that command already ran and `tenaza run` would run
 * it a SECOND time.
 */
export function formatInboxLine(item: InboxItem, id: string): string {
  const base = `${id}  ${describeAction(item.action)}`;
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
  const shortIds = shortIdIndex(home);
  const inboxBlock =
    inbox.length === 0
      ? "Inbox: (empty)\n"
      : `${[
          "Inbox:",
          ...inbox.map((item) => `  ${formatInboxLine(item, shortIds.get(item.id) ?? item.id)}`),
        ].join("\n")}\n`;
  return tree ? `${tree}\n${inboxBlock}` : inboxBlock;
}
