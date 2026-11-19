import { GREEN, RED, RESET } from "./contextbar";
import { isHeartbeatFresh, readAlive } from "./daemonlink";
import { readHealth } from "./health";
import { type InboxItem, deriveInbox, shortIdIndex } from "./inbox";
import { readAllSessionEvents } from "./log";
import { tenazaHome } from "./paths";
import { loadPolicy } from "./policy";
import { closedOutSessionIndex, nodeCategory, readTouchedTimestamps } from "./sessions";
import { describeAction } from "./status";

/** Same derived state `tenaza status` renders as a tree + Inbox, folded into three counts — the two must always agree. */
export interface StatuslineCounts {
  /** Every session whose own category (not rolled up) is "waits" or "alive". */
  live: number;
  /** Every session with the `measure` capability whose latest sample is at or past the threshold. */
  flagged: number;
  /** The open Inbox's length — every unresolved `human`-rule match, blocked or not. */
  inbox: number;
}

const FIRST_WORDS_COUNT = 3;

export function firstWords(command: string, count: number = FIRST_WORDS_COUNT): string {
  return command.split(/\s+/).filter(Boolean).slice(0, count).join(" ");
}

function isLive(category: ReturnType<typeof nodeCategory>): boolean {
  return category === "waits" || category === "alive";
}

/**
 * `flagged` is gated on the `measure` capability, never on whether a
 * sample happens to exist (matches `sessions.ts`'s own ⚑ gate). Uses
 * `closedOutSessionIndex`, not a raw index, so a session whose process is
 * confirmed dead — or went silent with no pid — never counts as live.
 */
export function deriveStatuslineCounts(home: string = tenazaHome()): StatuslineCounts {
  const events = readAllSessionEvents(home);
  const index = closedOutSessionIndex(events, readTouchedTimestamps(home));
  const inbox = deriveInbox(home);
  const waiting = new Set(inbox.map((row) => row.session));
  const thresholdTokens = loadPolicy(home).thresholdTokens;

  let live = 0;
  let flagged = 0;
  for (const node of index.values()) {
    if (isLive(nodeCategory(node, waiting))) live += 1;
    if (
      node.capabilities.includes("measure") &&
      node.contextTokens !== undefined &&
      node.contextTokens >= thresholdTokens
    ) {
      flagged += 1;
    }
  }

  return { live, flagged, inbox: inbox.length };
}

/**
 * Most recently opened open item — `deriveInbox`'s last element, since ids
 * are assigned in ascending chronological order. Recency decides, not
 * whether it's still `blocked` — an unblocked item can still be the one
 * named here.
 */
export function mostUrgentInboxItem(home: string = tenazaHome()): InboxItem | undefined {
  const inbox = deriveInbox(home);
  return inbox[inbox.length - 1];
}

function formatFlagged(flagged: number, thresholdTokens: number): string {
  if (flagged === 0) return "⚑ 0";
  const k = Math.round(thresholdTokens / 1000);
  return `⚑ ${flagged} >${k}k`;
}

/** `firstWords` of the command for `shell`; `describeAction` for `mcp`, since `action.command` doesn't exist on that variant. */
function formatInboxSummary(action: InboxItem["action"]): string {
  return action.kind === "shell" ? firstWords(action.command) : describeAction(action);
}

function formatInbox(count: number, top: InboxItem | undefined, shortId: string | undefined): string {
  if (count === 0 || top === undefined || shortId === undefined) return "✉ 0";
  return `✉ ${count} → ${shortId} ${formatInboxSummary(top.action)}`;
}

/**
 * Red whenever `state/health.json` reports any fault, grave or not — the
 * statusline is the one ambient channel that reaches a human who never
 * reads a `systemMessage` or a SessionStart warning. Empty string, never
 * a bare space, when healthy, so splicing it into the line leaves no
 * stray `·`.
 */
function formatHealthMark(home: string): string {
  return readHealth(home) === undefined ? "" : `${RED}degradado${RESET} ·`;
}

/**
 * Uses the same freshness rule as everywhere else (`isHeartbeatFresh`,
 * `DEFAULT_HEARTBEAT_STALE_MS`) — never a second staleness threshold for
 * "is the Daemon up." Empty, not a placeholder, while the Daemon is down:
 * it's opt-in, so being off is its ordinary state, not a fault like
 * `degradado`.
 */
function formatDaemonMark(home: string): string {
  return isHeartbeatFresh(readAlive(home), new Date()) ? `· ${GREEN}●${RESET} daemon` : "";
}

/** The `>Nk` suffix always reflects the Policy's actual threshold, never a hardcoded number — the bar's own `┊` mark already moves with a custom threshold, so the two must never disagree. */
export function formatStatusline(home: string = tenazaHome()): string {
  const counts = deriveStatuslineCounts(home);
  const thresholdTokens = loadPolicy(home).thresholdTokens;
  const top = mostUrgentInboxItem(home);
  const shortId = top ? shortIdIndex(home).get(top.id) : undefined;
  const healthMark = formatHealthMark(home);
  const daemonMark = formatDaemonMark(home);

  return [
    "tenaza │",
    ...(healthMark ? [healthMark] : []),
    `● ${counts.live} vivas ·`,
    `${formatFlagged(counts.flagged, thresholdTokens)} ·`,
    formatInbox(counts.inbox, top, shortId),
    ...(daemonMark ? [daemonMark] : []),
  ].join(" ");
}
