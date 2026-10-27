import type { Capability } from "./contract/event";
import { type Action, actionDecidedEvent } from "./contract/event";
import { BUILT_IN_FENCE_RULE, matchesBuiltInFence } from "./fence";
import { inboxIdentityHash, shortHashAt } from "./identity";
import { deriveInboxReport } from "./inbox";
import { appendEventAtLine } from "./log";
import { notifyNewInboxItem } from "./notify";
import { loadPolicy, matchRule, type Rule } from "./policy";

export type DecisionResult =
  | { decision: "allow"; logged: false }
  | { decision: "allow"; logged: true; rule: Rule; inboxId?: string; skippedLines?: number }
  | { decision: "deny"; logged: true; rule: Rule; inboxId?: string; skippedLines?: number };

/**
 * Decide one Action against the Policy, logging it when (and only when) a
 * Rule matched. A `human` match wants to deny and open an Inbox item — but
 * denying is an enforcement act: only a caller that declares the `block`
 * Capability can make it stick (ADR 0001, core degrades by Capability, never
 * by runtime name). Without it, claiming "deny" in the log would be a lie —
 * the call runs regardless of what Tenaza says — so it degrades to the same
 * shape as a `flag` match: allowed, but still recorded and still surfaced in
 * the Inbox (ticket 06's own `blocked: false`), never silently dropped. A
 * `flag` match is unaffected either way — it was never about blocking.
 *
 * `capabilities` defaults to the pre-ticket-06 assumption (`observe` +
 * `block`) so a caller that predates Capability-awareness keeps denying
 * exactly as before.
 *
 * ADR 0007 (ticket 01): `decision` is fixed HERE, before any side effect
 * runs, and never changes afterward. Logging the decision, deriving the
 * Inbox id, and notifying each get their OWN catch below, so a failure in
 * any of them can never turn a deny already decided into an allow.
 *
 * The built-in fence (decision 05, ticket 09, `fence.ts`) is checked FIRST,
 * ahead of the Policy's own Rules and independent of what `policy.toml`
 * contains — it is never a `policy.toml` entry, so a match here must never
 * depend on the Policy having loaded any Rules at all. A fence match takes
 * over the SAME `human`-effect pipeline every other reserved command goes
 * through (deny, log, open an Inbox item, notify) rather than inventing a
 * second one, so the rest of this function is unaware the Rule it is
 * holding is built-in at all.
 *
 * Inbox identity (decision 03, ADR 0005, ticket 06): the id is hashed
 * DIRECTLY from the line `appendEventAtLine` reports THIS call's own Event
 * landed on — never derived by re-deriving the whole Inbox and taking
 * "whatever is last" (the v0.1-era approach the old code here used,
 * through `deriveInbox`'s positional ordering). That mattered even after
 * the original ticket 06 ordering fix, because TWO denying hooks for the
 * SAME Session can run concurrently (two parallel tool calls in one turn):
 * each must get back ITS OWN line's id, not whichever row a full rescan
 * happens to see last. `deriveInboxReport` is still called once — but only
 * to learn `skippedLines` (ADR 0007, ticket 01) and the current universe
 * of ids to shorten this one against (ticket 06's display hash) — its
 * `items` are never consulted for identity anymore.
 *
 * A `human` match — enforced or not — is also where 🟡 fires (ticket 08):
 * the ONE place every Adapter opens an Inbox item, so it is the one place
 * that needs to know a Notification exists at all. `notifyNewInboxItem`
 * never throws on its own, but is still wrapped here with the rest of this
 * step's side effects, per ADR 0007.
 */
export async function decideAction(
  home: string,
  session: string,
  action: Action,
  capabilities: Capability[] = ["observe", "block"],
): Promise<DecisionResult> {
  const policy = loadPolicy(home);
  const outcome = matchesBuiltInFence(action) ? { rule: BUILT_IN_FENCE_RULE } : await matchRule(action, policy);
  if (!outcome) return { decision: "allow", logged: false };
  const { rule, reason } = outcome;

  const canDeny = rule.effect === "human" && capabilities.includes("block");
  const decision = canDeny ? "deny" : "allow";

  let line: number | undefined;
  try {
    const appended = appendEventAtLine(home, actionDecidedEvent(session, action, decision, rule, reason));
    line = appended.line;
  } catch {
    // `decision` above already stands; failing to log it never changes
    // what this call returns (ADR 0007).
  }

  if (rule.effect !== "human") {
    return { decision: "allow", logged: true, rule };
  }

  let inboxId: string | undefined;
  let skippedLines: number | undefined;
  if (line !== undefined) {
    const fullId = inboxIdentityHash(session, line);
    try {
      const { skipped, allIds } = deriveInboxReport(home);
      if (skipped > 0) skippedLines = skipped;
      const idx = allIds.indexOf(fullId);
      inboxId = idx === -1 ? fullId : shortHashAt(allIds, idx);
      notifyNewInboxItem(home, fullId, inboxId);
    } catch {
      // Deriving the display id (or notifying) failed; `decision` already
      // stands (ADR 0007, H1). The agent is still pointed at `tenaza
      // status` by `adapters/claude.ts`'s `denyMessage` when `inboxId`
      // comes back undefined.
    }
  }

  return { decision, logged: true, rule, inboxId, skippedLines };
}
