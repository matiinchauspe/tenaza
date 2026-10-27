import { NO_MEASURE_TEXT, type ContextDisplay } from "./viewModel";

export interface ContextTrackProps {
  display: ContextDisplay;
}

/**
 * The context track (ticket 08, q9/AC3/AC4; restyled per the approved
 * prototype's human fix round): a thin continuous 3px bar — not the old
 * discrete 15-cell run — with a 1px amber mark at the Policy's threshold
 * and the overflow past it in red. The percentages below are derived from
 * `computeContextTrack`'s own CELL counts (`contextbar.ts`), never a
 * second, independent "tokens / max" formula: `cells` is always the SAME
 * `BAR_CELLS` the CLI's ANSI bar divides by, so a Session can never show
 * two different fills in two different places, only two different
 * renderers of the identical fraction.
 *
 * `role="img"` + `aria-label` carry the whole thing (fill, mark position,
 * flagged) as text for a screen reader; the visible `label` text (`243k` /
 * `⚑243k`) means color is never the only signal here either.
 */
export function ContextTrack({ display }: ContextTrackProps) {
  if (display.kind === "unavailable") {
    return (
      <span className="context-track context-track--unavailable" aria-label={`contexto: ${NO_MEASURE_TEXT}`}>
        {NO_MEASURE_TEXT}
      </span>
    );
  }

  const { track, label } = display;
  const ariaLabel = `contexto ${label}${track.flagged ? ", por encima del umbral" : ""}`;
  const markPercent = (track.thresholdCell / track.cells) * 100;
  const fillPercent = (track.beforeFilled / track.cells) * 100;
  const overPercent = (track.overFilled / track.cells) * 100;

  return (
    <span className="context-track" role="img" aria-label={ariaLabel}>
      <span className="context-track__bar">
        <span className="context-track__fill" style={{ width: `${fillPercent}%` }} />
        {track.overFilled > 0 && (
          <span className="context-track__over" style={{ left: `${markPercent}%`, width: `${overPercent}%` }} />
        )}
        <span className="context-track__mark" style={{ left: `${markPercent}%` }} aria-hidden="true" />
      </span>
      <span className={`context-track__label${track.flagged ? " context-track__label--over" : ""}`}>{label}</span>
    </span>
  );
}
