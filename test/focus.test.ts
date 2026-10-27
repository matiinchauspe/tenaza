import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFocusRecorder, runFocusPlan } from "../src/focus";

/**
 * The focuser port, via the SAME recorder test seam `notify.ts`'s own
 * `sendNotification`/`daemon.ts`'s own `openBrowser` already establish
 * (`TENAZA_FOCUS_RECORDER` set globally by `test/support/notify-env.ts`'s
 * own preload — never a real spawn or `osascript` from any test in this
 * suite).
 */
describe("runFocusPlan (the focuser port itself, via the recorder test seam)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-focus-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("records every step, in order", () => {
    runFocusPlan(home, [
      { kind: "spawn", argv: ["tmux", "-S", "/tmp/sock", "switch-client", "-c", "/dev/ttys005", "-t", "%3"] },
      { kind: "spawn", argv: ["open", "-b", "com.googlecode.iterm2"] },
    ]);

    expect(readFocusRecorder(home)).toEqual([
      { kind: "spawn", argv: ["tmux", "-S", "/tmp/sock", "switch-client", "-c", "/dev/ttys005", "-t", "%3"] },
      { kind: "spawn", argv: ["open", "-b", "com.googlecode.iterm2"] },
    ]);
  });

  test("records an osascript step's own script verbatim", () => {
    runFocusPlan(home, [{ kind: "osascript", script: 'tell application "Terminal" to activate' }]);
    expect(readFocusRecorder(home)).toEqual([{ kind: "osascript", script: 'tell application "Terminal" to activate' }]);
  });

  test("a spawn step's own env rides along in the recording", () => {
    runFocusPlan(home, [
      { kind: "spawn", argv: ["wezterm", "cli", "activate-pane", "--pane-id", "7"], env: { WEZTERM_UNIX_SOCKET: "/tmp/sock" } },
    ]);
    expect(readFocusRecorder(home)[0]).toEqual({
      kind: "spawn",
      argv: ["wezterm", "cli", "activate-pane", "--pane-id", "7"],
      env: { WEZTERM_UNIX_SOCKET: "/tmp/sock" },
    });
  });

  test("an empty plan (unknown reach — nothing to run) records nothing and never throws", () => {
    runFocusPlan(home, []);
    expect(readFocusRecorder(home)).toEqual([]);
  });

  test("reads back empty for a home that never had a focus attempt at all", () => {
    expect(readFocusRecorder(home)).toEqual([]);
  });
});
