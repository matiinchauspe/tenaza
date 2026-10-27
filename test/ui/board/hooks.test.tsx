import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { EventSourceConstructor, EventSourceLike } from "../../../src/ui/board/useEventSource";
import { useEventSource } from "../../../src/ui/board/useEventSource";
import { boardCardElementId, useBoardKeyboard } from "../../../src/ui/board/useBoardKeyboard";

/**
 * This whole file needs a real `window`/`document` for React's effects
 * (`addEventListener`, `EventSource`) to attach to — `happy-dom`,
 * registered ONLY for this file's run (`beforeAll`/`afterAll`), never
 * globally via `bunfig.toml`'s preload. Scoping it this tightly is
 * deliberate: the server test suite drives REAL `fetch` against a REAL
 * Daemon process, and a global happy-dom registration would risk shadowing
 * Bun's own `fetch`/`URL`/etc. for every OTHER test file in the same
 * process. Verified empirically before this file was built out: the full
 * suite (daemon.test.ts included) still passes with this scoped
 * register/unregister in place.
 */
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1/" });
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  cleanup();
});

describe("useBoardKeyboard", () => {
  function dispatchKey(target: EventTarget, key: string): void {
    act(() => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  }

  test("j moves the selection down from none to the first id", () => {
    const { result } = renderHook(() => useBoardKeyboard(["a", "b", "c"]));
    expect(result.current.selectedId).toBeUndefined();

    dispatchKey(window, "j");
    expect(result.current.selectedId).toBe("a");
  });

  test("j then k returns to the first id (bounds: k never goes before the first)", () => {
    const { result } = renderHook(() => useBoardKeyboard(["a", "b", "c"]));
    dispatchKey(window, "j"); // -> a
    dispatchKey(window, "j"); // -> b
    dispatchKey(window, "k"); // -> a
    expect(result.current.selectedId).toBe("a");
    dispatchKey(window, "k"); // clamps at the first id
    expect(result.current.selectedId).toBe("a");
  });

  test("j clamps at the last id — it never wraps", () => {
    const { result } = renderHook(() => useBoardKeyboard(["a", "b"]));
    dispatchKey(window, "j"); // -> a
    dispatchKey(window, "j"); // -> b
    dispatchKey(window, "j"); // clamps at b
    expect(result.current.selectedId).toBe("b");
  });

  test("a click (select()) sets the selection directly", () => {
    const { result } = renderHook(() => useBoardKeyboard(["a", "b"]));
    act(() => result.current.select("b"));
    expect(result.current.selectedId).toBe("b");
  });

  test("j/k are IGNORED when the event's target is a text input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      const { result } = renderHook(() => useBoardKeyboard(["a", "b"]));
      dispatchKey(input, "j");
      expect(result.current.selectedId).toBeUndefined();
    } finally {
      input.remove();
    }
  });

  test("selection stays valid when the list changes under it: a selected id that disappears snaps to the first remaining id", () => {
    const { result, rerender } = renderHook(({ ids }) => useBoardKeyboard(ids), {
      initialProps: { ids: ["a", "b", "c"] },
    });
    act(() => result.current.select("b"));
    expect(result.current.selectedId).toBe("b");

    rerender({ ids: ["a", "c"] }); // "b" resolved and dropped out of the list
    expect(result.current.selectedId).toBe("a");
  });

  test("focus follows selection: j moves REAL DOM focus to the matching card element, not just aria-selected", () => {
    const cardA = document.createElement("li");
    cardA.id = boardCardElementId("a");
    cardA.tabIndex = -1;
    const cardB = document.createElement("li");
    cardB.id = boardCardElementId("b");
    cardB.tabIndex = -1;
    document.body.append(cardA, cardB);

    try {
      renderHook(() => useBoardKeyboard(["a", "b"]));
      dispatchKey(window, "j");
      expect(document.activeElement).toBe(cardA);

      dispatchKey(window, "j");
      expect(document.activeElement).toBe(cardB);
    } finally {
      cardA.remove();
      cardB.remove();
    }
  });

  test("selection is left alone when the list changes but the selected id still exists", () => {
    const { result, rerender } = renderHook(({ ids }) => useBoardKeyboard(ids), {
      initialProps: { ids: ["a", "b", "c"] },
    });
    act(() => result.current.select("b"));

    rerender({ ids: ["x", "b", "y"] }); // reshuffled, but "b" is still there
    expect(result.current.selectedId).toBe("b");
  });

  describe("d/x dispatch against the CURRENT selection (ticket 09)", () => {
    test("d calls onDone with the currently selected id", () => {
      const done: string[] = [];
      const { result } = renderHook(() => useBoardKeyboard(["a", "b"], { onDone: (id) => done.push(id) }));
      act(() => result.current.select("b"));

      dispatchKey(window, "d");

      expect(done).toEqual(["b"]);
    });

    test("x calls onDismiss with the currently selected id", () => {
      const dismissed: string[] = [];
      const { result } = renderHook(() => useBoardKeyboard(["a", "b"], { onDismiss: (id) => dismissed.push(id) }));
      act(() => result.current.select("a"));

      dispatchKey(window, "x");

      expect(dismissed).toEqual(["a"]);
    });

    test("d/x with no selection calls nothing — there is no id to act on", () => {
      const done: string[] = [];
      renderHook(() => useBoardKeyboard(["a", "b"], { onDone: (id) => done.push(id) }));

      dispatchKey(window, "d");

      expect(done).toEqual([]);
    });

    test("d/x are ignored when the event's target is a text input, same as j/k", () => {
      const input = document.createElement("input");
      document.body.appendChild(input);
      try {
        const done: string[] = [];
        const { result } = renderHook(() => useBoardKeyboard(["a", "b"], { onDone: (id) => done.push(id) }));
        act(() => result.current.select("a"));

        dispatchKey(input, "d");

        expect(done).toEqual([]);
      } finally {
        input.remove();
      }
    });

    test("omitting actions entirely never throws on d/x — the hook's second argument stays optional", () => {
      const { result } = renderHook(() => useBoardKeyboard(["a", "b"]));
      act(() => result.current.select("a"));

      expect(() => dispatchKey(window, "d")).not.toThrow();
      expect(() => dispatchKey(window, "x")).not.toThrow();
    });
  });
});

/** A fully scriptable `EventSource` stand-in (ticket 08's own "fake EventSource" requirement) — never a real network connection. */
class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data });
  }

  emitError(readyState: number): void {
    this.readyState = readyState;
    this.onerror?.();
  }
}

const FakeEventSourceCtor = FakeEventSource as unknown as EventSourceConstructor;

const GOOD_PAYLOAD = JSON.stringify({
  v: 1,
  policy: { stallMinutes: 15, contextThresholdTokens: 200_000 },
  sessions: [],
  inbox: [],
});

describe("useEventSource", () => {
  afterEach(() => {
    FakeEventSource.instances = [];
  });

  test("starts connecting, then open once the source fires onopen", () => {
    const { result } = renderHook(() => useEventSource("/events", FakeEventSourceCtor));
    expect(result.current.connectionState).toBe("connecting");

    const source = FakeEventSource.instances[0]!;
    act(() => source.emitOpen());
    expect(result.current.connectionState).toBe("open");
  });

  test("a valid frame updates the payload", () => {
    const { result } = renderHook(() => useEventSource("/events", FakeEventSourceCtor));
    const source = FakeEventSource.instances[0]!;

    act(() => source.emitMessage(GOOD_PAYLOAD));
    expect(result.current.payload).toEqual(JSON.parse(GOOD_PAYLOAD));
  });

  test("a frame that is not valid JSON NEVER crashes and keeps the last good payload", () => {
    const { result } = renderHook(() => useEventSource("/events", FakeEventSourceCtor));
    const source = FakeEventSource.instances[0]!;

    act(() => source.emitMessage(GOOD_PAYLOAD));
    const before = result.current.payload;

    expect(() => act(() => source.emitMessage("{not json"))).not.toThrow();
    expect(result.current.payload).toBe(before);
  });

  test("a frame that is valid JSON but fails the BoardPayload contract keeps the last good payload too", () => {
    const { result } = renderHook(() => useEventSource("/events", FakeEventSourceCtor));
    const source = FakeEventSource.instances[0]!;

    act(() => source.emitMessage(GOOD_PAYLOAD));
    const before = result.current.payload;

    act(() => source.emitMessage(JSON.stringify({ not: "a board payload" })));
    expect(result.current.payload).toBe(before);
  });

  test("onerror while CLOSED reads as closed; onerror otherwise reads as reconnecting", () => {
    const { result } = renderHook(() => useEventSource("/events", FakeEventSourceCtor));
    const source = FakeEventSource.instances[0]!;

    act(() => source.emitError(0)); // CONNECTING — the browser will retry
    expect(result.current.connectionState).toBe("connecting");

    act(() => source.emitError(2)); // CLOSED — no more retries
    expect(result.current.connectionState).toBe("closed");
  });

  /**
   * Ticket 08 fix (orchestrator review): the live dot must recover ON ITS
   * OWN after a Daemon restart — `/events` is an open read (no token), so
   * the browser's NATIVE `EventSource` retry is the whole mechanism; this
   * hook never recreates the source or runs any reconnect logic of its
   * own, it only reflects what the SAME instance reports. Covers the full
   * cycle a restart puts a real `EventSource` through: open -> error while
   * CONNECTING (the browser dropped and is retrying) -> connecting ->
   * onopen (the retry succeeded) -> open again — and a fresh payload sent
   * after the Daemon comes back up still flows through the SAME message
   * handler, proving reconnection does not need the hook to rewire
   * anything.
   */
  test("recovers on its own after a connection drop: open -> error(CONNECTING) -> connecting -> open again, with payload flowing after reconnect", () => {
    const { result } = renderHook(() => useEventSource("/events", FakeEventSourceCtor));
    const source = FakeEventSource.instances[0]!;

    act(() => source.emitOpen());
    expect(result.current.connectionState).toBe("open");

    act(() => source.emitMessage(GOOD_PAYLOAD));
    expect(result.current.payload).toEqual(JSON.parse(GOOD_PAYLOAD));

    // The Daemon restarts: the browser drops to CONNECTING (readyState 0)
    // and starts its own automatic retry.
    act(() => source.emitError(0));
    expect(result.current.connectionState).toBe("connecting");
    // Still the SAME EventSource instance — nothing in the hook tore it
    // down and built a new one; the browser's native retry is the whole
    // recovery mechanism.
    expect(FakeEventSource.instances.length).toBe(1);

    // The retry succeeds on its own.
    act(() => source.emitOpen());
    expect(result.current.connectionState).toBe("open");

    // A fresh payload pushed after the Daemon is back up still reaches the
    // board — the message handler was never detached across the drop.
    const payloadAfterReconnect = JSON.stringify({
      v: 1,
      policy: { stallMinutes: 15, contextThresholdTokens: 200_000 },
      sessions: [{ id: "s1", project: "tenaza", role: "sesión", hasMeasureCapability: false }],
      inbox: [],
    });
    act(() => source.emitMessage(payloadAfterReconnect));
    expect(result.current.payload).toEqual(JSON.parse(payloadAfterReconnect));
  });

  test("unmounting closes the underlying source", () => {
    const { unmount } = renderHook(() => useEventSource("/events", FakeEventSourceCtor));
    const source = FakeEventSource.instances[0]!;
    expect(source.closed).toBe(false);

    unmount();
    expect(source.closed).toBe(true);
  });
});
