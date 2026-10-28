import { GREEN, RED, RESET } from "./contextbar";
import { isHeartbeatFresh, readAlive } from "./daemonlink";
import { readHealth } from "./health";
import { type InboxItem, deriveInbox, shortIdIndex } from "./inbox";
import { readAllSessionEvents } from "./log";
import { tenazaHome } from "./paths";
import { loadPolicy } from "./policy";
import { buildSessionIndex, closeDeadProcesses, nodeCategory } from "./sessions";
import { describeAction } from "./status";

/**
 * `tenaza statusline`'s own three counts — the same derived state `tenaza
 * status` renders as a tree + Inbox, folded down to numbers (ticket 07, AC4:
 * "its counts always agree with `tenaza status` for the same state").
 */
export interface StatuslineCounts {
  /** Every Session whose OWN category (never rolled up) is "waits" or "alive" — i.e. not done, not ended. */
  live: number;
  /** Every Session with the `measure` Capability whose latest sample is at or past the Policy's threshold (ADR 0001: a Session without `measure` can never be flagged, however large a stray sample is). */
  flagged: number;
  /** The open Inbox's length — every `human`-Rule match not yet resolved, blocked or not (the GLOSSARY's own definition of an Inbox item, ticket 06). */
  inbox: number;
}

/**
 * The number of words from a command to show beside "most urgent" — 3, the
 * same the spec's own worked example uses ("gh pr merge" out of "gh pr merge
 * 58 --merge").
 */
const FIRST_WORDS_COUNT = 3;

export function firstWords(command: string, count: number = FIRST_WORDS_COUNT): string {
  return command.split(/\s+/).filter(Boolean).slice(0, count).join(" ");
}

/**
 * Every Session's own category (never rolled up — "vivas" counts individual
 * Sessions, not grouped roots) is "live" when it's "waits" or "alive":
 * anything that isn't done or ended yet. Mirrors `tenaza status`'s own
 * priority order (waits > alive > done > ended), read as a binary split here.
 */
function isLive(category: ReturnType<typeof nodeCategory>): boolean {
  return category === "waits" || category === "alive";
}

/**
 * Derive the statusline's three counts from the same Events `tenaza status`
 * reads — no state kept beside them (ADR 0002). `flagged` is gated on the
 * `measure` Capability, exactly as `formatContextColumn` (sessions.ts) gates
 * the tree row's own `⚑` — never on whether a sample happens to exist.
 *
 * Ticket 02: `closeDeadProcesses` runs right after `buildSessionIndex`,
 * before `live` is counted — a Session whose runtime process is confirmed
 * gone never counts toward "vivas" here, the SAME rule `tenaza status` and
 * the board apply (AC1).
 */
export function deriveStatuslineCounts(home: string = tenazaHome()): StatuslineCounts {
  const events = readAllSessionEvents(home);
  const index = buildSessionIndex(events);
  closeDeadProcesses(index); // ticket 02, AC1: the SAME rule `tenaza status` and the board apply
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
 * The Inbox item named by the statusline's terse "most urgent" slot: the
 * MOST RECENTLY opened open item — `deriveInbox`'s last element, since its
 * ids are assigned by ascending chronological position. Matches the spec's
 * own User Story 6 worked example, where a Session blocked 4 minutes ago
 * (#14) is named over one blocked 2 hours ago (#13) — recency decides, not
 * whether the item is still `blocked` (ticket 07's own build-time call: an
 * unblocked item is still open and still real, so it can still be the one
 * named here).
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

/**
 * The "most urgent" slot's own summary of `action` — `firstWords` of the
 * command for `shell` (unchanged, byte-for-byte, from ticket 07), or the
 * same tool-plus-args description `status`'s Inbox line uses for `mcp`
 * (ticket 04) — `top.action.command` simply doesn't exist on an `mcp`
 * Action, so this never falls back to a blind property read.
 */
function formatInboxSummary(action: InboxItem["action"]): string {
  return action.kind === "shell" ? firstWords(action.command) : describeAction(action);
}

function formatInbox(count: number, top: InboxItem | undefined, shortId: string | undefined): string {
  if (count === 0 || top === undefined || shortId === undefined) return "✉ 0";
  return `✉ ${count} → ${shortId} ${formatInboxSummary(top.action)}`;
}

/**
 * The "degradado" mark (ADR 0007, ticket 02): red, exactly while
 * `state/health.json` reports ANY fault — grave or not, since the
 * statusline is the one AMBIENT channel (decision 01's own word for it)
 * that reaches a human who never reads a `systemMessage` and never sees a
 * SessionStart warning. Empty string, never a bare space, when healthy —
 * so a caller can splice it into the line without a stray `·` showing up
 * for nothing. Reuses `contextbar.ts`'s own red: one "this needs you" color
 * across the line, never two.
 */
function formatHealthMark(home: string): string {
  return readHealth(home) === undefined ? "" : `${RED}degradado${RESET} ·`;
}

/**
 * Ticket 12: "the statusline shows a live dot while the heartbeat is
 * fresh" — the SAME freshness rule the live-answering hold and `tenaza
 * ui`'s own single-instance probe already read (`isHeartbeatFresh`,
 * `daemonlink.ts`'s `DEFAULT_HEARTBEAT_STALE_MS`), never a second
 * threshold for "is the Daemon up" (review lesson). Empty string, never a
 * bare space or a "daemon off" placeholder, while the Daemon is down —
 * it's opt-in (decision 05: "nothing starts on its own"), so its ordinary
 * state is absent, not a fault to announce the way `degradado` is.
 */
function formatDaemonMark(home: string): string {
  return isHeartbeatFresh(readAlive(home), new Date()) ? `· ${GREEN}●${RESET} daemon` : "";
}

/**
 * `tenaza │ ● <n> vivas · ⚑ <n> >200k · ✉ <n> → #<id> <first words>` — the
 * spec's own format (q19), calm when `⚑` and `✉` are both 0 (no `>Nk`
 * suffix, no arrow). The `>Nk` suffix reflects the Policy's ACTUAL threshold
 * (ticket 04's own configurable one), never a hardcoded "200k" — a build-
 * time call: the bar's own `┊` mark already moves with a custom threshold,
 * so the statusline's number should never disagree with it.
 */
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
