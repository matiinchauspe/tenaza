/**
 * Turns a `BoardPayload` plus the current `now` into what the presentational components
 * render — four columns of classified, formatted cards, plus the flattened id order
 * `useBoardKeyboard` walks. Pure, with no `Date.now()` inside and no state of its own:
 * `BoardApp` re-calls this on every tick, so a Session that stopped producing Events still
 * re-classifies here even though the SSE payload itself hasn't changed.
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
  TurnWait,
} from "../../contract/live";

/** "unknown" returns an empty string rather than a dead literal nobody reads, since neither card shows a terminal button for it at all. */
export function terminalLabelFor(reach: TerminalReach, appLabel: string | undefined): string {
  if (reach === "exact") return "ir a terminal ↗";
  if (reach === "app") return `abrir ${appLabel ?? "la terminal"} ↗`;
  return "";
}

/** Reuses `formatContextNumber` so a Session shows the same "243k"/"⚑243k"/"—" here as in the CLI's status tree. */
export type ContextDisplay = { kind: "track"; track: ContextTrack; label: string } | { kind: "unavailable" };

export interface InboxCardViewModel {
  id: string;
  project: string;
  /** Verbatim, or `undefined` when none was ever announced — a card then renders nothing for it, never a stray "— ". */
  ticket: string | undefined;
  sessionId: string;
  tool: string;
  /** `undefined` for an `mcp` Action (it has none) — the card shows the tool name alone then. */
  command: string | undefined;
  /** "tool: command", or the bare tool name — the card's `title` attribute and accessible name. */
  toolLabel: string;
  age: string;
  /** Denied and awaiting `run`, vs. already ran unenforced (ADR 0001) — picks the card's badge. */
  blocked: boolean;
  /** An already-ran item (`blocked: false`) and an `mcp` item (no stored command) both offer no `run` — computed here once so `InboxCard` never re-derives it. */
  offersRun: boolean;
  terminalLabel: string;
  terminalReach: TerminalReach;
  terminalNeedsTcc: boolean;
}

export interface LiveRequestViewModel {
  /** The full identity hash the `answer` write posts back against — never shown on the badge itself, unlike a pending TE NECESITA card's id. */
  id: string;
  tool: string;
  command: string | undefined;
  toolLabel: string;
  /** "hace Ns" since the hold began. */
  age: string;
  /** Seconds left before the window lapses — never negative. */
  remainingSeconds: number;
  /** 0..1, how much of the draining bar is still filled. */
  remainingFraction: number;
}

/**
 * Pure observation of Claude Code's own permission/idle prompt — never a Tenaza hold
 * (contrast `LiveRequestViewModel`, which carries an `id` the view can answer against).
 * There's no window, no command, and no answer Tenaza can send: `SessionCard` renders only a
 * badge plus the age, so pressing `a`/`r` on a card showing this does nothing.
 */
export interface NativeWaitViewModel {
  kind: NativeWaitKind;
  label: string;
  hint: string;
  /** "hace Ns" since the notification was observed. */
  age: string;
}

/** Present only when the Turn just ended and nothing more specific (`nativeWait`) is also current — observed only, never actionable, for the same reason: Tenaza never raised this. */
export interface TurnWaitViewModel {
  /** "hace Ns" since the Turn ended. */
  age: string;
  /** How many subagents are still running under this Session — 0 renders the badge with no suffix. */
  backgroundCount: number;
}

/** `done`, `fail-fast` and no verdict earn no badge, so those cards render as before. */
export type VerdictBadgeKind = "parked" | "checkpoint";

export interface VerdictBadgeViewModel {
  kind: VerdictBadgeKind;
  label: string;
}

const VERDICT_BADGE_LABEL: Record<VerdictBadgeKind, string> = {
  parked: "TE ESPERA",
  checkpoint: "CONTINÚA",
};

function verdictBadgeFor(verdict: string | undefined): VerdictBadgeViewModel | undefined {
  if (verdict !== "parked" && verdict !== "checkpoint") return undefined;
  return { kind: verdict, label: VERDICT_BADGE_LABEL[verdict] };
}

/** Already resolved to its es-AR symbol/text/tone; `SessionCard` only composes these into the final string, never re-derives the wording. */
export interface ResolutionTraceLineViewModel {
  symbol: "✓" | "✕" | "✗";
  /**
   * Cosmetic-only — not a collision-safe shortest-unique-prefix, which would need the full
   * population of every id ever assigned, computed server-side (`node:crypto`) and must
   * never reach this browser bundle. The full hash stays one hover away via the tooltip.
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
  /** `undefined` outside a known worktree layout. */
  worktree: string | undefined;
  ticket: string | undefined;
  role: SessionRole;
  /** Cut for display; `id` stays whole for keys, selection and DOM ids. */
  shortId: string;
  /** Ready-to-render "↳ <label>", or `undefined` when this Session has no parent. */
  parentLabel: string | undefined;
  /** True when this card renders right under its parent in the same column (indented). */
  nested: boolean;
  context: ContextDisplay;
  /** What this Session most recently attempted, or "—" when it never has. */
  lastSignal: string;
  age: string;
  /** `undefined` for every other card, including one whose hold already lapsed to pending — that item renders in TE NECESITA instead, same payload row, classified by `liveItemPhase`. */
  liveRequest: LiveRequestViewModel | undefined;
  /** `undefined` when this Session never raised a request. */
  resolutionTrace: ResolutionTraceViewModel | undefined;
  /** For a subagent, this is its parent's terminal button, not its own. */
  terminalLabel: string;
  terminalReach: TerminalReach;
  terminalNeedsTcc: boolean;
  /** Never conflated with `liveRequest`: that's an answerable Tenaza hold, this is pure observation — the card offers only "ir a terminal ↗" for it. */
  nativeWait: NativeWaitViewModel | undefined;
  turnWait: TurnWaitViewModel | undefined;
  /** TERMINÓ only: a session can announce a verdict and keep running. */
  verdictBadge: VerdictBadgeViewModel | undefined;
}

export interface BoardColumnViewModel<Card> {
  key: string;
  title: string;
  cards: Card[];
}

/** Plain counts — the header never re-derives these from the cards. */
export interface BoardStats {
  /** The total of every live request plus every plain pending one — even though the TE NECESITA column itself only lists the pending half. */
  teNecesita: number;
  corriendo: number;
  trabada: number;
  /** Sessions at or past the context threshold, excluding a TERMINÓ card — an ended Session crossing 200k is no longer anyone's problem to watch. */
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

/** Kept as its own literal rather than imported from `sessions.ts`, which would pull node-builtin-using neighbors into the browser bundle (ADR 0001). */
export const NO_MEASURE_TEXT = "sin datos";

function contextDisplayFor(session: BoardSession, contextThresholdTokens: number): ContextDisplay {
  if (!session.hasMeasureCapability) return { kind: "unavailable" };
  return {
    kind: "track",
    track: computeContextTrack(session.contextTokens, contextThresholdTokens),
    label: formatContextNumber(session.contextTokens, contextThresholdTokens),
  };
}

/** `item` is anything shaped like `ActionSummary` — an Inbox row's `action`, or a Session's `lastSignal` — same "tool: command" rule either way. */
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

/** `buildBoardViewModel` routes a live-phase "held" row here instead of through `toInboxCard` — never shown on a TE NECESITA card at all. */
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

/** The one place this wording is picked, so `SessionCard` never re-derives or duplicates it. */
const NATIVE_WAIT_LABEL: Record<NativeWaitKind, string> = {
  permission_prompt: "PERMISO NATIVO",
  idle_prompt: "INACTIVA",
};

/** Spells out, in es-AR, that Tenaza only observes this and names where to actually act. */
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

function toTurnWait(turnWait: TurnWait | undefined, now: Date): TurnWaitViewModel | undefined {
  if (!turnWait) return undefined;
  return { age: formatAge(turnWait.since, now), backgroundCount: turnWait.backgroundCount };
}

/** Display truncation only — not collision-safe. */
const TRACE_ID_DISPLAY_LENGTH = 4;

/** The one place every resolution kind maps to its symbol/text/tone, so `SessionCard` never re-derives it. */
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

/** `resolutions` arrives newest-first and is never re-sorted here. `undefined` when the Session never raised a request, so `SessionCard` renders nothing rather than an empty trace line. */
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

/** Enough to tell this human's Sessions apart at a glance; the full id stays in `id`. */
export const SHORT_ID_LENGTH = 8;

function shortSessionId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

/** "↳ <parent>": the parent's ticket when it has one, else its short id — never its role, since every top-level Session's role reads "sesión" and so names nothing. */
function parentLabelFor(session: BoardSession, byId: ReadonlyMap<string, BoardSession>): string | undefined {
  if (session.parentId === undefined) return undefined;
  const parent = byId.get(session.parentId);
  return `↳ ${parent?.ticket ?? shortSessionId(session.parentId)}`;
}

/**
 * Parents keep the column's own order; children follow right after, in that order. A child
 * whose parent isn't in this column (ended, or stalled while it runs) stays where the
 * column's order puts it, un-nested — its `↳` still names the parent.
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
  column: SessionColumn,
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
    turnWait: toTurnWait(session.turnWait, now),
    verdictBadge: column === "termino" ? verdictBadgeFor(session.verdict) : undefined,
  };
}

function byOldestFirst(a: BoardInboxItem, b: BoardInboxItem): number {
  return a.ts.localeCompare(b.ts);
}

/** Freshest activity first — a default; nothing mandates ordering for these columns. */
function byMostRecentEventFirst(a: BoardSession, b: BoardSession): number {
  return (b.lastEventTs ?? "").localeCompare(a.lastEventTs ?? "");
}

const COLUMN_TITLES = {
  teNecesita: "TE NECESITA · pedidos",
  corriendo: "CORRIENDO",
  trabada: "TRABADA",
  termino: "TERMINÓ",
} as const;

/** Only this column carries a tooltip. */
export const TE_NECESITA_TOOLTIP = "el agente no está esperando: ya recibió el deny y siguió";

/**
 * Splits `payload.inbox` into the TE NECESITA rows (plain pending items, plus a held row
 * whose window already lapsed — `liveItemPhase` reads that one as pending too) and the
 * still-live rows that dock onto their own Session's card instead. A held row whose Session
 * can't be found degrades to the pending list rather than vanishing silently.
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
      // At most one live hold per Session in practice. A second one would simply overwrite
      // the first here — nothing is dropped from the log, only from this render's badge.
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

  // A live row whose Session this payload doesn't carry at all is an orphan this render can
  // never dock anywhere — fall back to the pending list rather than dropping it.
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

  const toCards = (list: readonly BoardSession[], column: SessionColumn): SessionCardViewModel[] =>
    nestUnderParents(list).map(({ session, nested }) =>
      toSessionCard(
        session,
        nested,
        now,
        payload.policy.contextThresholdTokens,
        byId,
        liveBySessionId.get(session.id),
        payload.policy.waitSeconds,
        column,
      ),
    );

  const corriendoCards = toCards(sessionsByColumn.corriendo, "corriendo");
  const trabadaCards = toCards(sessionsByColumn.trabada, "trabada");
  const terminoCards = toCards(sessionsByColumn.termino, "termino");

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
 * Pure lookup, never baked into `buildBoardViewModel` itself — selection is the container's
 * own state, not a fact of the payload. `undefined` when nothing is selected, or the
 * selection isn't a TE NECESITA card — a live request's own card needs no cross-highlight,
 * since it's already selected directly.
 */
export function highlightedSessionId(viewModel: BoardViewModel, selectedId: string | undefined): string | undefined {
  if (selectedId === undefined) return undefined;
  return viewModel.teNecesita.cards.find((card) => card.id === selectedId)?.sessionId;
}

/**
 * `cardId` is ambiguous: for a TE NECESITA card it's the item's hash, never the Session it
 * belongs to; for a Session card it's already a Session id. Resolves either shape to the one
 * id the focus route actually takes. `undefined` only when `cardId` names nothing at all.
 */
export function sessionIdForCard(viewModel: BoardViewModel, cardId: string): string | undefined {
  const inboxCard = viewModel.teNecesita.cards.find((card) => card.id === cardId);
  if (inboxCard) return inboxCard.sessionId;
  const sessionCard = [...viewModel.corriendo.cards, ...viewModel.trabada.cards, ...viewModel.termino.cards].find(
    (card) => card.id === cardId,
  );
  return sessionCard?.id;
}

/** Same card-kind resolution as `sessionIdForCard`, but reading `terminalReach` instead — lets the board gate the `t` key without re-deriving which card kind `cardId` names. */
export function terminalReachForCard(viewModel: BoardViewModel, cardId: string): TerminalReach | undefined {
  const inboxCard = viewModel.teNecesita.cards.find((card) => card.id === cardId);
  if (inboxCard) return inboxCard.terminalReach;
  const sessionCard = [...viewModel.corriendo.cards, ...viewModel.trabada.cards, ...viewModel.termino.cards].find(
    (card) => card.id === cardId,
  );
  return sessionCard?.terminalReach;
}

export type BoardKey = "d" | "x" | "a" | "t";

/**
 * What `resolveBoardKeyAction` returns for a key that applies to the
 * selected card: which write to dispatch, and the id it actually targets —
 * the selected card's own id for every kind except `answer` and
 * `focusTerminal` below.
 */
export interface BoardKeyAction {
  kind: "done" | "dismiss" | "archive" | "answer" | "focusTerminal";
  /**
   * `answer` targets the live Inbox item's own id, never the selected Session card's id —
   * this field makes that distinction structurally explicit rather than left to each caller.
   * `focusTerminal` targets the owning Session's id, which for a TE NECESITA card differs
   * from the id selected. Every other kind targets the selected card's own id, unchanged.
   */
  id: string;
}

/**
 * The one table `BoardApp` dispatches through — it holds no card-kind lookup of its own.
 * `undefined` for a key that doesn't apply to the selected card, including a `selectedId`
 * naming no card at all.
 *
 * `r` carries no gate here: it only focuses a message input, a pure DOM move
 * `useBoardKeyboard` still owns directly.
 */
export function resolveBoardKeyAction(
  viewModel: BoardViewModel,
  selectedId: string,
  key: BoardKey,
): BoardKeyAction | undefined {
  switch (key) {
    case "d":
      return viewModel.teNecesita.cards.some((card) => card.id === selectedId)
        ? { kind: "done", id: selectedId }
        : undefined;

    case "x": {
      if (viewModel.teNecesita.cards.some((card) => card.id === selectedId)) {
        return { kind: "dismiss", id: selectedId };
      }
      return viewModel.termino.cards.some((card) => card.id === selectedId)
        ? { kind: "archive", id: selectedId }
        : undefined;
    }

    case "a": {
      // The selected card's live Inbox item, if one is currently docked on a Session card.
      const sessionCard = [...viewModel.corriendo.cards, ...viewModel.trabada.cards, ...viewModel.termino.cards].find(
        (card) => card.id === selectedId,
      );
      return sessionCard?.liveRequest ? { kind: "answer", id: sessionCard.liveRequest.id } : undefined;
    }

    case "t": {
      if (viewModel.termino.cards.some((card) => card.id === selectedId)) return undefined;
      if (terminalReachForCard(viewModel, selectedId) === "unknown") return undefined;
      const sessionId = sessionIdForCard(viewModel, selectedId);
      return sessionId ? { kind: "focusTerminal", id: sessionId } : undefined;
    }
  }
}
