import { DEFAULT_HEARTBEAT_STALE_MS, isHeartbeatFresh, readAlive } from "./daemonlink";
import { readHumanEventsTolerant } from "./log";

/**
 * Live answering's own hold/poll loop (ticket 10, decision 06) — the piece
 * `decide.ts` reaches for ONLY when a `human` match could actually be
 * denied (the capability-lacking case never holds — there's nothing to
 * pause) AND the Daemon's heartbeat already read fresh at the moment the
 * item was born live. Everything here is BLIND to how it got called: it
 * just watches the human log and the heartbeat until one of four things
 * happens, and reports which.
 */

/** Overridable via `TENAZA_LIVE_POLL_MS` (same reasoning as the heartbeat/SSE poll intervals) — a test never waits ~500ms real time per tick. */
export const DEFAULT_LIVE_POLL_INTERVAL_MS = 500;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function livePollIntervalMs(): number {
  return positiveIntFromEnv("TENAZA_LIVE_POLL_MS", DEFAULT_LIVE_POLL_INTERVAL_MS);
}

/**
 * Review fix (race at the deadline): the Daemon refuses an answer that
 * arrives with less than this left on the window, as `not-live` — the view
 * shows that refusal. Without it, an answer accepted in the hook's last
 * poll tick could land after the hook already denied on expiry, and the
 * human's click would silently do nothing. Two poll intervals, so the hook
 * always gets at least one full tick to read an accepted answer.
 */
export const LIVE_ANSWER_CUTOFF_MS = 2 * DEFAULT_LIVE_POLL_INTERVAL_MS;

/** Spec: "a reject with no message sends a generic reason" — the agent-facing deny reason when the human rejects without typing anything. */
export const GENERIC_REJECT_REASON = "Rechazado por el humano — sin mensaje.";

/** Spec's own exact wording for "On expiry: deny with...": the item turns pending and stays open. Reused verbatim for the stale-heartbeat-mid-wait case (decision 06) — functionally the SAME outcome, nobody answered. */
export function buildExpiryDenyMessage(shortId: string): string {
  return `nadie respondió; quedó como inbox ${shortId} para que el humano lo corra`;
}

export interface LiveAnswer {
  answer: "approve" | "reject";
  message?: string;
}

/** The FIRST `live.answered` Event naming `ref`, tolerant of a torn line (ADR 0007's own spirit — a poll tick that hits one simply tries again next tick, never crashes the hold). `undefined` while no answer has landed yet. */
export function readLiveAnswer(home: string, ref: string): LiveAnswer | undefined {
  const { events } = readHumanEventsTolerant(home);
  for (const event of events) {
    if (event.type === "live.answered" && event.data.ref === ref) {
      return { answer: event.data.answer, message: event.data.message };
    }
  }
  return undefined;
}

export type LiveHoldOutcome =
  | { kind: "approved"; message?: string }
  | { kind: "rejected"; message?: string }
  | { kind: "expired" }
  | { kind: "stale" };

/**
 * Hold until the human answers, the window expires, or the Daemon's
 * heartbeat goes stale — whichever comes first. `deadlineAtMs` is an
 * absolute epoch-ms timestamp, computed by the CALLER from the "held"
 * `action.decided` Event's own `ts` plus the Policy's effective
 * `waitSeconds` (`policy.ts`'s `effectiveWaitSeconds`) — never recomputed
 * in here, so the hook and any later reader of the SAME row always agree
 * on when it lapses.
 *
 * Order matters on every tick: an answer that lands in the SAME instant
 * the window closes still wins over expiry (checked first) — the human
 * clicked in time even if the hook's own clock reads it a beat later.
 * Heartbeat freshness is checked FIRST of all: "heartbeat going stale
 * mid-wait → deny at once" (decision 06) must never wait for a poll tick
 * that also happens to see a stale answer file.
 */
export async function waitForLiveAnswer(
  home: string,
  fullId: string,
  deadlineAtMs: number,
  pollMs: number = livePollIntervalMs(),
): Promise<LiveHoldOutcome> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!isHeartbeatFresh(readAlive(home), new Date(), DEFAULT_HEARTBEAT_STALE_MS)) {
      return { kind: "stale" };
    }

    const answer = readLiveAnswer(home, fullId);
    if (answer) {
      return answer.answer === "approve"
        ? { kind: "approved", message: answer.message }
        : { kind: "rejected", message: answer.message };
    }

    if (Date.now() >= deadlineAtMs) {
      // Review fix (race at the deadline): an answer can land between the
      // read above and this clock check. Read once more before giving up, so
      // an answer the Daemon accepted is never left orphaned while the
      // agent is told nobody answered. `LIVE_ANSWER_CUTOFF_MS` on the
      // Daemon's side closes the rest of the window.
      const lateAnswer = readLiveAnswer(home, fullId);
      if (lateAnswer) {
        return lateAnswer.answer === "approve"
          ? { kind: "approved", message: lateAnswer.message }
          : { kind: "rejected", message: lateAnswer.message };
      }
      return { kind: "expired" };
    }

    await Bun.sleep(pollMs);
  }
}
