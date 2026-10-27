import { useEffect, useState } from "react";
import { moveSelection } from "../../board";

export interface BoardKeyboard {
  selectedId: string | undefined;
  select(id: string): void;
}

/** Ticket 09's own two keys, dispatched against whatever is CURRENTLY selected — a plain callback per key, `undefined` when the container has nothing to wire it to (e.g. this board has no action cards at all). The container decides WHETHER `selectedId` actually names something `d`/`x` apply to (an Inbox card) — this hook stays ignorant of card kinds, same as it already is for `j`/`k`. */
export interface BoardKeyboardActions {
  onDone?(id: string): void;
  onDismiss?(id: string): void;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

/** The DOM id a card renders under — the one contract between this hook and `InboxCard`/`SessionCard`, so "visible focus" is an ACTUAL roving `tabIndex` + `.focus()` call, not aria-selected alone. */
export function boardCardElementId(cardId: string): string {
  return `board-card-${cardId}`;
}

/**
 * `j`/`k` selection at the board level (ticket 08; ticket 10 adds a
 * message input this must already ignore, so the guard is built now
 * rather than retrofit later — cheap, and avoids a card losing selection
 * the moment someone types "j" into a future input). `d`/`x` (ticket 09)
 * dispatch against whatever is CURRENTLY selected, through `actions` —
 * folded into this SAME hook rather than a second one, because it already
 * tracks `selectedId` in closure; a sibling hook would have to re-derive
 * or duplicate that state. The optional second parameter is purely
 * additive: every existing single-argument call site is unaffected.
 *
 * Selection is keyed by id, never by index (`moveSelection`, `src/board.ts`
 * re-resolves `orderedIds.indexOf(currentId)` fresh every call) — so when
 * the list changes shape under an active selection (a card resolved, a new
 * one arrived), the effect below snaps it to the first remaining id
 * instead of pointing at a card that no longer exists.
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

  // Focus follows selection: a real DOM focus move, not just the
  // `aria-selected` state — this is what makes `:focus-visible`'s ring
  // (tokens.css) actually show up on the selected card for a keyboard
  // user, and what a screen reader's listbox semantics expect. Never
  // throws when the element isn't mounted yet (e.g. the first tick after
  // the payload arrives) — it just does nothing that render.
  useEffect(() => {
    if (selectedId === undefined) return;
    document.getElementById(boardCardElementId(selectedId))?.focus();
  }, [selectedId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (isTypingTarget(event.target)) return;
      if (event.key === "j") {
        setSelectedId((current) => moveSelection(orderedIds, current, 1));
      } else if (event.key === "k") {
        setSelectedId((current) => moveSelection(orderedIds, current, -1));
      } else if (event.key === "d" && selectedId !== undefined) {
        actions.onDone?.(selectedId);
      } else if (event.key === "x" && selectedId !== undefined) {
        actions.onDismiss?.(selectedId);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // `selectedId` must be a real dependency here (unlike j/k's own
    // functional `setSelectedId` updates, which never need to READ it): d/x
    // dispatch against the id AS IT IS NOW, not a moved one, so there is no
    // updater form that avoids needing the current value in closure.
  }, [orderedIds, selectedId, actions]);

  return { selectedId, select: setSelectedId };
}
