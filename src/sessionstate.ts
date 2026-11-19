/**
 * The one place that decides a session's state, so `board.ts` and
 * `sessions.ts` never drift against each other on it again. Zero imports:
 * the Live surface's React client bundles this file directly, so no node
 * builtin can leak in. Owns only the state ladder and the Stalled silence
 * math — never wait derivation (`sessions.ts`) or display labels
 * (`board.ts`, `sessions.ts`).
 */

export type SessionState = "ended" | "waiting" | "stalled" | "working";

/**
 * Pre-derived facts only, never a raw `SessionNode`/`BoardSession` — so
 * this file stays import-free.
 *
 * `waitingForHuman` is the Turn-derived wait ONLY (`turnWait`/`nativeWait`
 * presence) — never an Inbox item's "waits for the human." A Turn simply
 * ending with nobody having typed the next prompt yet is a different
 * thing from an Inbox item needing an answer to a specific Action.
 *
 * `lastEventTs` already has any Activity touch merged in by the caller
 * (`sessions.ts`'s `closedOutSessionIndex`) — this file never reads a
 * touch file itself.
 */
export interface SessionStateFacts {
  ended: boolean;
  waitingForHuman: boolean;
  lastEventTs?: string;
}

/**
 * `ended` wins outright, even if the session looked mid-wait right before
 * it ended. `waitingForHuman` wins next: a KNOWN cause for silence (the
 * agent handed back and is waiting on you) is never confused with the
 * UNKNOWN one Stalled names.
 */
export function sessionState(facts: SessionStateFacts, now: Date, stallThresholdMs: number): SessionState {
  if (facts.ended) return "ended";
  if (facts.waitingForHuman) return "waiting";
  return isStalled(facts.lastEventTs, now, stallThresholdMs) ? "stalled" : "working";
}

/**
 * No Event at all (`lastEventTs` absent) is never Stalled — nothing to
 * measure silence against yet. `stallThresholdMs` is never defaulted
 * here: it always comes from the one place the Policy is read, so the CLI
 * and the board can't drift apart on the number.
 */
function isStalled(lastEventTs: string | undefined, now: Date, stallThresholdMs: number): boolean {
  if (!lastEventTs) return false;
  return now.getTime() - new Date(lastEventTs).getTime() > stallThresholdMs;
}
