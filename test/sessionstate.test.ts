import { describe, expect, test } from "bun:test";
import { sessionState } from "../src/sessionstate";

// Deepening ticket 03: the ONE place "ended > waiting for the human >
// Stalled > working" (docs/GLOSSARY.md's "Stalled") is proven — one case
// per rung. `board.test.ts`'s `sessionColumn` and `sessions.test.ts`'s
// `categoryWord` suites keep only the LABEL each surface puts on a
// resolved state (and, for the board, the 24h TERMINÓ window); the
// precedence itself lives only here from now on.

const STALL_THRESHOLD_MS = 15 * 60 * 1000;

describe("sessionState", () => {
  test("a live Session with a recent Event and nothing else going on is working", () => {
    const now = new Date("2026-01-01T00:01:00.000Z");
    const facts = { ended: false, waitingForHuman: false, lastEventTs: "2026-01-01T00:00:00.000Z" };
    expect(sessionState(facts, now, STALL_THRESHOLD_MS)).toBe("working");
  });

  test("ended beats everything — an ended Session is never read as waiting or Stalled, however stale or how-currently-waiting it looked right before it ended", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const facts = { ended: true, waitingForHuman: true, lastEventTs: "2025-01-01T00:00:00.000Z" };
    expect(sessionState(facts, now, STALL_THRESHOLD_MS)).toBe("ended");
  });

  test("waiting beats Stalled — a KNOWN cause for the silence is never relabeled Stalled, however long that silence has run", () => {
    const now = new Date("2026-01-01T06:00:00.000Z"); // hours past the stall threshold
    const facts = { ended: false, waitingForHuman: true, lastEventTs: "2026-01-01T00:00:00.000Z" };
    expect(sessionState(facts, now, STALL_THRESHOLD_MS)).toBe("waiting");
  });

  test("a Session with no Event at all is never Stalled — there is nothing to measure silence against yet", () => {
    const now = new Date("2026-01-01T06:00:00.000Z");
    const facts = { ended: false, waitingForHuman: false, lastEventTs: undefined };
    expect(sessionState(facts, now, STALL_THRESHOLD_MS)).toBe("working");
  });

  test("the exact threshold edge — silent exactly at the threshold is not yet Stalled; one ms past, it is", () => {
    const lastEventTs = "2026-01-01T00:00:00.000Z";
    const atThreshold = new Date(new Date(lastEventTs).getTime() + STALL_THRESHOLD_MS);
    const pastThreshold = new Date(atThreshold.getTime() + 1);
    const facts = { ended: false, waitingForHuman: false, lastEventTs };
    expect(sessionState(facts, atThreshold, STALL_THRESHOLD_MS)).toBe("working");
    expect(sessionState(facts, pastThreshold, STALL_THRESHOLD_MS)).toBe("stalled");
  });
});
