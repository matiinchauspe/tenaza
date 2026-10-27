import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { STATUSLINE_PASTE_LINE } from "../src/init";
import { readNotificationRecorder } from "../src/notify";
import { policyPath } from "../src/paths";
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

  describe("rule matching (ticket 03, decision 02, ADR 0006): a Rule matches an EXECUTED command, not raw text", () => {
    test("a wrapped launcher still denies with no launcher table: timeout 60 gh pr merge 58", async () => {
      await deny("timeout 60 gh pr merge 58");

      const status = await runCli(["status"], { home });
      expect(status.stdout).toContain("#1");
    });

    test("sudo gh pr merge 58 still denies, the same way", async () => {
      await deny("sudo gh pr merge 58");

      const status = await runCli(["status"], { home });
      expect(status.stdout).toContain("#1");
    });

    test("bash -c re-parses its script string and still denies", async () => {
      await deny('bash -c "gh pr merge 58"');

      const status = await runCli(["status"], { home });
      expect(status.stdout).toContain("#1");
    });

    test("eval re-parses its argument and still denies", async () => {
      await deny('eval "gh pr merge 58"');

      const status = await runCli(["status"], { home });
      expect(status.stdout).toContain("#1");
    });

    test("a $(...) command substitution is its own candidate and still denies", async () => {
      await deny("echo $(gh pr merge 58)");

      const status = await runCli(["status"], { home });
      expect(status.stdout).toContain("#1");
    });

    test("a backtick substitution still denies", async () => {
      await deny("echo `gh pr merge 58`");

      const status = await runCli(["status"], { home });
      expect(status.stdout).toContain("#1");
    });

    /**
     * The five live false positives recorded while charting this map
     * (map.md's Problem section; decision 02's Log) — a quoted string and a
     * heredoc body are data, never an executed command's own words. Each
     * one is reconstructed from what the Log and the research note
     * describe, not replayed byte-for-byte (none of those sessions recorded
     * the literal command text verbatim) — the regression is the SHAPE of
     * the false positive, which this asserts directly.
     */
    describe("the five recorded live false positives never deny", () => {
      test("the reviewer's rg: a search that only mentions the words inside a quoted string", async () => {
        const result = await runCli(["hook", "claude"], {
          home,
          stdin: JSON.stringify({
            session_id: "sess-1",
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: 'rg "gh pr merge"' },
          }),
        });

        expect(result.stdout.trim()).toBe("");
        const status = await runCli(["status"], { home });
        expect(status.stdout).not.toContain("#1");
      });

      test("inbox #2: a heredoc writing a ticket file whose text names the reserved command", async () => {
        await deny(
          "cat <<'EOF' > ticket.md\n" +
            "Blocked by: none. The example command is gh pr merge, written here as data.\n" +
            "EOF\n",
        );

        const status = await runCli(["status"], { home });
        expect(status.stdout).not.toContain("#1");
      });

      test("inbox #4: a heredoc writing the Tenaza handoff, whose text names the reserved command", async () => {
        await deny(
          "cat <<'EOF' > handoff.md\n" +
            "Pending by hand: one gh pr merge answered live, one left to lapse into pending.\n" +
            "EOF\n",
        );

        const status = await runCli(["status"], { home });
        expect(status.stdout).not.toContain("#1");
      });

      test("inbox #5: a heredoc writing a benchmark fixture, whose text names the reserved command", async () => {
        await deny(
          "cat <<'EOF' > bench-fixture.md\n" +
            "The fixture below uses gh pr merge as an example no shipped Rule should catch here.\n" +
            "EOF\n",
        );

        const status = await runCli(["status"], { home });
        expect(status.stdout).not.toContain("#1");
      });

      test("a commit message that only names the reserved command is data too (User Story 4)", async () => {
        await deny('git commit -m "docs: mention gh pr merge and git worktree remove as examples"');

        const status = await runCli(["status"], { home });
        expect(status.stdout).not.toContain("#1");
      });
    });

    test("a parse failure falls back to the v0.1 substring match and records reason parse_error", async () => {
      await deny('echo "unterminated gh pr merge');

      const status = await runCli(["status"], { home });
      expect(status.stdout).toContain("#1");

      const { EventSchema } = await import("../src/contract/event");
      const raw = await Bun.file(path.join(home, "state", "sessions", "sess-1.jsonl")).text();
      const events = raw
        .trim()
        .split("\n")
        .map((line) => EventSchema.parse(JSON.parse(line)));
      const decided = events.find((event) => event.type === "action.decided");
      const reason =
        decided?.type === "action.decided" && "reason" in decided.data.rule ? decided.data.rule.reason : undefined;
      expect(reason).toBe("parse_error");
    });

    test("a parse failure with nothing matching by raw substring either is allowed, not a crash", async () => {
      const result = await runCli(["hook", "claude"], {
        home,
        stdin: JSON.stringify({
          session_id: "sess-1",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: 'echo "unterminated and unrelated' },
        }),
      });

      expect(result.exitCode).toBe(0);
      const status = await runCli(["status"], { home });
      expect(status.stdout).not.toContain("#1");
    });

    test("a NESTED bash -c that fails to parse is a full parse failure, not a silent drop of that layer (orchestrator review)", async () => {
      // The outer `bash -c '...'` parses cleanly; only the WRAPPED script
      // (`gh pr merge 58; if`, a dangling `if`) fails. Before the fix, the
      // outer argv kept the whole thing as one quoted token and the Rule
      // never matched — allowed, where v0.1's raw substring denied it.
      await deny("bash -c 'gh pr merge 58; if'");

      const status = await runCli(["status"], { home });
      expect(status.stdout).toContain("#1");

      const { EventSchema } = await import("../src/contract/event");
      const raw = await Bun.file(path.join(home, "state", "sessions", "sess-1.jsonl")).text();
      const decided = raw
        .trim()
        .split("\n")
        .map((line) => EventSchema.parse(JSON.parse(line)))
        .find((event) => event.type === "action.decided");
      const reason =
        decided?.type === "action.decided" && "reason" in decided.data.rule ? decided.data.rule.reason : undefined;
      expect(reason).toBe("parse_error");
    });

    test("a 4-deep nested bash -c still denies — hitting the reparse depth cap falls back to the raw substring, never a false allow", async () => {
      // Each level is single-quoted via the standard close/insert/reopen
      // idiom (`'"'"'`), so this is valid bash at every depth (verified by
      // actually round-tripping it through a real bash subprocess while
      // building this fixture). MAX_REPARSE_DEPTH allows 3 successful
      // unwraps, so the 4th layer is left unresolved on purpose.
      const singleQuote = (text: string): string => `'${text.split("'").join(`'"'"'`)}'`;
      let script = "gh pr merge 58";
      for (let depth = 0; depth < 4; depth++) script = `bash -c ${singleQuote(script)}`;

      await deny(script);

      const status = await runCli(["status"], { home });
      expect(status.stdout).toContain("#1");
    });
  });

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

  test("the real `tenaza label` invocation only exits 0 — it never does the labeling itself", async () => {
    const result = await runCli(["label", "ticket=RES-131", "project=reservee"], { home });

    expect(result.exitCode).toBe(0);
    // the real CLI subprocess has no agent_id/session_id to act on — the
    // PreToolUse hook is what actually writes session.labeled (ADR 0003) —
    // so this invocation alone must leave no Session log behind at all.
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(home, "state", "sessions"))).toBe(false);
  });

  test("`tenaza label` with no args, or any args, still exits 0", async () => {
    const result = await runCli(["label"], { home });
    expect(result.exitCode).toBe(0);
  });

  test("hook claude on a `tenaza label` command inside a subagent labels agent_id's Session, project groups it, and status shows the ticket Label on the row (AC1, AC2)", async () => {
    await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "tenaza label ticket=RES-131 project=reservee" },
        agent_id: "agent-1",
      }),
    });
    await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({ session_id: "sess-1", hook_event_name: "SubagentStart", agent_id: "agent-1", cwd: "/workspace" }),
    });

    const status = await runCli(["status"], { home });

    expect(status.stdout).toContain("reservee");
    expect(status.stdout).toContain("RES-131");
    expect(status.stdout).toContain("agent-1");
  });

  test("a later announce adds and overrides keys on the same Session; earlier keys remain (AC4)", async () => {
    const announce = (command: string) =>
      runCli(["hook", "claude"], {
        home,
        stdin: JSON.stringify({
          session_id: "sess-1",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
        }),
      });

    await announce("tenaza label ticket=RES-131");
    await announce("tenaza label project=reservee");
    await announce("tenaza label ticket=RES-200");

    const { readSessionEvents } = await import("../src/log");
    const { buildSessionIndex } = await import("../src/sessions");
    const events = readSessionEvents("sess-1", home);
    const index = buildSessionIndex(events);

    // ticket overridden to the latest value; project from the earlier
    // announce remains untouched by the later one.
    expect(index.get("sess-1")?.labels).toEqual({ ticket: "RES-200", project: "reservee" });
  });

  describe("mcp Rules (ticket 04, decision 07), at the hook claude black-box seam", () => {
    beforeEach(() => {
      writeFileSync(
        path.join(home, "config", "policy.toml"),
        `
[[rule]]
tool = "mcp__*neon*__run_sql*"
unless = { branch_id = ["br-dev-123", "br-staging-456"] }
effect = "human"

[[rule]]
tool = "mcp__*vercel*"
when = { target = "production" }
effect = "human"

[[rule]]
tool = "mcp__*__write*"
unless = { tables = ["sandbox"] }
effect = "human"

[[rule]]
tool = "mcp__*postgres*__query*"
unless = { "connection.branch_id" = ["br-dev-123"] }
effect = "human"

[[rule]]
tool = "mcp__*railway*"
effect = "flag"
`,
      );
    });

    async function mcpCall(tool: string, args: Record<string, unknown>, session = "sess-1") {
      return await runCli(["hook", "claude"], {
        home,
        stdin: JSON.stringify({
          session_id: session,
          hook_event_name: "PreToolUse",
          tool_name: tool,
          tool_input: args,
        }),
      });
    }

    test("the tool-name glob: an unrelated tool is allowed and not logged", async () => {
      const result = await mcpCall("mcp__railway__status", {});

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
      const status = await runCli(["status"], { home });
      expect(status.stdout).not.toContain("#1");
    });

    test("unless: an ABSENT branch_id matches — the Neon default-branch-is-prod case", async () => {
      const result = await mcpCall("mcp__neon__run_sql", { sql: "select 1" });

      expect(result.exitCode).toBe(0);
      const response = JSON.parse(result.stdout);
      expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
      const status = await runCli(["status"], { home });
      expect(status.stdout).toContain("#1  mcp__neon__run_sql");
    });

    test("unless: a SAFE branch_id exempts the call — no block, no log", async () => {
      const result = await mcpCall("mcp__neon__run_sql", { branch_id: "br-dev-123" });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
      const status = await runCli(["status"], { home });
      expect(status.stdout).not.toContain("#1");
    });

    test("unless: an UNSAFE branch_id still matches and denies", async () => {
      const result = await mcpCall("mcp__neon__run_sql", { branch_id: "br-prod-999" });

      const response = JSON.parse(result.stdout);
      expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
    });

    test("when: the Rule matches only when the argument equals the given value", async () => {
      const prod = await mcpCall("mcp__vercel__promote_deployment", { target: "production" });
      expect(JSON.parse(prod.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

      const preview = await mcpCall("mcp__vercel__promote_deployment", { target: "preview" });
      expect(preview.stdout.trim()).toBe("");
    });

    test("dotted paths reach a nested argument", async () => {
      const safe = await mcpCall("mcp__postgres__query", { connection: { branch_id: "br-dev-123" } });
      expect(safe.stdout.trim()).toBe(""); // nested branch_id is safe — exempted

      const unsafe = await mcpCall("mcp__postgres__query", { connection: { branch_id: "br-prod" } });
      expect(JSON.parse(unsafe.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    });

    test("an array argument matches `unless` if ANY element is a safe value", async () => {
      const result = await mcpCall("mcp__db__write", { tables: ["orders", "sandbox"] });

      expect(result.stdout.trim()).toBe(""); // "sandbox" exempts the whole call
    });

    test("an array argument WITHOUT the safe value still matches", async () => {
      const result = await mcpCall("mcp__db__write", { tables: ["orders", "users"] });

      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    });

    test("a flag-ruled mcp call records the Action but returns NO hook output at all (H2)", async () => {
      const result = await mcpCall("mcp__railway__run", { command: "deploy" });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");

      const { readSessionEvents } = await import("../src/log");
      const events = readSessionEvents("sess-1", home);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ data: { decision: "allow" } });
    });

    test("status shows an mcp Inbox item as tool name + a short args summary, never crashing", async () => {
      await mcpCall("mcp__neon__run_sql", { branch_id: "br-prod" });

      const status = await runCli(["status"], { home });
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("#1  mcp__neon__run_sql  branch_id=br-prod");
    });

    test("tenaza run on an mcp Inbox item refuses cleanly — a CLI message, never a throw", async () => {
      await mcpCall("mcp__neon__run_sql", { branch_id: "br-prod" });

      const result = await runCli(["run", "1"], { home });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain("mcp");
      expect(result.stderr.toLowerCase()).toContain("tenaza done");
    });

    test("tenaza done closes an mcp Inbox item", async () => {
      await mcpCall("mcp__neon__run_sql", { branch_id: "br-prod" });

      const result = await runCli(["done", "1"], { home });

      expect(result.exitCode).toBe(0);
      const status = await runCli(["status"], { home });
      expect(status.stdout).not.toContain("#1");
    });

    test("tenaza dismiss closes an mcp Inbox item", async () => {
      await mcpCall("mcp__neon__run_sql", { branch_id: "br-prod" });

      const result = await runCli(["dismiss", "1"], { home });

      expect(result.exitCode).toBe(0);
      const status = await runCli(["status"], { home });
      expect(status.stdout).not.toContain("#1");
    });
  });

  describe("statusline (ticket 07)", () => {
    test("a fresh home prints the calm form", async () => {
      const result = await runCli(["statusline"], { home });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("tenaza │ ● 0 vivas · ⚑ 0 · ✉ 0\n");
    });

    test("accepts the statusline JSON on stdin without failing, and ignores fields it does not use (AC3)", async () => {
      const payload = JSON.stringify({
        hook_event_name: "Status",
        session_id: "claude-cli-session",
        model: { id: "claude-x", display_name: "Claude X" },
        workspace: { current_dir: "/some/where" },
        cost: { total_cost_usd: 0.42 },
      });

      const result = await runCli(["statusline"], { home, stdin: payload });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("tenaza │ ● 0 vivas · ⚑ 0 · ✉ 0");
    });

    test("malformed / non-JSON stdin never crashes it either — tenaza derives its own state, never the caller's", async () => {
      const result = await runCli(["statusline"], { home, stdin: "not json at all {{{" });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("tenaza │ ● 0 vivas · ⚑ 0 · ✉ 0");
    });

    test("with two open items, names the most urgent (most recent) one and counts both (AC1)", async () => {
      await deny("false", "sess-1");
      await deny("gh pr merge 58", "sess-2");

      const result = await runCli(["statusline"], { home });

      expect(result.stdout.trim()).toBe("tenaza │ ● 2 vivas · ⚑ 0 · ✉ 2 → #2 gh pr merge");
    });

    test("counts always agree with `tenaza status` for the same state (AC4)", async () => {
      await deny("false", "sess-1");
      await deny("gh pr merge 58", "sess-2");
      await runCli(["done", "1"], { home });

      const [statusResult, statuslineResult] = await Promise.all([
        runCli(["status"], { home }),
        runCli(["statusline"], { home }),
      ]);

      const inboxLinesInStatus = statusResult.stdout
        .split("\n")
        .filter((line) => /^\s*#\d/.test(line)).length;
      const inboxCountInStatusline = Number(statuslineResult.stdout.match(/✉ (\d+)/)?.[1]);

      expect(inboxCountInStatusline).toBe(inboxLinesInStatus);
      expect(inboxCountInStatusline).toBe(1);
      expect(statuslineResult.stdout.trim()).toBe("tenaza │ ● 2 vivas · ⚑ 0 · ✉ 1 → #2 gh pr merge");
    });

    test("an unblocked Inbox item (hook fake, no block Capability) still counts toward ✉", async () => {
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "start", session: "fake-1", cwd: "/tmp/fake" }),
      });
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "action", session: "fake-1", command: "gh pr merge 58" }),
      });

      const result = await runCli(["statusline"], { home });

      expect(result.stdout.trim()).toContain("✉ 1 → #1 gh pr merge");
    });
  });

  describe("hook fake (ADR 0001, ticket 06: proves the core degrades by Capability, never by runtime name)", () => {
    test("a Session from the fake Adapter (no measure) shows 'sin datos' in the tree — no bar, no ⚑ (AC1)", async () => {
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "start", session: "fake-1", cwd: "/tmp/fake" }),
      });

      const status = await runCli(["status"], { home });

      const line = status.stdout.split("\n").find((l) => l.includes("fake-1"));
      expect(line).toContain("sin datos");
      expect(line).not.toContain("⚑");
    });

    test("without block, a human-ruled command is NOT denied — the printed response is allow, not deny (AC2)", async () => {
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "start", session: "fake-1", cwd: "/tmp/fake" }),
      });

      const result = await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "action", session: "fake-1", command: "gh pr merge 58" }),
      });

      expect(result.exitCode).toBe(0);
      const response = JSON.parse(result.stdout);
      expect(response.decision).toBe("allow");
    });

    test("that same unenforceable human match is still RECORDED and SURFACED in the Inbox, not silently dropped (AC2)", async () => {
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "start", session: "fake-1", cwd: "/tmp/fake" }),
      });
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "action", session: "fake-1", command: "gh pr merge 58" }),
      });

      const status = await runCli(["status"], { home });

      expect(status.stdout).toContain("#1  fake: gh pr merge 58");
      expect(status.stdout).toContain("ya corrió");
    });

    test("run REFUSES an unblocked item — never executes the command a second time, exits non-zero, es-AR message naming done/dismiss", async () => {
      const marker = path.join(home, "marker");
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "start", session: "fake-1", cwd: "/tmp/fake" }),
      });
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({
          kind: "action",
          session: "fake-1",
          command: `gh pr merge 58 && touch ${marker}`,
        }),
      });

      const result = await runCli(["run", "1"], { home });

      expect(result.exitCode).not.toBe(0);
      const { existsSync } = await import("node:fs");
      expect(existsSync(marker)).toBe(false);
      expect(result.stderr).toContain("ya corrió");
      expect(result.stderr).toContain("no se pudo bloquear");
      expect(result.stderr).toContain("tenaza done 1");
      expect(result.stderr).toContain("tenaza dismiss 1");

      // refusing to run is not a resolution — the item stays open afterward
      const status = await runCli(["status"], { home });
      expect(status.stdout).toContain("#1");
    });

    test("done still closes an unblocked item, exactly as for a blocked one", async () => {
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "start", session: "fake-1", cwd: "/tmp/fake" }),
      });
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "action", session: "fake-1", command: "gh pr merge 58" }),
      });

      const result = await runCli(["done", "1"], { home });

      expect(result.exitCode).toBe(0);
      const status = await runCli(["status"], { home });
      expect(status.stdout).not.toContain("#1");
    });

    test("dismiss still closes an unblocked item, exactly as for a blocked one", async () => {
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "start", session: "fake-1", cwd: "/tmp/fake" }),
      });
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "action", session: "fake-1", command: "gh pr merge 58" }),
      });

      const result = await runCli(["dismiss", "1"], { home });

      expect(result.exitCode).toBe(0);
      const status = await runCli(["status"], { home });
      expect(status.stdout).not.toContain("#1");
    });

    test("the SAME command through the Claude Adapter (declares block) IS denied — the two Adapters diverge only by Capability, never by a hardcoded name", async () => {
      const result = await runCli(["hook", "claude"], {
        home,
        stdin: JSON.stringify({
          session_id: "sess-1",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "gh pr merge 58" },
        }),
      });

      const response = JSON.parse(result.stdout);
      expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
    });
  });

  describe("notifications (ticket 08, end to end through the real hook subprocess)", () => {
    test("a denied Bash command sends exactly one 🟡, matching the spec's own worked example format", async () => {
      // Label the Session first, the same way Yunque would announce it, so
      // the subtitle reproduces the spec's own worked example verbatim.
      await runCli(["hook", "claude"], {
        home,
        stdin: JSON.stringify({
          session_id: "b71",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "tenaza label project=reservee ticket=RES-131" },
        }),
      });

      await deny("gh pr merge 58 --merge", "b71");

      const notifications = readNotificationRecorder(home);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        tag: "inbox-1",
        title: "🟡 Tenaza · te espera · inbox #1",
        subtitle: "reservee / RES-131 / sesión b71",
        message: "Bash: gh pr merge 58 --merge · tenaza run 1",
      });
    });

    test("an unblocked match (hook fake, ADR 0001) still sends one 🟡, but never invites a second `tenaza run`", async () => {
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "start", session: "fake-1", cwd: "/tmp/fake" }),
      });
      await runCli(["hook", "fake"], {
        home,
        stdin: JSON.stringify({ kind: "action", session: "fake-1", command: "gh pr merge 58" }),
      });

      const notifications = readNotificationRecorder(home);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.message).toContain("ya corrió");
      expect(notifications[0]?.message).not.toContain("tenaza run");
    });

    test("three denies in a row produce three 🟡 but only one sound (AC5: burst window)", async () => {
      await deny("gh pr merge 1");
      await deny("gh pr merge 2");
      await deny("gh pr merge 3");

      const notifications = readNotificationRecorder(home);
      expect(notifications).toHaveLength(3);
      expect(notifications.filter((n) => n.sound)).toHaveLength(1);
      expect(notifications[0]?.sound).toBe(true);
    });

    test("resolving an item (run/done/dismiss) sends nothing — only opening one does", async () => {
      await deny("true");
      expect(readNotificationRecorder(home)).toHaveLength(1); // the open itself

      await runCli(["run", "1"], { home });

      expect(readNotificationRecorder(home)).toHaveLength(1); // unchanged by the resolution
    });

    test("an unmatched command never notifies", async () => {
      await runCli(["hook", "claude"], {
        home,
        stdin: JSON.stringify({
          session_id: "sess-1",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "ls -la" },
        }),
      });

      expect(readNotificationRecorder(home)).toEqual([]);
    });
  });
});

describe("tenaza init (black box, temporary TENAZA_HOME + fake Claude settings)", () => {
  let home: string;
  let settingsPath: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-init-cli-home-"));
    const settingsDir = mkdtempSync(path.join(tmpdir(), "tenaza-init-cli-settings-"));
    settingsPath = path.join(settingsDir, "settings.json");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(settingsPath), { recursive: true, force: true });
  });

  test("AC1: on a clean TENAZA_HOME, the Policy init writes blocks `gh pr merge` through the hook seam", async () => {
    const initResult = await runCli(["init"], { home, env: { TENAZA_CLAUDE_SETTINGS: settingsPath } });
    expect(initResult.exitCode).toBe(0);
    expect(existsSync(policyPath(home))).toBe(true);

    const hookResult = await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 58 --merge" },
      }),
    });

    expect(hookResult.exitCode).toBe(0);
    const response = JSON.parse(hookResult.stdout);
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(response.hookSpecificOutput.permissionDecisionReason).toContain("inbox #1");
  });

  test("AC2: an existing policy.toml is never overwritten by init", async () => {
    mkdirSync(path.dirname(policyPath(home)), { recursive: true });
    const handEdited = "# hand-edited, do not touch\n";
    writeFileSync(policyPath(home), handEdited);

    const result = await runCli(["init"], { home, env: { TENAZA_CLAUDE_SETTINGS: settingsPath } });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(policyPath(home), "utf8")).toBe(handEdited);
  });

  test("AC3: with no statusLine set, init sets it", async () => {
    const result = await runCli(["init"], { home, env: { TENAZA_CLAUDE_SETTINGS: settingsPath } });

    expect(result.exitCode).toBe(0);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.statusLine).toEqual({ type: "command", command: STATUSLINE_PASTE_LINE });
  });

  test("AC3: with a statusLine already set, init leaves the settings file byte-identical and prints the guarded line", async () => {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const existing = '{\n  "statusLine": {\n    "type": "command",\n    "command": "my-own-script.sh"\n  }\n}\n';
    writeFileSync(settingsPath, existing);

    const result = await runCli(["init"], { home, env: { TENAZA_CLAUDE_SETTINGS: settingsPath } });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("command -v tenaza >/dev/null && tenaza statusline");
    expect(readFileSync(settingsPath, "utf8")).toBe(existing);
  });

  test("AC4: running init twice changes nothing the second time", async () => {
    await runCli(["init"], { home, env: { TENAZA_CLAUDE_SETTINGS: settingsPath } });
    const policyAfterFirst = readFileSync(policyPath(home), "utf8");
    const settingsAfterFirst = readFileSync(settingsPath, "utf8");

    const second = await runCli(["init"], { home, env: { TENAZA_CLAUDE_SETTINGS: settingsPath } });

    expect(second.exitCode).toBe(0);
    expect(readFileSync(policyPath(home), "utf8")).toBe(policyAfterFirst);
    expect(readFileSync(settingsPath, "utf8")).toBe(settingsAfterFirst);
  });
});
