import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readHealth, recordDegraded, recordHealthy } from "../src/health";
import { healthPath } from "../src/paths";

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
