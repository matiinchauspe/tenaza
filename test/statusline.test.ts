import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  actionDecidedEvent,
  sessionEndedEvent,
  sessionStartedEvent,
  usageSampledEvent,
} from "../src/contract/event";
import { GREEN, RED, RESET } from "../src/contextbar";
import { writeAlive } from "../src/daemonlink";
import { recordDegraded, recordHealthy } from "../src/health";
import { inboxIdentityHash } from "../src/identity";
import { shortIdIndex } from "../src/inbox";
import { appendEvent } from "../src/log";
import { deriveStatuslineCounts, firstWords, formatStatusline } from "../src/statusline";

describe("firstWords (pure)", () => {
  test("joins the first 3 words of a command", () => {
    expect(firstWords("gh pr merge 58 --merge")).toBe("gh pr merge");
  });

  test("a command shorter than 3 words is returned whole", () => {
    expect(firstWords("ls")).toBe("ls");
  });
});

describe("deriveStatuslineCounts / formatStatusline", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-statusline-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("an empty store is calm: nothing vivas, nothing flagged, nothing open", () => {
    expect(deriveStatuslineCounts(home)).toEqual({ live: 0, flagged: 0, inbox: 0 });
    expect(formatStatusline(home)).toBe("tenaza │ ● 0 vivas · ⚑ 0 · ✉ 0");
  });

  test("the spec's own calm example: two alive Sessions, nothing flagged, nothing open (AC2)", () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/a", capabilities: ["observe", "block"] }));
    appendEvent(home, sessionStartedEvent("sess-2", { runtime: "claude", cwd: "/tmp/b", capabilities: ["observe", "block"] }));

    expect(formatStatusline(home)).toBe("tenaza │ ● 2 vivas · ⚑ 0 · ✉ 0");
  });

  test("an ended top-level Session does not count toward vivas", () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/a", capabilities: ["observe", "block"] }));
    appendEvent(home, sessionEndedEvent("sess-1", "clean_exit"));
    appendEvent(home, sessionStartedEvent("sess-2", { runtime: "claude", cwd: "/tmp/b", capabilities: ["observe", "block"] }));

    expect(deriveStatuslineCounts(home).live).toBe(1);
  });

  test("a Session waiting on an open Inbox item counts toward vivas (waits outranks alive, but both are live)", () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/a", capabilities: ["observe", "block"] }));
    appendEvent(
      home,
      actionDecidedEvent("sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" }, "deny", {
        match: "gh pr merge",
        effect: "human",
      }),
    );

    const counts = deriveStatuslineCounts(home);
    expect(counts.live).toBe(1);
    expect(counts.inbox).toBe(1);
  });

  test("a Session over the threshold with the measure Capability counts as flagged", () => {
    appendEvent(
      home,
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/a", capabilities: ["observe", "block", "measure"] }),
    );
    appendEvent(home, usageSampledEvent("sess-1", { context_tokens: 243_000 }));

    expect(deriveStatuslineCounts(home).flagged).toBe(1);
    expect(formatStatusline(home)).toBe("tenaza │ ● 1 vivas · ⚑ 1 >200k · ✉ 0");
  });

  test("a Session under the threshold is not flagged, even with measure", () => {
    appendEvent(
      home,
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/a", capabilities: ["observe", "block", "measure"] }),
    );
    appendEvent(home, usageSampledEvent("sess-1", { context_tokens: 50_000 }));

    expect(deriveStatuslineCounts(home).flagged).toBe(0);
  });

  test("a Session without the measure Capability is never flagged, however large a stray sample is (ADR 0001)", () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "fake", cwd: "/tmp/a", capabilities: ["observe"] }));
    appendEvent(home, usageSampledEvent("sess-1", { context_tokens: 999_000 }));

    expect(deriveStatuslineCounts(home).flagged).toBe(0);
  });

  test("with two open items, the line names the most urgent (most recently opened) one and counts both (AC1)", () => {
    // Ticket 06 (tenaza-v0-3): recent, `Date.now()`-relative timestamps, not
    // a fixed calendar date — `deriveStatuslineCounts` takes no injectable
    // `now`, and these Sessions carry no `pid`, so a STALE fixture date
    // would now (correctly) read as silent past 24h and drop out of
    // "vivas," which is not what this test is about.
    const firstTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const secondTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    appendEvent(
      home,
      {
        v: 1,
        ts: firstTs,
        session: "sess-1",
        type: "action.decided",
        data: {
          action: { kind: "shell", command: "git worktree remove foo", tool: "Bash" },
          decision: "deny",
          rule: { match: "git worktree remove", effect: "human" },
        },
      },
    );
    appendEvent(
      home,
      {
        v: 1,
        ts: secondTs,
        session: "sess-2",
        type: "action.decided",
        data: {
          action: { kind: "shell", command: "gh pr merge 58 --merge", tool: "Bash" },
          decision: "deny",
          rule: { match: "gh pr merge", effect: "human" },
        },
      },
    );

    // Neither Session has a `session.started`/`session.ended` of its own here
    // (bare `action.decided` fixtures, same as tickets 01/02's own tests) —
    // each still gets a node that reads "alive" (ticket 03: a Session known
    // only through an action.decided has no endedAt, so it is never "ended"),
    // so both count toward vivas too.
    const shortId = shortIdIndex(home).get(inboxIdentityHash("sess-2", 1));
    expect(formatStatusline(home)).toBe(`tenaza │ ● 2 vivas · ⚑ 0 · ✉ 2 → ${shortId} gh pr merge`);
  });

  test("an unblocked Inbox item (ADR 0001, ticket 06) still counts toward ✉, and can be the most urgent one", () => {
    appendEvent(
      home,
      actionDecidedEvent("sess-1", { kind: "shell", command: "gh pr merge 58 --merge", tool: "Bash" }, "allow", {
        match: "gh pr merge",
        effect: "human",
      }),
    );

    const counts = deriveStatuslineCounts(home);
    expect(counts.inbox).toBe(1);
    const shortId = inboxIdentityHash("sess-1", 1).slice(0, 4);
    expect(formatStatusline(home)).toBe(`tenaza │ ● 1 vivas · ⚑ 0 · ✉ 1 → ${shortId} gh pr merge`);
  });

  test("an mcp Inbox item (ticket 04) as the most urgent one never crashes — `action.command` doesn't exist on it", () => {
    appendEvent(
      home,
      actionDecidedEvent("sess-1", { kind: "mcp", tool: "mcp__neon__run_sql", args: { branch_id: "br-prod" } }, "deny", {
        tool: "mcp__*neon*__run_sql*",
        effect: "human",
      }),
    );

    const shortId = inboxIdentityHash("sess-1", 1).slice(0, 4);
    expect(formatStatusline(home)).toBe(
      `tenaza │ ● 1 vivas · ⚑ 0 · ✉ 1 → ${shortId} mcp__neon__run_sql  branch_id=br-prod`,
    );
  });

  test("a resolved Inbox item drops out of ✉, same as it drops out of tenaza status", () => {
    const { approvalResolvedEvent } = require("../src/contract/event");
    const { appendHumanEvent } = require("../src/log");
    appendEvent(
      home,
      actionDecidedEvent("sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" }, "deny", {
        match: "gh pr merge",
        effect: "human",
      }),
    );
    appendHumanEvent(home, approvalResolvedEvent("sess-1", "1", "done"));

    // sess-1 itself never "ended" (no session.ended Event) — resolving the
    // Inbox item closes the ITEM, not the Session, so it still reads alive.
    expect(deriveStatuslineCounts(home).inbox).toBe(0);
    expect(formatStatusline(home)).toBe("tenaza │ ● 1 vivas · ⚑ 0 · ✉ 0");
  });

  test("the flagged suffix reflects a custom Policy threshold, not a hardcoded 200k", () => {
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(path.join(home, "config", "policy.toml"), "[flag]\nthreshold_tokens = 100000\n");
    appendEvent(
      home,
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/a", capabilities: ["observe", "block", "measure"] }),
    );
    appendEvent(home, usageSampledEvent("sess-1", { context_tokens: 120_000 }));

    expect(formatStatusline(home)).toBe("tenaza │ ● 1 vivas · ⚑ 1 >100k · ✉ 0");
  });

  test("ADR 0007 (ticket 02): a red 'degradado' mark while state/health.json reports a fault", () => {
    expect(formatStatusline(home)).not.toContain("degradado");

    recordDegraded(home, "policy.toml is invalid", true);

    expect(formatStatusline(home)).toBe(`tenaza │ ${RED}degradado${RESET} · ● 0 vivas · ⚑ 0 · ✉ 0`);
  });

  test("ADR 0007 (ticket 02): the mark clears the moment the next healthy answer does", () => {
    recordDegraded(home, "a torn log line was skipped");
    expect(formatStatusline(home)).toContain("degradado");

    recordHealthy(home);

    expect(formatStatusline(home)).not.toContain("degradado");
    expect(formatStatusline(home)).toBe("tenaza │ ● 0 vivas · ⚑ 0 · ✉ 0");
  });

  describe("ticket 12: the Daemon's live dot", () => {
    test("no heartbeat at all — never shown", () => {
      expect(formatStatusline(home)).not.toContain("daemon");
      expect(formatStatusline(home)).toBe("tenaza │ ● 0 vivas · ⚑ 0 · ✉ 0");
    });

    test("a fresh heartbeat shows the green dot, trailing the line", () => {
      writeAlive(home);

      expect(formatStatusline(home)).toBe(
        `tenaza │ ● 0 vivas · ⚑ 0 · ✉ 0 · ${GREEN}●${RESET} daemon`,
      );
    });

    test("a STALE heartbeat (same rule the live-answering hold reads, never a second threshold) reads the same as none at all", () => {
      writeAlive(home, new Date(Date.now() - 60_000));

      expect(formatStatusline(home)).not.toContain("daemon");
      expect(formatStatusline(home)).toBe("tenaza │ ● 0 vivas · ⚑ 0 · ✉ 0");
    });

    test("the live dot composes with the degradado mark — a broken Tenaza is still visible even if the Daemon is up", () => {
      writeAlive(home);
      recordDegraded(home, "policy.toml is invalid", true);

      expect(formatStatusline(home)).toBe(
        `tenaza │ ${RED}degradado${RESET} · ● 0 vivas · ⚑ 0 · ✉ 0 · ${GREEN}●${RESET} daemon`,
      );
    });
  });

  /**
   * Ticket 02 ("a dead Session stops reading as live," AC1): the SAME rule
   * `renderSessionTree` (sessions.test.ts) and `buildBoardPayload`
   * (daemon.test.ts) are proven against, exercised here through the REAL
   * `ps` read (no injection — `deriveStatuslineCounts` takes none, by this
   * repo's own convention of leaving the real OS glue untested only at the
   * unit layer; `closeDeadProcesses` itself already is).
   */
  describe("ticket 02 — a Session whose captured pid's process has exited never counts toward vivas", () => {
    test("live while the process is up, no longer live once it exits", async () => {
      const proc = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
      try {
        appendEvent(
          home,
          sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/a", capabilities: [], pid: proc.pid }),
        );
        expect(deriveStatuslineCounts(home).live).toBe(1);

        proc.kill();
        await proc.exited;

        expect(deriveStatuslineCounts(home).live).toBe(0);
      } finally {
        proc.kill();
      }
    });
  });

  /**
   * Ticket 06 (tenaza-v0-3, "a Session with no pid stops reading live
   * after 24h of silence"): the companion fallback for a Session that
   * NEVER captured a `pid` at all — every Session started under the 0.2.0
   * binary, before `pid` capture shipped (ADR 0008). Found 2026-10-28: the
   * statusline read "7 vivas" while only 2 `claude` processes existed —
   * the other 5 had no `pid` to check at all.
   */
  describe("ticket 06 — a pre-0.3.0 Session with no pid never counts toward vivas once silent past 24h", () => {
    test("stays live while silent for LESS than 24h — only the 24h fallback changes category", () => {
      const recentlyAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h
      appendEvent(home, { ...sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/a", capabilities: [] }), ts: recentlyAgo });

      expect(deriveStatuslineCounts(home).live).toBe(1);
    });

    test("no longer live once silent for MORE than 24h, with no pid ever captured", () => {
      const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h
      appendEvent(home, { ...sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/a", capabilities: [] }), ts: longAgo });

      expect(deriveStatuslineCounts(home).live).toBe(0);
    });
  });
});
