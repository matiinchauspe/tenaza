import { type Action, actionDecidedEvent, approvalResolvedEvent, type Capability } from "./contract/event";
import { isHeartbeatFresh, readAlive } from "./daemonlink";
import { BUILT_IN_FENCE_RULE, matchesBuiltInFence } from "./fence";
import { inboxIdentityHash, shortHashAt } from "./identity";
import { deriveInboxReport } from "./inbox";
import { appendEventAtLine, appendHumanEvent } from "./log";
import { buildExpiryDenyMessage, GENERIC_REJECT_REASON, waitForLiveAnswer } from "./live";
import { notifyNewInboxItem } from "./notify";
import { effectiveWaitSeconds, loadPolicy, matchRule, type Rule } from "./policy";

export type DecisionResult =
  | { decision: "allow"; logged: false }
  | {
      decision: "allow";
      logged: true;
      rule: Rule;
      inboxId?: string;
      skippedLines?: number;
      /** Ticket 10: true ONLY for a live-answering APPROVE — the one case where an EXPLICIT hook `allow` is actually wanted: it runs before Claude Code's own auto-mode classifier and skips it (decision 08), which is exactly the point here (the human just said yes) but would be LESS safe for every other allow (H2's own mistake). The adapter stays silent (no `hookSpecificOutput` at all) for a flag match, a no-match, and the ADR 0001 unblockable case — only checks THIS flag, never `additionalContext`'s mere presence, since an approve with no message still needs the explicit allow. */
      live?: true;
      /** Set only alongside `live: true`, and only when the human actually typed a message — forwarded as PreToolUse `additionalContext` ("next to the tool result"). `undefined` on an approve with no message, never an empty string. */
      additionalContext?: string;
    }
  | {
      decision: "deny";
      logged: true;
      rule: Rule;
      inboxId?: string;
      skippedLines?: number;
      /** Ticket 10: set only on a live-answering deny (reject, expiry, or a heartbeat gone stale mid-wait) — overrides the adapter's own generic `denyMessage(inboxId)`. `undefined` for the plain, pre-ticket-10 immediate deny (no Daemon up at all), which keeps that wording exactly as it already is. */
      reason?: string;
    };

/** One Session, one match's worth of log + Inbox-id + notify side effects (ADR 0007: each gets its own catch, decision already stands either way). Shared by the three decisions that all surface in the Inbox — the unblockable allow (ADR 0001), the plain immediate deny (no Daemon), and the freshly-born-live hold — a flag match never reaches here (it returns before any of this). */
async function logHumanMatchAndNotify(
  home: string,
  session: string,
  action: Action,
  decision: "allow" | "deny" | "held",
  rule: Rule,
  reason: "parse_error" | undefined,
): Promise<{ line?: number; eventTs?: string; inboxId?: string; skippedLines?: number }> {
  let line: number | undefined;
  let eventTs: string | undefined;
  try {
    const appended = appendEventAtLine(home, actionDecidedEvent(session, action, decision, rule, reason));
    line = appended.line;
    eventTs = appended.event.ts;
  } catch {
    // `decision` already stands (ADR 0007) — failing to log it never changes what this call returns.
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

  return { line, eventTs, inboxId, skippedLines };
}

/** The id a human-facing MESSAGE embeds must stay accurate even minutes after the hold began — `inboxId` captured at hold time is a display hash, "the shortest prefix unique AT THAT MOMENT" (`identity.ts`), and the universe of ids can grow while this call sits in `waitForLiveAnswer`. Recomputed fresh only for text the agent actually reads; every other use of the hold-time `inboxId` (returned on the result, the 🟡 notification already fired) keeps the existing, accepted drift the rest of this codebase lives with. */
function freshShortId(home: string, fullId: string, fallback: string): string {
  try {
    const { allIds } = deriveInboxReport(home);
    const idx = allIds.indexOf(fullId);
    return idx === -1 ? fullId : shortHashAt(allIds, idx);
  } catch {
    return fallback;
  }
}

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
 * ADR 0007 (ticket 01): `decision` is fixed before any side effect runs for
 * the flag/unblockable/no-Daemon paths, and never changes afterward.
 * Logging the decision, deriving the Inbox id, and notifying each get their
 * OWN catch (`logHumanMatchAndNotify`), so a failure in any of them can
 * never turn a deny already decided into an allow.
 *
 * The built-in fence (decision 05, ticket 09, `fence.ts`) is checked FIRST,
 * ahead of the Policy's own Rules and independent of what `policy.toml`
 * contains — it is never a `policy.toml` entry, so a match here must never
 * depend on the Policy having loaded any Rules at all. A fence match takes
 * over the SAME `human`-effect pipeline every other reserved command goes
 * through (hold or deny, log, open an Inbox item, notify) rather than
 * inventing a second one, so the rest of this function is unaware the Rule
 * it is holding is built-in at all — including whether it ever goes live.
 *
 * Inbox identity (decision 03, ADR 0005, ticket 06) is the id hashed
 * DIRECTLY from the line THIS call's own `action.decided` Event landed on
 * — never derived by re-deriving the whole Inbox and taking "whatever is
 * last". That stays true for a held item too: the identity line is written
 * ONCE, the moment it is born live, and never rewritten — ticket 10's own
 * "one item, one id, throughout" (ADR 0005).
 *
 * **Live answering (ticket 10, decision 06):** a `human` match this caller
 * COULD actually deny (`capabilities` includes `block`) first checks
 * whether a Daemon is up (`daemonlink.ts`'s heartbeat). Fresh → the item is
 * born LIVE: logged as `"held"`, 🟡 fires, then this call awaits
 * `waitForLiveAnswer` for up to the Policy's effective `wait_seconds`
 * (`policy.ts`'s `effectiveWaitSeconds`) before ever returning — approve
 * closes the item and allows (the message as `additionalContext`), reject
 * closes it and denies (the message, or a generic one, as the reason),
 * and expiry or a heartbeat gone stale mid-wait denies WITHOUT closing it —
 * TIME IS STATE: the item simply reads as pending from then on, no second
 * Event ever written for that transition. Stale or absent from the START
 * degrades to the exact v0.1 shape this function already had: deny at
 * once, no hold attempted at all.
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

  if (rule.effect !== "human") {
    try {
      appendEventAtLine(home, actionDecidedEvent(session, action, "allow", rule, reason));
    } catch {
      // A `flag` match is always "allow" regardless — nothing here can ever change what this call returns (ADR 0007).
    }
    return { decision: "allow", logged: true, rule };
  }

  const canDeny = capabilities.includes("block");
  if (!canDeny) {
    const { inboxId, skippedLines } = await logHumanMatchAndNotify(home, session, action, "allow", rule, reason);
    return { decision: "allow", logged: true, rule, inboxId, skippedLines };
  }

  const heartbeatFresh = isHeartbeatFresh(readAlive(home), new Date());
  if (!heartbeatFresh) {
    const { inboxId, skippedLines } = await logHumanMatchAndNotify(home, session, action, "deny", rule, reason);
    return { decision: "deny", logged: true, rule, inboxId, skippedLines };
  }

  // Go live.
  const { line, eventTs, inboxId, skippedLines } = await logHumanMatchAndNotify(
    home,
    session,
    action,
    "held",
    rule,
    reason,
  );
  if (line === undefined || eventTs === undefined || inboxId === undefined) {
    // Could not even establish this hold's own identity (the write or the
    // id derivation itself failed) — there is nothing to poll FOR, so this
    // degrades to the exact same immediate-deny shape the no-Daemon path
    // above already returns, rather than leaving a dangling hold nobody
    // can ever answer.
    return { decision: "deny", logged: true, rule, inboxId, skippedLines };
  }

  const fullId = inboxIdentityHash(session, line);
  const deadlineAtMs = new Date(eventTs).getTime() + effectiveWaitSeconds(policy) * 1000;
  const holdOutcome = await waitForLiveAnswer(home, fullId, deadlineAtMs);

  if (holdOutcome.kind === "approved") {
    try {
      appendHumanEvent(home, approvalResolvedEvent(session, fullId, "done", "live"));
    } catch {
      // The decision (allow) already stands regardless of whether closing the item is recorded (ADR 0007).
    }
    const message = holdOutcome.message;
    return {
      decision: "allow",
      logged: true,
      rule,
      inboxId,
      skippedLines,
      live: true,
      additionalContext: message && message.length > 0 ? message : undefined,
    };
  }

  if (holdOutcome.kind === "rejected") {
    try {
      appendHumanEvent(home, approvalResolvedEvent(session, fullId, "dismissed", "live"));
    } catch {
      // The decision (deny) already stands regardless of whether closing the item is recorded (ADR 0007).
    }
    const message = holdOutcome.message;
    return {
      decision: "deny",
      logged: true,
      rule,
      inboxId,
      skippedLines,
      reason: message && message.length > 0 ? message : GENERIC_REJECT_REASON,
    };
  }

  // Expired, or the heartbeat went stale mid-wait: deny, no Event written
  // for the transition — the item simply reads as pending from here on
  // (TIME IS STATE), still open for the human to `run` it from the view.
  return {
    decision: "deny",
    logged: true,
    rule,
    inboxId,
    skippedLines,
    reason: buildExpiryDenyMessage(freshShortId(home, fullId, inboxId)),
  };
}
