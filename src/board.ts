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
