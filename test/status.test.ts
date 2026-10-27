import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideAction } from "../src/decide";
import { inboxIdentityHash } from "../src/identity";
import { appendEvent } from "../src/log";
import { renderStatus } from "../src/status";
import { mkdirSync, writeFileSync } from "node:fs";
import { sessionEndedEvent, sessionStartedEvent } from "../src/contract/event";

/** A single Inbox item's own display id is always the minimum 4-char prefix of its hash (decision 03, ADR 0005, ticket 06) — there's nothing else in these tests for it to collide with. */
function shortId(session: string, line: number): string {
  return inboxIdentityHash(session, line).slice(0, 4);
}

describe("renderStatus", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-status-"));
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      path.join(home, "config", "policy.toml"),
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

  test("an empty Inbox reads as empty, not absent", async () => {
    expect(renderStatus(home)).toContain("Inbox");
  });

  test("lists a denied Action as `<id>  Bash: command`", async () => {
    await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });

    const output = renderStatus(home);
    expect(output).toContain(`${shortId("sess-1", 1)}  Bash: gh pr merge 58`);
  });

  test("a fresh home with no observed Session renders no tree — just the Inbox, as before", async () => {
    const output = renderStatus(home);
    expect(output).toBe("Inbox: (empty)\n");
  });

  test("lists a denied mcp Action as `<id>  tool  args-summary`, never crashing (ticket 04)", async () => {
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[[rule]]
tool = "mcp__*neon*__run_sql*"
unless = { branch_id = ["br-dev"] }
effect = "human"
`,
    );

    await decideAction(home, "sess-1", {
      kind: "mcp",
      tool: "mcp__neon__run_sql",
      args: { branch_id: "br-prod" },
    });

    const output = renderStatus(home);
    expect(output).toContain(`${shortId("sess-1", 1)}  mcp__neon__run_sql  branch_id=br-prod`);
  });

  test("the Session tree renders above the Inbox, both present together", async () => {
    appendEvent(
      home,
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/scratch", capabilities: ["observe", "block"] }),
    );
    await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });

    const output = renderStatus(home);

    const treeIndex = output.indexOf("/tmp/scratch");
    const inboxIndex = output.indexOf("Inbox:");
    expect(treeIndex).toBeGreaterThanOrEqual(0);
    expect(inboxIndex).toBeGreaterThan(treeIndex);
    // The `session.started` appended above lands on line 1 of sess-1's own
    // log, so the deny's `action.decided` lands on line 2.
    expect(output).toContain(`${shortId("sess-1", 2)}  Bash: gh pr merge 58`);
  });

  test("an ENDED Session reads ended in the tree; its open Inbox item still shows in the Inbox on its own (ticket 05, #1436's stale 'te espera' fix)", async () => {
    // The real dogfood bug (2026-10-25, engram #1436: Session '55e06de1'):
    // the Session triggers a human-Rule match (denied), then ends normally
    // — but the tree kept reading "⏸ te espera" forever because the open
    // Inbox item outranked `endedAt`. Fixed: the tree shows "cerró"; the
    // Inbox block lists the item regardless, completely independently.
    appendEvent(
      home,
      sessionStartedEvent("55e06de1", { runtime: "claude", cwd: "/tmp/scratch", capabilities: ["observe", "block"] }),
    );
    await decideAction(home, "55e06de1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });
    appendEvent(home, sessionEndedEvent("55e06de1", "clear"));

    const output = renderStatus(home);

    const treeLine = output.split("\n").find((line) => line.includes("55e06de1"))!;
    expect(treeLine).toContain("cerró");
    expect(treeLine).not.toContain("te espera");
    expect(treeLine).not.toContain("⏸");
    expect(output).toContain("Inbox:");
    // Same shift: `session.started` is line 1, the deny is line 2.
    expect(output).toContain(`${shortId("55e06de1", 2)}  Bash: gh pr merge 58`);
  });
});
