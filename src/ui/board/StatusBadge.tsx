import type { ReactNode } from "react";

/**
 * The action card's own two badge states (ticket 08's read-only slice of
 * decision 04's prototype): denied and awaiting `run` ("inbox", dim) vs.
 * already ran unenforced ("ran", red — ADR 0001's "YA CORRIÓ"). The
 * prototype's THIRD state ("wait", a live item draining toward the Inbox)
 * has no source yet — the contract carries no `kind` to tell a live item
 * apart from a plain pending one (ticket 10) — so it is out of scope here
 * and not a tone this type offers. `StatusBadge` itself stays generic;
 * Session cards no longer render through it at all (a colored dot, inline
 * on the card, carries that signal instead — see `SessionCard`).
 */
export type BadgeTone = "inbox" | "ran";

export interface StatusBadgeProps {
  tone: BadgeTone;
  children: ReactNode;
}

/** Pure presentational: props in, markup out. Uppercase, square — HumanLayer's own look (CSS does the uppercasing; the text itself stays mixed-case in the DOM). Color is NEVER the only signal: the text itself names the status, so the badge reads the same under any color-vision deficiency. */
export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}
