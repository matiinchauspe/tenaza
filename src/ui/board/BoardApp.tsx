import { Board } from "./Board";
import { LiveDot } from "./LiveDot";
import { useBoardKeyboard } from "./useBoardKeyboard";
import { useDocumentTitle } from "./useDocumentTitle";
import { useEventSource } from "./useEventSource";
import { useNow } from "./useNow";
import { buildBoardViewModel, type BoardStats } from "./viewModel";

const EVENTS_URL = "/events";

/** The header's stat chips (prototype's `.stats`, decision 04's human fix round) — a plain count label, es-AR. `hot` (ticket 09/human-visible urgency) highlights TE NECESITA once it's non-zero, the SAME condition the tab title already uses. */
const STAT_LABELS: { key: keyof BoardStats; label: string; hot?: boolean }[] = [
  { key: "teNecesita", label: "TE NECESITAN", hot: true },
  { key: "corriendo", label: "CORRIENDO" },
  { key: "trabada", label: "TRABADAS" },
  { key: "over200k", label: ">200K" },
];

/**
 * The board feature's container (ticket 08): owns everything with an
 * effect or state — the SSE connection, the ticking clock, keyboard
 * selection, the tab title — and hands `Board` a plain, already-classified
 * view model plus the current selection. `Board` and everything under it
 * stay pure presentational.
 *
 * Header (restyled per the approved prototype, human fix round): the
 * `⚒ TENAZA` wordmark, the stat chips, and the live dot — no sim menu, no
 * activity feed (ticket 09/10's own territory, out of scope here). The
 * footer keybar shows ONLY the keys ticket 08 actually wires (`j`/`k`) —
 * the prototype's `a r d x t` belong to later tickets.
 */
export function BoardApp() {
  const { payload, connectionState } = useEventSource(EVENTS_URL);
  const now = useNow();
  const viewModel = payload ? buildBoardViewModel(payload, now) : undefined;
  const orderedIds = viewModel?.orderedIds ?? [];
  const { selectedId, select } = useBoardKeyboard(orderedIds);

  useDocumentTitle(viewModel?.teNecesita.cards.length ?? 0);

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__logo">
          ⚒ TENA<span className="app__logo-accent">Z</span>A
        </span>
        {viewModel && (
          <div className="app__stats">
            {STAT_LABELS.map(({ key, label, hot }) => {
              const value = viewModel.stats[key];
              return (
                <span key={key} className={`app__stat${hot && value > 0 ? " app__stat--hot" : ""}`}>
                  <b>{value}</b>
                  {label}
                </span>
              );
            })}
          </div>
        )}
        <div className="app__right">
          <LiveDot connectionState={connectionState} />
        </div>
      </header>
      {viewModel ? (
        <Board viewModel={viewModel} selectedId={selectedId} onSelect={select} />
      ) : (
        <p className="app__loading">conectando con el Daemon…</p>
      )}
      <footer className="app__footer">
        <span className="app__key">
          <kbd>j</kbd>
          <kbd>k</kbd> mover
        </span>
      </footer>
    </div>
  );
}
