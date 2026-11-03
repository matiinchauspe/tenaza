import { useEffect, useRef, useState } from "react";
import {
  ACTIVITY_FEED_CAPACITY,
  diffActivityFeed,
  type ActivityFeedEntry,
  type ActivitySnapshot,
  type ActivitySnapshots,
} from "../../board";
import type { BoardPayload } from "../../contract/live";

/**
 * Ticket 12 (spec "Activity panel (l)"): the activity panel's own data
 * source — "derived from the stream... never stored." This hook keeps
 * NOTHING beyond the capped in-memory list React itself holds for THIS
 * render (`entries`) and the per-session snapshot `diffActivityFeed`
 * needs to detect the NEXT change (`snapshotRef`, a plain ref — never
 * written to disk, never sent anywhere, gone the moment the tab closes).
 *
 * Re-diffs on EVERY `(payload, now)` pair the container hands it — not
 * only a fresh SSE push: a Session crossing into TRABADA is itself a
 * time-based reclassification with no new bytes over the wire
 * (`board.ts`'s own "TIME IS STATE"), so the SAME ticking clock driving
 * every other time-based thing on this board (`useNow`) must also drive
 * this diff, or a stall transition would simply never appear in the
 * panel until SOME OTHER change happened to push a new payload first.
 *
 * Deepening ticket 03: `payload.sessions` (`BoardSession[]`) passes
 * straight through to `diffActivityFeed`, which only ever reads
 * `ActivitySession`'s fields — structural typing, no `.map()` copy. Ticket
 * 09 once needed a hand-written field list here to carry `turnWait`/
 * `nativeWait` through (so this diff's own `sessionColumn` call could tell
 * a waiting Session from a stalled one); a field the classifier needs
 * could silently be dropped from that list again. Passing the payload's
 * own Sessions directly means there is no list left to drop one from.
 */
export function useActivityFeed(payload: BoardPayload | undefined, now: Date): readonly ActivityFeedEntry[] {
  const [entries, setEntries] = useState<readonly ActivityFeedEntry[]>([]);
  const snapshotRef = useRef<ActivitySnapshots>(new Map<string, ActivitySnapshot>());

  useEffect(() => {
    if (!payload) return;
    const { additions, next } = diffActivityFeed(
      payload.sessions,
      snapshotRef.current,
      now,
      payload.policy.stallMinutes,
    );
    snapshotRef.current = next;

    if (additions.length > 0) {
      setEntries((prev) => [...additions, ...prev].slice(0, ACTIVITY_FEED_CAPACITY));
    }
  }, [payload, now]);

  return entries;
}
