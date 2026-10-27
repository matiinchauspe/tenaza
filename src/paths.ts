import { homedir } from "node:os";
import path from "node:path";

/**
 * Every path Tenaza reads or writes resolves from here — the ONE place
 * TENAZA_HOME is read, so every caller agrees on where state lives.
 */
export function tenazaHome(): string {
  return process.env.TENAZA_HOME ?? path.join(homedir(), ".tenaza");
}

/**
 * The Live surface's own default port (decision 05); `--port` overrides it
 * for a given `tenaza ui` launch. Lives HERE, not in `daemon.ts` (which
 * re-exports it for back-compat) — `daemon.ts` imports `./ui/index.html`
 * at module scope, Bun's own HTML-import bundling of the whole React app,
 * and `fence.ts` needs this constant from the PreToolUse hook's hot path
 * (every Bash/MCP call, `decide.ts` → `fence.ts`). Importing `daemon.ts`
 * from there would drag that bundling cost into every single hook
 * invocation; `paths.ts` carries no such cost, so this is the one shared
 * home both sides can import without it.
 */
export const DEFAULT_DAEMON_PORT = 4747;

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
 * Ticket 14: a Session's own "last ordinary activity" marker — a plain
 * file beside its log, bumped (never an Event, same convention as
 * `toolCallCounterPath` above) on every PreToolUse, PostToolUse and Stop
 * call, matched or not (`toolcalls.ts`'s `touchSession`). `daemon.ts`'s
 * board payload folds its mtime into the Session's own `lastEventTs` so
 * "a busy agent never reads frozen" through a long run of ordinary tool
 * calls that write no Event at all (AC3) — without growing the
 * single-writer log ADR 0002 protects.
 */
export function sessionTouchedPath(
  session: string,
  home: string = tenazaHome(),
): string {
  return path.join(sessionsDir(home), `${session}.touched`);
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

/**
 * The Daemon's heartbeat (ticket 07, ADR 0004, decision 05): rewritten every
 * ~2s while `tenaza ui` runs. This file — not a socket, not shared memory —
 * is the ONLY signal a hook could ever read to learn a Daemon is up; hooks
 * never talk to the Daemon directly (decision 05's own rule), and no hook
 * reads this one yet (ticket 10 wires that up). Expressed here regardless,
 * one place, so a later reader and `tenaza ui`'s own writer can never
 * disagree on where it lives.
 */
export function daemonAlivePath(home: string = tenazaHome()): string {
  return path.join(home, "state", "daemon.alive");
}

/**
 * The Daemon's per-launch write token (ticket 07, decision 05): random,
 * mode 0600, required by every write route; reads (`/health`, the page, the
 * SSE stream) never check it. A SECOND `tenaza ui` that finds a Tenaza
 * already serving (via a live `GET /health`, never this file's mere
 * presence — a stale token from a crashed Daemon must not block a new
 * launch) reads the RUNNING instance's token back out of this file to open
 * its URL, rather than minting a new one that the already-open browser
 * tab's cookie would not match.
 */
export function daemonTokenPath(home: string = tenazaHome()): string {
  return path.join(home, "state", "daemon.token");
}

/**
 * Where the Daemon's browser-opener test seam records "what URL would have
 * been opened" (ticket 07) when `TENAZA_OPEN_RECORDER` swaps the real `open`
 * spawn for it — the same shape `notifyRecorderPath` already gives the
 * notifier port: a plain JSONL-of-URLs file, never an Event (nothing reads
 * it back as domain state; it is the test oracle for the opener port
 * alone), so a test can assert what `tenaza ui` tried to open without ever
 * launching a real browser.
 */
export function openRecorderPath(home: string = tenazaHome()): string {
  return path.join(home, "state", "open-recorder.jsonl");
}

/**
 * Ticket 11: where the focuser port's test seam records "what step would
 * have been run" (`focus.ts`) when `TENAZA_FOCUS_RECORDER` swaps the real
 * spawn/osascript for it — the SAME shape `notifyRecorderPath`/
 * `openRecorderPath` already give their own ports: a plain JSONL-of-steps
 * file, never an Event (a focus attempt is not domain state ADR 0002 cares
 * about; it is the test oracle for the focuser port alone).
 */
export function focusRecorderPath(home: string = tenazaHome()): string {
  return path.join(home, "state", "focus-recorder.jsonl");
}
