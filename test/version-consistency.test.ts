import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TENAZA_VERSION } from "../src/version";

/**
 * Ticket 12 ("Version 0.2.0 in the binary, plugin and formula"): every
 * place a version is announced agrees with `src/version.ts`'s own single
 * source of truth — EXCEPT the Homebrew formula, whose version
 * `packaging/homebrew/update-formula.sh` fills from a published release's
 * own tag AFTER that release ships, so on main it can trail
 * `TENAZA_VERSION` between a bump and its release. This repo is its own
 * tap, so `Formula/tenaza.rb` on main is what `brew install` reads: the
 * test guards that it is installable (filled, never placeholders), not
 * that it equals the binary's version.
 */

const REPO_ROOT = path.join(import.meta.dir, "..");

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

describe("version consistency (ticket 12)", () => {
  test("the plugin manifest's own version matches the binary's TENAZA_VERSION", () => {
    const manifest = readJson(".claude-plugin/plugin.json") as { version?: unknown };
    expect(manifest.version).toBe(TENAZA_VERSION);
  });

  test("the marketplace manifest carries no SEPARATE version to drift from the plugin's own", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json") as {
      plugins?: { version?: unknown }[];
    };
    for (const plugin of marketplace.plugins ?? []) {
      expect(plugin.version).toBeUndefined();
    }
  });

  test("the Homebrew formula on main is installable — a real version and real sha256s, never placeholders", () => {
    const formula = readFileSync(path.join(REPO_ROOT, "Formula/tenaza.rb"), "utf8");
    expect(formula).toMatch(/version "\d+\.\d+\.\d+"/);
    expect(formula).not.toContain('version "0.0.0"');
    const digests = [...formula.matchAll(/sha256 "([0-9a-f]+)"/g)].map((m) => m[1]);
    expect(digests).toHaveLength(2);
    for (const digest of digests) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(digest).not.toMatch(/^0{63}[0-9]$/);
    }
  });

  test("the plugin's /tenaza command file exists and calls `tenaza open` — the thin wrapper ticket 12 calls for", () => {
    const command = readFileSync(path.join(REPO_ROOT, "commands/tenaza.md"), "utf8");
    expect(command).toContain("tenaza open");
  });

  /**
   * Ticket 12, scope addition 2 (release notes): CHANGELOG.md's own TOP
   * entry — the first "## [<version>]" heading in the file — is the
   * version about to ship, same as the binary and the plugin manifest.
   * Never a LOWER entry: a changelog with an unreleased top section and an
   * older "current" one below it would silently ship stale notes.
   */
  test("CHANGELOG.md's top entry is the SAME version as the binary and the plugin", () => {
    const changelog = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const match = changelog.match(/^## \[([^\]]+)\]/m);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(TENAZA_VERSION);
  });
});
