import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { sessionTouchedPath, toolCallCounterPath } from "./paths";

export const SAMPLE_EVERY_N_TOOL_CALLS = 25;

/**
 * Records one PostToolUse call for `session`, returning the new running
 * total. A plain file beside the session's own log, never an Event —
 * "a tool call happened" isn't part of the Event contract. `tenaza hook
 * claude` is a fresh process per call, so nothing survives in memory
 * between calls — this file IS the count.
 *
 * Never reads the count to update it: each call appends exactly ONE byte
 * through an `O_APPEND`-opened fd, and the count is the file's size, read
 * back fresh every time. The kernel serializes an O_APPEND seek-and-write
 * as one atomic step, and a single byte is within the filesystem's atomic-
 * write guarantee — so two processes racing on this file can never land on
 * the same offset, the way a read-then-write always could.
 */
export function countToolCall(home: string, session: string): number {
  const file = toolCallCounterPath(session, home);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, "x");
  return statSync(file).size;
}

export function shouldSampleOnToolCall(count: number): boolean {
  return count % SAMPLE_EVERY_N_TOOL_CALLS === 0;
}

/**
 * Bumps `session`'s own "last ordinary activity" marker — a plain file
 * beside its log, same mechanism as `countToolCall` above. Called from
 * every hook on ordinary agent activity, matched or not. Swallows its own
 * failure: a DISPLAY-ONLY timestamp must never crash, or even warn on, the
 * hook call that triggered it.
 */
export function touchSession(home: string, session: string): void {
  try {
    const file = sessionTouchedPath(session, home);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, "x");
  } catch {
    // Deliberately empty.
  }
}
