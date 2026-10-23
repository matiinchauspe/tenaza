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

/**
 * Where the notifier's test seam records "what would have been sent" (ticket
 * 08) when `TENAZA_NOTIFY_RECORDER` swaps the real macOS sender for it — a
 * plain JSONL file, never an Event: a notification attempt isn't part of the
 * Event contract (nothing reads it back as domain state), it's the test
 * oracle for the notifier port alone.
 */
export function notifyRecorderPath(home: string = tenazaHome()): string {
  return path.join(home, "state", "notify-recorder.jsonl");
}

/**
 * The last time a notification actually played a sound (ticket 08's burst
 * window: "one sound per ~2s") — a plain ISO timestamp, never an Event, and
 * GLOBAL (not per-Session): a burst can span different Sessions or Inbox
 * items, so the cooldown is shared the same way `tenaza hook` itself has no
 * daemon to hold it in memory across invocations (ADR 0002).
 */
export function notifySoundStatePath(home: string = tenazaHome()): string {
  return path.join(home, "state", "notify-sound-at");
}
