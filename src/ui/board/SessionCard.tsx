import { ContextTrack } from "./ContextTrack";
import type { ColumnTone } from "./Column";
import { boardCardElementId } from "./useBoardKeyboard";
import type { SessionCardViewModel } from "./viewModel";

export interface SessionCardProps {
  card: SessionCardViewModel;
  tone: ColumnTone;
  statusLabel: string;
  selected: boolean;
  onSelect: (id: string) => void;
}

/**
 * A Session's card — CORRIENDO, TRABADA or TERMINÓ (ticket 08, restyled per
 * the approved prototype). No uppercase `StatusBadge` here: the prototype
 * signals a Session's state with a small colored dot in `l1` instead — the
 * column it sits in already names that state in text (its header), so the
 * dot is reinforcement, not the only signal. `aria-label` on the `<li>`
 * itself is the non-visual channel that still carries the status word,
 * same accessibility bar the badge used to satisfy. A TERMINÓ card reads
 * at reduced opacity (`session-card--termino`, prototype's `.ended`).
 */
export function SessionCard({ card, tone, statusLabel, selected, onSelect }: SessionCardProps) {
  const ariaLabel = `${statusLabel}: ${card.project}${card.ticket ? ` ${card.ticket}` : ""}`;
  return (
    <li
      id={boardCardElementId(card.id)}
      className={`card session-card session-card--${tone}${selected ? " card--selected" : ""}`}
      role="option"
      aria-selected={selected}
      aria-label={ariaLabel}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(card.id)}
    >
      <div className="session-card__l1">
        <span className={`session-card__dot session-card__dot--${tone}`} aria-hidden="true" />
        <span className="session-card__project">{card.project}</span>
        {card.ticket && <span className="session-card__ticket">{card.ticket}</span>}
        <span className="session-card__age">{card.age}</span>
      </div>
      <div className="session-card__l2">
        {card.role}
        {card.worktree ? ` · ${card.worktree}` : ""} · {card.id}
        {card.parentLabel ? ` · ${card.parentLabel}` : ""}
      </div>
      <div className="session-card__signal" title={card.lastSignal}>
        {card.lastSignal}
      </div>
      <ContextTrack display={card.context} />
    </li>
  );
}
