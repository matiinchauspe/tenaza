import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { actionDecidedEvent } from "../src/contract/event";
import { deriveInbox } from "../src/inbox";
import { appendEvent, readHumanEvents } from "../src/log";
import { readNotificationRecorder } from "../src/notify";
import {
  resolveInboxItem,
  runInboxItem,
  UnknownInboxItemError,
} from "../src/resolve";

function openItem(home: string, session: string, command: string): void {
  appendEvent(
    home,
    actionDecidedEvent(session, { kind: "shell", command, tool: "Bash" }, "deny", {
      match: command,
      effect: "human",
    }),
  );
}

/**
 * An Inbox item a Capability-lacking caller COULD NOT deny (ADR 0001, ticket
 * 06): `decision: "allow"` on a `human`-effect Rule — `blocked: false`. The
 * command already ran once; `run` must refuse a second execution of it.
 */
function openUnblockedItem(home: string, session: string, command: string): void {
  appendEvent(
    home,
    actionDecidedEvent(session, { kind: "shell", command, tool: "Bash" }, "allow", {
      match: command,
      effect: "human",
    }),
  );
}

/** An open Inbox item for an `mcp` Action (ticket 04, decision 07) — no stored shell command at all. */
function openMcpItem(home: string, session: string, tool: string, args: Record<string, unknown>): void {
  appendEvent(
    home,
    actionDecidedEvent(session, { kind: "mcp", tool, args }, "deny", {
      tool: `mcp__*`,
      effect: "human",
    }),
  );
}

describe("resolveInboxItem (done / dismiss)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-resolve-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("done closes an open item, writing one approval.resolved Event", () => {
    openItem(home, "sess-1", "gh pr merge 58");

    const result = resolveInboxItem(home, 1, "done");

    expect(result).toEqual({ alreadyResolved: false });
    expect(deriveInbox(home)).toEqual([]);

    const events = readHumanEvents(home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval.resolved",
      session: "sess-1",
      data: { ref: "1", outcome: "done" },
    });
  });

  test("dismiss closes an open item as dismissed", () => {
    openItem(home, "sess-1", "gh pr merge 58");

    const result = resolveInboxItem(home, 1, "dismissed");

    expect(result).toEqual({ alreadyResolved: false });
    expect(deriveInbox(home)).toEqual([]);
    expect(readHumanEvents(home)[0]).toMatchObject({ data: { outcome: "dismissed" } });
  });

  test("resolving an already-closed item is a no-op: no error, no second Event", () => {
    openItem(home, "sess-1", "gh pr merge 58");
    resolveInboxItem(home, 1, "done");

    const second = resolveInboxItem(home, 1, "dismissed");

    expect(second).toEqual({ alreadyResolved: true });
    expect(readHumanEvents(home)).toHaveLength(1); // still just the first Event
    expect(readHumanEvents(home)[0]).toMatchObject({ data: { outcome: "done" } }); // unchanged
  });

  test("an unknown id throws UnknownInboxItemError, not a generic error", () => {
    openItem(home, "sess-1", "gh pr merge 58");

    expect(() => resolveInboxItem(home, 99, "done")).toThrow(UnknownInboxItemError);
  });

  test("done never executes the stored command", async () => {
    const marker = path.join(home, "marker");
    openItem(home, "sess-1", `touch ${marker}`);

    resolveInboxItem(home, 1, "done");

    expect(existsSync(marker)).toBe(false);
  });

  test("a Resolution (ticket 08: 'resolutions send nothing') never sends a notification", () => {
    // `openItem` writes the `action.decided` Event directly (bypassing
    // `decideAction`, which is the only place 🟡 fires) — isolating this
    // test to `resolveInboxItem`'s OWN behavior: resolving must add nothing.
    openItem(home, "sess-1", "gh pr merge 58");
    resolveInboxItem(home, 1, "done");

    expect(readNotificationRecorder(home)).toEqual([]);
  });
});

describe("runInboxItem", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-run-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("a stored `true` closes the item as done", async () => {
    openItem(home, "sess-1", "true");

    const outcome = await runInboxItem(home, 1);

    expect(outcome).toEqual({ kind: "closed" });
    expect(deriveInbox(home)).toEqual([]);
    expect(readHumanEvents(home)[0]).toMatchObject({ data: { ref: "1", outcome: "done" } });
  });

  test("closing the item via `run` (ticket 08: 'resolutions send nothing') sends no notification either", async () => {
    openItem(home, "sess-1", "true");

    await runInboxItem(home, 1);

    expect(readNotificationRecorder(home)).toEqual([]);
  });

  test("a stored `false` leaves the item open, reporting the exit code", async () => {
    openItem(home, "sess-1", "false");

    const outcome = await runInboxItem(home, 1);

    expect(outcome).toEqual({ kind: "stays-open", exitCode: 1 });
    expect(deriveInbox(home)).toHaveLength(1); // still open
    expect(readHumanEvents(home)).toEqual([]); // no Event written on failure
  });

  test("running an already-resolved item is a no-op and never re-executes the command", async () => {
    const marker = path.join(home, "marker");
    openItem(home, "sess-1", `touch ${marker}`);
    resolveInboxItem(home, 1, "dismissed");

    const outcome = await runInboxItem(home, 1);

    expect(outcome).toEqual({ kind: "already-resolved" });
    expect(existsSync(marker)).toBe(false);
  });

  test("an unknown id throws UnknownInboxItemError", async () => {
    openItem(home, "sess-1", "true");

    await expect(runInboxItem(home, 99)).rejects.toThrow(UnknownInboxItemError);
  });

  describe("an unblocked item (ADR 0001, ticket 06: the command already ran once)", () => {
    test("run REFUSES — never executes, never writes an Event, reports 'unblockable'", async () => {
      const marker = path.join(home, "marker");
      openUnblockedItem(home, "sess-1", `touch ${marker}`);

      const outcome = await runInboxItem(home, 1);

      expect(outcome).toEqual({ kind: "unblockable" });
      expect(existsSync(marker)).toBe(false);
      expect(readHumanEvents(home)).toEqual([]);
      // still open — refusing to run is not a resolution
      expect(deriveInbox(home)).toHaveLength(1);
    });

    test("done still closes it, exactly as for a blocked item", () => {
      openUnblockedItem(home, "sess-1", "gh pr merge 58");

      const result = resolveInboxItem(home, 1, "done");

      expect(result).toEqual({ alreadyResolved: false });
      expect(deriveInbox(home)).toEqual([]);
    });

    test("dismiss still closes it, exactly as for a blocked item", () => {
      openUnblockedItem(home, "sess-1", "gh pr merge 58");

      const result = resolveInboxItem(home, 1, "dismissed");

      expect(result).toEqual({ alreadyResolved: false });
      expect(deriveInbox(home)).toEqual([]);
    });
  });

  describe("an mcp item (ticket 04, decision 07: no stored shell command at all)", () => {
    test("run refuses CLEANLY — reports 'not-runnable', never throws", async () => {
      openMcpItem(home, "sess-1", "mcp__neon__run_sql", { branch_id: "br-prod" });

      const outcome = await runInboxItem(home, 1);

      expect(outcome).toEqual({ kind: "not-runnable" });
      expect(readHumanEvents(home)).toEqual([]);
      // still open — refusing to run is not a resolution
      expect(deriveInbox(home)).toHaveLength(1);
    });

    test("done closes it, exactly as for a shell item", () => {
      openMcpItem(home, "sess-1", "mcp__neon__run_sql", { branch_id: "br-prod" });

      const result = resolveInboxItem(home, 1, "done");

      expect(result).toEqual({ alreadyResolved: false });
      expect(deriveInbox(home)).toEqual([]);
    });

    test("dismiss closes it, exactly as for a shell item", () => {
      openMcpItem(home, "sess-1", "mcp__neon__run_sql", { branch_id: "br-prod" });

      const result = resolveInboxItem(home, 1, "dismissed");

      expect(result).toEqual({ alreadyResolved: false });
      expect(deriveInbox(home)).toEqual([]);
    });
  });
});
