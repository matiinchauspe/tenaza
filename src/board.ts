/**
 * Zero imports of its own except `sessionstate.ts` (also zero-import): the
 * React client bundles this file directly, so it must never pull in a node
 * builtin transitively.
 *
 * TIME IS STATE: every function here that classifies anything time-based
 * takes `now` as a plain argument rather than reading `Date.now()`
 * internally — the caller's own ticking clock re-evaluates these, including
 * for a session that stopped producing events entirely. Without that, a
 * frozen state would never clear and a TERMINÓ card would never age out of
 * its 24h window.
 *
 * `stallMinutes` is never defaulted here — it always comes from the one
 * place the Policy is read, so the client and the Daemon can't drift on
 * the number.
 */

import { sessionState } from "./sessionstate";

/** Not configurable, unlike `stallMinutes` — this window is fixed. */
export const TERMINO_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SessionColumn = "corriendo" | "trabada" | "termino";

/** Subset of `BoardSession` these functions read — named independently so this file stays import-free. */
export interface SessionTiming {
  endedAt?: string;
  lastEventTs?: string;
  /**
   * Present while a current wait applies — `turnWait` for a Stop-derived
   * wait, `nativeWait` for a native prompt. Only PRESENCE matters to
   * `sessionColumn` below; the richer shape is `viewModel.ts`'s own badge
   * to resolve, which is why these stay `unknown` rather than importing
   * their real types and breaking "zero imports."
   */
  turnWait?: unknown;
  nativeWait?: unknown;
}

/**
 * `undefined` when the session belongs in no column — an ended session
 * past the 24h TERMINÓ window, whose card the board just drops. A
 * session's own column, never a rollup from descendants (unlike
 * `sessions.ts`'s tree-view `rollupCategory`): the board shows every
 * session, main and subagent alike, as its own independent card, so there
 * is no parent to roll up into.
 *
 * The ended/waiting/stalled/working ladder is `sessionstate.ts`'s
 * `sessionState` — the same function `sessions.ts` calls for the CLI
 * tree. This function only assigns the board LABEL for each state:
 * CORRIENDO covers both waiting and working (the board has no separate
 * waiting column; a card's own badge renders the distinction on top), and
 * decides the 24h TERMINÓ window, which `sessionstate.ts` doesn't own.
 */
export function sessionColumn(session: SessionTiming, now: Date, stallMinutes: number): SessionColumn | undefined {
  const state = sessionState(
    {
      ended: session.endedAt !== undefined,
      waitingForHuman: session.turnWait !== undefined || session.nativeWait !== undefined,
      lastEventTs: session.lastEventTs,
    },
    now,
    stallMinutes * 60 * 1000,
  );
  if (state === "ended" && session.endedAt !== undefined) {
    const endedAgoMs = now.getTime() - new Date(session.endedAt).getTime();
    return endedAgoMs <= TERMINO_WINDOW_MS ? "termino" : undefined;
  }
  return state === "stalled" ? "trabada" : "corriendo";
}

/** `Ns`/`Nm`/`Nh`/`Nd` since `ts`, or `—` if absent. Reimplemented against a bare ISO string, not a `SessionNode` — `sessions.ts` has its own `formatAge` for the CLI tree, but this one also needs to read an Inbox row's `ts` with no second formatter. */
export function formatAge(ts: string | undefined, now: Date): string {
  if (!ts) return "—";
  const ms = Math.max(0, now.getTime() - new Date(ts).getTime());
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * The project name shown on a card. `deriveProject` (`sessions.ts`)
 * returns either a `project` Label verbatim, or — absent one — a git
 * root's absolute path, which has no room on a dense card. A path under a
 * known worktree layout (see `worktreeLayout` below) shortens to its repo
 * name; anything else falls back to the path's own basename. A value with
 * no path separator at all passes through unchanged.
 */
export function projectLabel(project: string): string {
  if (!project.includes("/")) return project;
  const segments = project.split("/").filter((segment) => segment.length > 0);
  const layout = worktreeLayout(segments);
  if (layout) return layout.repo;
  return segments[segments.length - 1] ?? project;
}

/** The worktree a card's session runs in, shown as a secondary detail so two sessions on one repo stay distinguishable. `undefined` for a plain git root, a Label, or an unrecognized path. */
export function worktreeLabel(project: string): string | undefined {
  if (!project.includes("/")) return undefined;
  const segments = project.split("/").filter((segment) => segment.length > 0);
  return worktreeLayout(segments)?.worktree;
}

/**
 * The two worktree layouts recognized:
 *   - Yunque: `.worktrees/<repo>/<task...>` — repo right after
 *     `.worktrees`/`worktrees`; the leaf directory is the worktree.
 *   - Orca: `orca/workspaces/<repo>/<worktree>` — repo right after
 *     `workspaces`; the next segment is Orca's name for the worktree.
 */
function worktreeLayout(segments: readonly string[]): { repo: string; worktree: string | undefined } | undefined {
  const worktreesAt = segments.findIndex((segment) => segment === ".worktrees" || segment === "worktrees");
  if (worktreesAt !== -1 && segments.length > worktreesAt + 1) {
    const worktree = segments.length > worktreesAt + 2 ? segments[segments.length - 1] : undefined;
    return { repo: segments[worktreesAt + 1] as string, worktree };
  }
  const orcaAt = segments.findIndex((segment, i) => segment === "orca" && segments[i + 1] === "workspaces");
  if (orcaAt !== -1 && segments.length > orcaAt + 2) {
    return { repo: segments[orcaAt + 2] as string, worktree: segments[orcaAt + 3] };
  }
  return undefined;
}

/**
 * Whether a "held" row still reads as live or has lapsed to pending is
 * derived fresh against the clock every time, never stored. `waitSeconds`
 * is the EFFECTIVE, already-capped window — never a raw, unconfigured
 * default.
 */
export type LiveItemPhase = "live" | "pending";

export function liveItemPhase(heldAt: string, now: Date, waitSeconds: number): LiveItemPhase {
  const elapsedMs = now.getTime() - new Date(heldAt).getTime();
  return elapsedMs <= waitSeconds * 1000 ? "live" : "pending";
}

/** Fill fraction for the draining wait bar (1 = just went live, 0 = about to lapse), clamped to [0,1] — a `waitSeconds` of 0 never divides by zero. */
export function liveWaitRemainingFraction(heldAt: string, now: Date, waitSeconds: number): number {
  const totalMs = waitSeconds * 1000;
  if (totalMs <= 0) return 0;
  const elapsedMs = now.getTime() - new Date(heldAt).getTime();
  return Math.max(0, Math.min(1, 1 - elapsedMs / totalMs));
}

/**
 * Keyboard selection as pure list math. Keyed by id, never a stored index
 * — `ids.indexOf(currentId)` re-resolves fresh every call, so a list that
 * changed shape under the selection (a card resolved, a new one arrived)
 * never needs reconciling against a stale position. No selection, or one
 * that fell off the list, lands on the first id moving down, the last
 * moving up. Clamped, never wraps.
 */
export function moveSelection(
  ids: readonly string[],
  currentId: string | undefined,
  direction: 1 | -1,
): string | undefined {
  if (ids.length === 0) return undefined;
  const currentIndex = currentId !== undefined ? ids.indexOf(currentId) : -1;
  if (currentIndex === -1) return direction === 1 ? ids[0] : ids[ids.length - 1];
  const nextIndex = Math.min(Math.max(currentIndex + direction, 0), ids.length - 1);
  return ids[nextIndex];
}

// ---------------------------------------------------------------------------
// Activity panel: resolutions and column transitions, derived client-side
// by diffing this tick's board state against what this file remembered
// last tick — never a new server field, never persisted past render.
// ---------------------------------------------------------------------------

export interface ActivityFeedEntry {
  /** React list key — never a domain id by itself, since one session or resolution can produce several entries over a run. */
  id: string;
  /** When this was observed — a resolution's own `ts` when one exists, else `now` for a transition. */
  ts: string;
  text: string;
}

/** Subset of a session's resolution trace this diff reads — named independently of `contract/live.ts`'s `ResolutionTraceEntry` so this file stays import-free. */
export interface ActivityResolution {
  id: string;
  kind: "ran" | "done" | "dismissed" | "failed" | "approved" | "rejected";
  ts: string;
}

/** Subset of a session this diff reads: `SessionTiming`'s fields (the caller must carry `turnWait`/`nativeWait` through, or this can never tell a waiting session from a stalled one), plus a label and its resolutions. */
export interface ActivitySession extends SessionTiming {
  id: string;
  project: string;
  ticket?: string;
  /** Newest first — only `[0]` (the latest) is ever compared. */
  resolutions: readonly ActivityResolution[];
}

/** What this diff remembers about one session between ticks: enough to tell whether its column changed or there's an unreported resolution. */
export interface ActivitySnapshot {
  column: SessionColumn | undefined;
  latestResolutionId: string | undefined;
}

export type ActivitySnapshots = ReadonlyMap<string, ActivitySnapshot>;

/** Deliberately different wording from `viewModel.ts`'s `traceInfo` ("corrido por vos," etc.): that's a card's memory of its own latest request, read in context; this is a compact cross-session timeline where a terser verb reads better. */
const RESOLUTION_FEED_VERB: Record<ActivityResolution["kind"], string> = {
  ran: "corrido",
  done: "listo",
  dismissed: "descartado",
  failed: "falló",
  approved: "aprobado",
  rejected: "rechazado",
};

/** Short label for a feed line: the session's `ticket` Label when announced, else its project name — never its bare id, which says nothing at a glance. */
function activitySessionLabel(session: ActivitySession): string {
  return session.ticket ?? session.project;
}

/**
 * Never "arrancó" for the CORRIENDO case: a transition only fires for a
 * session this diff has already seen in another column before (a
 * brand-new session's first sighting is seeded silently, never reported),
 * so reaching CORRIENDO again always means it came FROM somewhere else.
 */
function activityTransitionText(column: SessionColumn): string {
  if (column === "trabada") return "se trabó";
  if (column === "termino") return "terminó";
  return "volvió a correr";
}

/**
 * Runs on every viewModel recompute — a fresh SSE payload and the ticking
 * clock alike, since a column change like TRABADA is itself time-driven
 * with no new bytes over the wire. Compares this tick's `sessions` to
 * `previous` and returns what's new plus the updated snapshot.
 *
 * A session seen for the first time is seeded into `next` silently, never
 * reported as a transition — that would flood the panel with every
 * already-running session the instant the board connects. A session that
 * vanishes while its last known column was TERMINÓ reads as archived: the
 * one case this diff can't read off `resolutions`, since archiving isn't
 * itself the resolution of any request it raised.
 */
export function diffActivityFeed(
  sessions: readonly ActivitySession[],
  previous: ActivitySnapshots,
  now: Date,
  stallMinutes: number,
): { additions: ActivityFeedEntry[]; next: ActivitySnapshots } {
  const next = new Map<string, ActivitySnapshot>();
  const additions: ActivityFeedEntry[] = [];
  let seq = 0;
  const nextEntryId = (prefix: string): string => `${prefix}-${now.getTime()}-${seq++}`;

  for (const session of sessions) {
    const column = sessionColumn(session, now, stallMinutes);
    const prevSnapshot = previous.get(session.id);
    const latest = session.resolutions[0];

    if (prevSnapshot) {
      if (column !== undefined && prevSnapshot.column !== column) {
        additions.push({
          id: nextEntryId(`t-${session.id}`),
          ts: now.toISOString(),
          text: `${activitySessionLabel(session)} ${activityTransitionText(column)}`,
        });
      }
      if (latest && latest.id !== prevSnapshot.latestResolutionId) {
        additions.push({
          id: `r-${latest.id}`,
          ts: latest.ts,
          text: `#${latest.id.slice(0, 4)} ${RESOLUTION_FEED_VERB[latest.kind]}`,
        });
      }
    }

    next.set(session.id, { column, latestResolutionId: latest?.id });
  }

  for (const [id, prevSnapshot] of previous) {
    if (!next.has(id) && prevSnapshot.column === "termino") {
      additions.push({ id: nextEntryId(`a-${id}`), ts: now.toISOString(), text: `#${id.slice(0, 4)} archivado` });
    }
  }

  return { additions, next };
}

/** Cap on the activity panel, applied by `useActivityFeed.ts` after prepending each tick's `additions`. */
export const ACTIVITY_FEED_CAPACITY = 12;
