import { describe, expect, test } from "bun:test";
import path from "node:path";
import { measureContextTokens } from "../src/transcript";

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "transcripts", name);

describe("measureContextTokens", () => {
  test("reads a real transcript's LATEST assistant usage, below the default threshold", () => {
    // Real Claude Code transcript lines (content stripped), two turns: an
    // earlier 76218 and a later 75704-ish total — the later one must win.
    expect(measureContextTokens(fixture("below-threshold.jsonl"))).toBe(75704);
  });

  test("reads a real transcript's LATEST assistant usage, above the default threshold", () => {
    // Real transcript lines: an earlier 76218 (below) then a later 242170
    // (above) — proves "latest", not "max" or "first", wins.
    expect(measureContextTokens(fixture("above-threshold.jsonl"))).toBe(242170);
  });

  test("a transcript with no assistant usage yields undefined, not zero", () => {
    expect(measureContextTokens(fixture("no-usage.jsonl"))).toBeUndefined();
  });

  test("a missing transcript file yields undefined", () => {
    expect(measureContextTokens(fixture("does-not-exist.jsonl"))).toBeUndefined();
  });

  test("context_tokens is input + cache_creation + cache_read, excluding output_tokens", () => {
    // The above-threshold fixture's last line carries input_tokens: 2,
    // cache_creation_input_tokens: 829, cache_read_input_tokens: 241339,
    // output_tokens: 188 — only the first three sum to 242170.
    expect(measureContextTokens(fixture("above-threshold.jsonl"))).toBe(2 + 829 + 241339);
  });
});
