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
 * Rule matched. A `human` match denies and opens an Inbox item; a `flag`
 * match allows and still records the decision; no match allows silently.
 */
export function decideAction(
  home: string,
  session: string,
  action: Action,
): DecisionResult {
  const policy = loadPolicy(home);
  const rule = matchRule(action, policy);
  if (!rule) return { decision: "allow", logged: false };

  const decision = rule.effect === "human" ? "deny" : "allow";
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
