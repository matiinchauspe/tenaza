import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeSettingsPath, policyPath, tenazaHome } from "./paths";
// Bun's text loader embeds this file's CONTENT (not a path) into the
// compiled binary (`bun build --compile`) the same way it does for `bun
// run`/`bun test` — so `tenaza init`, run from a Homebrew-installed
// binary with no sibling `policy.example.toml` on disk, still has it.
import policyExampleToml from "../policy.example.toml" with { type: "text" };

/**
 * The exact command written into `statusLine` itself, when `init` DOES
 * touch the settings file (below) — Tenaza's is then the ONLY thing ever
 * reading stdin there, fed straight from Claude Code with nothing upstream
 * draining it first. Guarded, never a bare `tenaza statusline`: a bare one
 * written straight into `statusLine` would dangle and ERROR once `tenaza`
 * is uninstalled (ticket 10's own found gap), where this guarded form fails
 * closed instead — `command -v tenaza` comes back empty, the statusline
 * prints nothing, and Claude Code keeps working.
 */
export const STATUSLINE_PASTE_LINE = "command -v tenaza >/dev/null && tenaza statusline";

/**
 * Pasted into the user's OWN script when `init` will not touch their
 * settings at all — a DIFFERENT string from `STATUSLINE_PASTE_LINE` above,
 * deliberately (ticket 01, tenaza-v0-3: found on a human's own machine).
 * That script's own first line is almost always `input=$(cat)` (the
 * standard Claude Code statusline shape) — by the time it reaches an
 * appended `tenaza statusline`, stdin is already drained and there is
 * nothing left for it to read. Re-piping `$input` is what held on the
 * human's script; `STATUSLINE_PASTE_LINE`'s bare form would silently read
 * nothing in this shape, which is exactly why settings.json's own value and
 * the pasted one are no longer one shared string. Same `command -v` guard
 * as above, so it still fails closed once `tenaza` is uninstalled.
 *
 * It also prints Tenaza on its own OUTPUT line (`printf '\n%s'`): a script
 * typically ends with `printf '%s' "$parts"` and no newline, so a bare
 * pasted command would land on the END of that line — the first thing
 * Claude Code cuts, since it truncates an overflowing line from the right.
 * The second line is what held on the human's own script.
 */
export const STATUSLINE_SCRIPT_SNIPPET = `command -v tenaza >/dev/null && printf '\\n%s' "$(echo "$input" | tenaza statusline)"`;

/**
 * A plugin cannot set Claude Code's MAIN `statusLine` (only `agent` and
 * `subagentStatusLine` take effect from a plugin's own settings, per the
 * spec's Distribution section) — so `tenaza init` edits the user's OWN
 * settings file directly, once, the first time it finds no `statusLine`
 * there at all. ALWAYS the guarded command (`STATUSLINE_PASTE_LINE`), never
 * a bare `tenaza statusline` — see that constant's own comment.
 */
const STATUSLINE_VALUE = { type: "command", command: STATUSLINE_PASTE_LINE };

export interface InitResult {
  /** `true` only when a fresh policy.toml was written; `false` means an existing one was left alone. */
  policyWritten: boolean;
  /**
   * `"set"`: a fresh `statusLine` was written (file created or amended).
   * `"already-set"`: a `statusLine` already existed — settings file left
   * byte-identical (AC3). `"unreadable"`: the settings file exists but
   * isn't valid JSON — left untouched rather than risk a destructive
   * rewrite of a file that can't even be parsed.
   */
  statusLine: "set" | "already-set" | "unreadable";
  /**
   * The line to paste into the user's own script — present whenever
   * `statusLine !== "set"`. Always `STATUSLINE_SCRIPT_SNIPPET`, never
   * `STATUSLINE_PASTE_LINE`: this is pasted into a script that already
   * drained stdin, not written as the sole command settings.json runs.
   */
  pasteLine?: string;
}

function writePolicyIfAbsent(home: string): boolean {
  const target = policyPath(home);
  if (existsSync(target)) return false;

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, policyExampleToml);
  return true;
}

function hasStatusLine(settings: unknown): boolean {
  return (
    typeof settings === "object" &&
    settings !== null &&
    !Array.isArray(settings) &&
    "statusLine" in settings &&
    (settings as Record<string, unknown>).statusLine !== undefined
  );
}

function writeSettingsWithStatusLine(settingsPath: string, settings: Record<string, unknown>): void {
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  const next = { ...settings, statusLine: STATUSLINE_VALUE };
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Wire the statusline into Claude Code's own settings (q20). Never touches
 * the file when a `statusLine` already exists (AC3's byte-identical
 * guarantee — the file simply isn't opened for writing in that branch) and
 * never guesses at a destructive rewrite of a file it can't parse.
 */
function wireStatusline(settingsPath: string): Pick<InitResult, "statusLine" | "pasteLine"> {
  if (!existsSync(settingsPath)) {
    writeSettingsWithStatusLine(settingsPath, {});
    return { statusLine: "set" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return { statusLine: "unreadable", pasteLine: STATUSLINE_SCRIPT_SNIPPET };
  }

  if (hasStatusLine(parsed)) {
    return { statusLine: "already-set", pasteLine: STATUSLINE_SCRIPT_SNIPPET };
  }

  writeSettingsWithStatusLine(settingsPath, parsed as Record<string, unknown>);
  return { statusLine: "set" };
}

/**
 * `tenaza init` (ticket 09, q16): prepare a machine. Idempotent by
 * construction — every step below checks before writing, so running this
 * twice changes nothing the second time (AC4).
 */
export function runInit(
  home: string = tenazaHome(),
  settingsPath: string = claudeSettingsPath(),
): InitResult {
  const policyWritten = writePolicyIfAbsent(home);
  const { statusLine, pasteLine } = wireStatusline(settingsPath);
  return { policyWritten, statusLine, pasteLine };
}
