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
    for (const event of [
      "SessionStart",
      "SubagentStart",
      "PostToolUse",
      "SubagentStop",
      "Stop",
      "SessionEnd",
      "UserPromptSubmit",
    ]) {
      const [entry] = entriesFor(event);
      expect(entry).toBeDefined();
      expect(entry?.matcher).toBeUndefined();
    }
  });

  test("ticket 14: Notification matches ONLY permission_prompt and idle_prompt, never Claude Code's full matcher table", () => {
    const [entry] = entriesFor("Notification");
    expect(entry?.matcher).toBe("permission_prompt|idle_prompt");
    expect(entry?.hooks[0]?.timeout).toBeUndefined(); // no decision capability — no reason to carry a timeout at all
  });

  test("ticket 14: UserPromptSubmit and Notification carry no `onFailure` either — same ADR 0007 rule as every other event", () => {
    for (const event of ["UserPromptSubmit", "Notification"]) {
      const [entry] = entriesFor(event);
      expect(entry).toBeDefined();
      expect("onFailure" in (entry as object)).toBe(false);
      expect("onFailure" in (entry?.hooks[0] as object)).toBe(false);
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

/**
 * announce-declaration/01, AC6: SessionStart and SubagentStart carry the
 * announce declaration, so with the binary missing they must stay SILENT —
 * no declaration, no warning, exit 0 — rather than an exec-form spawn
 * failure Claude Code shows as a `hook error` on every session and subagent.
 * PreToolUse's own guard already warns once; these two add nothing to it.
 */
describe("the declaring events' missing-binary guard", () => {
  async function runGuard(event: string, pathDir: string) {
    const command = entriesFor(event)[0]?.hooks[0]?.command ?? "";
    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      env: { PATH: pathDir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  for (const event of ["SessionStart", "SubagentStart"]) {
    test(`${event} is shell-form: a guard, then \`exec tenaza hook claude\``, () => {
      const hook = entriesFor(event)[0]?.hooks[0];
      expect(hook?.command).toContain("command -v tenaza");
      expect(hook?.command).toContain("exec tenaza hook claude");
      expect(hook?.args).toBeUndefined();
    });

    test(`${event} with no tenaza on PATH prints nothing and exits 0`, async () => {
      const emptyBin = mkdtempSync(path.join(tmpdir(), "tenaza-missing-path-"));
      try {
        expect(await runGuard(event, emptyBin)).toEqual({ stdout: "", stderr: "", exitCode: 0 });
      } finally {
        rmSync(emptyBin, { recursive: true, force: true });
      }
    });

    test(`${event} falls through to \`exec tenaza hook claude\` when tenaza IS on PATH`, async () => {
      const bin = mkdtempSync(path.join(tmpdir(), "tenaza-present-path-"));
      try {
        const fakeTenaza = path.join(bin, "tenaza");
        writeFileSync(fakeTenaza, '#!/bin/sh\nprintf \'ran:%s\' "$*"\n');
        Bun.spawnSync(["chmod", "+x", fakeTenaza]);
        const result = await runGuard(event, bin);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("ran:hook claude");
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });
  }
});
