import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { healthPath, policyPath, sessionLogPath } from "../src/paths";
import { runCli } from "./support/cli";

/**
 * Black-box seam the ticket names: `tenaza hook claude` in a temporary
 * `TENAZA_HOME` (ADR 0007, ticket 01). One case per listed fault — a torn
 * log line, a malformed Policy with and without a last-known-good copy,
 * and an uncaught exception — each asserting: no new block, a deny
 * already decided holds, and a warning is emitted.
 */
describe("ADR 0007 (ticket 01): a broken Tenaza never adds a block nor undoes a deny", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-hook-fail-mode-"));
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      policyPath(home),
      `
[[rule]]
match = "gh pr merge"
effect = "human"
`,
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function denyPayload(command: string, session = "sess-1"): string {
    return JSON.stringify({
      session_id: session,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    });
  }

  async function deny(command: string, session = "sess-1") {
    return runCli(["hook", "claude"], { home, stdin: denyPayload(command, session) });
  }

  test("a torn log line after a deny: the second deny still holds, the first stays open, and a warning names the skipped line", async () => {
    const first = await deny("gh pr merge 1");
    expect(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

    // Simulate a process that died mid-write: a torn line with no trailing newline, glued right after the valid deny Event.
    appendFileSync(sessionLogPath("sess-1", home), '{"torn');

    const second = await deny("gh pr merge 2");
    const response = JSON.parse(second.stdout);

    expect(second.exitCode).toBe(0);
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny"); // no new block beyond what the Policy already covers
    expect(typeof response.systemMessage).toBe("string");
    expect(response.systemMessage).toContain("skipped");

    const status = await runCli(["status"], { home });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("#1"); // the earlier deny still holds
    expect(status.stdout).toContain("#2"); // and the new one landed correctly despite the torn line
  });

  test("a malformed policy.toml with a last-known-good Policy: the existing Rule keeps enforcing, no block beyond it, and the warning names the fallback", async () => {
    const first = await deny("gh pr merge 1"); // establishes the LKG
    expect(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

    writeFileSync(policyPath(home), "[[rule\nmatch = broken");

    const second = await deny("gh pr merge 2");
    const response = JSON.parse(second.stdout);
    expect(second.exitCode).toBe(0);
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(response.systemMessage).toContain("using the last valid policy");

    const unmatched = await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      }),
    });
    expect(unmatched.exitCode).toBe(0);
    if (unmatched.stdout.trim().length > 0) {
      const unmatchedResponse = JSON.parse(unmatched.stdout);
      // no decision at all is as good as "allow" — either way, no new block
      expect(unmatchedResponse.hookSpecificOutput?.permissionDecision ?? "allow").toBe("allow");
    }

    const status = await runCli(["status"], { home });
    expect(status.stdout).toContain("#1");
    expect(status.stdout).toContain("#2");
  });

  test("a malformed policy.toml with no last-known-good Policy ever: nothing is newly blocked, and the warning is grave", async () => {
    writeFileSync(policyPath(home), "[[rule\nmatch = broken");

    const result = await deny("gh pr merge 1");
    const response = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(response.hookSpecificOutput?.permissionDecision ?? "allow").toBe("allow");
    expect(response.systemMessage).toContain("no Rules are active");

    const status = await runCli(["status"], { home });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).not.toContain("#1");
  });

  test("an uncaught fault (malformed hook payload) never blocks, is reported, and an earlier deny still holds", async () => {
    const first = await deny("gh pr merge 1");
    expect(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

    const garbage = await runCli(["hook", "claude"], { home, stdin: "not json at all {{{" });

    expect(garbage.exitCode).toBe(0);
    if (garbage.stdout.trim().length > 0) {
      const response = JSON.parse(garbage.stdout);
      expect(typeof response.systemMessage).toBe("string");
      // no permission decision at all — not even a synthesized "allow"
      // (ADR 0007 point 1, decision 08): an explicit hook allow skips
      // Claude Code's own auto-mode classifier entirely, which would be
      // LESS safe than no Tenaza at all on a reserved command.
      expect(response.hookSpecificOutput).toBeUndefined();
    }

    const status = await runCli(["status"], { home });
    expect(status.stdout).toContain("#1"); // the earlier deny still holds
  });

  test("a fault specifically on a PreToolUse call prints NO permissionDecision — just a systemMessage — and never says the call went through 'unguarded'", async () => {
    const first = await deny("gh pr merge 1");
    expect(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

    // A real, deterministic uncaught exception on a well-formed PreToolUse
    // payload: `tenaza label`'s own appendEvent isn't wrapped in a catch
    // (ADR 0007's top-level catch is its backstop, not a second guard on
    // every write site), and a plain FILE sitting where `state/sessions`
    // needs to be makes that write throw. The first deny above already
    // created that directory for real, so clear it first.
    rmSync(path.join(home, "state", "sessions"), { recursive: true, force: true });
    writeFileSync(path.join(home, "state", "sessions"), "not a directory");

    const result = await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-2",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "tenaza label ticket=X" },
      }),
    });

    expect(result.exitCode).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.hookSpecificOutput).toBeUndefined();
    expect(typeof response.systemMessage).toBe("string");
    expect(response.systemMessage.toLowerCase()).not.toContain("unguarded");
    expect(response.systemMessage).toContain("Claude Code's own permission checks still apply");
  });

  test("state/health.json is written on a degraded answer and cleared by the next healthy one", async () => {
    writeFileSync(policyPath(home), "[[rule\nmatch = broken"); // no LKG yet: grave

    await deny("gh pr merge 1");
    expect(existsSync(healthPath(home))).toBe(true);

    writeFileSync(
      policyPath(home),
      `
[[rule]]
match = "gh pr merge"
effect = "human"
`,
    );
    await deny("gh pr merge 2");

    expect(existsSync(healthPath(home))).toBe(false);
  });

  test("status and statusline never crash on a torn log line, with or without a prior deny", async () => {
    mkdirSync(path.dirname(sessionLogPath("sess-9", home)), { recursive: true });
    writeFileSync(sessionLogPath("sess-9", home), "{not even json\n");

    const status = await runCli(["status"], { home });
    const statusline = await runCli(["statusline"], { home });

    expect(status.exitCode).toBe(0);
    expect(statusline.exitCode).toBe(0);
  });
});
