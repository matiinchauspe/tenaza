import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { actionDecidedEvent, sessionStartedEvent } from "../src/contract/event";
import { inboxIdentityHash } from "../src/identity";
import { deriveInbox } from "../src/inbox";
import { appendEvent, readHumanEvents } from "../src/log";
import { readNotificationRecorder } from "../src/notify";
import {
  resolveInboxItem,
  runInboxItem,
  startInboxItemRunStream,
  UnknownInboxItemError,
} from "../src/resolve";
import { parseRunOutput, RUN_FAILURE_MARKER } from "../src/runoutput";

/** When `openItem` is the ONLY Event written for "sess-1", its `action.decided` lands on line 1. */
const ID = inboxIdentityHash("sess-1", 1);
/** When a `session.started` (`startSession`) precedes it, `openItem`'s own Event lands on line 2 instead. */
const ID_AFTER_START = inboxIdentityHash("sess-1", 2);
const UNKNOWN_ID = "0".repeat(40);

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

/** A Session's `session.started` (ticket 06: `run` needs this for its `cwd`) — defaults to `home` itself, which always exists, so a test that doesn't care about `cwd` specifically doesn't need its own directory. */
function startSession(home: string, session: string, cwd: string = home): void {
  appendEvent(home, sessionStartedEvent(session, { runtime: "fake", cwd, capabilities: ["observe", "block"] }));
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

    const result = resolveInboxItem(home, ID, "done");

    expect(result).toEqual({ alreadyResolved: false });
    expect(deriveInbox(home)).toEqual([]);

    const events = readHumanEvents(home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval.resolved",
      session: "sess-1",
      data: { ref: ID, outcome: "done" },
    });
  });

  test("dismiss closes an open item as dismissed", () => {
    openItem(home, "sess-1", "gh pr merge 58");

    const result = resolveInboxItem(home, ID, "dismissed");

    expect(result).toEqual({ alreadyResolved: false });
    expect(deriveInbox(home)).toEqual([]);
    expect(readHumanEvents(home)[0]).toMatchObject({ data: { outcome: "dismissed" } });
  });

  test("resolving an already-closed item is a no-op: no error, no second Event", () => {
    openItem(home, "sess-1", "gh pr merge 58");
    resolveInboxItem(home, ID, "done");

    const second = resolveInboxItem(home, ID, "dismissed");

    expect(second).toEqual({ alreadyResolved: true });
    expect(readHumanEvents(home)).toHaveLength(1); // still just the first Event
    expect(readHumanEvents(home)[0]).toMatchObject({ data: { outcome: "done" } }); // unchanged
  });

  test("an unknown id throws UnknownInboxItemError, not a generic error", () => {
    openItem(home, "sess-1", "gh pr merge 58");

    expect(() => resolveInboxItem(home, UNKNOWN_ID, "done")).toThrow(UnknownInboxItemError);
  });

  test("done never executes the stored command", async () => {
    const marker = path.join(home, "marker");
    openItem(home, "sess-1", `touch ${marker}`);

    resolveInboxItem(home, ID, "done");

    expect(existsSync(marker)).toBe(false);
  });

  test("a Resolution (ticket 08: 'resolutions send nothing') never sends a notification", () => {
    // `openItem` writes the `action.decided` Event directly (bypassing
    // `decideAction`, which is the only place 🟡 fires) — isolating this
    // test to `resolveInboxItem`'s OWN behavior: resolving must add nothing.
    openItem(home, "sess-1", "gh pr merge 58");
    resolveInboxItem(home, ID, "done");

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
    startSession(home, "sess-1");
    openItem(home, "sess-1", "true");

    const outcome = await runInboxItem(home, ID_AFTER_START);

    expect(outcome).toEqual({ kind: "closed" });
    expect(deriveInbox(home)).toEqual([]);
    expect(readHumanEvents(home)[0]).toMatchObject({ data: { ref: ID_AFTER_START, outcome: "done" } });
  });

  test("closing the item via `run` (ticket 08: 'resolutions send nothing') sends no notification either", async () => {
    startSession(home, "sess-1");
    openItem(home, "sess-1", "true");

    await runInboxItem(home, ID_AFTER_START);

    expect(readNotificationRecorder(home)).toEqual([]);
  });

  test("a stored `false` leaves the item open, reporting the exit code", async () => {
    startSession(home, "sess-1");
    openItem(home, "sess-1", "false");

    const outcome = await runInboxItem(home, ID_AFTER_START);

    expect(outcome).toEqual({ kind: "stays-open", exitCode: 1 });
    expect(deriveInbox(home)).toHaveLength(1); // still open
    expect(readHumanEvents(home)).toEqual([]); // no Event written on failure
  });

  test("running an already-resolved item is a no-op and never re-executes the command", async () => {
    startSession(home, "sess-1");
    const marker = path.join(home, "marker");
    openItem(home, "sess-1", `touch ${marker}`);
    resolveInboxItem(home, ID_AFTER_START, "dismissed");

    const outcome = await runInboxItem(home, ID_AFTER_START);

    expect(outcome).toEqual({ kind: "already-resolved" });
    expect(existsSync(marker)).toBe(false);
  });

  test("an unknown id throws UnknownInboxItemError", async () => {
    startSession(home, "sess-1");
    openItem(home, "sess-1", "true");

    await expect(runInboxItem(home, UNKNOWN_ID)).rejects.toThrow(UnknownInboxItemError);
  });

  describe("runs in the REQUESTING Session's OWN cwd (ticket 06 — fixes v0.1's Bun.spawn with no cwd at all)", () => {
    let cwd: string;

    beforeEach(() => {
      cwd = mkdtempSync(path.join(tmpdir(), "tenaza-run-cwd-"));
    });

    afterEach(() => {
      rmSync(cwd, { recursive: true, force: true });
    });

    test("the stored command actually executes with that cwd, never the caller's own current directory", async () => {
      startSession(home, "sess-1", cwd);
      const marker = path.join(home, "pwd-marker");
      openItem(home, "sess-1", `pwd > "${marker}"`);

      const outcome = await runInboxItem(home, ID_AFTER_START);

      expect(outcome).toEqual({ kind: "closed" });
      const reported = readFileSync(marker, "utf8").trim();
      expect(realpathSync(reported)).toBe(realpathSync(cwd));
    });

    test("no `session.started` at all for the Session → refuses outright as 'no-cwd', never runs anywhere", async () => {
      // Deliberately no `startSession` call.
      const marker = path.join(home, "marker");
      openItem(home, "sess-1", `touch ${marker}`);

      const outcome = await runInboxItem(home, ID);

      expect(outcome).toMatchObject({ kind: "no-cwd", command: `touch ${marker}` });
      expect(existsSync(marker)).toBe(false);
      // still open — refusing to run is not a resolution
      expect(deriveInbox(home)).toHaveLength(1);
    });

    test("a cwd that no longer exists on disk → refuses outright as 'cwd-missing', never runs elsewhere", async () => {
      const removed = mkdtempSync(path.join(tmpdir(), "tenaza-run-removed-"));
      rmSync(removed, { recursive: true, force: true });
      startSession(home, "sess-1", removed);
      const marker = path.join(home, "marker");
      openItem(home, "sess-1", `touch ${marker}`);

      const outcome = await runInboxItem(home, ID_AFTER_START);

      expect(outcome).toMatchObject({ kind: "cwd-missing", cwd: removed, command: `touch ${marker}` });
      expect(existsSync(marker)).toBe(false);
      expect(deriveInbox(home)).toHaveLength(1);
    });
  });

  describe("an unblocked item (ADR 0001, ticket 06: the command already ran once)", () => {
    test("run REFUSES — never executes, never writes an Event, reports 'unblockable'", async () => {
      // No `startSession` needed: this refusal happens before the cwd is
      // ever consulted.
      const marker = path.join(home, "marker");
      openUnblockedItem(home, "sess-1", `touch ${marker}`);

      const outcome = await runInboxItem(home, ID);

      expect(outcome).toEqual({ kind: "unblockable" });
      expect(existsSync(marker)).toBe(false);
      expect(readHumanEvents(home)).toEqual([]);
      // still open — refusing to run is not a resolution
      expect(deriveInbox(home)).toHaveLength(1);
    });

    test("done still closes it, exactly as for a blocked item", () => {
      openUnblockedItem(home, "sess-1", "gh pr merge 58");

      const result = resolveInboxItem(home, ID, "done");

      expect(result).toEqual({ alreadyResolved: false });
      expect(deriveInbox(home)).toEqual([]);
    });

    test("dismiss still closes it, exactly as for a blocked item", () => {
      openUnblockedItem(home, "sess-1", "gh pr merge 58");

      const result = resolveInboxItem(home, ID, "dismissed");

      expect(result).toEqual({ alreadyResolved: false });
      expect(deriveInbox(home)).toEqual([]);
    });
  });

  describe("an mcp item (ticket 04, decision 07: no stored shell command at all)", () => {
    test("run refuses CLEANLY — reports 'not-runnable', never throws", async () => {
      // No `startSession` needed: this refusal happens before the cwd is
      // ever consulted.
      openMcpItem(home, "sess-1", "mcp__neon__run_sql", { branch_id: "br-prod" });

      const outcome = await runInboxItem(home, ID);

      expect(outcome).toEqual({ kind: "not-runnable" });
      expect(readHumanEvents(home)).toEqual([]);
      // still open — refusing to run is not a resolution
      expect(deriveInbox(home)).toHaveLength(1);
    });

    test("done closes it, exactly as for a shell item", () => {
      openMcpItem(home, "sess-1", "mcp__neon__run_sql", { branch_id: "br-prod" });

      const result = resolveInboxItem(home, ID, "done");

      expect(result).toEqual({ alreadyResolved: false });
      expect(deriveInbox(home)).toEqual([]);
    });

    test("dismiss closes it, exactly as for a shell item", () => {
      openMcpItem(home, "sess-1", "mcp__neon__run_sql", { branch_id: "br-prod" });

      const result = resolveInboxItem(home, ID, "dismissed");

      expect(result).toEqual({ alreadyResolved: false });
      expect(deriveInbox(home)).toEqual([]);
    });
  });
});

/** Read a `ReadableStream<Uint8Array>` to completion as text — the test's own oracle for "what the view would have rendered into the card." */
async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

describe("startInboxItemRunStream (the view's own `run`, decisions 05/06, ticket 09)", () => {
  let home: string;
  const previousShell = process.env.TENAZA_RUN_SHELL;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-run-stream-"));
    // `/bin/sh` is fast and profile-free — pinned so this suite never pays
    // for (or depends on) whatever startup files the DEVELOPER's own
    // `$SHELL` happens to source. Production falls through to the real
    // login shell; this is a test seam only (`resolve.ts`'s own doc
    // comment on `loginShellPath`).
    process.env.TENAZA_RUN_SHELL = "/bin/sh";
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousShell === undefined) delete process.env.TENAZA_RUN_SHELL;
    else process.env.TENAZA_RUN_SHELL = previousShell;
  });

  test("a stored `true` streams to completion, closes the item as done, and carries NO failure trailer", async () => {
    startSession(home, "sess-1");
    openItem(home, "sess-1", "true");

    const result = startInboxItemRunStream(home, ID_AFTER_START);
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") throw new Error("expected a stream");
    const output = await readStreamText(result.stream);

    expect(deriveInbox(home)).toEqual([]);
    expect(readHumanEvents(home)[0]).toMatchObject({ data: { ref: ID_AFTER_START, outcome: "done" } });
    expect(output).not.toContain(RUN_FAILURE_MARKER);
    expect(parseRunOutput(output).error).toBeUndefined();
  });

  /**
   * Review fix: "anything else stays open WITH THE ERROR" (spec) — `false`
   * prints NOTHING of its own, so without an explicit trailer the stream
   * would end silently and the card would read as a no-op, never a
   * failure. The stream's own last bytes must carry that signal.
   */
  test("a stored `false` streams to completion, leaves the item open, and ends with the es-AR failure trailer naming the exit code", async () => {
    startSession(home, "sess-1");
    openItem(home, "sess-1", "false");

    const result = startInboxItemRunStream(home, ID_AFTER_START);
    if (result.kind !== "stream") throw new Error("expected a stream");
    const output = await readStreamText(result.stream);

    expect(deriveInbox(home)).toHaveLength(1); // still open
    expect(readHumanEvents(home)).toEqual([]);
    expect(output).toContain(`${RUN_FAILURE_MARKER}1`);
    const parsed = parseRunOutput(output);
    expect(parsed.body).toBe(""); // `false` itself printed nothing
    expect(parsed.error).toBe(`${RUN_FAILURE_MARKER}1`);
  });

  test("a non-zero exit with real stdout/stderr output still appends the trailer AFTER the command's own output", async () => {
    startSession(home, "sess-1");
    openItem(home, "sess-1", "echo falló; exit 3");

    const result = startInboxItemRunStream(home, ID_AFTER_START);
    if (result.kind !== "stream") throw new Error("expected a stream");
    const output = await readStreamText(result.stream);

    const parsed = parseRunOutput(output);
    expect(parsed.body).toBe("falló");
    expect(parsed.error).toBe(`${RUN_FAILURE_MARKER}3`);
  });

  test("spawning the shell itself throws → reports spawn-failed, with no stream and no Event", async () => {
    startSession(home, "sess-1");
    openItem(home, "sess-1", "true");
    process.env.TENAZA_RUN_SHELL = path.join(tmpdir(), "tenaza-no-such-shell-binary-at-all");

    const result = startInboxItemRunStream(home, ID_AFTER_START);

    expect(result.kind).toBe("spawn-failed");
    if (result.kind !== "spawn-failed") throw new Error("expected spawn-failed");
    expect(result.message.length).toBeGreaterThan(0);
    expect(readHumanEvents(home)).toEqual([]);
    expect(deriveInbox(home)).toHaveLength(1); // still open — nothing ran
  });

  test("runs in the REQUESTING Session's OWN cwd, through a LOGIN shell — never the Daemon's own current directory", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "tenaza-run-stream-cwd-"));
    try {
      startSession(home, "sess-1", cwd);
      openItem(home, "sess-1", "pwd");

      const result = startInboxItemRunStream(home, ID_AFTER_START);
      if (result.kind !== "stream") throw new Error("expected a stream");
      const output = await readStreamText(result.stream);

      expect(realpathSync(output.trim())).toBe(realpathSync(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the stream carries the command's combined stdout+stderr", async () => {
    startSession(home, "sess-1");
    openItem(home, "sess-1", "echo out; echo err 1>&2");

    const result = startInboxItemRunStream(home, ID_AFTER_START);
    if (result.kind !== "stream") throw new Error("expected a stream");
    const output = await readStreamText(result.stream);

    expect(output).toContain("out");
    expect(output).toContain("err");
  });

  test("an already-resolved item refuses OUTRIGHT — no process spawned, same shape the CLI path reports", async () => {
    startSession(home, "sess-1");
    const marker = path.join(home, "marker");
    openItem(home, "sess-1", `touch ${marker}`);
    resolveInboxItem(home, ID_AFTER_START, "dismissed");

    const result = startInboxItemRunStream(home, ID_AFTER_START);

    expect(result).toEqual({ kind: "already-resolved" });
    expect(existsSync(marker)).toBe(false);
  });

  test("an unblocked (YA CORRIÓ) item refuses — never a second execution", async () => {
    const marker = path.join(home, "marker");
    openUnblockedItem(home, "sess-1", `touch ${marker}`);

    const result = startInboxItemRunStream(home, ID);

    expect(result).toEqual({ kind: "unblockable" });
    expect(existsSync(marker)).toBe(false);
  });

  test("an mcp item refuses as not-runnable — it has no stored shell command", async () => {
    openMcpItem(home, "sess-1", "mcp__neon__run_sql", { branch_id: "br-prod" });

    const result = startInboxItemRunStream(home, ID);

    expect(result).toEqual({ kind: "not-runnable" });
  });

  test("no session.started at all refuses as no-cwd, never runs anywhere", async () => {
    const marker = path.join(home, "marker");
    openItem(home, "sess-1", `touch ${marker}`);

    const result = startInboxItemRunStream(home, ID);

    expect(result).toMatchObject({ kind: "no-cwd", command: `touch ${marker}` });
    expect(existsSync(marker)).toBe(false);
  });

  test("a cwd that no longer exists refuses as cwd-missing", async () => {
    const removed = mkdtempSync(path.join(tmpdir(), "tenaza-run-stream-removed-"));
    rmSync(removed, { recursive: true, force: true });
    startSession(home, "sess-1", removed);
    const marker = path.join(home, "marker");
    openItem(home, "sess-1", `touch ${marker}`);

    const result = startInboxItemRunStream(home, ID_AFTER_START);

    expect(result).toMatchObject({ kind: "cwd-missing", cwd: removed, command: `touch ${marker}` });
  });

  test("an unknown id throws UnknownInboxItemError, same as the CLI path", () => {
    startSession(home, "sess-1");
    openItem(home, "sess-1", "true");

    expect(() => startInboxItemRunStream(home, UNKNOWN_ID)).toThrow(UnknownInboxItemError);
  });
});
