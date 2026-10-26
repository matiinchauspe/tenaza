import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideAction } from "../src/decide";
import { deriveInbox } from "../src/inbox";
import { readSessionEvents } from "../src/log";
import { readNotificationRecorder } from "../src/notify";
import { sessionLogPath } from "../src/paths";

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

  test("a human rule denies and opens an Inbox item", () => {
    const result = decideAction(home, "sess-1", {
      kind: "shell",
      command: "gh pr merge 58",
      tool: "Bash",
    });

    expect(result.decision).toBe("deny");
    expect(result.decision === "deny" && result.inboxId).toBe(1);

    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "action.decided", data: { decision: "deny" } });

    expect(deriveInbox(home)).toHaveLength(1);
  });

  test("a flag rule allows and still records action.decided", () => {
    const result = decideAction(home, "sess-1", {
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

  test("an Action matching no Rule is allowed and NOT logged", () => {
    const result = decideAction(home, "sess-1", {
      kind: "shell",
      command: "ls -la",
      tool: "Bash",
    });

    expect(result.decision).toBe("allow");
    expect(result.logged).toBe(false);
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("Inbox ids stay stable across successive denies in the same session", () => {
    decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 1", tool: "Bash" });
    const second = decideAction(home, "sess-1", {
      kind: "shell",
      command: "gh pr merge 2",
      tool: "Bash",
    });

    expect(second.decision === "deny" && second.inboxId).toBe(2);
  });

  describe("Capability-gated denial (ADR 0001)", () => {
    test("a human rule DENIES when the caller declares the block Capability", () => {
      const result = decideAction(
        home,
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        ["observe", "block"],
      );

      expect(result.decision).toBe("deny");
    });

    test("a human rule CANNOT deny without the block Capability — degrades to allow, same shape as a flag match", () => {
      const result = decideAction(
        home,
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        ["observe"],
      );

      expect(result.decision).toBe("allow");
      expect(result.logged).toBe(true);
    });

    test("without block, the Action is still RECORDED — never silently dropped", () => {
      decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" }, [
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

    test("without block, the Action is still SURFACED in the Inbox — not silently dropped", () => {
      decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" }, [
        "observe",
      ]);

      const inbox = deriveInbox(home);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ blocked: false, session: "sess-1" });
    });

    test("with no Capabilities given at all, the Policy's own human Rule still enforces as before (back-compat default)", () => {
      const result = decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 58",
        tool: "Bash",
      });

      expect(result.decision).toBe("deny");
    });
  });

  describe("notifications (ticket 08: 🟡 fires at the single point an Inbox item opens)", () => {
    test("a human rule deny also sends exactly one 🟡", () => {
      decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });

      const notifications = readNotificationRecorder(home);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.title).toContain("inbox #1");
      expect(notifications[0]?.message).toContain("tenaza run 1");
    });

    test("an unenforceable human match (no block Capability) ALSO sends one 🟡 — never silently dropped (ADR 0001)", () => {
      decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" }, [
        "observe",
      ]);

      const notifications = readNotificationRecorder(home);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.message).toContain("ya corrió");
      expect(notifications[0]?.message).not.toContain("tenaza run");
    });

    test("a flag rule never sends a notification", () => {
      decideAction(home, "sess-1", { kind: "shell", command: "railway run -- psql", tool: "Bash" });

      expect(readNotificationRecorder(home)).toEqual([]);
    });

    test("an Action matching no Rule never sends a notification", () => {
      decideAction(home, "sess-1", { kind: "shell", command: "ls -la", tool: "Bash" });

      expect(readNotificationRecorder(home)).toEqual([]);
    });

    test("two successive denies in the same Session send two 🟡, one per Inbox item", () => {
      decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 1", tool: "Bash" });
      decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 2", tool: "Bash" });

      const notifications = readNotificationRecorder(home);
      expect(notifications).toHaveLength(2);
      expect(notifications[0]?.tag).toBe("inbox-1");
      expect(notifications[1]?.tag).toBe("inbox-2");
    });
  });

  describe("ADR 0007 (ticket 01): the decision holds even when a side effect fails", () => {
    test("a human rule still denies even when logging the decision fails — the id comes back undefined, never a stale one", () => {
      // Force a real fs failure: a plain FILE sits where the Session log's
      // own directory needs to be, so `appendEvent`'s `mkdirSync` throws.
      mkdirSync(path.join(home, "state"), { recursive: true });
      writeFileSync(path.join(home, "state", "sessions"), "not a directory");

      const result = decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 58",
        tool: "Bash",
      });

      expect(result.decision).toBe("deny");
      expect(result.decision === "deny" && result.inboxId).toBeUndefined();
    });

    test("a flag rule still allows, and never throws, when logging fails", () => {
      mkdirSync(path.join(home, "state"), { recursive: true });
      writeFileSync(path.join(home, "state", "sessions"), "not a directory");

      const result = decideAction(home, "sess-1", {
        kind: "shell",
        command: "railway run -- psql",
        tool: "Bash",
      });

      expect(result.decision).toBe("allow");
      expect(result.logged).toBe(true);
    });
  });

  describe("ADR 0007 (ticket 01): a torn line encountered while deriving the Inbox id is reported through decideAction's own result", () => {
    test("skippedLines is set when deriving the id hits a torn line, and the decision still holds", () => {
      decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 1", tool: "Bash" });
      // A torn line in a DIFFERENT Session's log — read while deriving the
      // Inbox for the second deny below, never thrown on (readLog's own
      // tolerance), but still reported here rather than silently dropped.
      writeFileSync(sessionLogPath("sess-2", home), "{torn\n");

      const second = decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 2",
        tool: "Bash",
      });

      expect(second.decision).toBe("deny");
      expect(second.decision === "deny" && second.skippedLines).toBe(1);
      expect(second.decision === "deny" && second.inboxId).toBe(2); // still correctly derived despite the torn line
    });

    test("skippedLines is undefined when nothing was skipped", () => {
      const result = decideAction(home, "sess-1", {
        kind: "shell",
        command: "gh pr merge 1",
        tool: "Bash",
      });

      expect(result.decision === "deny" && result.skippedLines).toBeUndefined();
    });

    test("skippedLines is never set for a flag match or a no-match — neither ever reads a Session log", () => {
      const flag = decideAction(home, "sess-1", {
        kind: "shell",
        command: "railway run -- psql",
        tool: "Bash",
      });
      expect(flag.logged && flag.skippedLines).toBeUndefined();

      const noMatch = decideAction(home, "sess-1", { kind: "shell", command: "ls -la", tool: "Bash" });
      expect(noMatch.logged).toBe(false);
    });
  });
});
