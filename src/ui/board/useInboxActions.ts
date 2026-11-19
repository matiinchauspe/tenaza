import { useCallback, useEffect, useRef, useState } from "react";
import { parseRunOutput } from "../../runoutput";

/** Matched only to decide what to do with the response — never schema-validated, unlike `BoardPayload`, which travels over SSE. */
const STALE_TOKEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;

/**
 * Every refusal kind the write routes can answer with (409/422/500). `done`/`dismiss` never
 * produce these themselves, but `run` can — and a stale card could still race one via
 * `done`/`dismiss` too, so the map applies uniformly to whichever write hit it.
 */
const REFUSAL_MESSAGES: Record<string, string> = {
  "already-resolved": "Ya estaba cerrado",
  unblockable: "Ya corrió — no se puede repetir",
  "not-runnable": "Es una llamada MCP, no tiene comando para correr",
  "no-cwd": "No se sabe en qué directorio correrlo",
  "cwd-missing": "El directorio de la Session ya no existe",
  "spawn-failed": "No se pudo iniciar el comando",
  /** The live window already lapsed (or it was never live) before this answer reached the Daemon. */
  "not-live": "Ya no está en vivo — pasó a pendiente",
  "invalid-answer": "Respuesta inválida",
  "invalid-body": "No se pudo enviar la respuesta",
  /** A repeat archive isn't a refusal — it rides the 200 instead, so there's no "already archived" entry here. */
  "not-ended": "Esa Session todavía no terminó",
};

/** The item closed from elsewhere (e.g. the CLI) between this tab's last SSE push and the click. Plain text body, never JSON — handled by status alone before any `res.json()` attempt. */
const NOT_FOUND_MESSAGE = "Ese ítem ya no está pendiente";

const SESSION_NOT_FOUND_MESSAGE = "Esa Session ya no existe";

const GENERIC_MESSAGE = (status: number): string => `No se pudo (${status})`;

/** Toasts fire only on confirmed success — never optimistically on click — so a refused write never shows a false "listo" alongside its error. */
const RESOLUTION_VERBS: Record<"run" | "done" | "dismiss", string> = {
  run: "corrido",
  done: "listo",
  dismiss: "descartado",
};

/** Display truncation only — never a collision-safe shortest-unique-prefix. */
const TOAST_ID_DISPLAY_LENGTH = 8;

function buildToastMessage(id: string, action: "run" | "done" | "dismiss"): string {
  return `✓ pedido #${id.slice(0, TOAST_ID_DISPLAY_LENGTH)} cerrado como ${RESOLUTION_VERBS[action]} — el agente no se entera`;
}

/**
 * Copied verbatim from `live.ts` rather than imported — importing it would drag server-only,
 * `node:fs`-backed code into the browser bundle. Kept in sync so a human reading the toast
 * sees the same words the agent reads when no message was typed.
 */
const GENERIC_REJECT_REASON_FOR_TOAST = "Rechazado por el humano — sin mensaje.";

/** Kept separate from `buildToastMessage`: an answer's wording doesn't fit the shared "cerrado como <verb>" template. */
function buildAnswerToastMessage(id: string, answer: "approve" | "reject", message: string | undefined): string {
  const shortId = id.slice(0, TOAST_ID_DISPLAY_LENGTH);
  if (answer === "approve") return `✓ #${shortId} aprobado — el agente sigue`;
  const shown = message && message.length > 0 ? message : GENERIC_REJECT_REASON_FOR_TOAST;
  return `✕ #${shortId} rechazado — el agente lee: "${shown}"`;
}

const TOAST_LIFETIME_MS = 2600;

export interface ToastViewModel {
  id: string;
  message: string;
}

/** Never called for 403 (handled separately via `staleToken`). A malformed or absent JSON body degrades to the generic message rather than throwing. */
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
  /** Drives the button's disabled/label state. */
  runningIds: ReadonlySet<string>;
  /** Combined stdout+stderr per item, keyed by id — cleared only when a new `run` starts for that same id. */
  outputs: Readonly<Record<string, string>>;
  /** The last non-ok, non-403 response any write for this item got — cleared on that id's next successful write. Distinct from a run's own in-stream failure trailer: this is "the write itself was refused," not "the write started and the command failed." */
  errors: Readonly<Record<string, string>>;
  /** True once any write 403s — the Daemon's token rotated (a restart) and this tab's cookie is stale. Never clears itself: reopening the view is the only fix. */
  staleToken: boolean;
  /** Every currently-visible toast, oldest first — each one drops itself after `TOAST_LIFETIME_MS`. */
  toasts: readonly ToastViewModel[];
  run(id: string): void;
  done(id: string): void;
  dismiss(id: string): void;
  /** `message` is the human's optional note, forwarded as the agent's own `additionalContext`. */
  approve(id: string, message?: string): void;
  /** `message` is the deny reason the agent reads; empty or omitted falls back to a generic one, never silently dropped. */
  reject(id: string, message?: string): void;
  /** `sessionId` is the owning Session's id, never the card's own id when the card is an Inbox item. Fire-and-forget: a focus action changes no derived state, so there's nothing for `/events` to push back either. */
  focusTerminal(sessionId: string): void;
  archive(sessionId: string): void;
}

function itemActionUrl(id: string, action: "run" | "done" | "dismiss" | "answer"): string {
  return `/items/${id}/${action}`;
}

function sessionActionUrl(id: string, action: "focus" | "archive"): string {
  return `/sessions/${id}/${action}`;
}

/**
 * Owns every write the board's action cards make, and the per-item state those writes
 * produce (streamed output, which ids are mid-run, a stale token, a per-item error).
 *
 * Whether a write actually changed anything is read back from `/events`, never from the
 * fetch response (ADR 0002: nothing is kept beside the logs) — except a refusal, which has
 * no SSE push to wait on since nothing changed, so it's surfaced from the response itself,
 * immediately.
 */
export function useInboxActions(): InboxActionsState {
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(new Set());
  const [outputs, setOutputs] = useState<Readonly<Record<string, string>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [staleToken, setStaleToken] = useState(false);
  const [toasts, setToasts] = useState<readonly ToastViewModel[]>([]);
  // Must never setState on a gone component once a fetch resolves after unmount — a plain
  // ref, not state, since nothing needs to render off this flag.
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

  /** Self-contained lifecycle: the removal timeout fires on its own, never dependent on a re-render to notice it. */
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

  /** Typed so the success branch can read `answer`/`message` straight back without re-parsing JSON or re-casting `unknown`. */
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
        // Only a refusal or 404 reaches here — `run`'s success path (a stream) never does —
        // so consuming the body here is safe.
        const message = await describeWriteError(res.clone());
        if (!unmountedRef.current) setErrors((prev) => ({ ...prev, [id]: message }));
      } else {
        clearError(id);
        // `done`/`dismiss` confirm success inline, in this response; `run` only confirms its
        // stream started — its own toast fires once the stream ends (below), never here.
        if (action === "done" || action === "dismiss") pushToast(buildToastMessage(id, action));
        // `body` is always defined for `answer` calls, but the guard stays defensive rather
        // than asserting it.
        else if (action === "answer" && body) pushToast(buildAnswerToastMessage(id, body.answer, body.message));
      }
      return res;
    },
    [],
  );

  /**
   * Kept separate from `post` rather than folded in: a different URL builder, a different
   * 404 wording, and neither needs a success toast — a focus action changes nothing derived
   * to toast about, and an archive is confirmed by the card simply leaving the board over
   * `/events`.
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
        // Accumulated locally, not read back from `outputs` state (which closes over a
        // stale value), so the toast check below has the complete text the instant the
        // stream ends.
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
          // A network drop mid-stream — the item's state is read back from `/events`
          // regardless, so there's nothing more to do here than stop showing it as running.
        } finally {
          // The stream ending with no failure trailer is `run`'s success signal — the only
          // way of saying "closed as done" short of re-deriving the Inbox.
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
