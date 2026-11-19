import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { focusRecorderPath, tenazaHome } from "./paths";
import type { FocusStep } from "./terminals";

/**
 * The focuser port: the one function that decides how a `FocusPlan`'s
 * steps actually reach the OS. Nothing upstream of this file
 * (`terminals.ts`'s `planFocus`, the Daemon's focus route) ever spawns a
 * process or calls `osascript` itself — they only ever build a plan and
 * hand it here.
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

/** Never awaited — the human already got their `{ ok: true }` the instant the plan was built (`daemon.ts`'s focus route); this fires and forgets. */
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
 * Runs every step of a focus plan — never throws, since a failing focus
 * action must never fail the write route that triggered it. Each step
 * gets its own try/catch, so one step failing (the exact-tab command,
 * say) still lets the Level-1 app raise that follows it run: the plan
 * carries both because the second is a fallback for the first, never
 * something gated on it succeeding.
 *
 * `TENAZA_FOCUS_RECORDER` set → append each step to the recorder file
 * under this `home` instead of touching the OS. A repo-wide `bunfig.toml`
 * preload sets this for every `bun test` run, so no test can ever fire a
 * real focus action by omission.
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
    }
  }
}
