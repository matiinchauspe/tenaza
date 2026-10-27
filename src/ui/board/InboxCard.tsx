import { boardCardElementId } from "./useBoardKeyboard";
import { StatusBadge } from "./StatusBadge";
import type { InboxCardViewModel } from "./viewModel";

export interface InboxCardProps {
  card: InboxCardViewModel;
  selected: boolean;
  onSelect: (id: string) => void;
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

/**
 * A pending Inbox item's card (ticket 08 — read-only; ticket 09 adds
 * run/listo/descartar over this SAME card). Pure presentational: props in,
 * markup out, no fetching, no global state. `aria-selected` carries the
 * keyboard selection non-visually; the roving `tabIndex` (0 only when
 * selected) is what lets `useBoardKeyboard` actually move DOM focus here,
 * so the visible focus ring (tokens.css) and a screen reader's listbox
 * semantics both follow j/k, not just the ARIA attribute.
 *
 * Restyled per the approved prototype's action card (human fix round): the
 * command sits in its own box (`inbox-card__cmd`), clamped to 3 lines
 * (`tokens.css`) so a 40-line heredoc never balloons the card — the full
 * text is always one hover away (`title`, native tooltip) and, selected,
 * the clamp lifts so the whole thing reads inline. Ticket 08 never carries
 * a live (awaiting-approval) item — the contract has no `kind` to tell one
 * apart from a plain pending row yet (ticket 10) — so every card here uses
 * the prototype's dimmer "inbox" left border, never its amber "live" one.
 */
export function InboxCard({ card, selected, onSelect }: InboxCardProps) {
  return (
    <li
      id={boardCardElementId(card.id)}
      className={`card inbox-card${selected ? " card--selected" : ""}`}
      role="option"
      aria-selected={selected}
      aria-label={`${card.blocked ? "Inbox" : "Ya corrió"}: ${card.project}${card.ticket ? ` ${card.ticket}` : ""}, ${card.toolLabel}`}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(card.id)}
    >
      <div className="inbox-card__top">
        <StatusBadge tone={card.blocked ? "inbox" : "ran"}>{card.blocked ? "Inbox" : "Ya corrió"}</StatusBadge>
        <span className="inbox-card__id" title={card.id}>
          #{card.id.slice(0, ID_DISPLAY_LENGTH)}
        </span>
        <span className="inbox-card__project">{card.project}</span>
        {card.ticket && <span className="inbox-card__ticket">{card.ticket}</span>}
        <span className="inbox-card__session">· {card.sessionId}</span>
        <span className="inbox-card__when">hace {card.age}</span>
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
    </li>
  );
}
