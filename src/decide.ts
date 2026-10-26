import type { Capability } from "./contract/event";
import { type Action, actionDecidedEvent } from "./contract/event";
import { deriveInboxReport } from "./inbox";
import { appendEvent } from "./log";
import { notifyNewInboxItem } from "./notify";
import { loadPolicy, matchRule, type Rule } from "./policy";

export type DecisionResult =
  | { decision: "allow"; logged: false }
  | { decision: "allow"; logged: true; rule: Rule; inboxId?: number; skippedLines?: number }
  | { decision: "deny"; logged: true; rule: Rule; inboxId?: number; skippedLines?: number };

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
 * any of them can never turn a deny already decided into an allow (H1's
 * own regression: a torn log line AFTER a deny must never undo it). The
 * Inbox id is only derived once THIS call's own event is confirmed logged
 * — deriving it from a log that never got that event would silently hand
 * back a STALE id (the previous item's), which is worse than none;
 * `adapters/claude.ts`'s `denyMessage` points the agent at `tenaza status`
 * when the id itself comes back unavailable. That same derivation also
 * reports `skippedLines` — how many log lines it could not read right
 * now — so `adapters/claude.ts` can warn about it on THIS call without a
 * second, independent rescan of every Session's log on every hook call
 * (unbounded in the number of Sessions, and most calls match no Rule at
 * all, so most never reach this branch).
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
  const outcome = await matchRule(action, policy);
  if (!outcome) return { decision: "allow", logged: false };
  const { rule, reason } = outcome;

  const canDeny = rule.effect === "human" && capabilities.includes("block");
  const decision = canDeny ? "deny" : "allow";

  let appended = false;
  try {
    appendEvent(home, actionDecidedEvent(session, action, decision, rule, reason));
    appended = true;
  } catch {
    // `decision` above already stands; failing to log it never changes
    // what this call returns (ADR 0007).
  }

  if (rule.effect !== "human") {
    return { decision: "allow", logged: true, rule };
  }

  let inboxId: number | undefined;
  let skippedLines: number | undefined;
  if (appended) {
    try {
      const { items, skipped } = deriveInboxReport(home);
      inboxId = items[items.length - 1]?.id;
      if (skipped > 0) skippedLines = skipped;
      if (inboxId !== undefined) notifyNewInboxItem(home, inboxId);
    } catch {
      // Deriving the id (or notifying) failed; `decision` already stands
      // (ADR 0007, H1).
    }
  }

  return { decision, logged: true, rule, inboxId, skippedLines };
}
