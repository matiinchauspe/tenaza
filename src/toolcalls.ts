import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toolCallCounterPath } from "./paths";

/** Every 25th PostToolUse call (25, 50, 75, …) — the ticket's own boundary (AC2), exactly on it. */
export const SAMPLE_EVERY_N_TOOL_CALLS = 25;

/**
 * Record one PostToolUse call for `session`, returning the new running
 * total. A plain integer file beside the Session's own log — never an
 * Event, since "a tool call happened" isn't part of the Event contract and
 * would double the log's size for no reader (q9's own residual: "the
 * counter lives beside the Session's log, keeping one writer per file").
 * `tenaza hook claude` is a fresh process per call, so nothing survives in
 * memory between calls — this file IS the count.
 */
export function countToolCall(home: string, session: string): number {
  const file = toolCallCounterPath(session, home);
  const next = readCounter(file) + 1;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, String(next), "utf8");
  return next;
}

function readCounter(file: string): number {
  if (!existsSync(file)) return 0;
  const parsed = Number(readFileSync(file, "utf8").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

/** True exactly on the 25th, 50th, 75th, … call — never before. */
export function shouldSampleOnToolCall(count: number): boolean {
  return count % SAMPLE_EVERY_N_TOOL_CALLS === 0;
}
