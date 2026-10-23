import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { countToolCall, SAMPLE_EVERY_N_TOOL_CALLS, shouldSampleOnToolCall } from "../src/toolcalls";

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
