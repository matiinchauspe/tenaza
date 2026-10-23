import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { type Action, EffectSchema } from "./contract/event";
import { policyPath, tenazaHome } from "./paths";

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
 * Load the user's Policy from `<home>/config/policy.toml`. A repo ships only
 * `policy.example.toml` and defaults — the user's own file is never
 * required, so an absent file degrades to no rules and the default
 * threshold, rather than an error.
 */
export function loadPolicy(home: string = tenazaHome()): Policy {
  const file = policyPath(home);
  if (!existsSync(file)) return { rules: [], thresholdTokens: DEFAULT_CONTEXT_THRESHOLD };

  const raw = parseToml(readFileSync(file, "utf8"));
  const parsed = PolicyFileSchema.parse(raw);
  return {
    rules: parsed.rule ?? [],
    thresholdTokens: parsed.flag?.threshold_tokens ?? DEFAULT_CONTEXT_THRESHOLD,
  };
}

/**
 * The first Rule, in file order, whose `match` text appears in the Action's
 * command. `undefined` means the Action matched nothing. Takes only the
 * `rules` a Policy carries — never the whole `Policy` shape — since matching
 * an Action has nothing to do with the Flag threshold.
 */
export function matchRule(action: Action, policy: Pick<Policy, "rules">): Rule | undefined {
  if (action.kind !== "shell") return undefined;
  return policy.rules.find((rule) => action.command.includes(rule.match));
}
