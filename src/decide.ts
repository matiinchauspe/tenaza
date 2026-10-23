import type { Capability } from "./contract/event";
import { type Action, actionDecidedEvent } from "./contract/event";
import { deriveInbox } from "./inbox";
import { appendEvent } from "./log";
import { loadPolicy, matchRule, type Rule } from "./policy";

export type DecisionResult =
  | { decision: "allow"; logged: false }
  | { decision: "allow"; logged: true; rule: Rule }
  | { decision: "deny"; logged: true; rule: Rule; inboxId: number };

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
 */
export function decideAction(
  home: string,
  session: string,
  action: Action,
  capabilities: Capability[] = ["observe", "block"],
): DecisionResult {
  const policy = loadPolicy(home);
  const rule = matchRule(action, policy);
  if (!rule) return { decision: "allow", logged: false };

  const canDeny = rule.effect === "human" && capabilities.includes("block");
  const decision = canDeny ? "deny" : "allow";
  appendEvent(home, actionDecidedEvent(session, action, decision, rule));

  if (decision === "deny") {
    const inbox = deriveInbox(home);
    const justOpened = inbox[inbox.length - 1];
    if (!justOpened) {
      throw new Error("decideAction: wrote a deny but the Inbox came back empty");
    }
    return { decision: "deny", logged: true, rule, inboxId: justOpened.id };
  }

  return { decision: "allow", logged: true, rule };
}
