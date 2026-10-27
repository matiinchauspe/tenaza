import { Board } from "./Board";
import { LiveDot } from "./LiveDot";
import { useBoardKeyboard } from "./useBoardKeyboard";
import { useDocumentTitle } from "./useDocumentTitle";
import { useEventSource } from "./useEventSource";
import { useInboxActions } from "./useInboxActions";
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

/** Decision 05: the write token rotates every Daemon launch — a tab left open across a restart carries a stale cookie and gets 403 on every write. es-AR, clear, never a silent failure (ticket 09's own note). */
const STALE_TOKEN_MESSAGE =
  "la sesión con el Daemon venció (se reinició) — volvé a abrir la vista (tenaza ui o /tenaza) para poder correr, marcar listo o descartar.";

/**
 * The board feature's container (ticket 08, extended by ticket 09): owns
 * everything with an effect or state — the SSE connection, the ticking
 * clock, keyboard selection, the tab title, and now every write an action
 * card makes (`useInboxActions`) — and hands `Board` a plain,
 * already-classified view model plus the current selection and the action
 * state. `Board` and everything under it stay pure presentational.
 *
 * Header (restyled per the approved prototype, human fix round): the
 * `⚒ TENAZA` wordmark, the stat chips, and the live dot — no sim menu, no
 * activity feed (ticket 10's own territory, out of scope here). The
 * footer keybar shows the keys wired so far — `j`/`k` (ticket 08), now
 * `d`/`x` (ticket 09) — the prototype's `a`/`r`/`t` belong to later
 * tickets.
 *
 * `d`/`x` only ever dispatch against an id this render actually knows is
 * an Inbox card (`inboxIds`, below) — `useBoardKeyboard` itself stays
 * ignorant of card kinds, so this gate is this container's to draw, never
 * the hook's.
 */
export function BoardApp() {
  const { payload, connectionState } = useEventSource(EVENTS_URL);
  const now = useNow();
  const viewModel = payload ? buildBoardViewModel(payload, now) : undefined;
  const orderedIds = viewModel?.orderedIds ?? [];
  const actions = useInboxActions();

  const inboxIds = new Set(viewModel?.teNecesita.cards.map((card) => card.id) ?? []);
  const { selectedId, select } = useBoardKeyboard(orderedIds, {
    onDone: (id) => {
      if (inboxIds.has(id)) actions.done(id);
    },
    onDismiss: (id) => {
      if (inboxIds.has(id)) actions.dismiss(id);
    },
  });

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
      {actions.staleToken && <div className="app__stale-banner">{STALE_TOKEN_MESSAGE}</div>}
      {viewModel ? (
        <Board
          viewModel={viewModel}
          selectedId={selectedId}
          onSelect={select}
          runningIds={actions.runningIds}
          outputs={actions.outputs}
          errors={actions.errors}
          onRun={actions.run}
          onDone={actions.done}
          onDismiss={actions.dismiss}
        />
      ) : (
        <p className="app__loading">conectando con el Daemon…</p>
      )}
      <footer className="app__footer">
        <span className="app__key">
          <kbd>j</kbd>
          <kbd>k</kbd> mover
        </span>
        <span className="app__key">
          <kbd>d</kbd> listo
        </span>
        <span className="app__key">
          <kbd>x</kbd> descartar
        </span>
      </footer>
    </div>
  );
}
