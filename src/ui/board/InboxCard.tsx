import { parseRunOutput } from "../../runoutput";
import { boardCardElementId } from "./useBoardKeyboard";
import { StatusBadge } from "./StatusBadge";
import type { InboxCardViewModel } from "./viewModel";

export interface InboxCardProps {
  card: InboxCardViewModel;
  selected: boolean;
  onSelect: (id: string) => void;
  /** Ticket 09: whether THIS card's `run` is currently streaming — disables the button and swaps its label, never a second independent loading flag the card would have to own itself. */
  running: boolean;
  /** The combined stdout+stderr captured so far for this card's own `run`, if it has ever started one in this tab — `undefined` (never rendered) until the first byte arrives. A trailing failure trailer (`runoutput.ts`), if present, is parsed OUT and styled separately — never shown as plain output text. */
  output: string | undefined;
  /** Review fix: a short es-AR message for the LAST non-ok, non-403 response any write for THIS item got (a 409 refusal, a 404 because it was resolved elsewhere, …) — `useInboxActions` owns deciding when this is set; the card only ever renders it. `undefined` when the last write (if any) succeeded. */
  errorMessage: string | undefined;
  onRun: (id: string) => void;
  onDone: (id: string) => void;
  onDismiss: (id: string) => void;
  /** Ticket 11: "from any card" — already bound to the OWNING Session's id by `Board`, so this card never needs to know it. */
  onFocusTerminal: () => void;
}

/**
 * Cosmetic-only, display-side truncation of `card.id` for the card's own
 * "#…" meta chip (visual bug found while verifying this fix round against
 * the prototype screenshot: `BoardInboxItem.id` is the FULL sha1 identity
 * hash, decision 03/ADR 0005 — 40 hex characters — and rendering it whole
 * blew the top row out past the card's width, wrapping mid-word). This is
 * NOT `identity.ts`'s own shortest-unique-prefix convention (`shortHashAt`)
 * — that needs the FULL population of ids to compute a collision-safe
 * length, server-only (it imports `node:crypto`, which must never reach
 * this browser-bundled component — `board.ts`'s own "zero imports"
 * doc comments explain why). The full id is always one hover away via
 * `title`; ticket 09, wiring real run/listo/descartar calls, is free to
 * thread a server-computed short id through instead if it needs one that
 * is provably unique, not just visually short.
 */
const ID_DISPLAY_LENGTH = 8;

/** Stop a click on an action button from ALSO firing the `<li>`'s own `onClick` (select) — selecting the card you just acted on is harmless either way, but suppressing the bubble keeps the click's effect legible to one thing at a time. */
function stopCardSelect(event: { stopPropagation(): void }): void {
  event.stopPropagation();
}

/**
 * A pending Inbox item's card (ticket 08 read-only; ticket 09 adds its
 * run/listo/descartar buttons and keys `d`/`x` over this SAME card). Pure
 * presentational: props in, callbacks out, no fetching of its own — every
 * write goes through the callbacks the container (`BoardApp`, via
 * `useInboxActions`) supplies. `aria-selected` carries the keyboard
 * selection non-visually; the roving `tabIndex` (0 only when selected) is
 * what lets `useBoardKeyboard` actually move DOM focus here, so the
 * visible focus ring (tokens.css) and a screen reader's listbox semantics
 * both follow j/k, not just the ARIA attribute.
 *
 * Restyled per the approved prototype's action card (human fix round): the
 * command sits in its own box (`inbox-card__cmd`), clamped to 3 lines
 * (`tokens.css`) so a 40-line heredoc never balloons the card — the full
 * text is always one hover away (`title`, native tooltip) and, selected,
 * the clamp lifts so the whole thing reads inline. Ticket 08 never carried
 * a live (awaiting-approval) item — the contract has no `kind` to tell one
 * apart from a plain pending row yet (ticket 10) — so every card here uses
 * the prototype's dimmer "inbox" left border, never its amber "live" one.
 *
 * The buttons and the YA CORRIÓ note below are ported literally from the
 * prototype's own action card (`PROTOTYPE-live-surface-BC.ts`'s
 * `actionCard`): `▶ tenaza run` only when `card.offersRun`, `listo`/
 * `descartar` always, each with its own `kbd`, and — for an item the
 * Adapter could never actually block — the SAME es-AR note instead of a
 * `run` button, never an invented one.
 *
 * Ticket 10 (BC2's own `pendingCard`, "Requests vs agents"): every card
 * HERE is now a REQUEST, never a waiting agent — a live hold renders on
 * its own Session's card instead (`SessionCard`'s `LiveRequestBlock`). The
 * top row reads "pedido de &lt;project&gt; · #&lt;id&gt;" rather than
 * showing the raw `sessionId` text; selecting the card cross-highlights
 * that Session's own card elsewhere on the board (`BoardApp`'s
 * `highlightedSessionId`), which is how the two stay visually linked now.
 *
 * Two DISTINCT failure surfaces, both review fixes, both red
 * (`inbox-card__output-error`, the prototype's own `--red`) but never
 * conflated: `output`'s own trailing failure trailer (`run` STARTED and
 * the command itself exited non-zero — "stays open WITH THE ERROR", spec)
 * vs. `errorMessage` (a write call — `run`, `done`, `dismiss` or `focus`
 * alike — was REFUSED outright, nothing ever ran). Either, both, or
 * neither can be present on a given card at once; each renders in its own
 * slot.
 *
 * Ticket 11: "from any card" — a terminal button rides alongside
 * listo/descartar, labeled and (for "terminal desconocida") disabled
 * straight off the already-formatted `card.terminalLabel`
 * (`viewModel.ts`'s `terminalLabelFor`) — this card never re-derives the
 * wording or re-checks the reach itself.
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
        <button
          type="button"
          className="btn"
          disabled={card.terminalReach === "unknown"}
          title={card.terminalNeedsTcc ? "macOS va a pedir permiso" : undefined}
          onClick={(event) => {
            stopCardSelect(event);
            onFocusTerminal();
          }}
        >
          {card.terminalLabel} <kbd>t</kbd>
        </button>
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
