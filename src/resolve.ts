import { approvalResolvedEvent } from "./contract/event";
import { findInboxRow, isResolved } from "./inbox";
import { appendHumanEvent } from "./log";

/** Thrown by every resolution path when the id names no Inbox row at all. */
export class UnknownInboxItemError extends Error {
  constructor(public readonly id: number) {
    super(`unknown inbox item #${id}`);
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
 * resolution already on file is left exactly as it is.
 */
export function resolveInboxItem(
  home: string,
  id: number,
  outcome: ResolutionOutcome,
): ResolveResult {
  const row = findInboxRow(home, id);
  if (!row) throw new UnknownInboxItemError(id);

  if (isResolved(home, id)) return { alreadyResolved: true };

  appendHumanEvent(home, approvalResolvedEvent(row.session, String(id), outcome));
  return { alreadyResolved: false };
}

export type RunOutcome =
  | { kind: "closed" }
  | { kind: "stays-open"; exitCode: number }
  | { kind: "already-resolved" }
  | { kind: "unblockable" }
  | { kind: "not-runnable" };

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
 * CLI reports, never a thrown error — this is an ordinary, expected
 * outcome of asking `run` for the wrong kind of item, not a programming
 * fault.
 */
export async function runInboxItem(home: string, id: number): Promise<RunOutcome> {
  const row = findInboxRow(home, id);
  if (!row) throw new UnknownInboxItemError(id);

  if (isResolved(home, id)) return { kind: "already-resolved" };

  if (!row.blocked) return { kind: "unblockable" };

  if (row.action.kind !== "shell") return { kind: "not-runnable" };

  const proc = Bun.spawn(["sh", "-c", row.action.command], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) return { kind: "stays-open", exitCode };

  appendHumanEvent(home, approvalResolvedEvent(row.session, String(id), "done"));
  return { kind: "closed" };
}
