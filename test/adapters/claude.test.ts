import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleClaudeHook } from "../../src/adapters/claude";
import { liveAnsweredEvent, sessionEndedEvent } from "../../src/contract/event";
import { writeAlive } from "../../src/daemonlink";
import { decideAction } from "../../src/decide";
import { inboxIdentityHash } from "../../src/identity";
import { appendEvent, appendHumanEvent, readSessionEvents } from "../../src/log";
import { readNotificationRecorder } from "../../src/notify";
import { renderSessionTree } from "../../src/sessions";
import { sessionTouchedPath } from "../../src/paths";

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

  test("denies a human-ruled Bash command with the standard message", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 58" },
    });

    expect(response?.hookSpecificOutput?.permissionDecision).toBe("deny");
    const reason = response?.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(reason).toMatch(/inbox [0-9a-f]{4,40}\./);
    expect(reason.toLowerCase()).toContain("reserved for the human");
    expect(reason.toLowerCase()).toContain("do not retry");
    expect(reason.toLowerCase()).toContain("tell the user");
    expect(reason.toLowerCase()).toContain("continue");
  });

  test("a human-ruled Bash command INSIDE a subagent is decided and logged under agent_id, never session_id (ticket 05, M2)", async () => {
    // The real bug (#1423): v0.1 keyed PreToolUse's decision by
    // `session_id` always, so a subagent's own denied command landed in
    // the PARENT's log instead of its own.
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 58" },
      agent_id: "agent-1",
    });

    expect(response?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
    const events = readSessionEvents("agent-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ session: "agent-1", type: "action.decided", data: { decision: "deny" } });
  });

  test("a flag-ruled Bash command still logs action.decided, but returns NO hook output at all (decision 07, H2)", async () => {
    // v0.1's mistake: answering an explicit `allow` here runs BEFORE Claude
    // Code's own auto-mode classifier and skips it — LESS safe than saying
    // nothing. A `flag` match must still be recorded, just never as a
    // permission decision.
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "railway run -- psql" },
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ data: { decision: "allow" } });
  });

  test("a Bash command matching no Rule produces no response and no log entry", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("an mcp__ tool call normalizes fine even when the Policy carries ZERO mcp Rules (ticket 04 backward compat)", async () => {
    // The outer Policy (above) has only `shell` Rules — proves a Policy with
    // no `mcp` Rule at all never crashes on an mcp Action: it's simply an
    // allow, not logged, same as any other no-match.
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "mcp__neon__run_sql",
      tool_input: { sql: "select 1" },
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("a non-Bash tool call is passed through untouched", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x" },
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("SessionStart writes session.started with no parent and the Adapter's declared Capabilities", async () => {
    const response = await handleClaudeHook(home, {
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

  /**
   * Ticket 11 (decision 09): `handleSessionStart` actually wires up
   * `captureTerminalLocator()` — unit-tested on its own in
   * `test/terminallocator.test.ts` (with an injected `psWalk`); this
   * confirms the END-TO-END integration, by temporarily setting
   * `process.env` to a known fixture (saved and restored either way) —
   * legitimate here, unlike a flaky assumption about whatever this
   * process's own real environment happens to carry.
   */
  test("SessionStart also captures and stores the terminal locator from its own env (decision 09, ticket 11)", async () => {
    const saved = { TERM_PROGRAM: process.env.TERM_PROGRAM, ORCA_TERMINAL_HANDLE: process.env.ORCA_TERMINAL_HANDLE };
    process.env.TERM_PROGRAM = "Orca";
    process.env.ORCA_TERMINAL_HANDLE = "term_fixture123";
    try {
      await handleClaudeHook(home, { session_id: "sess-2", hook_event_name: "SessionStart", cwd: "/repo" });
    } finally {
      process.env.TERM_PROGRAM = saved.TERM_PROGRAM;
      process.env.ORCA_TERMINAL_HANDLE = saved.ORCA_TERMINAL_HANDLE;
    }

    const events = readSessionEvents("sess-2", home);
    expect(events[0]).toMatchObject({
      type: "session.started",
      data: { terminal: { termProgram: "Orca", orcaHandle: "term_fixture123" } },
    });
  });

  test("SubagentStart never captures a terminal locator — resolving its PARENT's is the core's own job (ticket 11)", async () => {
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStart",
      agent_id: "agent-1",
      cwd: "/repo",
    });
    const events = readSessionEvents("agent-1", home);
    expect((events[0] as { data: { terminal?: unknown } }).data.terminal).toBeUndefined();
  });

  test("SubagentStart writes session.started keyed by agent_id, parented to session_id", async () => {
    const response = await handleClaudeHook(home, {
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

  test("SubagentStop writes session.ended for the agent_id Session, never the parent", async () => {
    // A REAL subagent — as of 2026-10-27, SubagentStop writes nothing at
    // all for an agent_id with no prior log, so the SubagentStart that
    // actually happens for a real subagent comes first.
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStart",
      agent_id: "agent-1",
      cwd: "/repo",
    });

    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
    const events = readSessionEvents("agent-1", home);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ session: "agent-1", type: "session.ended" });
  });

  test("SessionEnd writes session.ended for session_id, carrying the runtime's reason", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SessionEnd",
      reason: "clear",
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ session: "sess-1", type: "session.ended", data: { reason: "clear" } });
  });

  test("SessionEnd with a transcript_path ALSO samples usage for session_id (q9)", async () => {
    const response = await handleClaudeHook(home, {
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

  test("SubagentStop with an agent_transcript_path ALSO samples usage for agent_id, not session_id", async () => {
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStart",
      agent_id: "agent-1",
      cwd: "/repo",
    });

    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      agent_transcript_path: fixture("above-threshold.jsonl"),
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
    const events = readSessionEvents("agent-1", home);
    expect(events).toHaveLength(3);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage.sampled", data: { context_tokens: 242170 } }),
    );
  });

  test("SubagentStop reads agent_transcript_path, NEVER the sibling transcript_path — which names the PARENT's transcript (ticket 05, M3)", async () => {
    // The real bug (#1423/#1436): v0.1 measured the parent's transcript for
    // every subagent, so dozens of internal side-agents all showed the
    // SAME huge token count as their parent. Give the two fields
    // DIFFERENT fixtures and assert the subagent's own (smaller) number
    // wins — proof `transcript_path` here is read by nobody.
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStart",
      agent_id: "agent-1",
      cwd: "/repo",
    });

    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      transcript_path: fixture("above-threshold.jsonl"),
      agent_transcript_path: fixture("below-threshold.jsonl"),
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("agent-1", home);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage.sampled", data: { context_tokens: 75704 } }),
    );
  });

  test("SubagentStop with only a (parent) transcript_path and no agent_transcript_path samples nothing — never falls back to the wrong transcript", async () => {
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStart",
      agent_id: "agent-1",
      cwd: "/repo",
    });

    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      transcript_path: fixture("above-threshold.jsonl"),
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("agent-1", home);
    expect(events.map((e) => e.type)).toEqual(["session.started", "session.ended"]);
    expect(events.some((e) => e.type === "usage.sampled")).toBe(false);
  });

  test("Stop samples usage for session_id, without ending the Session", async () => {
    const response = await handleClaudeHook(home, {
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

  test("Stop with a transcript that yields no usage writes nothing — never a zero sample", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "Stop",
      transcript_path: fixture("no-usage.jsonl"),
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("Stop with no transcript_path at all degrades silently — no crash, no sample", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "Stop",
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("PostToolUse below the 25th call counts but writes nothing", async () => {
    for (let i = 1; i < 25; i++) {
      const response = await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "PostToolUse",
        transcript_path: fixture("below-threshold.jsonl"),
      });
      expect(response).toBeUndefined();
    }

    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("PostToolUse on exactly the 25th call samples usage for session_id, and not before", async () => {
    for (let i = 1; i < 25; i++) {
      await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "PostToolUse",
        transcript_path: fixture("below-threshold.jsonl"),
      });
    }
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);

    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      transcript_path: fixture("below-threshold.jsonl"),
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "usage.sampled", data: { context_tokens: 75704 } });
  });

  test("a `tenaza label` Bash command labels session_id's Session when there is no agent_id", async () => {
    const response = await handleClaudeHook(home, {
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

  test("a `tenaza label` Bash command run inside a subagent labels agent_id's Session, never session_id's (AC1)", async () => {
    const response = await handleClaudeHook(home, {
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

  test("a `tenaza label` command never goes through the Policy — no action.decided, even with a matching Rule", async () => {
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[[rule]]
match = "tenaza label"
effect = "human"
`,
    );

    const response = await handleClaudeHook(home, {
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

  test("`tenaza label` with no key=value pairs writes nothing — degrades silently, never a crash", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "tenaza label" },
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("a bare `tenaza` or `tenaza status` command is not mistaken for a label announce", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "tenaza status" },
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("PostToolUse counts are scoped per Session, never shared across sessions", async () => {
    for (let i = 1; i < 25; i++) {
      await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "PostToolUse",
        transcript_path: fixture("below-threshold.jsonl"),
      });
    }
    // sess-2's own 25th call must trigger its own sample, unaffected by sess-1's count.
    for (let i = 1; i < 25; i++) {
      await handleClaudeHook(home, {
        session_id: "sess-2",
        hook_event_name: "PostToolUse",
        transcript_path: fixture("above-threshold.jsonl"),
      });
    }
    expect(readSessionEvents("sess-2", home)).toHaveLength(0);

    await handleClaudeHook(home, {
      session_id: "sess-2",
      hook_event_name: "PostToolUse",
      transcript_path: fixture("above-threshold.jsonl"),
    });
    expect(readSessionEvents("sess-2", home)).toHaveLength(1);
  });

  test("PostToolUse INSIDE a subagent counts under agent_id, never session_id (ticket 05, M2)", async () => {
    for (let i = 1; i < 25; i++) {
      await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "PostToolUse",
        agent_id: "agent-1",
        agent_transcript_path: fixture("below-threshold.jsonl"),
      });
    }
    expect(readSessionEvents("agent-1", home)).toHaveLength(0);

    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      agent_id: "agent-1",
      agent_transcript_path: fixture("below-threshold.jsonl"),
    });

    // the 25th call for the SUBAGENT samples under its own Session —
    // the parent's log never sees any of this.
    expect(readSessionEvents("agent-1", home)).toHaveLength(1);
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("PostToolUse INSIDE a subagent samples agent_transcript_path, NEVER the sibling transcript_path which names the PARENT's transcript (ticket 05, M3 recurring in PostToolUse)", async () => {
    for (let i = 1; i <= 25; i++) {
      await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "PostToolUse",
        agent_id: "agent-1",
        transcript_path: fixture("above-threshold.jsonl"),
        agent_transcript_path: fixture("below-threshold.jsonl"),
      });
    }

    const events = readSessionEvents("agent-1", home);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage.sampled", data: { context_tokens: 75704 } }),
    );
  });

  test("PostToolUse INSIDE a subagent with only a (parent) transcript_path and no agent_transcript_path samples NOTHING on the 25th call — never falls back to the wrong transcript", async () => {
    for (let i = 1; i <= 25; i++) {
      await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "PostToolUse",
        agent_id: "agent-1",
        transcript_path: fixture("above-threshold.jsonl"),
      });
    }

    expect(readSessionEvents("agent-1", home)).toHaveLength(0);
  });

  test("PostToolUse INSIDE a subagent with no agent_transcript_path samples the subagent's OWN transcript beside the parent's on the 25th call — never the parent's tokens", async () => {
    // Claude Code's real layout: the parent at <dir>/<id>.jsonl, its
    // subagents at <dir>/<id>/subagents/agent-<agent_id>.jsonl.
    const projectDir = mkdtempSync(path.join(tmpdir(), "tenaza-claude-subagent-transcript-"));
    const parentTranscript = path.join(projectDir, "parent-1.jsonl");
    const subagentTranscript = path.join(projectDir, "parent-1", "subagents", "agent-agent-1.jsonl");
    writeFileSync(parentTranscript, readFileSync(fixture("above-threshold.jsonl")));
    mkdirSync(path.dirname(subagentTranscript), { recursive: true });
    writeFileSync(subagentTranscript, readFileSync(fixture("below-threshold.jsonl")));

    try {
      for (let i = 1; i <= 25; i++) {
        await handleClaudeHook(home, {
          session_id: "sess-1",
          hook_event_name: "PostToolUse",
          agent_id: "agent-1",
          transcript_path: parentTranscript,
        });
      }

      const samples = readSessionEvents("agent-1", home).filter((e) => e.type === "usage.sampled");
      expect(samples).toEqual([expect.objectContaining({ data: { context_tokens: 75704 } })]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  describe("notifications (ticket 08: 🔴 fires at the moment a sample crosses the threshold)", () => {
    test("a Stop call with a transcript above the threshold fires exactly one 🔴", async () => {
      await handleClaudeHook(home, {
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

    test("a second sample still above the threshold sends nothing more — once per Session", async () => {
      await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "Stop",
        transcript_path: fixture("above-threshold.jsonl"),
      });
      await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "Stop",
        transcript_path: fixture("above-threshold.jsonl"),
      });

      expect(readNotificationRecorder(home)).toHaveLength(1);
    });

    test("a sample below the threshold sends nothing", async () => {
      await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "Stop",
        transcript_path: fixture("below-threshold.jsonl"),
      });

      expect(readNotificationRecorder(home)).toEqual([]);
    });

    test("Session completion (SessionEnd) on its own, with no crossing sample, sends nothing", async () => {
      await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "SessionEnd",
        reason: "clear",
        transcript_path: fixture("below-threshold.jsonl"),
      });

      expect(readNotificationRecorder(home)).toEqual([]);
    });

    test("a Session whose transcript reads lower on a later sample (e.g. after compaction) still never re-crosses", async () => {
      // First sample crosses (above-threshold); the running max is what
      // `shouldNotifyThresholdCrossing` compares against, never the latest
      // alone, so a later LOWER sample must not look like "never crossed."
      await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "Stop",
        transcript_path: fixture("above-threshold.jsonl"),
      });
      await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "Stop",
        transcript_path: fixture("below-threshold.jsonl"),
      });

      expect(readNotificationRecorder(home)).toHaveLength(1);
    });

    test("SubagentStop samples and notifies for agent_id, never the parent session_id", async () => {
      await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "SubagentStart",
        agent_id: "agent-1",
        cwd: "/repo",
      });

      await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "SubagentStop",
        agent_id: "agent-1",
        agent_transcript_path: fixture("above-threshold.jsonl"),
      });

      const notifications = readNotificationRecorder(home);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.tag).toBe("threshold-agent-1");
    });
  });
});

describe("Live answering wiring (ticket 10): the adapter's own permission decision", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-claude-live-"));
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[[rule]]
match = "gh pr merge"
effect = "human"

[live]
wait_seconds = 2
`,
    );
    process.env.TENAZA_LIVE_POLL_MS = "20";
  });

  afterEach(() => {
    delete process.env.TENAZA_LIVE_POLL_MS;
    rmSync(home, { recursive: true, force: true });
  });

  function postAnswer(session: string, answer: "approve" | "reject", message?: string): void {
    appendHumanEvent(home, liveAnsweredEvent(session, inboxIdentityHash(session, 1), answer, message));
  }

  test("a live APPROVE returns an EXPLICIT allow, with the human's message as additionalContext", async () => {
    writeAlive(home);
    const responsePromise = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 58" },
    });
    await Bun.sleep(60);
    postAnswer("sess-1", "approve", "dale, adelante");

    const response = await responsePromise;
    expect(response?.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(response?.hookSpecificOutput?.additionalContext).toBe("dale, adelante");
  });

  test("a live APPROVE with no message carries no additionalContext key at all", async () => {
    writeAlive(home);
    const responsePromise = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 58" },
    });
    await Bun.sleep(60);
    postAnswer("sess-1", "approve");

    const response = await responsePromise;
    expect(response?.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect("additionalContext" in (response?.hookSpecificOutput ?? {})).toBe(false);
  });

  test("a live REJECT denies with the human's own message as the reason, never the generic 'Reserved for the human' wording", async () => {
    writeAlive(home);
    const responsePromise = handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 58" },
    });
    await Bun.sleep(60);
    postAnswer("sess-1", "reject", "primero corré los tests");

    const response = await responsePromise;
    expect(response?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(response?.hookSpecificOutput?.permissionDecisionReason).toBe("primero corré los tests");
  });

  test("expiry (no answer) denies with the spec's own es-AR wording, naming the inbox id", async () => {
    writeAlive(home);
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 58" },
    });

    expect(response?.hookSpecificOutput?.permissionDecision).toBe("deny");
    const reason = response?.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(reason).toContain("nadie respondió");
    expect(reason).toMatch(/inbox [0-9a-f]{4,40} /);
  });

  test("no Daemon up at all — the plain, unchanged deny wording, byte for byte with the pre-ticket-10 shape", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 58" },
    });

    expect(response?.hookSpecificOutput?.permissionDecision).toBe("deny");
    const reason = response?.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(reason.toLowerCase()).toContain("reserved for the human");
  });
});

describe("session.started backfill from a later event's own cwd (ticket 05, M6 — #1423's own fix)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-claude-backfill-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("a PostToolUse call for a Session that never got SessionStart backfills session.started from its own cwd", async () => {
    // A Session running before Tenaza was installed (or whose SessionStart
    // hook simply never fired) still gets grouped under a real project
    // on the next event that happens to carry a `cwd` — instead of
    // "(sin proyecto) sin datos" forever.
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      cwd: "/repos/predates-install",
    });

    const events = readSessionEvents("sess-1", home);
    expect(events[0]).toMatchObject({
      type: "session.started",
      data: { runtime: "claude", cwd: "/repos/predates-install" },
    });
    expect((events[0] as { data: { parent?: string } }).data.parent).toBeUndefined();
  });

  test("a PreToolUse call INSIDE a subagent that never got SubagentStart backfills session.started PARENTED to session_id", async () => {
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: {},
      agent_id: "agent-1",
      cwd: "/repos/predates-install",
    });

    const events = readSessionEvents("agent-1", home);
    expect(events[0]).toMatchObject({
      type: "session.started",
      data: { parent: "sess-1", runtime: "claude", cwd: "/repos/predates-install" },
    });
  });

  test("a call with NO cwd at all backfills nothing — the Session simply stays lifecycle-less", async () => {
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
    });

    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("backfill never fires once the Session already has a session.started — never overwrites or duplicates one", async () => {
    await handleClaudeHook(home, { session_id: "sess-1", hook_event_name: "SessionStart", cwd: "/repo/real" });

    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      cwd: "/some/other/cwd",
    });

    const events = readSessionEvents("sess-1", home);
    expect(events.filter((e) => e.type === "session.started")).toHaveLength(1);
    expect(events[0]).toMatchObject({ data: { cwd: "/repo/real" } });
  });

  test("backfill never repeats when the log's FIRST line is NOT session.started — e.g. a Session that predates install (ticket 05 fix: sessionHasStarted's own infinite-append bug)", async () => {
    // The Session's log opens with an action.decided (ticket 01/02's own
    // lifecycle-less shape) — line 1 is NEVER session.started, real or
    // backfilled, since a backfill only ever appends at the END. Two
    // PostToolUse calls, each carrying a cwd, must still produce exactly
    // ONE session.started — not one per call.
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(path.join(home, "config", "policy.toml"), '\n[[rule]]\nmatch = "gh pr merge"\neffect = "human"\n');
    await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });

    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      cwd: "/repo/predates-install",
    });
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      cwd: "/repo/predates-install",
    });

    const events = readSessionEvents("sess-1", home);
    expect(events.filter((e) => e.type === "session.started")).toHaveLength(1);
  });
});

describe("SubagentStop deliberately never backfills (ticket 05 fix — would defeat isNoiseSession)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-claude-subagentstop-nobackfill-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * As of 2026-10-27: this scenario — a bare SubagentStop with
   * NO prior SubagentStart or backfill — is Claude Code's own INTERNAL
   * side-agent signature (216 such logs measured in 24h on the real
   * `~/.tenaza/state`). It used to write `session.ended` + a usage sample
   * anyway and rely on `isNoiseSession` to hide the result (this test's
   * own former title/assertions); it now writes NOTHING at all — no log
   * is ever born for it, superseding the old "write it, then hide it"
   * shape rather than merely relying on the board-side filter.
   */
  test("a NEVER-STARTED agent_id (no prior SubagentStart, no backfill) gets nothing written at all — no log is ever born for it", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      cwd: "/repos/some-project",
      agent_transcript_path: fixture("below-threshold.jsonl"),
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("agent-1", home)).toHaveLength(0);
    expect(renderSessionTree(home)).not.toContain("agent-1");
  });

  test("a REAL subagent (SubagentStart fired first) still gets its session.ended + usage sample, unaffected", async () => {
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStart",
      agent_id: "agent-1",
      cwd: "/repos/some-project",
    });

    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      agent_transcript_path: fixture("below-threshold.jsonl"),
    });

    const events = readSessionEvents("agent-1", home);
    expect(events.map((e) => e.type)).toEqual(["session.started", "session.ended", "usage.sampled"]);
  });

  test("a subagent backfilled by an earlier PostToolUse (real work, no explicit SubagentStart) still gets its session.ended + usage sample", async () => {
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      agent_id: "agent-1",
      cwd: "/repos/some-project",
    });

    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      agent_transcript_path: fixture("below-threshold.jsonl"),
    });

    const events = readSessionEvents("agent-1", home);
    expect(events.some((e) => e.type === "session.started")).toBe(true);
    expect(events.some((e) => e.type === "session.ended")).toBe(true);
  });

  test("a RESUMED subagent (SubagentStart fires again under the same agent_id, ticket 13's own revival) keeps working through a second SubagentStop", async () => {
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStart",
      agent_id: "agent-1",
      cwd: "/repos/some-project",
    });
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      agent_transcript_path: fixture("below-threshold.jsonl"),
    });
    // SendMessage re-fires SubagentStart under the SAME agent_id.
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStart",
      agent_id: "agent-1",
      cwd: "/repos/some-project",
    });
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      agent_transcript_path: fixture("below-threshold.jsonl"),
    });

    const events = readSessionEvents("agent-1", home);
    expect(events.filter((e) => e.type === "session.started")).toHaveLength(2);
    expect(events.filter((e) => e.type === "session.ended")).toHaveLength(2);
  });

  test("a parse error on the SubagentStop payload fails safe: no new block, no throw, exit clean", async () => {
    await expect(
      handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "SubagentStop",
        // Malformed: agent_id missing entirely — must never throw.
      } as never),
    ).resolves.toBeUndefined();
  });

  /**
   * Board seam: a log ALREADY on disk from before the
   * hook fix shipped — session.ended{subagent_stop} as its ONLY Event, no
   * usage sample at all (an absent/unreadable transcript) — is never
   * deleted (ADR 0002), but must still never show as a phantom TERMINÓ
   * card.
   */
  test("a legacy log (pre-fix shape: only session.ended{subagent_stop}, no usage sample) stays hidden from status — never deleted, never shown", () => {
    appendEvent(home, sessionEndedEvent("agent-legacy", "subagent_stop"));
    expect(renderSessionTree(home)).not.toContain("agent-legacy");
  });

  test("a legacy top-level Session that ended with no session.started AND a DIFFERENT reason is never mistaken for the phantom shape", () => {
    appendEvent(home, sessionEndedEvent("sess-legacy-real", "prompt_input_exit"));
    expect(renderSessionTree(home)).toContain("sess-legacy-real");
  });
});

describe("Claude Code PreToolUse adapter: mcp Actions (ticket 04, decision 07)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-claude-mcp-"));
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[[rule]]
tool = "mcp__*neon*__run_sql*"
unless = { branch_id = ["br-dev-123"] }
effect = "human"

[[rule]]
tool = "mcp__*vercel*"
effect = "flag"
`,
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("normalizes an mcp__* tool call into { kind: mcp, tool, args } and denies it on a human-ruled match", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "mcp__neon__run_sql",
      tool_input: { branch_id: "br-prod-999", sql: "select 1" },
    });

    expect(response?.hookSpecificOutput?.permissionDecision).toBe("deny");
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "action.decided",
      data: {
        action: { kind: "mcp", tool: "mcp__neon__run_sql", args: { branch_id: "br-prod-999", sql: "select 1" } },
        decision: "deny",
      },
    });
  });

  test("an ABSENT branch_id still matches — the Neon default-branch-is-prod case", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "mcp__neon__run_sql",
      tool_input: { sql: "select 1" },
    });

    expect(response?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("a safe branch_id is exempted — allowed, and not even logged (no Rule matched)", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "mcp__neon__run_sql",
      tool_input: { branch_id: "br-dev-123" },
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("a flag-ruled mcp call logs action.decided but returns NO hook output at all (H2, same as a shell flag match)", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "mcp__vercel__promote_deployment",
      tool_input: { target: "production" },
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ data: { decision: "allow" } });
  });

  test("an mcp call matching no Rule produces no response and no log entry", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "mcp__railway__status",
      tool_input: {},
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("a non-Bash, non-mcp__ tool call is still passed through untouched", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x" },
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("an mcp call with no tool_input at all normalizes with an empty args record, never a crash", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "mcp__neon__run_sql",
      tool_input: {},
    });

    // No branch_id at all → unsafe (absent is never safe) → still denies.
    expect(response?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("UserPromptSubmit (ticket 14): a pure activity signal, once per turn", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-claude-promptsubmit-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("appends a prompt.submitted Event for session_id, and answers with nothing at all", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "UserPromptSubmit",
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ session: "sess-1", type: "prompt.submitted", data: {} });
  });

  test("inside a subagent, logs under agent_id, never session_id", async () => {
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "UserPromptSubmit",
      agent_id: "agent-1",
    });

    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
    expect(readSessionEvents("agent-1", home)).toHaveLength(1);
  });

  test("a payload missing session_id entirely never throws — degrades silently, no Event written", async () => {
    await expect(
      handleClaudeHook(home, { hook_event_name: "UserPromptSubmit" } as never),
    ).resolves.toBeUndefined();
  });
});

describe("Notification (ticket 14): Claude Code's OWN native permission/idle signal — observed only, never a decision", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-claude-notification-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("permission_prompt appends a notification.observed Event with that kind, and answers with nothing at all", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      session: "sess-1",
      type: "notification.observed",
      data: { kind: "permission_prompt" },
    });
  });

  test("idle_prompt appends a notification.observed Event with that kind", async () => {
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
    });

    const events = readSessionEvents("sess-1", home);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "notification.observed", data: { kind: "idle_prompt" } }),
    );
  });

  test("every OTHER notification_type (Claude Code's own full matcher table) is a silent no-op — never logged, never a crash", async () => {
    for (const notificationType of ["auth_success", "agent_completed", "agent_needs_input", "elicitation_dialog"]) {
      const response = await handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "Notification",
        notification_type: notificationType,
      });
      expect(response).toBeUndefined();
    }

    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("a MISSING notification_type is also a silent no-op", async () => {
    const response = await handleClaudeHook(home, { session_id: "sess-1", hook_event_name: "Notification" });
    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("inside a subagent, logs under agent_id, never session_id", async () => {
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "Notification",
      agent_id: "agent-1",
      notification_type: "permission_prompt",
    });

    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
    expect(readSessionEvents("agent-1", home)).toHaveLength(1);
  });

  test("a payload missing session_id entirely never throws — degrades silently, no Event written", async () => {
    await expect(
      handleClaudeHook(home, { hook_event_name: "Notification", notification_type: "permission_prompt" } as never),
    ).resolves.toBeUndefined();
  });

  test("a notification_type that is not even a string (malformed payload) never throws", async () => {
    await expect(
      handleClaudeHook(home, {
        session_id: "sess-1",
        hook_event_name: "Notification",
        notification_type: 42,
      } as never),
    ).resolves.toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });
});

describe("touchSession wiring (ticket 14, AC3): every ordinary call bumps the Session's own activity marker, never an Event", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-claude-touch-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("an UNMATCHED PreToolUse call touches the Session, writing no Event at all", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/a" },
    });

    expect(response).toBeUndefined();
    expect(existsSync(sessionTouchedPath("sess-1", home))).toBe(true);
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("a MATCHED PreToolUse call touches the Session too, alongside its own action.decided Event", async () => {
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(path.join(home, "config", "policy.toml"), '[[rule]]\nmatch = "gh pr merge"\neffect = "human"\n');

    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 1" },
    });

    expect(existsSync(sessionTouchedPath("sess-1", home))).toBe(true);
    expect(readSessionEvents("sess-1", home).some((e) => e.type === "action.decided")).toBe(true);
  });

  test("an ordinary PostToolUse call (below the 25th-call sample boundary) touches the Session, writing no usage.sampled Event", async () => {
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      cwd: "/tmp/repo",
    });

    expect(response).toBeUndefined();
    expect(existsSync(sessionTouchedPath("sess-1", home))).toBe(true);
    // The M6 backfill's session.started is the ONLY Event — never usage.sampled this early.
    expect(readSessionEvents("sess-1", home).some((e) => e.type === "usage.sampled")).toBe(false);
  });

  test("a Stop call with no transcript still touches the Session — closes ticket 13's own 'Stop with no transcript' no-frame gap", async () => {
    const response = await handleClaudeHook(home, { session_id: "sess-1", hook_event_name: "Stop" });

    expect(response).toBeUndefined();
    expect(existsSync(sessionTouchedPath("sess-1", home))).toBe(true);
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("touches are scoped per Session — a subagent's touch never lands on its parent's marker", async () => {
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "PostToolUse",
      agent_id: "agent-1",
      cwd: "/tmp/repo",
    });

    expect(existsSync(sessionTouchedPath("agent-1", home))).toBe(true);
    expect(existsSync(sessionTouchedPath("sess-1", home))).toBe(false);
  });

  test("a later call moves the touch file's own mtime forward", async () => {
    await handleClaudeHook(home, { session_id: "sess-1", hook_event_name: "PostToolUse", cwd: "/tmp/repo" });
    const first = statSync(sessionTouchedPath("sess-1", home)).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 20));
    await handleClaudeHook(home, { session_id: "sess-1", hook_event_name: "PostToolUse", cwd: "/tmp/repo" });
    const second = statSync(sessionTouchedPath("sess-1", home)).mtimeMs;

    expect(second).toBeGreaterThanOrEqual(first);
  });
});
