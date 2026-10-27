import { describe, expect, test } from "bun:test";
import {
  type ActivitySession,
  type ActivitySnapshots,
  diffActivityFeed,
  formatAge,
  isSessionStalled,
  liveItemPhase,
  liveWaitRemainingFraction,
  moveSelection,
  projectLabel,
  sessionColumn,
  TERMINO_WINDOW_MS,
  worktreeLabel,
} from "../src/board";

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

  test("an Orca worktree returns the REPO, never Orca's own name for the worktree", () => {
    expect(projectLabel("/Users/mati/orca/workspaces/agentic-workspace/oarfish")).toBe("agentic-workspace");
  });

  test("a plain git root with no worktree segment returns the path's own basename", () => {
    expect(projectLabel("/Users/mati/projects/reservee")).toBe("reservee");
  });

  test("a 'workspaces' directory not under 'orca' is not mistaken for Orca's layout", () => {
    expect(projectLabel("/Users/mati/workspaces/acme/api")).toBe("api");
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

describe("worktreeLabel", () => {
  test("an Orca worktree returns Orca's name for it", () => {
    expect(worktreeLabel("/Users/mati/orca/workspaces/agentic-workspace/oarfish")).toBe("oarfish");
  });

  test("a Yunque worktree returns its leaf task directory", () => {
    expect(worktreeLabel("/Users/mati/ws/.worktrees/tenaza/aw/tenaza-v0-2/09-80c2ba")).toBe("09-80c2ba");
  });

  test("a plain git root, a Label, or a bare repo segment has no worktree", () => {
    expect(worktreeLabel("/Users/mati/projects/reservee")).toBeUndefined();
    expect(worktreeLabel("reservee")).toBeUndefined();
    expect(worktreeLabel("/Users/mati/ws/.worktrees/tenaza")).toBeUndefined();
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

describe("liveItemPhase (ticket 10: TIME IS STATE — expiry flips live → pending with no new Event)", () => {
  const heldAt = "2026-10-27T10:00:00.000Z";
  const waitSeconds = 180;

  test("reads live right when it was born", () => {
    expect(liveItemPhase(heldAt, new Date(heldAt), waitSeconds)).toBe("live");
  });

  test("still reads live one second before the window closes", () => {
    const now = new Date(new Date(heldAt).getTime() + waitSeconds * 1000 - 1000);
    expect(liveItemPhase(heldAt, now, waitSeconds)).toBe("live");
  });

  test("reads live AT the exact deadline (inclusive)", () => {
    const now = new Date(new Date(heldAt).getTime() + waitSeconds * 1000);
    expect(liveItemPhase(heldAt, now, waitSeconds)).toBe("live");
  });

  test("flips to pending the instant the window passes — purely from the clock, the SAME `action.decided` row never rewritten", () => {
    const now = new Date(new Date(heldAt).getTime() + waitSeconds * 1000 + 1000);
    expect(liveItemPhase(heldAt, now, waitSeconds)).toBe("pending");
  });

  test("a later re-evaluation of the SAME row, with nothing else changed, flips on its own as the clock advances", () => {
    const justBefore = new Date(new Date(heldAt).getTime() + waitSeconds * 1000 - 1);
    const justAfter = new Date(new Date(heldAt).getTime() + waitSeconds * 1000 + 1);
    expect(liveItemPhase(heldAt, justBefore, waitSeconds)).toBe("live");
    expect(liveItemPhase(heldAt, justAfter, waitSeconds)).toBe("pending");
  });
});

describe("liveWaitRemainingFraction", () => {
  const heldAt = "2026-10-27T10:00:00.000Z";

  test("1 right when it was born", () => {
    expect(liveWaitRemainingFraction(heldAt, new Date(heldAt), 180)).toBe(1);
  });

  test("0.5 at the halfway point", () => {
    const now = new Date(new Date(heldAt).getTime() + 90_000);
    expect(liveWaitRemainingFraction(heldAt, now, 180)).toBe(0.5);
  });

  test("clamped to 0 once the window has fully elapsed, never negative", () => {
    const now = new Date(new Date(heldAt).getTime() + 300_000);
    expect(liveWaitRemainingFraction(heldAt, now, 180)).toBe(0);
  });

  test("never divides by zero on a degenerate zero-second window", () => {
    expect(liveWaitRemainingFraction(heldAt, new Date(heldAt), 0)).toBe(0);
  });
});

describe("diffActivityFeed (ticket 12: the activity panel's own diff)", () => {
  const STALL_MINUTES = 15;
  const EMPTY: ActivitySnapshots = new Map();

  function session(overrides: Partial<ActivitySession> & { id: string }): ActivitySession {
    return {
      project: "reservee",
      resolutions: [],
      ...overrides,
    };
  }

  test("a brand-new Session (never seen before) is seeded silently — no transition entry on first sighting", () => {
    const now = new Date("2026-10-27T10:00:00.000Z");
    const sess = session({ id: "s1", lastEventTs: now.toISOString() });

    const { additions, next } = diffActivityFeed([sess], EMPTY, now, STALL_MINUTES);

    expect(additions).toEqual([]);
    expect(next.get("s1")).toEqual({ column: "corriendo", latestResolutionId: undefined });
  });

  test("a Session going CORRIENDO -> TRABADA (purely from the clock, no new Event) reports 'se trabó'", () => {
    const t0 = new Date("2026-10-27T10:00:00.000Z");
    const sess = session({ id: "s1", ticket: "RES-131", lastEventTs: t0.toISOString() });
    const { next: afterFirst } = diffActivityFeed([sess], EMPTY, t0, STALL_MINUTES);

    const t1 = new Date(t0.getTime() + 16 * 60 * 1000); // 16 min later, past the 15 min threshold
    const { additions } = diffActivityFeed([sess], afterFirst, t1, STALL_MINUTES);

    expect(additions).toHaveLength(1);
    expect(additions[0]?.text).toBe("RES-131 se trabó");
  });

  test("a Session going CORRIENDO -> TERMINÓ reports 'terminó'", () => {
    const t0 = new Date("2026-10-27T10:00:00.000Z");
    const running = session({ id: "s1", project: "reservee", lastEventTs: t0.toISOString() });
    const { next: afterFirst } = diffActivityFeed([running], EMPTY, t0, STALL_MINUTES);

    const t1 = new Date(t0.getTime() + 1000);
    const ended = { ...running, endedAt: t1.toISOString() };
    const { additions } = diffActivityFeed([ended], afterFirst, t1, STALL_MINUTES);

    expect(additions).toHaveLength(1);
    expect(additions[0]?.text).toBe("reservee terminó");
  });

  test("a Session going TRABADA -> CORRIENDO again reports 'volvió a correr', never 'arrancó'", () => {
    const t0 = new Date("2026-10-27T10:00:00.000Z");
    const sess = session({ id: "s1", project: "rudy", lastEventTs: t0.toISOString() });
    const { next: afterFirst } = diffActivityFeed([sess], EMPTY, t0, STALL_MINUTES);
    const t1 = new Date(t0.getTime() + 16 * 60 * 1000);
    const { next: afterStall } = diffActivityFeed([sess], afterFirst, t1, STALL_MINUTES);

    // A fresh Event moves lastEventTs forward, reclassifying back to corriendo.
    const t2 = new Date(t1.getTime() + 1000);
    const revived = { ...sess, lastEventTs: t2.toISOString() };
    const { additions } = diffActivityFeed([revived], afterStall, t2, STALL_MINUTES);

    expect(additions).toHaveLength(1);
    expect(additions[0]?.text).toBe("rudy volvió a correr");
  });

  test("a NEW resolution entry reports its own short id and the feed's own short verb", () => {
    const t0 = new Date("2026-10-27T10:00:00.000Z");
    const sess = session({ id: "s1", lastEventTs: t0.toISOString() });
    const { next: afterFirst } = diffActivityFeed([sess], EMPTY, t0, STALL_MINUTES);

    const resolved = {
      ...sess,
      resolutions: [{ id: "abc12345", kind: "approved" as const, ts: "2026-10-27T10:05:00.000Z" }],
    };
    const { additions } = diffActivityFeed([resolved], afterFirst, t0, STALL_MINUTES);

    expect(additions).toEqual([{ id: "r-abc12345", ts: "2026-10-27T10:05:00.000Z", text: "#abc1 aprobado" }]);
  });

  test("every resolution kind maps to the feed's own short verb (never the card's longer 'corrido por vos' wording)", () => {
    const t0 = new Date("2026-10-27T10:00:00.000Z");
    const sess = session({ id: "s1", lastEventTs: t0.toISOString() });
    const { next: afterFirst } = diffActivityFeed([sess], EMPTY, t0, STALL_MINUTES);

    const cases: { kind: "ran" | "done" | "dismissed" | "failed" | "approved" | "rejected"; verb: string }[] = [
      { kind: "ran", verb: "corrido" },
      { kind: "done", verb: "listo" },
      { kind: "dismissed", verb: "descartado" },
      { kind: "failed", verb: "falló" },
      { kind: "approved", verb: "aprobado" },
      { kind: "rejected", verb: "rechazado" },
    ];
    for (const { kind, verb } of cases) {
      const id = `id-${kind}`;
      const resolved = { ...sess, resolutions: [{ id, kind, ts: t0.toISOString() }] };
      const { additions } = diffActivityFeed([resolved], afterFirst, t0, STALL_MINUTES);
      expect(additions.map((entry) => entry.text)).toContain(`#${id.slice(0, 4)} ${verb}`);
    }
  });

  test("a resolution UNCHANGED since last tick produces no new entry (never re-reported every tick)", () => {
    const t0 = new Date("2026-10-27T10:00:00.000Z");
    const resolved = session({
      id: "s1",
      lastEventTs: t0.toISOString(),
      resolutions: [{ id: "abc12345", kind: "approved", ts: t0.toISOString() }],
    });
    const { next: afterFirst } = diffActivityFeed([resolved], EMPTY, t0, STALL_MINUTES);

    const t1 = new Date(t0.getTime() + 1000);
    const { additions } = diffActivityFeed([resolved], afterFirst, t1, STALL_MINUTES);

    expect(additions).toEqual([]);
  });

  test("a Session that VANISHES while its last known column was TERMINÓ reports 'archivado'", () => {
    const t0 = new Date("2026-10-27T10:00:00.000Z");
    const ended = session({ id: "s1", lastEventTs: t0.toISOString(), endedAt: t0.toISOString() });
    const { next: afterFirst } = diffActivityFeed([ended], EMPTY, t0, STALL_MINUTES);
    expect(afterFirst.get("s1")?.column).toBe("termino");

    const t1 = new Date(t0.getTime() + 1000);
    const { additions, next } = diffActivityFeed([], afterFirst, t1, STALL_MINUTES);

    expect(additions).toHaveLength(1);
    expect(additions[0]?.text).toBe("#s1 archivado");
    expect(additions[0]?.ts).toBe(t1.toISOString());
    expect(next.has("s1")).toBe(false);
  });

  test("a Session that vanishes while CORRIENDO or TRABADA reports nothing — only a TERMINÓ disappearance reads as archived", () => {
    const t0 = new Date("2026-10-27T10:00:00.000Z");
    const running = session({ id: "s1", lastEventTs: t0.toISOString() });
    const { next: afterFirst } = diffActivityFeed([running], EMPTY, t0, STALL_MINUTES);

    const { additions, next } = diffActivityFeed([], afterFirst, t0, STALL_MINUTES);

    expect(additions).toEqual([]);
    expect(next.has("s1")).toBe(false);
  });

  test("several Sessions diff independently in one tick — no cross-contamination", () => {
    const t0 = new Date("2026-10-27T10:00:00.000Z");
    const a = session({ id: "a", project: "reservee", lastEventTs: t0.toISOString() });
    const b = session({ id: "b", project: "rudy", lastEventTs: t0.toISOString() });
    const { next: afterFirst } = diffActivityFeed([a, b], EMPTY, t0, STALL_MINUTES);

    const t1 = new Date(t0.getTime() + 16 * 60 * 1000);
    const aStalled = { ...a }; // no new Event — crosses the stall threshold
    const bResolved = {
      ...b,
      lastEventTs: t1.toISOString(), // a fresh Event — stays corriendo
      resolutions: [{ id: "bres0001", kind: "done" as const, ts: t1.toISOString() }],
    };
    const { additions } = diffActivityFeed([aStalled, bResolved], afterFirst, t1, STALL_MINUTES);

    const texts = additions.map((entry) => entry.text).sort();
    expect(texts).toEqual(["#bres listo", "reservee se trabó"].sort());
  });
});
