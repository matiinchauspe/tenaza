import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { daemonAlivePath, daemonTokenPath, tenazaHome } from "./paths";

/**
 * The light surface a HOOK needs to reach toward the Daemon, without ever
 * paying for `daemon.ts`'s own cost: that module imports `./ui/index.html`
 * at module scope (Bun's HTML-import bundling of the whole React board),
 * which — per `paths.ts`'s own doc comment on `DEFAULT_DAEMON_PORT` — must
 * never be dragged into the PreToolUse hook's hot path (every single
 * Bash/MCP call, `decide.ts`'s own import graph). Ticket 07 defined
 * `isHeartbeatFresh`/`readAlive` INSIDE `daemon.ts` with a doc comment
 * flagging exactly this: "Defined here for a future hook to call (ticket
 * 10) — not called by anything in THIS ticket." This module is that split:
 * `decide.ts`/`live.ts` import from HERE; `daemon.ts` re-exports the same
 * names so every existing caller that looked for them there (ticket 07's
 * own tests included) is unaffected.
 */

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Heartbeat (state/daemon.alive)
// ---------------------------------------------------------------------------

/** "rewritten every ~2 s" (ticket 07) — overridable via `TENAZA_HEARTBEAT_MS` so a test never waits 2 real seconds per assertion. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000;

/**
 * How stale a heartbeat has to read before a reader (the live-answering
 * hook, ticket 10; `tenaza ui`'s own second-instance probe) should treat the
 * Daemon as gone — "heartbeat going stale mid-wait → deny at once" (decision
 * 06). 2.5x the write interval: generous enough that one slow tick under
 * load never reads as dead, tight enough to notice a genuinely gone process
 * within a few seconds.
 */
export const DEFAULT_HEARTBEAT_STALE_MS = 5000;

export function heartbeatIntervalMs(): number {
  return positiveIntFromEnv("TENAZA_HEARTBEAT_MS", DEFAULT_HEARTBEAT_INTERVAL_MS);
}

/** Rewrite the heartbeat file with the current timestamp. Never throws — a failing write here must never crash the Daemon's own event loop. */
export function writeAlive(home: string, now: Date = new Date()): void {
  try {
    const file = daemonAlivePath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, now.toISOString(), "utf8");
  } catch {
    // See the doc comment above.
  }
}

/** The heartbeat's own timestamp, or `undefined` when absent or unreadable — never thrown. */
export function readAlive(home: string = tenazaHome()): Date | undefined {
  const file = daemonAlivePath(home);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = new Date(readFileSync(file, "utf8").trim());
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/** Pure: is the heartbeat read as fresh right now? The ONE place a `human` match (`decide.ts`/`live.ts`) decides whether to hold live or deny at once, as v0.1 (decision 06). */
export function isHeartbeatFresh(
  aliveAt: Date | undefined,
  now: Date,
  maxAgeMs: number = DEFAULT_HEARTBEAT_STALE_MS,
): boolean {
  if (!aliveAt) return false;
  return now.getTime() - aliveAt.getTime() <= maxAgeMs;
}

// ---------------------------------------------------------------------------
// Token (state/daemon.token)
// ---------------------------------------------------------------------------

/** A fresh random token, one per `tenaza ui` launch (decision 05) — not a security boundary (agents run as the same user), just honest mistake-proofing. */
export function generateDaemonToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Write the launch token, mode 0600 (ticket 07). `writeFileSync`'s own
 * `mode` option sets that on a FRESH file at creation (the common case: a
 * clean `clearDaemonFiles` leaves nothing behind) — but POSIX `open()`
 * ignores the `mode` argument when the path already exists, so a leftover
 * file from an earlier launch would otherwise keep whatever permission it
 * already had. `chmodSync` is the belt-and-suspenders for exactly that
 * stale-file case, not the normal path.
 */
export function writeDaemonToken(home: string, token: string): void {
  const file = daemonTokenPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const existedBefore = existsSync(file);
  writeFileSync(file, token, { mode: 0o600 });
  if (existedBefore) chmodSync(file, 0o600);
}

/** The CURRENT Daemon's token — whichever one is running, since there is only ever one `daemon.token` per `TENAZA_HOME` (the port is the lock, decision 05). `undefined` when no Daemon has ever written one, or the file can't be read. */
export function readDaemonToken(home: string = tenazaHome()): string | undefined {
  const file = daemonTokenPath(home);
  if (!existsSync(file)) return undefined;
  try {
    const token = readFileSync(file, "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The URL a launcher — `tenaza ui` itself, or (ticket 10) a clickable 🟡
 * notification — opens: `/auth?token=`, not `/?token=`. `/auth` is the ONE
 * route that still validates the token and sets the cookie server-side
 * (`daemon.ts`'s `authResponse`). No token to carry (the `readDaemonToken`
 * miss case) → open the plain page directly, since there is nothing for
 * `/auth` to validate.
 */
export function buildDaemonUrl(port: number, token: string | undefined): string {
  const origin = `http://127.0.0.1:${port}`;
  return token ? `${origin}/auth?token=${token}` : `${origin}/`;
}
