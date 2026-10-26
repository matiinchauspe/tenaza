import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideAction } from "../src/decide";
import { appendEvent } from "../src/log";
import {
  buildSessionIndex,
  categoryWord,
  deriveProject,
  isStalled,
  nodeCategory,
  renderSessionTree,
  roleOf,
  rollupCategory,
} from "../src/sessions";
import {
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
});

describe("nodeCategory and rollupCategory", () => {
  test("a started, un-ended Session with no open Inbox item is alive", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
    ]);
    const node = index.get("sess-1")!;
    expect(nodeCategory(node, new Set())).toBe("alive");
  });

  test("a Session with an open Inbox item waits for the human, even over ended", async () => {
    const index = buildSessionIndex([
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }),
      sessionEndedEvent("sess-1", "clear"),
    ]);
    const node = index.get("sess-1")!;
    expect(nodeCategory(node, new Set(["sess-1"]))).toBe("waits");
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
});
