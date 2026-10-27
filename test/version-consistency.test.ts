import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TENAZA_VERSION } from "../src/version";

/**
 * Ticket 12 ("Version 0.2.0 in the binary, plugin and formula"): every
 * place a version is announced agrees with `src/version.ts`'s own single
 * source of truth — EXCEPT the Homebrew formula, whose `version "0.0.0"`
 * stays a placeholder `packaging/homebrew/update-formula.sh` fills from a
 * published release's own tag (the formula's own doc comment: "do not
 * hand-edit version ... below"). That script is proven NOT to disturb
 * anything else in the file by `tenaza.rb`'s own doc comment and this
 * project's manual verification (no automated seam exists for a Ruby
 * formula + a bash script that shells out to `gh`); this test instead
 * guards the one thing that IS this project's to keep in sync by hand.
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

  test("the Homebrew formula's version stays the placeholder update-formula.sh fills — never hand-bumped to TENAZA_VERSION", () => {
    const formula = readFileSync(path.join(REPO_ROOT, "packaging/homebrew/tenaza.rb"), "utf8");
    expect(formula).toContain('version "0.0.0"');
    expect(formula).not.toContain(`version "${TENAZA_VERSION}"`);
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
