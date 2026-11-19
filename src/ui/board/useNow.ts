import { useEffect, useState } from "react";

/** 1s, finer than the board otherwise needs: the draining bar and live → pending flip need that resolution, and there's deliberately one shared clock rather than a second interval just for them. */
export const DEFAULT_TICK_MS = 1_000;

/** Re-renders every `tickMs` so time-based classification (`src/board.ts`) re-evaluates even with no new SSE push — e.g. a session that's gone silent, or crossed the 24h window. */
export function useNow(tickMs: number = DEFAULT_TICK_MS): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  return now;
}
