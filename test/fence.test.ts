import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideAction } from "../src/decide";
import { matchesBuiltInFence } from "../src/fence";
import { deriveInbox } from "../src/inbox";
import { readSessionEvents } from "../src/log";
import { DEFAULT_DAEMON_PORT } from "../src/paths";
import { runCli } from "./support/cli";

function shell(command: string) {
  return { kind: "shell" as const, command, tool: "Bash" };
}

describe("matchesBuiltInFence (decision 05, ticket 09) — pure, POSITIVE cases", () => {
  test("reading the token file, bare tilde path", () => {
    expect(matchesBuiltInFence(shell("cat ~/.tenaza/state/daemon.token"))).toBe(true);
  });

  test("reading the token file through $TENAZA_HOME, quoted", () => {
    expect(matchesBuiltInFence(shell('cat "$TENAZA_HOME/state/daemon.token"'))).toBe(true);
  });

  test("reading the token file through an absolute TENAZA_HOME", () => {
    expect(matchesBuiltInFence(shell("cat /Users/mati/custom-home/state/daemon.token"))).toBe(true);
  });

  test("a write route — the Daemon's own origin, http scheme, POST method", () => {
    expect(
      matchesBuiltInFence(shell(`curl -X POST http://127.0.0.1:${DEFAULT_DAEMON_PORT}/items/abc/run`)),
    ).toBe(true);
  });

  test("a write route — localhost, no scheme", () => {
    expect(matchesBuiltInFence(shell(`curl localhost:${DEFAULT_DAEMON_PORT}/items/abc/dismiss`))).toBe(true);
  });

  test("a write route — the done action", () => {
    expect(matchesBuiltInFence(shell(`curl http://127.0.0.1:${DEFAULT_DAEMON_PORT}/items/deadbeef/done`))).toBe(
      true,
    );
  });

  test("a write route — the IPv6 loopback bracket form", () => {
    expect(matchesBuiltInFence(shell(`curl http://[::1]:${DEFAULT_DAEMON_PORT}/items/abc/run`))).toBe(true);
  });

  test("ticket 10: a write route — the answer action (live approve/reject from the browser)", () => {
    expect(
      matchesBuiltInFence(shell(`curl -X POST http://127.0.0.1:${DEFAULT_DAEMON_PORT}/items/abc/answer`)),
    ).toBe(true);
  });
});

describe("matchesBuiltInFence — NEGATIVE cases (must NOT match — ordinary work, never fenced)", () => {
  test("listing an unrelated src/items/ directory", () => {
    expect(matchesBuiltInFence(shell("ls src/items/"))).toBe(false);
  });

  test("curl against a third-party REST API with its own /items/ path", () => {
    expect(matchesBuiltInFence(shell("curl https://api.example.com/items/1"))).toBe(false);
  });

  test("curl against the Daemon's host but a DIFFERENT port — never fenced (known, accepted miss)", () => {
    expect(matchesBuiltInFence(shell("curl http://127.0.0.1:3000/items/1/run"))).toBe(false);
  });

  test("grepping the bare word daemon.token while developing Tenaza itself", () => {
    expect(matchesBuiltInFence(shell("rg -n daemon.token src/"))).toBe(false);
  });

  test("reading an unrelated source file named daemon.ts", () => {
    expect(matchesBuiltInFence(shell("bat src/daemon.ts"))).toBe(false);
  });

  test("an ordinary command matches nothing at all", () => {
    expect(matchesBuiltInFence(shell("gh pr merge 58"))).toBe(false);
    expect(matchesBuiltInFence(shell("pnpm run build"))).toBe(false);
  });

  test("an mcp Action never matches — this fence is shell-only", () => {
    expect(
      matchesBuiltInFence({ kind: "mcp", tool: "mcp__neon__run_sql", args: { q: "daemon.token" } }),
    ).toBe(false);
  });
});

describe("the built-in fence through decideAction (ticket 09) — ALWAYS on, independent of policy.toml", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-fence-"));
    // Deliberately NO policy.toml at all — proves the fence is not a
    // policy.toml Rule and fires even with zero configured Rules.
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("reading daemon.token is denied and lands in the Inbox, with no policy.toml present", async () => {
    const result = await decideAction(home, "sess-1", shell("cat ~/.tenaza/state/daemon.token"));

    expect(result.decision).toBe("deny");
    expect(deriveInbox(home)).toHaveLength(1);

    const events = readSessionEvents("sess-1", home);
    expect(events[0]).toMatchObject({ type: "action.decided", data: { decision: "deny" } });
  });

  test("hitting a write route on the Daemon's own port is denied and lands in the Inbox", async () => {
    const result = await decideAction(
      home,
      "sess-1",
      shell(`curl -s -X POST http://127.0.0.1:${DEFAULT_DAEMON_PORT}/items/deadbeef/done`),
    );

    expect(result.decision).toBe("deny");
    expect(deriveInbox(home)).toHaveLength(1);
  });

  test("an unrelated command matches nothing and is never logged", async () => {
    const result = await decideAction(home, "sess-1", shell("ls -la"));

    expect(result.decision).toBe("allow");
    expect(result.logged).toBe(false);
    expect(deriveInbox(home)).toHaveLength(0);
  });

  test("ordinary work the fence must NEVER block: listing an unrelated items/ dir, grepping daemon.token, a different port", async () => {
    for (const command of [
      "ls src/items/",
      "curl https://api.example.com/items/1",
      "curl http://127.0.0.1:3000/items/1/run",
      "rg -n daemon.token src/",
      "bat src/daemon.ts",
    ]) {
      const result = await decideAction(home, "sess-1", shell(command));
      expect(result.decision).toBe("allow");
      expect(result.logged).toBe(false);
    }
    expect(deriveInbox(home)).toHaveLength(0);
  });
});

describe("the built-in fence at the hook seam (ticket 09's own AC)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-fence-hook-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("tenaza hook claude denies a Bash call reading daemon.token, with no policy.toml at all", async () => {
    const result = await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "cat ~/.tenaza/state/daemon.token" },
      }),
    });

    expect(result.exitCode).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(response.hookSpecificOutput.permissionDecisionReason).toContain("inbox");
  });

  test("tenaza hook claude denies a Bash call targeting a write route on the Daemon's own port", async () => {
    const result = await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `curl -X POST http://127.0.0.1:${DEFAULT_DAEMON_PORT}/items/abc123/run` },
      }),
    });

    expect(result.exitCode).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("an ordinary Bash call is unaffected — no hookSpecificOutput at all", async () => {
    const result = await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm run build" },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  test("ordinary work naming /items/ or daemon.token in passing is unaffected at the hook seam too", async () => {
    const result = await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rg -n daemon.token src/" },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});
