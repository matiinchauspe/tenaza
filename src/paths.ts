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

/**
 * Where Claude Code's OWN settings file lives — `tenaza init` reads and
 * edits it to wire up the statusline (q20). A different root than
 * TENAZA_HOME entirely (Claude Code's home, not Tenaza's), so it is never
 * derived from it. Resolved here, the ONE place, exactly like
 * `tenazaHome()`: `TENAZA_CLAUDE_SETTINGS` overrides it outright when set
 * (env), and every caller also takes it as an optional parameter (argument)
 * the same way every other path in this file takes `home` — so a test can
 * pass a temporary file directly without touching the environment at all.
 */
export function claudeSettingsPath(): string {
  return process.env.TENAZA_CLAUDE_SETTINGS ?? path.join(homedir(), ".claude", "settings.json");
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

/**
 * Tenaza's last successfully parsed Policy (ADR 0007, H3, ticket 01) — the
 * fallback a malformed `policy.toml` degrades to instead of silently
 * dropping every Rule. Written on every healthy `loadPolicy`, read back
 * only when the user's own file fails to parse.
 */
export function policyLkgPath(home: string = tenazaHome()): string {
  return path.join(home, "state", "policy.lkg.json");
}

/**
 * Tenaza's own degraded state (ADR 0007, ticket 01) — written OUTSIDE the
 * Session logs that might be the very thing that's broken, so a corrupt log
 * can never also hide the signal that something is corrupt. Written on a
 * degraded hook answer, cleared on the next healthy one; `tenaza
 * status`/`statusline` reading it to show a mark is a later ticket.
 */
export function healthPath(home: string = tenazaHome()): string {
  return path.join(home, "state", "health.json");
}
