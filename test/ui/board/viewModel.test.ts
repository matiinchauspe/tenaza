import { describe, expect, test } from "bun:test";
import { buildBoardViewModel, highlightedSessionId, sessionIdForCard, terminalLabelFor } from "../../../src/ui/board/viewModel";
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

  describe("offersRun (ticket 09): a YA CORRIÓ item and an mcp item never offer run", () => {
    test("a blocked shell item offers run", () => {
      const payload = makeBoardPayload({
        inbox: [makeInboxItem({ id: "x", blocked: true, action: { kind: "shell", tool: "Bash", command: "true" } })],
      });
      const model = buildBoardViewModel(payload, NOW);
      expect(model.teNecesita.cards[0]?.offersRun).toBe(true);
    });

    test("a YA CORRIÓ (unblocked) shell item never offers run", () => {
      const payload = makeBoardPayload({
        inbox: [makeInboxItem({ id: "x", blocked: false, action: { kind: "shell", tool: "Bash", command: "true" } })],
      });
      const model = buildBoardViewModel(payload, NOW);
      expect(model.teNecesita.cards[0]?.offersRun).toBe(false);
    });

    test("an mcp item never offers run, even when blocked", () => {
      const payload = makeBoardPayload({
        inbox: [
          makeInboxItem({ id: "x", blocked: true, action: { kind: "mcp", tool: "mcp__neon__run_sql", command: undefined } }),
        ],
      });
      const model = buildBoardViewModel(payload, NOW);
      expect(model.teNecesita.cards[0]?.offersRun).toBe(false);
    });
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

  test("a child whose parent has no ticket names the parent by its short id, never by its role", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({ id: "9b8fa51d-1844-4475", ticket: undefined, role: "sesión", lastEventTs: NOW.toISOString() }),
        makeSession({ id: "child", parentId: "9b8fa51d-1844-4475", role: "subagente", lastEventTs: NOW.toISOString() }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    const child = model.corriendo.cards.find((c) => c.id === "child");
    expect(child?.parentLabel).toBe("↳ 9b8fa51d");
  });

  test("a child whose parent is missing from this payload still names it by its short id", () => {
    const payload = makeBoardPayload({
      sessions: [makeSession({ id: "child", parentId: "ghost-parent-id", role: "subagente", lastEventTs: NOW.toISOString() })],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards[0]?.parentLabel).toBe("↳ ghost-pa");
  });

  test("a card shows a short id but keeps the full id for selection", () => {
    const payload = makeBoardPayload({
      sessions: [makeSession({ id: "9b8fa51d-1844-4475-8be0", lastEventTs: NOW.toISOString() })],
    });
    const card = buildBoardViewModel(payload, NOW).corriendo.cards[0];
    expect(card?.shortId).toBe("9b8fa51d");
    expect(card?.id).toBe("9b8fa51d-1844-4475-8be0");
  });

  test("a subagent renders right under its parent, nested, even when another Session is more recent", () => {
    const at = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
    const payload = makeBoardPayload({
      sessions: [
        makeSession({ id: "parent", lastEventTs: at(1) }),
        makeSession({ id: "other", lastEventTs: at(2) }),
        makeSession({ id: "child", parentId: "parent", role: "subagente", lastEventTs: at(5) }),
      ],
    });
    const cards = buildBoardViewModel(payload, NOW).corriendo.cards;
    expect(cards.map((c) => c.id)).toEqual(["parent", "child", "other"]);
    expect(cards.map((c) => c.nested)).toEqual([false, true, false]);
  });

  test("a subagent whose parent sits in another column is not nested and keeps the column's order", () => {
    const at = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
    const payload = makeBoardPayload({
      sessions: [
        makeSession({ id: "parent", lastEventTs: at(30) }), // silent past stall_minutes → TRABADA
        makeSession({ id: "child", parentId: "parent", role: "subagente", lastEventTs: at(1) }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards.map((c) => [c.id, c.nested])).toEqual([["child", false]]);
    expect(model.corriendo.cards[0]?.parentLabel).toBe("↳ parent");
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
      policy: { stallMinutes: 15, contextThresholdTokens: 200_000, waitSeconds: 180 },
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

describe("ticket 14: nativeWait — observed only, never actionable", () => {
  test("no nativeWait on the payload — the card's own field is undefined", () => {
    const payload = makeBoardPayload({ sessions: [makeSession({ id: "a", lastEventTs: NOW.toISOString() })] });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards[0]?.nativeWait).toBeUndefined();
  });

  test("permission_prompt resolves to its own es-AR label and hint, never the TE ESPERA wording", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({
          id: "a",
          lastEventTs: NOW.toISOString(),
          nativeWait: { kind: "permission_prompt", since: "2026-01-01T23:58:00.000Z" },
        }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    const nativeWait = model.corriendo.cards[0]?.nativeWait;
    expect(nativeWait?.kind).toBe("permission_prompt");
    expect(nativeWait?.label).toBe("PERMISO NATIVO");
    expect(nativeWait?.label).not.toContain("TE ESPERA");
    expect(nativeWait?.hint).toContain("Tenaza solo observa");
    expect(nativeWait?.age).toBe("2m");
  });

  test("idle_prompt resolves to its own distinct label", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({
          id: "a",
          lastEventTs: NOW.toISOString(),
          nativeWait: { kind: "idle_prompt", since: NOW.toISOString() },
        }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards[0]?.nativeWait?.label).toBe("INACTIVA");
  });

  test("a nativeWait on a TRABADA card still resolves — it is independent of the column's own stall classification", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({
          id: "a",
          lastEventTs: "2026-01-01T00:00:00.000Z", // 24h silent, stallMinutes 15 → TRABADA
          nativeWait: { kind: "idle_prompt", since: "2026-01-01T00:00:00.000Z" },
        }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.trabada.cards[0]?.nativeWait?.kind).toBe("idle_prompt");
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

describe("ticket 10: live answering — a held item docks on its OWN Session's card, never TE NECESITA, while still live", () => {
  test("a fresh held item renders as liveRequest on its Session's card, not as a TE NECESITA card", () => {
    const payload = makeBoardPayload({
      policy: { stallMinutes: 15, contextThresholdTokens: 200_000, waitSeconds: 180 },
      sessions: [makeSession({ id: "b71", lastEventTs: NOW.toISOString() })],
      inbox: [
        makeInboxItem({
          id: "abc123",
          sessionId: "b71",
          decision: "held",
          ts: NOW.toISOString(),
          action: { tool: "Bash", command: "gh pr merge 58 --merge" },
        }),
      ],
    });

    const model = buildBoardViewModel(payload, NOW);
    expect(model.teNecesita.cards).toHaveLength(0);
    const card = model.corriendo.cards.find((c) => c.id === "b71");
    expect(card?.liveRequest).toMatchObject({
      id: "abc123",
      tool: "Bash",
      command: "gh pr merge 58 --merge",
      remainingSeconds: 180,
    });
    expect(card?.liveRequest?.remainingFraction).toBe(1);
  });

  test("the TE NECESITA stat counts live + pending TOGETHER, even though the column itself only lists the pending half (spec: 'the stat chip... counts live + pending')", () => {
    const payload = makeBoardPayload({
      policy: { stallMinutes: 15, contextThresholdTokens: 200_000, waitSeconds: 180 },
      sessions: [makeSession({ id: "live-1", lastEventTs: NOW.toISOString() })],
      inbox: [
        makeInboxItem({ id: "live-item", sessionId: "live-1", decision: "held", ts: NOW.toISOString() }),
        makeInboxItem({ id: "pending-item", sessionId: "unrelated", decision: "deny" }),
      ],
    });

    const model = buildBoardViewModel(payload, NOW);
    expect(model.teNecesita.cards).toHaveLength(1); // only the pending one
    expect(model.stats.teNecesita).toBe(2); // live + pending
  });

  test("TIME IS STATE: once the window has lapsed, the SAME held row renders as a plain TE NECESITA card instead — no new event, just the clock", () => {
    const heldAt = new Date(NOW.getTime() - 200_000); // 200s ago, past the 180s window
    const payload = makeBoardPayload({
      policy: { stallMinutes: 15, contextThresholdTokens: 200_000, waitSeconds: 180 },
      sessions: [makeSession({ id: "b71", lastEventTs: NOW.toISOString() })],
      inbox: [makeInboxItem({ id: "abc123", sessionId: "b71", decision: "held", ts: heldAt.toISOString() })],
    });

    const model = buildBoardViewModel(payload, NOW);
    expect(model.teNecesita.cards.map((c) => c.id)).toEqual(["abc123"]);
    const card = model.corriendo.cards.find((c) => c.id === "b71");
    expect(card?.liveRequest).toBeUndefined();
  });

  test("a held item for an UNKNOWN Session (orphan) falls back to a plain TE NECESITA card rather than vanishing", () => {
    const payload = makeBoardPayload({
      sessions: [], // the held item's own Session isn't in this payload at all
      inbox: [makeInboxItem({ id: "abc123", sessionId: "ghost", decision: "held", ts: NOW.toISOString() })],
    });

    const model = buildBoardViewModel(payload, NOW);
    expect(model.teNecesita.cards.map((c) => c.id)).toEqual(["abc123"]);
  });

  test("a plain pending item (decision deny) is entirely unaffected — same TE NECESITA card as before ticket 10", () => {
    const payload = makeBoardPayload({
      sessions: [makeSession({ id: "e12", lastEventTs: NOW.toISOString() })],
      inbox: [makeInboxItem({ id: "pend1", sessionId: "e12", decision: "deny" })],
    });

    const model = buildBoardViewModel(payload, NOW);
    expect(model.teNecesita.cards.map((c) => c.id)).toEqual(["pend1"]);
    const card = model.corriendo.cards.find((c) => c.id === "e12");
    expect(card?.liveRequest).toBeUndefined();
  });
});

describe("ticket 10: resolution trace", () => {
  test("no resolutions at all — resolutionTrace is undefined, never an empty object", () => {
    const payload = makeBoardPayload({ sessions: [makeSession({ id: "a", resolutions: [] })] });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards[0]?.resolutionTrace).toBeUndefined();
  });

  test("a single resolution renders as the latest line with moreCount 0", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({
          id: "c09",
          resolutions: [{ id: "deadbeef00112233445566778899aabbccddeeff", kind: "ran", ts: NOW.toISOString() }],
        }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    const trace = model.corriendo.cards[0]?.resolutionTrace;
    expect(trace?.moreCount).toBe(0);
    expect(trace?.latest).toMatchObject({ symbol: "✓", text: "corrido por vos", tone: "ok", shortId: "dead" });
  });

  test("several resolutions: latest is the FIRST (server already sorted newest-first), moreCount counts the rest", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({
          id: "c09",
          resolutions: [
            { id: "1111111111111111111111111111111111111a", kind: "ran", ts: "2026-01-01T23:58:00.000Z" },
            { id: "2222222222222222222222222222222222222b", kind: "done", ts: "2026-01-01T23:50:00.000Z" },
            { id: "3333333333333333333333333333333333333c", kind: "dismissed", ts: "2026-01-01T23:40:00.000Z" },
          ],
        }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    const trace = model.corriendo.cards[0]?.resolutionTrace;
    expect(trace?.latest.text).toBe("corrido por vos");
    expect(trace?.moreCount).toBe(2);
    expect(trace?.tooltip.split("\n")).toHaveLength(3);
  });

  test("a failed run names its exit code", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({
          id: "c09",
          resolutions: [{ id: "4444444444444444444444444444444444444d", kind: "failed", ts: NOW.toISOString(), exitCode: 2 }],
        }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(model.corriendo.cards[0]?.resolutionTrace?.latest).toMatchObject({
      symbol: "✗",
      text: "falló (código 2)",
      tone: "fail",
    });
  });

  test("approved/rejected (live answers) read distinctly from done/dismissed", () => {
    const approvedPayload = makeBoardPayload({
      sessions: [
        makeSession({
          id: "a",
          resolutions: [{ id: "5555555555555555555555555555555555555e", kind: "approved", ts: NOW.toISOString() }],
        }),
      ],
    });
    expect(buildBoardViewModel(approvedPayload, NOW).corriendo.cards[0]?.resolutionTrace?.latest).toMatchObject({
      symbol: "✓",
      text: "aprobado",
    });

    const rejectedPayload = makeBoardPayload({
      sessions: [
        makeSession({
          id: "a",
          resolutions: [{ id: "6666666666666666666666666666666666666f", kind: "rejected", ts: NOW.toISOString() }],
        }),
      ],
    });
    expect(buildBoardViewModel(rejectedPayload, NOW).corriendo.cards[0]?.resolutionTrace?.latest).toMatchObject({
      symbol: "✕",
      text: "rechazado",
    });
  });
});

describe("highlightedSessionId (ticket 10): selecting a pending request highlights its Session's card", () => {
  test("undefined when nothing is selected", () => {
    const payload = makeBoardPayload({ inbox: [makeInboxItem({ id: "p1", sessionId: "s1" })] });
    const model = buildBoardViewModel(payload, NOW);
    expect(highlightedSessionId(model, undefined)).toBeUndefined();
  });

  test("resolves to the OWNING Session's id when a pending TE NECESITA card is selected", () => {
    const payload = makeBoardPayload({ inbox: [makeInboxItem({ id: "p1", sessionId: "s1" })] });
    const model = buildBoardViewModel(payload, NOW);
    expect(highlightedSessionId(model, "p1")).toBe("s1");
  });

  test("undefined when the selection is a Session card itself, not a TE NECESITA row", () => {
    const payload = makeBoardPayload({ sessions: [makeSession({ id: "s1" })] });
    const model = buildBoardViewModel(payload, NOW);
    expect(highlightedSessionId(model, "s1")).toBeUndefined();
  });
});

describe("terminalLabelFor (ticket 11, decision 09): the ONE place the button's wording is picked", () => {
  test("exact reach", () => {
    expect(terminalLabelFor("exact", "Orca")).toBe("ir a terminal ↗");
  });

  test("app-only reach, labeled by the app", () => {
    expect(terminalLabelFor("app", "Warp")).toBe("abrir Warp ↗");
  });

  test("app-only reach with no app label at all (should not happen in practice) still reads sensibly", () => {
    expect(terminalLabelFor("app", undefined)).toBe("abrir la terminal ↗");
  });

  test("unknown reach — greyed, the ticket's own exact wording", () => {
    expect(terminalLabelFor("unknown", undefined)).toBe("terminal desconocida");
  });
});

describe("buildBoardViewModel — terminal reach rides along on both card kinds (ticket 11)", () => {
  test("a Session card carries its own terminalReach/terminalAppLabel/terminalNeedsTcc, already formatted into terminalLabel", () => {
    const payload = makeBoardPayload({
      sessions: [makeSession({ id: "a", terminalReach: "exact", terminalAppLabel: "Orca", terminalNeedsTcc: false })],
    });
    const card = buildBoardViewModel(payload, NOW).corriendo.cards[0];
    expect(card).toMatchObject({ terminalReach: "exact", terminalLabel: "ir a terminal ↗", terminalNeedsTcc: false });
  });

  test("a TE NECESITA card carries the OWNING Session's own terminal fields (resolved server-side, carried verbatim on the row)", () => {
    const payload = makeBoardPayload({
      inbox: [
        makeInboxItem({ id: "p1", sessionId: "s1", terminalReach: "app", terminalAppLabel: "Alacritty", terminalNeedsTcc: false }),
      ],
    });
    const card = buildBoardViewModel(payload, NOW).teNecesita.cards[0];
    expect(card).toMatchObject({ terminalReach: "app", terminalLabel: "abrir Alacritty ↗" });
  });

  test("a TCC-gated row's needsTcc rides through to the card unchanged", () => {
    const payload = makeBoardPayload({
      sessions: [makeSession({ id: "a", terminalReach: "exact", terminalAppLabel: "iTerm2", terminalNeedsTcc: true })],
    });
    const card = buildBoardViewModel(payload, NOW).corriendo.cards[0];
    expect(card?.terminalNeedsTcc).toBe(true);
  });
});

describe("sessionIdForCard (ticket 11): resolves ANY selected card id to the Session id the focus route needs", () => {
  test("a Session card's own id round-trips unchanged", () => {
    const payload = makeBoardPayload({ sessions: [makeSession({ id: "s1" })] });
    const model = buildBoardViewModel(payload, NOW);
    expect(sessionIdForCard(model, "s1")).toBe("s1");
  });

  test("a TE NECESITA card resolves to its OWNING Session, never its own item hash", () => {
    const payload = makeBoardPayload({ inbox: [makeInboxItem({ id: "p1", sessionId: "s1" })] });
    const model = buildBoardViewModel(payload, NOW);
    expect(sessionIdForCard(model, "p1")).toBe("s1");
  });

  test("a TRABADA or TERMINÓ Session card's own id also round-trips", () => {
    const payload = makeBoardPayload({
      sessions: [
        makeSession({ id: "stalled", lastEventTs: "2026-01-01T00:00:00.000Z" }),
        makeSession({ id: "ended", endedAt: "2026-01-01T06:00:00.000Z" }),
      ],
    });
    const model = buildBoardViewModel(payload, NOW);
    expect(sessionIdForCard(model, "stalled")).toBe("stalled");
    expect(sessionIdForCard(model, "ended")).toBe("ended");
  });

  test("an id naming nothing at all is undefined, never a guess", () => {
    const model = buildBoardViewModel(makeBoardPayload(), NOW);
    expect(sessionIdForCard(model, "no-such-card")).toBeUndefined();
  });
});
