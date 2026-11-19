import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { daemonAlivePath, daemonTokenPath, tenazaHome } from "./paths";

/**
 * The light surface a hook needs to reach the Daemon without paying for
 * `daemon.ts`'s own cost: that module imports `./ui/index.html` at module
 * scope (Bun's HTML-import bundling of the whole React board), which must
 * never land in the hot path of every hook call. `decide.ts`/`live.ts`
 * import from here; `daemon.ts` re-exports the same names.
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

/** Overridable via `TENAZA_HEARTBEAT_MS` so a test never waits 2 real seconds per assertion. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000;

/**
 * How stale a heartbeat must read before a reader treats the Daemon as
 * gone — 2.5x the write interval: generous enough that one slow tick
 * under load never reads as dead, tight enough to notice a gone process
 * within a few seconds.
 */
export const DEFAULT_HEARTBEAT_STALE_MS = 5000;

export function heartbeatIntervalMs(): number {
  return positiveIntFromEnv("TENAZA_HEARTBEAT_MS", DEFAULT_HEARTBEAT_INTERVAL_MS);
}

/** Never throws — a failing write here must never crash the Daemon's own event loop. */
export function writeAlive(home: string, now: Date = new Date()): void {
  try {
    const file = daemonAlivePath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, now.toISOString(), "utf8");
  } catch {
  }
}

/** `undefined` when the file is absent or unreadable — never throws. */
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

/** The one place that decides whether to hold a `human` match live or deny it at once. */
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

/** Not a security boundary — agents run as the same user — just honest mistake-proofing against a stale URL. */
export function generateDaemonToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Mode 0600. `writeFileSync`'s own `mode` option only applies on a fresh
 * file create — POSIX `open()` ignores `mode` when the path already
 * exists, so a leftover file from an earlier launch would otherwise keep
 * its old permissions; `chmodSync` covers that stale-file case.
 */
export function writeDaemonToken(home: string, token: string): void {
  const file = daemonTokenPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const existedBefore = existsSync(file);
  writeFileSync(file, token, { mode: 0o600 });
  if (existedBefore) chmodSync(file, 0o600);
}

/** The current Daemon's token — there is only ever one `daemon.token` per `TENAZA_HOME`. `undefined` when none has been written, or the file can't be read. */
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
 * `/auth?token=`, not `/?token=`: `/auth` is the one route that validates
 * the token and sets the cookie server-side (`daemon.ts`'s
 * `authResponse`). With no token (the `readDaemonToken` miss case), opens
 * the plain page — there's nothing for `/auth` to validate.
 */
export function buildDaemonUrl(port: number, token: string | undefined): string {
  const origin = `http://127.0.0.1:${port}`;
  return token ? `${origin}/auth?token=${token}` : `${origin}/`;
}
