import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(import.meta.dir, "..", "scripts", "smoke-hook.sh");
const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");

async function runSmoke(binary: string) {
  const proc = Bun.spawn(["bash", SCRIPT, binary], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("scripts/smoke-hook.sh", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tenaza-smoke-hook-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function stub(name: string, body: string): string {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  // The script unsets the test recorder, so PATH=/bin is also what stops a real banner.
  test("passes on the real hook with no macOS notifier on PATH", async () => {
    const tenaza = stub("tenaza", `PATH=/bin exec ${process.execPath} run ${CLI_ENTRY} "$@"`);

    const result = await runSmoke(tenaza);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("smoke-hook: pass");
  });

  test("fails a hook that allows the reserved command", async () => {
    const result = await runSmoke(stub("tenaza", "cat >/dev/null"));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reserved command was not denied");
  });

  test("fails a hook that errors", async () => {
    const result = await runSmoke(stub("tenaza", "echo boom >&2; exit 3"));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("boom");
  });
});
