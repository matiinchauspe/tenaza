import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import policyExampleToml from "../policy.example.toml" with { type: "text" };
import { policyPath } from "../src/paths";
import { runInit, STATUSLINE_PASTE_LINE, STATUSLINE_SCRIPT_SNIPPET } from "../src/init";

describe("runInit (ticket 09)", () => {
  let home: string;
  let settingsPath: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-init-home-"));
    const settingsDir = mkdtempSync(path.join(tmpdir(), "tenaza-init-settings-"));
    settingsPath = path.join(settingsDir, "settings.json");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(settingsPath), { recursive: true, force: true });
  });

  test("on a clean TENAZA_HOME, writes policy.toml from the shipped example, verbatim", () => {
    const result = runInit(home, settingsPath);

    expect(result.policyWritten).toBe(true);
    expect(existsSync(policyPath(home))).toBe(true);
    expect(readFileSync(policyPath(home), "utf8")).toBe(policyExampleToml);
  });

  test("an existing policy.toml is never overwritten", () => {
    mkdirSync(path.dirname(policyPath(home)), { recursive: true });
    const handEdited = "# a human already edited this file\n";
    writeFileSync(policyPath(home), handEdited);

    const result = runInit(home, settingsPath);

    expect(result.policyWritten).toBe(false);
    expect(readFileSync(policyPath(home), "utf8")).toBe(handEdited);
  });

  test("with no Claude settings file at all, init creates one with statusLine set to the GUARDED command (closes the uninstall gap: a bare `tenaza statusline` would dangle and error once the binary is gone)", () => {
    const result = runInit(home, settingsPath);

    expect(result.statusLine).toBe("set");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.statusLine).toEqual({ type: "command", command: STATUSLINE_PASTE_LINE });
  });

  test("with a statusLine already set, the settings file is left byte-identical and the paste line is returned", () => {
    const existing =
      '{\n  "statusLine": {\n    "type": "command",\n    "command": "~/.claude/my-script.sh"\n  },\n  "otherSetting": true\n}\n';
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, existing);

    const result = runInit(home, settingsPath);

    expect(result.statusLine).toBe("already-set");
    // The "already-set"/"unreadable" paths paste INTO an existing script, not
    // straight into Claude Code's settings.json — that script already drained
    // stdin (ticket 01, tenaza-v0-3: the common `input=$(cat)` first line), so
    // the pasted snippet re-feeds `$input` rather than reusing the guarded
    // bare command settings.json itself gets.
    expect(result.pasteLine).toBe(STATUSLINE_SCRIPT_SNIPPET);
    expect(readFileSync(settingsPath, "utf8")).toBe(existing);
  });

  test("with a settings file that has other keys but no statusLine, those keys are preserved", () => {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ otherSetting: true, model: "opus" }));

    const result = runInit(home, settingsPath);

    expect(result.statusLine).toBe("set");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.otherSetting).toBe(true);
    expect(settings.model).toBe("opus");
    expect(settings.statusLine).toEqual({ type: "command", command: STATUSLINE_PASTE_LINE });
  });

  test("an unreadable (malformed JSON) settings file is left untouched, never crashes", () => {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const malformed = "{ this is not valid JSON";
    writeFileSync(settingsPath, malformed);

    const result = runInit(home, settingsPath);

    expect(result.statusLine).toBe("unreadable");
    expect(result.pasteLine).toBe(STATUSLINE_SCRIPT_SNIPPET);
    expect(readFileSync(settingsPath, "utf8")).toBe(malformed);
  });

  test("running init twice changes nothing the second time", () => {
    const first = runInit(home, settingsPath);
    const policyAfterFirst = readFileSync(policyPath(home), "utf8");
    const settingsAfterFirst = readFileSync(settingsPath, "utf8");

    const second = runInit(home, settingsPath);

    expect(second.policyWritten).toBe(false);
    expect(second.statusLine).toBe("already-set");
    expect(readFileSync(policyPath(home), "utf8")).toBe(policyAfterFirst);
    expect(readFileSync(settingsPath, "utf8")).toBe(settingsAfterFirst);
    expect(first.policyWritten).toBe(true);
    expect(first.statusLine).toBe("set");
  });
});

describe("the two statusline snippets (ticket 01, tenaza-v0-3)", () => {
  test("STATUSLINE_PASTE_LINE — written straight into settings.json, where Tenaza's own command is the ONLY thing reading stdin — never re-pipes anything", () => {
    expect(STATUSLINE_PASTE_LINE).toBe("command -v tenaza >/dev/null && tenaza statusline");
  });

  test("STATUSLINE_SCRIPT_SNIPPET — pasted into a script that already drained stdin into `$input` — re-feeds it, guarded the same way, on its own OUTPUT line", () => {
    expect(STATUSLINE_SCRIPT_SNIPPET).toBe(
      `command -v tenaza >/dev/null && printf '\\n%s' "$(echo "$input" | tenaza statusline)"`,
    );
    expect(STATUSLINE_SCRIPT_SNIPPET).not.toBe(STATUSLINE_PASTE_LINE);
  });
});
