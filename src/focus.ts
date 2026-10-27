import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { focusRecorderPath, tenazaHome } from "./paths";
import type { FocusStep } from "./terminals";

/**
 * The focuser port (ticket 11, decision 09): the ONE function that decides
 * HOW a `FocusPlan`'s steps actually reach the OS — same shape `notify.ts`'s
 * `sendNotification` / `daemon.ts`'s `openBrowser` already establish for
 * this project's other "never a real side effect in a test" seams. Nothing
 * upstream of this file (`terminals.ts`'s `planFocus`, the Daemon's focus
 * route) ever spawns a process or calls `osascript` itself — they only ever
 * build a plan and hand it here.
 */

function appendFocusRecorder(home: string, step: FocusStep): void {
  const file = focusRecorderPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(step)}\n`, "utf8");
}

/** Read back every step the recorder seam captured, in order — the test oracle for "what the focuser would have run." */
export function readFocusRecorder(home: string = tenazaHome()): FocusStep[] {
  const file = focusRecorderPath(home);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FocusStep);
}

/** Run exactly one step against the real OS — `osascript -e` for an AppleScript step, a plain spawn (with the step's own `env` layered on top of this process's) otherwise. Never awaited: the human already got their `{ ok: true }` the instant the plan was built (`daemon.ts`'s focus route); this fires and forgets, same as `sendMacNotification`/`openBrowser`. */
function runStepReal(step: FocusStep): void {
  if (step.kind === "osascript") {
    Bun.spawn(["osascript", "-e", step.script], { stdout: "ignore", stderr: "ignore" });
    return;
  }
  Bun.spawn(step.argv, {
    stdout: "ignore",
    stderr: "ignore",
    env: step.env ? { ...process.env, ...step.env } : undefined,
  });
}

/**
 * Run every step of a focus plan, IN ORDER — never throws (same guarantee
 * every other port in this project carries: a failing focus action must
 * never fail the write route that triggered it, and the human is no worse
 * off than before this ticket existed). Each step is wrapped in its OWN
 * try/catch so one step failing — the exact-tab command, say — still lets
 * the Level-1 app raise that follows it run; the whole point of a plan
 * carrying both is that the second is a fallback for the first, not
 * something gated on it succeeding.
 *
 *   - `TENAZA_FOCUS_RECORDER` set (any truthy value) → append each step to
 *     the recorder file under THIS `home` instead of touching the OS at
 *     all — the test seam `test/support/notify-env.ts`'s own sibling
 *     establishes for every other port in this project. A repo-wide
 *     `bunfig.toml` preload sets this for every `bun test` run, so no
 *     test can ever fire a real focus action by omission.
 *   - unset → the real spawn/osascript, per step.
 */
export function runFocusPlan(home: string, steps: readonly FocusStep[]): void {
  for (const step of steps) {
    try {
      if (process.env.TENAZA_FOCUS_RECORDER) {
        appendFocusRecorder(home, step);
      } else {
        runStepReal(step);
      }
    } catch {
      // See the doc comment above.
    }
  }
}
