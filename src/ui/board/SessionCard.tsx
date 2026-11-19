import { useState } from "react";
import { ContextTrack } from "./ContextTrack";
import type { ColumnTone } from "./Column";
import { StatusBadge, type BadgeTone } from "./StatusBadge";
import { boardCardElementId, liveMessageInputElementId } from "./useBoardKeyboard";
import type { SessionCardViewModel, VerdictBadgeKind } from "./viewModel";

export interface SessionCardProps {
  card: SessionCardViewModel;
  tone: ColumnTone;
  statusLabel: string;
  selected: boolean;
  /** True when a separate, selected TE NECESITA card names this Session as its own. Visually distinct from `selected` — the two can differ. */
  highlighted: boolean;
  onSelect: (id: string) => void;
  /** `message` is whatever this card's own local draft currently holds. Never called when `card.liveRequest` is `undefined`. */
  onApprove: (id: string, message: string | undefined) => void;
  onReject: (id: string, message: string | undefined) => void;
  /** Already bound to this Session's own id by `Board`. */
  onFocusTerminal: () => void;
  /** Set by `Board`'s own gate — this component never checks its own column. */
  showArchive: boolean;
  onArchive: () => void;
}

function stopCardSelect(event: { stopPropagation(): void }): void {
  event.stopPropagation();
}

/**
 * Owns a small local draft of the message input — a controlled input is not a fetch, so
 * "props in, callbacks out" still holds. `r` focuses this input by its own id; `a` reads its
 * current value straight from the DOM rather than through React state.
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
            // Enter fires reject with whatever is typed; Escape just blurs. Keys typed here
            // are never board shortcuts — `useBoardKeyboard`'s `isTypingTarget` guard already
            // ignores them while this input has focus.
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

/** Deliberately no approve/reject, no message input, no draining bar — unlike `LiveRequestBlock`, Tenaza never raised this and can never answer it on the agent's behalf. */
function NativeWaitBlock({ nativeWait }: { nativeWait: NonNullable<SessionCardViewModel["nativeWait"]> }) {
  return (
    <div className="native-wait" title={nativeWait.hint}>
      <StatusBadge tone="native">{nativeWait.label}</StatusBadge>
      <span className="native-wait__when">hace {nativeWait.age}</span>
    </div>
  );
}

/** Reuses the same muted "native" tone as `NativeWaitBlock` — Tenaza observes here too, and never owns a window it could act from. */
function TurnWaitBlock({ turnWait }: { turnWait: NonNullable<SessionCardViewModel["turnWait"]> }) {
  return (
    <div className="turn-wait">
      <StatusBadge tone="native">
        ESPERÁNDOTE{turnWait.backgroundCount > 0 ? ` · ${turnWait.backgroundCount} en segundo plano` : ""}
      </StatusBadge>
      <span className="turn-wait__when">hace {turnWait.age}</span>
    </div>
  );
}

/** No new color for either verdict. */
const VERDICT_BADGE_TONE: Record<VerdictBadgeKind, BadgeTone> = {
  parked: "ran",
  checkpoint: "inbox",
};

function VerdictBadge({ verdictBadge }: { verdictBadge: NonNullable<SessionCardViewModel["verdictBadge"]> }) {
  return (
    <div className="verdict-badge">
      <StatusBadge tone={VERDICT_BADGE_TONE[verdictBadge.kind]}>{verdictBadge.label}</StatusBadge>
    </div>
  );
}

/** Composed straight from the already-resolved view-model fields, never re-deriving wording here. */
function ResolutionTrace({ trace }: { trace: NonNullable<SessionCardViewModel["resolutionTrace"]> }) {
  return (
    <div className={`resolution-trace resolution-trace--${trace.latest.tone}`} title={trace.moreCount > 0 ? trace.tooltip : undefined}>
      {trace.latest.symbol} #{trace.latest.shortId} {trace.latest.text} · hace {trace.latest.age}
      {trace.moreCount > 0 && <span className="resolution-trace__more"> · +{trace.moreCount} más</span>}
    </div>
  );
}

/**
 * A TERMINÓ card offers archivar instead of the terminal button: the agent is gone, and once
 * a closed window reads as TERMINÓ, so is the terminal it ran in — the same reason an unknown
 * terminal reach renders no button either.
 *
 * No uppercase `StatusBadge` for the card's own state: a small colored dot in `l1` is
 * reinforcement, not the only signal, since the column it sits in already names that state in
 * text. `aria-label` on the `<li>` itself carries the status word non-visually.
 */
export function SessionCard({
  card,
  tone,
  statusLabel,
  selected,
  highlighted,
  onSelect,
  onApprove,
  onReject,
  onFocusTerminal,
  showArchive,
  onArchive,
}: SessionCardProps) {
  const ariaLabel = `${statusLabel}: ${card.project}${card.ticket ? ` ${card.ticket}` : ""}${card.verdictBadge ? `, ${card.verdictBadge.label.toLowerCase()}` : ""}${card.liveRequest ? ", te espera" : ""}${card.nativeWait ? `, ${card.nativeWait.label.toLowerCase()}` : ""}${card.turnWait ? `, esperándote${card.turnWait.backgroundCount > 0 ? ` · ${card.turnWait.backgroundCount} en segundo plano` : ""}` : ""}`;
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
      {card.verdictBadge && <VerdictBadge verdictBadge={card.verdictBadge} />}
      {card.nativeWait && <NativeWaitBlock nativeWait={card.nativeWait} />}
      {card.turnWait && <TurnWaitBlock turnWait={card.turnWait} />}
      {card.resolutionTrace && <ResolutionTrace trace={card.resolutionTrace} />}
      <div className="session-card__signal" title={card.lastSignal}>
        {card.lastSignal}
      </div>
      <ContextTrack display={card.context} />
      <div className="session-card__actions" onClick={stopCardSelect}>
        {!showArchive && card.terminalReach !== "unknown" && (
          <button
            type="button"
            className="btn"
            title={card.terminalNeedsTcc ? "macOS va a pedir permiso" : undefined}
            onClick={onFocusTerminal}
          >
            {card.terminalLabel} <kbd>t</kbd>
          </button>
        )}
        {showArchive && (
          <button type="button" className="btn" onClick={onArchive}>
            archivar <kbd>x</kbd>
          </button>
        )}
      </div>
      {card.liveRequest && (
        <LiveRequestBlock sessionId={card.id} liveRequest={card.liveRequest} onApprove={onApprove} onReject={onReject} />
      )}
    </li>
  );
}
