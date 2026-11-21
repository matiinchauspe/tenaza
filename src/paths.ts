import { homedir } from "node:os";
import path from "node:path";

/** Every path Tenaza reads or writes resolves from here — the one place TENAZA_HOME is read, so every caller agrees on where state lives. */
export function tenazaHome(): string {
  return process.env.TENAZA_HOME ?? path.join(homedir(), ".tenaza");
}

/**
 * The Live surface's own default port; `--port` overrides it for a given
 * `tenaza ui` launch. Lives here, not in `daemon.ts` — that module imports
 * `./ui/index.html` at module scope (Bun's HTML-import bundling of the
 * whole React app), and `fence.ts` needs this constant on the PreToolUse
 * hook's hot path. Importing `daemon.ts` there would drag that bundling
 * cost into every hook call; `paths.ts` carries no such cost.
 */
export const DEFAULT_DAEMON_PORT = 4747;

export function policyPath(home: string = tenazaHome()): string {
  return path.join(home, "config", "policy.toml");
}

/**
 * Where Claude Code's own settings file lives — `tenaza init` reads and
 * edits it to wire up the statusline. A different root than TENAZA_HOME
 * entirely (Claude Code's home, not Tenaza's), so it's never derived from
 * it. `TENAZA_CLAUDE_SETTINGS` overrides it when set, and callers can pass
 * it directly too, so a test can use a temporary file without touching the
 * environment at all.
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
 * The running PostToolUse counter for one Session — a plain number, never
 * an Event, kept beside the Session's own log so each still keeps a single
 * writer per file.
 */
export function toolCallCounterPath(
  session: string,
  home: string = tenazaHome(),
): string {
  return path.join(sessionsDir(home), `${session}.toolcalls`);
}

/**
 * A Session's own "last ordinary activity" marker — a plain file beside
 * its log, bumped on every PreToolUse, PostToolUse and Stop call, matched
 * or not. The board payload folds its mtime into the Session's own
 * `lastEventTs` so a busy agent never reads as frozen through a long run
 * of ordinary tool calls that write no Event at all, without growing the
 * log.
 */
export function sessionTouchedPath(
  session: string,
  home: string = tenazaHome(),
): string {
  return path.join(sessionsDir(home), `${session}.touched`);
}

/** A Session's latest usage sample, a plain number — never an Event: PostToolUse reads it on every call instead of replaying the log. */
export function usageSampleMarkerPath(
  session: string,
  home: string = tenazaHome(),
): string {
  return path.join(sessionsDir(home), `${session}.usage`);
}

/** A Session's accumulated labels as JSON — a plain sidecar, never an Event, so reading them doesn't require replaying the log. */
export function sessionLabelsMarkerPath(
  session: string,
  home: string = tenazaHome(),
): string {
  return path.join(sessionsDir(home), `${session}.labels`);
}

/**
 * Where the notifier's test seam records "what would have been sent" when
 * `TENAZA_NOTIFY_RECORDER` swaps the real macOS sender for it — a plain
 * JSONL file, never an Event: a notification attempt isn't domain state
 * anything else reads back, it's the test oracle for the notifier port
 * alone.
 */
export function notifyRecorderPath(home: string = tenazaHome()): string {
  return path.join(home, "state", "notify-recorder.jsonl");
}

/**
 * The last time a notification actually played a sound — a plain ISO
 * timestamp, never an Event, and global (not per-Session): a burst can
 * span different Sessions or Inbox items, so the cooldown is shared, and
 * `tenaza hook` itself has no daemon process to hold it in memory across
 * invocations.
 */
export function notifySoundStatePath(home: string = tenazaHome()): string {
  return path.join(home, "state", "notify-sound-at");
}

export function notifiedMarkersDir(home: string = tenazaHome()): string {
  return path.join(home, "state", "notified");
}

/** A file, not an Event, so the claim is atomic across processes — a notify or the Daemon's migration writes it. */
export function inboxNotifiedMarkerPath(id: string, home: string = tenazaHome()): string {
  return path.join(notifiedMarkersDir(home), `inbox-${id}`);
}

/** The one marker only the migration itself writes, so a hook's or the Daemon's own claim is never read as it. */
export function inboxMigratedMarkerPath(home: string = tenazaHome()): string {
  return path.join(notifiedMarkersDir(home), ".migrated");
}

/**
 * Tenaza's last successfully parsed Policy — the fallback a malformed
 * `policy.toml` degrades to instead of silently dropping every Rule.
 * Written on every healthy `loadPolicy`, read back only when the user's
 * own file fails to parse.
 */
export function policyLkgPath(home: string = tenazaHome()): string {
  return path.join(home, "state", "policy.lkg.json");
}

/**
 * Tenaza's own degraded state — written outside the Session logs that
 * might be the very thing that's broken, so a corrupt log can never also
 * hide the signal that something is corrupt. Written on a degraded hook
 * answer, cleared on the next healthy one.
 */
export function healthPath(home: string = tenazaHome()): string {
  return path.join(home, "state", "health.json");
}

/**
 * The Daemon's heartbeat, rewritten every ~2s while `tenaza ui` runs. This
 * file — not a socket, not shared memory — is the only signal a hook could
 * ever read to learn a Daemon is up, since hooks never talk to the Daemon
 * directly. Resolved here, one place, so a later reader and `tenaza ui`'s
 * own writer can never disagree on where it lives.
 */
export function daemonAlivePath(home: string = tenazaHome()): string {
  return path.join(home, "state", "daemon.alive");
}

/**
 * The Daemon's per-launch write token: random, mode 0600, required by
 * every write route; reads (`/health`, the page, the SSE stream) never
 * check it. A second `tenaza ui` that finds a Tenaza already serving — via
 * a live `GET /health`, never this file's mere presence, since a stale
 * token from a crashed Daemon must not block a new launch — reads the
 * running instance's token back out of this file to open its URL, rather
 * than minting a new one the already-open browser tab's cookie wouldn't
 * match.
 */
export function daemonTokenPath(home: string = tenazaHome()): string {
  return path.join(home, "state", "daemon.token");
}

/**
 * Where the Daemon's browser-opener test seam records "what URL would
 * have been opened" when `TENAZA_OPEN_RECORDER` swaps the real `open`
 * spawn for it — a plain JSONL file, never an Event, so a test can assert
 * what `tenaza ui` tried to open without ever launching a real browser.
 */
export function openRecorderPath(home: string = tenazaHome()): string {
  return path.join(home, "state", "open-recorder.jsonl");
}

/**
 * Where the focuser port's test seam records "what step would have been
 * run" when `TENAZA_FOCUS_RECORDER` swaps the real spawn/osascript for it
 * — a plain JSONL file, never an Event: the test oracle for the focuser
 * port alone.
 */
export function focusRecorderPath(home: string = tenazaHome()): string {
  return path.join(home, "state", "focus-recorder.jsonl");
}
