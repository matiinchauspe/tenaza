import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { type Action, EffectSchema } from "./contract/event";
import { policyLkgPath, policyPath, tenazaHome } from "./paths";
import { matchesContiguousRun, parseExecutedCommands, words } from "./shellparse";

/**
 * One entry of the Policy: a text pattern matched against a normalized
 * Action, and the Effect applied when it matches. Matching is text on the
 * Action — a guardrail against honest agent mistakes, not a security
 * boundary.
 */
export const RuleSchema = z.object({
  match: z.string(),
  effect: EffectSchema,
});
export type Rule = z.infer<typeof RuleSchema>;

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
function mayMatchSomeRule(command: string, rules: readonly Rule[]): boolean {
  return rules.some((rule) => {
    const [first] = words(rule.match);
    return first !== undefined && command.includes(first);
  });
}

/** The v0.1 behavior: the first Rule, in file order, whose `match` text is a raw substring of the command — the fallback a parse failure degrades to, never "no match" (the guard must never go empty). */
function matchByRawSubstring(command: string, rules: readonly Rule[]): Rule | undefined {
  return rules.find((rule) => command.includes(rule.match));
}

/**
 * The first Rule, in file order, that matches the Action (ticket 03,
 * decision 02, ADR 0006): the command is parsed with tree-sitter-bash, and
 * a Rule matches when its words appear as a CONTIGUOUS RUN anywhere in some
 * executed command's argv — `timeout 60 gh pr merge 58` and
 * `sudo gh pr merge 58` match with no launcher table, while `rg "gh pr
 * merge"`, a heredoc body and a commit message never do, because a quoted
 * string stays one argv word. A parse failure or parser error falls back to
 * the v0.1 raw-substring match and reports `reason: "parse_error"` — the
 * caller logs that onto the Event. `undefined` means the Action matched
 * nothing at all. Takes only the `rules` a Policy carries — never the whole
 * `Policy` shape — since matching an Action has nothing to do with the Flag
 * threshold.
 *
 * Async because loading the grammar (`parseExecutedCommands`) is: the cost
 * is paid only past the prefilter below, which is why it stays synchronous
 * and checked FIRST — most Bash calls return right there, with no `await`
 * ever reached.
 */
export async function matchRule(
  action: Action,
  policy: Pick<Policy, "rules">,
): Promise<MatchOutcome | undefined> {
  if (action.kind !== "shell") return undefined;
  if (!mayMatchSomeRule(action.command, policy.rules)) return undefined;

  const parsed = await parseExecutedCommands(action.command);
  if (!parsed) {
    const rule = matchByRawSubstring(action.command, policy.rules);
    return rule ? { rule, reason: "parse_error" } : undefined;
  }

  for (const rule of policy.rules) {
    const ruleWords = words(rule.match);
    if (parsed.commands.some((argv) => matchesContiguousRun(ruleWords, argv))) {
      return { rule };
    }
  }
  return undefined;
}
