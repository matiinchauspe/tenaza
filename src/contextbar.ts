/**
 * `status`'s context bar (spec's variant D, q9/AC3): 15 cells over 300k —
 * 20k per cell — with a `┊` mark at the Policy's threshold cell (default
 * 200k, AC4 moves it) and the cells past the mark in red. The number beside
 * it reads `243k`, or `⚑243k` once the Session is at or past the threshold.
 */

export const BAR_CELLS = 15;
export const TOKENS_PER_CELL = 20_000;

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function clampCell(cell: number): number {
  return Math.max(0, Math.min(BAR_CELLS, cell));
}

/**
 * The bar itself. No sample yet (`tokens === undefined`) renders fully
 * empty — the mark still shows, since the threshold doesn't depend on
 * having a sample. Only the OVER-threshold cells are colored: the ticket
 * names red for the cells, never the whole bar.
 */
export function formatContextBar(tokens: number | undefined, thresholdTokens: number): string {
  const thresholdCell = clampCell(Math.round(thresholdTokens / TOKENS_PER_CELL));
  const afterCells = BAR_CELLS - thresholdCell;
  const filledCell = tokens === undefined ? 0 : clampCell(Math.round(tokens / TOKENS_PER_CELL));

  const beforeFilled = Math.min(filledCell, thresholdCell);
  const overFilled = Math.min(Math.max(filledCell - thresholdCell, 0), afterCells);

  const before = "█".repeat(beforeFilled) + "░".repeat(thresholdCell - beforeFilled);
  const overflow = overFilled > 0 ? `${RED}${"█".repeat(overFilled)}${RESET}` : "";
  const after = overflow + "░".repeat(afterCells - overFilled);

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
  return tokens >= thresholdTokens ? `⚑${k}k` : `${k}k`;
}
