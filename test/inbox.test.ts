import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { actionDecidedEvent } from "../src/contract/event";
import { deriveInbox } from "../src/inbox";
import { appendEvent } from "../src/log";

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
    });
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
});
