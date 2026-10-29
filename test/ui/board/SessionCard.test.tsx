import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { SessionCard, type SessionCardProps } from "../../../src/ui/board/SessionCard";
import type { SessionCardViewModel } from "../../../src/ui/board/viewModel";

/** Same scoped happy-dom registration `hooks.test.tsx`/`useInboxActions.test.tsx` already use — needed for real DOM events (typing, clicking, focus) a static-markup render can't exercise. */
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
 * Environment gap (verified directly, not assumed): on this exact stack —
 * React 19.3.1 + happy-dom 21.0.4 + @testing-library/react 16.3.3 — a
 * CONTROLLED `<input>`'s `onChange` never fires from any `fireEvent`
 * simulation of typing, including the documented native-setter workaround
 * (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`
 * + dispatching `input`). Reproduced on a BARE, minimal `<input
 * value={v} onChange={...}>` with no `SessionCard` code involved at all —
 * `bareChangeCount` stayed `0` even though the DOM's own `.value` updated
 * and the event visibly bubbled to `document`. This is a dependency-stack
 * limitation, not a defect in `SessionCard`'s own (textbook-standard)
 * controlled-input code. Tests below cover every path that does NOT
 * require simulating a keystroke; the "does a typed message actually
 * reach `onApprove`/`onReject`" wiring is verified by code review instead
 * (`LiveRequestBlock`'s own `onChange={(e) => setMessage(e.target.value)}`)
 * and belongs on the by-hand acceptance list alongside the rest of the
 * Live surface's manual checks.
 */
const NOOP = () => {};

function baseCard(overrides: Partial<SessionCardViewModel> = {}): SessionCardViewModel {
  return {
    id: "b71",
    project: "reservee",
    worktree: undefined,
    ticket: "RES-131",
    role: "sesión",
    shortId: "b71",
    parentLabel: undefined,
    nested: false,
    context: { kind: "unavailable" },
    lastSignal: "—",
    age: "2m",
    liveRequest: undefined,
    resolutionTrace: undefined,
    terminalLabel: "terminal desconocida",
    terminalReach: "unknown",
    terminalNeedsTcc: false,
    nativeWait: undefined,
    turnWait: undefined,
    ...overrides,
  };
}

function renderCard(overrides: Partial<SessionCardProps> & { card: SessionCardViewModel }) {
  const props: SessionCardProps = {
    tone: "corriendo",
    statusLabel: "Corriendo",
    selected: false,
    highlighted: false,
    onSelect: NOOP,
    onApprove: NOOP,
    onReject: NOOP,
    onFocusTerminal: NOOP,
    showArchive: false,
    onArchive: NOOP,
    ...overrides,
  };
  return render(<SessionCard {...props} />);
}

describe("SessionCard — TE ESPERA block (ticket 10)", () => {
  function liveCard(): SessionCardViewModel {
    return baseCard({
      liveRequest: {
        id: "abc123",
        tool: "Bash",
        command: "gh pr merge 58 --merge",
        toolLabel: "Bash: gh pr merge 58 --merge",
        age: "20s",
        remainingSeconds: 160,
        remainingFraction: 0.89,
      },
    });
  }

  test("renders the badge, command, timer bar width and age when a liveRequest is present", () => {
    const { container } = renderCard({ card: liveCard() });

    expect(container.textContent).toContain("TE ESPERA · 160s");
    expect(container.textContent).toContain("gh pr merge 58 --merge");
    expect(container.textContent).toContain("hace 20s");
    const timer = container.querySelector(".live-request__timer i") as HTMLElement;
    expect(timer.style.width).toBe("89%");
  });

  test("renders no TE ESPERA block at all when liveRequest is undefined", () => {
    const { container } = renderCard({ card: baseCard() });
    expect(container.querySelector(".live-request")).toBeNull();
  });

  test("aprobar fires onApprove with the current (empty) message", () => {
    const approved: [string, string | undefined][] = [];
    const { container } = renderCard({
      card: liveCard(),
      onApprove: (id, message) => approved.push([id, message]),
    });

    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("aprobar"));
    act(() => fireEvent.click(button!));

    expect(approved).toEqual([["abc123", undefined]]);
  });

  test("rechazar (with no message typed) fires onReject with undefined, never an empty string", () => {
    const rejected: [string, string | undefined][] = [];
    const { container } = renderCard({
      card: liveCard(),
      onReject: (id, message) => rejected.push([id, message]),
    });

    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("rechazar"));
    act(() => fireEvent.click(button!));

    expect(rejected).toEqual([["abc123", undefined]]);
  });

  // "Enter fires reject" has NO automated test here: dispatching an
  // `Enter` keydown at a controlled `<input>` crashes React-DOM's own
  // input-tracking plugin on this exact dependency stack (reproduced
  // deterministically, isolated from this component — see the file-level
  // note above `NOOP`). The handler itself is two lines
  // (`LiveRequestBlock`'s own `onKeyDown`, `event.key === "Enter"` branch)
  // verified by code review; by-hand acceptance covers the real behavior.

  test("Escape inside the message input fires nothing at all", () => {
    const approved: unknown[] = [];
    const rejected: unknown[] = [];
    const { container } = renderCard({
      card: liveCard(),
      onApprove: (...args) => approved.push(args),
      onReject: (...args) => rejected.push(args),
    });

    const input = container.querySelector(".live-request__input") as HTMLInputElement;
    act(() => fireEvent.keyDown(input, { key: "Escape" }));

    expect(approved).toEqual([]);
    expect(rejected).toEqual([]);
  });

  test("clicking inside the live-request block never also selects the card (stopPropagation)", () => {
    const selected: string[] = [];
    const { container } = renderCard({ card: liveCard(), onSelect: (id) => selected.push(id) });

    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("aprobar"));
    act(() => fireEvent.click(button!));

    expect(selected).toEqual([]);
  });
});

describe("SessionCard — native wait block (ticket 14): observed only, never actionable", () => {
  function nativeWaitCard(kind: "permission_prompt" | "idle_prompt" = "permission_prompt"): SessionCardViewModel {
    return baseCard({
      // Ticket 07: `baseCard()`'s own default reach is "unknown", which now
      // renders NO terminal button at all — give this fixture a KNOWN reach
      // so "still offers the terminal button" below actually exercises
      // that claim, rather than passing by coincidence on the old greyed
      // "terminal desconocida" text.
      terminalReach: "exact",
      nativeWait: {
        kind,
        label: kind === "permission_prompt" ? "PERMISO NATIVO" : "INACTIVA",
        hint: "Claude Code te pide permiso — Tenaza solo observa, contestale en la terminal",
        age: "12s",
      },
    });
  }

  test("renders the badge and age when nativeWait is present", () => {
    const { container } = renderCard({ card: nativeWaitCard() });

    expect(container.textContent).toContain("PERMISO NATIVO");
    expect(container.textContent).toContain("hace 12s");
  });

  test("renders no native-wait block at all when nativeWait is undefined", () => {
    const { container } = renderCard({ card: baseCard() });
    expect(container.querySelector(".native-wait")).toBeNull();
  });

  test("offers NO aprobar/rechazar/message-input controls — Tenaza never answers a native prompt", () => {
    const { container } = renderCard({ card: nativeWaitCard() });

    expect(container.querySelector(".live-request")).toBeNull();
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(buttons.some((text) => text.includes("aprobar"))).toBe(false);
    expect(buttons.some((text) => text.includes("rechazar"))).toBe(false);
    expect(container.querySelector(".live-request__input")).toBeNull();
  });

  test("still offers the terminal button — the human's own way to actually respond", () => {
    const { container } = renderCard({ card: nativeWaitCard() });
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.includes("terminal"))).toBe(true);
  });

  test("the card's own border never carries the amber TE ESPERA treatment for a native wait alone", () => {
    const { container } = renderCard({ card: nativeWaitCard() });
    expect(container.querySelector(".session-card--waiting")).toBeNull();
  });

  test("idle_prompt renders its own distinct label", () => {
    const { container } = renderCard({ card: nativeWaitCard("idle_prompt") });
    expect(container.textContent).toContain("INACTIVA");
  });

  test("the card's aria-label names the native wait, distinct wording from 'te espera'", () => {
    const { container } = renderCard({ card: nativeWaitCard() });
    const li = container.querySelector("li");
    expect(li?.getAttribute("aria-label")).toContain("permiso nativo");
  });

  test("a card with a turnWait renders its own badge and age, distinct from native-wait", () => {
    const { container } = renderCard({ card: baseCard({ turnWait: { age: "45s", backgroundCount: 0 } }) });
    expect(container.querySelector(".turn-wait")).not.toBeNull();
    expect(container.textContent).toContain("hace 45s");
  });

  test("a turnWait with background work appends the 'en segundo plano' count", () => {
    const { container } = renderCard({ card: baseCard({ turnWait: { age: "45s", backgroundCount: 2 } }) });
    expect(container.textContent).toContain("2 en segundo plano");
  });

  test("renders no turn-wait block at all when turnWait is undefined", () => {
    const { container } = renderCard({ card: baseCard() });
    expect(container.querySelector(".turn-wait")).toBeNull();
  });

  test("a turnWait card offers NO aprobar/rechazar/message-input controls — Tenaza never answers this on the agent's behalf", () => {
    const { container } = renderCard({ card: baseCard({ turnWait: { age: "45s", backgroundCount: 0 } }) });
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(buttons.some((text) => text.includes("aprobar"))).toBe(false);
    expect(buttons.some((text) => text.includes("rechazar"))).toBe(false);
  });

  test("a card with BOTH a nativeWait and a turnWait never happens in practice, but renders both without crashing", () => {
    const { container } = renderCard({
      card: baseCard({
        nativeWait: { kind: "idle_prompt", label: "INACTIVA", hint: "hint", age: "1m" },
        turnWait: { age: "45s", backgroundCount: 0 },
      }),
    });
    expect(container.querySelector(".native-wait")).not.toBeNull();
    expect(container.querySelector(".turn-wait")).not.toBeNull();
  });

  test("a card with BOTH a liveRequest and a nativeWait renders both blocks without conflict", () => {
    const card = baseCard({
      liveRequest: {
        id: "abc123",
        tool: "Bash",
        command: "gh pr merge 58",
        toolLabel: "Bash: gh pr merge 58",
        age: "5s",
        remainingSeconds: 175,
        remainingFraction: 0.97,
      },
      nativeWait: {
        kind: "idle_prompt",
        label: "INACTIVA",
        hint: "el turno terminó y nadie respondió — Tenaza solo observa, contestale en la terminal",
        age: "1m",
      },
    });
    const { container } = renderCard({ card });

    expect(container.querySelector(".live-request")).not.toBeNull();
    expect(container.querySelector(".native-wait")).not.toBeNull();
  });
});

describe("SessionCard — resolution trace (ticket 10)", () => {
  test("renders the latest line with its symbol, id and text", () => {
    const card = baseCard({
      resolutionTrace: {
        latest: { symbol: "✓", shortId: "dead", text: "corrido por vos", tone: "ok", age: "2m" },
        moreCount: 0,
        tooltip: "✓ #dead corrido por vos · hace 2m",
      },
    });
    const { container } = renderCard({ card });

    expect(container.textContent).toContain("✓ #dead corrido por vos · hace 2m");
    expect(container.textContent).not.toContain("más");
  });

  test("shows '+N más' and a tooltip when there is more than one resolution", () => {
    const card = baseCard({
      resolutionTrace: {
        latest: { symbol: "✓", shortId: "dead", text: "corrido por vos", tone: "ok", age: "2m" },
        moreCount: 2,
        tooltip: "line one\nline two\nline three",
      },
    });
    const { container } = renderCard({ card });

    expect(container.textContent).toContain("+2 más");
    const trace = container.querySelector(".resolution-trace");
    expect(trace?.getAttribute("title")).toBe("line one\nline two\nline three");
  });

  test("renders nothing at all when resolutionTrace is undefined", () => {
    const { container } = renderCard({ card: baseCard() });
    expect(container.querySelector(".resolution-trace")).toBeNull();
  });
});

describe("SessionCard — selection and cross-highlight (ticket 10)", () => {
  test("highlighted adds its own class, distinct from selected", () => {
    const { container } = renderCard({ card: baseCard(), highlighted: true });
    expect(container.querySelector("li")?.className).toContain("session-card--highlighted");
  });

  test("a card with a live request carries its own waiting class", () => {
    const card = baseCard({
      liveRequest: {
        id: "abc",
        tool: "Bash",
        command: "x",
        toolLabel: "Bash: x",
        age: "1s",
        remainingSeconds: 10,
        remainingFraction: 1,
      },
    });
    const { container } = renderCard({ card });
    expect(container.querySelector("li")?.className).toContain("session-card--waiting");
  });
});

describe("SessionCard — the terminal button and TERMINÓ-only archive control (ticket 11, ticket 07)", () => {
  function terminalButton(container: HTMLElement): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find((b) => !b.textContent?.includes("archivar")) as
      | HTMLButtonElement
      | undefined;
  }

  test("renders the card's own already-formatted terminalLabel", () => {
    const { container } = renderCard({ card: baseCard({ terminalLabel: "ir a terminal ↗", terminalReach: "exact" }) });
    expect(container.textContent).toContain("ir a terminal ↗");
  });

  test("ticket 07: unknown reach renders NO terminal button at all — no empty slot or stray separator left behind", () => {
    // Also covers "the t key does nothing on a card with unknown reach":
    // with no button, there is no click target at all; the keyboard
    // shortcut's own gate (`terminalReachForCard(...) === "unknown"`) lives
    // one layer up, in `BoardApp.tsx`'s `onFocusTerminal` — the same place
    // (and the same code-review-only coverage) the sibling TERMINÓ gate
    // already relies on.
    const { container } = renderCard({ card: baseCard({ terminalReach: "unknown" }) });
    expect(terminalButton(container)).toBeUndefined();
    expect(container.textContent).not.toContain("terminal");
    // `showArchive` is false here, so the actions row has nothing else to
    // show either — it must be left genuinely empty, not a hollow wrapper.
    expect(container.querySelector(".session-card__actions")?.children.length).toBe(0);
  });

  test("known reach (exact or app) renders an always-enabled terminal button, unchanged by ticket 07", () => {
    const exact = renderCard({ card: baseCard({ terminalReach: "exact" }) });
    expect(terminalButton(exact.container)?.disabled).toBe(false);

    const app = renderCard({ card: baseCard({ terminalReach: "app", terminalLabel: "abrir Warp ↗" }) });
    expect(terminalButton(app.container)?.disabled).toBe(false);
  });

  test("a TCC-gated row carries the 'macOS va a pedir permiso' title", () => {
    const { container } = renderCard({ card: baseCard({ terminalReach: "exact", terminalNeedsTcc: true }) });
    expect(terminalButton(container)?.title).toBe("macOS va a pedir permiso");
  });

  test("clicking the terminal button fires onFocusTerminal and never also selects the card", () => {
    let focused = 0;
    const selected: string[] = [];
    const { container } = renderCard({
      card: baseCard({ terminalReach: "exact" }),
      onFocusTerminal: () => focused++,
      onSelect: (id) => selected.push(id),
    });
    act(() => fireEvent.click(terminalButton(container)!));
    expect(focused).toBe(1);
    expect(selected).toEqual([]);
  });

  test("the archive button renders ONLY when showArchive is true (Board's own TERMINÓ gate)", () => {
    const hidden = renderCard({ card: baseCard(), showArchive: false });
    expect(hidden.container.textContent).not.toContain("archivar");

    const shown = renderCard({ card: baseCard(), showArchive: true });
    expect(shown.container.textContent).toContain("archivar");
  });

  test("a TERMINÓ card (showArchive) offers NO terminal button — the agent is gone, and with a closed window so is its terminal", () => {
    const { container } = renderCard({ card: baseCard({ terminalReach: "exact" }), showArchive: true });
    expect(terminalButton(container)).toBeUndefined();
    expect(container.textContent).not.toContain("terminal");
    expect(container.textContent).toContain("archivar");
  });

  test("clicking archivar fires onArchive and never also selects the card", () => {
    let archived = 0;
    const selected: string[] = [];
    const { container } = renderCard({
      card: baseCard(),
      showArchive: true,
      onArchive: () => archived++,
      onSelect: (id) => selected.push(id),
    });
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("archivar"));
    act(() => fireEvent.click(button!));
    expect(archived).toBe(1);
    expect(selected).toEqual([]);
  });
});
