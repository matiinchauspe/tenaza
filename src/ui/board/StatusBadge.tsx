import type { ReactNode } from "react";

/**
 * "ran" (red) is also a parked run's TE ESPERA. "native" stays dim, never
 * amber: amber means Tenaza holds the request and you can act on it from
 * here, which is never true for a prompt Tenaza only observes.
 */
export type BadgeTone = "inbox" | "ran" | "wait" | "native";

export interface StatusBadgeProps {
  tone: BadgeTone;
  children: ReactNode;
}

/** Color is never the only signal: the text itself names the status, so the badge reads the same under any color-vision deficiency. */
export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}
