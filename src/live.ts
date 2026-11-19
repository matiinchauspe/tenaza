import { DEFAULT_HEARTBEAT_STALE_MS, isHeartbeatFresh, readAlive } from "./daemonlink";
import { readHumanEventsTolerant } from "./log";

/**
 * Live answering's own hold/poll loop — reached only when a `human` match
 * could actually be denied (the capability-lacking case never holds) and
 * the Daemon's heartbeat read fresh when the item was born live. Blind to
 * how it got called: it watches the human log and the heartbeat until one
 * of four things happens, and reports which.
 */

/** Overridable via `TENAZA_LIVE_POLL_MS` so a test never waits ~500ms real time per tick. */
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
 * The Daemon refuses an answer arriving with less than this left on the
 * window, as `not-live`. Two poll intervals, so the hook always gets at
 * least one full tick to read an accepted answer before the window
 * closes.
 */
export const LIVE_ANSWER_CUTOFF_MS = 2 * DEFAULT_LIVE_POLL_INTERVAL_MS;

/** Sent when the human rejects without typing a message. */
export const GENERIC_REJECT_REASON = "Rechazado por el humano — sin mensaje.";

/** On expiry the item turns pending and stays open. Reused verbatim for the stale-heartbeat case too — functionally the same outcome: nobody answered. */
export function buildExpiryDenyMessage(shortId: string): string {
  return `nadie respondió; quedó como inbox ${shortId} para que el humano lo corra`;
}

export interface LiveAnswer {
  answer: "approve" | "reject";
  message?: string;
}

/** Tolerant of a torn line — a poll tick that hits one simply retries next tick rather than crash the hold. `undefined` while no answer has landed. */
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
 * Holds until the human answers, the window expires, or the heartbeat
 * goes stale — whichever comes first. `deadlineAtMs` is computed by the
 * CALLER (from the held event's `ts` plus the Policy's effective wait)
 * and never recomputed here, so the hook and any later reader of the same
 * row agree on when it lapses.
 *
 * Checked in this order every tick: heartbeat first (a stale heartbeat
 * must deny at once, never wait for a tick that also happens to see a
 * stale answer file), then the answer (an answer landing in the same
 * instant the window closes still wins over expiry).
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
      // An answer can land between the read above and this clock check.
      // Read once more before giving up, so an accepted answer is never
      // left orphaned while the agent is told nobody answered.
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
