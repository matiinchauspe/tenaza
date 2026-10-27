import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { BoardApp } from "../../../src/ui/board/BoardApp";
import { makeBoardPayload, makeInboxItem, makeSession } from "../../support/boardFixture";

/** Same scoped happy-dom registration every other effectful UI test file already uses — `BoardApp` owns real effects (`EventSource`, `setInterval`, `addEventListener`) that need a real DOM to attach to. */
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1/" });
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  cleanup();
});

/**
 * A minimal `EventSource` stand-in, same shape `hooks.test.tsx`'s own
 * `FakeEventSource` already establishes for `useEventSource` — redefined
 * here (not imported; that one isn't exported) rather than widening that
 * file's own exports for a single new consumer. Installed on
 * `globalThis.EventSource` BEFORE each render, since `BoardApp` itself
 * calls `useEventSource(EVENTS_URL)` with no injected constructor — the
 * hook's own default parameter reads the GLOBAL at call time, so patching
 * it here (not passing a constructor through `BoardApp`'s props, which
 * don't have one) is the only seam available to a container-level test.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = 2;
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function installFakeEventSource(): void {
  FakeEventSource.instances = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = FakeEventSource;
}

function currentSource(): FakeEventSource {
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!source) throw new Error("BoardApp never constructed an EventSource");
  return source;
}

/**
 * Ticket 12 follow-up (verified finding #2 from the prior run): keyboard
 * `a` on a live Session card used to pass the SESSION's own id to
 * `actions.approve`, which POSTs `/items/<id>/answer` — an ITEM-hash
 * route. The mouse-click buttons in `SessionCard.tsx`'s own
 * `LiveRequestBlock` always used `liveRequest.id` correctly; only the
 * board-level `a` keyboard shortcut (`BoardApp.tsx`'s own
 * `liveRequestSessionIds`-gated `onApprove`) forwarded the wrong id.
 */
describe("BoardApp — keyboard 'a' on a live Session card (ticket 12 follow-up)", () => {
  test("a targets the live item's OWN id for /items/<id>/answer, never the Session's id", async () => {
    installFakeEventSource();
    const calls: { url: string; body: string | undefined }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body as string | undefined });
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch;

    try {
      render(<BoardApp />);
      const source = currentSource();
      const now = new Date();

      act(() => {
        source.emit(
          makeBoardPayload({
            sessions: [makeSession({ id: "sess-1", ticket: "RES-131", lastEventTs: now.toISOString() })],
            inbox: [
              makeInboxItem({
                id: "item-hash-abc123",
                sessionId: "sess-1",
                ts: now.toISOString(),
                decision: "held",
              }),
            ],
          }),
        );
      });

      // Select the only card on the board (the Session's own — the live
      // item renders ON it, never as its own TE NECESITA card) then press
      // the approve shortcut.
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
      });
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      });

      // `approve` fires a fetch asynchronously inside `useInboxActions` —
      // flush microtasks before asserting.
      await act(async () => {
        await Promise.resolve();
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("/items/item-hash-abc123/answer");
      expect(calls[0]?.url).not.toContain("sess-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
