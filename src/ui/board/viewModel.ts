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
import {
  formatAge,
  liveItemPhase,
  liveWaitRemainingFraction,
  projectLabel,
  sessionColumn,
  worktreeLabel,
  type SessionColumn,
} from "../../board";
import type {
  ActionSummary,
  BoardInboxItem,
  BoardPayload,
  BoardSession,
  NativeWaitKind,
  ResolutionTraceEntry,
  SessionRole,
  TerminalReach,
} from "../../contract/live";

/**
 * Ticket 11 (decision 09): "Label by reach: 'ir a terminal ↗', 'abrir <App>
 * ↗', greyed 'terminal desconocida'" (ticket). The ONE place this wording
 * is picked, for both card kinds — `SessionCard`/`InboxCard` only ever
 * render whatever this returns, never re-deriving it.
 */
export function terminalLabelFor(reach: TerminalReach, appLabel: string | undefined): string {
  if (reach === "exact") return "ir a terminal ↗";
  if (reach === "app") return `abrir ${appLabel ?? "la terminal"} ↗`;
  return "terminal desconocida";
}

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
  /** Ticket 11: "from any card" (spec) — the OWNING Session's own terminal button, already formatted (`terminalLabelFor`). */
  terminalLabel: string;
  terminalReach: TerminalReach;
  terminalNeedsTcc: boolean;
}

/**
 * Ticket 10: the TE ESPERA block a Session's own card grows while its
 * agent is held, live — the spec's own "command, a draining wait bar, a
 * message input, rechazar/aprobar". `id` is the item's FULL identity hash,
 * what the view's `answer` write (`a`/`r`, or the buttons) posts back
 * against — never shown on the badge itself (the prototype's own layout
 * carries no id here at all, unlike a pending TE NECESITA card).
 */
export interface LiveRequestViewModel {
  id: string;
  tool: string;
  command: string | undefined;
  toolLabel: string;
  /** "hace Ns" since the hold began. */
  age: string;
  /** Seconds left before the window lapses — the badge's own "TE ESPERA · Ns". Never negative. */
  remainingSeconds: number;
  /** 0..1, how much of the draining bar is still filled. */
  remainingFraction: number;
}

/**
 * Ticket 14: the plain, non-actionable block a Session's own card grows
 * while Claude Code's OWN permission/idle prompt is the most recent thing
 * observed for it — never a Tenaza hold (contrast `LiveRequestViewModel`
 * above, which carries `remainingSeconds`/`remainingFraction` for its OWN
 * draining window and an `id` the view can post an answer against). There
 * is no window Tenaza owns here, no command to show (Claude Code's own
 * `Notification` payload carries none), and no answer Tenaza can send —
 * `SessionCard` renders this with no aprobar/rechazar, no message input,
 * no draining bar: only a badge plus the age, so pressing `a`/`r` on a
 * card showing this never does anything it looks like it should.
 */
export interface NativeWaitViewModel {
  kind: NativeWaitKind;
  /** The badge's own es-AR text, already picked (`NATIVE_WAIT_LABEL`) — "PERMISO NATIVO" or "INACTIVA". */
  label: string;
  /** The badge's own `title` tooltip, spelling out that Tenaza only observes this. */
  hint: string;
  /** "hace Ns" since the notification was observed. */
  age: string;
}

/** One line of a Session's resolution trace (spec "Requests vs agents") — already resolved to its es-AR symbol/text/tone; `SessionCard` only ever composes these into the final "✓ #<id> <text> · hace <age>" string, never re-derives the wording itself. */
export interface ResolutionTraceLineViewModel {
  symbol: "✓" | "✕" | "✗";
  /**
   * Cosmetic-only display id (same convention `InboxCard`'s own
   * `ID_DISPLAY_LENGTH` truncation already uses for `card.id` — NOT a
   * collision-safe shortest-unique-prefix: that needs the full population
   * of every id ever assigned, computed server-side with `node:crypto`
   * (`identity.ts`), which must never reach this browser bundle). The
   * full hash stays one hover away via the trace's own tooltip text.
   */
  shortId: string;
  text: string;
  tone: "ok" | "muted" | "reject" | "fail";
  age: string;
}

export interface ResolutionTraceViewModel {
  latest: ResolutionTraceLineViewModel;
  /** How many OLDER resolutions exist beyond `latest` — 0 renders no "+N más" at all. */
  moreCount: number;
  /** Every resolution, newest first, one per line — the trace's own `title` tooltip when `moreCount > 0`. */
  tooltip: string;
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
  /** Ticket 10: present while this Session's agent is held, waiting on a live answer — `undefined` for every other card, including one whose hold already lapsed to pending (that item renders in TE NECESITA instead, same payload row, classified by `liveItemPhase`). */
  liveRequest: LiveRequestViewModel | undefined;
  /** Ticket 10: this Session's own resolution trace, or `undefined` when it never raised a request. */
  resolutionTrace: ResolutionTraceViewModel | undefined;
  /** Ticket 11: this Session's own (or, for a subagent, its parent's) terminal button, already formatted. */
  terminalLabel: string;
  terminalReach: TerminalReach;
  terminalNeedsTcc: boolean;
  /**
   * Ticket 14: present while Claude Code's OWN native permission/idle
   * prompt is the most recent thing observed for this Session — `undefined`
   * for every other card. NEVER conflated with `liveRequest` above: that
   * one is a Tenaza `human` Rule hold this VIEW can itself approve/reject;
   * this one is pure observation — the card offers only "ir a terminal ↗"
   * for it, never aprobar/rechazar, since Tenaza never raised it and can
   * never answer it on the agent's behalf.
   */
  nativeWait: NativeWaitViewModel | undefined;
}

export interface BoardColumnViewModel<Card> {
  key: string;
  title: string;
  cards: Card[];
}

/** The header's own stat chips (ticket 08's human fix round, decision 04's "stat chips"): plain counts, never re-derived by the header — same rule as everything else here, one pass over the already-classified cards. */
export interface BoardStats {
  /** Ticket 10: "the TE NECESITAN stat chip... count live + pending" (spec) — the TOTAL of every currently-live request PLUS every plain pending one, even though the TE NECESITA COLUMN itself only ever lists the pending half (`teNecesita.cards`). */
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
    terminalLabel: terminalLabelFor(item.terminalReach, item.terminalAppLabel),
    terminalReach: item.terminalReach,
    terminalNeedsTcc: item.terminalNeedsTcc,
  };
}

/** Ticket 10: a still-live held item's own TE ESPERA block, docked on its Session's card — never shown on a TE NECESITA card at all (`buildBoardViewModel` routes a live-phase "held" row here instead of through `toInboxCard`). */
function toLiveRequest(item: BoardInboxItem, now: Date, waitSeconds: number): LiveRequestViewModel {
  const elapsedMs = now.getTime() - new Date(item.ts).getTime();
  const remainingSeconds = Math.max(0, Math.round((waitSeconds * 1000 - elapsedMs) / 1000));
  return {
    id: item.id,
    tool: item.action.tool,
    command: item.action.command,
    toolLabel: toolLabelFor(item.action),
    age: formatAge(item.ts, now),
    remainingSeconds,
    remainingFraction: liveWaitRemainingFraction(item.ts, now, waitSeconds),
  };
}

/** Ticket 14's own es-AR wording for each native-wait kind — the ONE place either string is picked, so `SessionCard` never re-derives or duplicates this copy (same convention `traceInfo` below already follows for the resolution trace). */
const NATIVE_WAIT_LABEL: Record<NativeWaitKind, string> = {
  permission_prompt: "PERMISO NATIVO",
  idle_prompt: "INACTIVA",
};

/** The badge's own tooltip — spells out, in es-AR, that Tenaza only observes this (never answers it) and names where to actually act. */
const NATIVE_WAIT_HINT: Record<NativeWaitKind, string> = {
  permission_prompt: "Claude Code te pide permiso — Tenaza solo observa, contestale en la terminal",
  idle_prompt: "el turno terminó y nadie respondió — Tenaza solo observa, contestale en la terminal",
};

function toNativeWait(nativeWait: BoardSession["nativeWait"], now: Date): NativeWaitViewModel | undefined {
  if (!nativeWait) return undefined;
  return {
    kind: nativeWait.kind,
    label: NATIVE_WAIT_LABEL[nativeWait.kind],
    hint: NATIVE_WAIT_HINT[nativeWait.kind],
    age: formatAge(nativeWait.since, now),
  };
}

/** Display truncation only (see `ResolutionTraceLineViewModel.shortId`'s own doc) — never a collision-safe shortest-unique-prefix. */
const TRACE_ID_DISPLAY_LENGTH = 4;

/** The resolution trace's own es-AR wording (spec "Requests vs agents") — the ONE place every kind maps to its symbol/text/tone, so `SessionCard` never re-derives or duplicates this copy. */
function traceInfo(entry: ResolutionTraceEntry): { symbol: ResolutionTraceLineViewModel["symbol"]; text: string; tone: ResolutionTraceLineViewModel["tone"] } {
  switch (entry.kind) {
    case "ran":
      return { symbol: "✓", text: "corrido por vos", tone: "ok" };
    case "done":
      return { symbol: "✓", text: "cerrado como listo", tone: "muted" };
    case "dismissed":
      return { symbol: "✕", text: "descartado", tone: "reject" };
    case "failed":
      return { symbol: "✗", text: `falló (código ${entry.exitCode ?? "?"})`, tone: "fail" };
    case "approved":
      return { symbol: "✓", text: "aprobado", tone: "ok" };
    case "rejected":
      return { symbol: "✕", text: "rechazado", tone: "reject" };
  }
}

function toTraceLine(entry: ResolutionTraceEntry, now: Date): ResolutionTraceLineViewModel {
  const info = traceInfo(entry);
  return {
    symbol: info.symbol,
    text: info.text,
    tone: info.tone,
    shortId: entry.id.slice(0, TRACE_ID_DISPLAY_LENGTH),
    age: formatAge(entry.ts, now),
  };
}

/** `resolutions` arrives newest-first (`inbox.ts`'s `deriveResolutionTraceBySession`) — never re-sorted here. `undefined` when the Session never raised a request, so `SessionCard` renders nothing rather than an empty trace line. */
function toResolutionTrace(resolutions: readonly ResolutionTraceEntry[], now: Date): ResolutionTraceViewModel | undefined {
  const [latestEntry, ...rest] = resolutions;
  if (!latestEntry) return undefined;
  const lines = resolutions.map((entry) => toTraceLine(entry, now));
  return {
    latest: toTraceLine(latestEntry, now),
    moreCount: rest.length,
    tooltip: lines.map((line) => `${line.symbol} #${line.shortId} ${line.text} · hace ${line.age}`).join("\n"),
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
  liveItem: BoardInboxItem | undefined,
  waitSeconds: number,
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
    liveRequest: liveItem ? toLiveRequest(liveItem, now, waitSeconds) : undefined,
    resolutionTrace: toResolutionTrace(session.resolutions, now),
    terminalLabel: terminalLabelFor(session.terminalReach, session.terminalAppLabel),
    terminalReach: session.terminalReach,
    terminalNeedsTcc: session.terminalNeedsTcc,
    nativeWait: toNativeWait(session.nativeWait, now),
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

/**
 * Ticket 10 (spec "Requests vs agents"): TE NECESITA now holds pending
 * REQUESTS only — "TE NECESITA · pedidos" names that directly, with
 * `TE_NECESITA_TOOLTIP` (below) spelling out why in `Column`'s own header.
 */
const COLUMN_TITLES = {
  teNecesita: "TE NECESITA · pedidos",
  corriendo: "CORRIENDO",
  trabada: "TRABADA",
  termino: "TERMINÓ",
} as const;

/** The TE NECESITA header's own tooltip (spec, verbatim from the approved prototype's `col()` call) — only this column carries one. */
export const TE_NECESITA_TOOLTIP = "el agente no está esperando: ya recibió el deny y siguió";

/**
 * Ticket 10: split `payload.inbox` into the TE NECESITA rows (plain pending
 * items, unchanged, PLUS a held row whose window has already lapsed —
 * `liveItemPhase` reads that one as pending too, same as the hook itself
 * would by now) and the still-live rows that dock onto their OWN Session's
 * card instead (`liveBySessionId`). A held row whose Session cannot be
 * found at all (should not happen — see `toSessionCard`'s own callers)
 * degrades to the pending list rather than vanishing silently.
 */
function splitInboxByLivePhase(
  inbox: readonly BoardInboxItem[],
  now: Date,
  waitSeconds: number,
): { pending: BoardInboxItem[]; liveBySessionId: Map<string, BoardInboxItem> } {
  const pending: BoardInboxItem[] = [];
  const liveBySessionId = new Map<string, BoardInboxItem>();

  for (const item of inbox) {
    if (item.decision === "held" && liveItemPhase(item.ts, now, waitSeconds) === "live") {
      // At most one live hold per Session in practice (an agent waits on
      // one tool call at a time) — a second one, were it ever to happen,
      // simply overwrites the first here; nothing silently drops it from
      // the LOG, only from this one render's badge.
      liveBySessionId.set(item.sessionId, item);
    } else {
      pending.push(item);
    }
  }

  return { pending, liveBySessionId };
}

export function buildBoardViewModel(payload: BoardPayload, now: Date): BoardViewModel {
  const byId = new Map(payload.sessions.map((session) => [session.id, session] as const));
  const sessionIds = new Set(payload.sessions.map((session) => session.id));

  const { pending, liveBySessionId } = splitInboxByLivePhase(payload.inbox, now, payload.policy.waitSeconds);

  // A live row whose Session this payload doesn't carry at all is an
  // orphan this render can never dock anywhere — fall back to the pending
  // list rather than dropping it (no silent failures, per review).
  for (const [sessionId, item] of liveBySessionId) {
    if (!sessionIds.has(sessionId)) {
      liveBySessionId.delete(sessionId);
      pending.push(item);
    }
  }

  const inboxCards = [...pending].sort(byOldestFirst).map((item) => toInboxCard(item, now));

  const sessionsByColumn: Record<SessionColumn, BoardSession[]> = { corriendo: [], trabada: [], termino: [] };
  for (const session of payload.sessions) {
    const column = sessionColumn(session, now, payload.policy.stallMinutes);
    if (!column) continue; // ended past the 24h TERMINÓ window — the board drops the card entirely
    sessionsByColumn[column].push(session);
  }
  for (const list of Object.values(sessionsByColumn)) list.sort(byMostRecentEventFirst);

  const toCards = (list: readonly BoardSession[]): SessionCardViewModel[] =>
    nestUnderParents(list).map(({ session, nested }) =>
      toSessionCard(
        session,
        nested,
        now,
        payload.policy.contextThresholdTokens,
        byId,
        liveBySessionId.get(session.id),
        payload.policy.waitSeconds,
      ),
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
    stats: {
      teNecesita: inboxCards.length + liveBySessionId.size,
      corriendo: corriendoCards.length,
      trabada: trabadaCards.length,
      over200k,
    },
    orderedIds: [
      ...inboxCards.map((card) => card.id),
      ...corriendoCards.map((card) => card.id),
      ...trabadaCards.map((card) => card.id),
      ...terminoCards.map((card) => card.id),
    ],
  };
}

/**
 * Ticket 10: "selecting [a pending request] highlights that Session's
 * card" (spec) — pure lookup, never baked into `buildBoardViewModel` itself
 * (selection is the container's own state, not a fact of the payload).
 * `undefined` when nothing is selected, or the selection isn't a TE
 * NECESITA card at all (a live request's own card needs no cross-highlight
 * — it's already selected directly).
 */
export function highlightedSessionId(viewModel: BoardViewModel, selectedId: string | undefined): string | undefined {
  if (selectedId === undefined) return undefined;
  return viewModel.teNecesita.cards.find((card) => card.id === selectedId)?.sessionId;
}

/**
 * Ticket 11: "from any card... t brings the terminal... to the front"
 * (ticket) — `cardId` is whatever `useBoardKeyboard`'s own `selectedId`
 * carries, which for a TE NECESITA card is the ITEM's hash, never the
 * Session it belongs to. Resolves either shape to the one id the focus
 * route actually takes (`/sessions/<id>/focus`): a Session card's own id
 * IS already a Session id, so it round-trips unchanged; a TE NECESITA
 * card's own `sessionId` field is read instead. `undefined` only when
 * `cardId` names nothing at all (should not happen — it always came from
 * `orderedIds`).
 */
export function sessionIdForCard(viewModel: BoardViewModel, cardId: string): string | undefined {
  const inboxCard = viewModel.teNecesita.cards.find((card) => card.id === cardId);
  if (inboxCard) return inboxCard.sessionId;
  const sessionCard = [...viewModel.corriendo.cards, ...viewModel.trabada.cards, ...viewModel.termino.cards].find(
    (card) => card.id === cardId,
  );
  return sessionCard?.id;
}
