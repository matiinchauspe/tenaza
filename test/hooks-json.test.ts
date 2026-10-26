import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import hooksConfig from "../hooks/hooks.json";

/**
 * `hooks.json` itself (ADR 0007, decision 01; decision 07's generic `mcp`
 * Rule), the acceptance criterion's own named seam: the shape Claude Code
 * reads, and — since the missing-binary guard lives entirely in a shell
 * string, not in any `src/` module — a REAL subprocess run of that exact
 * string with a `PATH` that has no `tenaza` on it.
 */

type HookEntry = { matcher?: string; hooks: { type: string; command: string; args?: string[]; timeout?: number }[] };

function entriesFor(event: string): HookEntry[] {
  return (hooksConfig.hooks as Record<string, HookEntry[]>)[event] ?? [];
}

describe("hooks.json shape", () => {
  test("PreToolUse matches Bash and any mcp__* tool, with an explicit 240s timeout", () => {
    const [entry] = entriesFor("PreToolUse");
    expect(entry?.matcher).toBe("Bash|mcp__.*");
    expect(entry?.hooks[0]?.timeout).toBe(240);
  });

  test("PreToolUse carries no `onFailure` key anywhere (dropped by ADR 0007)", () => {
    const [entry] = entriesFor("PreToolUse");
    expect(entry).toBeDefined();
    expect("onFailure" in (entry as object)).toBe(false);
    expect("onFailure" in (entry?.hooks[0] as object)).toBe(false);
  });

  test("PreToolUse's command is shell-form: a guard, then falling through to `exec tenaza hook claude`", () => {
    const [entry] = entriesFor("PreToolUse");
    const command = entry?.hooks[0]?.command ?? "";
    expect(command).toContain("command -v tenaza");
    expect(command).toContain("exec tenaza hook claude");
    expect(entry?.hooks[0]?.args).toBeUndefined(); // shell-form: no argv array alongside it
  });

  test("every other event keeps no matcher at all", () => {
    for (const event of ["SessionStart", "SubagentStart", "PostToolUse", "SubagentStop", "Stop", "SessionEnd"]) {
      const [entry] = entriesFor(event);
      expect(entry).toBeDefined();
      expect(entry?.matcher).toBeUndefined();
    }
  });

  test("no `onFailure` key exists anywhere in the whole file", () => {
    expect(JSON.stringify(hooksConfig)).not.toContain("onFailure");
  });
});

describe("the missing-binary guard, run for real with a PATH that lacks tenaza", () => {
  test("prints the exact systemMessage JSON, with no hookSpecificOutput, and exits 0 (lets the call through)", async () => {
    const [entry] = entriesFor("PreToolUse");
    const command = entry?.hooks[0]?.command ?? "";

    const emptyBin = mkdtempSync(path.join(tmpdir(), "tenaza-missing-path-"));
    try {
      const proc = Bun.spawn(["/bin/sh", "-c", command], {
        env: { PATH: emptyBin },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual({ systemMessage: "Tenaza guardrail OFF — binary not found" });
      expect(parsed.hookSpecificOutput).toBeUndefined();
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test("falls through to `exec tenaza hook claude` the moment a `tenaza` IS on PATH", async () => {
    const [entry] = entriesFor("PreToolUse");
    const command = entry?.hooks[0]?.command ?? "";

    const bin = mkdtempSync(path.join(tmpdir(), "tenaza-present-path-"));
    try {
      const fakeTenaza = path.join(bin, "tenaza");
      writeFileSync(fakeTenaza, '#!/bin/sh\nprintf \'ran:%s\' "$*"\n');
      mkdirSync(bin, { recursive: true });
      Bun.spawnSync(["chmod", "+x", fakeTenaza]);

      const proc = Bun.spawn(["/bin/sh", "-c", command], {
        env: { PATH: bin },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

      expect(exitCode).toBe(0);
      expect(stdout).toBe("ran:hook claude");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
