import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { type Action, type McpAction, EffectSchema } from "./contract/event";
import { policyLkgPath, policyPath, tenazaHome } from "./paths";
import { matchesContiguousRun, parseExecutedCommands, words } from "./shellparse";

/**
 * A `shell` Rule (unchanged from ticket 03): a text pattern matched against
 * a normalized `shell` Action's parsed command. Matching is text on the
 * Action — a guardrail against honest agent mistakes, not a security
 * boundary.
 */
export const ShellRuleSchema = z.object({
  match: z.string(),
  effect: EffectSchema,
});
export type ShellRule = z.infer<typeof ShellRuleSchema>;

/**
 * An `mcp` Rule (ticket 04, decision 07): `tool` is a glob on the tool's own
 * name (`*` as the only wildcard, e.g. "mcp__*neon*__run_sql*"); `unless`
 * EXEMPTS the match when a (dotted) argument path holds one of the listed
 * safe values — an ABSENT argument never counts as safe, it still matches
 * (the Neon worked example: no `branch_id` hits the default branch, which
 * is prod); `when` REQUIRES a (dotted) argument path to equal the given
 * value. An array argument satisfies either check when ANY of its elements
 * does. No per-provider code, and argument CONTENT (SQL text and the like)
 * is never inspected — only these two structural conditions are.
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
 * field it carries (`match` vs `tool`) since neither TOML table declares a
 * literal kind of its own. A malformed entry (neither, or a type mismatch)
 * fails the whole `policy.toml` parse and degrades the way ticket 01's LKG
 * path does — it never disables every OTHER Rule on its own.
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
  /** The context size past which a Session is Flagged (q9). Shown, never enforced — v1 never stops a Session. */
  thresholdTokens: number;
}

/** The Flag's own default (spec: "The threshold comes from the Policy, default 200k"). */
export const DEFAULT_CONTEXT_THRESHOLD = 200_000;

const PolicyFileSchema = z.object({
  rule: z.array(RuleSchema).optional(),
  flag: z.object({ threshold_tokens: z.number().optional() }).optional(),
});

/**
 * The last-known-good Policy's own on-disk shape (ADR 0007, H3): the
 * already-parsed, validated result — never the raw TOML — plus when it was
 * saved.
 */
const LkgFileSchema = z.object({
  rules: z.array(RuleSchema),
  thresholdTokens: z.number(),
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
      },
    };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Cache the last successfully parsed Policy to `state/policy.lkg.json`
 * (ADR 0007, H3) — the fallback a malformed `policy.toml` degrades to,
 * instead of silently dropping every Rule. A failure to WRITE this cache
 * must never fail the load that triggered it — it's a convenience, not the
 * source of truth.
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
        savedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // See the doc comment above.
  }
}

function readLkg(home: string): { policy: Policy; savedAt: string } | undefined {
  const file = policyLkgPath(home);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = LkgFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    return {
      policy: { rules: parsed.rules, thresholdTokens: parsed.thresholdTokens },
      savedAt: parsed.savedAt,
    };
  } catch {
    return undefined;
  }
}

/**
 * Load the user's Policy from `<home>/config/policy.toml`. A repo ships only
 * `policy.example.toml` and defaults — the user's own file is never
 * required, so an absent file degrades to no rules and the default
 * threshold, rather than an error.
 *
 * Never throws (ADR 0007, ticket 01): a malformed file degrades to the
 * last successfully parsed Policy (H3's own last-known-good), or — when
 * none was ever parsed — to no Rules at all, the same shape an absent file
 * already returns. `policyWarning` below reports whether THIS call
 * actually hit that fallback; `loadPolicy` itself only ever hands back
 * something usable.
 */
export function loadPolicy(home: string = tenazaHome()): Policy {
  const file = policyPath(home);
  if (!existsSync(file)) return { rules: [], thresholdTokens: DEFAULT_CONTEXT_THRESHOLD };

  const result = readPolicyFile(home);
  if (result.ok) {
    writeLkg(home, result.policy);
    return result.policy;
  }

  const lkg = readLkg(home);
  return lkg ? lkg.policy : { rules: [], thresholdTokens: DEFAULT_CONTEXT_THRESHOLD };
}

export interface PolicyWarning {
  message: string;
  /** True only when NO last-known-good Policy ever existed — Rules are off entirely, not just stale (H3's "grave" case). */
  grave: boolean;
}

/**
 * Re-derive whether `loadPolicy` just took its fallback path, as a REPORT
 * rather than a value (ADR 0007, ticket 01) — `undefined` when
 * `policy.toml` parsed cleanly, or is absent (a normal "nothing configured
 * yet" state, never a fault). Kept separate from `loadPolicy` itself so
 * every ordinary caller (sampling, the statusline, `decideAction`) keeps
 * asking only for a `Policy`; only the hook's own health report asks this
 * question too.
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
  /** Set exactly when the command failed to parse and matching fell back to the v0.1 raw-substring check (ticket 03) — never set on a clean parse. */
  reason?: "parse_error";
}

/**
 * Could ANY `shell` Rule's first word possibly appear as a match in
 * `command`? If none of them is even present as a raw substring, no Rule —
 * parsed correctly or not — can ever match it: a Rule's full `match` text
 * can only be a substring of `command` if its own first word is too, and
 * the SAME holds for a parsed contiguous-run match, since every word a Rule
 * needs (its first one included) must appear SOMEWHERE in the executed
 * text for a run to exist. This is the prefilter (decision 02): the cheap
 * check that lets the hot path skip tree-sitter entirely on an ordinary
 * Bash call that names no Rule at all.
 */
function mayMatchSomeRule(command: string, rules: readonly ShellRule[]): boolean {
  return rules.some((rule) => {
    const [first] = words(rule.match);
    return first !== undefined && command.includes(first);
  });
}

/** The v0.1 behavior: the first Rule, in file order, whose `match` text is a raw substring of the command — the fallback a parse failure degrades to, never "no match" (the guard must never go empty). */
function matchByRawSubstring(command: string, rules: readonly ShellRule[]): ShellRule | undefined {
  return rules.find((rule) => command.includes(rule.match));
}

/** Convert an `mcp` Rule's tool glob (`*` the only wildcard) into a RegExp anchored to the whole string. */
function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`);
}

/** Reach a (possibly nested) argument by a dotted path, e.g. "params.branch_id". `undefined` on any missing or non-object step. */
function argAtPath(args: Record<string, unknown>, dottedPath: string): unknown {
  let current: unknown = args;
  for (const key of dottedPath.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** `predicate` against `value`, or against ANY element when `value` is an array — decision 07's own "an array argument matches if any element does," applied uniformly to both `unless` and `when`. */
function matchesValueOrElement(value: unknown, predicate: (candidate: unknown) => boolean): boolean {
  return Array.isArray(value) ? value.some(predicate) : predicate(value);
}

/**
 * Does `rule.unless` exempt this call — i.e. is EVERY listed argument
 * already holding one of ITS OWN safe values? An absent argument never
 * counts as safe (the Neon worked example: no `branch_id` hits the default
 * branch, which is prod), so a Rule whose `unless` names an argument the
 * call never carries is never exempted. No `unless` at all is never an
 * exemption either — there's nothing to exempt it.
 */
function exemptedByUnless(rule: McpRule, args: Record<string, unknown>): boolean {
  if (!rule.unless) return false;
  return Object.entries(rule.unless).every(([argPath, safeValues]) => {
    const value = argAtPath(args, argPath);
    if (value === undefined) return false;
    return matchesValueOrElement(value, (candidate) => safeValues.includes(candidate));
  });
}

/** Does every `rule.when` condition hold? No `when` at all is vacuously true — the Rule carries no such requirement. */
function satisfiesWhen(rule: McpRule, args: Record<string, unknown>): boolean {
  if (!rule.when) return true;
  return Object.entries(rule.when).every(([argPath, target]) =>
    matchesValueOrElement(argAtPath(args, argPath), (candidate) => candidate === target),
  );
}

/** Does this `mcp` Rule match this `mcp` Action (decision 07)? The tool glob first — cheapest, and most calls name no Rule's tool at all — then `when`, then `unless`. */
function mcpRuleMatches(rule: McpRule, action: McpAction): boolean {
  if (!globToRegExp(rule.tool).test(action.tool)) return false;
  if (!satisfiesWhen(rule, action.args)) return false;
  if (exemptedByUnless(rule, action.args)) return false;
  return true;
}

/**
 * The first Rule, in file order, that matches the Action — a `shell` Action
 * against the Policy's `shell` Rules (ticket 03, decision 02, ADR 0006), or
 * an `mcp` Action against its `mcp` Rules (ticket 04, decision 07). A
 * `shell` Action's command is parsed with tree-sitter-bash, and a Rule
 * matches when its words appear as a CONTIGUOUS RUN anywhere in some
 * executed command's argv — `timeout 60 gh pr merge 58` and
 * `sudo gh pr merge 58` match with no launcher table, while `rg "gh pr
 * merge"`, a heredoc body and a commit message never do, because a quoted
 * string stays one argv word. A parse failure or parser error falls back to
 * the v0.1 raw-substring match and reports `reason: "parse_error"` — the
 * caller logs that onto the Event; an `mcp` Action never takes this
 * fallback path, since there is no parse to fail. `undefined` means the
 * Action matched nothing at all. Takes only the `rules` a Policy carries —
 * never the whole `Policy` shape — since matching an Action has nothing to
 * do with the Flag threshold.
 *
 * Async because loading the bash grammar (`parseExecutedCommands`) is: the
 * cost is paid only past the prefilter below, which is why it stays
 * synchronous and checked FIRST — most Bash calls return right there, with
 * no `await` ever reached. An `mcp` Action never awaits anything at all.
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
