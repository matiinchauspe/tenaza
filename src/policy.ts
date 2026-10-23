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
}

const PolicyFileSchema = z.object({
  rule: z.array(RuleSchema).optional(),
});

/**
 * Load the user's Policy from `<home>/config/policy.toml`. A repo ships only
 * `policy.example.toml` and defaults — the user's own file is never
 * required, so an absent file degrades to no rules rather than an error.
 */
export function loadPolicy(home: string = tenazaHome()): Policy {
  const file = policyPath(home);
  if (!existsSync(file)) return { rules: [] };

  const raw = parseToml(readFileSync(file, "utf8"));
  const parsed = PolicyFileSchema.parse(raw);
  return { rules: parsed.rule ?? [] };
}

/**
 * The first Rule, in file order, whose `match` text appears in the Action's
 * command. `undefined` means the Action matched nothing.
 */
export function matchRule(action: Action, policy: Policy): Rule | undefined {
  if (action.kind !== "shell") return undefined;
  return policy.rules.find((rule) => action.command.includes(rule.match));
}
