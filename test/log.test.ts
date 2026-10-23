import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { actionDecidedEvent, approvalResolvedEvent, EventSchema } from "../src/contract/event";
import { appendEvent, appendHumanEvent, readAllSessionEvents, readHumanEvents } from "../src/log";
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
