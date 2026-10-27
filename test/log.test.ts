import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { actionDecidedEvent, approvalResolvedEvent, EventSchema, sessionStartedEvent } from "../src/contract/event";
import {
  appendEvent,
  appendHumanEvent,
  readAllSessionEvents,
  readAllSessionEventsTolerant,
  readHumanEvents,
  readHumanEventsTolerant,
  readSessionEvents,
  sessionHasStarted,
} from "../src/log";
import { humanLogPath, sessionLogPath } from "../src/paths";

describe("Session log", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-log-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("appendEvent creates state/sessions/<session>.jsonl on first write", () => {
    const evt = actionDecidedEvent(
      "sess-1",
      { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
      "deny",
      { match: "gh pr merge", effect: "human" },
    );

    appendEvent(home, evt);

    const raw = readFileSync(sessionLogPath("sess-1", home), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(EventSchema.parse(JSON.parse(lines[0]!))).toEqual(evt);
  });

  test("appendEvent appends, one Event per line, to an existing log", () => {
    const first = actionDecidedEvent(
      "sess-1",
      { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
      "deny",
      { match: "gh pr merge", effect: "human" },
    );
    const second = actionDecidedEvent(
      "sess-1",
      { kind: "shell", command: "railway run -- psql", tool: "Bash" },
      "allow",
      { match: "railway run", effect: "flag" },
    );

    appendEvent(home, first);
    appendEvent(home, second);

    const raw = readFileSync(sessionLogPath("sess-1", home), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => EventSchema.safeParse(JSON.parse(line)).success)).toBe(
      true,
    );
  });

  test("readAllSessionEvents reads every line, across every session, validated", () => {
    const home2 = home;
    const a = actionDecidedEvent(
      "sess-1",
      { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
      "deny",
      { match: "gh pr merge", effect: "human" },
    );
    const b = actionDecidedEvent(
      "sess-2",
      { kind: "shell", command: "git worktree remove foo", tool: "Bash" },
      "deny",
      { match: "git worktree remove", effect: "human" },
    );

    appendEvent(home2, a);
    appendEvent(home2, b);

    const events = readAllSessionEvents(home2);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.session).sort()).toEqual(["sess-1", "sess-2"]);
  });

  test("readAllSessionEvents returns an empty list when no sessions exist yet", () => {
    expect(readAllSessionEvents(home)).toEqual([]);
  });
});

describe("Human log", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-human-log-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("appendHumanEvent writes to state/human.jsonl, creating it on first write", () => {
    const evt = approvalResolvedEvent("sess-1", "1", "done");

    appendHumanEvent(home, evt);

    const raw = readFileSync(humanLogPath(home), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(EventSchema.parse(JSON.parse(lines[0]!))).toEqual(evt);
  });

  test("appendHumanEvent never touches the originating Session's own log", () => {
    appendHumanEvent(home, approvalResolvedEvent("sess-1", "1", "done"));

    expect(readAllSessionEvents(home)).toEqual([]);
  });

  test("readHumanEvents returns an empty list when human.jsonl doesn't exist yet", () => {
    expect(readHumanEvents(home)).toEqual([]);
  });

  test("readHumanEvents reads every line, validated, in file order", () => {
    appendHumanEvent(home, approvalResolvedEvent("sess-1", "1", "done"));
    appendHumanEvent(home, approvalResolvedEvent("sess-2", "2", "dismissed"));

    const events = readHumanEvents(home);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type === "approval.resolved" && e.data.ref)).toEqual([
      "1",
      "2",
    ]);
  });
});

describe("ADR 0007 (ticket 01): a torn log line is skipped and counted, never thrown", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-log-tolerant-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("readSessionEvents skips a torn (unparseable) line instead of throwing", () => {
    const file = sessionLogPath("sess-1", home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"v":1,"ts":"2026-01-01T00:00:00.000Z","session":"sess-1","type":"session.ended","data":{"reason":"x"}}\n{"torn\n');

    expect(() => readSessionEvents("sess-1", home)).not.toThrow();
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "session.ended" });
  });

  test("readSessionEvents skips a line naming an unknown Event type", () => {
    const file = sessionLogPath("sess-1", home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ v: 1, ts: "2026-01-01T00:00:00.000Z", session: "sess-1", type: "future.event", data: {} })}\n`,
    );

    expect(readSessionEvents("sess-1", home)).toEqual([]);
  });

  test("readAllSessionEvents tolerates a torn line in one Session without losing another Session's Events", () => {
    const goodFile = sessionLogPath("sess-2", home);
    mkdirSync(path.dirname(goodFile), { recursive: true });
    writeFileSync(
      goodFile,
      `${JSON.stringify(EventSchema.parse(approvalResolvedEvent("sess-2", "1", "done")))}\n`,
    );
    writeFileSync(sessionLogPath("sess-1", home), "{not even json\n");

    const events = readAllSessionEvents(home);
    expect(events).toHaveLength(1);
    expect(events[0]?.session).toBe("sess-2");
  });

  test("readAllSessionEventsTolerant reports 0 skipped for a clean home", () => {
    appendEvent(home, approvalResolvedEvent("sess-1", "1", "done"));
    expect(readAllSessionEventsTolerant(home).skipped).toBe(0);
  });

  test("readAllSessionEventsTolerant reports exactly how many lines across every Session's log could not be read, alongside the Events that WERE readable", () => {
    mkdirSync(path.dirname(sessionLogPath("sess-1", home)), { recursive: true });
    writeFileSync(sessionLogPath("sess-1", home), "{broken-1\n{broken-2\n");
    appendEvent(home, approvalResolvedEvent("sess-2", "1", "done"));

    const result = readAllSessionEventsTolerant(home);
    expect(result.skipped).toBe(2);
    expect(result.events).toHaveLength(1);
  });

  test("readHumanEventsTolerant reports how many human-log lines could not be read, alongside the Events that WERE readable", () => {
    appendHumanEvent(home, approvalResolvedEvent("sess-1", "1", "done"));
    appendFileSync(humanLogPath(home), "{broken-human\n");

    const result = readHumanEventsTolerant(home);
    expect(result.skipped).toBe(1);
    expect(result.events).toHaveLength(1);
  });

  test("appendEvent starts a new line when the file's last line has no trailing newline, instead of gluing onto it", () => {
    const file = sessionLogPath("sess-1", home);
    mkdirSync(path.dirname(file), { recursive: true });
    // No trailing newline — exactly the torn tail a crashed process leaves (H1's own side finding).
    writeFileSync(file, '{"v":1,"ts":"2026-01-01T00:00:00.000Z","session":"sess-1"');

    const evt = approvalResolvedEvent("sess-1", "1", "done");
    appendEvent(home, evt);

    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual(EventSchema.parse(evt));

    // the torn first line is skipped, not glued onto — only the new, valid Event comes back
    expect(readSessionEvents("sess-1", home)).toEqual([EventSchema.parse(evt)]);
  });

  test("appendEvent needs no extra newline when the file already ends in one", () => {
    const file = sessionLogPath("sess-1", home);
    appendEvent(home, approvalResolvedEvent("sess-1", "1", "done"));
    appendEvent(home, approvalResolvedEvent("sess-1", "2", "dismissed"));

    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("\n\n");
    expect(readSessionEvents("sess-1", home)).toHaveLength(2);
  });
});

describe("sessionHasStarted (ticket 05, M6's own backfill guard)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-log-started-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("false when the Session's log doesn't exist at all", () => {
    expect(sessionHasStarted("sess-1", home)).toBe(false);
  });

  test("true when session.started is the first (and only) line", () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }));
    expect(sessionHasStarted("sess-1", home)).toBe(true);
  });

  test("false when the log exists but holds no session.started at all — the exact backfill-guard case", () => {
    appendEvent(
      home,
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        "deny",
        { match: "gh pr merge", effect: "human" },
      ),
    );
    expect(sessionHasStarted("sess-1", home)).toBe(false);
  });

  test("still true for a Session with many later Events — reads only the first line, never the whole growing log", () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }));
    for (let i = 0; i < 500; i++) {
      appendEvent(home, approvalResolvedEvent("sess-1", String(i), "done"));
    }
    expect(sessionHasStarted("sess-1", home)).toBe(true);
  });

  test("true when session.started is NOT line 1 but DOES appear later — the slow-path fallback (ticket 05 fix for the infinite-backfill bug)", () => {
    // Exactly the shape a previous backfill call leaves behind: the
    // Session's log opens with an EARLIER Event (predates a proper start),
    // and the backfilled session.started landed after it, since an append
    // only ever lands at the end. The fast (first-line) path alone would
    // say "false" FOREVER here.
    appendEvent(
      home,
      actionDecidedEvent(
        "sess-1",
        { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        "deny",
        { match: "gh pr merge", effect: "human" },
      ),
    );
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: "/repo", capabilities: [] }));

    expect(sessionHasStarted("sess-1", home)).toBe(true);
  });

  test("degrades to false, never throws, on a torn first line", () => {
    const file = sessionLogPath("sess-1", home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"v":1,"ts":"2026-01-01T00:00:00.000Z","session":"sess-1"');

    expect(() => sessionHasStarted("sess-1", home)).not.toThrow();
    expect(sessionHasStarted("sess-1", home)).toBe(false);
  });
});
