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
import { RED, RESET } from "../src/contextbar";
import { recordDegraded, recordHealthy } from "../src/health";
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
    appendEvent(
      home,
      {
        v: 1,
        ts: "2026-10-23T10:00:00.000Z",
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
        ts: "2026-10-23T10:05:00.000Z",
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
    expect(formatStatusline(home)).toBe("tenaza │ ● 2 vivas · ⚑ 0 · ✉ 2 → #2 gh pr merge");
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
    expect(formatStatusline(home)).toBe("tenaza │ ● 1 vivas · ⚑ 0 · ✉ 1 → #1 gh pr merge");
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
});
