import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { toolCallCounterPath } from "./paths";

/** Every 25th PostToolUse call (25, 50, 75, …) — the ticket's own boundary (AC2), exactly on it. */
export const SAMPLE_EVERY_N_TOOL_CALLS = 25;

/**
 * Record one PostToolUse call for `session`, returning the new running
 * total. A plain file beside the Session's own log — never an Event, since
 * "a tool call happened" isn't part of the Event contract and would
 * double the log's size for no reader (q9's own residual: "the counter
 * lives beside the Session's log, keeping one writer per file").
 * `tenaza hook claude` is a fresh process per call, so nothing survives in
 * memory between calls — this file IS the count.
 *
 * Atomic under PARALLEL hooks for the same Session (ticket 05, M5 — a
 * previous read-modify-write here lost updates: 50 parallel calls counted
 * 44). Fixed by never reading the count at all: each call appends exactly
 * ONE byte through an `O_APPEND`-opened fd (`appendFileSync`'s own 'a'
 * flag), and the count IS the file's size, read back fresh every time. The
 * kernel serializes the seek-to-end-and-write of an O_APPEND fd as one
 * atomic step per call — and a single byte is always within the
 * filesystem's atomic-write guarantee — so two processes racing on this
 * file can never both land on the same offset the way a separate
 * read-then-write always could. The byte's own VALUE is never read back;
 * only the file's length is the count.
 */
export function countToolCall(home: string, session: string): number {
  const file = toolCallCounterPath(session, home);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, "x");
  return statSync(file).size;
}

/** True exactly on the 25th, 50th, 75th, … call — never before. */
export function shouldSampleOnToolCall(count: number): boolean {
  return count % SAMPLE_EVERY_N_TOOL_CALLS === 0;
}
