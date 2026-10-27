import { useEffect, useState } from "react";
import { parseBoardPayload, type BoardPayload } from "../../contract/live";

export type ConnectionState = "connecting" | "open" | "closed";

export interface BoardEventSourceState {
  payload: BoardPayload | undefined;
  connectionState: ConnectionState;
}

/** The minimal shape this hook actually drives — small enough that a test can hand it a fake constructor without implementing the whole DOM `EventSource` interface (same spirit as `daemon.ts`'s own injectable `openBrowser`/notifier test seams). */
export interface EventSourceLike {
  close(): void;
  readyState: number;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}
export type EventSourceConstructor = new (url: string) => EventSourceLike;

const CLOSED_READY_STATE = 2;

/**
 * Wraps the SSE connection to `/events` (ticket 08): connection state for
 * the live dot, and a parse error that NEVER drops or crashes the board —
 * it warns once and keeps the LAST GOOD payload, never `undefined`ing it
 * out from under the board once one has arrived. The browser's own
 * `EventSource` already reconnects on a dropped connection; this hook only
 * tracks what state that leaves the board in.
 *
 * `EventSourceImpl` is a constructor-injection test seam, never read from
 * the environment: a hook has no server process to set an env var for, so
 * it takes its fake the same way any other collaborator would — as a
 * parameter, defaulting to the real global.
 */
export function useEventSource(
  url: string,
  EventSourceImpl: EventSourceConstructor = globalThis.EventSource as unknown as EventSourceConstructor,
): BoardEventSourceState {
  const [payload, setPayload] = useState<BoardPayload | undefined>(undefined);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");

  useEffect(() => {
    const source = new EventSourceImpl(url);

    source.onopen = () => setConnectionState("open");
    source.onerror = () => {
      setConnectionState(source.readyState === CLOSED_READY_STATE ? "closed" : "connecting");
    };
    source.onmessage = (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        console.warn("tenaza: SSE frame was not valid JSON — keeping the last good board state");
        return;
      }
      const parsed = parseBoardPayload(raw);
      if (!parsed) {
        console.warn("tenaza: SSE frame did not match the board contract — keeping the last good board state");
        return;
      }
      setPayload(parsed);
    };

    return () => {
      source.close();
    };
  }, [url, EventSourceImpl]);

  return { payload, connectionState };
}
