import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONTEXT_THRESHOLD, loadPolicy, matchRule, policyWarning } from "../src/policy";
import { policyLkgPath } from "../src/paths";

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

  test("an absent policy file yields the default 200k threshold", () => {
    const policy = loadPolicy(home);
    expect(policy.thresholdTokens).toBe(DEFAULT_CONTEXT_THRESHOLD);
    expect(DEFAULT_CONTEXT_THRESHOLD).toBe(200_000);
  });

  test("a policy.toml without a [flag] section still yields the default threshold", () => {
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[[rule]]
match = "gh pr merge"
effect = "human"
`,
    );

    expect(loadPolicy(home).thresholdTokens).toBe(DEFAULT_CONTEXT_THRESHOLD);
  });

  test("a custom [flag] threshold_tokens overrides the default", () => {
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[flag]
threshold_tokens = 150000
`,
    );

    expect(loadPolicy(home).thresholdTokens).toBe(150_000);
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

describe("ADR 0007 (ticket 01, H3): last-known-good Policy", () => {
  let home: string;
  const policyFile = () => path.join(home, "config", "policy.toml");

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-policy-lkg-"));
    mkdirSync(path.join(home, "config"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("a successful load writes the parsed Policy to state/policy.lkg.json", () => {
    writeFileSync(
      policyFile(),
      `
[[rule]]
match = "gh pr merge"
effect = "human"
`,
    );

    loadPolicy(home);

    expect(existsSync(policyLkgPath(home))).toBe(true);
    const saved = JSON.parse(readFileSync(policyLkgPath(home), "utf8"));
    expect(saved.rules).toEqual([{ match: "gh pr merge", effect: "human" }]);
    expect(typeof saved.savedAt).toBe("string");
  });

  test("a malformed policy.toml falls back to the last-known-good Policy instead of dropping every Rule", () => {
    writeFileSync(
      policyFile(),
      `
[[rule]]
match = "gh pr merge"
effect = "human"
`,
    );
    loadPolicy(home); // establishes the LKG

    writeFileSync(policyFile(), "[[rule\nmatch = broken");

    const policy = loadPolicy(home);
    expect(policy.rules).toEqual([{ match: "gh pr merge", effect: "human" }]);
  });

  test("loadPolicy never throws on a malformed file, even with no LKG to fall back on", () => {
    writeFileSync(policyFile(), "[[rule\nmatch = broken");

    expect(() => loadPolicy(home)).not.toThrow();
    expect(loadPolicy(home).rules).toEqual([]);
  });

  test("policyWarning is undefined when policy.toml parses cleanly", () => {
    writeFileSync(policyFile(), `[[rule]]\nmatch = "gh pr merge"\neffect = "human"\n`);
    loadPolicy(home);

    expect(policyWarning(home)).toBeUndefined();
  });

  test("policyWarning is undefined when policy.toml is simply absent (a normal state, never a fault)", () => {
    expect(policyWarning(home)).toBeUndefined();
  });

  test("policyWarning names the fallback and the LKG's saved time when one exists", () => {
    writeFileSync(policyFile(), `[[rule]]\nmatch = "gh pr merge"\neffect = "human"\n`);
    loadPolicy(home);
    writeFileSync(policyFile(), "[[rule\nmatch = broken");

    const warning = policyWarning(home);
    expect(warning?.grave).toBe(false);
    expect(warning?.message).toContain("policy.toml is invalid");
    expect(warning?.message).toContain("using the last valid policy from");
  });

  test("policyWarning is grave when no last-known-good Policy ever existed", () => {
    writeFileSync(policyFile(), "[[rule\nmatch = broken");

    const warning = policyWarning(home);
    expect(warning?.grave).toBe(true);
    expect(warning?.message).toContain("no Rules are active");
  });
});
