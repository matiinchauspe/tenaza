import { homedir } from "node:os";
import path from "node:path";

/**
 * Every path Tenaza reads or writes resolves from here — the ONE place
 * TENAZA_HOME is read, so every caller agrees on where state lives.
 */
export function tenazaHome(): string {
  return process.env.TENAZA_HOME ?? path.join(homedir(), ".tenaza");
}

export function policyPath(home: string = tenazaHome()): string {
  return path.join(home, "config", "policy.toml");
}

export function sessionsDir(home: string = tenazaHome()): string {
  return path.join(home, "state", "sessions");
}

export function sessionLogPath(
  session: string,
  home: string = tenazaHome(),
): string {
  return path.join(sessionsDir(home), `${session}.jsonl`);
}

export function humanLogPath(home: string = tenazaHome()): string {
  return path.join(home, "state", "human.jsonl");
}

/**
 * The running PostToolUse counter for one Session (ticket 04, q9) — a plain
 * number, never an Event, beside the Session's own log so it still keeps one
 * writer per file (ADR 0002).
 */
export function toolCallCounterPath(
  session: string,
  home: string = tenazaHome(),
): string {
  return path.join(sessionsDir(home), `${session}.toolcalls`);
}
