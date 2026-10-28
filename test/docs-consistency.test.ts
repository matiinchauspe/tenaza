import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { STATUSLINE_SCRIPT_SNIPPET } from "../src/init";

/**
 * Ticket 01 (tenaza-v0-3): a human who already has a custom statusline
 * found Tenaza never showed up, for three compounding reasons — a wrong
 * paste line (covered by test/init.test.ts and test/cli.test.ts), the
 * README never showing the snippet at all, and the brew caveats never
 * pointing at `tenaza init`. These two guard the doc half so the README and
 * the CLI's own printed snippet can never drift apart (one source for the
 * text), and so `brew install`'s own caveats always name the next step.
 */

const REPO_ROOT = path.join(import.meta.dir, "..");

describe("statusline docs consistency (ticket 01, tenaza-v0-3)", () => {
  test("README has an \"Already have a statusline?\" section carrying the EXACT snippet init prints", () => {
    const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toContain("Already have a statusline?");
    expect(readme).toContain(STATUSLINE_SCRIPT_SNIPPET);
  });

  test("the Homebrew formula's caveats name `tenaza init` as the next step after install", () => {
    const formula = readFileSync(path.join(REPO_ROOT, "Formula/tenaza.rb"), "utf8");
    expect(formula).toContain("tenaza init");
  });
});
