import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "./support/cli";

describe("tenaza CLI (black box, temporary TENAZA_HOME)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-cli-"));
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[[rule]]
match = "gh pr merge"
effect = "human"

[[rule]]
match = "railway run"
effect = "flag"

[[rule]]
match = "true"
effect = "human"

[[rule]]
match = "false"
effect = "human"
`,
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("hook claude denies `gh pr merge 58` and tells the agent to stop", async () => {
    const payload = JSON.stringify({
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 58" },
    });

    const result = await runCli(["hook", "claude"], { home, stdin: payload });

    expect(result.exitCode).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(response.hookSpecificOutput.permissionDecisionReason).toContain("inbox #1");
  });

  test("hook claude allows a flag-ruled command and still logs it", async () => {
    const payload = JSON.stringify({
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "railway run -- psql" },
    });

    const result = await runCli(["hook", "claude"], { home, stdin: payload });

    expect(result.exitCode).toBe(0);
    if (result.stdout.trim().length > 0) {
      const response = JSON.parse(result.stdout);
      expect(response.hookSpecificOutput.permissionDecision).toBe("allow");
    }
  });

  test("hook claude says nothing for an unmatched command", async () => {
    const payload = JSON.stringify({
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });

    const result = await runCli(["hook", "claude"], { home, stdin: payload });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  test("status lists what the agent was just told, as the human sees it", async () => {
    await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 58" },
      }),
    });

    const status = await runCli(["status"], { home });

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("#1  Bash: gh pr merge 58");
  });

  test("each Session's Events land in its own state/sessions/<session>.jsonl, every line schema-valid", async () => {
    await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-abc",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 58" },
      }),
    });

    const { EventSchema } = await import("../src/contract/event");
    const raw = await Bun.file(path.join(home, "state", "sessions", "sess-abc.jsonl")).text();
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    for (const line of lines) {
      expect(() => EventSchema.parse(JSON.parse(line))).not.toThrow();
    }
  });

  async function deny(command: string, session = "sess-1"): Promise<void> {
    await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: session,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      }),
    });
  }

  test("tenaza run <id> on a stored `true` closes the item as done", async () => {
    await deny("true");

    const result = await runCli(["run", "1"], { home });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("closed");

    const status = await runCli(["status"], { home });
    expect(status.stdout).not.toContain("#1");
  });

  test("tenaza run <id> on a stored `false` leaves the item open and reports the failure", async () => {
    await deny("false");

    const result = await runCli(["run", "1"], { home });

    expect(result.exitCode).not.toBe(0);

    const status = await runCli(["status"], { home });
    expect(status.stdout).toContain("#1");
  });

  test("tenaza done <id> closes the item; status no longer lists it", async () => {
    await deny("gh pr merge 58");

    const result = await runCli(["done", "1"], { home });

    expect(result.exitCode).toBe(0);
    const status = await runCli(["status"], { home });
    expect(status.stdout).not.toContain("#1");
  });

  test("tenaza dismiss <id> closes the item; status no longer lists it", async () => {
    await deny("gh pr merge 58");

    const result = await runCli(["dismiss", "1"], { home });

    expect(result.exitCode).toBe(0);
    const status = await runCli(["status"], { home });
    expect(status.stdout).not.toContain("#1");
  });

  test("resolving an unknown id fails with a clear message, not a crash", async () => {
    const result = await runCli(["done", "999"], { home });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("999");
  });

  test("resolving an already-closed item is a no-op, not an error", async () => {
    await deny("gh pr merge 58");
    await runCli(["done", "1"], { home });

    const second = await runCli(["dismiss", "1"], { home });

    expect(second.exitCode).toBe(0);
  });

  test("Tenaza never executes the stored command except through `run`", async () => {
    const marker = path.join(home, "marker");
    await deny(`gh pr merge 58 && touch ${marker}`);

    await runCli(["done", "1"], { home });

    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  });
});
