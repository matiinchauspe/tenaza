import { existsSync } from "node:fs";
import { approvalResolvedEvent } from "./contract/event";
import { findInboxRow, isResolved } from "./inbox";
import { appendHumanEvent } from "./log";
import { cwdForSession } from "./sessions";

/** Thrown by every resolution path when the id names no Inbox row at all. */
export class UnknownInboxItemError extends Error {
  constructor(public readonly id: string) {
    super(`unknown inbox item ${id}`);
  }
}

export type ResolutionOutcome = "done" | "dismissed";

export interface ResolveResult {
  /** True when the item was already closed — this call wrote nothing. */
  alreadyResolved: boolean;
}

/**
 * Close an Inbox item by hand — `done` (the human ran it themselves) or
 * `dismissed` (it no longer applies). Idempotent: resolving an
 * already-closed item neither errors nor appends a second Event — the
 * resolution already on file is left exactly as it is. `id` is the item's
 * FULL identity hash (decision 03, ADR 0005) — `cli.ts` resolves whatever
 * prefix the human typed down to this before ever calling here.
 */
export function resolveInboxItem(
  home: string,
  id: string,
  outcome: ResolutionOutcome,
): ResolveResult {
  const row = findInboxRow(home, id);
  if (!row) throw new UnknownInboxItemError(id);

  if (isResolved(home, id)) return { alreadyResolved: true };

  appendHumanEvent(home, approvalResolvedEvent(row.session, id, outcome));
  return { alreadyResolved: false };
}

export type RunOutcome =
  | { kind: "closed" }
  | { kind: "stays-open"; exitCode: number }
  | { kind: "already-resolved" }
  | { kind: "unblockable" }
  | { kind: "not-runnable" }
  | { kind: "no-cwd"; command: string }
  | { kind: "cwd-missing"; cwd: string; command: string };

/**
 * `tenaza run <id>`: execute the Inbox item's stored command AT THE HUMAN'S
 * REQUEST — this is the only path in Tenaza that ever executes a stored
 * command (the ticket's own constraint: `done`/`dismiss` never do). Streams
 * the child's output live (inherited stdio) rather than capturing it, so the
 * human watches it run. Closes the item as `done` on exit 0; on anything
 * else the item stays open and no Event is written, so the human can retry.
 *
 * `row.blocked === false` (ADR 0001, ticket 06) means a Capability-lacking
 * caller could never actually deny this Action — the command already ran
 * ONCE, unblocked. Running it again here would execute it a SECOND time
 * (a merge, a prod write, …), so `run` refuses outright: no spawn, no
 * Event, the item stays open for `done`/`dismiss` to close by hand.
 *
 * An `mcp` item (ticket 04, decision 07) carries no stored shell command at
 * all — it is answered live, or closed by hand (`done`/`dismiss`), never
 * executed from here. `run` refuses it the SAME way: a clean outcome the
 * CLI reports, never a thrown error.
 *
 * Runs in the REQUESTING Session's OWN `cwd` (ticket 06), read from that
 * Session's own `session.started` — fixing v0.1's `Bun.spawn` with no
 * `cwd` at all, which ran in whatever directory the human happened to be
 * in when they typed `tenaza run`. Two ways that can fail to resolve, and
 * EITHER refuses outright rather than silently running somewhere else
 * (the ticket's own warning): the Session never started at all
 * (`"no-cwd"`), or its directory no longer exists on disk — a worktree
 * already removed, say (`"cwd-missing"`). Both leave the item open and
 * write no Event, exactly like `"stays-open"`, so the human can still
 * close it by hand or run the command themselves.
 */
export async function runInboxItem(home: string, id: string): Promise<RunOutcome> {
  const row = findInboxRow(home, id);
  if (!row) throw new UnknownInboxItemError(id);

  if (isResolved(home, id)) return { kind: "already-resolved" };

  if (!row.blocked) return { kind: "unblockable" };

  if (row.action.kind !== "shell") return { kind: "not-runnable" };
  const command = row.action.command;

  const cwd = cwdForSession(row.session, home);
  if (cwd === undefined) return { kind: "no-cwd", command };
  if (!existsSync(cwd)) return { kind: "cwd-missing", cwd, command };

  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) return { kind: "stays-open", exitCode };

  appendHumanEvent(home, approvalResolvedEvent(row.session, id, "done"));
  return { kind: "closed" };
}
