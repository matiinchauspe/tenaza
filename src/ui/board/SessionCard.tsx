import { useState } from "react";
import { ContextTrack } from "./ContextTrack";
import type { ColumnTone } from "./Column";
import { StatusBadge } from "./StatusBadge";
import { boardCardElementId, liveMessageInputElementId } from "./useBoardKeyboard";
import type { SessionCardViewModel } from "./viewModel";

export interface SessionCardProps {
  card: SessionCardViewModel;
  tone: ColumnTone;
  statusLabel: string;
  selected: boolean;
  /** Ticket 10: true when a SEPARATE, selected TE NECESITA card names THIS Session as its own — the spec's own cross-highlight ("selecting it highlights that Session's card"). Never true at the same time as `selected` carries the live-request outline; the two are visually distinct (`session-card--highlighted` vs `card--selected`). */
  highlighted: boolean;
  onSelect: (id: string) => void;
  /** Ticket 10: fires the live request's own approve/reject — `message` is whatever `SessionCard`'s own local draft currently holds. `undefined` (never called) when `card.liveRequest` is itself `undefined`. */
  onApprove: (id: string, message: string | undefined) => void;
  onReject: (id: string, message: string | undefined) => void;
}

/** Stop a click inside the live-request block from ALSO firing the card's own `onClick` (select) — same convention `InboxCard`'s own `stopCardSelect` already uses. */
function stopCardSelect(event: { stopPropagation(): void }): void {
  event.stopPropagation();
}

/**
 * Ticket 10: the TE ESPERA block docked on a Session's own card while its
 * agent is held, live (spec "Requests vs agents" — never a TE NECESITA
 * card of its own). Owns a small local draft of the message input's text —
 * "props in, callbacks out" still holds (`onApprove`/`onReject` are the
 * only way anything leaves this component), a plain controlled input is
 * not a fetch. `r` (the board-level shortcut, `useBoardKeyboard`) focuses
 * THIS input by its own id (`liveMessageInputElementId`); `a` reads its
 * CURRENT value straight from the DOM rather than through React state,
 * since the keyboard hook holds no state of its own for a per-card draft —
 * see that hook's own doc for why.
 */
function LiveRequestBlock({
  sessionId,
  liveRequest,
  onApprove,
  onReject,
}: {
  sessionId: string;
  liveRequest: NonNullable<SessionCardViewModel["liveRequest"]>;
  onApprove: (id: string, message: string | undefined) => void;
  onReject: (id: string, message: string | undefined) => void;
}) {
  const [message, setMessage] = useState("");
  const trimmed = message.trim();
  const draft = trimmed.length > 0 ? trimmed : undefined;

  return (
    <div className="live-request" onClick={stopCardSelect}>
      <div className="live-request__top">
        <StatusBadge tone="wait">TE ESPERA · {liveRequest.remainingSeconds}s</StatusBadge>
        <span className="live-request__when">hace {liveRequest.age}</span>
      </div>
      <div className="live-request__cmd" title={liveRequest.toolLabel}>
        <span className="live-request__prompt" aria-hidden="true">
          $
        </span>
        {liveRequest.command !== undefined ? (
          <>
            <span className="live-request__tool">{liveRequest.tool}</span>
            {liveRequest.command}
          </>
        ) : (
          liveRequest.tool
        )}
      </div>
      <div className="live-request__timer">
        <i style={{ width: `${liveRequest.remainingFraction * 100}%` }} />
      </div>
      <div className="live-request__acts">
        <input
          id={liveMessageInputElementId(sessionId)}
          className="live-request__input"
          placeholder="mensaje para el agente…"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            // Enter fires REJECT with whatever is typed (spec's own worked
            // example types a reason before rejecting); Escape just blurs.
            // `a`/`r`/`j`/`k` typed here are never board shortcuts at all —
            // `useBoardKeyboard`'s own `isTypingTarget` guard already
            // ignores every key while this input has focus.
            if (event.key === "Enter") {
              onReject(liveRequest.id, draft);
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          className="btn btn--no"
          onClick={() => onReject(liveRequest.id, draft)}
        >
          rechazar <kbd>r</kbd>
        </button>
        <button
          type="button"
          className="btn btn--ok"
          onClick={() => onApprove(liveRequest.id, draft)}
        >
          aprobar <kbd>a</kbd>
        </button>
      </div>
    </div>
  );
}

/** The resolution trace's own line (spec "Requests vs agents") — composed straight from the already-resolved view-model fields, never re-deriving wording here. */
function ResolutionTrace({ trace }: { trace: NonNullable<SessionCardViewModel["resolutionTrace"]> }) {
  return (
    <div className={`resolution-trace resolution-trace--${trace.latest.tone}`} title={trace.moreCount > 0 ? trace.tooltip : undefined}>
      {trace.latest.symbol} #{trace.latest.shortId} {trace.latest.text} · hace {trace.latest.age}
      {trace.moreCount > 0 && <span className="resolution-trace__more"> · +{trace.moreCount} más</span>}
    </div>
  );
}

/**
 * A Session's card — CORRIENDO, TRABADA or TERMINÓ (ticket 08, restyled per
 * the approved prototype; ticket 10 adds the TE ESPERA block, the
 * resolution trace, and the cross-highlight). No uppercase `StatusBadge`
 * here: the prototype signals a Session's state with a small colored dot
 * in `l1` instead — the column it sits in already names that state in
 * text (its header), so the dot is reinforcement, not the only signal.
 * `aria-label` on the `<li>` itself is the non-visual channel that still
 * carries the status word, same accessibility bar the badge used to
 * satisfy. A TERMINÓ card reads at reduced opacity
 * (`session-card--termino`, prototype's `.ended`).
 */
export function SessionCard({ card, tone, statusLabel, selected, highlighted, onSelect, onApprove, onReject }: SessionCardProps) {
  const ariaLabel = `${statusLabel}: ${card.project}${card.ticket ? ` ${card.ticket}` : ""}${card.liveRequest ? ", te espera" : ""}`;
  return (
    <li
      id={boardCardElementId(card.id)}
      className={`card session-card session-card--${tone}${card.nested ? " session-card--nested" : ""}${selected ? " card--selected" : ""}${highlighted ? " session-card--highlighted" : ""}${card.liveRequest ? " session-card--waiting" : ""}`}
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
        {card.worktree ? ` · ${card.worktree}` : ""} · <span title={card.id}>{card.shortId}</span>
        {card.parentLabel ? ` · ${card.parentLabel}` : ""}
      </div>
      {card.resolutionTrace && <ResolutionTrace trace={card.resolutionTrace} />}
      <div className="session-card__signal" title={card.lastSignal}>
        {card.lastSignal}
      </div>
      <ContextTrack display={card.context} />
      {card.liveRequest && (
        <LiveRequestBlock sessionId={card.id} liveRequest={card.liveRequest} onApprove={onApprove} onReject={onReject} />
      )}
    </li>
  );
}
