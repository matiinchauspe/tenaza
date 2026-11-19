import { existsSync } from "node:fs";
import { liveItemPhase } from "./board";
import { approvalResolvedEvent, liveAnsweredEvent, runFailedEvent, sessionArchivedEvent } from "./contract/event";
import { findInboxRow, isResolved, type InboxRow } from "./inbox";
import { LIVE_ANSWER_CUTOFF_MS } from "./live";
import { appendHumanEvent, readSessionEvents } from "./log";
import { effectiveWaitSeconds, loadPolicy } from "./policy";
import { runFailureTrailer } from "./runoutput";
import {
  closedOutSessionIndex,
  cwdForSession,
  isArchived,
  latestArchiveTimestamps,
  readSessionTouchedTimestamp,
  UnknownSessionError,
} from "./sessions";

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
 * Close an Inbox item by hand — `done` or `dismissed`. Idempotent:
 * resolving an already-closed item neither errors nor appends a second
 * Event. `id` is the item's full identity hash — `cli.ts` resolves
 * whatever prefix the human typed down to this first.
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

/**
 * Every reason `run` refuses outright — no spawn, no Event — shared by
 * the CLI's own spawn and the view's streaming route, so the two paths
 * can never drift on whether an item may run, only on how it executes.
 */
export type RunRefusal =
  | { kind: "already-resolved" }
  | { kind: "unblockable" }
  | { kind: "not-runnable" }
  | { kind: "no-cwd"; command: string }
  | { kind: "cwd-missing"; cwd: string; command: string };

export type RunOutcome = RunRefusal | { kind: "closed" } | { kind: "stays-open"; exitCode: number };

/** One Inbox item cleared to actually run: its row (for the Event this write eventually appends), the stored command, and the cwd it must run in. */
interface RunTarget {
  row: InboxRow;
  command: string;
  cwd: string;
}

export function isRunRefusal(result: RunTarget | RunRefusal): result is RunRefusal {
  return !("row" in result);
}

/**
 * The validation every `run` call must pass before anything is spawned.
 *
 * `row.blocked === false` means a Capability-lacking caller could never
 * deny this Action — it already ran once, unblocked. Running it again
 * would execute it a second time (a merge, a prod write, …), so `run`
 * refuses outright, leaving the item open for `done`/`dismiss`. An `mcp`
 * item carries no stored command at all and refuses the same way — a
 * clean outcome, never a thrown error.
 *
 * `cwd` is the requesting Session's own directory, read from its
 * `session.started` — never wherever the human happens to be standing
 * when they type `tenaza run`. Either it never started (`"no-cwd"`) or
 * its directory is gone (`"cwd-missing"`), and both refuse outright
 * rather than silently running somewhere else.
 */
function resolveRunTarget(home: string, id: string): RunTarget | RunRefusal {
  const row = findInboxRow(home, id);
  if (!row) throw new UnknownInboxItemError(id);

  if (isResolved(home, id)) return { kind: "already-resolved" };
  if (!row.blocked) return { kind: "unblockable" };
  if (row.action.kind !== "shell") return { kind: "not-runnable" };
  const command = row.action.command;

  const cwd = cwdForSession(row.session, home);
  if (cwd === undefined) return { kind: "no-cwd", command };
  if (!existsSync(cwd)) return { kind: "cwd-missing", cwd, command };

  return { row, command, cwd };
}

/**
 * `tenaza run <id>`: execute the item's stored command at the human's
 * request, streaming output live (inherited stdio) into their terminal.
 * Closes the item as `done` on exit 0; on anything else it stays open,
 * no Event written, so the human can retry.
 *
 * Spawns through a plain non-login `sh -c` — the human's own shell is
 * already interactive with a full PATH, unlike the view's spawn below,
 * which runs under launchd's minimal one.
 */
export async function runInboxItem(home: string, id: string): Promise<RunOutcome> {
  const target = resolveRunTarget(home, id);
  if (isRunRefusal(target)) return target;
  const { row, command, cwd } = target;

  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    // A non-resolving Event, purely so the resolution trace can show
    // "falló (código N)".
    appendHumanEvent(home, runFailedEvent(row.session, id, exitCode));
    return { kind: "stays-open", exitCode };
  }

  appendHumanEvent(home, approvalResolvedEvent(row.session, id, "done", "run"));
  return { kind: "closed" };
}

/** What `startInboxItemRunStream` hands back: the same refusal `runInboxItem` would (no spawn at all), or a live stream of the command's combined output. */
export type RunStreamStart =
  | RunRefusal
  /** Fit to run, but spawning the shell itself threw — the local machine couldn't start a process (e.g. a `TENAZA_RUN_SHELL` naming a binary that doesn't exist), not a `RunRefusal`. `message` is the raw spawn error. */
  | { kind: "spawn-failed"; message: string }
  | { kind: "stream"; stream: ReadableStream<Uint8Array> };

function describeSpawnError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * launchd gives a minimal PATH, so the view's own `run` needs a login
 * shell to pick one up. `TENAZA_RUN_SHELL` is a test seam only, pinning a
 * fast profile-free shell instead of paying for the developer's own
 * `$SHELL` startup files.
 */
function loginShellPath(): string {
  return process.env.TENAZA_RUN_SHELL ?? process.env.SHELL ?? "/bin/zsh";
}

/** Pipes one readable stream's bytes into `controller`, in order. Stdout and stderr pump concurrently — Tenaza never buffers a whole run before showing it in the card. */
async function pumpInto(
  readable: ReadableStream<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  const reader = readable.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    controller.enqueue(value);
  }
}

/**
 * The view's own `run`: shares `resolveRunTarget`'s validation, but spawns
 * through the user's login shell into a `ReadableStream` rather than
 * inheriting stdio — there's no terminal to inherit into from inside the
 * Daemon.
 *
 * On a non-zero exit, the stream's last bytes are a short es-AR trailer
 * naming the exit code (`runFailureTrailer`): a command like `false`
 * prints nothing of its own, so without this the card would show empty
 * output and read as a silent no-op rather than a failure.
 *
 * `Bun.spawn` is wrapped in its own try/catch: a missing shell throws
 * synchronously, before any stream exists — left uncaught, that would
 * surface as an unexplained 500. Caught here as `"spawn-failed"` instead.
 */
function spawnRunShell(cwd: string, command: string) {
  return Bun.spawn([loginShellPath(), "-lc", command], { cwd, stdout: "pipe", stderr: "pipe" });
}

export function startInboxItemRunStream(home: string, id: string): RunStreamStart {
  const target = resolveRunTarget(home, id);
  if (isRunRefusal(target)) return target;
  const { row, command, cwd } = target;

  let proc: ReturnType<typeof spawnRunShell>;
  try {
    proc = spawnRunShell(cwd, command);
  } catch (error) {
    return { kind: "spawn-failed", message: describeSpawnError(error) };
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await Promise.all([pumpInto(proc.stdout, controller), pumpInto(proc.stderr, controller)]);
      } finally {
        const exitCode = await proc.exited;
        if (exitCode === 0) {
          appendHumanEvent(home, approvalResolvedEvent(row.session, id, "done", "run"));
        } else {
          appendHumanEvent(home, runFailedEvent(row.session, id, exitCode));
          controller.enqueue(new TextEncoder().encode(runFailureTrailer(exitCode)));
        }
        controller.close();
      }
    },
  });

  return { kind: "stream", stream };
}

// ---------------------------------------------------------------------------
// Live answering: the browser's own POST, from the Session card's
// rechazar/aprobar buttons.
// ---------------------------------------------------------------------------

/**
 * Every reason the Daemon's `/items/<id>/answer` route refuses outright.
 * `"not-live"` covers both an item never born live and one that lapsed to
 * pending — `row.decision` stays `"held"` forever once written, so the
 * elapsed-time check below is what tells a still-live hold apart from one
 * the hook already gave up on. Either way there's no hook left polling,
 * so accepting it would be a silent no-op the human could never see fail.
 */
export type AnswerRefusal = { kind: "already-resolved" } | { kind: "not-live" };

export type AnswerResult = AnswerRefusal | { kind: "accepted" };

/** Appends the human's live answer to the human log — the hold's own hook (`decide.ts`/`live.ts`) is what actually closes the item once it reads this back. */
export function postLiveAnswer(
  home: string,
  id: string,
  answer: "approve" | "reject",
  message?: string,
  now: Date = new Date(),
): AnswerResult {
  const row = findInboxRow(home, id);
  if (!row) throw new UnknownInboxItemError(id);
  if (isResolved(home, id)) return { kind: "already-resolved" };
  if (row.decision !== "held") return { kind: "not-live" };

  const policy = loadPolicy(home);
  const waitSeconds = effectiveWaitSeconds(policy);
  if (liveItemPhase(row.ts, now, waitSeconds) !== "live") return { kind: "not-live" };
  // Too close to expiry to be sure the hook still reads it.
  const remainingMs = new Date(row.ts).getTime() + waitSeconds * 1000 - now.getTime();
  if (remainingMs < LIVE_ANSWER_CUTOFF_MS) return { kind: "not-live" };

  appendHumanEvent(home, liveAnsweredEvent(row.session, id, answer, message));
  return { kind: "accepted" };
}

// ---------------------------------------------------------------------------
// Archive a TERMINÓ card: a human Event in the log, through a
// token-protected write route.
// ---------------------------------------------------------------------------

/** Every reason the archive route refuses outright. `"not-ended"` guards a stale card — a Session that resumed between the human's last render and their click must not let the archive through regardless. Archiving an already-archived Session is folded into `"accepted"`, never a refusal. */
export type ArchiveRefusal = { kind: "not-ended" };

/**
 * `alreadyArchived` is idempotent and harmless (a double click, a race
 * between tabs) — but it means "archived and nothing happened since," not
 * merely "an archive Event exists somewhere in the past": a resumed
 * Session that ran and ended again gets a fresh archive, not this flag.
 */
export type ArchiveResult = ArchiveRefusal | { kind: "accepted"; alreadyArchived: boolean };

/**
 * Archives Session `sessionId`, idempotent only while nothing has
 * happened since its own latest archive — `isArchived` judges that
 * against `lastEventTs`, so a resumed-then-reended Session always gets a
 * fresh archive rather than being treated as already done. Reads just
 * this Session's own log and `.touched` file, never the full
 * cross-Session index `buildBoardPayload` builds.
 *
 * `closedOutSessionIndex` also folds in a Session the board already shows
 * closed on other grounds (process confirmed gone, or no `pid` at all) —
 * a human who saw either move to TERMINÓ must still be able to archive it
 * here rather than get refused with `not-ended`.
 */
export function archiveSession(home: string, sessionId: string): ArchiveResult {
  const touched = readSessionTouchedTimestamp(sessionId, home);
  const index = closedOutSessionIndex(
    readSessionEvents(sessionId, home),
    touched ? new Map([[sessionId, touched]]) : undefined,
  );
  const node = index.get(sessionId);
  if (!node) throw new UnknownSessionError(sessionId);
  if (node.endedAt === undefined) return { kind: "not-ended" };

  const archivedAt = latestArchiveTimestamps(home).get(sessionId);
  if (isArchived(archivedAt, node.lastEventTs)) return { kind: "accepted", alreadyArchived: true };

  appendHumanEvent(home, sessionArchivedEvent(sessionId));
  return { kind: "accepted", alreadyArchived: false };
}
