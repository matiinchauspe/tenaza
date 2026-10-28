import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TENAZA_VERSION } from "../src/version";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "extract-changelog.sh");
const REAL_CHANGELOG = path.join(import.meta.dir, "..", "CHANGELOG.md");

interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runScript(args: string[]): Promise<ScriptResult> {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Ticket 12, scope addition 2: `scripts/extract-changelog.sh` is what
 * `.github/workflows/release.yml` runs to build a tagged release's own
 * notes (`body_path: release/notes.md`) — tested here as a real
 * subprocess, same black-box convention `test/support/cli.ts`'s `runCli`
 * already uses for the `tenaza` binary itself, since this is a portable
 * shell script, not a bun module.
 */
describe("scripts/extract-changelog.sh", () => {
  test("finds the real CHANGELOG's 0.2.0 section and prints its body, never the heading line", async () => {
    const result = await runScript(["0.2.0", REAL_CHANGELOG]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("## [0.2.0]");
    expect(result.stdout).toContain("### Added");
    expect(result.stdout).toContain("The optional **Daemon**");
    // Never bleeds into the NEXT version's own section.
    expect(result.stdout).not.toContain("Initial release");
  });

  test("the real CHANGELOG has a section for TENAZA_VERSION — the version this run actually ships", async () => {
    const result = await runScript([TENAZA_VERSION, REAL_CHANGELOG]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  test("finds the real CHANGELOG's 0.1.0 section too, stopping before EOF cleanly", async () => {
    const result = await runScript(["0.1.0", REAL_CHANGELOG]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Initial release");
    expect(result.stdout).not.toContain("### Added");
  });

  test("a version with no heading at all fails loudly — exit 1, nothing on stdout, a clear stderr message", async () => {
    const result = await runScript(["9.9.9", REAL_CHANGELOG]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("9.9.9");
  });

  test("no changelog path argument at all is a usage error, never a crash", async () => {
    const result = await runScript([]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("usage:");
  });

  test("a changelog path that doesn't exist fails loudly rather than reading nothing silently", async () => {
    const result = await runScript(["0.2.0", "/tmp/this-file-does-not-exist-tenaza.md"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no changelog at");
  });

  describe("against a scratch fixture (never found through a substring match)", () => {
    let home: string;
    let fixture: string;

    beforeEach(() => {
      home = mkdtempSync(path.join(tmpdir(), "tenaza-changelog-"));
      fixture = path.join(home, "CHANGELOG.md");
      writeFileSync(
        fixture,
        [
          "# Changelog",
          "",
          "## [0.2.0] - 2026-10-27",
          "",
          "### Added",
          "- a thing",
          "",
          "## [0.2.0-rc1] - 2026-10-20",
          "",
          "- a release candidate note that must never leak into 0.2.0's own body",
          "",
          "## [10.2.0] - 2020-01-01",
          "",
          "- an unrelated older-scheme version that must never match \"0.2.0\" as a substring",
          "",
        ].join("\n"),
      );
    });

    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    test("an EXACT version heading match never grabs a differently-suffixed one (0.2.0 vs 0.2.0-rc1)", async () => {
      const result = await runScript(["0.2.0", fixture]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("a thing");
      expect(result.stdout).not.toContain("release candidate");
    });

    test("never matches a longer version string containing the search term (0.2.0 vs 10.2.0)", async () => {
      const result = await runScript(["0.2.0", fixture]);

      expect(result.stdout).not.toContain("unrelated older-scheme");
    });

    test("the suffixed version (0.2.0-rc1) is reachable on its own and stays scoped to its own body", async () => {
      const result = await runScript(["0.2.0-rc1", fixture]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("release candidate");
      expect(result.stdout).not.toContain("a thing");
    });

    test("leading and trailing blank lines around a section's body are trimmed", async () => {
      const blankPadded = path.join(home, "padded.md");
      writeFileSync(
        blankPadded,
        ["## [1.0.0] - 2026-01-01", "", "", "body line", "", "", "## [0.9.0] - 2025-01-01", ""].join("\n"),
      );

      const result = await runScript(["1.0.0", blankPadded]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("body line\n");
    });

    test("a version whose section is the LAST one in the file extracts cleanly to EOF", async () => {
      const result = await runScript(["10.2.0", fixture]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("unrelated older-scheme");
    });
  });
});
