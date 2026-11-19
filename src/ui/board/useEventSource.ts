import { useEffect, useState } from "react";
import { parseBoardPayload, type BoardPayload } from "../../contract/live";

export type ConnectionState = "connecting" | "open" | "closed";

export interface BoardEventSourceState {
  payload: BoardPayload | undefined;
  connectionState: ConnectionState;
}

/** Minimal shape so a test can inject a fake constructor without implementing the whole DOM `EventSource` interface. */
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
 * A parse error never drops or crashes the board: it warns once and keeps the last good
 * payload rather than clearing it. The browser's own `EventSource` already handles
 * reconnects; this hook only tracks what state that leaves the board in.
 *
 * `EventSourceImpl` is a constructor-injection seam rather than an env var, since a hook has
 * no process environment to read from.
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
