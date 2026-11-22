import path from "node:path";

const CLI_ENTRY = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the `tenaza` CLI as a real, separate process — the black-box seam the
 * spec's Testing Decisions name: tests observe only what the process prints
 * back and what it leaves on disk, never its internals. Runs the TypeScript
 * entrypoint directly (not the `bun build --compile` binary) so the suite
 * stays fast; the compiled binary is exercised by the build gate instead.
 */
export async function runCli(
  args: string[],
  options: { home: string; stdin?: string; env?: Record<string, string> } = { home: "" },
): Promise<CliResult> {
  // `process.execPath`, an absolute path — never the bare name "bun" — so a
  // test overriding the child's own `PATH` (e.g. to make its notifier
  // undeliverable) can't also break Bun's own lookup of the binary to spawn.
  const proc = Bun.spawn([process.execPath, "run", CLI_ENTRY, ...args], {
    env: { ...process.env, TENAZA_HOME: options.home, ...options.env },
    stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}
