import type { ReactNode } from "react";

/** The four column identities a dot/title color key off (prototype's own `c-<cls>`/`b-<cls>` convention) — kept apart from `StatusBadge`'s own tone, which a column header no longer renders through (the prototype shows an inline dot, never an uppercase badge, for a column heading). */
export type ColumnTone = "te-necesita" | "corriendo" | "trabada" | "termino";

export interface ColumnProps {
  title: string;
  count: number;
  tone: ColumnTone;
  /** Shown instead of the list when `count` is 0 (prototype's own `.empty` placeholder) — es-AR copy, the column's call. */
  emptyMessage: string;
  children: ReactNode;
}

/**
 * One board column (ticket 08) — a labelled region landmark with its own
 * heading, holding a `listbox` of selectable cards. Pure presentational:
 * no fetching, no state — the container decides which cards belong here.
 * The dot + colored title (prototype, decision 04's human fix round) ARE
 * the column's own status signal — color is never the ONLY one, since the
 * title text itself always names the column ("CORRIENDO", "TRABADA", …).
 */
export function Column({ title, count, tone, emptyMessage, children }: ColumnProps) {
  return (
    <section className="column" aria-label={`${title} (${count})`}>
      <header className="column__header">
        <span className={`column__dot column__dot--${tone}`} aria-hidden="true" />
        <h2 className={`column__title column__title--${tone}`}>{title}</h2>
        <span className="column__count">{count}</span>
      </header>
      {count > 0 ? (
        <ul className="column__list" role="listbox" aria-label={title}>
          {children}
        </ul>
      ) : (
        <div className="column__list column__list--empty">
          <p className="column__empty">{emptyMessage}</p>
        </div>
      )}
    </section>
  );
}
