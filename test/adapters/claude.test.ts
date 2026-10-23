import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleClaudeHook } from "../../src/adapters/claude";
import { readSessionEvents } from "../../src/log";
import { readNotificationRecorder } from "../../src/notify";

const fixture = (name: string) =>
  path.join(import.meta.dir, "..", "fixtures", "transcripts", name);

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
      data: { runtime: "claude", cwd: "/repo", capabilities: ["observe", "block", "measure"] },
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
      data: { parent: "sess-1", runtime: "claude", cwd: "/repo", capabilities: ["observe", "block", "measure"] },
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

  test("SessionEnd with a transcript_path ALSO samples usage for session_id (q9)", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SessionEnd",
      reason: "clear",
      transcript_path: fixture("below-threshold.jsonl"),
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "session.ended" }));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage.sampled", data: { context_tokens: 75704 } }),
    );
  });

  test("SubagentStop with a transcript_path ALSO samples usage for agent_id, not session_id", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      transcript_path: fixture("above-threshold.jsonl"),
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
    const events = readSessionEvents("agent-1", home);
    expect(events).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage.sampled", data: { context_tokens: 242170 } }),
    );
  });

  test("Stop samples usage for session_id, without ending the Session", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "Stop",
      transcript_path: fixture("above-threshold.jsonl"),
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      session: "sess-1",
      type: "usage.sampled",
      data: { context_tokens: 242170 },
    });
  });

  test("Stop with a transcript that yields no usage writes nothing — never a zero sample", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "Stop",
      transcript_path: fixture("no-usage.jsonl"),
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("Stop with no transcript_path at all degrades silently — no crash, no sample", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "Stop",
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("PostToolUse below the 25th call counts but writes nothing", () => {
    for (let i = 1; i < 25; i++) {
      const response = handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "PostToolUse",
        transcript_path: fixture("below-threshold.jsonl"),
      });
      expect(response).toBeUndefined();
    }

    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("PostToolUse on exactly the 25th call samples usage for session_id, and not before", () => {
    for (let i = 1; i < 25; i++) {
      handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "PostToolUse",
        transcript_path: fixture("below-threshold.jsonl"),
      });
    }
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);

    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      transcript_path: fixture("below-threshold.jsonl"),
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "usage.sampled", data: { context_tokens: 75704 } });
  });

  test("a `tenaza label` Bash command labels session_id's Session when there is no agent_id", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "tenaza label ticket=RES-131 project=reservee" },
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      session: "sess-1",
      type: "session.labeled",
      data: { labels: { ticket: "RES-131", project: "reservee" } },
    });
  });

  test("a `tenaza label` Bash command run inside a subagent labels agent_id's Session, never session_id's (AC1)", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "tenaza label ticket=RES-131 project=reservee" },
      agent_id: "agent-1",
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
    const events = readSessionEvents("agent-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      session: "agent-1",
      type: "session.labeled",
      data: { labels: { ticket: "RES-131", project: "reservee" } },
    });
  });

  test("a `tenaza label` command never goes through the Policy — no action.decided, even with a matching Rule", () => {
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[[rule]]
match = "tenaza label"
effect = "human"
`,
    );

    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "tenaza label ticket=RES-131" },
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("session.labeled");
  });

  test("`tenaza label` with no key=value pairs writes nothing — degrades silently, never a crash", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "tenaza label" },
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("a bare `tenaza` or `tenaza status` command is not mistaken for a label announce", () => {
    const response = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "tenaza status" },
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("PostToolUse counts are scoped per Session, never shared across sessions", () => {
    for (let i = 1; i < 25; i++) {
      handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "PostToolUse",
        transcript_path: fixture("below-threshold.jsonl"),
      });
    }
    // sess-2's own 25th call must trigger its own sample, unaffected by sess-1's count.
    for (let i = 1; i < 25; i++) {
      handleClaudeHook(home, {
        session_id: "sess-2",
        hook_event_name: "PostToolUse",
        transcript_path: fixture("above-threshold.jsonl"),
      });
    }
    expect(readSessionEvents("sess-2", home)).toHaveLength(0);

    handleClaudeHook(home, {
      session_id: "sess-2",
      hook_event_name: "PostToolUse",
      transcript_path: fixture("above-threshold.jsonl"),
    });
    expect(readSessionEvents("sess-2", home)).toHaveLength(1);
  });

  describe("notifications (ticket 08: 🔴 fires at the moment a sample crosses the threshold)", () => {
    test("a Stop call with a transcript above the threshold fires exactly one 🔴", () => {
      handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "Stop",
        transcript_path: fixture("above-threshold.jsonl"),
      });

      const notifications = readNotificationRecorder(home);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        tag: "threshold-sess-1",
        title: "🔴 Tenaza · pasó 200k",
      });
      expect(notifications[0]?.message).toContain("242k");
    });

    test("a second sample still above the threshold sends nothing more — once per Session", () => {
      handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "Stop",
        transcript_path: fixture("above-threshold.jsonl"),
      });
      handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "Stop",
        transcript_path: fixture("above-threshold.jsonl"),
      });

      expect(readNotificationRecorder(home)).toHaveLength(1);
    });

    test("a sample below the threshold sends nothing", () => {
      handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "Stop",
        transcript_path: fixture("below-threshold.jsonl"),
      });

      expect(readNotificationRecorder(home)).toEqual([]);
    });

    test("Session completion (SessionEnd) on its own, with no crossing sample, sends nothing", () => {
      handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "SessionEnd",
        reason: "clear",
        transcript_path: fixture("below-threshold.jsonl"),
      });

      expect(readNotificationRecorder(home)).toEqual([]);
    });

    test("a Session whose transcript reads lower on a later sample (e.g. after compaction) still never re-crosses", () => {
      // First sample crosses (above-threshold); the running max is what
      // `shouldNotifyThresholdCrossing` compares against, never the latest
      // alone, so a later LOWER sample must not look like "never crossed."
      handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "Stop",
        transcript_path: fixture("above-threshold.jsonl"),
      });
      handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "Stop",
        transcript_path: fixture("below-threshold.jsonl"),
      });

      expect(readNotificationRecorder(home)).toHaveLength(1);
    });

    test("SubagentStop samples and notifies for agent_id, never the parent session_id", () => {
      handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "SubagentStop",
        agent_id: "agent-1",
        transcript_path: fixture("above-threshold.jsonl"),
      });

      const notifications = readNotificationRecorder(home);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.tag).toBe("threshold-agent-1");
    });
  });
});
