import { useEffect, useState } from "react";

/**
 * Ticket 10: the ONE board-wide clock now also drives the live-answering
 * draining bar and the live → pending flip on expiry (`board.ts`'s
 * `liveItemPhase`/`liveWaitRemainingFraction`), neither of which can read
 * right on a 20s cadence — the BC2 prototype itself re-renders every
 * 1000ms. Ticket 08's own "15-30s" range was never load-bearing (a build-
 * time default, not spec-mandated) and is superseded here: there is
 * deliberately only ONE clock for the whole board — `sessionColumn`/
 * `isSessionStalled`/`formatAge` simply ride the same faster tick now,
 * rather than this hook growing a second interval for the live items alone.
 */
export const DEFAULT_TICK_MS = 1_000;

/**
 * A ticking clock (ticket 08's "TIME IS STATE"): re-renders the board every
 * `tickMs` so `sessionColumn`/`isSessionStalled`/`formatAge` (`src/board.ts`)
 * re-evaluate even when no new SSE push ever arrives — the exact case of a
 * Session that simply went silent (no further Event, so no further push)
 * or an ended Session crossing out of the 24h TERMINÓ window. Ticket 10
 * extends that same list with `liveItemPhase`/`liveWaitRemainingFraction`.
 */
export function useNow(tickMs: number = DEFAULT_TICK_MS): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  return now;
}
