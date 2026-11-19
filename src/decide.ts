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
      /**
       * True only for a live-answering approve — the one case an explicit
       * hook `allow` is actually wanted, since it skips Claude Code's own
       * auto-mode classifier, which would be LESS safe for every other
       * allow. The adapter checks only this flag, never
       * `additionalContext`'s mere presence, since an approve with no
       * message still needs the explicit allow.
       */
      live?: true;
      /**
       * Set only alongside `live: true`, and only when the human typed a
       * message — forwarded as PreToolUse `additionalContext`.
       * `undefined` on an approve with no message, never an empty string.
       */
      additionalContext?: string;
    }
  | {
      decision: "deny";
      logged: true;
      rule: Rule;
      inboxId?: string;
      skippedLines?: number;
      /**
       * Set only on a live-answering deny (reject, expiry, or a heartbeat
       * gone stale mid-wait) — overrides the adapter's own generic
       * `denyMessage(inboxId)`. `undefined` for the plain immediate deny
       * (no Daemon up at all), which keeps that wording exactly as is.
       */
      reason?: string;
    };

/**
 * One Session, one match's worth of log + Inbox-id + notify side effects,
 * shared by the three decisions that surface in the Inbox: the
 * unblockable allow, the plain immediate deny (no Daemon), and the
 * freshly-born-live hold. A flag match never reaches here.
 */
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
  } catch {}

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
      // The agent is still pointed at `tenaza status` by
      // `adapters/claude.ts`'s `denyMessage` when `inboxId` comes back
      // undefined.
    }
  }

  return { line, eventTs, inboxId, skippedLines };
}

/**
 * The id a human-facing MESSAGE embeds must stay accurate even minutes
 * after the hold began — `inboxId` captured at hold time is a display
 * hash, the shortest prefix unique AT THAT MOMENT, and the universe of ids
 * can grow while this call sits in `waitForLiveAnswer`. Recomputed fresh
 * only for text the agent actually reads; every other use of the
 * hold-time `inboxId` keeps the existing drift the rest of this codebase
 * lives with.
 */
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
 * Decides one Action against the Policy, logging it when (and only when) a
 * Rule matched. A `human` match wants to deny and open an Inbox item — but
 * denying is an enforcement act: only a caller that declares the `block`
 * Capability can make it stick. Without it, claiming "deny" in the log
 * would be a lie — the call runs regardless of what Tenaza says — so it
 * degrades to the same shape as a `flag` match: allowed, but still
 * recorded and surfaced in the Inbox, never silently dropped. A `flag`
 * match is unaffected either way — it was never about blocking.
 *
 * `capabilities` defaults to `observe` + `block` so a caller that predates
 * Capability-awareness keeps denying exactly as before.
 *
 * `decision` is fixed before any side effect runs for the
 * flag/unblockable/no-Daemon paths, and never changes afterward — logging
 * it, deriving the Inbox id, and notifying each run behind their own catch
 * (`logHumanMatchAndNotify`), so a failure in any of them can never turn a
 * deny already decided into an allow.
 *
 * The built-in fence (`fence.ts`) is checked FIRST, ahead of the Policy's
 * own Rules and independent of what `policy.toml` contains. A fence match
 * takes over the SAME `human`-effect pipeline every other reserved command
 * goes through, rather than inventing a second one, so the rest of this
 * function is unaware the Rule it is holding is built-in at all.
 *
 * Inbox identity is the id hashed DIRECTLY from the line this call's own
 * `action.decided` Event landed on — never derived by re-deriving the
 * whole Inbox and taking "whatever is last." That stays true for a held
 * item too: the identity line is written ONCE, the moment it is born live,
 * and never rewritten.
 *
 * **Live answering:** a `human` match this caller could actually deny
 * first checks whether a Daemon is up. Fresh → the item is born LIVE:
 * logged as `"held"`, the notification fires, then this call awaits
 * `waitForLiveAnswer` for up to the Policy's effective `wait_seconds`
 * before ever returning — approve closes the item and allows, reject
 * closes it and denies, and expiry or a heartbeat gone stale mid-wait
 * denies WITHOUT closing it: TIME IS STATE, the item simply reads as
 * pending from then on, no second Event ever written for that transition.
 * Stale or absent from the START degrades to the same immediate-deny shape
 * as the no-heartbeat path.
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
    } catch {}
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

  const { line, eventTs, inboxId, skippedLines } = await logHumanMatchAndNotify(
    home,
    session,
    action,
    "held",
    rule,
    reason,
  );
  if (line === undefined || eventTs === undefined || inboxId === undefined) {
    // Could not establish this hold's own identity — nothing to poll for,
    // so this degrades to the no-Daemon path's immediate-deny shape rather
    // than leaving a dangling hold nobody can ever answer.
    return { decision: "deny", logged: true, rule, inboxId, skippedLines };
  }

  const fullId = inboxIdentityHash(session, line);
  const deadlineAtMs = new Date(eventTs).getTime() + effectiveWaitSeconds(policy) * 1000;
  const holdOutcome = await waitForLiveAnswer(home, fullId, deadlineAtMs);

  if (holdOutcome.kind === "approved") {
    try {
      appendHumanEvent(home, approvalResolvedEvent(session, fullId, "done", "live"));
    } catch {}
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
    } catch {}
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

  // Still open for the human to `run` it from the view.
  return {
    decision: "deny",
    logged: true,
    rule,
    inboxId,
    skippedLines,
    reason: buildExpiryDenyMessage(freshShortId(home, fullId, inboxId)),
  };
}
