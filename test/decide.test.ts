import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { liveAnsweredEvent } from "../src/contract/event";
import { writeAlive } from "../src/daemonlink";
import { decideAction } from "../src/decide";
import { inboxIdentityHash } from "../src/identity";
import { deriveInbox } from "../src/inbox";
import { appendHumanEvent, readSessionEvents } from "../src/log";
import { readNotificationRecorder } from "../src/notify";
import { sessionLogPath } from "../src/paths";

/** A fresh decideAction result's `inboxId` is always its own short hash (decision 03, ADR 0005, ticket 06) — at least 4 hex characters, never a bare position. */
const HASH_ID = /^[0-9a-f]{4,40}$/;

describe("decideAction", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-decide-"));
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[[rule]]
match = "gh pr merge"
effect = "human"

[[rule]]
match = "railway run"
effect = "flag"
`,
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("a human rule denies and opens an Inbox item", async () => {
    const result = await decideAction(home, "sess-1", {
      kind: "shell",
      command: "gh pr merge 58",
      tool: "Bash",
    });

    expect(result.decision).toBe("deny");
    expect(result.decision === "deny" && result.inboxId).toMatch(HASH_ID);

    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "action.decided", data: { decision: "deny" } });

    expect(deriveInbox(home)).toHaveLength(1);
  });

  test("a flag rule allows and still records action.decided", async () => {
    const result = await decideAction(home, "sess-1", {
      kind: "shell",
      command: "railway run -- psql",
      tool: "Bash",
    });

    expect(result.decision).toBe("allow");
    expect(result.logged).toBe(true);

    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "action.decided", data: { decision: "allow" } });

    expect(deriveInbox(home)).toHaveLength(0);
  });

  test("an Action matching no Rule is allowed and NOT logged", async () => {
    const result = await decideAction(home, "sess-1", {
      kind: "shell",
      command: "ls -la",
      tool: "Bash",
    });

    expect(result.decision).toBe("allow");
    expect(result.logged).toBe(false);
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("successive denies in the same session each get their OWN id, and neither changes once assigned", async () => {
    const first = await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 1", tool: "Bash" });
    const second = await decideAction(home, "sess-1", {
      kind: "shell",
      command: "gh pr merge 2",
      tool: "Bash",
    });

    expect(first.decision === "deny" && first.inboxId).toMatch(HASH_ID);
    expect(second.decision === "deny" && second.inboxId).toMatch(HASH_ID);
    expect(first.decision === "deny" && second.decision === "deny" && first.inboxId).not.toBe(
      second.decision === "deny" && second.inboxId,
    );
  });

  describe("Capability-gated denial (ADR 0001)", () => {
    test("a human rule DENIES when the caller declares the block Capability", async () => {
      const result = await decideAction(
        home,
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        ["observe", "block"],
      );

      expect(result.decision).toBe("deny");
    });

    test("a human rule CANNOT deny without the block Capability — degrades to allow, same shape as a flag match", async () => {
      const result = await decideAction(
        home,
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        ["observe"],
      );

      expect(result.decision).toBe("allow");
      expect(result.logged).toBe(true);
    });

    test("without block, the Action is still RECORDED — never silently dropped", async () => {
      await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" }, [
        "observe",
      ]);

      const events = readSessionEvents("sess-1", home);
      expect(events).toHaveLength(1);
      // The log stays honest: the Policy's own verdict for this Rule is
      // "human", and the decision truthfully reads "allow" — it was never
      // actually blocked, so claiming "deny" here would be a lie.
      expect(events[0]).toMatchObject({
        type: "action.decided",
        data: { decision: "allow", rule: { effect: "human" } },
      });
    });

    test("without block, the Action is still SURFACED in the Inbox — not silently dropped", async () => {
      await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" }, [
        "observe",
      ]);

      const inbox = deriveInbox(home);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ blocked: false, session: "sess-1" });
    });

    test("with no Capabilities given at all, the Policy's own human Rule still enforces as before (back-compat default)", async () => {
      const result = await decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 58",
        tool: "Bash",
      });

      expect(result.decision).toBe("deny");
    });
  });

  describe("notifications (ticket 08: 🟡 fires at the single point an Inbox item opens)", () => {
    test("a human rule deny also sends exactly one 🟡, naming the SAME short hash the decision returned", async () => {
      const result = await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });
      const shortId = result.decision === "deny" ? result.inboxId : undefined;

      const notifications = readNotificationRecorder(home);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.title).toContain(`inbox ${shortId}`);
      expect(notifications[0]?.message).toContain(`tenaza run ${shortId}`);
    });

    test("an unenforceable human match (no block Capability) ALSO sends one 🟡 — never silently dropped (ADR 0001)", async () => {
      await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" }, [
        "observe",
      ]);

      const notifications = readNotificationRecorder(home);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.message).toContain("ya corrió");
      expect(notifications[0]?.message).not.toContain("tenaza run");
    });

    test("a flag rule never sends a notification", async () => {
      await decideAction(home, "sess-1", { kind: "shell", command: "railway run -- psql", tool: "Bash" });

      expect(readNotificationRecorder(home)).toEqual([]);
    });

    test("an Action matching no Rule never sends a notification", async () => {
      await decideAction(home, "sess-1", { kind: "shell", command: "ls -la", tool: "Bash" });

      expect(readNotificationRecorder(home)).toEqual([]);
    });

    test("two successive denies in the same Session send two 🟡, one per Inbox item, with DIFFERENT tags", async () => {
      await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 1", tool: "Bash" });
      await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 2", tool: "Bash" });

      const notifications = readNotificationRecorder(home);
      expect(notifications).toHaveLength(2);
      expect(notifications[0]?.tag).toMatch(/^inbox-[0-9a-f]{40}$/);
      expect(notifications[1]?.tag).toMatch(/^inbox-[0-9a-f]{40}$/);
      expect(notifications[0]?.tag).not.toBe(notifications[1]?.tag);
    });
  });

  describe("ADR 0007 (ticket 01): the decision holds even when a side effect fails", () => {
    test("a human rule still denies even when logging the decision fails — the id comes back undefined, never a stale one", async () => {
      // Force a real fs failure: a plain FILE sits where the Session log's
      // own directory needs to be, so `appendEvent`'s `mkdirSync` throws.
      mkdirSync(path.join(home, "state"), { recursive: true });
      writeFileSync(path.join(home, "state", "sessions"), "not a directory");

      const result = await decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 58",
        tool: "Bash",
      });

      expect(result.decision).toBe("deny");
      expect(result.decision === "deny" && result.inboxId).toBeUndefined();
    });

    test("a flag rule still allows, and never throws, when logging fails", async () => {
      mkdirSync(path.join(home, "state"), { recursive: true });
      writeFileSync(path.join(home, "state", "sessions"), "not a directory");

      const result = await decideAction(home, "sess-1", {
        kind: "shell",
        command: "railway run -- psql",
        tool: "Bash",
      });

      expect(result.decision).toBe("allow");
      expect(result.logged).toBe(true);
    });
  });

  describe("ADR 0007 (ticket 01): a torn line encountered while deriving the Inbox id is reported through decideAction's own result", () => {
    test("skippedLines is set when deriving the id hits a torn line, and the decision still holds", async () => {
      await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 1", tool: "Bash" });
      // A torn line in a DIFFERENT Session's log — read while deriving the
      // Inbox for the second deny below, never thrown on (readLog's own
      // tolerance), but still reported here rather than silently dropped.
      writeFileSync(sessionLogPath("sess-2", home), "{torn\n");

      const second = await decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 2",
        tool: "Bash",
      });

      expect(second.decision).toBe("deny");
      expect(second.decision === "deny" && second.skippedLines).toBe(1);
      expect(second.decision === "deny" && second.inboxId).toMatch(HASH_ID); // still correctly derived despite the torn line
    });

    test("skippedLines is undefined when nothing was skipped", async () => {
      const result = await decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 1",
        tool: "Bash",
      });

      expect(result.decision === "deny" && result.skippedLines).toBeUndefined();
    });

    test("skippedLines is never set for a flag match or a no-match — neither ever reads a Session log", async () => {
      const flag = await decideAction(home, "sess-1", {
        kind: "shell",
        command: "railway run -- psql",
        tool: "Bash",
      });
      expect(flag.logged && flag.skippedLines).toBeUndefined();

      const noMatch = await decideAction(home, "sess-1", { kind: "shell", command: "ls -la", tool: "Bash" });
      expect(noMatch.logged).toBe(false);
    });
  });

  describe("mcp Actions (ticket 04, decision 07)", () => {
    beforeEach(() => {
      writeFileSync(
        path.join(home, "config", "policy.toml"),
        `
[[rule]]
tool = "mcp__*neon*__run_sql*"
unless = { branch_id = ["br-dev-123"] }
effect = "human"

[[rule]]
tool = "mcp__*vercel*"
effect = "flag"
`,
      );
    });

    test("a human mcp Rule denies and opens an Inbox item, carrying the Action's tool and args", async () => {
      const result = await decideAction(home, "sess-1", {
        kind: "mcp",
        tool: "mcp__neon__run_sql",
        args: { branch_id: "br-prod" },
      });

      expect(result.decision).toBe("deny");
      expect(result.decision === "deny" && result.inboxId).toMatch(HASH_ID);

      const events = readSessionEvents("sess-1", home);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "action.decided",
        data: { action: { kind: "mcp", tool: "mcp__neon__run_sql" }, decision: "deny" },
      });
    });

    test("a flag mcp Rule allows and still records action.decided", async () => {
      const result = await decideAction(home, "sess-1", {
        kind: "mcp",
        tool: "mcp__vercel__promote_deployment",
        args: { target: "production" },
      });

      expect(result.decision).toBe("allow");
      expect(result.logged).toBe(true);
      expect(deriveInbox(home)).toHaveLength(0);
    });

    test("unless with a safe branch_id exempts the call — allowed and NOT logged", async () => {
      const result = await decideAction(home, "sess-1", {
        kind: "mcp",
        tool: "mcp__neon__run_sql",
        args: { branch_id: "br-dev-123" },
      });

      expect(result.decision).toBe("allow");
      expect(result.logged).toBe(false);
    });
  });

  describe("Live answering (ticket 10, decision 06)", () => {
    beforeEach(() => {
      writeFileSync(
        path.join(home, "config", "policy.toml"),
        `
[[rule]]
match = "gh pr merge"
effect = "human"

[live]
wait_seconds = 2
`,
      );
      process.env.TENAZA_LIVE_POLL_MS = "20";
    });

    afterEach(() => {
      delete process.env.TENAZA_LIVE_POLL_MS;
    });

    function postAnswer(session: string, answer: "approve" | "reject", message?: string): void {
      // The hold's identity line is the FIRST `action.decided` line this
      // fresh Session ever writes — line 1 — matching `decideAction`'s own
      // `inboxIdentityHash(session, line)`.
      const fullId = inboxIdentityHash(session, 1);
      appendHumanEvent(home, liveAnsweredEvent(session, fullId, answer, message));
    }

    test("no Daemon up at all (absent heartbeat) — degrades to the exact v0.1 immediate deny, no hold attempted", async () => {
      const startedAt = Date.now();
      const result = await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });
      const elapsedMs = Date.now() - startedAt;

      expect(result.decision).toBe("deny");
      expect(elapsedMs).toBeLessThan(500); // never waited for the 2s window
      expect(result.decision === "deny" && result.reason).toBeUndefined(); // the plain wording, untouched
    });

    test("Daemon up (fresh heartbeat), human answers APPROVE with a message — allows, message as additionalContext, item closes", async () => {
      writeAlive(home);
      const decisionPromise = decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 58",
        tool: "Bash",
      });
      await Bun.sleep(60);
      postAnswer("sess-1", "approve", "dale, adelante");

      const result = await decisionPromise;
      expect(result.decision).toBe("allow");
      expect(result.logged && result.decision === "allow" && result.additionalContext).toBe("dale, adelante");
      expect(deriveInbox(home)).toHaveLength(0); // closed — no longer open
    });

    test("approve with NO message — allows, additionalContext stays undefined (never an empty string)", async () => {
      writeAlive(home);
      const decisionPromise = decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 58",
        tool: "Bash",
      });
      await Bun.sleep(60);
      postAnswer("sess-1", "approve");

      const result = await decisionPromise;
      expect(result.decision).toBe("allow");
      expect(result.decision === "allow" && result.logged && result.additionalContext).toBeUndefined();
    });

    test("Daemon up, human answers REJECT with a message — denies, the message is the reason, item closes", async () => {
      writeAlive(home);
      const decisionPromise = decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 58",
        tool: "Bash",
      });
      await Bun.sleep(60);
      postAnswer("sess-1", "reject", "primero corré los tests");

      const result = await decisionPromise;
      expect(result.decision).toBe("deny");
      expect(result.decision === "deny" && result.reason).toBe("primero corré los tests");
      expect(deriveInbox(home)).toHaveLength(0); // closed (dismissed) — no longer open
    });

    test("reject with NO message — denies with a generic reason, never blank", async () => {
      writeAlive(home);
      const decisionPromise = decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 58",
        tool: "Bash",
      });
      await Bun.sleep(60);
      postAnswer("sess-1", "reject");

      const result = await decisionPromise;
      expect(result.decision).toBe("deny");
      expect(result.decision === "deny" && result.reason && result.reason.length > 0).toBe(true);
    });

    test("no answer within the window — denies with the es-AR expiry wording, item stays OPEN as pending", async () => {
      writeAlive(home);
      const result = await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });

      expect(result.decision).toBe("deny");
      expect(result.decision === "deny" && result.reason).toContain("nadie respondió");
      expect(result.decision === "deny" && result.reason).toContain("para que el humano lo corra");

      const inbox = deriveInbox(home);
      expect(inbox).toHaveLength(1); // still open — never resolved
    });

    test("TIME IS STATE: after expiry, the row's own decision line still reads 'held' — no second Event was ever written for the transition", async () => {
      writeAlive(home);
      await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });

      const events = readSessionEvents("sess-1", home);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "action.decided", data: { decision: "held" } });
    });

    test("heartbeat goes stale mid-wait — denies at once, well inside the window, same expiry-style wording", async () => {
      writeAlive(home);
      const decisionPromise = decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 58",
        tool: "Bash",
      });
      await Bun.sleep(60);
      rmSync(path.join(home, "state", "daemon.alive"), { force: true });

      const startedWaitingAt = Date.now();
      const result = await decisionPromise;
      const elapsedMs = Date.now() - startedWaitingAt;

      expect(result.decision).toBe("deny");
      expect(result.decision === "deny" && result.reason).toContain("nadie respondió");
      expect(elapsedMs).toBeLessThan(1900); // well inside the 2s window — never waited for the full expiry
    });

    test("no `block` Capability — never holds at all, resolves immediately exactly as ADR 0001's unblockable case", async () => {
      writeAlive(home);
      const startedAt = Date.now();
      const result = await decideAction(
        home,
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        ["observe"],
      );
      const elapsedMs = Date.now() - startedAt;

      expect(result.decision).toBe("allow"); // unchanged ADR 0001 shape
      expect(elapsedMs).toBeLessThan(500); // never entered the hold loop
    });

    test("fires 🟡 the moment the item is born live, before any answer — never silently held", async () => {
      writeAlive(home);
      const decisionPromise = decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 58",
        tool: "Bash",
      });
      await Bun.sleep(60);
      postAnswer("sess-1", "approve");
      await decisionPromise;

      const notifications = readNotificationRecorder(home);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.message).toContain("te espera tu respuesta en la vista");
    });
  });
});
