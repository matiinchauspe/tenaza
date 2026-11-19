import type { ReactNode } from "react";

/** Kept apart from `StatusBadge`'s own tone — a column header renders a dot, never an uppercase badge. */
export type ColumnTone = "te-necesita" | "corriendo" | "trabada" | "termino";

export interface ColumnProps {
  title: string;
  count: number;
  tone: ColumnTone;
  /** Shown instead of the list when `count` is 0 — es-AR copy, the caller's call. */
  emptyMessage: string;
  /** `undefined` for every other column, which carries none. */
  tooltip?: string;
  children: ReactNode;
}

/**
 * A labelled region landmark with its own heading, holding a `listbox` of selectable cards.
 * Pure presentational: the container decides which cards belong here. Color is never the
 * only signal — the title text itself always names the column.
 */
export function Column({ title, count, tone, emptyMessage, tooltip, children }: ColumnProps) {
  return (
    <section className="column" aria-label={`${title} (${count})`}>
      <header className="column__header">
        <span className={`column__dot column__dot--${tone}`} aria-hidden="true" />
        <h2 className={`column__title column__title--${tone}`} title={tooltip}>
          {title}
        </h2>
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
