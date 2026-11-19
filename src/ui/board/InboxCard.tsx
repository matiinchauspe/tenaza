import { parseRunOutput } from "../../runoutput";
import { boardCardElementId } from "./useBoardKeyboard";
import { StatusBadge } from "./StatusBadge";
import type { InboxCardViewModel } from "./viewModel";

export interface InboxCardProps {
  card: InboxCardViewModel;
  selected: boolean;
  onSelect: (id: string) => void;
  /** Disables the button and swaps its label — never a second independent loading flag the card would have to own itself. */
  running: boolean;
  /** `undefined` until the first byte arrives. A trailing failure trailer, if present, is parsed out and styled separately — never shown as plain output text. */
  output: string | undefined;
  /** `useInboxActions` owns deciding when this is set; the card only ever renders it. `undefined` when the last write (if any) succeeded. */
  errorMessage: string | undefined;
  onRun: (id: string) => void;
  onDone: (id: string) => void;
  onDismiss: (id: string) => void;
  /** Already bound to the owning Session's id by `Board`, so this card never needs to know it. */
  onFocusTerminal: () => void;
}

/** Cosmetic-only — not a collision-safe shortest-unique-prefix. The full id is always one hover away via `title`. */
const ID_DISPLAY_LENGTH = 8;

/** Keeps a click's effect legible to one thing at a time — selecting the card you just acted on would be harmless, but this stops it from happening silently alongside the real action. */
function stopCardSelect(event: { stopPropagation(): void }): void {
  event.stopPropagation();
}

/**
 * Pure presentational: props in, callbacks out — every write goes through the callbacks
 * `BoardApp` supplies. The roving `tabIndex` (0 only when selected) is what lets
 * `useBoardKeyboard` move DOM focus here, so the focus ring and a screen reader's listbox
 * semantics both follow j/k, not just `aria-selected`.
 *
 * The command is clamped to a few lines so a long heredoc never balloons the card — the full
 * text is always one hover away via `title`, and the clamp lifts when selected.
 *
 * Every card here is a request, never a waiting agent — a live hold renders on its own
 * Session's card instead. Selecting a card cross-highlights that Session's own card elsewhere
 * on the board.
 *
 * Two distinct failure surfaces, both rendered the same red, never conflated: `output`'s own
 * trailing failure trailer (`run` started and the command itself exited non-zero) vs.
 * `errorMessage` (a write call was refused outright, nothing ever ran). Either, both, or
 * neither can be present on a given card at once.
 *
 * No terminal button at all for an unknown reach — never a disabled placeholder — so
 * listo/descartar sit alone with no empty slot left behind.
 */
export function InboxCard({
  card,
  selected,
  onSelect,
  running,
  output,
  errorMessage,
  onRun,
  onDone,
  onDismiss,
  onFocusTerminal,
}: InboxCardProps) {
  const parsedOutput = output !== undefined && output.length > 0 ? parseRunOutput(output) : undefined;

  return (
    <li
      id={boardCardElementId(card.id)}
      className={`card inbox-card${selected ? " card--selected" : ""}`}
      role="option"
      aria-selected={selected}
      aria-label={`pedido ${card.blocked ? "pendiente" : "ya corrió"}: ${card.project}${card.ticket ? ` ${card.ticket}` : ""}, ${card.toolLabel}`}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(card.id)}
    >
      <div className="inbox-card__top">
        <StatusBadge tone={card.blocked ? "inbox" : "ran"}>{card.blocked ? "Pendiente" : "Ya corrió"}</StatusBadge>
        <span className="inbox-card__when">hace {card.age}</span>
      </div>
      <div className="inbox-card__req">
        pedido de <span className="inbox-card__project">{card.project}</span> ·{" "}
        <span className="inbox-card__id" title={card.id}>
          #{card.id.slice(0, ID_DISPLAY_LENGTH)}
        </span>
        {card.ticket && <span className="inbox-card__ticket">{card.ticket}</span>}
      </div>
      <div className="inbox-card__cmd" title={card.toolLabel}>
        <span className="inbox-card__cmd-text">
          <span className="inbox-card__prompt" aria-hidden="true">$</span>
          {card.command !== undefined ? (
            <>
              <span className="inbox-card__tool">{card.tool}</span>
              {card.command}
            </>
          ) : (
            card.tool
          )}
        </span>
      </div>
      <div className="inbox-card__acts">
        {card.offersRun && (
          <button
            type="button"
            className="btn"
            disabled={running}
            onClick={(event) => {
              stopCardSelect(event);
              onRun(card.id);
            }}
          >
            {running ? "corriendo…" : "▶ tenaza run"}
          </button>
        )}
        <button
          type="button"
          className="btn"
          onClick={(event) => {
            stopCardSelect(event);
            onDone(card.id);
          }}
        >
          listo <kbd>d</kbd>
        </button>
        <button
          type="button"
          className="btn"
          onClick={(event) => {
            stopCardSelect(event);
            onDismiss(card.id);
          }}
        >
          descartar <kbd>x</kbd>
        </button>
        {card.terminalReach !== "unknown" && (
          <button
            type="button"
            className="btn"
            title={card.terminalNeedsTcc ? "macOS va a pedir permiso" : undefined}
            onClick={(event) => {
              stopCardSelect(event);
              onFocusTerminal();
            }}
          >
            {card.terminalLabel} <kbd>t</kbd>
          </button>
        )}
      </div>
      {parsedOutput && parsedOutput.body.length > 0 && (
        <pre className="inbox-card__output">{parsedOutput.body}</pre>
      )}
      {parsedOutput?.error && <div className="inbox-card__output-error">{parsedOutput.error}</div>}
      {errorMessage && <div className="inbox-card__output-error">{errorMessage}</div>}
      {!card.blocked && (
        <div className="inbox-card__note">
          el adapter no pudo frenarlo — quedó registrado, no lo vuelvas a correr
        </div>
      )}
    </li>
  );
}
