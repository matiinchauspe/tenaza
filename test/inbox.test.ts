import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ActionDecidedEvent,
  actionDecidedEvent,
  approvalResolvedEvent,
} from "../src/contract/event";
import { buildInboxRows, dedupOutstanding, deriveInbox, findInboxRow, isResolved } from "../src/inbox";
import { appendEvent, appendHumanEvent } from "../src/log";

describe("Inbox derivation", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-inbox-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("an empty store has an empty Inbox", () => {
    expect(deriveInbox(home)).toEqual([]);
  });

  test("a human deny becomes an Inbox item numbered from 1", () => {
    appendEvent(
      home,
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        "deny",
        { match: "gh pr merge", effect: "human" },
      ),
    );

    const inbox = deriveInbox(home);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      id: 1,
      session: "sess-1",
      action: { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
      blocked: true,
    });
  });

  test("a human match the caller could NOT deny (no block Capability) still becomes an Inbox item, marked not blocked (ADR 0001, ticket 06)", () => {
    appendEvent(
      home,
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        "allow",
        { match: "gh pr merge", effect: "human" },
      ),
    );

    const inbox = deriveInbox(home);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ id: 1, session: "sess-1", blocked: false });
  });

  test("a flag allow never becomes an Inbox item", () => {
    appendEvent(
      home,
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "railway run -- psql", tool: "Bash" },
        "allow",
        { match: "railway run", effect: "flag" },
      ),
    );

    expect(deriveInbox(home)).toEqual([]);
  });

  test("Inbox items across Sessions are numbered chronologically", async () => {
    appendEvent(
      home,
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
    );
    appendEvent(
      home,
      {
        v: 1,
        ts: "2026-10-23T10:00:05.000Z",
        session: "sess-2",
        type: "action.decided",
        data: {
          action: { kind: "shell", command: "git worktree remove foo", tool: "Bash" },
          decision: "deny",
          rule: { match: "git worktree remove", effect: "human" },
        },
      },
    );

    const inbox = deriveInbox(home);
    expect(inbox.map((i) => i.id)).toEqual([1, 2]);
    expect(inbox[0]?.session).toBe("sess-1");
    expect(inbox[1]?.session).toBe("sess-2");
  });

  test("a resolved item drops out of the Inbox, and the one after it keeps its id", () => {
    appendEvent(home, {
      v: 1,
      ts: "2026-10-23T10:00:00.000Z",
      session: "sess-1",
      type: "action.decided",
      data: {
        action: { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        decision: "deny",
        rule: { match: "gh pr merge", effect: "human" },
      },
    });
    appendEvent(home, {
      v: 1,
      ts: "2026-10-23T10:00:05.000Z",
      session: "sess-2",
      type: "action.decided",
      data: {
        action: { kind: "shell", command: "git worktree remove foo", tool: "Bash" },
        decision: "deny",
        rule: { match: "git worktree remove", effect: "human" },
      },
    });

    appendHumanEvent(home, approvalResolvedEvent("sess-1", "1", "done"));

    const inbox = deriveInbox(home);
    expect(inbox.map((i) => i.id)).toEqual([2]);
    expect(inbox[0]?.session).toBe("sess-2");
  });

  test("resolving every item leaves an empty Inbox, not an error", () => {
    appendEvent(home, {
      v: 1,
      ts: "2026-10-23T10:00:00.000Z",
      session: "sess-1",
      type: "action.decided",
      data: {
        action: { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        decision: "deny",
        rule: { match: "gh pr merge", effect: "human" },
      },
    });
    appendHumanEvent(home, approvalResolvedEvent("sess-1", "1", "dismissed"));

    expect(deriveInbox(home)).toEqual([]);
  });

  test("two denies that tie on the same millisecond still assign ids deterministically", () => {
    const tied = "2026-10-23T10:00:00.000Z";
    appendEvent(home, {
      v: 1,
      ts: tied,
      session: "sess-b",
      type: "action.decided",
      data: {
        action: { kind: "shell", command: "gh pr merge 1", tool: "Bash" },
        decision: "deny",
        rule: { match: "gh pr merge", effect: "human" },
      },
    });
    appendEvent(home, {
      v: 1,
      ts: tied,
      session: "sess-a",
      type: "action.decided",
      data: {
        action: { kind: "shell", command: "gh pr merge 2", tool: "Bash" },
        decision: "deny",
        rule: { match: "gh pr merge", effect: "human" },
      },
    });

    // Session names break the tie alphabetically, independent of append
    // order or directory-read order — so re-deriving always agrees.
    const first = deriveInbox(home);
    const second = deriveInbox(home);
    expect(first).toEqual(second);
    expect(first.find((i) => i.session === "sess-a")?.id).toBe(1);
    expect(first.find((i) => i.session === "sess-b")?.id).toBe(2);
  });
});

describe("buildInboxRows (pure)", () => {
  test("assigns 1-indexed ids by position, in the order given", () => {
    const events: ActionDecidedEvent[] = [
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "gh pr merge 1", tool: "Bash" },
        "deny",
        { match: "gh pr merge", effect: "human" },
      ),
      actionDecidedEvent(
        "sess-2",
        { kind: "shell", command: "gh pr merge 2", tool: "Bash" },
        "deny",
        { match: "gh pr merge", effect: "human" },
      ),
    ];

    const rows = buildInboxRows(events);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows.map((r) => r.session)).toEqual(["sess-1", "sess-2"]);
  });

  test("an empty list of denies builds an empty list of rows", () => {
    expect(buildInboxRows([])).toEqual([]);
  });

  test("blocked reflects the Event's own decision: deny -> true, allow -> false (ADR 0001, ticket 06)", () => {
    const rows = buildInboxRows([
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "gh pr merge 1", tool: "Bash" },
        "deny",
        { match: "gh pr merge", effect: "human" },
      ),
      actionDecidedEvent(
        "sess-2",
        { kind: "shell", command: "gh pr merge 2", tool: "Bash" },
        "allow",
        { match: "gh pr merge", effect: "human" },
      ),
    ]);

    expect(rows.map((r) => r.blocked)).toEqual([true, false]);
  });
});

describe("dedupOutstanding (pure)", () => {
  const rowA = {
    id: 1,
    session: "sess-1",
    ts: "t1",
    action: { kind: "shell" as const, command: "a", tool: "Bash" },
    blocked: true,
  };
  const rowB = {
    id: 2,
    session: "sess-2",
    ts: "t2",
    action: { kind: "shell" as const, command: "b", tool: "Bash" },
    blocked: true,
  };

  test("drops a row whose id is in the resolved set", () => {
    expect(dedupOutstanding([rowA, rowB], new Set(["1"]))).toEqual([rowB]);
  });

  test("keeps every row when nothing is resolved", () => {
    expect(dedupOutstanding([rowA, rowB], new Set())).toEqual([rowA, rowB]);
  });
});

describe("findInboxRow / isResolved", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-inbox-find-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("findInboxRow reaches a row across the FULL history, resolved or not", () => {
    appendEvent(
      home,
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        "deny",
        { match: "gh pr merge", effect: "human" },
      ),
    );
    appendHumanEvent(home, approvalResolvedEvent("sess-1", "1", "done"));

    expect(findInboxRow(home, 1)).toMatchObject({ id: 1, session: "sess-1" });
    expect(findInboxRow(home, 99)).toBeUndefined();
  });

  test("isResolved is false until a matching approval.resolved lands", () => {
    appendEvent(
      home,
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        "deny",
        { match: "gh pr merge", effect: "human" },
      ),
    );

    expect(isResolved(home, 1)).toBe(false);
    appendHumanEvent(home, approvalResolvedEvent("sess-1", "1", "dismissed"));
    expect(isResolved(home, 1)).toBe(true);
  });
});
