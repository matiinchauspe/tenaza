import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideAction } from "../src/decide";
import { deriveInbox } from "../src/inbox";
import { readSessionEvents } from "../src/log";

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
});
