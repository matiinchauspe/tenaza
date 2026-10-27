import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useInboxActions } from "../../../src/ui/board/useInboxActions";

/** Same scoped happy-dom registration `hooks.test.tsx` already uses — needed here for React's own effect/state plumbing, never for anything DOM-specific this hook itself touches. */
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1/" });
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  cleanup();
});

/** One fake `fetch` call the test asserted on: method + URL, so a test can confirm `done`/`dismiss`/`run` hit the route ticket 09 actually defines. */
interface FetchCall {
  url: string;
  method: string | undefined;
}

function streamingResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

/** The exact shape `daemon.ts`'s refusal routes answer with (`Response.json({ error: "<kind>" }, { status })`). */
function refusalResponse(errorKind: string, status: number): Response {
  return new Response(JSON.stringify({ error: errorKind }), { status });
}

/** The exact (plain-text, NOT JSON) shape a 404 comes back as (`new Response("not found\n", { status: 404 })`). */
function notFoundResponse(): Response {
  return new Response("not found\n", { status: 404 });
}

describe("useInboxActions (ticket 09) — the view's own run/done/dismiss", () => {
  let calls: FetchCall[];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const call: FetchCall = { url: String(input), method: init?.method };
      calls.push(call);
      return await respond(call);
    }) as typeof fetch;
  }

  test("done POSTs /items/<id>/done", async () => {
    stubFetch(() => new Response(JSON.stringify({ outcome: "done", alreadyResolved: false })));
    const { result } = renderHook(() => useInboxActions());

    act(() => result.current.done("abc123"));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: "/items/abc123/done", method: "POST" });
  });

  test("dismiss POSTs /items/<id>/dismiss", async () => {
    stubFetch(() => new Response(JSON.stringify({ outcome: "dismissed", alreadyResolved: false })));
    const { result } = renderHook(() => useInboxActions());

    act(() => result.current.dismiss("abc123"));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: "/items/abc123/dismiss", method: "POST" });
  });

  test("run POSTs /items/<id>/run, marks the id running, then clears it once the stream ends", async () => {
    stubFetch(() => streamingResponse(["hola "]));
    const { result } = renderHook(() => useInboxActions());

    act(() => result.current.run("abc123"));
    expect(result.current.runningIds.has("abc123")).toBe(true);

    await waitFor(() => expect(result.current.runningIds.has("abc123")).toBe(false));
    expect(calls[0]).toEqual({ url: "/items/abc123/run", method: "POST" });
  });

  test("run accumulates every streamed chunk into outputs[id], in order", async () => {
    stubFetch(() => streamingResponse(["uno ", "dos ", "tres"]));
    const { result } = renderHook(() => useInboxActions());

    act(() => result.current.run("abc123"));

    await waitFor(() => expect(result.current.outputs["abc123"]).toBe("uno dos tres"));
  });

  test("a NEW run for the same id starts its output over, never appending to the previous run's", async () => {
    stubFetch(() => streamingResponse(["primera corrida"]));
    const { result } = renderHook(() => useInboxActions());

    act(() => result.current.run("abc123"));
    await waitFor(() => expect(result.current.outputs["abc123"]).toBe("primera corrida"));

    stubFetch(() => streamingResponse(["segunda"]));
    act(() => result.current.run("abc123"));

    await waitFor(() => expect(result.current.outputs["abc123"]).toBe("segunda"));
  });

  test("a 403 on done sets staleToken — the Daemon's token rotated and this tab's cookie is stale", async () => {
    stubFetch(() => new Response("forbidden\n", { status: 403 }));
    const { result } = renderHook(() => useInboxActions());

    expect(result.current.staleToken).toBe(false);
    act(() => result.current.done("abc123"));

    await waitFor(() => expect(result.current.staleToken).toBe(true));
  });

  test("a 403 on run also sets staleToken, and never shows a running state stuck forever", async () => {
    stubFetch(() => new Response("forbidden\n", { status: 403 }));
    const { result } = renderHook(() => useInboxActions());

    act(() => result.current.run("abc123"));

    await waitFor(() => expect(result.current.staleToken).toBe(true));
    await waitFor(() => expect(result.current.runningIds.has("abc123")).toBe(false));
  });

  test("two items can run independently — each keeps its own running flag and output", async () => {
    stubFetch(() => streamingResponse(["salida"]));
    const { result } = renderHook(() => useInboxActions());

    act(() => {
      result.current.run("one");
      result.current.run("two");
    });

    expect(result.current.runningIds.has("one")).toBe(true);
    expect(result.current.runningIds.has("two")).toBe(true);

    await waitFor(() => expect(result.current.runningIds.size).toBe(0));
    expect(result.current.outputs["one"]).toBe("salida");
    expect(result.current.outputs["two"]).toBe("salida");
  });
});

/**
 * Review fix: a non-ok, non-403 write response must surface a per-item
 * es-AR message — previously `run` silently returned on `!res.ok`, and
 * `done`/`dismiss` never looked at the response at all, so a 409/404 made
 * the click do nothing visible.
 */
describe("useInboxActions — non-403 write failures surface a per-item es-AR message (review fix)", () => {
  let calls: FetchCall[];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const call: FetchCall = { url: String(input), method: init?.method };
      calls.push(call);
      return await respond(call);
    }) as typeof fetch;
  }

  test("a 409 on run (already-resolved) sets a Spanish error for that item, never staleToken", async () => {
    stubFetch(() => refusalResponse("already-resolved", 409));
    const { result } = renderHook(() => useInboxActions());

    act(() => result.current.run("abc123"));

    await waitFor(() => expect(result.current.errors["abc123"]).toBe("Ya estaba cerrado"));
    expect(result.current.staleToken).toBe(false);
    expect(result.current.runningIds.has("abc123")).toBe(false);
  });

  test("a 409 on run (unblockable / YA CORRIÓ raced) maps to its own message", async () => {
    stubFetch(() => refusalResponse("unblockable", 409));
    const { result } = renderHook(() => useInboxActions());

    act(() => result.current.run("abc123"));

    await waitFor(() => expect(result.current.errors["abc123"]).toBe("Ya corrió — no se puede repetir"));
  });

  test("a 500 spawn-failed on run maps to its own message", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "spawn-failed", message: "ENOENT" }), { status: 500 }));
    const { result } = renderHook(() => useInboxActions());

    act(() => result.current.run("abc123"));

    await waitFor(() => expect(result.current.errors["abc123"]).toBe("No se pudo iniciar el comando"));
  });

  test("an unrecognized error kind falls back to the generic 'No se pudo (<status>)' message", async () => {
    stubFetch(() => refusalResponse("some-future-kind", 409));
    const { result } = renderHook(() => useInboxActions());

    act(() => result.current.run("abc123"));

    await waitFor(() => expect(result.current.errors["abc123"]).toBe("No se pudo (409)"));
  });

  test("a 404 on run — plain text body, never JSON — maps to 'Ese ítem ya no está pendiente'", async () => {
    stubFetch(() => notFoundResponse());
    const { result } = renderHook(() => useInboxActions());

    act(() => result.current.run("abc123"));

    await waitFor(() => expect(result.current.errors["abc123"]).toBe("Ese ítem ya no está pendiente"));
  });

  test("a 404 on done surfaces the same message — previously done() ignored the response entirely", async () => {
    stubFetch(() => notFoundResponse());
    const { result } = renderHook(() => useInboxActions());

    act(() => result.current.done("abc123"));

    await waitFor(() => expect(result.current.errors["abc123"]).toBe("Ese ítem ya no está pendiente"));
    expect(calls[0]).toEqual({ url: "/items/abc123/done", method: "POST" });
  });

  test("a 409 on dismiss (already-resolved) surfaces its message too", async () => {
    stubFetch(() => refusalResponse("already-resolved", 409));
    const { result } = renderHook(() => useInboxActions());

    act(() => result.current.dismiss("abc123"));

    await waitFor(() => expect(result.current.errors["abc123"]).toBe("Ya estaba cerrado"));
  });

  test("a SUCCESSFUL write clears a previous error for the same item", async () => {
    stubFetch(() => refusalResponse("already-resolved", 409));
    const { result } = renderHook(() => useInboxActions());
    act(() => result.current.done("abc123"));
    await waitFor(() => expect(result.current.errors["abc123"]).toBe("Ya estaba cerrado"));

    stubFetch(() => new Response(JSON.stringify({ outcome: "dismissed", alreadyResolved: false })));
    act(() => result.current.dismiss("abc123"));

    await waitFor(() => expect(result.current.errors["abc123"]).toBeUndefined());
  });

  test("errors for different items never cross-contaminate", async () => {
    // NOTE: matches on the ITEM ID segment specifically (`/items/<id>/`),
    // never a bare substring check — "done" itself contains "one" ("d-ONE"),
    // which silently misrouted this fixture before this fix.
    stubFetch((call) =>
      call.url.startsWith("/items/one/") ? refusalResponse("already-resolved", 409) : notFoundResponse(),
    );
    const { result } = renderHook(() => useInboxActions());

    act(() => {
      result.current.done("one");
      result.current.done("two");
    });

    await waitFor(() => {
      expect(result.current.errors["one"]).toBe("Ya estaba cerrado");
      expect(result.current.errors["two"]).toBe("Ese ítem ya no está pendiente");
    });
  });
});
