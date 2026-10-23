import { describe, expect, test } from "bun:test";
import { formatContextBar, formatContextNumber } from "../src/contextbar";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const DEFAULT_THRESHOLD = 200_000;

describe("formatContextBar", () => {
  test("no sample yet renders fully empty, mark still shown", () => {
    expect(formatContextBar(undefined, DEFAULT_THRESHOLD)).toBe(`${"░".repeat(10)}┊${"░".repeat(5)}`);
  });

  test("below the threshold: filled cells, no red, mark untouched", () => {
    // 100_000 tokens / 20_000 per cell = 5 filled cells, well short of the mark at cell 10.
    const bar = formatContextBar(100_000, DEFAULT_THRESHOLD);
    expect(bar).toBe(`${"█".repeat(5)}${"░".repeat(5)}┊${"░".repeat(5)}`);
    expect(bar).not.toContain(RED);
  });

  test("past the threshold: overflow cells are red, filled up to the mark first", () => {
    // 242_170 tokens → 12 filled cells: 10 before the mark (full) + 2 red over it.
    const bar = formatContextBar(242_170, DEFAULT_THRESHOLD);
    expect(bar).toBe(`${"█".repeat(10)}┊${RED}${"█".repeat(2)}${RESET}${"░".repeat(3)}`);
    expect(bar).toContain(RED);
  });

  test("exactly at the threshold shows no overflow cell yet (bucket granularity, matches the ticket's own 20k cells)", () => {
    const bar = formatContextBar(200_000, DEFAULT_THRESHOLD);
    expect(bar).toBe(`${"█".repeat(10)}┊${"░".repeat(5)}`);
    expect(bar).not.toContain(RED);
  });

  test("a custom threshold moves the mark (AC4): fewer cells before it, more after", () => {
    const bar = formatContextBar(120_000, 100_000);
    // threshold 100_000 / 20_000 = cell 5 — mark moves left from the default's cell 10.
    expect(bar).toBe(`${"█".repeat(5)}┊${RED}${"█".repeat(1)}${RESET}${"░".repeat(9)}`);
  });

  test("the same tokens read as flagged under a lower threshold but not under the default", () => {
    const underDefault = formatContextBar(120_000, DEFAULT_THRESHOLD);
    const underCustom = formatContextBar(120_000, 100_000);
    expect(underDefault).not.toContain(RED);
    expect(underCustom).toContain(RED);
  });

  test("tokens beyond the full 300k span clamp the bar, never overflow it", () => {
    const bar = formatContextBar(400_000, DEFAULT_THRESHOLD);
    expect(bar).toBe(`${"█".repeat(10)}┊${RED}${"█".repeat(5)}${RESET}`);
  });
});

describe("formatContextNumber", () => {
  test("no sample yet reads as a dash", () => {
    expect(formatContextNumber(undefined, DEFAULT_THRESHOLD)).toBe("—");
  });

  test("below the threshold: plain, no flag", () => {
    expect(formatContextNumber(100_000, DEFAULT_THRESHOLD)).toBe("100k");
  });

  test("at or past the threshold: flagged with ⚑ (AC3)", () => {
    expect(formatContextNumber(200_000, DEFAULT_THRESHOLD)).toBe("⚑200k");
    expect(formatContextNumber(242_170, DEFAULT_THRESHOLD)).toBe("⚑242k");
  });

  test("a custom threshold moves what counts as flagged (AC4)", () => {
    expect(formatContextNumber(120_000, DEFAULT_THRESHOLD)).toBe("120k");
    expect(formatContextNumber(120_000, 100_000)).toBe("⚑120k");
  });
});
