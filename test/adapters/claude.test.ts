import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleClaudeHook } from "../../src/adapters/claude";
import { liveAnsweredEvent } from "../../src/contract/event";
import { writeAlive } from "../../src/daemonlink";
import { decideAction } from "../../src/decide";
import { inboxIdentityHash } from "../../src/identity";
import { appendHumanEvent, readSessionEvents } from "../../src/log";
import { readNotificationRecorder } from "../../src/notify";
import { renderSessionTree } from "../../src/sessions";

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
    const response = await handleClaudeHook(home, {
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
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      agent_transcript_path: fixture("above-threshold.jsonl"),
    });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
    const events = readSessionEvents("agent-1", home);
    expect(events).toHaveLength(2);
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
    const response = await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      transcript_path: fixture("above-threshold.jsonl"),
    });

    expect(response).toBeUndefined();
    const events = readSessionEvents("agent-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("session.ended");
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

  test("SubagentStop with cwd + agent_transcript_path and NOTHING else stays hidden from status — exactly the side-agent signature isNoiseSession hides", async () => {
    await handleClaudeHook(home, {
      session_id: "sess-1",
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      cwd: "/repos/some-project",
      agent_transcript_path: fixture("below-threshold.jsonl"),
    });

    const events = readSessionEvents("agent-1", home);
    expect(events.map((e) => e.type).sort()).toEqual(["session.ended", "usage.sampled"]);
    expect(events.some((e) => e.type === "session.started")).toBe(false);
    expect(renderSessionTree(home)).not.toContain("agent-1");
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
