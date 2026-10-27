import type { ReactNode } from "react";

/**
 * The board's badge states: a pending request awaiting `run` ("inbox",
 * dim), one already ran unenforced ("ran", red — ADR 0001's "YA CORRIÓ"),
 * and — ticket 10 — a Session's own live hold, draining toward pending
 * ("wait", amber, the prototype's own tone). `StatusBadge` itself stays
 * generic; a plain Session card with no live hold still renders through a
 * colored dot instead (inline on the card — see `SessionCard`), never this
 * component.
 */
export type BadgeTone = "inbox" | "ran" | "wait";

export interface StatusBadgeProps {
  tone: BadgeTone;
  children: ReactNode;
}

/** Pure presentational: props in, markup out. Uppercase, square — HumanLayer's own look (CSS does the uppercasing; the text itself stays mixed-case in the DOM). Color is NEVER the only signal: the text itself names the status, so the badge reads the same under any color-vision deficiency. */
export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}
