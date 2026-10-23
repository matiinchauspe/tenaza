import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPolicy, matchRule } from "../src/policy";

describe("Policy", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-policy-"));
    mkdirSync(path.join(home, "config"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("loads rules from policy.toml", () => {
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[[rule]]
match = "gh pr merge"
effect = "human"

[[rule]]
match = "noisy-but-watched"
effect = "flag"
`,
    );

    const policy = loadPolicy(home);
    expect(policy.rules).toEqual([
      { match: "gh pr merge", effect: "human" },
      { match: "noisy-but-watched", effect: "flag" },
    ]);
  });

  test("an absent policy file yields no rules, not an error", () => {
    const policy = loadPolicy(home);
    expect(policy.rules).toEqual([]);
  });

  test("matchRule finds a human rule by substring on the command", () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = { kind: "shell" as const, command: "gh pr merge 58 --merge", tool: "Bash" };

    expect(matchRule(action, policy)).toEqual({ match: "gh pr merge", effect: "human" });
  });

  test("matchRule returns undefined when nothing matches", () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = { kind: "shell" as const, command: "ls -la", tool: "Bash" };

    expect(matchRule(action, policy)).toBeUndefined();
  });

  test("matchRule returns the first matching rule, in file order", () => {
    const policy = {
      rules: [
        { match: "gh pr", effect: "flag" as const },
        { match: "gh pr merge", effect: "human" as const },
      ],
    };
    const action = { kind: "shell" as const, command: "gh pr merge 58", tool: "Bash" };

    expect(matchRule(action, policy)).toEqual({ match: "gh pr", effect: "flag" });
  });
});
