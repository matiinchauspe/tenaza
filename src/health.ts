import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { healthPath, tenazaHome } from "./paths";

/**
 * Tenaza's own degraded state (ADR 0007, ticket 01) — written OUTSIDE the
 * Session logs that might be the very thing that's broken, so a corrupt log
 * can never also hide the signal that something is corrupt. `tenaza
 * status`/`statusline` reading this to show a mark is a later ticket; this
 * module only owns writing it (on a degraded hook answer) and clearing it
 * (on the next healthy one).
 */
export interface HealthState {
  cause: string;
  /** True only for a fault with nothing to fall back on (H3's "grave" case, e.g. no last-known-good Policy ever) — a sharper signal for whichever channel reads this later, never a reason to throw here. */
  grave: boolean;
  at: string;
}

/**
 * Record that the hook's most recent answer was degraded. Never throws —
 * reporting a fault must never itself become one (same guarantee
 * `notify.ts`'s `sendNotification` already gives the notifier port).
 */
export function recordDegraded(
  home: string,
  cause: string,
  grave = false,
  now: Date = new Date(),
): void {
  try {
    const file = healthPath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    const state: HealthState = { cause, grave, at: now.toISOString() };
    writeFileSync(file, JSON.stringify(state));
  } catch {
    // See the doc comment above.
  }
}

/** Clear the degraded mark — called on the next healthy answer. Never throws. */
export function recordHealthy(home: string): void {
  try {
    const file = healthPath(home);
    if (existsSync(file)) rmSync(file);
  } catch {
    // See `recordDegraded`'s own doc.
  }
}

/** Read the current degraded state, if any — `undefined` when healthy, or when the file itself can't be read. */
export function readHealth(home: string = tenazaHome()): HealthState | undefined {
  const file = healthPath(home);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as HealthState;
  } catch {
    return undefined;
  }
}
