import { useState } from "react";
import { ActivityPanel } from "./ActivityPanel";
import { Board } from "./Board";
import { LiveDot } from "./LiveDot";
import { TenazaMark } from "./TenazaMark";
import { ToastStack } from "./ToastStack";
import { useActivityFeed } from "./useActivityFeed";
import { useBoardKeyboard } from "./useBoardKeyboard";
import { useDocumentTitle } from "./useDocumentTitle";
import { useEventSource } from "./useEventSource";
import { useInboxActions } from "./useInboxActions";
import { useNow } from "./useNow";
import { buildBoardViewModel, highlightedSessionId, resolveBoardKeyAction, type BoardStats } from "./viewModel";

const EVENTS_URL = "/events";

/** `hot` highlights TE NECESITA once it's non-zero — the same condition the tab title already uses. */
const STAT_LABELS: { key: keyof BoardStats; label: string; hot?: boolean }[] = [
  { key: "teNecesita", label: "TE NECESITAN", hot: true },
  { key: "corriendo", label: "CORRIENDO" },
  { key: "trabada", label: "TRABADAS" },
  { key: "over200k", label: ">200K" },
];

const STALE_TOKEN_MESSAGE =
  "la sesión con el Daemon venció (se reinició) — volvé a abrir la vista (tenaza ui o /tenaza) para poder correr, marcar listo o descartar.";

/**
 * Owns everything with an effect or state — the SSE connection, the ticking clock, keyboard
 * selection, the tab title, and every write an action card makes — and hands `Board` a plain,
 * already-classified view model plus the current selection and the action state. `Board` and
 * everything under it stay pure presentational.
 *
 * `d`/`x`/`a`/`t` each dispatch against whatever `resolveBoardKeyAction` resolves for the
 * current selection — this container holds no card-kind lookup of its own.
 */
export function BoardApp() {
  const { payload, connectionState } = useEventSource(EVENTS_URL);
  const now = useNow();
  const viewModel = payload ? buildBoardViewModel(payload, now) : undefined;
  const orderedIds = viewModel?.orderedIds ?? [];
  const actions = useInboxActions();
  const [activityOpen, setActivityOpen] = useState(false);
  const activityFeed = useActivityFeed(payload, now);

  const { selectedId, select } = useBoardKeyboard(orderedIds, {
    onDone: (id) => {
      const resolved = viewModel && resolveBoardKeyAction(viewModel, id, "d");
      if (resolved?.kind === "done") actions.done(resolved.id);
    },
    onDismiss: (id) => {
      const resolved = viewModel && resolveBoardKeyAction(viewModel, id, "x");
      if (resolved?.kind === "dismiss") actions.dismiss(resolved.id);
    },
    onApprove: (id, message) => {
      const resolved = viewModel && resolveBoardKeyAction(viewModel, id, "a");
      if (resolved?.kind === "answer") actions.approve(resolved.id, message);
    },
    onFocusTerminal: (id) => {
      const resolved = viewModel && resolveBoardKeyAction(viewModel, id, "t");
      if (resolved?.kind === "focusTerminal") actions.focusTerminal(resolved.id);
    },
    onArchive: (id) => {
      const resolved = viewModel && resolveBoardKeyAction(viewModel, id, "x");
      if (resolved?.kind === "archive") actions.archive(resolved.id);
    },
    onToggleActivity: () => setActivityOpen((open) => !open),
    onCloseActivity: () => setActivityOpen(false),
  });
  const highlightedId = viewModel ? highlightedSessionId(viewModel, selectedId) : undefined;

  // `stats.teNecesita`, never `teNecesita.cards.length` alone, which only ever holds the
  // pending half.
  useDocumentTitle(viewModel?.stats.teNecesita ?? 0);

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__logo">
          <TenazaMark />
          TENA<span className="app__logo-accent">Z</span>A
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
          <kbd>j</kbd> atrás
        </span>
        <span className="app__key">
          <kbd>k</kbd> adelante
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
        <span className="app__key">
          <kbd>l</kbd> actividad
        </span>
      </footer>
      <ActivityPanel open={activityOpen} entries={activityFeed} />
      <ToastStack toasts={actions.toasts} />
    </div>
  );
}
