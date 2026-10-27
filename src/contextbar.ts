/**
 * `status`'s context bar (spec's variant D, q9/AC3): 15 cells over 300k —
 * 20k per cell — with a `┊` mark at the Policy's threshold cell (default
 * 200k, AC4 moves it) and the cells past the mark in red. The number beside
 * it reads `243k`, or `⚑243k` once the Session is at or past the threshold.
 *
 * Zero imports, on purpose (ticket 08): the Live surface's React client
 * bundles this SAME module directly — no node builtin anywhere in this
 * file, so Bun's browser bundler never has to shim one. `computeContextTrack`
 * is the one piece of math every renderer (this file's own ANSI strings for
 * the CLI, and the web's `ContextTrack` component for the board) builds on,
 * so a terminal row and a board card can never disagree about which cell
 * the 200k mark sits in.
 */

export const BAR_CELLS = 15;
export const TOKENS_PER_CELL = 20_000;

/** The one "needs you" red the line uses — reused by `statusline.ts`'s own "degradado" mark (ADR 0007, ticket 02) so the statusline never shows two different reds for two different urgencies. */
export const RED = "\x1b[31m";
export const RESET = "\x1b[0m";

function clampCell(cell: number): number {
  return Math.max(0, Math.min(BAR_CELLS, cell));
}

/**
 * The structured shape every context-track renderer builds from — the
 * cell math alone, with no presentation baked in. `beforeFilled` +
 * `beforeEmpty` always sum to `thresholdCell`; `overFilled` + `overEmpty`
 * always sum to `BAR_CELLS - thresholdCell`. A renderer draws
 * `beforeFilled` filled cells, `beforeEmpty` empty ones, the `┊` mark,
 * then `overFilled` (in the "needs you" color) and `overEmpty`.
 */
export interface ContextTrack {
  cells: number;
  thresholdCell: number;
  beforeFilled: number;
  beforeEmpty: number;
  overFilled: number;
  overEmpty: number;
  /** `tokens >= thresholdTokens` — matches the Flag's own ">=" (a Session exactly on the line is already Flagged). */
  flagged: boolean;
  /** `undefined` tokens reads as "no sample yet" — the bar still shows the mark, flagged is always false. */
  hasSample: boolean;
}

/**
 * The cell math alone (ticket 08): where the mark sits, how many cells are
 * filled before and after it, and whether `tokens` is flagged — everything
 * a renderer needs, in neither ANSI nor DOM terms. `formatContextBar` and
 * `formatContextNumber` below are now thin ANSI renderers over this; the
 * web board's `ContextTrack` component (src/ui/board) is the other one.
 */
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

/**
 * The bar itself. No sample yet (`tokens === undefined`) renders fully
 * empty — the mark still shows, since the threshold doesn't depend on
 * having a sample. Only the OVER-threshold cells are colored: the ticket
 * names red for the cells, never the whole bar.
 */
export function formatContextBar(tokens: number | undefined, thresholdTokens: number): string {
  const track = computeContextTrack(tokens, thresholdTokens);

  const before = "█".repeat(track.beforeFilled) + "░".repeat(track.beforeEmpty);
  const overflow = track.overFilled > 0 ? `${RED}${"█".repeat(track.overFilled)}${RESET}` : "";
  const after = overflow + "░".repeat(track.overEmpty);

  return `${before}┊${after}`;
}

/**
 * The bar's companion number: `243k`, or `⚑243k` once `tokens` is AT OR PAST
 * `thresholdTokens` — matching the Flag's own ">=" (a Session exactly on the
 * line is already Flagged). No sample yet reads `—`, the same "nothing
 * known yet" convention `formatAge` already uses (sessions.ts).
 */
export function formatContextNumber(tokens: number | undefined, thresholdTokens: number): string {
  if (tokens === undefined) return "—";
  const k = Math.round(tokens / 1000);
  const track = computeContextTrack(tokens, thresholdTokens);
  return track.flagged ? `⚑${k}k` : `${k}k`;
}
