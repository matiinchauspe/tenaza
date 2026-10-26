import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readHealth, recordDegraded, recordHealthy, runSelfCheck } from "../src/health";
import { healthPath, policyPath } from "../src/paths";

describe("ADR 0007 (ticket 01): health state", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-health-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("recordDegraded writes state/health.json, readable back through readHealth", () => {
    recordDegraded(home, "policy.toml is invalid", true, new Date("2026-01-01T00:00:00.000Z"));

    expect(existsSync(healthPath(home))).toBe(true);
    expect(readHealth(home)).toEqual({
      cause: "policy.toml is invalid",
      grave: true,
      at: "2026-01-01T00:00:00.000Z",
    });
  });

  test("recordDegraded defaults grave to false", () => {
    recordDegraded(home, "a torn log line was skipped");
    expect(readHealth(home)?.grave).toBe(false);
  });

  test("readHealth is undefined on a fresh home — nothing degraded yet", () => {
    expect(readHealth(home)).toBeUndefined();
  });

  test("recordHealthy clears a previously degraded state", () => {
    recordDegraded(home, "something broke");
    expect(readHealth(home)).toBeDefined();

    recordHealthy(home);

    expect(existsSync(healthPath(home))).toBe(false);
    expect(readHealth(home)).toBeUndefined();
  });

  test("recordHealthy on an already-healthy home is a harmless no-op", () => {
    expect(() => recordHealthy(home)).not.toThrow();
    expect(readHealth(home)).toBeUndefined();
  });

  test("neither recordDegraded nor recordHealthy ever throws, even when state/ can't be created", () => {
    // A plain file sits where `state/` (health.json's own directory) needs to be.
    rmSync(home, { recursive: true, force: true });
    writeFileSync(home, "a file, not a directory");

    expect(() => recordDegraded(home, "whatever")).not.toThrow();
    expect(() => recordHealthy(home)).not.toThrow();
  });
});

describe("ADR 0007 (ticket 02): runSelfCheck", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-selfcheck-"));
  });

  afterEach(() => {
    try {
      chmodSync(path.join(home, "state"), 0o755);
    } catch {
      // Not every test creates `state/`, and some already restore it themselves.
    }
    rmSync(home, { recursive: true, force: true });
  });

  test("a fresh home with no policy.toml and a writable state dir passes silently", () => {
    expect(runSelfCheck(home)).toBeUndefined();
  });

  test("a policy.toml with a last-known-good fallback: not grave", () => {
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      policyPath(home),
      `
[[rule]]
match = "gh pr merge"
effect = "human"
`,
    );
    // Establish the LKG the same way `loadPolicy` would on a healthy read.
    const { loadPolicy } = require("../src/policy");
    loadPolicy(home);
    writeFileSync(policyPath(home), "[[rule\nmatch = broken");

    const fault = runSelfCheck(home);
    expect(fault).toBeDefined();
    expect(fault?.grave).toBe(false);
    expect(fault?.message).toContain("using the last valid policy");
  });

  test("a malformed policy.toml with no last-known-good Policy ever: grave", () => {
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(policyPath(home), "[[rule\nmatch = broken");

    const fault = runSelfCheck(home);
    expect(fault).toBeDefined();
    expect(fault?.grave).toBe(true);
    expect(fault?.message).toContain("no Rules are active");
  });

  test("a state directory that can't be written to: reported, never grave", () => {
    mkdirSync(path.join(home, "state"), { recursive: true });
    chmodSync(path.join(home, "state"), 0o500); // read + execute, no write

    const fault = runSelfCheck(home);
    expect(fault).toBeDefined();
    expect(fault?.grave).toBe(false);
    expect(fault?.message).toContain("state directory");

    chmodSync(path.join(home, "state"), 0o755); // restore so afterEach can clean up
  });

  test("a healthy Policy and a writable state dir together: silent, even with a policy.toml present", () => {
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      policyPath(home),
      `
[[rule]]
match = "gh pr merge"
effect = "human"
`,
    );

    expect(runSelfCheck(home)).toBeUndefined();
  });
});
