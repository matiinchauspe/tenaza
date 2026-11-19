import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { type Action, type McpAction, EffectSchema } from "./contract/event";
import { policyLkgPath, policyPath, tenazaHome } from "./paths";
import { matchesContiguousRun, parseExecutedCommands, words } from "./shellparse";

/** A text pattern matched against a normalized `shell` Action's parsed command — a guardrail against honest mistakes, not a security boundary. */
export const ShellRuleSchema = z.object({
  match: z.string(),
  effect: EffectSchema,
});
export type ShellRule = z.infer<typeof ShellRuleSchema>;

/**
 * An `mcp` Rule: `tool` is a glob on the tool's name (`*` the only
 * wildcard); `unless` exempts a match whose argument already holds a safe
 * value, `when` requires an argument to equal one. An array argument
 * satisfies either when any element does. Argument CONTENT is never
 * inspected — only these two structural conditions are.
 */
export const McpRuleSchema = z.object({
  tool: z.string(),
  unless: z.record(z.string(), z.array(z.unknown())).optional(),
  when: z.record(z.string(), z.unknown()).optional(),
  effect: EffectSchema,
});
export type McpRule = z.infer<typeof McpRuleSchema>;

/**
 * One entry of the Policy, either shape — discriminated by which REQUIRED
 * field it carries (`match` vs `tool`), since neither TOML table declares a
 * literal kind of its own. A malformed entry (neither, or a type mismatch)
 * fails the whole `policy.toml` parse — it never disables every OTHER Rule
 * on its own.
 */
export const RuleSchema = z.union([ShellRuleSchema, McpRuleSchema]);
export type Rule = z.infer<typeof RuleSchema>;

export function isShellRule(rule: Rule): rule is ShellRule {
  return "match" in rule;
}
export function isMcpRule(rule: Rule): rule is McpRule {
  return "tool" in rule;
}

export interface Policy {
  rules: Rule[];
  /** The context size past which a Session is Flagged; shown only, never enforced. */
  thresholdTokens: number;
  /**
   * How many minutes a Session may stay silent before the Live surface
   * reads it as TRABADA — `[live] stall_minutes` in `policy.toml`. Read
   * only here, by the Daemon's SSE payload and the board's own classifier,
   * so the two can never disagree on what "stalled" means.
   */
  stallMinutes: number;
  /**
   * How many seconds a `human` match holds the agent's call before it
   * lapses to pending — `[live] wait_seconds` in `policy.toml`, read raw
   * and uncapped; `effectiveWaitSeconds` below applies the hook's timeout
   * cap.
   */
  waitSeconds: number;
}

export const DEFAULT_CONTEXT_THRESHOLD = 200_000;
export const DEFAULT_STALL_MINUTES = 15;
export const DEFAULT_WAIT_SECONDS = 180;

/**
 * The ceiling on the live-answering window — `hooks/hooks.json`'s own
 * PreToolUse `timeout` (240s) minus a 30s margin for the hook's own side
 * effects (logging, deriving the id, notifying) to finish before Claude
 * Code's own deadline.
 */
export const MAX_WAIT_SECONDS = 210;

export function effectiveWaitSeconds(policy: Pick<Policy, "waitSeconds">): number {
  return Math.min(policy.waitSeconds, MAX_WAIT_SECONDS);
}

const PolicyFileSchema = z.object({
  rule: z.array(RuleSchema).optional(),
  flag: z.object({ threshold_tokens: z.number().optional() }).optional(),
  live: z.object({ stall_minutes: z.number().optional(), wait_seconds: z.number().optional() }).optional(),
});

const LkgFileSchema = z.object({
  rules: z.array(RuleSchema),
  thresholdTokens: z.number(),
  /** Optional so an LKG written before this field existed still parses — it degrades to the default instead of losing the whole cache. */
  stallMinutes: z.number().optional(),
  waitSeconds: z.number().optional(),
  savedAt: z.string(),
});

function describeParseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PolicyFileReadResult = { ok: true; policy: Policy } | { ok: false; error: unknown };

/**
 * Parse and validate `policy.toml` as it stands right now — the ONE place
 * that attempt happens, so `loadPolicy` and `policyWarning` below always
 * agree on whether it just succeeded.
 */
function readPolicyFile(home: string): PolicyFileReadResult {
  try {
    const raw = parseToml(readFileSync(policyPath(home), "utf8"));
    const parsed = PolicyFileSchema.parse(raw);
    return {
      ok: true,
      policy: {
        rules: parsed.rule ?? [],
        thresholdTokens: parsed.flag?.threshold_tokens ?? DEFAULT_CONTEXT_THRESHOLD,
        stallMinutes: parsed.live?.stall_minutes ?? DEFAULT_STALL_MINUTES,
        waitSeconds: parsed.live?.wait_seconds ?? DEFAULT_WAIT_SECONDS,
      },
    };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Caches the last successfully parsed Policy to `state/policy.lkg.json` —
 * the fallback a malformed `policy.toml` degrades to. A failed write must
 * never fail the load that triggered it: this cache is a convenience, not
 * the source of truth.
 */
function writeLkg(home: string, policy: Policy): void {
  try {
    const file = policyLkgPath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        rules: policy.rules,
        thresholdTokens: policy.thresholdTokens,
        stallMinutes: policy.stallMinutes,
        waitSeconds: policy.waitSeconds,
        savedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // Failing to write the LKG must never fail the load that triggered it.
  }
}

function readLkg(home: string): { policy: Policy; savedAt: string } | undefined {
  const file = policyLkgPath(home);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = LkgFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    return {
      policy: {
        rules: parsed.rules,
        thresholdTokens: parsed.thresholdTokens,
        stallMinutes: parsed.stallMinutes ?? DEFAULT_STALL_MINUTES,
        waitSeconds: parsed.waitSeconds ?? DEFAULT_WAIT_SECONDS,
      },
      savedAt: parsed.savedAt,
    };
  } catch {
    return undefined;
  }
}

const NO_RULES_POLICY: Policy = {
  rules: [],
  thresholdTokens: DEFAULT_CONTEXT_THRESHOLD,
  stallMinutes: DEFAULT_STALL_MINUTES,
  waitSeconds: DEFAULT_WAIT_SECONDS,
};

/**
 * Loads the user's Policy from `<home>/config/policy.toml`. The user's own
 * file is never required — absent, it degrades to no rules and the
 * default threshold.
 *
 * Never throws: a malformed file degrades to the last successfully parsed
 * Policy, or to no rules when none was ever parsed. `policyWarning` below
 * reports whether this call hit that fallback; this function only ever
 * hands back something usable.
 */
export function loadPolicy(home: string = tenazaHome()): Policy {
  const file = policyPath(home);
  if (!existsSync(file)) return NO_RULES_POLICY;

  const result = readPolicyFile(home);
  if (result.ok) {
    writeLkg(home, result.policy);
    return result.policy;
  }

  const lkg = readLkg(home);
  return lkg ? lkg.policy : NO_RULES_POLICY;
}

export interface PolicyWarning {
  message: string;
  /** True only when no last-known-good Policy ever existed — Rules are off entirely, not just stale. */
  grave: boolean;
}

/**
 * Re-derives whether `loadPolicy` just took its fallback path, as a report
 * rather than a value — `undefined` when `policy.toml` parsed cleanly or
 * is absent (a normal state, never a fault). Kept separate so every
 * ordinary caller keeps asking only for a `Policy`; only the hook's own
 * health report asks this too.
 */
export function policyWarning(home: string = tenazaHome()): PolicyWarning | undefined {
  if (!existsSync(policyPath(home))) return undefined;

  const result = readPolicyFile(home);
  if (result.ok) return undefined;

  const cause = describeParseError(result.error);
  const lkg = readLkg(home);
  if (lkg) {
    return {
      message: `policy.toml is invalid (${cause}); using the last valid policy from ${lkg.savedAt}.`,
      grave: false,
    };
  }
  return {
    message: `policy.toml is invalid (${cause}) and no last-known-good policy exists yet — no Rules are active.`,
    grave: true,
  };
}

export interface MatchOutcome {
  rule: Rule;
  /** Set when the command failed to parse and matching fell back to the raw-substring check — never set on a clean parse. */
  reason?: "parse_error";
}

/**
 * Could ANY `shell` Rule's first word possibly appear in `command`? If
 * none is even present as a raw substring, no Rule can match it — a
 * Rule's full `match` text, or a parsed contiguous-run match, can only
 * exist if its first word appears somewhere in the executed text. This
 * prefilter lets the hot path skip tree-sitter entirely on a Bash call
 * that names no Rule at all.
 */
function mayMatchSomeRule(command: string, rules: readonly ShellRule[]): boolean {
  return rules.some((rule) => {
    const [first] = words(rule.match);
    return first !== undefined && command.includes(first);
  });
}

/** The first Rule, in file order, whose `match` text is a raw substring of the command — the fallback a parse failure degrades to, never "no match": the guard must never go empty. */
function matchByRawSubstring(command: string, rules: readonly ShellRule[]): ShellRule | undefined {
  return rules.find((rule) => command.includes(rule.match));
}

function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`);
}

function argAtPath(args: Record<string, unknown>, dottedPath: string): unknown {
  let current: unknown = args;
  for (const key of dottedPath.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** `predicate` against `value`, or against ANY element when `value` is an array — the same array rule applied uniformly to both `unless` and `when`. */
function matchesValueOrElement(value: unknown, predicate: (candidate: unknown) => boolean): boolean {
  return Array.isArray(value) ? value.some(predicate) : predicate(value);
}

/**
 * Does `rule.unless` exempt this call — every listed argument already
 * holding one of its own safe values? An absent argument never counts as
 * safe (e.g. no `branch_id` hits the default branch, which is prod), so a
 * Rule whose `unless` names an argument the call never carries is never
 * exempted.
 */
function exemptedByUnless(rule: McpRule, args: Record<string, unknown>): boolean {
  if (!rule.unless) return false;
  return Object.entries(rule.unless).every(([argPath, safeValues]) => {
    const value = argAtPath(args, argPath);
    if (value === undefined) return false;
    return matchesValueOrElement(value, (candidate) => safeValues.includes(candidate));
  });
}

function satisfiesWhen(rule: McpRule, args: Record<string, unknown>): boolean {
  if (!rule.when) return true;
  return Object.entries(rule.when).every(([argPath, target]) =>
    matchesValueOrElement(argAtPath(args, argPath), (candidate) => candidate === target),
  );
}

/** Does this `mcp` Rule match this `mcp` Action? Checks the tool glob first — cheapest, and most calls name no Rule's tool at all — then `when`, then `unless`. */
function mcpRuleMatches(rule: McpRule, action: McpAction): boolean {
  if (!globToRegExp(rule.tool).test(action.tool)) return false;
  if (!satisfiesWhen(rule, action.args)) return false;
  if (exemptedByUnless(rule, action.args)) return false;
  return true;
}

/**
 * The first Rule, in file order, that matches the Action — a `shell`
 * Action against the `shell` Rules, or an `mcp` Action against the `mcp`
 * Rules. A `shell` Action is parsed with tree-sitter-bash, and a Rule
 * matches when its words appear as a CONTIGUOUS RUN anywhere in some
 * executed command's argv — `timeout 60 gh pr merge 58` and `sudo gh pr
 * merge 58` match, while `rg "gh pr merge"`, a heredoc body or a commit
 * message never do, because a quoted string stays one argv word. A parse
 * failure falls back to the raw-substring match and reports `reason:
 * "parse_error"`; an `mcp` Action never takes this path, since there is no
 * parse to fail. Takes only the `rules` a Policy carries, never the whole
 * `Policy`, since matching an Action has nothing to do with the Flag
 * threshold.
 *
 * Async because loading the bash grammar is costly — a cost paid only past
 * the prefilter below, which stays synchronous and runs first so most Bash
 * calls return without ever reaching an `await`. An `mcp` Action never
 * awaits at all.
 */
export async function matchRule(
  action: Action,
  policy: Pick<Policy, "rules">,
): Promise<MatchOutcome | undefined> {
  if (action.kind === "mcp") {
    const rule = policy.rules.find(
      (candidate): candidate is McpRule => isMcpRule(candidate) && mcpRuleMatches(candidate, action),
    );
    return rule ? { rule } : undefined;
  }
  if (action.kind !== "shell") return undefined;

  const shellRules = policy.rules.filter(isShellRule);
  if (!mayMatchSomeRule(action.command, shellRules)) return undefined;

  const parsed = await parseExecutedCommands(action.command);
  if (!parsed) {
    const rule = matchByRawSubstring(action.command, shellRules);
    return rule ? { rule, reason: "parse_error" } : undefined;
  }

  for (const rule of shellRules) {
    const ruleWords = words(rule.match);
    if (parsed.commands.some((argv) => matchesContiguousRun(ruleWords, argv))) {
      return { rule };
    }
  }
  return undefined;
}
