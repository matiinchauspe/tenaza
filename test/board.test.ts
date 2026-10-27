import { describe, expect, test } from "bun:test";
import { formatAge, isSessionStalled, moveSelection, projectLabel, sessionColumn, TERMINO_WINDOW_MS } from "../src/board";

const STALL_MINUTES = 15;

describe("projectLabel", () => {
  test("a project Label with no path separator passes through unchanged", () => {
    expect(projectLabel("reservee")).toBe("reservee");
  });

  test("the unknown-project bucket passes through unchanged (no separator)", () => {
    expect(projectLabel("(sin proyecto)")).toBe("(sin proyecto)");
  });

  test("a worktree path returns the REPO segment, never the leaf task directory", () => {
    const cwd = "/Users/mati/agentic-workspace/.worktrees/tenaza/aw/tenaza-v0-2/08-13fdc4";
    expect(projectLabel(cwd)).toBe("tenaza");
  });

  test("a worktree path without the leading dot is still recognized", () => {
    expect(projectLabel("/home/mati/ws/worktrees/reservee/aw/fix-12")).toBe("reservee");
  });

  test("a plain git root with no worktree segment returns the path's own basename", () => {
    expect(projectLabel("/Users/mati/orca/workspaces/agentic-workspace/oarfish")).toBe("oarfish");
  });

  test("a trailing slash never leaves an empty basename", () => {
    expect(projectLabel("/Users/mati/projects/rudy/")).toBe("rudy");
  });

  test("a bare cwd with no git root at all still returns its own basename", () => {
    expect(projectLabel("/tmp/scratch")).toBe("scratch");
  });

  test("a .worktrees path with nothing after the repo segment falls back to the repo itself as the basename", () => {
    expect(projectLabel("/Users/mati/ws/.worktrees/tenaza")).toBe("tenaza");
  });
});

describe("isSessionStalled", () => {
  test("no Event at all is never stalled", () => {
    expect(isSessionStalled({}, new Date(), STALL_MINUTES)).toBe(false);
  });

  test("silent exactly at the threshold is not yet stalled", () => {
    const now = new Date("2026-01-01T00:15:00.000Z");
    const session = { lastEventTs: "2026-01-01T00:00:00.000Z" };
    expect(isSessionStalled(session, now, STALL_MINUTES)).toBe(false);
  });

  test("silent past the threshold is stalled", () => {
    const now = new Date("2026-01-01T00:15:01.000Z");
    const session = { lastEventTs: "2026-01-01T00:00:00.000Z" };
    expect(isSessionStalled(session, now, STALL_MINUTES)).toBe(true);
  });

  test("a custom stallMinutes (from the Policy, never hardcoded) moves the line", () => {
    const now = new Date("2026-01-01T00:05:01.000Z");
    const session = { lastEventTs: "2026-01-01T00:00:00.000Z" };
    expect(isSessionStalled(session, now, 5)).toBe(true);
    expect(isSessionStalled(session, now, 15)).toBe(false);
  });
});

describe("sessionColumn", () => {
  test("a running Session with a recent Event is CORRIENDO", () => {
    const now = new Date("2026-01-01T00:01:00.000Z");
    const session = { lastEventTs: "2026-01-01T00:00:00.000Z" };
    expect(sessionColumn(session, now, STALL_MINUTES)).toBe("corriendo");
  });

  test("a running Session silent past stallMinutes is TRABADA", () => {
    const now = new Date("2026-01-01T00:16:00.000Z");
    const session = { lastEventTs: "2026-01-01T00:00:00.000Z" };
    expect(sessionColumn(session, now, STALL_MINUTES)).toBe("trabada");
  });

  test("TIME IS STATE: the SAME session, read again later with no new Event, flips from CORRIENDO to TRABADA on the clock alone", () => {
    const session = { lastEventTs: "2026-01-01T00:00:00.000Z" };
    const stillFresh = new Date("2026-01-01T00:05:00.000Z");
    const nowStale = new Date("2026-01-01T00:20:00.000Z");
    expect(sessionColumn(session, stillFresh, STALL_MINUTES)).toBe("corriendo");
    expect(sessionColumn(session, nowStale, STALL_MINUTES)).toBe("trabada");
  });

  test("an ended Session within the 24h window is TERMINÓ", () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    const session = { endedAt: "2026-01-01T06:00:00.000Z" };
    expect(sessionColumn(session, now, STALL_MINUTES)).toBe("termino");
  });

  test("an ended Session exactly at the 24h mark is still TERMINÓ", () => {
    const endedAt = "2026-01-01T00:00:00.000Z";
    const now = new Date(new Date(endedAt).getTime() + TERMINO_WINDOW_MS);
    expect(sessionColumn({ endedAt }, now, STALL_MINUTES)).toBe("termino");
  });

  test("an ended Session past the 24h window has no column — the board drops its card", () => {
    const endedAt = "2026-01-01T00:00:00.000Z";
    const now = new Date(new Date(endedAt).getTime() + TERMINO_WINDOW_MS + 1);
    expect(sessionColumn({ endedAt }, now, STALL_MINUTES)).toBeUndefined();
  });

  test("TIME IS STATE: the SAME ended Session crosses out of TERMINÓ on the clock alone, with no new push possible (it's ended)", () => {
    const session = { endedAt: "2026-01-01T00:00:00.000Z" };
    const stillWithin = new Date("2026-01-01T23:59:00.000Z");
    const justPast = new Date("2026-01-02T00:00:01.000Z");
    expect(sessionColumn(session, stillWithin, STALL_MINUTES)).toBe("termino");
    expect(sessionColumn(session, justPast, STALL_MINUTES)).toBeUndefined();
  });

  test("ended beats stalled: an ended Session is never read as trabada even with no recent Event", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const session = { endedAt: "2026-01-01T00:00:00.000Z", lastEventTs: "2025-01-01T00:00:00.000Z" };
    expect(sessionColumn(session, now, STALL_MINUTES)).toBe("termino");
  });
});

describe("formatAge", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  test("never observed reads as a dash", () => {
    expect(formatAge(undefined, now)).toBe("—");
  });

  test("seconds", () => {
    expect(formatAge("2025-12-31T23:59:45.000Z", now)).toBe("15s");
  });

  test("minutes", () => {
    expect(formatAge("2025-12-31T23:30:00.000Z", now)).toBe("30m");
  });

  test("hours", () => {
    expect(formatAge("2025-12-31T18:00:00.000Z", now)).toBe("6h");
  });

  test("days", () => {
    expect(formatAge("2025-12-28T00:00:00.000Z", now)).toBe("4d");
  });

  test("never negative: a ts slightly in the future (clock skew) reads as 0s, not a negative age", () => {
    expect(formatAge("2026-01-01T00:00:05.000Z", now)).toBe("0s");
  });
});

describe("moveSelection", () => {
  const ids = ["a", "b", "c"];

  test("an empty list has nothing to select", () => {
    expect(moveSelection([], "a", 1)).toBeUndefined();
  });

  test("no current selection moving down lands on the first id", () => {
    expect(moveSelection(ids, undefined, 1)).toBe("a");
  });

  test("no current selection moving up lands on the last id", () => {
    expect(moveSelection(ids, undefined, -1)).toBe("c");
  });

  test("moves down one step", () => {
    expect(moveSelection(ids, "a", 1)).toBe("b");
  });

  test("moves up one step", () => {
    expect(moveSelection(ids, "c", -1)).toBe("b");
  });

  test("clamps at the end — moving down past the last id stays on the last id", () => {
    expect(moveSelection(ids, "c", 1)).toBe("c");
  });

  test("clamps at the start — moving up past the first id stays on the first id", () => {
    expect(moveSelection(ids, "a", -1)).toBe("a");
  });

  test("a selection that fell off the list (e.g. its card resolved) re-resolves to the first id moving down", () => {
    expect(moveSelection(ids, "gone", 1)).toBe("a");
  });

  test("a selection that fell off the list re-resolves to the last id moving up", () => {
    expect(moveSelection(ids, "gone", -1)).toBe("c");
  });

  test("keyed by id, not index: reordering the SAME ids moves relative to where the id actually sits now", () => {
    const reordered = ["c", "a", "b"];
    expect(moveSelection(reordered, "a", 1)).toBe("b");
    expect(moveSelection(reordered, "a", -1)).toBe("c");
  });
});
