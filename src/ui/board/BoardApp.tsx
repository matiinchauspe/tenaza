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
 * `TENAZA` wordmark beside the official mark (`TenazaMark`, ticket 12 —
 * the `⚒` placeholder glyph it replaces), the stat chips, and the live
 * dot — no sim menu, no activity feed of its own here (ticket 12 adds a
 * SEPARATE one, the `l`-toggled `ActivityPanel`, below). The footer
 * keybar shows the keys wired so far — `j`/`k` (ticket 08), `d`/`x`
 * (ticket 09), `a`/`r` (ticket 10), now `t` (go to
 * terminal) and `x`'s second job (archive a TERMINÓ card, ticket 11).
 *
 * Deepening ticket 04: `d`/`x`/`a`/`t` each dispatch against whatever
 * `resolveBoardKeyAction` (`viewModel.ts`) resolves for the current
 * selection — this container holds no card-kind lookup of its own any
 * more (no `inboxIds`, no `terminoSessionIds`, no
 * `liveRequestItemIdBySessionId`; `a`'s old bug — forwarding the
 * Session's id instead of the live item's own — is now structurally
 * impossible, since the resolver's own `id` field already IS the right
 * one to dispatch). `useBoardKeyboard` itself stays ignorant of card
 * kinds, same as before this ticket. `r` carries no gate at all: it only
 * ever focuses a message input that may or may not exist (see that
 * hook's own doc).
 */
export function BoardApp() {
  const { payload, connectionState } = useEventSource(EVENTS_URL);
  const now = useNow();
  const viewModel = payload ? buildBoardViewModel(payload, now) : undefined;
  const orderedIds = viewModel?.orderedIds ?? [];
  const actions = useInboxActions();
  // Ticket 12: closed by default (spec "Activity panel (l)") — `l`
  // toggles it, `Esc` always closes it, neither gated on a selection.
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

  // Ticket 10: "the (n) Tenaza tab title count live + pending" (spec) — `stats.teNecesita`, never `teNecesita.cards.length` alone, which only ever holds the pending half now.
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
