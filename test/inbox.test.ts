import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ActionDecidedEvent,
  actionDecidedEvent,
  approvalResolvedEvent,
} from "../src/contract/event";
import { inboxIdentityHash } from "../src/identity";
import {
  allInboxIdentityHashes,
  buildInboxRows,
  dedupOutstanding,
  deriveInbox,
  deriveInboxReport,
  findInboxRow,
  type HumanMatchLine,
  isResolved,
  shortIdIndex,
} from "../src/inbox";
import { appendEvent, appendHumanEvent } from "../src/log";
import { humanLogPath } from "../src/paths";

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

  test("a human deny becomes an Inbox item identified by (Session, line) — line 1 for a Session's first Event", () => {
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
      id: inboxIdentityHash("sess-1", 1),
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
    expect(inbox[0]).toMatchObject({ id: inboxIdentityHash("sess-1", 1), session: "sess-1", blocked: false });
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

  test("Inbox items across Sessions each hash from their OWN Session's line — never a cross-Session position", () => {
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

    const inbox = deriveInbox(home);
    expect(inbox.map((i) => i.id)).toEqual([inboxIdentityHash("sess-1", 1), inboxIdentityHash("sess-2", 1)]);
    expect(inbox[0]?.session).toBe("sess-1");
    expect(inbox[1]?.session).toBe("sess-2");
  });

  test("a resolved item drops out of the Inbox, and the other keeps its own (unrelated) id", () => {
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

    appendHumanEvent(home, approvalResolvedEvent("sess-1", inboxIdentityHash("sess-1", 1), "done"));

    const inbox = deriveInbox(home);
    expect(inbox.map((i) => i.id)).toEqual([inboxIdentityHash("sess-2", 1)]);
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
    appendHumanEvent(home, approvalResolvedEvent("sess-1", inboxIdentityHash("sess-1", 1), "dismissed"));

    expect(deriveInbox(home)).toEqual([]);
  });

  test("two denies that tie on the same millisecond, in DIFFERENT Sessions, still each hash from their own (session, line) — order never matters for identity", () => {
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

    const first = deriveInbox(home);
    const second = deriveInbox(home);
    expect(first).toEqual(second);
    expect(first.find((i) => i.session === "sess-a")?.id).toBe(inboxIdentityHash("sess-a", 1));
    expect(first.find((i) => i.session === "sess-b")?.id).toBe(inboxIdentityHash("sess-b", 1));
  });

  test("legacy v0.1 upgrade: a bare numeric ref in human.jsonl is translated with the frozen positional rule and never reopens", () => {
    // Two denies, chronologically sess-1 then sess-2 — the v0.1 install
    // would have shown these as #1 and #2.
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

    // A v0.1 install's own human.jsonl: a bare "1", never a hash.
    appendHumanEvent(home, approvalResolvedEvent("sess-1", "1", "done"));

    const inbox = deriveInbox(home);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.session).toBe("sess-2");
    expect(inbox[0]?.id).toBe(inboxIdentityHash("sess-2", 1));

    // Idempotent: re-deriving (as a second `tenaza` invocation would) must
    // not reopen #1 nor double-resolve anything.
    expect(deriveInbox(home)).toEqual(inbox);
  });

  test("legacy upgrade is a no-op once a ref is already a v0.2 hash — a v0.2 binary reading an already-translated human.jsonl never reopens or double-resolves", () => {
    appendEvent(
      home,
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        "deny",
        { match: "gh pr merge", effect: "human" },
      ),
    );
    const full = inboxIdentityHash("sess-1", 1);
    appendHumanEvent(home, approvalResolvedEvent("sess-1", full, "done"));

    expect(deriveInbox(home)).toEqual([]);
    expect(isResolved(home, full)).toBe(true);
    // Re-deriving again changes nothing.
    expect(deriveInbox(home)).toEqual([]);
  });

  test("a legacy ref past the end of the chronological history translates to nothing, rather than guessing", () => {
    appendEvent(
      home,
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        "deny",
        { match: "gh pr merge", effect: "human" },
      ),
    );
    appendHumanEvent(home, approvalResolvedEvent("sess-1", "99", "done"));

    // The one real item stays open — "99" named nothing real.
    expect(deriveInbox(home)).toHaveLength(1);
  });
});

describe("buildInboxRows (pure)", () => {
  function line(event: ActionDecidedEvent, lineNumber: number): HumanMatchLine {
    return { event, line: lineNumber };
  }

  test("hashes each row from its OWN (session, line) — never a position in the list given", () => {
    const rows = buildInboxRows([
      line(
        actionDecidedEvent(
          "sess-1",
          { kind: "shell", command: "gh pr merge 1", tool: "Bash" },
          "deny",
          { match: "gh pr merge", effect: "human" },
        ),
        1,
      ),
      line(
        actionDecidedEvent(
          "sess-2",
          { kind: "shell", command: "gh pr merge 2", tool: "Bash" },
          "deny",
          { match: "gh pr merge", effect: "human" },
        ),
        3, // e.g. the third line in sess-2's own log (two earlier non-human Events) — the id must reflect THAT line, not this row's position (1).
      ),
    ]);

    expect(rows.map((r) => r.id)).toEqual([inboxIdentityHash("sess-1", 1), inboxIdentityHash("sess-2", 3)]);
    expect(rows.map((r) => r.session)).toEqual(["sess-1", "sess-2"]);
  });

  test("an empty list of denies builds an empty list of rows", () => {
    expect(buildInboxRows([])).toEqual([]);
  });

  test("blocked reflects the Event's own decision: deny -> true, allow -> false (ADR 0001, ticket 06)", () => {
    const rows = buildInboxRows([
      line(
        actionDecidedEvent(
          "sess-1",
          { kind: "shell", command: "gh pr merge 1", tool: "Bash" },
          "deny",
          { match: "gh pr merge", effect: "human" },
        ),
        1,
      ),
      line(
        actionDecidedEvent(
          "sess-2",
          { kind: "shell", command: "gh pr merge 2", tool: "Bash" },
          "allow",
          { match: "gh pr merge", effect: "human" },
        ),
        1,
      ),
    ]);

    expect(rows.map((r) => r.blocked)).toEqual([true, false]);
  });
});

describe("dedupOutstanding (pure)", () => {
  const idA = inboxIdentityHash("sess-1", 1);
  const idB = inboxIdentityHash("sess-2", 1);
  const rowA = {
    id: idA,
    session: "sess-1",
    ts: "t1",
    action: { kind: "shell" as const, command: "a", tool: "Bash" },
    blocked: true,
    decision: "deny" as const,
  };
  const rowB = {
    id: idB,
    session: "sess-2",
    ts: "t2",
    action: { kind: "shell" as const, command: "b", tool: "Bash" },
    blocked: true,
    decision: "deny" as const,
  };

  test("drops a row whose id is in the resolved set", () => {
    expect(dedupOutstanding([rowA, rowB], new Set([idA]))).toEqual([rowB]);
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

  test("findInboxRow reaches a row across the FULL history, resolved or not, by its FULL identity hash", () => {
    appendEvent(
      home,
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        "deny",
        { match: "gh pr merge", effect: "human" },
      ),
    );
    const id = inboxIdentityHash("sess-1", 1);
    appendHumanEvent(home, approvalResolvedEvent("sess-1", id, "done"));

    expect(findInboxRow(home, id)).toMatchObject({ id, session: "sess-1" });
    expect(findInboxRow(home, "0".repeat(40))).toBeUndefined();
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
    const id = inboxIdentityHash("sess-1", 1);

    expect(isResolved(home, id)).toBe(false);
    appendHumanEvent(home, approvalResolvedEvent("sess-1", id, "dismissed"));
    expect(isResolved(home, id)).toBe(true);
  });
});

describe("allInboxIdentityHashes / shortIdIndex", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-inbox-shorten-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("allInboxIdentityHashes covers the full history, resolved or not", () => {
    appendEvent(
      home,
      actionDecidedEvent("sess-1", { kind: "shell", command: "a", tool: "Bash" }, "deny", {
        match: "a",
        effect: "human",
      }),
    );
    appendHumanEvent(home, approvalResolvedEvent("sess-1", inboxIdentityHash("sess-1", 1), "done"));

    expect(allInboxIdentityHashes(home)).toEqual([inboxIdentityHash("sess-1", 1)]);
    // Resolved, so it drops out of the OPEN Inbox, but stays in the universe.
    expect(deriveInbox(home)).toEqual([]);
  });

  test("shortIdIndex gives every item at least a 4-char display id, lengthened only where two collide", () => {
    // Two sessions whose (session, "1") sha1 hashes share the 4-char
    // prefix "dce9", diverging at the 5th character — found by brute
    // force against the exact hash scheme `identity.ts` implements.
    appendEvent(
      home,
      actionDecidedEvent("sess-collide-59", { kind: "shell", command: "a", tool: "Bash" }, "deny", {
        match: "a",
        effect: "human",
      }),
    );
    appendEvent(
      home,
      actionDecidedEvent("sess-collide-133", { kind: "shell", command: "b", tool: "Bash" }, "deny", {
        match: "b",
        effect: "human",
      }),
    );

    const idA = inboxIdentityHash("sess-collide-59", 1);
    const idB = inboxIdentityHash("sess-collide-133", 1);
    expect(idA.slice(0, 4)).toBe("dce9");
    expect(idB.slice(0, 4)).toBe("dce9");

    const shortIds = shortIdIndex(home);
    expect(shortIds.get(idA)).toBe(idA.slice(0, 5));
    expect(shortIds.get(idB)).toBe(idB.slice(0, 5));
    expect(shortIds.get(idA)).not.toBe(shortIds.get(idB));
  });
});

describe("deriveInboxReport (ticket 01's skippedLines, plus ticket 06's allIds)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-inbox-report-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("allIds reflects the full history the SAME single read computed skippedLines from", () => {
    appendEvent(
      home,
      actionDecidedEvent("sess-1", { kind: "shell", command: "a", tool: "Bash" }, "deny", {
        match: "a",
        effect: "human",
      }),
    );
    writeFileSync(humanLogPath(home), "{torn\n");

    const report = deriveInboxReport(home);
    expect(report.allIds).toEqual([inboxIdentityHash("sess-1", 1)]);
    expect(report.skipped).toBe(1);
  });
});
