/**
 * The board's own view model (ticket 08): turns a `BoardPayload` plus the
 * CURRENT `now` into exactly what the presentational components render —
 * four columns of cards, already classified and formatted, plus the
 * flattened id order `useBoardKeyboard` walks with j/k. Pure: the same
 * `(payload, now)` pair always builds the same model, with no `Date.now()`
 * inside and no state of its own — `BoardApp` (the container) re-calls this
 * on every `useNow` tick, which is what makes "TIME IS STATE" actually
 * hold: a Session that stopped producing Events re-classifies here even
 * though the SSE payload itself hasn't changed at all.
 */

import { computeContextTrack, formatContextNumber, type ContextTrack } from "../../contextbar";
import { formatAge, projectLabel, sessionColumn, worktreeLabel, type SessionColumn } from "../../board";
import type { ActionSummary, BoardInboxItem, BoardPayload, BoardSession, SessionRole } from "../../contract/live";

/** `label` reuses `formatContextNumber` (`contextbar.ts`) — the SAME "243k" / "⚑243k" / "—" the CLI's `status` tree already shows, so a Session never reads two different numbers in two different places. */
export type ContextDisplay = { kind: "track"; track: ContextTrack; label: string } | { kind: "unavailable" };

export interface InboxCardViewModel {
  id: string;
  project: string;
  /** The `ticket` Label verbatim, or `undefined` when none was ever announced — a card renders NOTHING for it then (human fix round), never a stray "— ". */
  ticket: string | undefined;
  sessionId: string;
  /** The bare tool name ("Bash", or an MCP tool's qualified name) — the card's own dimmed prefix inside its command box. */
  tool: string;
  /** The stored shell command, or `undefined` for an `mcp` Action (it has none) — the card shows the tool name alone then. */
  command: string | undefined;
  /** "tool: command", or the bare tool name — kept for the card's `title` attribute (the full, unclamped text) and for a screen reader's accessible name. */
  toolLabel: string;
  age: string;
  /** Denied and awaiting `run` vs. already ran unenforced (ticket 06, ADR 0001) — read-only in ticket 08, picks the card's badge. */
  blocked: boolean;
  /** Ticket 09: a YA CORRIÓ item (`blocked: false`) and an `mcp` item (no stored command) both offer no `run` — this is the ONE place that rule is computed, so `InboxCard` never re-derives it from `blocked`/`command` separately. */
  offersRun: boolean;
}

export interface SessionCardViewModel {
  id: string;
  project: string;
  /** The worktree this Session runs in (`worktreeLabel`, `src/board.ts`), or `undefined` outside a known worktree layout. */
  worktree: string | undefined;
  /** The `ticket` Label verbatim, or `undefined` when none was ever announced — a card renders NOTHING for it then (human fix round), never a stray "— ". */
  ticket: string | undefined;
  role: SessionRole;
  /** The Session id cut for display (`SHORT_ID_LENGTH`); `id` stays whole for keys, selection and DOM ids. */
  shortId: string;
  /** Ready-to-render "↳ <label>", or `undefined` when this Session has no parent. */
  parentLabel: string | undefined;
  /** True when this card renders right under its parent in the same column (indented). */
  nested: boolean;
  context: ContextDisplay;
  /** "Last signal" (spec's own field): what this Session most recently attempted, or "—" when it never has. */
  lastSignal: string;
  age: string;
}

export interface BoardColumnViewModel<Card> {
  key: string;
  title: string;
  cards: Card[];
}

/** The header's own stat chips (ticket 08's human fix round, decision 04's "stat chips"): plain counts, never re-derived by the header — same rule as everything else here, one pass over the already-classified cards. */
export interface BoardStats {
  teNecesita: number;
  corriendo: number;
  trabada: number;
  /** Sessions at or past the context threshold, EXCLUDING a TERMINÓ card — an ended Session crossing 200k is no longer anyone's problem to watch. */
  over200k: number;
}

export interface BoardViewModel {
  teNecesita: BoardColumnViewModel<InboxCardViewModel>;
  corriendo: BoardColumnViewModel<SessionCardViewModel>;
  trabada: BoardColumnViewModel<SessionCardViewModel>;
  termino: BoardColumnViewModel<SessionCardViewModel>;
  stats: BoardStats;
  /** Every visible card id, TE NECESITA first then CORRIENDO/TRABADA/TERMINÓ, in each column's own display order — the order `useBoardKeyboard`'s j/k walks. */
  orderedIds: string[];
}

/** Spanish for "no data" (ADR 0001) — an Adapter that never declared the `measure` Capability at all, the SAME convention `sessions.ts`'s `NO_MEASURE_CAPABILITY` renders for the CLI tree. Kept as its own literal here rather than importing that module, which would pull its node-builtin-using neighbors into the browser bundle (see `src/board.ts`'s own doc comment). */
export const NO_MEASURE_TEXT = "sin datos";

function contextDisplayFor(session: BoardSession, contextThresholdTokens: number): ContextDisplay {
  if (!session.hasMeasureCapability) return { kind: "unavailable" };
  return {
    kind: "track",
    track: computeContextTrack(session.contextTokens, contextThresholdTokens),
    label: formatContextNumber(session.contextTokens, contextThresholdTokens),
  };
}

/** `item` is anything shaped like an `ActionSummary` — an Inbox row's own `action` field, or a Session's `lastSignal`. The same "tool: command" / bare tool rule either way. */
function toolLabelFor(item: ActionSummary): string {
  return item.command ? `${item.tool}: ${item.command}` : item.tool;
}

function toInboxCard(item: BoardInboxItem, now: Date): InboxCardViewModel {
  return {
    id: item.id,
    project: projectLabel(item.project),
    ticket: item.ticket,
    sessionId: item.sessionId,
    tool: item.action.tool,
    command: item.action.command,
    toolLabel: toolLabelFor(item.action),
    age: formatAge(item.ts, now),
    blocked: item.blocked,
    offersRun: item.blocked && item.action.kind === "shell",
  };
}

/** Display length of a Session id — enough to tell this human's Sessions apart at a glance (the prototype shows short ids); the full id stays in `id`. */
export const SHORT_ID_LENGTH = 8;

function shortSessionId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

/**
 * "↳ <parent>": the parent's ticket when it has one, else its short id —
 * never its role (the human's report, 2026-10-27: "↳ sesión" named nothing,
 * since every top-level Session's role reads "sesión").
 */
function parentLabelFor(session: BoardSession, byId: ReadonlyMap<string, BoardSession>): string | undefined {
  if (session.parentId === undefined) return undefined;
  const parent = byId.get(session.parentId);
  return `↳ ${parent?.ticket ?? shortSessionId(session.parentId)}`;
}

/**
 * A column's Sessions with each subagent right under its parent (spec: "a
 * subagent renders once, under its parent"). Parents keep the column's own
 * order; their children follow in that same order. A child whose parent is
 * not in this column (the parent ended, or stalled while it runs) stays
 * where the column's order puts it, un-nested — its `↳` still names the
 * parent.
 */
function nestUnderParents(list: readonly BoardSession[]): { session: BoardSession; nested: boolean }[] {
  const inColumn = new Set(list.map((session) => session.id));
  const childrenOf = new Map<string, BoardSession[]>();
  for (const session of list) {
    if (session.parentId !== undefined && inColumn.has(session.parentId)) {
      const siblings = childrenOf.get(session.parentId) ?? [];
      siblings.push(session);
      childrenOf.set(session.parentId, siblings);
    }
  }
  const out: { session: BoardSession; nested: boolean }[] = [];
  const emit = (session: BoardSession, nested: boolean): void => {
    out.push({ session, nested });
    for (const child of childrenOf.get(session.id) ?? []) emit(child, true);
  };
  for (const session of list) {
    if (session.parentId === undefined || !inColumn.has(session.parentId)) emit(session, false);
  }
  return out;
}

function toSessionCard(
  session: BoardSession,
  nested: boolean,
  now: Date,
  contextThresholdTokens: number,
  byId: ReadonlyMap<string, BoardSession>,
): SessionCardViewModel {
  return {
    id: session.id,
    shortId: shortSessionId(session.id),
    project: projectLabel(session.project),
    worktree: worktreeLabel(session.project),
    ticket: session.ticket,
    role: session.role,
    parentLabel: parentLabelFor(session, byId),
    nested,
    context: contextDisplayFor(session, contextThresholdTokens),
    lastSignal: session.lastSignal ? toolLabelFor(session.lastSignal) : "—",
    age: formatAge(session.lastEventTs, now),
  };
}

/** Oldest first (spec's own convention for the live cards ticket 10 adds — applied uniformly to today's plain pending cards too, since nothing in 08 says otherwise). */
function byOldestFirst(a: BoardInboxItem, b: BoardInboxItem): number {
  return a.ts.localeCompare(b.ts);
}

/** Freshest activity first within a Session column — a build-time default; the spec names no ordering for CORRIENDO/TRABADA/TERMINÓ. */
function byMostRecentEventFirst(a: BoardSession, b: BoardSession): number {
  return (b.lastEventTs ?? "").localeCompare(a.lastEventTs ?? "");
}

const COLUMN_TITLES = {
  teNecesita: "TE NECESITA",
  corriendo: "CORRIENDO",
  trabada: "TRABADA",
  termino: "TERMINÓ",
} as const;

export function buildBoardViewModel(payload: BoardPayload, now: Date): BoardViewModel {
  const byId = new Map(payload.sessions.map((session) => [session.id, session] as const));

  const inboxCards = [...payload.inbox].sort(byOldestFirst).map((item) => toInboxCard(item, now));

  const sessionsByColumn: Record<SessionColumn, BoardSession[]> = { corriendo: [], trabada: [], termino: [] };
  for (const session of payload.sessions) {
    const column = sessionColumn(session, now, payload.policy.stallMinutes);
    if (!column) continue; // ended past the 24h TERMINÓ window — the board drops the card entirely
    sessionsByColumn[column].push(session);
  }
  for (const list of Object.values(sessionsByColumn)) list.sort(byMostRecentEventFirst);

  const toCards = (list: readonly BoardSession[]): SessionCardViewModel[] =>
    nestUnderParents(list).map(({ session, nested }) =>
      toSessionCard(session, nested, now, payload.policy.contextThresholdTokens, byId),
    );

  const corriendoCards = toCards(sessionsByColumn.corriendo);
  const trabadaCards = toCards(sessionsByColumn.trabada);
  const terminoCards = toCards(sessionsByColumn.termino);

  const isFlagged = (card: SessionCardViewModel): boolean => card.context.kind === "track" && card.context.track.flagged;
  const over200k = corriendoCards.filter(isFlagged).length + trabadaCards.filter(isFlagged).length;

  return {
    teNecesita: { key: "te_necesita", title: COLUMN_TITLES.teNecesita, cards: inboxCards },
    corriendo: { key: "corriendo", title: COLUMN_TITLES.corriendo, cards: corriendoCards },
    trabada: { key: "trabada", title: COLUMN_TITLES.trabada, cards: trabadaCards },
    termino: { key: "termino", title: COLUMN_TITLES.termino, cards: terminoCards },
    stats: { teNecesita: inboxCards.length, corriendo: corriendoCards.length, trabada: trabadaCards.length, over200k },
    orderedIds: [
      ...inboxCards.map((card) => card.id),
      ...corriendoCards.map((card) => card.id),
      ...trabadaCards.map((card) => card.id),
      ...terminoCards.map((card) => card.id),
    ],
  };
}
