import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideAction } from "../src/decide";
import { renderStatus } from "../src/status";
import { mkdirSync, writeFileSync } from "node:fs";

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

  test("an empty Inbox reads as empty, not absent", () => {
    expect(renderStatus(home)).toContain("Inbox");
  });

  test("lists a denied Action as `#id  Bash: command`", () => {
    decideAction(home, "sess-1", { kind: "shell", command: "gh pr merge 58", tool: "Bash" });

    const output = renderStatus(home);
    expect(output).toContain("#1  Bash: gh pr merge 58");
  });
});
