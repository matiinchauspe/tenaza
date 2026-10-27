import type { ConnectionState } from "./useEventSource";

export interface LiveDotProps {
  connectionState: ConnectionState;
}

const LABEL: Record<ConnectionState, string> = {
  open: "en vivo",
  connecting: "conectando",
  closed: "desconectado",
};

/**
 * The SSE connection indicator (ticket 08, decision 04). `role="status"` +
 * `aria-live="polite"` give the state a non-visual channel too — a dot
 * color alone would be invisible to a screen reader AND, per the
 * accessibility bar, color is never the only signal here either way: the
 * label is always rendered, dot or no dot. Respects
 * `prefers-reduced-motion` through the stylesheet's own global rule, not
 * anything this component does itself.
 */
export function LiveDot({ connectionState }: LiveDotProps) {
  return (
    <span className={`live-dot live-dot--${connectionState}`} role="status" aria-live="polite">
      <span className="live-dot__dot" aria-hidden="true" />
      <span className="live-dot__label">{LABEL[connectionState]}</span>
    </span>
  );
}
