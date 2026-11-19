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
 * `role="status"` + `aria-live="polite"` give the state a non-visual channel — a dot color
 * alone would be invisible to a screen reader, and the label is always rendered regardless.
 * `prefers-reduced-motion` is handled by the stylesheet's own global rule, not this component.
 */
export function LiveDot({ connectionState }: LiveDotProps) {
  return (
    <span className={`live-dot live-dot--${connectionState}`} role="status" aria-live="polite">
      <span className="live-dot__dot" aria-hidden="true" />
      <span className="live-dot__label">{LABEL[connectionState]}</span>
    </span>
  );
}
