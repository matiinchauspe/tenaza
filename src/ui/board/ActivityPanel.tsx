import type { ActivityFeedEntry } from "../../board";

export interface ActivityPanelProps {
  open: boolean;
  entries: readonly ActivityFeedEntry[];
}

/** Absolute, never relative "hace Ns": the panel already orders entries newest-first, so an absolute time reads better here. */
function formatClock(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * `BoardApp` owns `open` entirely — nothing here ever toggles it. Pure presentational:
 * `entries` arrives already newest-first and already capped, so this component renders
 * exactly what it's handed.
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
