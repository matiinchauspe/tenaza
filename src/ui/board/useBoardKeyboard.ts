import { useEffect, useState } from "react";
import { moveSelection } from "../../board";

export interface BoardKeyboard {
  selectedId: string | undefined;
  select(id: string): void;
}

function isTypingTarget(target: EventTarget | null): boolean {
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
 * the moment someone types "j" into a future input).
 *
 * Selection is keyed by id, never by index (`moveSelection`, `src/board.ts`
 * re-resolves `orderedIds.indexOf(currentId)` fresh every call) — so when
 * the list changes shape under an active selection (a card resolved, a new
 * one arrived), the effect below snaps it to the first remaining id
 * instead of pointing at a card that no longer exists.
 */
export function useBoardKeyboard(orderedIds: readonly string[]): BoardKeyboard {
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
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [orderedIds]);

  return { selectedId, select: setSelectedId };
}
