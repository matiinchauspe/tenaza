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

  test("matchRule finds a human rule as a contiguous run in the parsed command", async () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = { kind: "shell" as const, command: "gh pr merge 58 --merge", tool: "Bash" };

    expect(await matchRule(action, policy)).toEqual({ rule: { match: "gh pr merge", effect: "human" } });
  });

  test("matchRule returns undefined when nothing matches", async () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = { kind: "shell" as const, command: "ls -la", tool: "Bash" };

    expect(await matchRule(action, policy)).toBeUndefined();
  });

  test("matchRule returns the first matching rule, in file order", async () => {
    const policy = {
      rules: [
        { match: "gh pr", effect: "flag" as const },
        { match: "gh pr merge", effect: "human" as const },
      ],
    };
    const action = { kind: "shell" as const, command: "gh pr merge 58", tool: "Bash" };

    expect(await matchRule(action, policy)).toEqual({ rule: { match: "gh pr", effect: "flag" } });
  });
});

describe("matchRule (ticket 03, decision 02): matching parsed commands, not raw substrings", () => {
  test("a wrapped launcher matches with no launcher table: timeout 60 gh pr merge 58", async () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = { kind: "shell" as const, command: "timeout 60 gh pr merge 58", tool: "Bash" };

    expect(await matchRule(action, policy)).toEqual({ rule: { match: "gh pr merge", effect: "human" } });
  });

  test("sudo gh pr merge 58 matches the same way", async () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = { kind: "shell" as const, command: "sudo gh pr merge 58", tool: "Bash" };

    expect(await matchRule(action, policy)).toEqual({ rule: { match: "gh pr merge", effect: "human" } });
  });

  test("a search that only mentions the words in a quoted string never matches", async () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = { kind: "shell" as const, command: 'rg "gh pr merge"', tool: "Bash" };

    expect(await matchRule(action, policy)).toBeUndefined();
  });

  test("a heredoc body that only writes the reserved words as text never matches", async () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = {
      kind: "shell" as const,
      command: "cat <<'EOF' > ticket.md\nmentions gh pr merge as an example\nEOF\n",
      tool: "Bash",
    };

    expect(await matchRule(action, policy)).toBeUndefined();
  });

  test("bash -c re-parses its script and still matches", async () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = { kind: "shell" as const, command: 'bash -c "gh pr merge 58"', tool: "Bash" };

    expect(await matchRule(action, policy)).toEqual({ rule: { match: "gh pr merge", effect: "human" } });
  });

  test("eval re-parses its argument and still matches", async () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = { kind: "shell" as const, command: 'eval "gh pr merge 58"', tool: "Bash" };

    expect(await matchRule(action, policy)).toEqual({ rule: { match: "gh pr merge", effect: "human" } });
  });

  test("a command substitution $(...) is its own candidate and still matches", async () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = { kind: "shell" as const, command: "echo $(gh pr merge 58)", tool: "Bash" };

    expect(await matchRule(action, policy)).toEqual({ rule: { match: "gh pr merge", effect: "human" } });
  });

  test("a parse failure falls back to the v0.1 raw-substring match and reports reason parse_error", async () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = {
      kind: "shell" as const,
      command: 'echo "unterminated gh pr merge',
      tool: "Bash",
    };

    expect(await matchRule(action, policy)).toEqual({
      rule: { match: "gh pr merge", effect: "human" },
      reason: "parse_error",
    });
  });

  test("a parse failure that still matches nothing by raw substring returns undefined, not a reason with no rule", async () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = { kind: "shell" as const, command: 'echo "unterminated and unrelated', tool: "Bash" };

    expect(await matchRule(action, policy)).toBeUndefined();
  });

  test("the prefilter: a command naming none of the Policy's Rules is undefined with no parse attempted", async () => {
    const policy = { rules: [{ match: "gh pr merge", effect: "human" as const }] };
    const action = { kind: "shell" as const, command: "ls -la", tool: "Bash" };

    expect(await matchRule(action, policy)).toBeUndefined();
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
