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
 * Re-diffs on every `(payload, now)` pair, not just a fresh SSE push: a session going stale
 * is a time-based reclassification with no new payload, so without `now` in the deps a stall
 * would never surface until something else changed.
 *
 * `payload.sessions` passes straight through to `diffActivityFeed` via structural typing — no
 * hand-picked field list to accidentally drop a field from.
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
