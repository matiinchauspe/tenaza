import type { Action } from "./contract/event";
import { deriveInbox, type InboxItem, shortIdIndex } from "./inbox";
import { tenazaHome } from "./paths";
import { renderSessionTree } from "./sessions";

/** Shown for an Inbox item that already ran unblocked, so a caller never invites running it again. Exported so the notifier reuses the exact same words. */
export const UNBLOCKED_MARKER = "(ya corrió — no se pudo bloquear)";

/** Caps one noisy argument (e.g. a long SQL string) from dominating the summary line. */
const MAX_MCP_ARGS_SUMMARY_LENGTH = 80;

/** Display only — never inspects argument content (e.g. SQL text), just stringifies it. */
function summarizeMcpArgs(args: Record<string, unknown>): string {
  const summary = Object.entries(args)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return summary.length > MAX_MCP_ARGS_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_MCP_ARGS_SUMMARY_LENGTH)}…`
    : summary;
}

/** Described for a human — `formatInboxLine` below and `notify.ts`'s notification both call this, so the same copy never drifts between the two. */
export function describeAction(action: Action): string {
  if (action.kind === "shell") return `${action.tool}: ${action.command}`;
  const summary = summarizeMcpArgs(action.args);
  return summary ? `${action.tool}  ${summary}` : action.tool;
}

export function formatInboxLine(item: InboxItem, id: string): string {
  const base = `${id}  ${describeAction(item.action)}`;
  return item.blocked ? base : `${base}  ${UNBLOCKED_MARKER}`;
}

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
