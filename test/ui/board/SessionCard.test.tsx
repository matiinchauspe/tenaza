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
