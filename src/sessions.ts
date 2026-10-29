import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { TERMINO_WINDOW_MS } from "./board";
import type { Action, Capability, Event, NotificationKind, TerminalLocator } from "./contract/event";
import { formatContextBar, formatContextNumber } from "./contextbar";
import { deriveInbox } from "./inbox";
import { readAllSessionEvents, readHumanEvents, readSessionEvents } from "./log";
import { sessionsDir, tenazaHome } from "./paths";
import { loadPolicy } from "./policy";

/**
 * The four states the ticket names for a Session's row (and what a parent
 * rolls up to, per its most urgent descendant): waits for the human > alive
 * > done > ended. "Stalled" (a Session with no recent Event) is NOT a fifth
 * category here — it is a WORD override on "alive" applied at render time
 * (`categoryWord`), since the ticket's own glyph set has only four symbols.
 */
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

/** One observed Session, derived from every Event that names it — never stored, only read (ADR 0002). */
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
  /** The latest `ts` across every Event naming this Session — the basis for `age` and `isStalled`. */
  lastEventTs?: string;
  /** The context size from the LATEST `usage.sampled` Event this Session has (q9). `undefined` means never sampled, never zero. */
  contextTokens?: number;
  /** The Action from the LATEST `action.decided` Event (ticket 08's "last signal" — what this Session most recently attempted, allowed or not). Last write wins, same convention as `contextTokens`; `undefined` means it has never attempted a matched or recorded Action. */
  lastAction?: Action;
  /** Ticket 14: the LATEST `notification.observed` Event this Session carries — last write wins, same convention as `lastAction`. Whether it still reads as a CURRENT native wait (vs. superseded by later activity) is `nativeWaitFor`'s own call, never decided here. */
  lastNotification?: { kind: NotificationKind; ts: string };
  /** Ticket 05 ("Turn state"): the ts of the LATEST `turn.ended` Event (this Session's own `Stop`) — last write wins, same convention as `lastNotification`. Whether it still reads as a CURRENT wait (vs. superseded by a fresh prompt or ordinary activity) is `turnWaitSince`'s own call, never decided here. */
  lastTurnEnded?: string;
  /** Ticket 11 (decision 09): the terminal locator its OWN `session.started` carried, when its Adapter captured one — never set on a subagent (`adapters/claude.ts`'s `handleSubagentStart` never calls the capture), which is exactly why "a subagent's card focuses its PARENT's terminal" is a RESOLUTION-time rule (`daemon.ts`'s focus route walks to `node.parent`) rather than something copied onto every node here. */
  terminalLocator?: TerminalLocator;
  /** Ticket 02: the runtime's own OS process id, captured at `session.started` (`adapters/claude.ts`'s `captureProcessMarker`) — `undefined` for a backfilled start, legacy data, or an environment `ps` couldn't be read in. UNLIKE `terminalLocator`, a subagent carries its OWN copy (same OS process as its parent), never resolved by walking to `node.parent`. */
  pid?: number;
  /** Ticket 02: `pid`'s own process-start marker (`ps -o lstart=`) at the moment it was captured — paired with `pid` so `closeDeadProcesses` can tell a reused pid after a reboot apart from the same process still running. `undefined` means the reuse guard can't be applied; `pid` alone is still trusted then. */
  pidStartedAt?: string;
}

/** Thrown by every Session-scoped operation (the focus and archive write routes, `daemon.ts`/`resolve.ts`, ticket 11) when an id names no observed Session at all. */
export class UnknownSessionError extends Error {
  constructor(public readonly id: string) {
    super(`unknown session ${id}`);
  }
}

function emptyNode(id: string): SessionNode {
  return { id, capabilities: [], labels: {} };
}

/**
 * One SessionNode per distinct `session` any Event names — "every observed
 * Session" means every id ANY Event names, not only ones carrying a
 * lifecycle Event. A Session known only through an `action.decided` (ticket
 * 01/02's fixtures, written before this ticket existed) still gets a node,
 * with everything but `id` and `lastEventTs` left undefined.
 */
export function buildSessionIndex(events: Event[]): Map<string, SessionNode> {
  const index = new Map<string, SessionNode>();

  for (const event of events) {
    const node = index.get(event.session) ?? emptyNode(event.session);
    index.set(event.session, node);

    if (!node.lastEventTs || event.ts > node.lastEventTs) node.lastEventTs = event.ts;

    if (event.type === "session.started") {
      node.parent = event.data.parent;
      node.runtime = event.data.runtime;
      node.cwd = event.data.cwd;
      node.capabilities = event.data.capabilities;
      node.startedAt = event.ts;
      node.terminalLocator = event.data.terminal;
      node.pid = event.data.pid;
      node.pidStartedAt = event.data.pidStartedAt;
      // A start AFTER an end is the same Session running again (ticket 13):
      // SendMessage re-fires SubagentStart under the same agent_id. Only a
      // start revives it — the usage.sampled every SessionEnd/SubagentStop
      // appends right after its own end must never read as activity.
      delete node.endedAt;
      delete node.endedReason;
    } else if (event.type === "session.ended") {
      node.endedAt = event.ts;
      node.endedReason = event.data.reason;
    } else if (event.type === "session.labeled") {
      Object.assign(node.labels, event.data.labels);
    } else if (event.type === "usage.sampled") {
      // Last write wins, same as endedAt/endedReason above — the file's own
      // chronological order is the only ordering Tenaza trusts (ADR 0002).
      node.contextTokens = event.data.context_tokens;
    } else if (event.type === "action.decided") {
      // Every matched Action, not only a `human`-effect one — "last signal"
      // (ticket 08) is "what did this Session most recently attempt",
      // independent of whether it was held, denied, flagged or allowed.
      node.lastAction = event.data.action;
    } else if (event.type === "notification.observed") {
      // Last write wins, same convention as lastAction/contextTokens above.
      node.lastNotification = { kind: event.data.kind, ts: event.ts };
    } else if (event.type === "turn.ended") {
      // Ticket 05: last write wins, same convention as lastNotification above.
      node.lastTurnEnded = event.ts;
    }
  }

  return index;
}

/**
 * The `cwd` a Session's OWN `session.started` carried (ticket 06, "`run`
 * from the Session's directory") — `undefined` when this Session has no
 * `session.started` at all (its start hook never fired, or the Session id
 * is unknown outright). Deliberately NOT a fallback to the caller's own
 * current directory: a caller that treats `undefined` as "run here
 * instead" would silently run a denied command somewhere the human never
 * asked for it to run (the ticket's own warning) — `resolve.ts`'s
 * `runInboxItem` refuses outright instead.
 */
export function cwdForSession(session: string, home: string = tenazaHome()): string | undefined {
  return buildSessionIndex(readSessionEvents(session, home)).get(session)?.cwd;
}

/**
 * This Session's OWN category — before any rollup from descendants. ENDED
 * beats an open Inbox item (ticket 05, #1436's own fix — flipped from the
 * priority ticket 03 originally gave this check): a Session that already
 * finished is never shown "te espera" just because a `human`-Rule match it
 * triggered before ending is still unresolved. That match stays visible in
 * the Inbox on its own (`deriveInbox`), independent of this Session's row —
 * an open Inbox item only promotes a STILL-RUNNING Session to "waits".
 * (`rollupCategory`'s own waits > alive > done > ended priority, below, is
 * unaffected: it ranks a PARENT against its descendants, never this check.)
 */
export function nodeCategory(node: SessionNode, waiting: ReadonlySet<string>): SessionCategory {
  if (node.endedAt !== undefined) {
    // An ended Session WITH a parent is a subagent finishing its work ("done");
    // an ended Session with no parent is the top-level Session closing ("ended").
    // Derived structurally from `parent`, never from parsing the free-text
    // `reason` — a build-time judgment call (ticket 03), not spec-mandated.
    return node.parent !== undefined ? "done" : "ended";
  }
  if (waiting.has(node.id)) return "waits";
  return "alive";
}

/**
 * A parent's displayed category is the most urgent among itself and every
 * descendant (waits > alive > done > ended) — the ticket's own rollup rule.
 * A tie keeps the SELF value (self wins ties): a build-time judgment call,
 * since the ticket's priority order only ranks the four categories against
 * each other, never says who wins a tie within one category.
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
/** Ticket 05: the tree's own word for an alive Session between Turns — never a fifth category or a new glyph (same "word override on alive" convention this file's own `isStalled`/`STALLED_WORD` already established), just rendered through `categoryWord` below instead of "vivo". */
const WAITING_WORD = "esperándote";

export function glyphFor(category: SessionCategory): string {
  return GLYPH[category];
}

/** Ticket 05 (AC3): "esperándote · N en segundo plano" — the ONE place this suffix is built for the CLI tree (the board's own literal lives separately in `viewModel.ts`, same convention `NO_MEASURE_TEXT` already follows there, never importing this node-builtin-using module). Empty when nothing is running in the background at all — never a stray " · 0 en segundo plano". */
function backgroundSuffix(activeDescendants: number): string {
  return activeDescendants > 0 ? ` · ${activeDescendants} en segundo plano` : "";
}

/**
 * Stalled and Turn state only ever override the "alive" word — a
 * waiting(-for-Inbox)/done/ended Session already reads unambiguously.
 * Ticket 05: a Turn that ended wins over stalled whenever both would
 * otherwise apply — silence with a KNOWN cause ("esperándote," the human
 * just hasn't typed the next prompt yet) is never relabeled "sin señal"
 * (an UNKNOWN cause), however long that silence runs; "sin señal" stays
 * reserved for a Session that went quiet for no reason this file can name
 * at all. `turn`/`activeDescendants` default to "working"/0 so every
 * pre-ticket-05 2-arg call (`notify.ts`, every existing test) is unaffected
 * byte-for-byte.
 */
export function categoryWord(
  category: SessionCategory,
  stalled: boolean,
  turn: TurnState = "working",
  activeDescendants: number = 0,
): string {
  if (category !== "alive") return WORD[category];
  if (turn === "waiting") return `${WAITING_WORD}${backgroundSuffix(activeDescendants)}`;
  return stalled ? STALLED_WORD : WORD.alive;
}

/**
 * No recent Event past this age reads as stalled — an implementation choice
 * the ticket explicitly leaves to the code, not the spec. 15 minutes: long
 * enough that an ordinary pause between tool calls never trips it, short
 * enough to flag a Session that has genuinely gone quiet.
 */
export const STALL_THRESHOLD_MS = 15 * 60 * 1000;

export function isStalled(node: SessionNode, now: Date, thresholdMs: number = STALL_THRESHOLD_MS): boolean {
  if (!node.lastEventTs) return false;
  return now.getTime() - new Date(node.lastEventTs).getTime() > thresholdMs;
}

/**
 * Ticket 02 ("a dead Session stops reading as live"): Tenaza's OWN word for
 * a Session closed because its runtime process is gone — written onto
 * `endedReason` exactly where a real `SessionEnd`'s runtime-supplied reason
 * would go, but never confusable with one (AC1: "reported as a distinct
 * reason… so the two never blur"). Never a Rule a human would see; purely
 * an internal marker for anything that ever reads `endedReason` later.
 */
export const PROCESS_GONE_REASON = "process_gone";

/**
 * Ticket 02: is `node`'s own OS process the EXACT one its `session.started`
 * captured — never resurrected by an unrelated process that happens to
 * reuse the same pid after a reboot (the ticket's own named trap)? A pure
 * decision over an ALREADY-READ `startMarkers` map (`closeDeadProcesses`
 * below does the one real `ps` read, batched across every candidate at
 * once) — this function itself never touches the process table.
 *
 * `node.pid === undefined` (legacy data, a backfilled start, or an
 * environment `ps` couldn't be read in at SessionStart) means nothing was
 * ever captured to check — reads as "cannot tell," never "gone": this NEVER
 * marks a Session dead on the mere ABSENCE of a pid (AC2's own "only a dead
 * process changes category" — missing information is not evidence of
 * death). A pid present in `startMarkers` but with no stored
 * `pidStartedAt` to compare degrades to trusting the bare pid number alone
 * — the best available signal, same silent-degrade convention every other
 * optional capture in this project already follows.
 */
export function isProcessGone(node: SessionNode, startMarkers: ReadonlyMap<number, string>): boolean {
  if (node.pid === undefined) return false;
  const current = startMarkers.get(node.pid);
  if (current === undefined) return true; // confirmed absent from the live process table
  if (node.pidStartedAt === undefined) return false; // bare pid only, no reuse guard possible
  return current !== node.pidStartedAt; // same pid NUMBER, a different process instance
}

/**
 * The real process-table read (never run in a unit test — `closeDeadProcesses`'s
 * own `readProcessStartMarkers` parameter is what a test injects instead,
 * same shape `defaultGitRootFor`/`defaultPsWalk` already use): ONE `ps`
 * call for every candidate pid at once (`-p` takes a comma list) — ticket
 * 13's own lesson, never repeated here as one spawn per Session. A pid `ps`
 * cannot find is simply ABSENT from its own output (verified against a
 * mixed real+bogus `-p` list: `ps` drops what it can't find rather than
 * erroring per-pid) — exactly the "confirmed gone" signal `isProcessGone`
 * reads back. Never throws: a missing `ps` binary or a sandboxed test
 * environment with no real process table degrades to an empty map —
 * "nobody confirmed gone this read," never a crash.
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
    // See the doc comment above.
  }
  return map;
}

/**
 * Ticket 02's own fix, applied in exactly ONE place so `tenaza status`
 * (`renderSessionTree`), `statusline` (`deriveStatuslineCounts`) and the
 * board (`daemon.ts`'s `buildBoardPayload`) can never disagree (AC1: "one
 * rule, the same in all three") — each calls this right after
 * `buildSessionIndex`, before deriving anything from `endedAt`.
 *
 * Closes every Session whose own runtime process is CONFIRMED gone —
 * `endedAt`/`endedReason` set exactly as a real `SessionEnd` would read,
 * so every existing consumer (`nodeCategory`, `board.ts`'s `sessionColumn`,
 * `statusline.ts`'s `isLive`) treats it correctly with NO new logic of its
 * own. Never written back to the log — a derived, read-side fact,
 * recomputed fresh on every call (ADR 0002), and reached only from
 * `status`/`statusline`/the board, never from a hook's own answer path
 * (ADR 0007, the ticket's own AC4).
 *
 * `endedAt` is set to the node's OWN `lastEventTs` — its last confirmed
 * activity — never to `now`: using `now` would make `endedAt` a different
 * value on every single call (nothing persists it), which would never let
 * `sessionColumn`'s 24h TERMINÓ window actually age the card out, and would
 * spuriously change the board's own payload on every poll tick forever.
 * `now` is used only as a last-resort fallback for a hand-built fixture
 * with a `pid` but no `lastEventTs` at all — unreachable through the real
 * pipeline, since capturing a `pid` requires a `session.started` Event,
 * which `buildSessionIndex` already folds into `lastEventTs` first.
 *
 * Only a node with NO real end yet (`endedAt === undefined`) is ever a
 * candidate — this never overwrites a real `SessionEnd`'s own reason, and
 * a node with no `pid` at all is left exactly as it was (AC2: a live-but-
 * idle Session, or one Tenaza never captured a pid for, keeps reading
 * alive/"sin señal" — only a CONFIRMED-dead process ever changes category).
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

/**
 * Ticket 06 ("a Session with no pid stops reading live after 24h of
 * silence"): Tenaza's own word for a Session closed by THIS rule —
 * distinct from `PROCESS_GONE_REASON` (AC: "the ended reason is
 * distinguishable from `process_gone`... so a reader can tell the two
 * apart"). Same "purely an internal marker, never a Rule a human would see"
 * convention `PROCESS_GONE_REASON` already follows.
 */
export const NO_PID_SILENT_REASON = "no_pid_silent";

/**
 * Ticket 06: is `node` a transition-era Session gone silent long enough to
 * read as ended? Every Session started before `session.started` began
 * capturing `pid` (ADR 0008, ticket 02 — every Session from the 0.2.0
 * binary) carries NO `pid` at all, which means `isProcessGone`/
 * `closeDeadProcesses` can NEVER confirm one of these gone — there is
 * nothing to check against the live process table (`isProcessGone`'s own
 * "missing information is not evidence of death" rule, untouched by this
 * ticket). Found 2026-10-28: the statusline read "7 vivas" while only 2
 * `claude` processes existed — 5 pre-0.3.0 Sessions with no `pid` could
 * never be confirmed gone, and `archiveSession` refused to remove them
 * (`resolve.ts`) since nothing could ever set their `endedAt` either.
 *
 * `windowMs` is `TERMINO_WINDOW_MS` (`board.ts`) by default — the SAME 24h
 * the board's own TERMINÓ column already uses (AC: "reuse… never a second
 * magic number"), not a new number invented for this rule (ADR 0010).
 *
 * A Session that already has a real end, or one that carries a `pid` at
 * all (the real `closeDeadProcesses` check owns that one — AC: "a Session
 * WITH a pid is never touched by this rule"), is never a candidate here —
 * the two rules are mutually exclusive by construction, so they can never
 * disagree about the same Session. A Session with no `lastEventTs` at all
 * (no Event has ever named it) has nothing to measure silence against yet,
 * the same convention `isStalled` already follows.
 */
export function isPidlessSilent(node: SessionNode, now: Date, windowMs: number = TERMINO_WINDOW_MS): boolean {
  if (node.pid !== undefined) return false;
  if (node.endedAt !== undefined) return false;
  if (node.lastEventTs === undefined) return false;
  return now.getTime() - new Date(node.lastEventTs).getTime() > windowMs;
}

/**
 * Ticket 06: `closeDeadProcesses`'s own companion for a Session it can
 * never confirm gone — `isPidlessSilent`'s own shape, closed the SAME way a
 * real `SessionEnd` would read (`endedAt`/`endedReason` set, never written
 * back to the log — ADR 0002, recomputed fresh on every call, exactly
 * `closeDeadProcesses`'s own convention). Called right after
 * `closeDeadProcesses` at every one of its own call sites
 * (`renderSessionTree`, `statusline.ts`'s `deriveStatuslineCounts`,
 * `daemon.ts`'s board payload, `resolve.ts`'s `archiveSession`) so this fix
 * reaches every surface for free — ticket 02's own "one rule, never
 * disagreeing" convention (AC1), extended rather than duplicated.
 *
 * `endedAt` is `lastEventTs` PLUS `windowMs` (ADR 0010, human's own call)
 * — the FIXED moment this Session's silence first crossed the 24h line,
 * never `lastEventTs` bare and never `now`. A bare `lastEventTs` would read
 * the board's own TERMINÓ window (`board.ts`'s `sessionColumn`, the SAME
 * `TERMINO_WINDOW_MS`) as already past its 24h the instant this rule can
 * even fire, dropping the card before a human ever sees it. `now` was tried
 * first and rejected: it moves on every read, so the card never ages out of
 * TERMINÓ on its own and a human has to archive every single one by hand.
 * This fixed stamp gives the board exactly the SAME 24h-wide TERMINÓ
 * window every other ended Session gets, just shifted to start when the
 * silence crossed the line rather than when the last real Event landed —
 * the card is TERMINÓ (and archivable with "x") from 24h to 48h of total
 * silence, then drops off the board on its own past 48h, exactly like any
 * other ended Session ages out. A Session already silent past 48h the
 * first time this rule ever observes it simply never shows on the board at
 * all — accepted (ADR 0010): there is no real end moment to recover for
 * data that stale, and `tenaza status`/the statusline still read it as
 * ended regardless (they gate on `endedAt !== undefined` alone, never on
 * the board's own window).
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

/**
 * project Label → git root of cwd → cwd — the spec's own fallback chain,
 * read on every call (no daemon, ADR 0002). `resolveGitRoot` is injectable
 * so tests never spawn a real `git` process.
 */
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
 * Ticket 13, criterion 3 — the ACTUAL measured cause, found by profiling
 * `buildBoardPayload` once the log-read cache (`log.ts`'s `SessionLogCache`)
 * turned out NOT to be where the ~440 ms at real scale went: every Session
 * with no `project` Label spawns its OWN `git … rev-parse` process in
 * `defaultGitRootFor`, and the real-scale fixture (1165 Sessions, 197 of
 * them visible) has only 8 DISTINCT `cwd`s among them — one spawn per
 * Session instead of one per distinct `cwd` is what actually cost
 * ~450 ms, confirmed by isolating this one call from the rest of
 * `buildBoardPayload` and timing it alone.
 *
 * A `git` worktree's root for a given `cwd` cannot change within the
 * lifetime of ONE Daemon process (the worktree would have to move or be
 * deleted and recreated elsewhere while the Daemon keeps running) — so,
 * unlike the log cache, this one never needs an invalidation key at all:
 * once resolved, a `cwd`'s root is memoized for good. `tenaza status` and
 * `statusline` (one-shot processes) have no reason to pay for a cache that
 * dies with them — `deriveProject`'s own default stays exactly as it was;
 * only `daemon.ts` builds ONE resolver via this and passes it down for the
 * life of the Daemon.
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
 * Claude Code's own internal side-agents (ticket 05 — #1436's "~85 phantom
 * Sessions" measured on the human's real `tenaza status`, 2026-10-25): a
 * Session whose ENTIRE observed log is its own end plus a Usage sample —
 * no `session.started` even after `adapters/claude.ts`'s own M6 backfill
 * (the triggering Events never carried a `cwd` to backfill FROM), no
 * Policy match, no Label. There is nothing useful to show for it, so
 * `renderSessionTree` hides it rather than rendering a permanent
 * "(sin proyecto) sin datos cerró" row forever.
 *
 * Widened 2026-10-27 for a NARROWER legacy shape the
 * same side-agents also leave behind — a log whose ENTIRE content is a
 * single `session.ended` with reason `"subagent_stop"` (no usage sample at
 * all, e.g. an unreadable or absent transcript). `adapters/claude.ts`'s own
 * `handleSubagentStop` now refuses to WRITE this shape going forward (it
 * never appends anything for an `agent_id` with no existing log), but a
 * log that already landed on disk before that fix shipped is never
 * deleted (ADR 0002) — this is what still hides it from a render. Gated on
 * `endedReason` specifically (never on the type-set alone, unlike the
 * two-Event case above): a GENUINE top-level Session that happens to have
 * ended with no `session.started` at all (its own end carried no `cwd` to
 * backfill from either) is a real, if sparse, Session — never silently
 * dropped just because its log happens to be short. `endedReason` is
 * `undefined` for every pre-ticket-14 caller, which keeps this branch
 * permanently false and the original two-Event rule untouched for them.
 */
export function isNoiseSession(eventTypes: ReadonlySet<Event["type"]>, endedReason?: string): boolean {
  if (eventTypes.size === 2 && eventTypes.has("session.ended") && eventTypes.has("usage.sampled")) return true;
  return eventTypes.size === 1 && eventTypes.has("session.ended") && endedReason === "subagent_stop";
}

/**
 * Ticket 11's "archive a TERMINÓ card": every Session id's LATEST
 * `session.archived` Event ts, read from the human log's own Events (ADR
 * 0002 — no state beside the logs; the Daemon's write route appended one
 * there, never a side file). Scanned fresh on every read, same convention
 * as every other derived state in this project.
 *
 * Orchestrator review, 2026-10-27: a Claude Code Session can be RESUMED
 * (`claude --resume`/`--continue`) under the SAME `session_id`, firing
 * SessionStart/tool Events again long after it was archived — so a human
 * may archive, resume, run, and eventually archive the SAME Session a
 * SECOND time. Collapsing to the newest ts here (never a bare `Set`,
 * which this function used to return) is what lets `isArchived` below
 * tell "still archived" apart from "was archived once, but that's stale
 * now" — an EARLIER archive Event is never deleted (ADR 0002 never
 * rewrites a line), only superseded by comparing timestamps.
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
 * TIME IS STATE (orchestrator review, 2026-10-27): an archive hides a
 * Session's card from the board only while NOTHING of that Session
 * happened AFTER it — never permanently. `archivedAt` is this Session's
 * own latest archive ts (`latestArchiveTimestamps`, `undefined` when
 * never archived at all); `lastEventTs` is the Session's own latest
 * Event (`SessionNode.lastEventTs`, the same running max every other
 * time-based check in this project already reads). A resumed Session —
 * a fresh SessionStart or tool call landing AFTER the archive — makes
 * `lastEventTs` newer than `archivedAt`, which is exactly what brings its
 * card back, in whatever column its CURRENT state now puts it: visibility
 * is re-evaluated fresh on every read, the same way `isStalled`/
 * `sessionColumn` already re-evaluate against a ticking clock elsewhere —
 * never a flag written once and trusted forever. Used ONLY by `daemon.ts`'s
 * board payload and `resolve.ts`'s own re-archive check — never by
 * `renderSessionTree` (`tenaza status`), since the spec scopes archiving
 * to "hides that Session from the BOARD," not the CLI.
 */
export function isArchived(archivedAt: string | undefined, lastEventTs: string | undefined): boolean {
  if (archivedAt === undefined) return false;
  return lastEventTs === undefined || lastEventTs <= archivedAt;
}

/**
 * Ticket 14 (AC3): every Session's own "last ordinary activity" signal —
 * each `<session>.touched` file's own mtime (`toolcalls.ts`'s
 * `touchSession`, bumped on every PreToolUse/PostToolUse/Stop call,
 * matched or not — NEVER an Event, so ADR 0002's single-writer log stays
 * exactly the size it was). Scanned fresh on every call, same convention
 * as `latestArchiveTimestamps` above; a file that vanishes between the
 * directory listing and the stat (a race with its own writer, vanishingly
 * rare and harmless either way) is simply absent from this read, never a
 * crash. Used ONLY by `daemon.ts`'s board payload — `buildSessionIndex`
 * itself stays a pure function of `Event[]` and has no reason to know
 * this file exists; `tenaza status`/`statusline` (one-shot CLI reads the
 * human already asked for AT that exact moment) have no need for it
 * either, which is why this stays out of `renderSessionTree`'s own path.
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
      // See the doc comment above.
    }
  }
  return map;
}

/**
 * Ticket 14: is `node` CURRENTLY waiting on a native Claude Code prompt —
 * a permission dialog, or the ~60s idle_prompt — right now? TIME IS
 * STATE, the same way `isStalled`/`liveItemPhase` are elsewhere: neither
 * signal has a documented "resolved" hook event
 * (`docs/research/claude-code-waiting-on-human-hooks.md`), so this is
 * derived fresh from ORDERING, never a stored flag. `node.lastNotification`
 * still names the Session's CURRENT native wait exactly when it is STILL
 * the most recent thing observed for this Session — i.e. `node.lastEventTs`
 * (which the caller MUST have already folded the touched-file merge into,
 * `daemon.ts`'s `buildBoardPayload`) has not moved past it. The moment
 * anything later happens — a fresh prompt, an ordinary tool call's touch,
 * a lifecycle Event, another notification — `lastEventTs` advances past
 * `lastNotification.ts` and this reads `undefined` again, with no second
 * Event ever written for that transition.
 *
 * Known, accepted tie (same shape `log.ts`'s own `appendEventAtLine` doc
 * already accepts for two Events landing in the exact same millisecond):
 * a later Event whose `ts` happens to be BYTE-IDENTICAL to the notification's
 * own never resolves it here (a strict string comparison, not `>=`) — in
 * practice vanishingly rare for real activity, each a separate hook process
 * launch apart in wall-clock time; only ever observed in a synthetic test
 * that appends two Events back to back with no delay between them.
 */
export function nativeWaitFor(node: SessionNode): { kind: NotificationKind; since: string } | undefined {
  const notification = node.lastNotification;
  if (!notification) return undefined;
  if (node.lastEventTs !== notification.ts) return undefined;
  return { kind: notification.kind, since: notification.ts };
}

/** Ticket 05 ("Turn state: working vs waiting"): working, mid-Turn — or waiting for the human, between Turns. See `turnWaitSince`'s own doc for how "waiting" is actually derived. */
export type TurnState = "working" | "waiting";

/**
 * Ticket 05: `node`'s own Stop-derived wait — present exactly when its
 * LATEST Turn ended (`turn.ended`, this Session's own `Stop`) and nothing
 * else has happened since: no fresh `prompt.submitted`, no ordinary
 * tool-call touch, no later native prompt. TIME IS STATE, the exact
 * convention `nativeWaitFor` above already established for the SAME "no
 * second Event for the transition" shape — any later Event (ticket 14's
 * own touched-file merge, `buildBoardPayload`'s doc comment, included)
 * simply moves `lastEventTs` past `lastTurnEnded`, and this reads
 * `undefined` again with nothing else to do.
 *
 * Returns `undefined` — never "waiting" — the instant a MORE SPECIFIC
 * native signal is also current (`nativeWaitFor`): that one carries its
 * own `kind` (a permission prompt vs. the ~60s idle timeout) and renders
 * its own, more specific badge, so a caller never has to choose between
 * the two — this function already resolves that for it, which is what
 * keeps the board from ever showing two waiting badges on one card. Also
 * `undefined` once the Session itself has ended (`endedAt`) — mirrors
 * `nodeCategory`'s own done/ended check, which always outranks any wait,
 * rather than leaving that to Event-ordering alone.
 */
export function turnWaitSince(node: SessionNode): string | undefined {
  if (node.endedAt !== undefined) return undefined;
  if (nativeWaitFor(node) !== undefined) return undefined;
  if (node.lastTurnEnded !== undefined && node.lastTurnEnded === node.lastEventTs) return node.lastTurnEnded;
  return undefined;
}

/**
 * Ticket 05: is `node` mid-Turn ("working") or between Turns ("waiting for
 * the human")? "Waiting" covers BOTH a current native prompt
 * (`nativeWaitFor`) and this Session's own plain Stop-derived wait
 * (`turnWaitSince`) — the two are mutually exclusive by `turnWaitSince`'s
 * own gate above, so this never double-counts them; it only needs to know
 * whether EITHER currently applies.
 */
export function turnState(node: SessionNode): TurnState {
  if (node.endedAt !== undefined) return "working";
  return nativeWaitFor(node) !== undefined || turnWaitSince(node) !== undefined ? "waiting" : "working";
}

/**
 * Ticket 05 (AC3, "background work is not hidden"): how many of `nodeId`'s
 * own descendants — subagents, and THEIR subagents in turn — are not yet
 * ended, i.e. still doing work this Session's own row alone cannot show.
 * The ONLY "background work" Tenaza has any visibility into: a backgrounded
 * shell command (`run_in_background`) fires no hook Tenaza could ever
 * observe finishing, so it is deliberately never counted here — only a
 * real subagent Session (its own `session.started`/`SubagentStart`) is.
 * `childrenOf` is whatever a caller already built (`childrenIndex` for the
 * CLI tree, `daemon.ts`'s own map for the board) — never rebuilt here, so
 * this stays a cheap, pure traversal over structure the caller already has.
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

/** Every distinct Event `type` observed for each Session — what `isNoiseSession` reads, computed once per render. Exported so the Daemon's board payload (ticket 08) can drop the SAME noise rows from `/events`, rather than re-deriving a second copy of this scan. */
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
 * Every Session that names `parent` as its own parent, sorted
 * chronologically — ALWAYS, regardless of project (spec: "a subagent
 * renders once, under its parent, even across projects"). Project is never
 * a reason to split a child from its parent; it only decides which group a
 * Session with NO renderable parent becomes a root of (`groupRootsByProject`
 * below). `nodes` has already dropped noise (`isNoiseSession`), so a child
 * whose parent WAS noise, or was never observed at all, simply finds
 * nothing here and surfaces as its own root there instead.
 *
 * Exported (ticket 05) so `daemon.ts`'s own board payload can build the
 * SAME structural parent→children map once per read and feed it to
 * `countActiveDescendants`, rather than re-deriving a second copy of this.
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
 * Group every Session under its derived project. A Session IS a root of
 * its own project group exactly when it has no RENDERABLE parent — no
 * `parent` at all, or a `parent` id that names no surviving node (never
 * observed, or filtered out as noise). Project is deliberately NOT part of
 * this test (ticket 05 fix — a previous version of this function made a
 * cross-project child a root here too, which rendered it TWICE alongside
 * `childrenIndex` nesting it under its parent; the spec's own line is
 * explicit that a subagent nests under its parent "even across projects",
 * so a known parent always wins). A Session with a renderable parent is
 * never a root here — `childrenIndex` nests it instead.
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

/**
 * The ticket Label when one was announced, else the structural role —
 * "subagente" for any Session with a parent, "sesión" otherwise (ticket 03's
 * own fallback, now filled in by ticket 05: `ticket` is shown opaquely,
 * exactly as announced, never validated or parsed — only `project` is
 * interpreted, per the Label's own definition).
 */
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

/** Spanish for "no data" — reserved for a Session from an Adapter that never declared the `measure` Capability at all (ADR 0001). Distinct from the empty-bar-plus-dash convention `formatContextBar`/`formatContextNumber` already use for "has `measure`, just not sampled yet": that one is honest uncertainty on a Capability that COULD answer; this one is a Capability that structurally never will. */
const NO_MEASURE_CAPABILITY = "sin datos";

/**
 * The tree row's context column: the bar + number pair when this Session's
 * Adapter declared `measure`, or the Capability-gated "no data" text when it
 * didn't — never both, and never inferred from whether a sample happens to
 * exist (a stray `usage.sampled` on a non-measuring Session, e.g. a test
 * fixture, is deliberately ignored: the Capability gates this, not the
 * data). The core degrades by Capability here, never by runtime name (ADR
 * 0001, exercised by ticket 06).
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
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
  lines: string[],
): void {
  const category = rollupCategory(node, childrenOf, waiting);
  const stalled = isStalled(node, now);
  // Ticket 05: this node's OWN Turn state and background count — never
  // rolled up from descendants (unlike `category` above), since each one
  // already renders its own row right below its parent's.
  const turn = turnState(node);
  const activeDescendants = countActiveDescendants(node.id, childrenOf);
  const head = isRoot ? "  " : `${prefix}${isLast ? "└ " : "├ "}`;
  const contextColumn = formatContextColumn(node, thresholdTokens);
  lines.push(
    `${head}${glyphFor(category)} ${roleOf(node)}  ${node.id}  ${contextColumn}  ${categoryWord(category, stalled, turn, activeDescendants)}  ${formatAge(node, now)}`,
  );

  const children = childrenOf.get(node.id) ?? [];
  children.forEach((child, i) => {
    renderNode(
      child,
      childrenOf,
      waiting,
      now,
      thresholdTokens,
      isRoot ? "  " : prefix + (isLast ? "  " : "│ "),
      i === children.length - 1,
      false,
      lines,
    );
  });
}

/**
 * `tenaza status`'s Session tree, grouped per project — the spec's variant
 * D, now WITH the context bar (ticket 04, q9): 15 cells over 300k, a `┊`
 * mark at the Policy's threshold (default 200k), red past it, and the
 * number as `243k` / `⚑243k`. Empty when no Session has ever been observed
 * — or when every observed Session was noise (ticket 05, `isNoiseSession`)
 * — so it adds nothing to a fresh `status` (ticket 01/02's own output stays
 * unchanged).
 */
export function renderSessionTree(home: string = tenazaHome(), now: Date = new Date()): string {
  const events = readAllSessionEvents(home);
  if (events.length === 0) return "";

  const index = buildSessionIndex(events);
  closeDeadProcesses(index, now); // ticket 02, AC1: the SAME rule statusline and the board apply
  closeSilentPidlessSessions(index, now); // ticket 06: the no-pid fallback, same point
  const eventTypes = eventTypesBySession(events);
  const nodes = [...index.values()].filter(
    (node) => !isNoiseSession(eventTypes.get(node.id) ?? new Set(), node.endedReason),
  );
  if (nodes.length === 0) return "";

  // `projectOf` only feeds `groupRootsByProject` now — `childrenIndex`
  // nests purely on `parent`, never on project (ticket 05 fix: a subagent
  // nests under its parent even across projects, per spec).
  const projectOf = new Map(nodes.map((node) => [node.id, deriveProject(node)] as const));
  const childrenOf = childrenIndex(nodes);
  const waiting = new Set(deriveInbox(home).map((row) => row.session));
  const groups = groupRootsByProject(nodes, projectOf);
  const thresholdTokens = loadPolicy(home).thresholdTokens;

  const lines: string[] = [];
  for (const project of [...groups.keys()].sort()) {
    lines.push(project);
    const roots = groups.get(project) ?? [];
    roots.forEach((root, i) =>
      renderNode(root, childrenOf, waiting, now, thresholdTokens, "", i === roots.length - 1, true, lines),
    );
    lines.push("");
  }
  return lines.join("\n");
}
