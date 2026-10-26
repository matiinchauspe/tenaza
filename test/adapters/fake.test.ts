import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAKE_CAPABILITIES, handleFakeHook } from "../../src/adapters/fake";
import { readSessionEvents } from "../../src/log";
import { deriveInbox } from "../../src/inbox";

describe("the fake Adapter (ADR 0001: proves the core degrades by Capability, never by runtime name)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-fake-"));
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[[rule]]
match = "gh pr merge"
effect = "human"

[[rule]]
match = "railway run"
effect = "flag"
`,
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("declares Capabilities that deliberately EXCLUDE measure and block", async () => {
    expect(FAKE_CAPABILITIES).not.toContain("measure");
    expect(FAKE_CAPABILITIES).not.toContain("block");
  });

  test("start appends session.started with its own (narrower) Capabilities", async () => {
    await handleFakeHook(home, { kind: "start", session: "sess-1", cwd: "/tmp/scratch" });

    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "session.started",
      data: { runtime: "fake", capabilities: FAKE_CAPABILITIES },
    });
  });

  test("a human-ruled action CANNOT be denied without block — the response is allow, not deny (AC2)", async () => {
    const response = await handleFakeHook(home, { kind: "action", session: "sess-1", command: "gh pr merge 58" });

    expect(response?.decision).toBe("allow");
  });

  test("that same action is still RECORDED and SURFACED, not silently dropped (AC2)", async () => {
    await handleFakeHook(home, { kind: "action", session: "sess-1", command: "gh pr merge 58" });

    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "action.decided", data: { decision: "allow", rule: { effect: "human" } } });

    const inbox = deriveInbox(home);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ blocked: false, session: "sess-1" });
  });

  test("a flag-ruled action is unaffected — still allowed and logged, exactly as any Adapter would", async () => {
    const response = await handleFakeHook(home, { kind: "action", session: "sess-1", command: "railway run -- psql" });

    expect(response?.decision).toBe("allow");
    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "action.decided", data: { decision: "allow", rule: { effect: "flag" } } });
  });

  test("an action matching no Rule returns no response and logs nothing", async () => {
    const response = await handleFakeHook(home, { kind: "action", session: "sess-1", command: "ls -la" });

    expect(response).toBeUndefined();
    expect(readSessionEvents("sess-1", home)).toHaveLength(0);
  });

  test("end appends session.ended", async () => {
    await handleFakeHook(home, { kind: "end", session: "sess-1", reason: "done" });

    const events = readSessionEvents("sess-1", home);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "session.ended", data: { reason: "done" } });
  });
});
