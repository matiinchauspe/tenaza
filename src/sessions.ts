import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { TERMINO_WINDOW_MS } from "./board";
import type { Action, Capability, Event, NotificationKind, TerminalLocator } from "./contract/event";
import { formatContextBar, formatContextNumber } from "./contextbar";
import { deriveInbox } from "./inbox";
import { readAllSessionEvents, readHumanEvents, readSessionEvents } from "./log";
import { sessionTouchedPath, sessionsDir, tenazaHome } from "./paths";
import { loadPolicy } from "./policy";
import { sessionState, type SessionState } from "./sessionstate";

/** waits > alive > done > ended, by urgency. "Stalled" is not a category here — it's a word override on "alive" (see `categoryWord`). */
export type SessionCategory = "waits" | "alive" | "done" | "ended";

function categoryRank(category: SessionCategory): number {
  switch (category) {
    case "waits":
      return 3;
    case "alive":
      return 2;
    case "done":
      return 1;
    case "ended":
      return 0;
  }
}

/** One observed Session, derived fresh from events — never persisted (ADR 0002). */
export interface SessionNode {
  id: string;
  parent?: string;
  runtime?: string;
  cwd?: string;
  capabilities: Capability[];
  labels: Record<string, string>;
  startedAt?: string;
  endedAt?: string;
  endedReason?: string;
  lastEventTs?: string;
  /** undefined means never sampled — never zero. */
  contextTokens?: number;
  /** undefined means no Action has been matched yet. */
  lastAction?: Action;
  /** Whether this still counts as a CURRENT wait is `nativeWaitFor`'s call, not this field's. */
  lastNotification?: { kind: NotificationKind; ts: string };
  /** Whether this still counts as a CURRENT wait is `turnWaitSince`'s call, not this field's. */
  lastTurnEnded?: string;
  /** Never set on a subagent — its Adapter never captures one — which is why focusing a subagent's terminal resolves to its parent elsewhere, rather than being copied onto every node here. */
  terminalLocator?: TerminalLocator;
  /** undefined for a backfilled start, legacy data, or an environment where `ps` couldn't be read. Unlike `terminalLocator`, a subagent carries its OWN pid — never resolved via `node.parent`. */
  pid?: number;
  /** Paired with `pid` so `closeDeadProcesses` can tell a reused pid (after a reboot) apart from the same process still running. undefined means the reuse guard can't apply — `pid` alone is still trusted. */
  pidStartedAt?: string;
}

export class UnknownSessionError extends Error {
  constructor(public readonly id: string) {
    super(`unknown session ${id}`);
  }
}

function emptyNode(id: string): SessionNode {
  return { id, capabilities: [], labels: {} };
}

/**
 * One SessionNode per distinct `session` any Event names, not only one
 * with a lifecycle Event — a session known only through e.g.
 * `action.decided` still gets a node, with everything but `id` and
 * `lastEventTs` left undefined.
 */
export function buildSessionIndex(events: Event[]): Map<string, SessionNode> {
  const index = new Map<string, SessionNode>();

  for (const event of events) {
    const node = index.get(event.session) ?? emptyNode(event.session);
    index.set(event.session, node);

    if (!node.lastEventTs || event.ts > node.lastEventTs) node.lastEventTs = event.ts;

    // Events are read in file order, so each branch below is last-write-wins (ADR 0002).
    if (event.type === "session.started") {
      node.parent = event.data.parent;
      node.runtime = event.data.runtime;
      node.cwd = event.data.cwd;
      node.capabilities = event.data.capabilities;
      node.startedAt = event.ts;
      node.terminalLocator = event.data.terminal;
      node.pid = event.data.pid;
      node.pidStartedAt = event.data.pidStartedAt;
      // A start after an end means the session is running again
      // (SendMessage re-fires SubagentStart under the same agent_id) — only
      // a start revives it, so the trailing usage.sampled after an end
      // never counts as activity.
      delete node.endedAt;
      delete node.endedReason;
    } else if (event.type === "session.ended") {
      node.endedAt = event.ts;
      node.endedReason = event.data.reason;
    } else if (event.type === "session.labeled") {
      Object.assign(node.labels, event.data.labels);
    } else if (event.type === "usage.sampled") {
      node.contextTokens = event.data.context_tokens;
    } else if (event.type === "action.decided") {
      // Captures every matched Action, not only a human-effect one —
      // independent of whether it was held, denied, flagged or allowed.
      node.lastAction = event.data.action;
    } else if (event.type === "notification.observed") {
      node.lastNotification = { kind: event.data.kind, ts: event.ts };
    } else if (event.type === "turn.ended") {
      node.lastTurnEnded = event.ts;
    }
  }

  return index;
}

/**
 * The cwd this session's own `session.started` carried — undefined when
 * there was no `session.started` at all. Deliberately not a fallback to
 * the caller's own cwd: treating undefined as "run here instead" would run
 * a denied command somewhere the human never asked for it to run
 * (`resolve.ts`'s `runInboxItem` refuses outright instead).
 */
export function cwdForSession(session: string, home: string = tenazaHome()): string | undefined {
  return buildSessionIndex(readSessionEvents(session, home)).get(session)?.cwd;
}

/**
 * This session's own category, before any rollup from descendants. Ended
 * always beats an open Inbox wait — a finished session is never shown "te
 * espera" for a Rule match it triggered before ending; that match stays
 * visible in the Inbox on its own, independent of this row.
 */
export function nodeCategory(node: SessionNode, waiting: ReadonlySet<string>): SessionCategory {
  if (node.endedAt !== undefined) {
    // Derived structurally from `parent`, never from parsing the free-text
    // `reason` — a subagent (has a parent) is "done"; a top-level session
    // (no parent) is "ended".
    return node.parent !== undefined ? "done" : "ended";
  }
  if (waiting.has(node.id)) return "waits";
  return "alive";
}

/**
 * Rolls up to whichever of itself and its descendants is most urgent
 * (`categoryRank`). Ties keep the parent's own value — deliberate, not an
 * oversight.
 */
export function rollupCategory(
  node: SessionNode,
  childrenOf: ReadonlyMap<string, SessionNode[]>,
  waiting: ReadonlySet<string>,
): SessionCategory {
  const own = nodeCategory(node, waiting);
  const children = childrenOf.get(node.id) ?? [];
  return children.reduce((best, child) => {
    const candidate = rollupCategory(child, childrenOf, waiting);
    return categoryRank(candidate) > categoryRank(best) ? candidate : best;
  }, own);
}

const GLYPH: Record<SessionCategory, string> = { waits: "⏸", alive: "●", done: "✓", ended: "○" };
const WORD: Record<SessionCategory, string> = {
  waits: "te espera",
  alive: "vivo",
  done: "terminó",
  ended: "cerró",
};
const STALLED_WORD = "sin señal";
const WAITING_WORD = "esperándote";

export function glyphFor(category: SessionCategory): string {
  return GLYPH[category];
}

/** The board keeps its own copy of this suffix (`viewModel.ts`) rather than importing this module, which pulls in Node builtins the UI can't use. */
function backgroundSuffix(activeDescendants: number): string {
  return activeDescendants > 0 ? ` · ${activeDescendants} en segundo plano` : "";
}

/**
 * Only overrides the "alive" word — waiting/done/ended already read
 * unambiguously. The precedence between a current Turn wait and Stalled is
 * decided by `sessionState` (`renderNode` below); this only picks the word
 * for whichever `state` it settled on.
 */
export function categoryWord(
  category: SessionCategory,
  state: SessionState = "working",
  activeDescendants: number = 0,
): string {
  if (category !== "alive") return WORD[category];
  if (state === "waiting") return `${WAITING_WORD}${backgroundSuffix(activeDescendants)}`;
  return state === "stalled" ? STALLED_WORD : WORD.alive;
}

/** Written to `endedReason` where a real SessionEnd's reason would go — an internal marker only, never a Rule a human sees. */
export const PROCESS_GONE_REASON = "process_gone";

/**
 * Is `node`'s process still the exact one `session.started` captured — not
 * a different process that reused the same pid after a reboot? A pure
 * decision over the already-read `startMarkers` map; `closeDeadProcesses`
 * does the one real `ps` read. Missing information (no pid captured) is
 * never evidence of death.
 */
export function isProcessGone(node: SessionNode, startMarkers: ReadonlyMap<number, string>): boolean {
  if (node.pid === undefined) return false;
  const current = startMarkers.get(node.pid);
  if (current === undefined) return true; // confirmed absent from the live process table
  if (node.pidStartedAt === undefined) return false; // bare pid only, no reuse guard possible
  return current !== node.pidStartedAt; // same pid NUMBER, a different process instance
}

/**
 * Batches every candidate pid into ONE `ps -p` call rather than one spawn
 * per session. A pid `ps` can't find is simply absent from its output
 * (verified: `ps` drops unmatched pids rather than erroring) — exactly the
 * "confirmed gone" signal `isProcessGone` reads back. Never throws: a
 * missing `ps` binary or sandboxed test environment degrades to an empty
 * map instead of a crash.
 */
function defaultProcessStartMarkers(pids: readonly number[]): ReadonlyMap<number, string> {
  const map = new Map<number, string>();
  if (pids.length === 0) return map;
  try {
    const proc = Bun.spawnSync(["ps", "-o", "pid=,lstart=", "-p", pids.join(",")]);
    for (const line of proc.stdout.toString("utf8").split("\n")) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      map.set(Number(match[1]), match[2] as string);
    }
  } catch {
  }
  return map;
}

/**
 * Closes every session whose process is CONFIRMED gone — `endedAt`/
 * `endedReason` set as a real SessionEnd would.
 *
 * `endedAt` is the node's own `lastEventTs`, never `now`: `now` changes on
 * every call, which would stop the 24h TERMINÓ window from ever aging a
 * card out, and would churn the board's payload on every poll. `now` only
 * backstops a fixture with a `pid` but no `lastEventTs` at all —
 * unreachable in the real pipeline, since a `pid` is only captured
 * alongside a `session.started`, which sets `lastEventTs` first.
 */
export function closeDeadProcesses(
  index: ReadonlyMap<string, SessionNode>,
  now: Date = new Date(),
  readProcessStartMarkers: (pids: readonly number[]) => ReadonlyMap<number, string> = defaultProcessStartMarkers,
): void {
  const candidates = [...index.values()].filter(
    (node): node is SessionNode & { pid: number } => node.endedAt === undefined && node.pid !== undefined,
  );
  if (candidates.length === 0) return;

  const startMarkers = readProcessStartMarkers([...new Set(candidates.map((node) => node.pid))]);

  for (const node of candidates) {
    if (!isProcessGone(node, startMarkers)) continue;
    node.endedAt = node.lastEventTs ?? now.toISOString();
    node.endedReason = PROCESS_GONE_REASON;
  }
}

export const NO_PID_SILENT_REASON = "no_pid_silent";

/**
 * Every session from before `session.started` captured `pid` (ADR 0008)
 * carries no `pid` at all, so `isProcessGone`/`closeDeadProcesses` can
 * never confirm it gone — there's nothing to check against the process
 * table. This is the fallback for those: gone silent past `windowMs`
 * (`TERMINO_WINDOW_MS` by default, the same 24h the board's TERMINÓ column
 * uses).
 */
export function isPidlessSilent(node: SessionNode, now: Date, windowMs: number = TERMINO_WINDOW_MS): boolean {
  if (node.pid !== undefined) return false;
  if (node.endedAt !== undefined) return false;
  if (node.lastEventTs === undefined) return false;
  return now.getTime() - new Date(node.lastEventTs).getTime() > windowMs;
}

/**
 * `closeDeadProcesses`'s companion for a session with no `pid` to check.
 *
 * `endedAt` is `lastEventTs + windowMs`, never bare `lastEventTs` (would
 * already read past the board's TERMINÓ window the instant this fires,
 * hiding the card before a human sees it) and never `now` (moves every
 * read, so the card never ages out — someone would have to archive every
 * one by hand). The fixed stamp gives the same 24h TERMINÓ window any ended
 * session gets, just starting when the silence crossed the line: visible
 * 24h-48h after going silent, then drops off past 48h on its own. A
 * session already silent past 48h the first time this rule sees it never
 * shows on the board at all — there is no real end moment left to recover.
 */
export function closeSilentPidlessSessions(
  index: ReadonlyMap<string, SessionNode>,
  now: Date = new Date(),
  windowMs: number = TERMINO_WINDOW_MS,
): void {
  for (const node of index.values()) {
    if (!isPidlessSilent(node, now, windowMs) || node.lastEventTs === undefined) continue;
    node.endedAt = new Date(new Date(node.lastEventTs).getTime() + windowMs).toISOString();
    node.endedReason = NO_PID_SILENT_REASON;
  }
}

/**
 * The one seam `tenaza status`, `statusline`, the board, and archive all
 * read a closed-out session index through — never reassembling
 * `buildSessionIndex` plus the two closes by hand, which is what let one
 * caller's local Activity-touch merge drift out of sync with the others.
 *
 * Order is fixed: touch merges into `lastEventTs` before either close
 * reads it, so a derived `endedAt` reflects the session's true last
 * activity. Reordering would let a dead- or silence-closed session's
 * `endedAt` miss activity the touch alone recorded.
 *
 * `touchedAt` is never read from disk here — the caller decides how to
 * produce it (archive merges only its own session's touch; the other
 * three merge every session's at once), so this stays indifferent to
 * which.
 */
export function closedOutSessionIndex(
  events: Event[],
  touchedAt: ReadonlyMap<string, string> = new Map(),
  now: Date = new Date(),
  readProcessStartMarkers: (pids: readonly number[]) => ReadonlyMap<number, string> = defaultProcessStartMarkers,
  windowMs: number = TERMINO_WINDOW_MS,
): Map<string, SessionNode> {
  const index = buildSessionIndex(events);

  for (const node of index.values()) {
    const touched = touchedAt.get(node.id);
    if (touched && (!node.lastEventTs || touched > node.lastEventTs)) node.lastEventTs = touched;
  }

  closeDeadProcesses(index, now, readProcessStartMarkers);
  closeSilentPidlessSessions(index, now, windowMs);

  return index;
}

function defaultGitRootFor(cwd: string): string | undefined {
  if (!cwd) return undefined;
  try {
    const proc = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
    if (proc.exitCode !== 0) return undefined;
    const out = proc.stdout.toString("utf8").trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The bucket a Session with neither a Label nor a known cwd groups under — never crashes, never vanishes. */
export const UNKNOWN_PROJECT = "(sin proyecto)";

/** Read fresh on every call (ADR 0002, no daemon-side cache) — `resolveGitRoot` is injectable so tests never spawn a real `git` process. */
export function deriveProject(
  node: SessionNode,
  resolveGitRoot: (cwd: string) => string | undefined = defaultGitRootFor,
): string {
  const labeled = node.labels.project;
  if (labeled) return labeled;
  if (!node.cwd) return UNKNOWN_PROJECT;
  return resolveGitRoot(node.cwd) ?? node.cwd;
}

/**
 * A git worktree's root for a given `cwd` cannot change within the
 * lifetime of one Daemon process, so this needs no invalidation key — once
 * resolved, memoized for good. One-shot processes (`tenaza status`,
 * `statusline`) have no reason to pay for a cache that dies with them, so
 * only `daemon.ts` builds one and passes it down for its own lifetime.
 */
export function createCachingGitRootResolver(
  resolveGitRoot: (cwd: string) => string | undefined = defaultGitRootFor,
): (cwd: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (cwd: string): string | undefined => {
    if (cache.has(cwd)) return cache.get(cwd);
    const root = resolveGitRoot(cwd);
    cache.set(cwd, root);
    return root;
  };
}

/**
 * Claude Code's own internal side-agents leave two noise shapes behind: a
 * log that is only its own end plus a usage sample (no `session.started`,
 * no Policy match, no Label — nothing useful to show), or a log that is
 * only a single `session.ended` with reason `"subagent_stop"`. Both get
 * hidden here rather than rendered as a permanent empty row.
 *
 * The second shape is gated on `endedReason` specifically, never on the
 * type-set alone: a genuine top-level session that ended with no
 * `session.started` at all is a real, if sparse, session and is never
 * dropped just because its log happens to be short. `handleSubagentStop`
 * no longer writes this shape, but a log that already landed before that
 * fix is never deleted (ADR 0002) — this still has to catch it.
 */
export function isNoiseSession(eventTypes: ReadonlySet<Event["type"]>, endedReason?: string): boolean {
  if (eventTypes.size === 2 && eventTypes.has("session.ended") && eventTypes.has("usage.sampled")) return true;
  return eventTypes.size === 1 && eventTypes.has("session.ended") && endedReason === "subagent_stop";
}

/**
 * This id's latest `session.archived` event ts — a map, not a bare set of
 * archived ids: a session can be resumed under the same id (`claude
 * --resume`) and archived again later, so `isArchived` below needs to tell
 * "still archived" apart from "archived once but stale now" by comparing
 * timestamps. An earlier archive event is never deleted (ADR 0002), only
 * superseded.
 */
export function latestArchiveTimestamps(home: string = tenazaHome()): Map<string, string> {
  const map = new Map<string, string>();
  for (const event of readHumanEvents(home)) {
    if (event.type !== "session.archived") continue;
    const current = map.get(event.session);
    if (!current || event.ts > current) map.set(event.session, event.ts);
  }
  return map;
}

/**
 * An archive hides a card from the board only while nothing has happened
 * on that session since — never permanently. A resumed session's
 * `lastEventTs` moves past `archivedAt`, which brings the card back in
 * whatever column its current state now puts it.
 *
 * Used only by the board payload and the re-archive check — never by
 * `renderSessionTree`, since archiving hides a session from the board, not
 * the CLI.
 */
export function isArchived(archivedAt: string | undefined, lastEventTs: string | undefined): boolean {
  if (archivedAt === undefined) return false;
  return lastEventTs === undefined || lastEventTs <= archivedAt;
}

/**
 * Every session's own "last ordinary activity" signal — each
 * `<session>.touched` file's mtime, bumped by `toolcalls.ts`'s
 * `touchSession` on every tool-use hook, matched or not. Never an Event,
 * so the single-writer log (ADR 0002) stays exactly the size it was. A
 * file that vanishes between the directory listing and the stat is simply
 * absent from this read, never a crash.
 *
 * `buildSessionIndex` stays a pure function of `Event[]` and has no reason
 * to know this file exists — the merge happens one layer up, in
 * `closedOutSessionIndex`. Every reader of a session's state needs this
 * signal equally; none of them gets to skip it.
 */
export function readTouchedTimestamps(home: string = tenazaHome()): Map<string, string> {
  const map = new Map<string, string>();
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return map;
  const suffix = ".touched";
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(suffix)) continue;
    try {
      const stat = statSync(path.join(dir, name));
      map.set(name.slice(0, -suffix.length), new Date(stat.mtimeMs).toISOString());
    } catch {
    }
  }
  return map;
}

/**
 * One session's own Activity touch, read directly rather than through
 * `readTouchedTimestamps`'s full directory scan — `archiveSession` already
 * knows which session it's archiving, so scanning every OTHER session's
 * `.touched` file just to discard the result would be pure waste on every
 * archive click. `undefined` when the file was never written or vanished
 * mid-read.
 */
export function readSessionTouchedTimestamp(session: string, home: string = tenazaHome()): string | undefined {
  try {
    return new Date(statSync(sessionTouchedPath(session, home)).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Is `node` currently waiting on a native prompt (a permission dialog, or
 * the idle timeout) right now? Neither signal has a "resolved" hook event,
 * so this is derived fresh from ordering rather than a stored flag:
 * `lastNotification` still names the CURRENT wait exactly while
 * `lastEventTs` has not moved past it. The moment anything later happens —
 * a fresh prompt, a tool-call touch, another notification — `lastEventTs`
 * advances past it and this reads `undefined` again, with no event ever
 * written for that transition.
 */
export function nativeWaitFor(node: SessionNode): { kind: NotificationKind; since: string } | undefined {
  const notification = node.lastNotification;
  if (!notification) return undefined;
  if (node.lastEventTs !== notification.ts) return undefined;
  return { kind: notification.kind, since: notification.ts };
}

/** working: mid-turn. waiting: between turns, for the human. */
export type TurnState = "working" | "waiting";

/**
 * This session's own Stop-derived wait — present when its latest turn
 * ended and nothing has happened since (no fresh prompt, tool-call touch,
 * or later native prompt); the moment something does, `lastEventTs` moves
 * past `lastTurnEnded` and this reads `undefined` again.
 *
 * Returns `undefined` whenever a more specific native wait is also current
 * (`nativeWaitFor`) — that one carries its own kind and renders its own
 * badge, so a card never shows two waiting badges at once. Also
 * `undefined` once the session has ended, so done/ended always outranks
 * any wait.
 */
export function turnWaitSince(node: SessionNode): string | undefined {
  if (node.endedAt !== undefined) return undefined;
  if (nativeWaitFor(node) !== undefined) return undefined;
  if (node.lastTurnEnded !== undefined && node.lastTurnEnded === node.lastEventTs) return node.lastTurnEnded;
  return undefined;
}

export function turnState(node: SessionNode): TurnState {
  if (node.endedAt !== undefined) return "working";
  return nativeWaitFor(node) !== undefined || turnWaitSince(node) !== undefined ? "waiting" : "working";
}

/**
 * How many of `nodeId`'s descendants (recursively) have not yet ended —
 * work this session's own row can't show. The only "background work"
 * Tenaza has visibility into: a backgrounded shell command fires no hook
 * Tenaza could ever observe finishing, so only real subagent sessions are
 * counted here, never those.
 */
export function countActiveDescendants(nodeId: string, childrenOf: ReadonlyMap<string, SessionNode[]>): number {
  const children = childrenOf.get(nodeId) ?? [];
  let count = 0;
  for (const child of children) {
    if (child.endedAt === undefined) count += 1;
    count += countActiveDescendants(child.id, childrenOf);
  }
  return count;
}

/** Every distinct event type observed per session — what `isNoiseSession` reads. Exported so the board payload can drop the same noise rows from `/events` without a second copy of this scan. */
export function eventTypesBySession(events: Event[]): Map<string, Set<Event["type"]>> {
  const map = new Map<string, Set<Event["type"]>>();
  for (const event of events) {
    const types = map.get(event.session) ?? new Set();
    types.add(event.type);
    map.set(event.session, types);
  }
  return map;
}

function byStartedThenId(a: SessionNode, b: SessionNode): number {
  return (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.id.localeCompare(b.id);
}

/**
 * Every session that names `parent` as its own, sorted chronologically —
 * regardless of project; project only decides which group a session with
 * no renderable parent roots under (`groupRootsByProject` below). A child
 * whose parent was noise or never observed finds nothing here and
 * surfaces as its own root there instead.
 *
 * Exported so the board payload can build the same parent→children map
 * once per read and feed it to `countActiveDescendants`, rather than
 * re-deriving a second copy.
 */
export function childrenIndex(nodes: SessionNode[]): Map<string, SessionNode[]> {
  const map = new Map<string, SessionNode[]>();
  for (const node of nodes) {
    if (node.parent === undefined) continue;
    const siblings = map.get(node.parent) ?? [];
    siblings.push(node);
    map.set(node.parent, siblings);
  }
  for (const siblings of map.values()) siblings.sort(byStartedThenId);
  return map;
}

/**
 * Roots every session under its derived project. A session roots here only
 * when it has no RENDERABLE parent — no `parent` at all, or a `parent` id
 * that names no surviving node. Project is deliberately not part of this
 * test: a session with a renderable parent is always nested by
 * `childrenIndex` instead, even across projects — making project part of
 * this test would render it twice, once here and once nested there.
 */
function groupRootsByProject(
  nodes: SessionNode[],
  projectOf: ReadonlyMap<string, string>,
): Map<string, SessionNode[]> {
  const ids = new Set(nodes.map((node) => node.id));
  const groups = new Map<string, SessionNode[]>();

  for (const node of nodes) {
    const project = projectOf.get(node.id) ?? UNKNOWN_PROJECT;
    const isRoot = node.parent === undefined || !ids.has(node.parent);
    if (!isRoot) continue;

    const roots = groups.get(project) ?? [];
    roots.push(node);
    groups.set(project, roots);
  }

  for (const roots of groups.values()) roots.sort(byStartedThenId);
  return groups;
}

/** `ticket` label when announced, else "subagente"/"sesión" by structural role. Shown opaquely, exactly as announced — never validated or parsed, unlike `project`, which `deriveProject` interprets. */
export function roleOf(node: SessionNode): string {
  return node.labels.ticket ?? (node.parent !== undefined ? "subagente" : "sesión");
}

export function formatAge(node: SessionNode, now: Date): string {
  if (!node.lastEventTs) return "—";
  const ms = Math.max(0, now.getTime() - new Date(node.lastEventTs).getTime());
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** "No data" for an Adapter that never declared the `measure` Capability at all (ADR 0001) — distinct from `formatContextBar`/`formatContextNumber`'s empty-bar-plus-dash for "has `measure`, not sampled yet": that's honest uncertainty on a Capability that COULD answer; this is one that structurally never will. */
const NO_MEASURE_CAPABILITY = "sin datos";

/**
 * Bar+number when the session's Adapter declared `measure`, else the
 * Capability-gated "no data" text — never inferred from whether a sample
 * happens to exist. A stray `usage.sampled` on a non-measuring session
 * (e.g. a test fixture) is deliberately ignored: the Capability gates
 * this, never the data.
 */
export function formatContextColumn(node: SessionNode, thresholdTokens: number): string {
  if (!node.capabilities.includes("measure")) return NO_MEASURE_CAPABILITY;
  return `${formatContextBar(node.contextTokens, thresholdTokens)} ${formatContextNumber(node.contextTokens, thresholdTokens)}`;
}

function renderNode(
  node: SessionNode,
  childrenOf: ReadonlyMap<string, SessionNode[]>,
  waiting: ReadonlySet<string>,
  now: Date,
  thresholdTokens: number,
  stallThresholdMs: number,
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
  lines: string[],
): void {
  const category = rollupCategory(node, childrenOf, waiting);
  // Turn state and background count are per-node, never rolled up — each
  // descendant already renders its own row.
  const turn = turnState(node);
  // Same classifier the board uses (`sessionState`), so the two never disagree.
  const state: SessionState = sessionState(
    { ended: node.endedAt !== undefined, waitingForHuman: turn === "waiting", lastEventTs: node.lastEventTs },
    now,
    stallThresholdMs,
  );
  const activeDescendants = countActiveDescendants(node.id, childrenOf);
  const head = isRoot ? "  " : `${prefix}${isLast ? "└ " : "├ "}`;
  const contextColumn = formatContextColumn(node, thresholdTokens);
  lines.push(
    `${head}${glyphFor(category)} ${roleOf(node)}  ${node.id}  ${contextColumn}  ${categoryWord(category, state, activeDescendants)}  ${formatAge(node, now)}`,
  );

  const children = childrenOf.get(node.id) ?? [];
  children.forEach((child, i) => {
    renderNode(
      child,
      childrenOf,
      waiting,
      now,
      thresholdTokens,
      stallThresholdMs,
      isRoot ? "  " : prefix + (isLast ? "  " : "│ "),
      i === children.length - 1,
      false,
      lines,
    );
  });
}

/**
 * `tenaza status`'s session tree, grouped per project. Reads the same
 * `closedOutSessionIndex` the board builds, rather than reassembling
 * `buildSessionIndex` plus the two closes by hand, so the CLI and the
 * board never disagree about a session's state.
 */
export function renderSessionTree(home: string = tenazaHome(), now: Date = new Date()): string {
  const events = readAllSessionEvents(home);
  if (events.length === 0) return "";

  const index = closedOutSessionIndex(events, readTouchedTimestamps(home), now);
  const eventTypes = eventTypesBySession(events);
  const nodes = [...index.values()].filter(
    (node) => !isNoiseSession(eventTypes.get(node.id) ?? new Set(), node.endedReason),
  );
  if (nodes.length === 0) return "";

  const projectOf = new Map(nodes.map((node) => [node.id, deriveProject(node)] as const));
  const childrenOf = childrenIndex(nodes);
  const waiting = new Set(deriveInbox(home).map((row) => row.session));
  const groups = groupRootsByProject(nodes, projectOf);
  const policy = loadPolicy(home);
  const thresholdTokens = policy.thresholdTokens;
  // Policy's own `stallMinutes` — never a second hardcoded threshold here.
  const stallThresholdMs = policy.stallMinutes * 60 * 1000;

  const lines: string[] = [];
  for (const project of [...groups.keys()].sort()) {
    lines.push(project);
    const roots = groups.get(project) ?? [];
    roots.forEach((root, i) =>
      renderNode(
        root,
        childrenOf,
        waiting,
        now,
        thresholdTokens,
        stallThresholdMs,
        "",
        i === roots.length - 1,
        true,
        lines,
      ),
    );
    lines.push("");
  }
  return lines.join("\n");
}
