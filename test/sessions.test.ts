import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideAction } from "../src/decide";
import { appendEvent, appendHumanEvent } from "../src/log";
import { captureProcessMarker } from "../src/terminallocator";
import { touchSession } from "../src/toolcalls";
import {
  PROCESS_GONE_REASON,
  buildSessionIndex,
  categoryWord,
  closeDeadProcesses,
  deriveProject,
  isArchived,
  isNoiseSession,
  isProcessGone,
  isStalled,
  latestArchiveTimestamps,
  nativeWaitFor,
  nodeCategory,
  readTouchedTimestamps,
  renderSessionTree,
  roleOf,
  rollupCategory,
} from "../src/sessions";
import {
  actionDecidedEvent,
  notificationObservedEvent,
  sessionArchivedEvent,
  sessionEndedEvent,
  sessionLabeledEvent,
  sessionStartedEvent,
  usageSampledEvent,
} from "../src/contract/event";

describe("buildSessionIndex", () => {
  test("captures runtime, cwd, capabilities and parent from session.started", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("agent-1", {
        parent: "sess-1",
        runtime: "claude",
        cwd: "/repo",
        capabilities: ["observe", "block"],
      }),
    ]);

    const node = index.get("agent-1");
    expect(node).toMatchObject({
      id: "agent-1",
      parent: "sess-1",
      runtime: "claude",
      cwd: "/repo",
      capabilities: ["observe", "block"],
    });
  });

  test("ticket 11: captures the terminal locator from session.started when one was recorded", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", {
        runtime: "claude",
        cwd: "/repo",
        capabilities: ["observe"],
        terminal: { termProgram: "Apple_Terminal", tty: "/dev/ttys003" },
      }),
    ]);
    expect(index.get("sess-1")?.terminalLocator).toEqual({ termProgram: "Apple_Terminal", tty: "/dev/ttys003" });
  });

  test("ticket 11: no terminal field at all (legacy v0.1 data, or a backfilled session.started) leaves terminalLocator undefined — never a crash", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: ["observe"] }),
    ]);
    expect(index.get("sess-1")?.terminalLocator).toBeUndefined();
  });

  test("ticket 11: a subagent's session.started never carries a terminal field (adapters/claude.ts never captures one for SubagentStart) — resolving its PARENT's is the core's own job, not this index's", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", {
        runtime: "claude",
        cwd: "/repo",
        capabilities: ["observe"],
        terminal: { termProgram: "iTerm.app", tty: "/dev/ttys007" },
      }),
      sessionStartedEvent("agent-1", { parent: "sess-1", runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);
    expect(index.get("agent-1")?.terminalLocator).toBeUndefined();
    expect(index.get("sess-1")?.terminalLocator).toEqual({ termProgram: "iTerm.app", tty: "/dev/ttys007" });
  });

  test("a Session with no session.started still gets a node (ticket 01/02's lifecycle-less fixtures)", async () => {
    const index = buildSessionIndex([
      {
        v: 1,
        ts: "2026-10-23T10:00:00.000Z",
        session: "sess-1",
        type: "action.decided",
        data: {
          action: { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
          decision: "deny",
          rule: { match: "gh pr merge", effect: "human" },
        },
      },
    ]);

    const node = index.get("sess-1");
    expect(node?.id).toBe("sess-1");
    expect(node?.cwd).toBeUndefined();
  });

  test("lastEventTs tracks the MAX timestamp seen for that Session", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
      sessionEndedEvent("sess-1", "clear"),
    ]);

    const node = index.get("sess-1");
    expect(node?.startedAt).toBeDefined();
    expect(node?.endedAt).toBeDefined();
    expect(node?.lastEventTs).toBe(node?.endedAt);
  });

  test("contextTokens captures the LATEST usage.sampled, not the max or first (q9)", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
      usageSampledEvent("sess-1", { context_tokens: 242_170 }),
      usageSampledEvent("sess-1", { context_tokens: 80_000 }),
    ]);

    // the LAST sample wins, even though it's the smaller number — the file's
    // own order decides, same convention measureContextTokens uses.
    expect(index.get("sess-1")?.contextTokens).toBe(80_000);
  });

  test("a Session with no usage.sampled event has contextTokens undefined, not zero", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);

    expect(index.get("sess-1")?.contextTokens).toBeUndefined();
  });

  test("lastAction captures the LATEST action.decided Event's Action — ticket 08's 'last signal' (last write wins, same convention as contextTokens)", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "ls -la", tool: "Bash" },
        "allow",
        { match: "nothing", effect: "flag" },
      ),
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        "deny",
        { match: "gh pr merge", effect: "human" },
      ),
    ]);

    expect(index.get("sess-1")?.lastAction).toEqual({ kind: "shell", command: "gh pr merge 58", tool: "Bash" });
  });

  test("a Session with no action.decided Event has lastAction undefined", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);

    expect(index.get("sess-1")?.lastAction).toBeUndefined();
  });

  test("ticket 14: lastNotification captures the LATEST notification.observed Event (last write wins, same convention as lastAction)", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
      notificationObservedEvent("sess-1", "idle_prompt"),
      notificationObservedEvent("sess-1", "permission_prompt"),
    ]);

    expect(index.get("sess-1")?.lastNotification).toMatchObject({ kind: "permission_prompt" });
  });

  test("ticket 14: a Session with no notification.observed Event has lastNotification undefined", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);

    expect(index.get("sess-1")?.lastNotification).toBeUndefined();
  });
});

describe("nodeCategory and rollupCategory", () => {
  test("a started, un-ended Session with no open Inbox item is alive", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);
    const node = index.get("sess-1")!;
    expect(nodeCategory(node, new Set())).toBe("alive");
  });

  test("a STILL-RUNNING Session with an open Inbox item waits for the human", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);
    const node = index.get("sess-1")!;
    expect(nodeCategory(node, new Set(["sess-1"]))).toBe("waits");
  });

  test("an ENDED Session reads ended, even with an open Inbox item (ticket 05, #1436's stale 'te espera' fix)", async () => {
    // The real dogfood bug (2026-10-25): a Session that triggered a
    // `human`-Rule match, then ended normally, read "⏸ te espera" forever
    // because the open Inbox item outranked `endedAt`. Ended now wins —
    // the Inbox item itself still surfaces independently (`deriveInbox`,
    // proven at the `renderStatus` seam in status.test.ts).
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
      sessionEndedEvent("sess-1", "clear"),
    ]);
    const node = index.get("sess-1")!;
    expect(nodeCategory(node, new Set(["sess-1"]))).toBe("ended");
  });

  test("an ended subagent (has a parent) reads as done; an ended top-level Session reads as ended", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
      sessionEndedEvent("sess-1", "clear"),
      sessionStartedEvent("agent-1", { parent: "sess-1", runtime: "claude", cwd: "/repo", capabilities: [] }),
      sessionEndedEvent("agent-1", "subagent_stop"),
    ]);
    expect(nodeCategory(index.get("sess-1")!, new Set())).toBe("ended");
    expect(nodeCategory(index.get("agent-1")!, new Set())).toBe("done");
  });

  test("ticket 13: a subagent re-started after it ended (SendMessage re-fires SubagentStart under the SAME agent_id) reads alive again, its stale end dropped", () => {
    // The real shape from ~/.tenaza (2026-10-27, abd9287f / aa1de933): the
    // card sat in TERMINÓ while the continued subagent was working.
    const index = buildSessionIndex([
      sessionStartedEvent("agent-1", { parent: "sess-1", runtime: "claude", cwd: "/repo", capabilities: [] }),
      sessionEndedEvent("agent-1", "subagent_stop"),
      usageSampledEvent("agent-1", { context_tokens: 120_000 }),
      sessionStartedEvent("agent-1", { parent: "sess-1", runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);
    const node = index.get("agent-1")!;
    expect(node.endedAt).toBeUndefined();
    expect(node.endedReason).toBeUndefined();
    expect(nodeCategory(node, new Set())).toBe("alive");
  });

  test("ticket 13: the usage.sampled every SubagentStop appends right after its own end never revives it — only a start does", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("agent-1", { parent: "sess-1", runtime: "claude", cwd: "/repo", capabilities: [] }),
      sessionEndedEvent("agent-1", "subagent_stop"),
      usageSampledEvent("agent-1", { context_tokens: 120_000 }),
    ]);
    expect(nodeCategory(index.get("agent-1")!, new Set())).toBe("done");
  });

  test("ticket 13: a re-started subagent that ends AGAIN reads done, carrying its newest end (aa820af8: three runs, three ends)", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("agent-1", { parent: "sess-1", runtime: "claude", cwd: "/repo", capabilities: [] }),
      { ...sessionEndedEvent("agent-1", "subagent_stop"), ts: "2026-10-27T13:12:56.028Z" },
      sessionStartedEvent("agent-1", { parent: "sess-1", runtime: "claude", cwd: "/repo", capabilities: [] }),
      { ...sessionEndedEvent("agent-1", "subagent_stop"), ts: "2026-10-27T13:20:08.186Z" },
    ]);
    const node = index.get("agent-1")!;
    expect(node.endedAt).toBe("2026-10-27T13:20:08.186Z");
    expect(nodeCategory(node, new Set())).toBe("done");
  });

  test("a parent rolls up its most urgent descendant: waits > alive > done > ended", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("parent", { runtime: "claude", cwd: "/repo", capabilities: [] }),
      sessionStartedEvent("child-done", { parent: "parent", runtime: "claude", cwd: "/repo", capabilities: [] }),
      sessionEndedEvent("child-done", "subagent_stop"),
      sessionStartedEvent("child-waits", { parent: "parent", runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);
    const childrenOf = new Map([
      ["parent", [index.get("child-done")!, index.get("child-waits")!]],
    ]);

    // child-waits has an open Inbox item -> outranks the parent's own "alive" and the other child's "done"
    expect(rollupCategory(index.get("parent")!, childrenOf, new Set(["child-waits"]))).toBe("waits");
    // with nothing waiting, the parent's own "alive" outranks its "done" child (self wins ties)
    expect(rollupCategory(index.get("parent")!, childrenOf, new Set())).toBe("alive");
  });
});

describe("deriveProject", () => {
  test("a session.labeled project Label wins over everything else", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
      { v: 1, ts: "2026-10-23T10:00:01.000Z", session: "sess-1", type: "session.labeled", data: { labels: { project: "reservee" } } },
    ]);
    const node = index.get("sess-1")!;
    expect(deriveProject(node, () => "/some/git/root")).toBe("reservee");
  });

  test("falls back to the git root of cwd when there is no Label", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo/sub", capabilities: [] }),
    ]);
    const node = index.get("sess-1")!;
    expect(deriveProject(node, (cwd) => (cwd === "/repo/sub" ? "/repo" : undefined))).toBe("/repo");
  });

  test("falls back to cwd itself when there is no git root", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/scratch", capabilities: [] }),
    ]);
    const node = index.get("sess-1")!;
    expect(deriveProject(node, () => undefined)).toBe("/tmp/scratch");
  });

  test("a Session with no known cwd (no session.started) groups under one unknown-project bucket", async () => {
    const index = buildSessionIndex([
      {
        v: 1,
        ts: "2026-10-23T10:00:00.000Z",
        session: "sess-1",
        type: "action.decided",
        data: {
          action: { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
          decision: "deny",
          rule: { match: "gh pr merge", effect: "human" },
        },
      },
    ]);
    const node = index.get("sess-1")!;
    expect(deriveProject(node, () => undefined)).toBe("(sin proyecto)");
  });

  test("two Sessions with different git roots derive different projects", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("a", { runtime: "claude", cwd: "/repos/tenaza", capabilities: [] }),
      sessionStartedEvent("b", { runtime: "claude", cwd: "/repos/rudy", capabilities: [] }),
    ]);
    const resolve = (cwd: string) => cwd;
    expect(deriveProject(index.get("a")!, resolve)).not.toBe(deriveProject(index.get("b")!, resolve));
  });

  test("a later session.labeled event overrides an earlier key but leaves other keys alone (AC4)", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
      sessionLabeledEvent("sess-1", { ticket: "RES-131" }),
      sessionLabeledEvent("sess-1", { project: "reservee" }),
      sessionLabeledEvent("sess-1", { ticket: "RES-200" }),
    ]);
    expect(index.get("sess-1")?.labels).toEqual({ ticket: "RES-200", project: "reservee" });
  });
});

describe("roleOf", () => {
  test("a Session with no ticket Label falls back to its structural role", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
      sessionStartedEvent("agent-1", { parent: "sess-1", runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);
    expect(roleOf(index.get("sess-1")!)).toBe("sesión");
    expect(roleOf(index.get("agent-1")!)).toBe("subagente");
  });

  test("a Session with a ticket Label shows it in place of the role, verbatim (AC3)", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("agent-1", { parent: "sess-1", runtime: "claude", cwd: "/repo", capabilities: [] }),
      sessionLabeledEvent("agent-1", { ticket: "RES-131" }),
    ]);
    expect(roleOf(index.get("agent-1")!)).toBe("RES-131");
  });
});

describe("isStalled / categoryWord", () => {
  test("no recent Event past the threshold reads as stalled", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);
    const node = index.get("sess-1")!;
    const started = new Date(node.startedAt!);
    const farLater = new Date(started.getTime() + 60 * 60 * 1000); // 1h later
    expect(isStalled(node, farLater, 15 * 60 * 1000)).toBe(true);
    expect(isStalled(node, new Date(started.getTime() + 1000), 15 * 60 * 1000)).toBe(false);
  });

  test("categoryWord only swaps to the stalled word for the alive category", async () => {
    expect(categoryWord("alive", true)).not.toBe(categoryWord("alive", false));
    expect(categoryWord("waits", true)).toBe(categoryWord("waits", false));
    expect(categoryWord("done", true)).toBe(categoryWord("done", false));
    expect(categoryWord("ended", true)).toBe(categoryWord("ended", false));
  });
});

describe("isProcessGone (ticket 02 — a dead Session stops reading as live)", () => {
  test("no pid captured at all reads as 'cannot tell,' never gone (AC2: missing info is not evidence of death)", () => {
    const node = { id: "sess-1", capabilities: [], labels: {} } as unknown as Parameters<typeof isProcessGone>[0];
    expect(isProcessGone(node, new Map([[123, "Wed Oct 28 10:00:00 2026"]]))).toBe(false);
  });

  test("a pid absent from the live process table is CONFIRMED gone", () => {
    const node = { id: "sess-1", capabilities: [], labels: {}, pid: 999 } as unknown as Parameters<
      typeof isProcessGone
    >[0];
    expect(isProcessGone(node, new Map([[123, "Wed Oct 28 10:00:00 2026"]]))).toBe(true);
  });

  test("a pid present, no stored start marker to compare — trusts the bare pid alone (degrades to alive)", () => {
    const node = { id: "sess-1", capabilities: [], labels: {}, pid: 123 } as unknown as Parameters<
      typeof isProcessGone
    >[0];
    expect(isProcessGone(node, new Map([[123, "Wed Oct 28 10:00:00 2026"]]))).toBe(false);
  });

  test("same pid, same start marker — still the SAME process, reads alive", () => {
    const node = {
      id: "sess-1",
      capabilities: [],
      labels: {},
      pid: 123,
      pidStartedAt: "Wed Oct 28 10:00:00 2026",
    } as unknown as Parameters<typeof isProcessGone>[0];
    expect(isProcessGone(node, new Map([[123, "Wed Oct 28 10:00:00 2026"]]))).toBe(false);
  });

  test("same pid NUMBER, a DIFFERENT start marker — a reused pid after a reboot, reads gone (AC3)", () => {
    const node = {
      id: "sess-1",
      capabilities: [],
      labels: {},
      pid: 123,
      pidStartedAt: "Wed Oct 28 10:00:00 2026",
    } as unknown as Parameters<typeof isProcessGone>[0];
    expect(isProcessGone(node, new Map([[123, "Thu Oct 29 08:00:00 2026"]]))).toBe(true);
  });
});

describe("closeDeadProcesses (ticket 02 — the ONE rule status/statusline/the board all apply, AC1)", () => {
  test("a candidate whose pid is confirmed gone is closed exactly like a real SessionEnd — a DISTINCT reason (AC1)", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [], pid: 111, pidStartedAt: "m1" }),
    ]);
    closeDeadProcesses(index, new Date(), () => new Map());
    const node = index.get("sess-1")!;
    expect(node.endedAt).toBeDefined();
    expect(node.endedAt).toBe(node.lastEventTs);
    expect(node.endedReason).toBe(PROCESS_GONE_REASON);
  });

  test("a candidate whose pid is still alive (matching marker) stays untouched — AC2: idle-but-alive never changes category", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [], pid: 111, pidStartedAt: "m1" }),
    ]);
    closeDeadProcesses(index, new Date(), () => new Map([[111, "m1"]]));
    const node = index.get("sess-1")!;
    expect(node.endedAt).toBeUndefined();
    expect(node.endedReason).toBeUndefined();
  });

  test("a Session with no pid at all is left exactly as it was, whatever the process table reports", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);
    closeDeadProcesses(index, new Date(), () => new Map());
    const node = index.get("sess-1")!;
    expect(node.endedAt).toBeUndefined();
  });

  test("a Session that ALREADY has a real SessionEnd is never touched, even if ps reports its pid gone", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [], pid: 111, pidStartedAt: "m1" }),
      sessionEndedEvent("sess-1", "clear"),
    ]);
    closeDeadProcesses(index, new Date(), () => new Map());
    const node = index.get("sess-1")!;
    expect(node.endedReason).toBe("clear");
  });

  test("a subagent carries its OWN pid and closes independently — no parent walk needed, unlike the terminal locator", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("parent-1", { runtime: "claude", cwd: "/repo", capabilities: [], pid: 111, pidStartedAt: "m1" }),
      sessionStartedEvent("child-1", {
        parent: "parent-1",
        runtime: "claude",
        cwd: "/repo",
        capabilities: [],
        pid: 111,
        pidStartedAt: "m1",
      }),
    ]);
    closeDeadProcesses(index, new Date(), () => new Map()); // the shared pid is confirmed gone
    expect(index.get("parent-1")!.endedReason).toBe(PROCESS_GONE_REASON);
    expect(index.get("child-1")!.endedReason).toBe(PROCESS_GONE_REASON);
    // rollupCategory now agrees too — "done" for the child (it has a parent), "ended" for the root.
    expect(nodeCategory(index.get("parent-1")!, new Set())).toBe("ended");
    expect(nodeCategory(index.get("child-1")!, new Set())).toBe("done");
  });

  test("every distinct candidate pid is read in ONE batched call, never one spawn per Session (ticket 13's own lesson)", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [], pid: 111, pidStartedAt: "m1" }),
      sessionStartedEvent("sess-2", { runtime: "claude", cwd: "/repo", capabilities: [], pid: 222, pidStartedAt: "m2" }),
      sessionStartedEvent("sess-3", { runtime: "claude", cwd: "/repo", capabilities: [], pid: 111, pidStartedAt: "m1" }),
    ]);
    let calls = 0;
    closeDeadProcesses(index, new Date(), (pids) => {
      calls += 1;
      expect([...pids].sort()).toEqual([111, 222]); // deduplicated
      return new Map([[111, "m1"]]); // 222 confirmed gone, 111 still alive
    });
    expect(calls).toBe(1);
    expect(index.get("sess-1")!.endedAt).toBeUndefined();
    expect(index.get("sess-2")!.endedAt).toBeDefined();
    expect(index.get("sess-3")!.endedAt).toBeUndefined();
  });

  test("no candidates at all (every node already ended, or none has a pid) never calls the process-table reader", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);
    let called = false;
    closeDeadProcesses(index, new Date(), () => {
      called = true;
      return new Map();
    });
    expect(called).toBe(false);
  });
});

describe("closeDeadProcesses — real `ps` (no injection): end-to-end over an actual OS process", () => {
  test("a Session whose captured pid belongs to a process that has since exited reads as closed", async () => {
    const proc = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      // The SAME capture this ticket wires into SessionStart, read for a REAL pid.
      const marker = captureProcessMarker(proc.pid);
      expect(marker.pid).toBe(proc.pid);

      const index = buildSessionIndex([
        sessionStartedEvent("sess-1", {
          runtime: "claude",
          cwd: "/repo",
          capabilities: [],
          pid: marker.pid,
          pidStartedAt: marker.startedAt,
        }),
      ]);

      // Still running: the real `ps` read must confirm it alive.
      closeDeadProcesses(index);
      expect(index.get("sess-1")!.endedAt).toBeUndefined();

      proc.kill();
      await proc.exited;

      // Gone now: the SAME real `ps` read must confirm it dead.
      const indexAfter = buildSessionIndex([
        sessionStartedEvent("sess-1", {
          runtime: "claude",
          cwd: "/repo",
          capabilities: [],
          pid: marker.pid,
          pidStartedAt: marker.startedAt,
        }),
      ]);
      closeDeadProcesses(indexAfter);
      const node = indexAfter.get("sess-1")!;
      expect(node.endedAt).toBeDefined();
      expect(node.endedReason).toBe(PROCESS_GONE_REASON);
    } finally {
      proc.kill();
    }
  });
});

describe("isNoiseSession (ticket 05 — #1436's '~85 phantom Sessions' finding)", () => {
  test("a Session whose ONLY Events are session.ended + usage.sampled is noise", () => {
    expect(isNoiseSession(new Set(["session.ended", "usage.sampled"]))).toBe(true);
  });

  test("a Session that ended with NO usage sample at all is NOT noise — the literal shape needs BOTH", () => {
    expect(isNoiseSession(new Set(["session.ended"]))).toBe(false);
  });

  test("a usage.sampled with no session.ended yet is never noise — the Session hasn't ended", () => {
    expect(isNoiseSession(new Set(["usage.sampled"]))).toBe(false);
    expect(isNoiseSession(new Set())).toBe(false);
  });

  test("a Session with a real session.started is never noise, even if it also ended", () => {
    expect(isNoiseSession(new Set(["session.started", "session.ended", "usage.sampled"]))).toBe(false);
  });

  test("a Session with an action.decided (a real Policy match) is never noise, even with no session.started", () => {
    // The ticket 01/02 "lifecycle-less fixture" case: a real Inbox item
    // must never be hidden just because it also happens to have ended.
    expect(isNoiseSession(new Set(["action.decided", "session.ended"]))).toBe(false);
  });

  test("a Session with a session.labeled announce is never noise", () => {
    expect(isNoiseSession(new Set(["session.labeled", "session.ended", "usage.sampled"]))).toBe(false);
  });
});

describe("renderSessionTree (black box over a temporary TENAZA_HOME)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-sessions-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("an empty home renders no tree at all", async () => {
    expect(renderSessionTree(home)).toBe("");
  });

  test("a subagent renders nested under its parent, under their shared project", async () => {
    appendEvent(
      home,
      sessionStartedEvent("parent", { runtime: "claude", cwd: "/tmp/scratch", capabilities: ["observe", "block"] }),
    );
    appendEvent(
      home,
      sessionStartedEvent("child", {
        parent: "parent",
        runtime: "claude",
        cwd: "/tmp/scratch",
        capabilities: ["observe", "block"],
      }),
    );

    const out = renderSessionTree(home, new Date());

    expect(out).toContain("/tmp/scratch");
    expect(out).toContain("parent");
    expect(out).toContain("child");
    expect(out).toContain("●");
    expect(out).toContain("sesión");
    expect(out).toContain("subagente");
    expect(out).toContain("vivo");
    // the child must be indented under the parent, not listed as a second root
    const parentLine = out.split("\n").find((l) => l.includes("parent"))!;
    const childLine = out.split("\n").find((l) => l.includes("child") && !l.includes("parent"))!;
    expect(childLine.startsWith(" ")).toBe(true);
    expect(childLine.length).toBeGreaterThan(0);
    expect(parentLine).toBeDefined();
  });

  test("a denied Session shows waits-for-the-human, es-AR word included", async () => {
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[[rule]]
match = "gh pr merge"
effect = "human"
`,
    );
    await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });

    const out = renderSessionTree(home);

    expect(out).toContain("⏸");
    expect(out).toContain("te espera");
    expect(out).toContain("(sin proyecto)");
  });

  test("two Sessions in different git repos land in different project groups", async () => {
    appendEvent(home, sessionStartedEvent("a", { runtime: "claude", cwd: "/repos/tenaza", capabilities: [] }));
    appendEvent(home, sessionStartedEvent("b", { runtime: "claude", cwd: "/repos/rudy", capabilities: [] }));

    // cwd here isn't a real git repo, so both fall back to cwd itself as the project —
    // still two DIFFERENT groups, proving the grouping key tracks derived project, not a shared default.
    const out = renderSessionTree(home);

    expect(out).toContain("/repos/tenaza");
    expect(out).toContain("/repos/rudy");
  });

  test("a Session below the threshold shows no red overflow and no ⚑ (AC3)", async () => {
    appendEvent(
      home,
      sessionStartedEvent("sess-1", {
        runtime: "claude",
        cwd: "/tmp/scratch",
        capabilities: ["observe", "block", "measure"],
      }),
    );
    appendEvent(home, usageSampledEvent("sess-1", { context_tokens: 100_000 }));

    const out = renderSessionTree(home);
    const line = out.split("\n").find((l) => l.includes("sess-1"))!;

    expect(line).toContain("100k");
    expect(line).not.toContain("⚑");
    expect(line).not.toContain("\x1b[31m");
  });

  test("a Session past the default 200k threshold shows the red overflow and ⚑ (AC3)", async () => {
    appendEvent(
      home,
      sessionStartedEvent("sess-1", {
        runtime: "claude",
        cwd: "/tmp/scratch",
        capabilities: ["observe", "block", "measure"],
      }),
    );
    appendEvent(home, usageSampledEvent("sess-1", { context_tokens: 242_170 }));

    const out = renderSessionTree(home);
    const line = out.split("\n").find((l) => l.includes("sess-1"))!;

    expect(line).toContain("⚑242k");
    expect(line).toContain("\x1b[31m");
  });

  test("a custom Policy threshold moves the mark and what counts as flagged (AC4)", async () => {
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(path.join(home, "config", "policy.toml"), "\n[flag]\nthreshold_tokens = 100000\n");
    appendEvent(
      home,
      sessionStartedEvent("sess-1", {
        runtime: "claude",
        cwd: "/tmp/scratch",
        capabilities: ["observe", "block", "measure"],
      }),
    );
    // 120k is below the DEFAULT 200k threshold but above this custom 100k one.
    appendEvent(home, usageSampledEvent("sess-1", { context_tokens: 120_000 }));

    const out = renderSessionTree(home);
    const line = out.split("\n").find((l) => l.includes("sess-1"))!;

    expect(line).toContain("⚑120k");
    expect(line).toContain("\x1b[31m");
  });

  test("a Session never sampled shows the empty bar and a dash, not a crash", async () => {
    appendEvent(
      home,
      sessionStartedEvent("sess-1", {
        runtime: "claude",
        cwd: "/tmp/scratch",
        capabilities: ["observe", "block", "measure"],
      }),
    );

    const out = renderSessionTree(home);
    const line = out.split("\n").find((l) => l.includes("sess-1"))!;

    expect(line).toContain("—");
    expect(line).not.toContain("⚑");
  });

  test("a Session from an Adapter WITHOUT the measure Capability shows 'sin datos' — no bar, no ⚑ (ADR 0001, ticket 06 AC1)", async () => {
    appendEvent(
      home,
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/scratch", capabilities: ["observe"] }),
    );
    // Even if a usage.sampled Event somehow landed anyway, lacking `measure`
    // still reads as "sin datos" — the Capability, not the data, gates this.
    appendEvent(home, usageSampledEvent("sess-1", { context_tokens: 242_170 }));

    const out = renderSessionTree(home);
    const line = out.split("\n").find((l) => l.includes("sess-1"))!;

    expect(line).toContain("sin datos");
    expect(line).not.toContain("⚑");
    expect(line).not.toContain("█");
    expect(line).not.toContain("░");
  });

  // Shaped after the human's real `tenaza status`, read 2026-10-25 against
  // ~/.tenaza/state/sessions/ (engram #1436) — the actual Session ids,
  // end reason and token count, with cwds swapped for temp-safe paths
  // since we can't spawn against his real home.
  test("a phantom internal side-agent (#1436: 'a41df3047775c4252', ~85 of these on the real status) never appears at all", async () => {
    appendEvent(home, sessionEndedEvent("a41df3047775c4252", "subagent_stop"));
    appendEvent(home, usageSampledEvent("a41df3047775c4252", { context_tokens: 185_775 }));
    // One real Session too, so the tree isn't empty for an unrelated reason.
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/scratch", capabilities: [] }));

    const out = renderSessionTree(home);

    expect(out).not.toContain("a41df3047775c4252");
    expect(out).toContain("sess-1");
  });

  test("a home where EVERY observed Session is a phantom side-agent renders no tree at all, same as truly empty", async () => {
    appendEvent(home, sessionEndedEvent("a41df3047775c4252", "subagent_stop"));
    appendEvent(home, usageSampledEvent("a41df3047775c4252", { context_tokens: 185_775 }));

    expect(renderSessionTree(home)).toBe("");
  });

  test("a subagent with a known parent (#1436: '55e06de1' / 'a322c9c646287386a') nests under it ONCE, even across projects (spec: nesting beats project)", async () => {
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(path.join(home, "config", "policy.toml"), '\n[[rule]]\nmatch = "gh pr merge"\neffect = "human"\n');

    // The parent ('55e06de1') is known only through a human-Rule match —
    // no session.started, so it groups under "(sin proyecto)" exactly as
    // ticket 01/02's own fixtures already do.
    await decideAction(home, "55e06de1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });
    // The subagent DOES know its own cwd — a real, DIFFERENT project. Spec
    // line 328: "a subagent renders once, under its parent, even across
    // projects" — a known parent always wins over project.
    appendEvent(
      home,
      sessionStartedEvent("a322c9c646287386a", {
        parent: "55e06de1",
        runtime: "claude",
        cwd: "/tmp/scratch/oarfish",
        capabilities: [],
      }),
    );

    const out = renderSessionTree(home);

    expect(out).toContain("(sin proyecto)");
    // No SECOND top-level group for the subagent's own project — it never
    // becomes a root there.
    expect(out).not.toContain("/tmp/scratch/oarfish");
    // Exactly one line carries the subagent's id — nested under its
    // parent, never also a root elsewhere.
    const lines = out.split("\n").filter((l) => l.includes("a322c9c646287386a"));
    expect(lines).toHaveLength(1);
    // Nested (not a root): the renderer's own non-root indentation marker.
    expect(lines[0]).toContain("└");
  });
});

describe("latestArchiveTimestamps (ticket 11's 'archive a TERMINÓ card' — ADR 0002, a human Event in the log)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-archived-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("empty when nothing was ever archived", () => {
    expect(latestArchiveTimestamps(home)).toEqual(new Map());
  });

  test("names every Session's own archive ts, from the human log", () => {
    const a = { ...sessionArchivedEvent("sess-1"), ts: "2026-01-01T00:00:00.000Z" };
    const b = { ...sessionArchivedEvent("sess-2"), ts: "2026-01-02T00:00:00.000Z" };
    appendHumanEvent(home, a);
    appendHumanEvent(home, b);
    expect(latestArchiveTimestamps(home)).toEqual(
      new Map([
        ["sess-1", "2026-01-01T00:00:00.000Z"],
        ["sess-2", "2026-01-02T00:00:00.000Z"],
      ]),
    );
  });

  test("orchestrator review: TWO archive Events for the SAME Session (archived, resumed, archived again) collapse to the NEWEST — the older one is never deleted, only superseded", () => {
    appendHumanEvent(home, { ...sessionArchivedEvent("sess-1"), ts: "2026-01-01T00:00:00.000Z" });
    appendHumanEvent(home, { ...sessionArchivedEvent("sess-1"), ts: "2026-01-03T00:00:00.000Z" });
    expect(latestArchiveTimestamps(home)).toEqual(new Map([["sess-1", "2026-01-03T00:00:00.000Z"]]));
  });

  test("never scans a Session's OWN log — only the human log (archiving is a human Event, never written beside a Session's single-writer file)", () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }));
    expect(latestArchiveTimestamps(home)).toEqual(new Map());
  });
});

/**
 * Orchestrator review, 2026-10-27: an archive must never hide a Session
 * FOREVER — a Claude Code Session can be RESUMED (`claude --resume`/
 * `--continue`) under the same `session_id`, firing SessionStart/tool
 * Events again long after it was archived. `isArchived` is the ONE place
 * that judges whether an archive still holds, TIME IS STATE: re-evaluated
 * fresh against each Session's own `lastEventTs` every time, never a flag
 * written once and trusted forever.
 */
describe("isArchived — TIME IS STATE: an archive holds only while nothing happened since (ticket 11 fix)", () => {
  test("never archived at all (archivedAt undefined) — never hidden", () => {
    expect(isArchived(undefined, "2026-01-01T00:00:00.000Z")).toBe(false);
  });

  test("archived, nothing since (lastEventTs at or before the archive) — hidden", () => {
    expect(isArchived("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(true);
    // The boundary itself (the archive's own ts IS the Session's last
    // known activity at the moment it was archived) still counts as hidden.
    expect(isArchived("2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z")).toBe(true);
  });

  test("resumed — a lastEventTs AFTER the archive brings the card back", () => {
    expect(isArchived("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")).toBe(false);
  });

  test("a Session with no lastEventTs at all (should not arise for a real archived Session, which must have ended) still degrades to hidden rather than crashing", () => {
    expect(isArchived("2026-01-01T00:00:00.000Z", undefined)).toBe(true);
  });
});

describe("readTouchedTimestamps (ticket 14, AC3 — the board's own 'last ordinary activity' signal)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-touched-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("empty when no Session was ever touched", () => {
    expect(readTouchedTimestamps(home).size).toBe(0);
  });

  test("names every touched Session's own timestamp, scoped per Session", () => {
    touchSession(home, "sess-1");
    touchSession(home, "sess-2");

    const map = readTouchedTimestamps(home);
    expect(map.has("sess-1")).toBe(true);
    expect(map.has("sess-2")).toBe(true);
    expect(map.has("sess-3")).toBe(false);
  });

  test("never reads a Session's own .jsonl or .toolcalls files as a touch", () => {
    mkdirSync(path.join(home, "state", "sessions"), { recursive: true });
    writeFileSync(path.join(home, "state", "sessions", "sess-1.jsonl"), "{}\n");
    writeFileSync(path.join(home, "state", "sessions", "sess-1.toolcalls"), "x");

    expect(readTouchedTimestamps(home).size).toBe(0);
  });
});

describe("nativeWaitFor — TIME IS STATE: a native prompt holds only while nothing happened since (ticket 14)", () => {
  test("no notification.observed Event at all — never waiting", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);
    expect(nativeWaitFor(index.get("sess-1")!)).toBeUndefined();
  });

  test("the notification IS the most recent thing observed — reads as a current native wait", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
      notificationObservedEvent("sess-1", "permission_prompt"),
    ]);
    expect(nativeWaitFor(index.get("sess-1")!)).toMatchObject({ kind: "permission_prompt" });
  });

  test("a LATER Event (any kind) supersedes a stale notification — no longer waiting, no second Event written for the transition", () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
      notificationObservedEvent("sess-1", "idle_prompt"),
    ]);
    const node = index.get("sess-1")!;
    // Simulate `buildBoardPayload`'s own touched-file merge (daemon.ts):
    // an ordinary tool call's touch moved lastEventTs past the notification.
    node.lastEventTs = new Date(new Date(node.lastEventTs!).getTime() + 1000).toISOString();

    expect(nativeWaitFor(node)).toBeUndefined();
  });
});
