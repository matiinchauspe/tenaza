import { useEffect, useState } from "react";
import { moveSelection } from "../../board";

export interface BoardKeyboard {
  selectedId: string | undefined;
  select(id: string): void;
}

/**
 * Ticket 09's own two keys (`d`/`x`), plus ticket 10's `a` — dispatched
 * against whatever is CURRENTLY selected — a plain callback per key,
 * `undefined` when the container has nothing to wire it to (e.g. this
 * board has no action cards at all). The container decides WHETHER
 * `selectedId` actually names something the key applies to (an Inbox card
 * for `d`/`x`, a Session card with a live request for `a`) — this hook
 * stays ignorant of card kinds, same as it already is for `j`/`k`.
 *
 * `r` carries NO callback here at all (ticket 10): it only ever FOCUSES the
 * selected card's own message input (`liveMessageInputElementId`), a pure
 * DOM move with no network effect — a no-op when that element doesn't
 * exist (a selection with no live request). Firing the actual reject comes
 * from the input's own `Enter` key or the card's `rechazar` button, both
 * wired directly to `SessionCard`'s own `onReject` prop, never through this
 * hook.
 */
export interface BoardKeyboardActions {
  onDone?(id: string): void;
  onDismiss?(id: string): void;
  onApprove?(id: string, message: string | undefined): void;
  /** Ticket 11: "ir a terminal ↗" / key `t` — dispatched against whatever is selected, same "the container decides whether it applies" convention `onDone`/`onDismiss` already establish (this hook stays ignorant of card kinds and of terminal reach). */
  onFocusTerminal?(id: string): void;
  /** Ticket 11: `x` on a selected TERMINÓ Session card — folded onto the SAME key `onDismiss` already owns (below), never a new keybinding: the container's own gating (is this id an Inbox card, or a TERMINÓ Session card) is what makes exactly one of the two actually fire for any given selection. */
  onArchive?(id: string): void;
  /** Ticket 12: `l` toggles the activity panel — never gated on `selectedId` (it has nothing to do with the board's selection), so it fires whenever this hook's own `isTypingTarget` guard allows it through, same as every other key here. */
  onToggleActivity?(): void;
  /** Ticket 12: `Esc` closes the activity panel — a dedicated close rather than a second meaning folded onto `onToggleActivity`, since a future `Esc` use (e.g. clearing a selection) must never also toggle this panel back OPEN. */
  onCloseActivity?(): void;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

/** The DOM id a card renders under — the one contract between this hook and `InboxCard`/`SessionCard`, so "visible focus" is an ACTUAL roving `tabIndex` + `.focus()` call, not aria-selected alone. */
export function boardCardElementId(cardId: string): string {
  return `board-card-${cardId}`;
}

/** Ticket 10: the DOM id a Session card's own live-request message input renders under — `r` focuses this directly; `a`'s own current-value read (below) goes through the SAME id, so a card and this hook can never disagree on which input either key means. */
export function liveMessageInputElementId(sessionCardId: string): string {
  return `live-message-${sessionCardId}`;
}

/** The message input's own CURRENT value for `sessionCardId`, read straight from the DOM — `a` needs it at the INSTANT the key fires, and this hook owns no React state of its own for a per-card draft (`SessionCard` does, as a plain controlled input). `undefined` for an empty value, never an empty string, and `undefined` outright when no such input is even mounted (a selection with no live request). */
function currentLiveMessage(sessionCardId: string): string | undefined {
  const el = document.getElementById(liveMessageInputElementId(sessionCardId));
  if (!(el instanceof HTMLInputElement)) return undefined;
  return el.value.length > 0 ? el.value : undefined;
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
      // `k` forward, `j` back — the human's call (2026-10-27), deliberately the
      // reverse of vim's j-down/k-up and of the prototype: forward walks down a
      // column, then on to the first card of the column to its right.
      if (event.key === "k") {
        setSelectedId((current) => moveSelection(orderedIds, current, 1));
      } else if (event.key === "j") {
        setSelectedId((current) => moveSelection(orderedIds, current, -1));
      } else if (event.key === "d" && selectedId !== undefined) {
        actions.onDone?.(selectedId);
      } else if (event.key === "x" && selectedId !== undefined) {
        // Ticket 11: `x` now serves TWO cards — "descartar" on a pending
        // Inbox card (unchanged since ticket 09), "archivar" on a TERMINÓ
        // Session card (new). Both callbacks fire; each container-level
        // wrapper gates on whether `selectedId` actually names ITS own
        // kind of card, so only one ever does anything for a given
        // selection — see `BoardKeyboardActions.onArchive`'s own doc.
        actions.onDismiss?.(selectedId);
        actions.onArchive?.(selectedId);
      } else if (event.key === "t" && selectedId !== undefined) {
        actions.onFocusTerminal?.(selectedId);
      } else if (event.key === "a" && selectedId !== undefined) {
        actions.onApprove?.(selectedId, currentLiveMessage(selectedId));
      } else if (event.key === "r" && selectedId !== undefined) {
        // No callback, no network effect — see `BoardKeyboardActions`'s own
        // doc. A no-op when the selected card carries no live request at
        // all (nothing to focus).
        document.getElementById(liveMessageInputElementId(selectedId))?.focus();
      } else if (event.key === "l") {
        actions.onToggleActivity?.();
      } else if (event.key === "Escape") {
        actions.onCloseActivity?.();
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
