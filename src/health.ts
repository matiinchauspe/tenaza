import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { healthPath, tenazaHome } from "./paths";
import { policyWarning } from "./policy";
import { TENAZA_VERSION } from "./version";

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

/** What `runSelfCheck` reports when something failed — the same shape `adapters/claude.ts`'s `HookOutcome.degraded` already carries, so a caller can hand this straight to `recordDegraded`. */
export interface SelfCheckFault {
  message: string;
  grave: boolean;
}

/**
 * Probe `<home>/state` the only way that actually proves it's writable: a
 * real write, then a real delete. `mkdirSync` first so a FRESH home (no
 * degraded answer has ever been written) isn't mistaken for an unwritable
 * one just because nothing created the directory yet.
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
 * The SessionStart self-check (ADR 0007, ticket 02) — three cheap checks
 * that catch a degraded Tenaza once per session, before the first dangerous
 * command, not at it: `systemMessage` already warns per CALL (ticket 01),
 * but a session that starts and never happens to run a Policy-matching
 * command would otherwise never hear about it. Returns `undefined` when
 * every check passes, so a healthy SessionStart stays silent — the same
 * "nothing to say, say nothing" convention `handlePreToolUse` already
 * follows.
 *
 *   - **binary version**: `version` (the one literal every build bakes in,
 *     `TENAZA_VERSION` by default) is read through a parameter, not
 *     inlined, so THIS is the one place that could ever report "Tenaza
 *     could not determine its own version" — a check that can only ever
 *     pass today, kept anyway so a future regression here is caught by
 *     name instead of surfacing as a confusing crash somewhere else.
 *   - **Policy loads**: `policyWarning` — the SAME re-derivation
 *     `adapters/claude.ts`'s `withPolicyDegradation` already uses for
 *     PreToolUse, so the two call sites can never disagree about whether
 *     `policy.toml` is degraded right now.
 *   - **state dir writable**: see `isStateDirWritable` above.
 *
 * `grave` is true only when a failing check is ITSELF grave (today, only
 * `policyWarning`'s "no last-known-good Policy ever" case) — an unwritable
 * state dir is real but recoverable (fix the permission; nothing was ever
 * silently unguarded because of it), so it never escalates past a plain
 * warning.
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
