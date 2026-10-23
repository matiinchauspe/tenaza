import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import path from "node:path";
import {
  claudeSettingsPath,
  humanLogPath,
  policyPath,
  sessionLogPath,
  sessionsDir,
  tenazaHome,
} from "../src/paths";

describe("TENAZA_HOME resolution", () => {
  const original = process.env.TENAZA_HOME;

  afterEach(() => {
    if (original === undefined) delete process.env.TENAZA_HOME;
    else process.env.TENAZA_HOME = original;
  });

  test("defaults to ~/.tenaza when TENAZA_HOME is unset", () => {
    delete process.env.TENAZA_HOME;
    expect(tenazaHome()).toBe(path.join(homedir(), ".tenaza"));
  });

  test("honours TENAZA_HOME when set", () => {
    process.env.TENAZA_HOME = "/tmp/some-tenaza-home";
    expect(tenazaHome()).toBe("/tmp/some-tenaza-home");
  });

  test("every path resolves under the resolved home", () => {
    process.env.TENAZA_HOME = "/tmp/some-tenaza-home";
    expect(policyPath()).toBe("/tmp/some-tenaza-home/config/policy.toml");
    expect(sessionsDir()).toBe("/tmp/some-tenaza-home/state/sessions");
    expect(sessionLogPath("sess-1")).toBe(
      "/tmp/some-tenaza-home/state/sessions/sess-1.jsonl",
    );
    expect(humanLogPath()).toBe("/tmp/some-tenaza-home/state/human.jsonl");
  });
});

describe("Claude settings path resolution (ticket 09)", () => {
  const original = process.env.TENAZA_CLAUDE_SETTINGS;

  afterEach(() => {
    if (original === undefined) delete process.env.TENAZA_CLAUDE_SETTINGS;
    else process.env.TENAZA_CLAUDE_SETTINGS = original;
  });

  test("defaults to ~/.claude/settings.json when TENAZA_CLAUDE_SETTINGS is unset", () => {
    delete process.env.TENAZA_CLAUDE_SETTINGS;
    expect(claudeSettingsPath()).toBe(path.join(homedir(), ".claude", "settings.json"));
  });

  test("honours TENAZA_CLAUDE_SETTINGS when set, never derived from TENAZA_HOME", () => {
    process.env.TENAZA_CLAUDE_SETTINGS = "/tmp/some-settings.json";
    expect(claudeSettingsPath()).toBe("/tmp/some-settings.json");
  });
});
