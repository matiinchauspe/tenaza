import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { healthPath, tenazaHome } from "./paths";
import { policyWarning } from "./policy";
import { TENAZA_VERSION } from "./version";

/**
 * Tenaza's own degraded state — written OUTSIDE the session logs that
 * might be the very thing that's broken, so a corrupt log can never also
 * hide the signal that something is corrupt. This module only writes it
 * (on a degraded hook answer) and clears it (on the next healthy one).
 */
export interface HealthState {
  cause: string;
  /** True only when there's nothing to fall back on (e.g. no last-known-good Policy ever) — a sharper signal for whichever channel reads this later. */
  grave: boolean;
  /** Did THIS fault actually reach a human — never inferred from `grave` alone. */
  notified: boolean;
  at: string;
}

/** Never throws — reporting a fault must never itself become one. */
export function recordDegraded(
  home: string,
  cause: string,
  grave = false,
  notified = false,
  now: Date = new Date(),
): void {
  try {
    const file = healthPath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    const state: HealthState = { cause, grave, notified, at: now.toISOString() };
    writeFileSync(file, JSON.stringify(state));
  } catch {
  }
}

/** Called on the next healthy answer; never throws. */
export function recordHealthy(home: string): void {
  try {
    const file = healthPath(home);
    if (existsSync(file)) rmSync(file);
  } catch {
  }
}

/** `undefined` either when healthy or when the file can't be read — the two cases aren't distinguished. */
export function readHealth(home: string = tenazaHome()): HealthState | undefined {
  const file = healthPath(home);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as HealthState;
  } catch {
    return undefined;
  }
}

/** Same shape as `adapters/claude.ts`'s `HookOutcome.degraded`, so a caller can hand this straight to `recordDegraded`. */
export interface SelfCheckFault {
  message: string;
  grave: boolean;
}

/**
 * Proves writability with a real write + delete — nothing less actually
 * proves it. `mkdirSync` first, so a fresh home (nothing has written here
 * yet) isn't mistaken for unwritable just because the directory doesn't
 * exist yet.
 */
function isStateDirWritable(home: string): boolean {
  const dir = path.join(home, "state");
  const probe = path.join(dir, ".selfcheck-probe");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The SessionStart self-check: three cheap checks that catch a degraded
 * Tenaza once per session, before the first dangerous command rather than
 * at it — a session that starts and never happens to run a
 * Policy-matching command would otherwise never hear about it. Returns
 * `undefined` when every check passes, so a healthy SessionStart adds no
 * extra warning.
 *
 *   - **binary version**: read through a parameter, not inlined, so this
 *     is the one place that could report "Tenaza could not determine its
 *     own version" — a check that can only ever pass currently, kept so a
 *     future regression is caught by name instead of surfacing as a
 *     confusing crash elsewhere.
 *   - **Policy loads**: `policyWarning` — the same re-derivation
 *     `adapters/claude.ts`'s `withPolicyDegradation` uses for PreToolUse,
 *     so the two call sites can never disagree about whether
 *     `policy.toml` is degraded right now.
 *   - **state dir writable**: see `isStateDirWritable` above.
 *
 * `grave` is true only when a failing check is itself grave — only
 * `policyWarning`'s "no last-known-good Policy ever" case ever sets it;
 * an unwritable state dir is real but recoverable, so it never escalates
 * past a plain warning.
 */
export function runSelfCheck(home: string, version: string = TENAZA_VERSION): SelfCheckFault | undefined {
  const problems: string[] = [];
  let grave = false;

  if (!version) {
    problems.push("Tenaza could not determine its own version.");
  }

  const warning = policyWarning(home);
  if (warning) {
    problems.push(warning.message);
    grave = grave || warning.grave;
  }

  if (!isStateDirWritable(home)) {
    problems.push(`the state directory (${path.join(home, "state")}) is not writable.`);
  }

  if (problems.length === 0) return undefined;
  return { message: `Tenaza self-check failed: ${problems.join(" ")}`, grave };
}
