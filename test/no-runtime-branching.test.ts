import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * ADR 0001 (ticket 06, AC3): the CORE degrades by Capability, never by
 * runtime name. Scoped to `src/`, excluding exactly the two places a
 * runtime name is unavoidable wiring rather than core branching:
 *   - `src/adapters/` — each Adapter's OWN file, which legitimately names
 *     itself and the runtime it translates (e.g. `runtime: "claude"`).
 *   - `src/cli.ts` — the command dispatcher, which must route a CLI
 *     subcommand ("hook claude" / "hook fake") to one Adapter module by
 *     name, same as any plugin registry would.
 * Everywhere else, a runtime name appearing as a QUOTED STRING LITERAL
 * (`"claude"`, `'fake'`, …) would mean some core file is comparing or
 * switching on it — exactly the branch ADR 0001 forbids. An UNQUOTED
 * mention in a doc comment (e.g. "a Claude Code subagent") is prose, not a
 * branch, and is deliberately NOT what this test flags.
 */
const SRC_ROOT = path.join(import.meta.dir, "..", "src");
const EXCLUDED_DIRS = new Set(["adapters"]);
const EXCLUDED_FILES = new Set(["cli.ts"]);
const RUNTIME_NAME_LITERAL = /["'](claude|fake)["']/i;

function collectCoreFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const isDir = statSync(full).isDirectory();
    if (isDir) {
      if (dir === SRC_ROOT && EXCLUDED_DIRS.has(entry)) continue;
      files.push(...collectCoreFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (dir === SRC_ROOT && EXCLUDED_FILES.has(entry)) continue;
    files.push(full);
  }
  return files;
}

describe("ADR 0001: the core never branches on a runtime name", () => {
  test("no core source file (outside adapters/ and cli.ts) names a runtime as a quoted string literal", () => {
    const offenders: string[] = [];
    for (const file of collectCoreFiles(SRC_ROOT)) {
      const text = readFileSync(file, "utf8");
      const match = text.match(RUNTIME_NAME_LITERAL);
      if (match) offenders.push(`${path.relative(SRC_ROOT, file)}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
