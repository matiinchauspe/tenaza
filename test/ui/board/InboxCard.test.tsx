import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InboxCard, type InboxCardProps } from "../../../src/ui/board/InboxCard";
import { buildBoardViewModel } from "../../../src/ui/board/viewModel";
import { makeBoardPayload, makeInboxItem } from "../../support/boardFixture";

const NOW = new Date("2026-01-02T00:00:00.000Z");
const NOOP = () => {};

function cardFor(overrides: Parameters<typeof makeInboxItem>[0]) {
  const payload = makeBoardPayload({ inbox: [makeInboxItem({ id: "x", ...overrides })] });
  const model = buildBoardViewModel(payload, NOW);
  const card = model.teNecesita.cards[0];
  if (!card) throw new Error("expected one Inbox card");
  return card;
}

/** Every `InboxCardProps` field that isn't the thing a given test is actually varying — one place to default them, so adding a prop (review fix: `errorMessage`) touches this ONE function, never every call site. */
function renderCard(overrides: Partial<InboxCardProps> & { card: InboxCardProps["card"] }): string {
  const props: InboxCardProps = {
    selected: false,
    onSelect: NOOP,
    running: false,
    output: undefined,
    errorMessage: undefined,
    onRun: NOOP,
    onDone: NOOP,
    onDismiss: NOOP,
    onFocusTerminal: NOOP,
    ...overrides,
  };
  return renderToStaticMarkup(<InboxCard {...props} />);
}

/**
 * Ticket 09's own action buttons, ported literally from the approved
 * prototype's action card (`PROTOTYPE-live-surface-BC.ts`'s `actionCard`):
 * `▶ tenaza run` only when offered, `listo`/`descartar` with their own
 * `kbd`, and the YA CORRIÓ note in place of a `run` button for an item the
 * Adapter could never actually block.
 */
describe("InboxCard — action buttons (ticket 09)", () => {
  test("a blocked shell item renders the run button, plus listo/descartar with their keys", () => {
    const card = cardFor({ blocked: true, action: { kind: "shell", tool: "Bash", command: "true" } });
    const html = renderCard({ card });

    expect(html).toContain("▶ tenaza run");
    expect(html).toContain("listo");
    expect(html).toContain("descartar");
    expect(html).toContain("<kbd>d</kbd>");
    expect(html).toContain("<kbd>x</kbd>");
    // No YA CORRIÓ note on a blocked (enforced) item.
    expect(html).not.toContain("el adapter no pudo frenarlo");
  });

  test("a YA CORRIÓ (unblocked) item offers NO run button, but still offers listo/descartar, plus the note", () => {
    const card = cardFor({ blocked: false, action: { kind: "shell", tool: "Bash", command: "true" } });
    const html = renderCard({ card });

    expect(html).not.toContain("▶ tenaza run");
    expect(html).toContain("listo");
    expect(html).toContain("descartar");
    expect(html).toContain("el adapter no pudo frenarlo — quedó registrado, no lo vuelvas a correr");
  });

  test("an mcp item offers NO run button even when blocked — it has no stored command", () => {
    const card = cardFor({
      blocked: true,
      action: { kind: "mcp", tool: "mcp__neon__run_sql", command: undefined },
    });
    const html = renderCard({ card });

    expect(html).not.toContain("▶ tenaza run");
    expect(html).toContain("listo");
    expect(html).toContain("descartar");
  });

  test("running disables the run button and swaps its label", () => {
    const card = cardFor({ blocked: true, action: { kind: "shell", tool: "Bash", command: "true" } });
    const html = renderCard({ card, running: true });

    expect(html).toContain("corriendo…");
    expect(html).not.toContain("▶ tenaza run");
    expect(html).toContain("disabled");
  });

  test("a non-empty output renders as a preformatted block; an empty or absent output renders nothing", () => {
    const card = cardFor({ blocked: true, action: { kind: "shell", tool: "Bash", command: "true" } });

    const withOutput = renderCard({ card, output: "corriendo bien\n" });
    expect(withOutput).toContain('class="inbox-card__output"');
    expect(withOutput).toContain("corriendo bien");

    const withoutOutput = renderCard({ card, output: undefined });
    expect(withoutOutput).not.toContain("inbox-card__output");

    const withEmptyOutput = renderCard({ card, output: "" });
    expect(withEmptyOutput).not.toContain("inbox-card__output");
  });
});

describe("InboxCard — the terminal button (ticket 11, 'from any card'; ticket 07)", () => {
  test("renders the card's own already-formatted terminalLabel, with the t key", () => {
    const card = cardFor({ terminalReach: "exact", terminalAppLabel: "Orca" });
    const html = renderCard({ card });

    expect(html).toContain("ir a terminal ↗");
    expect(html).toContain("<kbd>t</kbd>");
  });

  test("app-only reach labels by the app, exact reach never does", () => {
    const html = renderCard({ card: cardFor({ terminalReach: "app", terminalAppLabel: "Warp" }) });
    expect(html).toContain("abrir Warp ↗");
  });

  test("ticket 07: unknown reach renders NO terminal button at all — listo/descartar remain, no stray separator", () => {
    const html = renderCard({ card: cardFor({ terminalReach: "unknown" }) });
    expect(html).not.toContain("terminal desconocida");
    expect(html).not.toContain("<kbd>t</kbd>");
    // `running: false` keeps the run button enabled, and the terminal
    // button is now gone outright, so no disabled button remains at all.
    expect(html).not.toContain("disabled");
    expect(html).toContain("listo");
    expect(html).toContain("descartar");
  });

  test("a TCC-gated row carries the 'macOS va a pedir permiso' title", () => {
    const html = renderCard({ card: cardFor({ terminalReach: "exact", terminalNeedsTcc: true }) });
    expect(html).toContain('title="macOS va a pedir permiso"');
  });
});

/**
 * Review fix: a failed `run` must be VISIBLE in the card, never a silent
 * no-op — and a write Tenaza refused outright (409/422/500/404) must say
 * why, not just do nothing. Both render in `.inbox-card__output-error`
 * (the prototype's own `--red`), kept apart from the command's own
 * (neutral) output.
 */
describe("InboxCard — failure surfaces (review fix)", () => {
  test("output carrying a failure trailer renders the command's own output AND the trailer, separately, as a distinguishable red element", () => {
    const card = cardFor({ blocked: true, action: { kind: "shell", tool: "Bash", command: "false" } });
    const html = renderCard({ card, output: "antes de fallar\n\n✗ salió con código 1\n" });

    expect(html).toContain('class="inbox-card__output">antes de fallar<');
    expect(html).toContain('class="inbox-card__output-error">✗ salió con código 1<');
  });

  test("a failure trailer with no preceding output renders ONLY the red trailer, no empty output block", () => {
    const card = cardFor({ blocked: true, action: { kind: "shell", tool: "Bash", command: "false" } });
    const html = renderCard({ card, output: "\n✗ salió con código 1\n" });

    expect(html).not.toContain('class="inbox-card__output">');
    expect(html).toContain('class="inbox-card__output-error">✗ salió con código 1<');
  });

  test("errorMessage (a refused write) renders as its own red element, independent of output", () => {
    const card = cardFor({ blocked: true, action: { kind: "shell", tool: "Bash", command: "true" } });
    const html = renderCard({ card, errorMessage: "Ya estaba cerrado" });

    expect(html).toContain('class="inbox-card__output-error">Ya estaba cerrado<');
  });

  test("output's own trailer AND a write errorMessage can both render at once — two distinct facts, two elements", () => {
    const card = cardFor({ blocked: true, action: { kind: "shell", tool: "Bash", command: "false" } });
    const html = renderCard({
      card,
      output: "\n✗ salió con código 1\n",
      errorMessage: "No se pudo (409)",
    });

    const occurrences = html.split('class="inbox-card__output-error">').length - 1;
    expect(occurrences).toBe(2);
    expect(html).toContain("✗ salió con código 1");
    expect(html).toContain("No se pudo (409)");
  });

  test("no output, no errorMessage — neither failure element renders at all", () => {
    const card = cardFor({ blocked: true, action: { kind: "shell", tool: "Bash", command: "true" } });
    const html = renderCard({ card });

    expect(html).not.toContain("inbox-card__output-error");
  });
});
