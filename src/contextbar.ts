/**
 * Zero imports — the Live surface's React client bundles this file
 * directly, so no node builtin can leak in.
 */

export const BAR_CELLS = 15;
export const TOKENS_PER_CELL = 20_000;

/** The one "needs you" red, shared with `statusline.ts`'s "degradado" mark so the line never shows two different reds for the same meaning. */
export const RED = "\x1b[31m";
export const RESET = "\x1b[0m";

/** The one green for "up and reachable", shared with `statusline.ts`'s Daemon-heartbeat dot. */
export const GREEN = "\x1b[32m";

function clampCell(cell: number): number {
  return Math.max(0, Math.min(BAR_CELLS, cell));
}

/** Cell math only, no presentation: `beforeFilled + beforeEmpty` sums to `thresholdCell`, `overFilled + overEmpty` sums to `BAR_CELLS - thresholdCell`. */
export interface ContextTrack {
  cells: number;
  thresholdCell: number;
  beforeFilled: number;
  beforeEmpty: number;
  overFilled: number;
  overEmpty: number;
  /** `tokens >= thresholdTokens` (not `>`) — a session exactly at the threshold already counts as flagged. */
  flagged: boolean;
  /** No sample (`tokens` undefined) still shows the mark; flagged is always false then. */
  hasSample: boolean;
}

/** Cell math only, no ANSI or DOM — also used by the board's `ContextTrack` component (src/ui/board) so the two renderers can't disagree on where the mark sits. */
export function computeContextTrack(tokens: number | undefined, thresholdTokens: number): ContextTrack {
  const thresholdCell = clampCell(Math.round(thresholdTokens / TOKENS_PER_CELL));
  const afterCells = BAR_CELLS - thresholdCell;
  const filledCell = tokens === undefined ? 0 : clampCell(Math.round(tokens / TOKENS_PER_CELL));

  const beforeFilled = Math.min(filledCell, thresholdCell);
  const overFilled = Math.min(Math.max(filledCell - thresholdCell, 0), afterCells);

  return {
    cells: BAR_CELLS,
    thresholdCell,
    beforeFilled,
    beforeEmpty: thresholdCell - beforeFilled,
    overFilled,
    overEmpty: afterCells - overFilled,
    flagged: tokens !== undefined && tokens >= thresholdTokens,
    hasSample: tokens !== undefined,
  };
}

export function formatContextBar(tokens: number | undefined, thresholdTokens: number): string {
  const track = computeContextTrack(tokens, thresholdTokens);

  const before = "█".repeat(track.beforeFilled) + "░".repeat(track.beforeEmpty);
  const overflow = track.overFilled > 0 ? `${RED}${"█".repeat(track.overFilled)}${RESET}` : "";
  const after = overflow + "░".repeat(track.overEmpty);

  return `${before}┊${after}`;
}

export function formatContextNumber(tokens: number | undefined, thresholdTokens: number): string {
  if (tokens === undefined) return "—";
  const k = Math.round(tokens / 1000);
  const track = computeContextTrack(tokens, thresholdTokens);
  return track.flagged ? `⚑${k}k` : `${k}k`;
}
