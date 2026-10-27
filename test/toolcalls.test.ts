import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sessionTouchedPath, toolCallCounterPath } from "../src/paths";
import { countToolCall, SAMPLE_EVERY_N_TOOL_CALLS, shouldSampleOnToolCall, touchSession } from "../src/toolcalls";
import { runCli } from "./support/cli";

describe("countToolCall", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-toolcalls-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("the first call for a fresh Session returns 1", () => {
    expect(countToolCall(home, "sess-1")).toBe(1);
  });

  test("counts increment across calls, and are scoped per Session", () => {
    countToolCall(home, "sess-1");
    countToolCall(home, "sess-1");
    expect(countToolCall(home, "sess-1")).toBe(3);
    expect(countToolCall(home, "sess-2")).toBe(1);
  });

  test("the count survives being read back fresh, as a later hook invocation would", () => {
    countToolCall(home, "sess-1");
    countToolCall(home, "sess-1");
    // A real `tenaza hook claude` call is a fresh process each time — nothing
    // in memory carries over, only what was written to disk.
    expect(countToolCall(home, "sess-1")).toBe(3);
  });

  test("50 REAL parallel `tenaza hook claude` PostToolUse calls for the SAME Session count exactly 50 (ticket 05, M5)", async () => {
    // A sequential loop — even a `Promise.all` over 50 calls to the
    // in-process `countToolCall` function — can never actually race:
    // Node/Bun's synchronous fs calls never interleave within one process.
    // The real bug (#1423: "50 parallel calls counted 44") only shows up
    // across SEPARATE OS processes, which is what `runCli` spawns here —
    // 50 of them, fired together via `Promise.all`, never awaited one at
    // a time.
    const payload = JSON.stringify({ session_id: "sess-parallel", hook_event_name: "PostToolUse" });
    const calls = Array.from({ length: 50 }, () => runCli(["hook", "claude"], { home, stdin: payload }));
    const results = await Promise.all(calls);

    for (const result of results) expect(result.exitCode).toBe(0);
    expect(statSync(toolCallCounterPath("sess-parallel", home)).size).toBe(50);
  });
});

describe("touchSession (ticket 14, AC3)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-touch-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("creates the Session's own .touched marker, scoped per Session", () => {
    touchSession(home, "sess-1");
    expect(existsSync(sessionTouchedPath("sess-1", home))).toBe(true);
    expect(existsSync(sessionTouchedPath("sess-2", home))).toBe(false);
  });

  test("a later touch moves the file's own mtime forward", async () => {
    touchSession(home, "sess-1");
    const first = statSync(sessionTouchedPath("sess-1", home)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    touchSession(home, "sess-1");
    const second = statSync(sessionTouchedPath("sess-1", home)).mtimeMs;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  test("never throws when the state directory cannot be created — a display-only signal, never worth failing a hook call over", () => {
    const blockedHome = mkdtempSync(path.join(tmpdir(), "tenaza-touch-blocked-"));
    try {
      mkdirSync(path.join(blockedHome, "state"), { recursive: true });
      chmodSync(path.join(blockedHome, "state"), 0o500);
      expect(() => touchSession(blockedHome, "sess-1")).not.toThrow();
    } finally {
      chmodSync(path.join(blockedHome, "state"), 0o755);
      rmSync(blockedHome, { recursive: true, force: true });
    }
  });
});

describe("shouldSampleOnToolCall", () => {
  test("is false for every count before the 25th", () => {
    for (let i = 1; i < 25; i++) {
      expect(shouldSampleOnToolCall(i)).toBe(false);
    }
  });

  test("is true exactly on the 25th call, and every 25th after", () => {
    expect(shouldSampleOnToolCall(25)).toBe(true);
    expect(shouldSampleOnToolCall(50)).toBe(true);
    expect(shouldSampleOnToolCall(75)).toBe(true);
    expect(SAMPLE_EVERY_N_TOOL_CALLS).toBe(25);
  });

  test("is false on counts between the 25-multiples", () => {
    expect(shouldSampleOnToolCall(26)).toBe(false);
    expect(shouldSampleOnToolCall(49)).toBe(false);
  });
});
