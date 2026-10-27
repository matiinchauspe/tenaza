import { Board } from "./Board";
import { LiveDot } from "./LiveDot";
import { ToastStack } from "./ToastStack";
import { useBoardKeyboard } from "./useBoardKeyboard";
import { useDocumentTitle } from "./useDocumentTitle";
import { useEventSource } from "./useEventSource";
import { useInboxActions } from "./useInboxActions";
import { useNow } from "./useNow";
import { buildBoardViewModel, highlightedSessionId, sessionIdForCard, type BoardStats } from "./viewModel";

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
 * activity feed. The footer keybar shows the keys wired so far — `j`/`k`
 * (ticket 08), `d`/`x` (ticket 09), `a`/`r` (ticket 10), now `t` (go to
 * terminal) and `x`'s second job (archive a TERMINÓ card, ticket 11).
 *
 * `d`/`x` only ever dispatch against an id this render actually knows is
 * an Inbox card (`inboxIds`, below); `a` only ever dispatches against a
 * Session card that actually carries a `liveRequest` right now
 * (`liveRequestSessionIds`) — `useBoardKeyboard` itself stays ignorant of
 * card kinds, so every one of these gates is this container's to draw,
 * never the hook's. `r` carries no gate at all: it only ever focuses a
 * message input that may or may not exist (see that hook's own doc).
 */
export function BoardApp() {
  const { payload, connectionState } = useEventSource(EVENTS_URL);
  const now = useNow();
  const viewModel = payload ? buildBoardViewModel(payload, now) : undefined;
  const orderedIds = viewModel?.orderedIds ?? [];
  const actions = useInboxActions();

  const inboxIds = new Set(viewModel?.teNecesita.cards.map((card) => card.id) ?? []);
  const liveRequestSessionIds = new Set(
    [...(viewModel?.corriendo.cards ?? []), ...(viewModel?.trabada.cards ?? []), ...(viewModel?.termino.cards ?? [])]
      .filter((card) => card.liveRequest)
      .map((card) => card.id),
  );
  // Ticket 11: `x` archives ONLY a TERMINÓ Session card — "x on any other
  // Session card does nothing" (ticket), enforced here the SAME way
  // `inboxIds` already gates `onDismiss`: a set this render actually knows
  // is the TERMINÓ column's own cards, never CORRIENDO/TRABADA.
  const terminoSessionIds = new Set(viewModel?.termino.cards.map((card) => card.id) ?? []);
  const { selectedId, select } = useBoardKeyboard(orderedIds, {
    onDone: (id) => {
      if (inboxIds.has(id)) actions.done(id);
    },
    onDismiss: (id) => {
      if (inboxIds.has(id)) actions.dismiss(id);
    },
    onApprove: (id, message) => {
      if (liveRequestSessionIds.has(id)) actions.approve(id, message);
    },
    onFocusTerminal: (id) => {
      if (!viewModel) return;
      const sessionId = sessionIdForCard(viewModel, id);
      if (sessionId) actions.focusTerminal(sessionId);
    },
    onArchive: (id) => {
      if (terminoSessionIds.has(id)) actions.archive(id);
    },
  });
  const highlightedId = viewModel ? highlightedSessionId(viewModel, selectedId) : undefined;

  // Ticket 10: "the (n) Tenaza tab title count live + pending" (spec) — `stats.teNecesita`, never `teNecesita.cards.length` alone, which only ever holds the pending half now.
  useDocumentTitle(viewModel?.stats.teNecesita ?? 0);

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
          highlightedSessionId={highlightedId}
          runningIds={actions.runningIds}
          outputs={actions.outputs}
          errors={actions.errors}
          onRun={actions.run}
          onDone={actions.done}
          onDismiss={actions.dismiss}
          onApprove={actions.approve}
          onReject={actions.reject}
          onFocusTerminal={actions.focusTerminal}
          onArchive={actions.archive}
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
          <kbd>a</kbd> aprobar
        </span>
        <span className="app__key">
          <kbd>r</kbd> rechazar
        </span>
        <span className="app__key">
          <kbd>d</kbd> listo
        </span>
        <span className="app__key">
          <kbd>x</kbd> descartar / archivar
        </span>
        <span className="app__key">
          <kbd>t</kbd> terminal
        </span>
      </footer>
      <ToastStack toasts={actions.toasts} />
    </div>
  );
}
