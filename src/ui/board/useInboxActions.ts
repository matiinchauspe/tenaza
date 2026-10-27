import { useCallback, useEffect, useRef, useState } from "react";
import { parseRunOutput } from "../../runoutput";

/** The HTTP shapes `daemon.ts`'s write routes answer with (ticket 09) — matched here only to decide what to DO with the response, never re-validated against a schema (unlike `BoardPayload`, which travels over SSE and needs one). */
const STALE_TOKEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;

/**
 * Short es-AR phrases for every refusal `kind` `daemon.ts`'s write routes
 * can answer with (review fix) — `runRefusalResponse`'s `RunRefusal` kinds
 * (409/422) plus `spawn-failed` (500). `done`/`dismiss` never return any of
 * these themselves (`resolveInboxItem` only ever 200s or 404s), but `run`
 * can, and a stale card could in principle still send a `done`/`dismiss`
 * that races one of these too — the map applies uniformly to whichever
 * write hit it.
 */
const REFUSAL_MESSAGES: Record<string, string> = {
  "already-resolved": "Ya estaba cerrado",
  unblockable: "Ya corrió — no se puede repetir",
  "not-runnable": "Es una llamada MCP, no tiene comando para correr",
  "no-cwd": "No se sabe en qué directorio correrlo",
  "cwd-missing": "El directorio de la Session ya no existe",
  "spawn-failed": "No se pudo iniciar el comando",
  /** Ticket 10: `postLiveAnswer`'s own refusal — the window already lapsed (or it was never live) before this answer reached the Daemon. */
  "not-live": "Ya no está en vivo — pasó a pendiente",
  "invalid-answer": "Respuesta inválida",
  "invalid-body": "No se pudo enviar la respuesta",
  /** Ticket 11: `archiveSession`'s own refusal (`resolve.ts`) — the server-side half of "x on any other Session card does nothing". A repeat archive is never a refusal (`alreadyArchived` rides the 200 instead), so there is no "already archived" entry here. */
  "not-ended": "Esa Session todavía no terminó",
};

/** 404 — the item doesn't exist UNDER THIS id any more (closed from elsewhere, e.g. the CLI, between this tab's last SSE push and the click). Plain text body (`daemon.ts`'s `new Response("not found\n", ...)`), never JSON — handled by status alone, before any `res.json()` attempt. */
const NOT_FOUND_MESSAGE = "Ese ítem ya no está pendiente";

/** Ticket 11: the SAME 404 shape, worded for a Session-scoped write (`focus`/`archive`) instead of an Inbox item. */
const SESSION_NOT_FOUND_MESSAGE = "Esa Session ya no existe";

const GENERIC_MESSAGE = (status: number): string => `No se pudo (${status})`;

/**
 * Ticket 10: "resolving a pending request gives visible feedback: a short
 * toast... never a silent vanish" (spec). Fired ONLY on a CONFIRMED
 * success — `done`/`dismiss`'s own 200 response, or `run`'s stream ending
 * with no failure trailer — never optimistically on click, so a refused
 * write (409/422/500/404, surfaced in `errors[id]` instead) never shows a
 * false "listo" alongside it.
 *
 * **Amended ticket 12** (spec "Requests vs agents," 2026-10-27): a live
 * `answer` (approve/reject) now ALSO toasts, on the Daemon's own
 * confirmation — never optimistically on the `a`/`r` keypress or button
 * click, same rule as every other toast here. A REFUSED answer (409
 * `not-live`, the window already lapsed) shows its error instead, exactly
 * like a refused `done`/`dismiss`/`run` — never a toast. `buildAnswerToastMessage`
 * (below) is `answer`'s own builder, kept separate from `buildToastMessage`
 * because its wording doesn't fit the shared "cerrado como <verb>" template
 * (the spec gives each answer kind its own exact phrasing).
 */
const RESOLUTION_VERBS: Record<"run" | "done" | "dismiss", string> = {
  run: "corrido",
  done: "listo",
  dismiss: "descartado",
};

/** Display truncation only (same convention `InboxCard`'s own `ID_DISPLAY_LENGTH` already uses) — never a collision-safe shortest-unique-prefix. */
const TOAST_ID_DISPLAY_LENGTH = 8;

function buildToastMessage(id: string, action: "run" | "done" | "dismiss"): string {
  return `✓ pedido #${id.slice(0, TOAST_ID_DISPLAY_LENGTH)} cerrado como ${RESOLUTION_VERBS[action]} — el agente no se entera`;
}

/**
 * Ticket 12: mirrors `live.ts`'s own `GENERIC_REJECT_REASON` text — copied
 * here VERBATIM rather than imported, same convention `runoutput.ts`'s own
 * doc comment already establishes for a format two sides must agree on
 * ("a ZERO-IMPORT module... so the writer and the reader can never
 * disagree"): `live.ts` imports `daemonlink.ts`/`log.ts`, both
 * `node:fs`-backed, and importing it here would drag that server-only
 * code into the browser bundle. A human reading the toast sees the SAME
 * words the agent actually reads when no message was typed.
 */
const GENERIC_REJECT_REASON_FOR_TOAST = "Rechazado por el humano — sin mensaje.";

/**
 * Ticket 12 (spec, amended "Requests vs agents"): `✓ #<id> aprobado — el
 * agente sigue` / `✕ #<id> rechazado — el agente lee: "<msg>"` — the
 * EXACT wording the spec gives, never folded into `buildToastMessage`'s
 * own "cerrado como <verb>" template above.
 */
function buildAnswerToastMessage(id: string, answer: "approve" | "reject", message: string | undefined): string {
  const shortId = id.slice(0, TOAST_ID_DISPLAY_LENGTH);
  if (answer === "approve") return `✓ #${shortId} aprobado — el agente sigue`;
  const shown = message && message.length > 0 ? message : GENERIC_REJECT_REASON_FOR_TOAST;
  return `✕ #${shortId} rechazado — el agente lee: "${shown}"`;
}

/** How long a toast stays up before it's dropped (the prototype's own ~2.6s). */
const TOAST_LIFETIME_MS = 2600;

export interface ToastViewModel {
  id: string;
  message: string;
}

/**
 * A non-ok, NON-403 write response → its short es-AR message (review fix:
 * "surface a per-item es-AR message... for any non-ok, non-403 response").
 * 403 is handled separately (`staleToken`, below) — this is never called
 * for it. Reads the body only when the status is one `daemon.ts` is known
 * to answer with JSON on (409/422/500); a malformed or absent JSON body
 * still degrades to the generic message rather than throwing.
 */
async function describeWriteError(res: Response, notFoundMessage: string = NOT_FOUND_MESSAGE): Promise<string> {
  if (res.status === NOT_FOUND_STATUS) return notFoundMessage;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error && REFUSAL_MESSAGES[body.error]) return REFUSAL_MESSAGES[body.error] as string;
  } catch {
    // Not JSON (or already consumed) — fall through to the generic message.
  }
  return GENERIC_MESSAGE(res.status);
}

export interface InboxActionsState {
  /** Item ids with a `run` currently streaming — drives the button's disabled/label state. */
  runningIds: ReadonlySet<string>;
  /** The combined stdout+stderr captured so far for each item THIS tab has ever run, keyed by item id — cleared only when a NEW `run` starts for that same id. */
  outputs: Readonly<Record<string, string>>;
  /** Review fix: a short es-AR message for the LAST non-ok, non-403 response any write (`run`, `done` or `dismiss`) for this item got — a refusal the item's own state caused (409/422), a spawn failure (500), or the item being gone already (404). Cleared the next time a write for the SAME id succeeds. Distinct from `outputs`' own in-stream failure trailer (`runoutput.ts`): this is "the write itself was refused," that is "the write STARTED and the command it ran failed." */
  errors: Readonly<Record<string, string>>;
  /** True once any write has come back 403 — the Daemon's token rotated (a restart) and this tab's cookie is stale (decision 05, ticket 09's own "stale tab" note). Never clears itself: reopening the view (a fresh `/auth` load) is the only fix, so there is nothing to recover from in place. */
  staleToken: boolean;
  /** Ticket 10: every currently-visible toast, oldest first — each one drops itself after `TOAST_LIFETIME_MS`. */
  toasts: readonly ToastViewModel[];
  run(id: string): void;
  done(id: string): void;
  dismiss(id: string): void;
  /** Ticket 10: post a live-answering APPROVE for `id` — `message` is the human's optional note, forwarded as the agent's own `additionalContext`. */
  approve(id: string, message?: string): void;
  /** Ticket 10: post a live-answering REJECT for `id` — `message` is the deny reason the agent reads; empty/omitted gets a generic one (`live.ts`'s own `GENERIC_REJECT_REASON`), never silently dropped. */
  reject(id: string, message?: string): void;
  /** Ticket 11: "go to the agent's terminal" — `sessionId` is the OWNING Session's own id, never a card's own id when the card is an Inbox item (`viewModel.ts`'s `sessionIdForCard` resolves that). Fire-and-forget, same shape `approve`/`reject` already use — a focus action never changes derived state, so there is nothing for `/events` to push back either. */
  focusTerminal(sessionId: string): void;
  /** Ticket 11: "archive a TERMINÓ card" — `x` on a selected TERMINÓ Session card, or its own button. */
  archive(sessionId: string): void;
}

function itemActionUrl(id: string, action: "run" | "done" | "dismiss" | "answer"): string {
  return `/items/${id}/${action}`;
}

/** Ticket 11: `/sessions/<id>/focus` or `/sessions/<id>/archive` — a SEPARATE route shape from `itemActionUrl`'s own `/items/<id>/<action>` (`fence.ts`'s own doc comment on why). */
function sessionActionUrl(id: string, action: "focus" | "archive"): string {
  return `/sessions/${id}/${action}`;
}

/**
 * Owns every write the board's action cards make (ticket 09's `run`,
 * `done`, `dismiss`; ticket 10's `approve`/`reject`) — and the per-item
 * state those writes produce (streamed output, which ids are mid-run,
 * whether this tab's token has gone stale, and a per-item error message
 * for a refused write). The container (`BoardApp`) calls this and hands
 * the result down; `InboxCard`/`SessionCard` stay pure presentational,
 * exactly as ticket 08 left them. `approve`/`reject` are fire-and-forget,
 * same shape as `done`/`dismiss` — the hold's own CLOSE (or expiry) is
 * read back from `/events`, never from this fetch's response.
 *
 * The RESOLVED outcome of a SUCCESSFUL `run` or `done`/`dismiss` —
 * whether the item actually closed — is still never read from the fetch
 * response here. It is read back from the board's own `/events` SSE the
 * moment the Daemon's state changes (ADR 0002: nothing is kept beside the
 * logs). What THIS hook now also owns is the opposite case: a write that
 * never had a chance to change anything at all, because the Daemon
 * refused it outright — that refusal has no SSE push to wait on (nothing
 * changed), so it must be surfaced from the response itself, immediately.
 */
export function useInboxActions(): InboxActionsState {
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(new Set());
  const [outputs, setOutputs] = useState<Readonly<Record<string, string>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [staleToken, setStaleToken] = useState(false);
  const [toasts, setToasts] = useState<readonly ToastViewModel[]>([]);
  // A fetch that resolves after this hook's owner unmounts (e.g. the board
  // re-renders away mid-stream) must never call `setState` on a gone
  // component — a plain ref, not state, since nothing ever needs to
  // RENDER off this flag.
  const unmountedRef = useRef(false);
  const toastTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      for (const timeout of toastTimeoutsRef.current) clearTimeout(timeout);
    };
  }, []);

  function clearError(id: string): void {
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  /** Push one toast and schedule its own removal — a plain, self-contained lifecycle, never dependent on the component re-rendering for any other reason to notice the timeout fired. */
  function pushToast(message: string): void {
    if (unmountedRef.current) return;
    const toastId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { id: toastId, message }]);
    const timeout = setTimeout(() => {
      toastTimeoutsRef.current.delete(timeout);
      if (unmountedRef.current) return;
      setToasts((prev) => prev.filter((toast) => toast.id !== toastId));
    }, TOAST_LIFETIME_MS);
    toastTimeoutsRef.current.add(timeout);
  }

  /** The ONLY shape `body` is ever actually sent as (`approve`/`reject`'s own call sites, below) — `done`/`dismiss`/`run` always call `post` with no third argument at all. Typed here so the success branch can read `answer`/`message` straight back WITHOUT re-parsing JSON a second time or re-casting `unknown`. */
  type AnswerBody = { answer: "approve" | "reject"; message?: string };

  const post = useCallback(
    async (id: string, action: "run" | "done" | "dismiss" | "answer", body?: AnswerBody): Promise<Response> => {
      const res = await fetch(itemActionUrl(id, action), {
        method: "POST",
        ...(body !== undefined
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      if (unmountedRef.current) return res;

      if (res.status === STALE_TOKEN_STATUS) {
        setStaleToken(true);
      } else if (!res.ok) {
        // `run`'s own SUCCESS path (200, a stream) never reaches here — only
        // a refusal (409/422/500) or a 404 does, neither of which carries a
        // body a later reader needs, so consuming it here is safe.
        const message = await describeWriteError(res.clone());
        if (!unmountedRef.current) setErrors((prev) => ({ ...prev, [id]: message }));
      } else {
        clearError(id);
        // Ticket 10: `done`/`dismiss` confirm success INLINE, in this same
        // response — unlike `run`, which only confirms its STREAM started;
        // that one's own toast fires once the stream actually ends (below),
        // never here.
        if (action === "done" || action === "dismiss") pushToast(buildToastMessage(id, action));
        // Ticket 12: `answer`'s own toast, on the SAME "confirmed by this
        // response" rule — `body` is always defined here (every `answer`
        // call site passes one; see `AnswerBody`'s own doc), but the guard
        // stays defensive rather than asserting it.
        else if (action === "answer" && body) pushToast(buildAnswerToastMessage(id, body.answer, body.message));
      }
      return res;
    },
    [],
  );

  /**
   * Ticket 11's own write pair (`focus`, `archive`) — same shape `post`
   * already gives the `/items/` writes, kept SEPARATE rather than folded
   * into it: a different URL builder (`sessionActionUrl`), a different
   * 404 wording (`SESSION_NOT_FOUND_MESSAGE`), and neither ever needs a
   * success toast (a focus action changes nothing derived to toast about;
   * archiving is confirmed by the card simply leaving the board over
   * `/events`, same as every other derived-state change in this project —
   * never a redundant toast on top of that).
   */
  const postSession = useCallback(
    async (id: string, action: "focus" | "archive"): Promise<Response> => {
      const res = await fetch(sessionActionUrl(id, action), { method: "POST" });
      if (unmountedRef.current) return res;

      if (res.status === STALE_TOKEN_STATUS) {
        setStaleToken(true);
      } else if (!res.ok) {
        const message = await describeWriteError(res.clone(), SESSION_NOT_FOUND_MESSAGE);
        if (!unmountedRef.current) setErrors((prev) => ({ ...prev, [id]: message }));
      } else {
        clearError(id);
      }
      return res;
    },
    [],
  );

  const focusTerminal = useCallback(
    (sessionId: string) => {
      void postSession(sessionId, "focus");
    },
    [postSession],
  );

  const archive = useCallback(
    (sessionId: string) => {
      void postSession(sessionId, "archive");
    },
    [postSession],
  );

  const done = useCallback(
    (id: string) => {
      void post(id, "done");
    },
    [post],
  );

  const dismiss = useCallback(
    (id: string) => {
      void post(id, "dismiss");
    },
    [post],
  );

  const approve = useCallback(
    (id: string, message?: string) => {
      void post(id, "answer", { answer: "approve", message });
    },
    [post],
  );

  const reject = useCallback(
    (id: string, message?: string) => {
      void post(id, "answer", { answer: "reject", message });
    },
    [post],
  );

  const run = useCallback(
    (id: string) => {
      setRunningIds((prev) => new Set(prev).add(id));
      setOutputs((prev) => ({ ...prev, [id]: "" }));

      void (async () => {
        // Ticket 10: accumulated LOCALLY too (never just read back from
        // `outputs` state, which closes over a stale value) so the toast
        // check below — "did this run end WITHOUT a failure trailer" — has
        // the complete text the instant the stream itself ends, not
        // whatever React happened to have committed by then.
        let accumulated = "";
        let streamEndedCleanly = false;
        try {
          const res = await post(id, "run");
          if (res.status === STALE_TOKEN_STATUS || !res.ok || !res.body) return;

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { value, done: streamDone } = await reader.read();
            if (streamDone) break;
            const chunk = decoder.decode(value, { stream: true });
            accumulated += chunk;
            if (unmountedRef.current) continue;
            setOutputs((prev) => ({ ...prev, [id]: (prev[id] ?? "") + chunk }));
          }
          streamEndedCleanly = true;
        } catch {
          // A network drop mid-stream — the item's own state (closed or
          // still open) is read back from `/events` regardless; nothing
          // more to do here than stop showing it as running.
        } finally {
          // The stream ending with NO failure trailer is `run`'s own
          // success signal — `startInboxItemRunStream`'s one and only way
          // of saying "closed as done" short of re-deriving the Inbox.
          if (streamEndedCleanly && parseRunOutput(accumulated).error === undefined) {
            pushToast(buildToastMessage(id, "run"));
          }
          if (!unmountedRef.current) {
            setRunningIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        }
      })();
    },
    [post],
  );

  return { runningIds, outputs, errors, staleToken, toasts, run, done, dismiss, approve, reject, focusTerminal, archive };
}
