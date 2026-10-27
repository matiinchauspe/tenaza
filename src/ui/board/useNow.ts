import { useEffect, useState } from "react";

/** Within the spec's own "15-30s" range for re-evaluating time-based state. */
export const DEFAULT_TICK_MS = 20_000;

/**
 * A ticking clock (ticket 08's "TIME IS STATE"): re-renders the board every
 * `tickMs` so `sessionColumn`/`isSessionStalled`/`formatAge` (`src/board.ts`)
 * re-evaluate even when no new SSE push ever arrives — the exact case of a
 * Session that simply went silent (no further Event, so no further push)
 * or an ended Session crossing out of the 24h TERMINÓ window.
 */
export function useNow(tickMs: number = DEFAULT_TICK_MS): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  return now;
}
