/**
 * The Session-state classifier (deepening ticket 03): the ONE place that
 * decides a Session's state — ended > waiting for the human > Stalled >
 * working, the glossary's own precedence (docs/GLOSSARY.md's "Stalled"
 * entry) — so `board.ts`'s `sessionColumn` and `sessions.ts`'s
 * `categoryWord` (through `renderNode`) never drift on it again, the way
 * the CLI tree and the board once did (`d0da4d9` taught the CLI that a
 * waiting Session is never Stalled; the board kept filing it under TRABADA
 * until a later fix, `a435162`, caught up).
 *
 * Zero imports, the same rule `board.ts` and `contextbar.ts` already
 * follow: the React client bundles this file directly, so it must never
 * pull in a node builtin transitively.
 *
 * It owns ONLY this ladder and the Stalled silence math — never the wait
 * DERIVATION (`sessions.ts`'s `turnWaitSince`/`nativeWaitFor`, and "a
 * native prompt beats a plain Turn wait," stay there as a single copy; the
 * Daemon ships their result as `turnWait`/`nativeWait` over SSE) and never
 * a LABEL (CORRIENDO/TRABADA/TERMINÓ stay in `board.ts`; "esperándote · N
 * en segundo plano" / "sin señal" stay in `sessions.ts`; the 24h TERMINÓ
 * card window stays in `board.ts` too — it decides which cards show, not
 * what state a Session is in).
 *
 * TIME IS STATE, the same convention `board.ts`'s own header documents:
 * `now` and `stallThresholdMs` are always plain arguments, never read
 * internally — the caller's own ticking clock (the board's `useNow`, or a
 * fresh `new Date()` per CLI render) is what re-evaluates this against the
 * clock, including for a Session that stopped producing Events entirely.
 */

export type SessionState = "ended" | "waiting" | "stalled" | "working";

/**
 * The already-derived facts this ladder reads — never a raw `SessionNode`
 * or `BoardSession`, so this file stays import-free.
 *
 * `ended` is whether a real or derived end was recorded (`sessions.ts`'s
 * `closedOutSessionIndex` sets this one way or another for every Session
 * it closes; the board's own payload carries the same `endedAt`).
 *
 * `waitingForHuman` is the Turn-derived wait ONLY — `sessions.ts`'s
 * `turnWaitSince`/`nativeWaitFor`, carried over SSE as the mere PRESENCE
 * of `turnWait`/`nativeWait`. It is NOT an Inbox item's own "waits for the
 * human": the glossary draws that line on purpose (docs/GLOSSARY.md's
 * "Turn" entry) — a Turn simply ended and nobody has typed the next prompt
 * yet, which is a different thing from an Inbox item needing an answer to
 * a specific Action. `sessions.ts`'s own structural rollup (`nodeCategory`)
 * keeps deciding that axis; this ladder never sees it.
 *
 * `lastEventTs` is the Session's latest observed activity, with any
 * Activity touch already merged in by the caller
 * (`sessions.ts`'s `closedOutSessionIndex`) — this file never reads a
 * touch file, or anything else, itself.
 */
export interface SessionStateFacts {
  ended: boolean;
  waitingForHuman: boolean;
  lastEventTs?: string;
}

/**
 * ended > waiting for the human > Stalled > working. `ended` wins
 * outright: a Session that already finished is never read as waiting or
 * Stalled, however stale its last Event was or however it looked mid-wait
 * right before it ended. `waitingForHuman` wins next: a KNOWN cause for
 * the silence ("the agent handed back and is waiting on you") is never
 * confused with the UNKNOWN one Stalled names, however long that silence
 * has run. Only once neither applies does the Stalled silence math below
 * decide between "stalled" and "working".
 */
export function sessionState(facts: SessionStateFacts, now: Date, stallThresholdMs: number): SessionState {
  if (facts.ended) return "ended";
  if (facts.waitingForHuman) return "waiting";
  return isStalled(facts.lastEventTs, now, stallThresholdMs) ? "stalled" : "working";
}

/**
 * The Stalled silence math alone (docs/GLOSSARY.md's "Stalled": "no Event
 * for longer than the Policy's stall threshold"). A Session with no Event
 * at all (`lastEventTs` absent) is never Stalled — there is nothing to
 * measure silence against yet, the same convention every other
 * time-based check in this project already follows.
 *
 * `stallThresholdMs` is never defaulted here, same reasoning `board.ts`'s
 * header already gives for its own former copy of this math: it always
 * comes from the ONE place the Policy is read (`policy.ts`'s
 * `DEFAULT_STALL_MINUTES`) — a default in this file would be a second
 * number the CLI and the board could drift apart on again.
 */
function isStalled(lastEventTs: string | undefined, now: Date, stallThresholdMs: number): boolean {
  if (!lastEventTs) return false;
  return now.getTime() - new Date(lastEventTs).getTime() > stallThresholdMs;
}
