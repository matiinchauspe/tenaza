import { existsSync } from "node:fs";
import { liveItemPhase } from "./board";
import { approvalResolvedEvent, liveAnsweredEvent, runFailedEvent, sessionArchivedEvent } from "./contract/event";
import { findInboxRow, isResolved, type InboxRow } from "./inbox";
import { LIVE_ANSWER_CUTOFF_MS } from "./live";
import { appendHumanEvent, readSessionEvents } from "./log";
import { effectiveWaitSeconds, loadPolicy } from "./policy";
import { runFailureTrailer } from "./runoutput";
import {
  buildSessionIndex,
  closeDeadProcesses,
  cwdForSession,
  isArchived,
  latestArchiveTimestamps,
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

/**
 * Every reason `run` refuses OUTRIGHT — no spawn, no Event — shared by
 * BOTH places `run` executes from (the CLI, ticket 06; the view's
 * streaming route, ticket 09): the validation is one shared fact about the
 * Inbox item, independent of how its output is delivered afterward.
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
 * The validation EVERY `run` call must pass before anything is ever spawned
 * — shared by the CLI's inherited-stdio spawn (`runInboxItem`, ticket 06)
 * and the view's streaming, login-shell spawn (`startInboxItemRunStream`,
 * ticket 09), so the two paths can never drift apart on WHETHER an item may
 * run, only on HOW its command executes once it may.
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
 * caller reports, never a thrown error.
 *
 * `cwd` is the REQUESTING Session's OWN directory (ticket 06), read from
 * that Session's own `session.started` — fixing v0.1's `Bun.spawn` with no
 * `cwd` at all, which ran in whatever directory the human happened to be
 * in when they typed `tenaza run` (decision 06: "CLI and view alike"). Two
 * ways that can fail to resolve, and EITHER refuses outright rather than
 * silently running somewhere else (the ticket's own warning): the Session
 * never started at all (`"no-cwd"`), or its directory no longer exists on
 * disk — a worktree already removed, say (`"cwd-missing"`).
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
 * `tenaza run <id>`: execute the Inbox item's stored command AT THE HUMAN'S
 * REQUEST — one of the two paths in Tenaza that ever executes a stored
 * command (the view's own is `startInboxItemRunStream`, below; `done`/
 * `dismiss` never do). Streams the child's output live (inherited stdio)
 * rather than capturing it, so the human watches it run in their own
 * terminal. Closes the item as `done` on exit 0; on anything else the item
 * stays open and no Event is written, so the human can retry.
 *
 * Spawns through a plain non-login `sh -c` — this is the CLI, run from the
 * human's OWN already-interactive shell, which already has a full PATH;
 * the view's own spawn (below) needs a login shell precisely because it
 * runs under launchd's minimal one (decision 06). Validation is shared
 * (`resolveRunTarget`) — only this last step, how the command actually
 * executes, differs between the two.
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
    // Ticket 10: a NON-resolving Event — the item stays open for a retry
    // (unchanged) — purely so the resolution trace has something to read
    // back for "falló (código N)" (spec).
    appendHumanEvent(home, runFailedEvent(row.session, id, exitCode));
    return { kind: "stays-open", exitCode };
  }

  appendHumanEvent(home, approvalResolvedEvent(row.session, id, "done", "run"));
  return { kind: "closed" };
}

/** What `startInboxItemRunStream` hands back: either the SAME refusal `runInboxItem` would (no spawn at all), or a live stream of the command's combined output — the HTTP route (`daemon.ts`) is the one place that turns either into a `Response`. */
export type RunStreamStart =
  | RunRefusal
  /** The item was fit to run, but SPAWNING the shell itself threw — never a `RunRefusal` (the item's own state is fine; the local machine couldn't start a process at all, e.g. a `TENAZA_RUN_SHELL` naming a binary that doesn't exist). No stream was ever created; `message` is the raw spawn error, for the route to report rather than let bubble into an unexplained 500. */
  | { kind: "spawn-failed"; message: string }
  | { kind: "stream"; stream: ReadableStream<Uint8Array> };

function describeSpawnError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The login shell the VIEW's own `run` spawns through (decision 06:
 * "launchd gives a minimal PATH"). `TENAZA_RUN_SHELL` is a test seam only
 * (same spirit as `daemon.ts`'s `TENAZA_HEARTBEAT_MS` / `TENAZA_SSE_POLL_MS`)
 * — it lets a test pin a fast, profile-free shell (`/bin/sh`) instead of
 * paying for whatever startup files the DEVELOPER's own `$SHELL` happens to
 * source; production always falls through to the human's real login shell,
 * `$SHELL` itself, or `/bin/zsh` (macOS's own default) when neither is set.
 */
function loginShellPath(): string {
  return process.env.TENAZA_RUN_SHELL ?? process.env.SHELL ?? "/bin/zsh";
}

/** Pipe one readable stream's bytes straight into `controller`, in order, until it ends. Stdout and stderr are pumped CONCURRENTLY (`Promise.all` below) — Tenaza never buffers a whole run before showing anything, which is the entire point of streaming it into the card. */
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
 * The view's own `run` (decision 06, ticket 09): same validation as the
 * CLI's `runInboxItem` (`resolveRunTarget`), but spawns through the user's
 * LOGIN shell and hands back a live `ReadableStream` of the command's
 * combined stdout+stderr instead of inheriting this process's own — there
 * is no terminal to inherit into from inside the Daemon, and the whole
 * point is streaming that output into the browser's card as it arrives.
 *
 * Closes the item as `done` on exit 0, exactly like the CLI path. On
 * anything else, no Event is written, the item stays open, and — review
 * fix, "anything else stays open WITH THE ERROR" (spec) — the stream's own
 * LAST bytes are a short es-AR trailer naming the exit code
 * (`runFailureTrailer`, `runoutput.ts`): a stored command like `false`
 * prints nothing of its own, so without this the card would show an empty
 * output and the run would read as a silent no-op rather than a failure.
 * The caller (`daemon.ts`'s route) never needs to ask which happened over
 * THIS return value otherwise — `startInboxItemRunStream` returns before
 * the process has even exited — it is derivable from the Inbox's own state
 * once the stream ends (`deriveInbox`/`isResolved`), the same place every
 * other resolution is ever read from (ADR 0002: nothing is kept beside the
 * logs).
 *
 * `Bun.spawn` itself is wrapped in its own try/catch (review fix): a
 * missing or unexecutable shell throws SYNCHRONOUSLY, before any stream
 * exists at all — left uncaught, that would surface to the human as an
 * unexplained 500 from the route. Caught here and reported as its own
 * `"spawn-failed"` outcome instead, carrying the raw error message.
 */
/** Factored out so `startInboxItemRunStream`'s own `let` declaration below can name its type as `ReturnType<typeof spawnRunShell>` — a BARE `ReturnType<typeof Bun.spawn>` loses the `stdout`/`stderr: "pipe"` literal narrowing Bun's own overloads give a direct inline call, which is what `pumpInto` needs (`ReadableStream`, never `number | undefined`). */
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
          // Ticket 10: same non-resolving trace Event the CLI's own
          // `runInboxItem` writes on a failed run — the item stays open.
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
// Live answering (ticket 10, decision 06): the browser's own POST, from the
// Session card's rechazar/aprobar buttons.
// ---------------------------------------------------------------------------

/**
 * Every reason the Daemon's `/items/<id>/answer` route refuses OUTRIGHT —
 * nothing is ever appended. `"not-live"` covers BOTH an item that was never
 * born live (a plain pending/unblocked row) and one that WAS, but has
 * already lapsed to pending (TIME IS STATE: `row.decision` stays `"held"`
 * forever once written, so the elapsed-time check below is what actually
 * tells a still-live hold apart from one the hook already gave up on) —
 * either way there is no hook left polling for this answer, so accepting it
 * would be a SILENT no-op the human could never see failed.
 */
export type AnswerRefusal = { kind: "already-resolved" } | { kind: "not-live" };

export type AnswerResult = AnswerRefusal | { kind: "accepted" };

/**
 * Append the human's live answer to the human log — the ONE write this
 * route makes; the hold's own hook (`decide.ts`/`live.ts`) is what actually
 * closes the item once it reads this back. `id` is the item's FULL identity
 * hash (ADR 0005), same convention as `resolveInboxItem`/`runInboxItem`.
 */
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
  // Review fix (race at the deadline): too close to expiry to be sure the hook still reads it.
  const remainingMs = new Date(row.ts).getTime() + waitSeconds * 1000 - now.getTime();
  if (remainingMs < LIVE_ANSWER_CUTOFF_MS) return { kind: "not-live" };

  appendHumanEvent(home, liveAnsweredEvent(row.session, id, answer, message));
  return { kind: "accepted" };
}

// ---------------------------------------------------------------------------
// Archive a TERMINÓ card (ticket 11, added 2026-10-27): a human Event in
// the log (ADR 0002), through a token-protected write route.
// ---------------------------------------------------------------------------

/** Every reason the Daemon's `/sessions/<id>/archive` route refuses OUTRIGHT — nothing is ever appended. `"not-ended"` is the server-side half of "x on any other Session card does nothing" (spec): the UI only ever shows the control on a TERMINÓ card, but a stale card (an agent that resumed between the human's last render and their click) must not let the archive through regardless. Archiving an ALREADY-archived Session is never a refusal — see `ArchiveResult`'s own doc on why it's folded into `"accepted"` instead, same convention `resolveInboxItem`'s `alreadyResolved` already uses. */
export type ArchiveRefusal = { kind: "not-ended" };

/**
 * `alreadyArchived` tells a repeat archive apart from the first — same
 * shape `resolveInboxItem`'s `ResolveResult` already gives for `done`/
 * `dismiss`: idempotent and harmless (a double click, a race between two
 * tabs), never an error a human needs to see.
 *
 * Orchestrator review, 2026-10-27: `alreadyArchived` means "archived AND
 * nothing of this Session happened since" (`sessions.ts`'s `isArchived`)
 * — NEVER merely "an archive Event exists somewhere in this Session's
 * past." A resumed Session (`claude --resume`/`--continue` under the same
 * `session_id`) that ran and ended again is no longer archived by its OLD
 * Event; archiving it now is a FRESH archive, appending a new one.
 */
export type ArchiveResult = ArchiveRefusal | { kind: "accepted"; alreadyArchived: boolean };

/**
 * Archive Session `sessionId` — hides its card from the board (ADR 0002:
 * recorded as a human Event in the log, never a side file). Idempotent
 * ONLY while nothing has happened since the Session's own latest archive —
 * `isArchived` (`sessions.ts`) judges that against this Session's own
 * `lastEventTs`, so a resumed-then-reended Session always gets a FRESH
 * archive Event here rather than being silently treated as already done.
 * Reading just THIS Session's own log is enough to know whether it has
 * ended and when it last did anything at all — `session.ended` (and every
 * resumed Session's later Events) are written there, not the human log —
 * so this never needs the full cross-Session index `buildBoardPayload`
 * builds; only the human log's own archive Events (`latestArchiveTimestamps`)
 * come from elsewhere.
 *
 * Ticket 02: also runs `closeDeadProcesses` over this one-node index before
 * reading `endedAt` — a Session the board already shows closed (its
 * runtime process confirmed gone) must be archivable too, or a human who
 * just saw it move to TERMINÓ would click "archivar" and get refused with
 * `not-ended`. Scoped to this Session's own `pid` alone (never a second,
 * cross-Session `ps` read) — the SAME single-node index this function
 * already builds, unchanged otherwise.
 */
export function archiveSession(home: string, sessionId: string): ArchiveResult {
  const index = buildSessionIndex(readSessionEvents(sessionId, home));
  closeDeadProcesses(index);
  const node = index.get(sessionId);
  if (!node) throw new UnknownSessionError(sessionId);
  if (node.endedAt === undefined) return { kind: "not-ended" };

  const archivedAt = latestArchiveTimestamps(home).get(sessionId);
  if (isArchived(archivedAt, node.lastEventTs)) return { kind: "accepted", alreadyArchived: true };

  appendHumanEvent(home, sessionArchivedEvent(sessionId));
  return { kind: "accepted", alreadyArchived: false };
}
