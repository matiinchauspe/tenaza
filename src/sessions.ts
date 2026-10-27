import type { Action, Capability, Event, TerminalLocator } from "./contract/event";
import { formatContextBar, formatContextNumber } from "./contextbar";
import { deriveInbox } from "./inbox";
import { readAllSessionEvents, readHumanEvents, readSessionEvents } from "./log";
import { tenazaHome } from "./paths";
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
  /** Ticket 11 (decision 09): the terminal locator its OWN `session.started` carried, when its Adapter captured one — never set on a subagent (`adapters/claude.ts`'s `handleSubagentStart` never calls the capture), which is exactly why "a subagent's card focuses its PARENT's terminal" is a RESOLUTION-time rule (`daemon.ts`'s focus route walks to `node.parent`) rather than something copied onto every node here. */
  terminalLocator?: TerminalLocator;
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

export function glyphFor(category: SessionCategory): string {
  return GLYPH[category];
}

/** Stalled only ever overrides the "alive" word — a waiting/done/ended Session already reads unambiguously. */
export function categoryWord(category: SessionCategory, stalled: boolean): string {
  return category === "alive" && stalled ? STALLED_WORD : WORD[category];
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
 */
function childrenIndex(nodes: SessionNode[]): Map<string, SessionNode[]> {
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
  const head = isRoot ? "  " : `${prefix}${isLast ? "└ " : "├ "}`;
  const contextColumn = formatContextColumn(node, thresholdTokens);
  lines.push(
    `${head}${glyphFor(category)} ${roleOf(node)}  ${node.id}  ${contextColumn}  ${categoryWord(category, stalled)}  ${formatAge(node, now)}`,
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
