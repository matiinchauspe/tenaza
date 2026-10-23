import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleClaudeHook } from "../../src/adapters/claude";
import { readSessionEvents } from "../../src/log";

describe("Claude Code PreToolUse adapter", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-claude-"));
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
`,
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("denies a human-ruled Bash command with the standard message", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 58" },
    });

    expect(response?.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = response?.hookSpecificOutput.permissionDecisionReason ?? "";
    expect(reason).toContain("inbox #1");
    expect(reason.toLowerCase()).toContain("reserved for the human");
    expect(reason.toLowerCase()).toContain("do not retry");
    expect(reason.toLowerCase()).toContain("tell the user");
    expect(reason.toLowerCase()).toContain("continue");
  });

  test("allows a flag-ruled Bash command and still logs action.decided", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "railway run -- psql" },
    });

    expect(response?.hookSpecificOutput.permissionDecision).toBe("allow");
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ data: { decision: "allow" } });
  });

  test("a Bash command matching no Rule produces no response and no log entry", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("a non-Bash tool call is passed through untouched", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x" },
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("SessionStart writes session.started with no parent and the Adapter's declared Capabilities", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SessionStart",
      cwd: "/repo",
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      session: "sess-1",
      type: "session.started",
      data: { runtime: "claude", cwd: "/repo", capabilities: ["observe", "block"] },
    });
    expect((events[0] as { data: { parent?: string } }).data.parent).toBeUndefined();
  });

  test("SubagentStart writes session.started keyed by agent_id, parented to session_id", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStart",
      agent_id: "agent-1",
      cwd: "/repo",
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
    const events = readSessionEvents("agent-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      session: "agent-1",
      type: "session.started",
      data: { parent: "sess-1", runtime: "claude", cwd: "/repo", capabilities: ["observe", "block"] },
    });
  });

  test("SubagentStop writes session.ended for the agent_id Session, never the parent", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
    const events = readSessionEvents("agent-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ session: "agent-1", type: "session.ended" });
  });

  test("SessionEnd writes session.ended for session_id, carrying the runtime's reason", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SessionEnd",
      reason: "clear",
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ session: "sess-1", type: "session.ended", data: { reason: "clear" } });
  });
});
