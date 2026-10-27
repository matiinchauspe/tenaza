/**
 * The Live surface's own domain logic (ticket 08, decision 04): which
 * column a Session belongs in, whether it's stalled, how its age reads,
 * and the pure list math the board's keyboard selection moves over. Zero
 * imports, on purpose — same reasoning as `contextbar.ts`: the React client
 * bundles this file directly, so it must never pull in a node builtin
 * transitively.
 *
 * TIME IS STATE: every function here that classifies anything time-based
 * takes `now` as a plain argument and does nothing with `Date.now()`
 * internally — the caller (the board's `useNow` hook, ticking every
 * 15-30s) is what actually re-evaluates these on a clock, including for a
 * Session that stopped producing Events entirely (which otherwise would
 * never re-push over SSE, and would freeze — frozen "CORRIENDO" forever,
 * or a TERMINÓ card that never ages out of the 24h window).
 *
 * `stallMinutes` is never defaulted here. It always comes from the ONE
 * place the Policy is read (`policy.ts`'s `DEFAULT_STALL_MINUTES`, carried
 * in the SSE payload as `LivePolicy.stallMinutes`) — a default here would
 * be a second copy of that number the client and the Daemon could drift
 * apart on, exactly what the ticket's "never hardcoded in the client"
 * rules out.
 */

/** TERMINÓ shows a Session ended within this window (spec: "the last 24 h") — not configurable, unlike `stallMinutes`. */
export const TERMINO_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SessionColumn = "corriendo" | "trabada" | "termino";

/** The subset of `BoardSession` the time-based functions below actually read — named independently of the contract type so this file stays import-free. */
export interface SessionTiming {
  endedAt?: string;
  lastEventTs?: string;
}

/** A Session with no Event at all (`lastEventTs` absent) is never stalled — there is nothing to measure silence against yet (mirrors `sessions.ts`'s own `isStalled`). */
export function isSessionStalled(session: SessionTiming, now: Date, stallMinutes: number): boolean {
  if (!session.lastEventTs) return false;
  const thresholdMs = stallMinutes * 60 * 1000;
  return now.getTime() - new Date(session.lastEventTs).getTime() > thresholdMs;
}

/**
 * Which board column a Session belongs in RIGHT NOW, or `undefined` when it
 * belongs in none (an ended Session past the 24h TERMINÓ window — the
 * board simply drops its card, per spec). A Session's own column, never a
 * rollup from descendants (unlike `sessions.ts`'s tree-view
 * `rollupCategory`): the board shows every Session, main and subagent
 * alike, as its own independent card (spec's user story 9), so there is no
 * parent to roll up into — `parentId` is shown on the card for context
 * only (the "↳ parent" label).
 */
export function sessionColumn(session: SessionTiming, now: Date, stallMinutes: number): SessionColumn | undefined {
  if (session.endedAt !== undefined) {
    const endedAgoMs = now.getTime() - new Date(session.endedAt).getTime();
    return endedAgoMs <= TERMINO_WINDOW_MS ? "termino" : undefined;
  }
  return isSessionStalled(session, now, stallMinutes) ? "trabada" : "corriendo";
}

/**
 * `Ns` / `Nm` / `Nh` / `Nd` since `ts` — the same convention
 * `sessions.ts`'s `formatAge` already uses for the CLI tree, reimplemented
 * here against a bare ISO string (rather than a `SessionNode`) so it also
 * reads an Inbox row's own `ts` with no second formatter. `undefined`
 * (never observed) reads as "—", same as a Session with no sample yet.
 */
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
 * A board card's displayed project NAME (human fix round, ticket 08):
 * `deriveProject` (`sessions.ts`) returns a `project` Label verbatim, or —
 * absent one — a git root's ABSOLUTE PATH (`/Users/.../oarfish`), which
 * reads fine in the CLI's own grouped tree but has no room on a dense board
 * card (the human's own rejection: "the project shows the full cwd path
 * instead of the project name"). The spec names no formatting rule for this
 * — decision left to the code, reported.
 *
 * Mirrors how Yunque itself lays out a worktree, this project's own
 * CLAUDE.md: `.worktrees/<repo>/<task...>/` — the segment right after
 * `.worktrees` (or `worktrees`) is the REPO, never the leaf task/branch
 * directory under it, which is what a bare basename would return instead.
 * Anything else — a plain git root, an arbitrary cwd — uses the path's own
 * basename, same as `reservee`/`rudy` in the prototype (decision 04).
 *
 * A value with no path separator at all (a `project` Label like
 * "reservee", or the `UNKNOWN_PROJECT` bucket "(sin proyecto)") passes
 * through unchanged — `deriveProject` already resolved it to exactly the
 * string a human announced (or the one fixed bucket), which this must
 * never rewrite.
 */
export function projectLabel(project: string): string {
  if (!project.includes("/")) return project;
  const segments = project.split("/").filter((segment) => segment.length > 0);
  const layout = worktreeLayout(segments);
  if (layout) return layout.repo;
  return segments[segments.length - 1] ?? project;
}

/**
 * The worktree a card's Session runs in, when its path follows a known
 * worktree layout — shown as a secondary detail so two Sessions on one
 * repo stay distinguishable. `undefined` for a plain git root, a Label, or
 * an unrecognized path: there the project name already says it all.
 */
export function worktreeLabel(project: string): string | undefined {
  if (!project.includes("/")) return undefined;
  const segments = project.split("/").filter((segment) => segment.length > 0);
  return worktreeLayout(segments)?.worktree;
}

/**
 * The two worktree layouts the human works in (the human's report,
 * 2026-10-27: this very Session showed as "oarfish", the name Orca gave its
 * worktree, instead of its repo):
 *   - Yunque: `.worktrees/<repo>/<task...>` — the repo right after
 *     `.worktrees` (or `worktrees`); the leaf directory is the worktree.
 *   - Orca: `orca/workspaces/<repo>/<worktree>` — the repo right after
 *     `workspaces`; the next segment is Orca's own name for the worktree.
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
 * Ticket 10: a "held" Inbox row's own `action.decided` line NEVER changes
 * once written (ADR 0005's identity line is permanent) — whether it still
 * reads as live (the hook is still polling, holding the agent's call) or
 * has lapsed to pending (the window passed) is derived fresh against the
 * clock every time, exactly like `sessionColumn`'s own stall
 * classification. `waitSeconds` is the EFFECTIVE (already-capped) window —
 * `LivePolicy.waitSeconds` on the wire, never a raw, unconfigured default.
 */
export type LiveItemPhase = "live" | "pending";

export function liveItemPhase(heldAt: string, now: Date, waitSeconds: number): LiveItemPhase {
  const elapsedMs = now.getTime() - new Date(heldAt).getTime();
  return elapsedMs <= waitSeconds * 1000 ? "live" : "pending";
}

/** The draining wait bar's own fill fraction (1 = just born live, 0 = about to lapse), clamped to `[0, 1]` — a `waitSeconds` of 0 (a degenerate test Policy) never divides by zero. */
export function liveWaitRemainingFraction(heldAt: string, now: Date, waitSeconds: number): number {
  const totalMs = waitSeconds * 1000;
  if (totalMs <= 0) return 0;
  const elapsedMs = now.getTime() - new Date(heldAt).getTime();
  return Math.max(0, Math.min(1, 1 - elapsedMs / totalMs));
}

/**
 * The board's keyboard selection, as pure list math (`useBoardKeyboard`
 * wraps this in a hook): given the CURRENT flattened order of visible card
 * ids, move one step from `currentId`. Keyed by id, never by a stored
 * index — so a list that changed shape under the selection (a card
 * resolved, a new one arrived) never has to be reconciled against a stale
 * position: `ids.indexOf(currentId)` just re-resolves it fresh every call.
 * No selection yet, or a selection that fell off the list (`indexOf` ===
 * -1): lands on the first id moving down, the last moving up — never
 * `undefined` while the list is non-empty. An empty list has nothing to
 * select. Clamped, never wraps, at either end.
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
// Activity panel (ticket 12, spec "Activity panel (l)") — resolutions and
// session-column transitions "the SSE stream already carries," derived
// client-side by diffing one tick's board state against the last one this
// file itself remembered, never a new server field and never persisted
// past this render (spec: "derived from the stream, never stored").
// ---------------------------------------------------------------------------

export interface ActivityFeedEntry {
  /** A unique key for this ENTRY (react's own list key) — never a domain id by itself, since one resolution or one session can legitimately produce several entries over a run. */
  id: string;
  /** When this was OBSERVED (a resolution's own `ts` when one exists; `now` for a transition, which carries no timestamp of its own). */
  ts: string;
  text: string;
}

/** The subset of a Session's resolution trace this diff actually reads — named independently of `contract/live.ts`'s own `ResolutionTraceEntry`, same convention `SessionTiming` above already follows, so this file stays import-free. */
export interface ActivityResolution {
  id: string;
  kind: "ran" | "done" | "dismissed" | "failed" | "approved" | "rejected";
  ts: string;
}

/** The subset of a Session this diff reads — `SessionTiming`'s own two fields (for the column classification) plus what a feed LINE needs to read (its label) and what its resolutions the diff watches for new ones. */
export interface ActivitySession extends SessionTiming {
  id: string;
  project: string;
  ticket?: string;
  /** Newest first, same convention the contract's own `resolutions` field already carries — only `[0]` (the latest) is ever compared. */
  resolutions: readonly ActivityResolution[];
}

/** What this diff remembers about ONE Session between ticks — just enough to tell "did its column change" and "is there a resolution here it hasn't already reported." */
export interface ActivitySnapshot {
  column: SessionColumn | undefined;
  latestResolutionId: string | undefined;
}

export type ActivitySnapshots = ReadonlyMap<string, ActivitySnapshot>;

/** The feed's own short verbs (spec, parenthetical list) — DELIBERATELY not `viewModel.ts`'s own `traceInfo` wording ("corrido por vos," "cerrado como listo"): that is a CARD's memory of its own latest request, read in context; this is a compact, cross-session timeline where a terser verb reads better one line at a time. */
const RESOLUTION_FEED_VERB: Record<ActivityResolution["kind"], string> = {
  ran: "corrido",
  done: "listo",
  dismissed: "descartado",
  failed: "falló",
  approved: "aprobado",
  rejected: "rechazado",
};

/** A Session's own short label for a feed line — its `ticket` Label when it announced one, else its project name (never its bare id, which says nothing at a glance). */
function activitySessionLabel(session: ActivitySession): string {
  return session.ticket ?? session.project;
}

/**
 * The feed's own wording for a column change (no literal spec text given —
 * this run's own call, reported): "se trabó" entering TRABADA, "terminó"
 * entering TERMINÓ, "volvió a correr" entering CORRIENDO — never "arrancó"
 * for that last one, since a transition only ever fires for a Session this
 * diff has ALREADY seen in some other column before (a brand-new Session's
 * first sighting is seeded silently, below, never reported as a
 * transition) — reaching CORRIENDO again always means it came FROM
 * somewhere else (TRABADA, or a resume after TERMINÓ), never a first
 * start.
 */
function activityTransitionText(column: SessionColumn): string {
  if (column === "trabada") return "se trabó";
  if (column === "termino") return "terminó";
  return "volvió a correr";
}

/**
 * One tick of the activity feed's own diff (`useActivityFeed.ts` calls this
 * on every viewModel recompute — a fresh SSE payload AND the ticking clock
 * alike, since a column change like TRABADA is itself time-driven with no
 * new bytes over the wire, same "TIME IS STATE" every other classifier in
 * this file already follows). Compares `sessions` (this tick's own,
 * classified against `now`) to `previous` (what the LAST call to this
 * function left behind) and returns both what's NEW this tick and the
 * updated snapshot to diff against next time.
 *
 * A Session seen for the FIRST time (no entry in `previous` at all) is
 * seeded into `next` silently — never a synthetic "transition," which
 * would flood the panel with every already-running Session the instant
 * the board first connects. A Session that VANISHES from `sessions`
 * entirely while its last known column was TERMINÓ reads as archived
 * (ticket 11's own archive route is the only thing that removes a TERMINÓ
 * card outright) — the one entry this diff can never read off a
 * `resolutions` array, since archiving a Session is not itself the
 * resolution of any request it raised.
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

/** "the latest ~12 board events" (spec) — the activity panel's own cap, applied by `useActivityFeed.ts` after prepending each tick's `additions`. */
export const ACTIVITY_FEED_CAPACITY = 12;
