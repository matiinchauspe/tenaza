import { useEffect, useState } from "react";
import { moveSelection } from "../../board";

export interface BoardKeyboard {
  selectedId: string | undefined;
  select(id: string): void;
}

/**
 * Each callback is optional and dispatched against whatever is currently selected; this hook
 * stays ignorant of which card kind a key actually applies to — the container decides that.
 *
 * `r` has no callback here: it only focuses the selected card's message input (a no-op if
 * that input isn't mounted). The actual reject fires through `SessionCard`'s own `onReject`
 * prop, never through this hook.
 */
export interface BoardKeyboardActions {
  onDone?(id: string): void;
  onDismiss?(id: string): void;
  onApprove?(id: string, message: string | undefined): void;
  onFocusTerminal?(id: string): void;
  /** `x` fires both this and `onDismiss` for any selection; the container's own gating (Inbox card vs TERMINÓ session) decides which one actually does anything. */
  onArchive?(id: string): void;
  /** Not gated on `selectedId` — toggling the panel has nothing to do with the board's selection. */
  onToggleActivity?(): void;
  /** A dedicated close, not `onToggleActivity` again — a future `Esc` use elsewhere (e.g. clearing a selection) must never re-open this panel. */
  onCloseActivity?(): void;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

/** The contract this hook shares with `InboxCard`/`SessionCard` for a card's DOM id. */
export function boardCardElementId(cardId: string): string {
  return `board-card-${cardId}`;
}

/** Shared with `r`'s focus and `a`'s current-value read, so a card and this hook can never disagree on which input either key means. */
export function liveMessageInputElementId(sessionCardId: string): string {
  return `live-message-${sessionCardId}`;
}

/** Reads straight from the DOM since this hook owns no React state for the draft — `SessionCard` does, as a controlled input. */
function currentLiveMessage(sessionCardId: string): string | undefined {
  const el = document.getElementById(liveMessageInputElementId(sessionCardId));
  if (!(el instanceof HTMLInputElement)) return undefined;
  return el.value.length > 0 ? el.value : undefined;
}

/**
 * `actions` stays a second parameter on this same hook, not a sibling one, since it already
 * tracks `selectedId` in closure — a sibling hook would have to re-derive that state. Default
 * `{}` keeps every existing single-argument call site unaffected.
 *
 * Selection is keyed by id, never index (`moveSelection` re-resolves the index fresh every
 * call), so when the list reshapes under an active selection the effect below snaps to the
 * first remaining id instead of pointing at a card that no longer exists.
 */
export function useBoardKeyboard(
  orderedIds: readonly string[],
  actions: BoardKeyboardActions = {},
): BoardKeyboard {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (selectedId !== undefined && !orderedIds.includes(selectedId)) {
      setSelectedId(orderedIds[0]);
    }
  }, [orderedIds, selectedId]);

  // A real DOM focus move, not just `aria-selected` — what makes the focus-visible ring show,
  // and what a screen reader's listbox semantics expect. No-op if the element isn't mounted yet.
  useEffect(() => {
    if (selectedId === undefined) return;
    document.getElementById(boardCardElementId(selectedId))?.focus();
  }, [selectedId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (isTypingTarget(event.target)) return;
      // Reversed from vim's j/k on purpose: `k` walks forward down a column (then into the
      // next column's first card), `j` walks back.
      if (event.key === "k") {
        setSelectedId((current) => moveSelection(orderedIds, current, 1));
      } else if (event.key === "j") {
        setSelectedId((current) => moveSelection(orderedIds, current, -1));
      } else if (event.key === "d" && selectedId !== undefined) {
        actions.onDone?.(selectedId);
      } else if (event.key === "x" && selectedId !== undefined) {
        actions.onDismiss?.(selectedId);
        actions.onArchive?.(selectedId);
      } else if (event.key === "t" && selectedId !== undefined) {
        actions.onFocusTerminal?.(selectedId);
      } else if (event.key === "a" && selectedId !== undefined) {
        actions.onApprove?.(selectedId, currentLiveMessage(selectedId));
      } else if (event.key === "r" && selectedId !== undefined) {
        document.getElementById(liveMessageInputElementId(selectedId))?.focus();
      } else if (event.key === "l") {
        actions.onToggleActivity?.();
      } else if (event.key === "Escape") {
        actions.onCloseActivity?.();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // `selectedId` is a real dependency here: unlike j/k's functional `setSelectedId` updates,
    // d/x/a/r read the current value directly, so there's no updater form that avoids it.
  }, [orderedIds, selectedId, actions]);

  return { selectedId, select: setSelectedId };
}
