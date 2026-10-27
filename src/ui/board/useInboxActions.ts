import { useCallback, useEffect, useRef, useState } from "react";

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
};

/** 404 — the item doesn't exist UNDER THIS id any more (closed from elsewhere, e.g. the CLI, between this tab's last SSE push and the click). Plain text body (`daemon.ts`'s `new Response("not found\n", ...)`), never JSON — handled by status alone, before any `res.json()` attempt. */
const NOT_FOUND_MESSAGE = "Ese ítem ya no está pendiente";

const GENERIC_MESSAGE = (status: number): string => `No se pudo (${status})`;

/**
 * A non-ok, NON-403 write response → its short es-AR message (review fix:
 * "surface a per-item es-AR message... for any non-ok, non-403 response").
 * 403 is handled separately (`staleToken`, below) — this is never called
 * for it. Reads the body only when the status is one `daemon.ts` is known
 * to answer with JSON on (409/422/500); a malformed or absent JSON body
 * still degrades to the generic message rather than throwing.
 */
async function describeWriteError(res: Response): Promise<string> {
  if (res.status === NOT_FOUND_STATUS) return NOT_FOUND_MESSAGE;
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
  run(id: string): void;
  done(id: string): void;
  dismiss(id: string): void;
}

function itemActionUrl(id: string, action: "run" | "done" | "dismiss"): string {
  return `/items/${id}/${action}`;
}

/**
 * Owns every write the board's action cards make (ticket 09) — `run`,
 * `done`, `dismiss` — and the per-item state those writes produce
 * (streamed output, which ids are mid-run, whether this tab's token has
 * gone stale, and now a per-item error message for a refused write). The
 * container (`BoardApp`) calls this and hands the result down; `InboxCard`
 * itself stays pure presentational, exactly as ticket 08 left it.
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
  // A fetch that resolves after this hook's owner unmounts (e.g. the board
  // re-renders away mid-stream) must never call `setState` on a gone
  // component — a plain ref, not state, since nothing ever needs to
  // RENDER off this flag.
  const unmountedRef = useRef(false);
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
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

  const post = useCallback(async (id: string, action: "run" | "done" | "dismiss"): Promise<Response> => {
    const res = await fetch(itemActionUrl(id, action), { method: "POST" });
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
    }
    return res;
  }, []);

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

  const run = useCallback(
    (id: string) => {
      setRunningIds((prev) => new Set(prev).add(id));
      setOutputs((prev) => ({ ...prev, [id]: "" }));

      void (async () => {
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
            if (unmountedRef.current) continue;
            setOutputs((prev) => ({ ...prev, [id]: (prev[id] ?? "") + chunk }));
          }
        } catch {
          // A network drop mid-stream — the item's own state (closed or
          // still open) is read back from `/events` regardless; nothing
          // more to do here than stop showing it as running.
        } finally {
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

  return { runningIds, outputs, errors, staleToken, run, done, dismiss };
}
