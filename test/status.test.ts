import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideAction } from "../src/decide";
import { appendEvent } from "../src/log";
import { renderStatus } from "../src/status";
import { mkdirSync, writeFileSync } from "node:fs";
import { sessionStartedEvent } from "../src/contract/event";

describe("renderStatus", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-status-"));
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[[rule]]
match = "gh pr merge"
effect = "human"
`,
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("an empty Inbox reads as empty, not absent", async () => {
    expect(renderStatus(home)).toContain("Inbox");
  });

  test("lists a denied Action as `#id  Bash: command`", async () => {
    await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });

    const output = renderStatus(home);
    expect(output).toContain("#1  Bash: gh pr merge 58");
  });

  test("a fresh home with no observed Session renders no tree — just the Inbox, as before", async () => {
    const output = renderStatus(home);
    expect(output).toBe("Inbox: (empty)\n");
  });

  test("the Session tree renders above the Inbox, both present together", async () => {
    appendEvent(
      home,
      sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/tmp/scratch", capabilities: ["observe", "block"] }),
    );
    await decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });

    const output = renderStatus(home);

    const treeIndex = output.indexOf("/tmp/scratch");
    const inboxIndex = output.indexOf("Inbox:");
    expect(treeIndex).toBeGreaterThanOrEqual(0);
    expect(inboxIndex).toBeGreaterThan(treeIndex);
    expect(output).toContain("#1  Bash: gh pr merge 58");
  });
});
