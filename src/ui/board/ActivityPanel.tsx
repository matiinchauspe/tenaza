import type { ActivityFeedEntry } from "../../board";

export interface ActivityPanelProps {
  open: boolean;
  entries: readonly ActivityFeedEntry[];
}

/** A plain wall-clock reading of `ts` (same convention the BC2 prototype's own `#log` used: "when I observed this," never a relative "hace Ns" — the panel already orders entries newest-first, so an absolute time reads better here). An unparsable `ts` (should never happen — every entry builds its own) degrades to an em dash rather than "Invalid Date." */
function formatClock(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Ticket 12 (spec "Activity panel (l)"): a small panel, bottom-right,
 * closed by default — `l` (or a selected-session click elsewhere) never
 * mounts it; `BoardApp` owns `open` entirely. Ported from the approved
 * BC2 prototype's own `#feed`/`#log`
 * (`.yun/prototypes/tenaza-live-surface/PROTOTYPE-live-surface-BC2.ts:244-270,412`)
 * into this project's tokens.css style — same position, same density,
 * BEM selectors instead of the prototype's one-letter classes, same as
 * every other ported block in this file (`tokens.css`'s own doc comment).
 * Pure presentational: `entries` is already newest-first and already
 * capped (`useActivityFeed.ts`'s own `ACTIVITY_FEED_CAPACITY`) — this
 * component renders exactly what it's handed, nothing more.
 */
export function ActivityPanel({ open, entries }: ActivityPanelProps) {
  if (!open) return null;
  return (
    <div className="activity-panel" role="log" aria-label="actividad del board">
      <div className="activity-panel__header">
        <span>actividad</span>
        <em>l para cerrar</em>
      </div>
      <div className="activity-panel__log">
        {entries.length === 0 ? (
          <div className="activity-panel__empty">nada todavía</div>
        ) : (
          entries.map((entry, index) => (
            <div
              key={entry.id}
              className={`activity-panel__entry${index === 0 ? " activity-panel__entry--latest" : ""}`}
            >
              <time>{formatClock(entry.ts)}</time>
              {entry.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
