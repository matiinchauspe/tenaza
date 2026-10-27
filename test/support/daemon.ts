import path from "node:path";

const CLI_ENTRY = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

export interface DaemonHandle {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  token: string;
  home: string;
  url: string;
  /** Kill the process and wait for it to actually exit (bounded — never hangs the suite). */
  stop(): Promise<void>;
}

/**
 * The line `runUi` prints to stdout once it is actually listening
 * (`src/daemon.ts`'s own `print` call) — the one fact a test needs to drive
 * the rest of the black-box seam (its real, OS-assigned port when spawned
 * with `--port 0`, and the launch token).
 */
const STARTUP_LINE = /tenaza: serving on http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+)/;

async function readStartupLine(
  stdout: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<{ port: number; token: string }> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /**
   * Keep reading (and discarding) stdout once the startup line is found.
   * REQUIRED, not cosmetic: the child process's stdout pipe has a finite OS
   * buffer, and `tenaza ui` never closes stdout until it's killed — if
   * nobody keeps draining it, the buffer fills and the child blocks on its
   * next write, which would hang teardown. A closure over `reader` here —
   * never a standalone function taking it as a parameter — sidesteps a
   * real type mismatch: Bun's own `ReadableStreamDefaultReader` (what
   * `getReader()` actually returns at runtime) and `node:stream/web`'s
   * (what a separately-annotated parameter resolves to under this
   * project's `@types/node`) are structurally different BYOB-capable
   * overloads that don't assign to each other, even though both work
   * identically for the plain, non-BYOB `.read()` this only ever calls.
   */
  const drainForever = async (): Promise<void> => {
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await reader.read();
        if (done) return;
      }
    } catch {
      // The process exited or the pipe closed — nothing left to drain.
    }
  };

  const result = await Promise.race([
    (async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the Daemon closed stdout before reporting its listening URL");
        buffer += decoder.decode(value, { stream: true });
        const match = buffer.match(STARTUP_LINE);
        if (match) {
          const [, portText, token] = match;
          return { port: Number(portText), token: token! };
        }
      }
    })(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for the Daemon's startup line")), timeoutMs),
    ),
  ]);

  void drainForever();
  return result;
}

/**
 * Spawn `tenaza ui` as a real, separate process — ticket 07's own black-box
 * seam ("driving `tenaza ui --port 0` ... over HTTP"). Unlike
 * `test/support/cli.ts`'s `runCli`, this NEVER awaits `proc.exited` — the
 * Daemon is long-lived by design (it only stops on Ctrl-C/SIGINT, or here,
 * `stop()`), so waiting for exit would hang every test that uses it.
 */
export async function spawnDaemon(
  args: string[],
  options: { home: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<DaemonHandle> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "ui", ...args], {
    env: { ...process.env, TENAZA_HOME: options.home, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const { port, token } = await readStartupLine(proc.stdout, options.timeoutMs ?? 5000);
    return {
      proc,
      port,
      token,
      home: options.home,
      url: `http://127.0.0.1:${port}/?token=${token}`,
      async stop() {
        await stopDaemon(proc);
      },
    };
  } catch (error) {
    // Never leak a half-started process when startup itself fails.
    await stopDaemon(proc);
    throw error;
  }
}

async function stopDaemon(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    // already gone
  }
  const exited = await Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  if (!exited) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
    await proc.exited;
  }
}
