import { describe, expect, test } from "bun:test";
import { buildBoardViewModel } from "../../../src/ui/board/viewModel";
import { makeBoardPayload, makeInboxItem, makeSession } from "../../support/boardFixture";

const NOW = new Date("2026-01-02T00:00:00.000Z");

describe("buildBoardViewModel — columns", () => {
  test("a running Session with a recent Event lands in CORRIENDO", () => {
    const payload = makeBoardPayload({
      sessions: [makeSession({ id: "a", lastEventTs: "2026-01-02T00:00:00.000Z" })],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards.map((c) => c.id)).toEqual(["a"]);
    expect(model.trabada.cards).toHaveLength(0);
    expect(model.termino.cards).toHaveLength(0);
  });

  test("a Session silent past stallMinutes lands in TRABADA", () => {
    const payload = makeBoardPayload({
      sessions: [makeSession({ id: "a", lastEventTs: "2026-01-01T00:00:00.000Z" })], // 24h silent, stallMinutes 15
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.trabada.cards.map((c) => c.id)).toEqual(["a"]);
    expect(model.corriendo.cards).toHaveLength(0);
  });

  test("a Session ended within 24h lands in TERMINÓ", () => {
    const payload = makeBoardPayload({
      sessions: [makeSession({ id: "a", endedAt: "2026-01-01T06:00:00.000Z" })],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.termino.cards.map((c) => c.id)).toEqual(["a"]);
  });

  test("a Session ended past 24h appears in NO column and NOT in orderedIds — the board drops its card", () => {
    const payload = makeBoardPayload({
      sessions: [makeSession({ id: "a", endedAt: "2025-12-31T00:00:00.000Z" })],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards).toHaveLength(0);
    expect(model.trabada.cards).toHaveLength(0);
    expect(model.termino.cards).toHaveLength(0);
    expect(model.orderedIds).not.toContain("a");
  });

  test("sessions within a column sort most-recent-event first", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({ id: "older", lastEventTs: "2026-01-01T23:50:00.000Z" }), // 10m ago — still CORRIENDO
        makeSession({ id: "newer", lastEventTs: "2026-01-01T23:58:00.000Z" }), // 2m ago
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards.map((c) => c.id)).toEqual(["newer", "older"]);
  });
});

describe("buildBoardViewModel — TE NECESITA (Inbox)", () => {
  test("pending items sort oldest first", () => {
    const payload = makeBoardPayload({
      inbox: [
        makeInboxItem({ id: "later", ts: "2026-01-01T12:00:00.000Z" }),
        makeInboxItem({ id: "earlier", ts: "2026-01-01T06:00:00.000Z" }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.teNecesita.cards.map((c) => c.id)).toEqual(["earlier", "later"]);
  });

  test("a shell item's tool label combines tool and command", () => {
    const payload = makeBoardPayload({
      inbox: [makeInboxItem({ action: { tool: "Bash", command: "gh pr merge 58" } })],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.teNecesita.cards[0]?.toolLabel).toBe("Bash: gh pr merge 58");
  });

  test("an mcp item (no stored command) shows the tool name alone", () => {
    const payload = makeBoardPayload({
      inbox: [makeInboxItem({ action: { kind: "mcp", tool: "mcp__neon__run_sql", command: undefined } })],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.teNecesita.cards[0]?.toolLabel).toBe("mcp__neon__run_sql");
  });

  test("project passes through from the row; an unlabeled item has NO ticket at all (never a stray dash)", () => {
    const payload = makeBoardPayload({
      inbox: [makeInboxItem({ project: "tenaza", ticket: undefined })],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.teNecesita.cards[0]?.project).toBe("tenaza");
    expect(model.teNecesita.cards[0]?.ticket).toBeUndefined();
  });

  test("a labeled item's ticket passes through verbatim", () => {
    const payload = makeBoardPayload({ inbox: [makeInboxItem({ ticket: "RES-131" })] });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.teNecesita.cards[0]?.ticket).toBe("RES-131");
  });

  test("an item's project resolves a worktree path to the repo's own name, never the full cwd (human fix round)", () => {
    const payload = makeBoardPayload({
      inbox: [makeInboxItem({ project: "/Users/mati/ws/.worktrees/reservee/aw/fix-12" })],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.teNecesita.cards[0]?.project).toBe("reservee");
  });

  test("a shell item's command and bare tool are exposed separately (for the card's own clamped command box), alongside the combined toolLabel", () => {
    const payload = makeBoardPayload({
      inbox: [makeInboxItem({ action: { kind: "shell", tool: "Bash", command: "gh pr merge 58" } })],
    });
    const model = buildBoardViewModel(payload, NOW);
    const card = model.teNecesita.cards[0];
    expect(card?.tool).toBe("Bash");
    expect(card?.command).toBe("gh pr merge 58");
    expect(card?.toolLabel).toBe("Bash: gh pr merge 58");
  });

  test("an mcp item has no command — the card's box falls back to the bare tool name", () => {
    const payload = makeBoardPayload({
      inbox: [makeInboxItem({ action: { kind: "mcp", tool: "mcp__neon__run_sql", command: undefined } })],
    });
    const model = buildBoardViewModel(payload, NOW);
    const card = model.teNecesita.cards[0];
    expect(card?.tool).toBe("mcp__neon__run_sql");
    expect(card?.command).toBeUndefined();
  });

  test("blocked (ADR 0001's enforced deny vs. YA CORRIÓ) passes through verbatim for the card's own badge", () => {
    const payload = makeBoardPayload({
      inbox: [makeInboxItem({ id: "blocked", blocked: true }), makeInboxItem({ id: "ran", blocked: false })],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.teNecesita.cards.find((c) => c.id === "blocked")?.blocked).toBe(true);
    expect(model.teNecesita.cards.find((c) => c.id === "ran")?.blocked).toBe(false);
  });
});

describe("buildBoardViewModel — Session card fields", () => {
  test("an unlabeled Session has NO ticket at all (never a stray dash), and shows its structural role", () => {
    const payload = makeBoardPayload({
      sessions: [makeSession({ id: "a", role: "subagente", ticket: undefined, lastEventTs: NOW.toISOString() })],
    });
    const model = buildBoardViewModel(payload, NOW);
    const card = model.corriendo.cards[0];
    expect(card?.ticket).toBeUndefined();
    expect(card?.role).toBe("subagente");
  });

  test("a Session's project resolves a worktree path to the repo's own name, never the full cwd (human fix round)", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({
          id: "a",
          project: "/Users/mati/orca/workspaces/agentic-workspace/.worktrees/tenaza/aw/tenaza-v0-2/08-13fdc4",
          lastEventTs: NOW.toISOString(),
        }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards[0]?.project).toBe("tenaza");
  });

  test("a child with a known parent shows '↳ <parent ticket>'", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({ id: "parent", ticket: "TEN-08", lastEventTs: NOW.toISOString() }),
        makeSession({ id: "child", parentId: "parent", role: "subagente", lastEventTs: NOW.toISOString() }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    const child = model.corriendo.cards.find((c) => c.id === "child");
    expect(child?.parentLabel).toBe("↳ TEN-08");
  });

  test("a child whose parent has no ticket label falls back to the parent's structural role", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({ id: "parent", ticket: undefined, role: "sesión", lastEventTs: NOW.toISOString() }),
        makeSession({ id: "child", parentId: "parent", role: "subagente", lastEventTs: NOW.toISOString() }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    const child = model.corriendo.cards.find((c) => c.id === "child");
    expect(child?.parentLabel).toBe("↳ sesión");
  });

  test("a child whose parent is missing from this payload falls back to the raw parent id", () => {
    const payload = makeBoardPayload({
      sessions: [makeSession({ id: "child", parentId: "ghost", role: "subagente", lastEventTs: NOW.toISOString() })],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards[0]?.parentLabel).toBe("↳ ghost");
  });

  test("a top-level Session (no parentId) has no parentLabel", () => {
    const payload = makeBoardPayload({ sessions: [makeSession({ id: "a", lastEventTs: NOW.toISOString() })] });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards[0]?.parentLabel).toBeUndefined();
  });

  test("lastSignal reads '—' for a Session that has never attempted an Action", () => {
    const payload = makeBoardPayload({ sessions: [makeSession({ id: "a", lastEventTs: NOW.toISOString() })] });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards[0]?.lastSignal).toBe("—");
  });

  test("lastSignal renders the SAME 'tool: command' shape as an Inbox card's tool label", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({
          id: "a",
          lastEventTs: NOW.toISOString(),
          lastSignal: { kind: "shell", tool: "Bash", command: "git status" },
        }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards[0]?.lastSignal).toBe("Bash: git status");
  });

  test("lastSignal for an mcp Action shows the tool name alone, same as an Inbox mcp item", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({
          id: "a",
          lastEventTs: NOW.toISOString(),
          lastSignal: { kind: "mcp", tool: "mcp__neon__run_sql" },
        }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards[0]?.lastSignal).toBe("mcp__neon__run_sql");
  });

  test("no measure Capability reads as 'unavailable', never a track built from an absent sample", () => {
    const payload = makeBoardPayload({
      sessions: [makeSession({ id: "a", hasMeasureCapability: false, lastEventTs: NOW.toISOString() })],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards[0]?.context).toEqual({ kind: "unavailable" });
  });

  test("measure Capability present builds a track, reusing contextbar's own math and label", () => {
    const payload = makeBoardPayload({
      policy: { stallMinutes: 15, contextThresholdTokens: 200_000 },
      sessions: [
        makeSession({ id: "a", hasMeasureCapability: true, contextTokens: 242_170, lastEventTs: NOW.toISOString() }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    const context = model.corriendo.cards[0]?.context;
    expect(context?.kind).toBe("track");
    if (context?.kind === "track") {
      expect(context.label).toBe("⚑242k");
      expect(context.track.flagged).toBe(true);
    }
  });
});

describe("buildBoardViewModel — orderedIds", () => {
  test("flattens TE NECESITA, then CORRIENDO, TRABADA, TERMINÓ, each in its own display order", () => {
    const payload = makeBoardPayload({
      inbox: [makeInboxItem({ id: "inbox-1", ts: "2026-01-01T00:00:00.000Z" })],
      sessions: [
        makeSession({ id: "corriendo-1", lastEventTs: NOW.toISOString() }),
        makeSession({ id: "trabada-1", lastEventTs: "2026-01-01T00:00:00.000Z" }),
        makeSession({ id: "termino-1", endedAt: "2026-01-01T12:00:00.000Z" }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.orderedIds).toEqual(["inbox-1", "corriendo-1", "trabada-1", "termino-1"]);
  });

  test("TIME IS STATE end to end: the SAME payload, read at a later now with no new push, moves a Session from CORRIENDO to TRABADA and reorders orderedIds accordingly", () => {
    const payload = makeBoardPayload({
      sessions: [makeSession({ id: "a", lastEventTs: "2026-01-01T23:50:00.000Z" })],
    });
    const soon = buildBoardViewModel(payload, new Date("2026-01-01T23:55:00.000Z"));
    expect(soon.corriendo.cards.map((c) => c.id)).toEqual(["a"]);

    const later = buildBoardViewModel(payload, new Date("2026-01-02T01:00:00.000Z"));
    expect(later.trabada.cards.map((c) => c.id)).toEqual(["a"]);
    expect(later.corriendo.cards).toHaveLength(0);
  });
});

describe("buildBoardViewModel — stats (header chips, human fix round)", () => {
  test("plain counts per column", () => {
    const payload = makeBoardPayload({
      inbox: [makeInboxItem({ id: "i1" })],
      sessions: [
        makeSession({ id: "run-1", lastEventTs: NOW.toISOString() }),
        makeSession({ id: "run-2", lastEventTs: NOW.toISOString() }),
        makeSession({ id: "stall-1", lastEventTs: "2026-01-01T00:00:00.000Z" }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.stats).toEqual({ teNecesita: 1, corriendo: 2, trabada: 1, over200k: 0 });
  });

  test("over200k counts flagged CORRIENDO and TRABADA Sessions, never TERMINÓ", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({ id: "hot-run", hasMeasureCapability: true, contextTokens: 210_000, lastEventTs: NOW.toISOString() }),
        makeSession({
          id: "hot-stall",
          hasMeasureCapability: true,
          contextTokens: 250_000,
          lastEventTs: "2026-01-01T00:00:00.000Z",
        }),
        makeSession({
          id: "hot-ended",
          hasMeasureCapability: true,
          contextTokens: 300_000,
          endedAt: "2026-01-01T12:00:00.000Z",
        }),
        makeSession({ id: "cool", hasMeasureCapability: true, contextTokens: 10_000, lastEventTs: NOW.toISOString() }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.stats.over200k).toBe(2);
  });
});
