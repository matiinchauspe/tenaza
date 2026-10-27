import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Board } from "../../../src/ui/board/Board";
import { buildBoardViewModel } from "../../../src/ui/board/viewModel";
import { makeBoardPayload, makeInboxItem, makeSession } from "../../support/boardFixture";

/**
 * One render test of the board from a fixture payload (ticket 08's own
 * requirement). `renderToStaticMarkup` (`react-dom/server`) needs no DOM
 * at all — it runs fine in Bun's plain server environment — which is why
 * this test lives apart from `hooks.test.tsx`'s happy-dom-backed suite:
 * the board's OWN render has no effects or browser APIs to exercise, so
 * the lighter, DOM-free renderer is the right tool, not a reach for the
 * heavier one "just in case".
 */
describe("Board — render from a fixture payload", () => {
  const now = new Date("2026-01-02T00:00:00.000Z");

  const payload = makeBoardPayload({
    inbox: [
      makeInboxItem({
        id: "a1b2",
        project: "tenaza",
        ticket: "08",
        sessionId: "sess-main",
        action: { tool: "Bash", command: "gh pr merge 58" },
        ts: "2026-01-01T23:00:00.000Z",
      }),
    ],
    sessions: [
      makeSession({
        id: "sess-main",
        project: "tenaza",
        ticket: "08",
        role: "sesión",
        lastEventTs: "2026-01-01T23:58:00.000Z",
        hasMeasureCapability: true,
        contextTokens: 50_000,
        lastSignal: { kind: "shell", tool: "Bash", command: "bun test" },
      }),
      makeSession({
        id: "sess-stalled",
        project: "tenaza",
        role: "sesión",
        lastEventTs: "2026-01-01T00:00:00.000Z",
        hasMeasureCapability: true,
        contextTokens: 210_000,
      }),
      makeSession({
        id: "sess-ended",
        project: "tenaza",
        role: "subagente",
        parentId: "sess-main",
        endedAt: "2026-01-01T12:00:00.000Z",
        hasMeasureCapability: false,
      }),
    ],
  });

  const viewModel = buildBoardViewModel(payload, now);
  const html = renderToStaticMarkup(<Board viewModel={viewModel} selectedId="a1b2" onSelect={() => {}} />);

  test("renders all four column titles", () => {
    expect(html).toContain("TE NECESITA");
    expect(html).toContain("CORRIENDO");
    expect(html).toContain("TRABADA");
    expect(html).toContain("TERMINÓ");
  });

  test("renders the pending Inbox card's project, ticket and command, and marks it selected", () => {
    expect(html).toContain('class="inbox-card__tool">Bash</span>gh pr merge 58');
    expect(html).toContain('class="inbox-card__project">tenaza</span>');
    expect(html).toContain('class="inbox-card__ticket">08</span>');
    expect(html).toContain('aria-selected="true"');
  });

  test("an Inbox card's badge reads 'Inbox' (blocked) vs 'Ya corrió' (unenforced) — raw text mixed-case, CSS uppercases it", () => {
    const blockedPayload = buildBoardViewModel(
      makeBoardPayload({ inbox: [makeInboxItem({ id: "blocked", blocked: true })] }),
      now,
    );
    const ranPayload = buildBoardViewModel(
      makeBoardPayload({ inbox: [makeInboxItem({ id: "ran", blocked: false })] }),
      now,
    );
    const blockedHtml = renderToStaticMarkup(
      <Board viewModel={blockedPayload} selectedId={undefined} onSelect={() => {}} />,
    );
    const ranHtml = renderToStaticMarkup(<Board viewModel={ranPayload} selectedId={undefined} onSelect={() => {}} />);
    expect(blockedHtml).toContain("Inbox");
    expect(ranHtml).toContain("Ya corrió");
  });

  test("an mcp Inbox item (no stored command) shows the bare tool name in its command box", () => {
    const payload = buildBoardViewModel(
      makeBoardPayload({
        inbox: [makeInboxItem({ action: { kind: "mcp", tool: "mcp__neon__run_sql", command: undefined } })],
      }),
      now,
    );
    const mcpHtml = renderToStaticMarkup(<Board viewModel={payload} selectedId={undefined} onSelect={() => {}} />);
    expect(mcpHtml).toContain('class="inbox-card__cmd" title="mcp__neon__run_sql"><span class="inbox-card__cmd-text">');
    expect(mcpHtml).toContain('<span class="inbox-card__prompt" aria-hidden="true">$</span>mcp__neon__run_sql</span>');
  });

  test("an Inbox item's project resolves a worktree path to the repo's own name, never the full cwd", () => {
    const payload = buildBoardViewModel(
      makeBoardPayload({ inbox: [makeInboxItem({ project: "/Users/mati/ws/.worktrees/rudy/aw/fix-3" })] }),
      now,
    );
    const worktreeHtml = renderToStaticMarkup(<Board viewModel={payload} selectedId={undefined} onSelect={() => {}} />);
    expect(worktreeHtml).toContain('class="inbox-card__project">rudy</span>');
  });

  test("a Session card shows NO ticket at all when none was ever announced — never a stray ' / —'", () => {
    const payload = buildBoardViewModel(
      makeBoardPayload({
        sessions: [
          makeSession({
            id: "no-ticket",
            ticket: undefined,
            lastEventTs: now.toISOString(),
            contextTokens: 10_000,
            lastSignal: { kind: "shell", tool: "Bash", command: "pwd" },
          }),
        ],
      }),
      now,
    );
    const noTicketHtml = renderToStaticMarkup(<Board viewModel={payload} selectedId={undefined} onSelect={() => {}} />);
    expect(noTicketHtml).not.toContain("session-card__ticket");
    expect(noTicketHtml).not.toContain("/ —");
    expect(noTicketHtml).not.toContain("—</span>");
  });

  test("a column header's dot carries the colored status; the title text carries it too (color is never the only signal)", () => {
    expect(html).toContain('class="column__dot column__dot--corriendo"');
    expect(html).toContain('class="column__title column__title--corriendo"');
  });

  test("an empty column (no cards) shows its own placeholder instead of an empty list", () => {
    const payload = buildBoardViewModel(makeBoardPayload(), now);
    const emptyHtml = renderToStaticMarkup(<Board viewModel={payload} selectedId={undefined} onSelect={() => {}} />);
    expect(emptyHtml).toContain("nada te espera — los agentes siguen solos");
    expect(emptyHtml).toContain("column__empty");
  });

  test("renders a flagged context track's label for the Session past the threshold", () => {
    expect(html).toContain("⚑210k");
  });

  test("renders 'sin datos' for a Session with no measure Capability, never a bar built from nothing", () => {
    expect(html).toContain("sin datos");
  });

  test("renders a subagent's '↳ parent' reference", () => {
    expect(html).toContain("↳ 08");
  });

  test("renders a Session's 'last signal' field", () => {
    expect(html).toContain("Bash: bun test");
  });

  test("Session status is never color-only: the column title names it visually, and each card's aria-label repeats it for a screen reader (no visible per-card badge any more — a colored dot is reinforcement only)", () => {
    expect(html).toContain('aria-label="Corriendo: tenaza 08"');
    expect(html).toContain('aria-label="Trabada: tenaza"');
    expect(html).toContain('aria-label="Terminó: tenaza"');
  });

  test("the Inbox card's own badge still carries text, never color alone", () => {
    expect(html).toContain("Inbox");
  });
});
