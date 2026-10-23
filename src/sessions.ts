import type { Capability, Event } from "./contract/event";
import { formatContextBar, formatContextNumber } from "./contextbar";
import { deriveInbox } from "./inbox";
import { readAllSessionEvents } from "./log";
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
    } else if (event.type === "session.ended") {
      node.endedAt = event.ts;
      node.endedReason = event.data.reason;
    } else if (event.type === "session.labeled") {
      Object.assign(node.labels, event.data.labels);
    } else if (event.type === "usage.sampled") {
      // Last write wins, same as endedAt/endedReason above — the file's own
      // chronological order is the only ordering Tenaza trusts (ADR 0002).
      node.contextTokens = event.data.context_tokens;
    }
  }

  return index;
}

/**
 * This Session's OWN category — before any rollup from descendants. An open
 * Inbox item outranks everything else, even a Session that also ended (the
 * ticket's own priority order, applied here too, not just across the tree).
 */
export function nodeCategory(node: SessionNode, waiting: ReadonlySet<string>): SessionCategory {
  if (waiting.has(node.id)) return "waits";
  if (node.endedAt !== undefined) {
    // An ended Session WITH a parent is a subagent finishing its work ("done");
    // an ended Session with no parent is the top-level Session closing ("ended").
    // Derived structurally from `parent`, never from parsing the free-text
    // `reason` — a build-time judgment call (ticket 03), not spec-mandated.
    return node.parent !== undefined ? "done" : "ended";
  }
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

function byStartedThenId(a: SessionNode, b: SessionNode): number {
  return (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.id.localeCompare(b.id);
}

/** Every Session that names `parent` as its own parent, sorted chronologically. */
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
 * Group every Session under its derived project. A Session whose parent
 * lands in the SAME group is never a root there — it nests under that
 * parent in the walk instead. A Session whose parent is absent, unknown, or
 * in a DIFFERENT group becomes a root in its OWN group, so a cross-project
 * subagent is never lost.
 */
function groupRootsByProject(
  nodes: SessionNode[],
  resolveGitRoot?: (cwd: string) => string | undefined,
): Map<string, SessionNode[]> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const projectOf = new Map(nodes.map((n) => [n.id, deriveProject(n, resolveGitRoot)] as const));
  const groups = new Map<string, SessionNode[]>();

  for (const node of nodes) {
    const project = projectOf.get(node.id) ?? UNKNOWN_PROJECT;
    const parent = node.parent !== undefined ? byId.get(node.parent) : undefined;
    const isRoot = parent === undefined || projectOf.get(parent.id) !== project;
    if (!isRoot) continue;

    const roots = groups.get(project) ?? [];
    roots.push(node);
    groups.set(project, roots);
  }

  for (const roots of groups.values()) roots.sort(byStartedThenId);
  return groups;
}

/** "subagente" for any Session with a parent, "sesión" otherwise — structural, nothing guessed. */
export function roleOf(node: SessionNode): string {
  return node.parent !== undefined ? "subagente" : "sesión";
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
  const bar = formatContextBar(node.contextTokens, thresholdTokens);
  const num = formatContextNumber(node.contextTokens, thresholdTokens);
  lines.push(
    `${head}${glyphFor(category)} ${roleOf(node)}  ${node.id}  ${bar} ${num}  ${categoryWord(category, stalled)}  ${formatAge(node, now)}`,
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
 * number as `243k` / `⚑243k`. Empty when no Session has ever been observed,
 * so it adds nothing to a fresh `status` (ticket 01/02's own output stays
 * unchanged).
 */
export function renderSessionTree(home: string = tenazaHome(), now: Date = new Date()): string {
  const events = readAllSessionEvents(home);
  if (events.length === 0) return "";

  const index = buildSessionIndex(events);
  const nodes = [...index.values()];
  const childrenOf = childrenIndex(nodes);
  const waiting = new Set(deriveInbox(home).map((row) => row.session));
  const groups = groupRootsByProject(nodes);
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
