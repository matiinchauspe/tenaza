import type { TerminalLocator } from "./contract/event";

/**
 * Ticket 11 (decision 09): capture the runtime-neutral terminal locator at
 * SessionStart — "read from the hook's own env and process table" (spec).
 * This is the ONE place that reads `process.env`/spawns `ps` for this
 * feature; `terminals.ts` (core) never does either — it only ever consumes
 * whatever this module already captured. Split in two for testability,
 * same shape `sessions.ts`'s own `deriveProject`/`defaultGitRootFor` pair
 * already uses: `localeFromEnv` is a PURE mapping (env vars in, locator
 * fields out — no I/O, trivially fixture-tested), and `defaultPsWalk` is
 * the one real process-table read, injectable so a test can fix
 * `tty`/`outerApp` without ever spawning a real `ps`.
 */

/** Every env var this capture reads, by name — declared once so `localeFromEnv`'s own mapping reads as a flat list rather than sixteen scattered `if`s with no shared shape. */
const ENV_LOCATOR_FIELDS: {
  readonly env: string;
  readonly field: keyof Omit<TerminalLocator, "tty" | "outerApp">;
  /** Only `TMUX`'s own value needs reshaping (its first comma-field is the socket path, research §1.2's own prerequisite) — every other var copies straight through. */
  readonly transform?: (raw: string) => string;
}[] = [
  { env: "TERM_PROGRAM", field: "termProgram" },
  { env: "__CFBundleIdentifier", field: "bundleId" },
  { env: "PWD", field: "pwd" },
  { env: "ORCA_TERMINAL_HANDLE", field: "orcaHandle" },
  { env: "TMUX", field: "tmuxSocket", transform: (raw) => raw.split(",")[0] ?? raw },
  { env: "TMUX_PANE", field: "tmuxPane" },
  { env: "ITERM_SESSION_ID", field: "itermSessionId" },
  { env: "WEZTERM_PANE", field: "weztermPane" },
  { env: "WEZTERM_UNIX_SOCKET", field: "weztermSocket" },
  { env: "KITTY_WINDOW_ID", field: "kittyWindowId" },
  { env: "KITTY_LISTEN_ON", field: "kittyListenOn" },
  { env: "ZELLIJ_SESSION_NAME", field: "zellijSession" },
  { env: "ZELLIJ_PANE_ID", field: "zellijPane" },
];

/** PURE: every per-terminal + outer-var field this capture can read straight off `env`, with no process-table read at all (`tty`/`outerApp` are `defaultPsWalk`'s own job, folded in by `captureTerminalLocator`). Absent and empty-string vars are both skipped — Claude Code's own hook env can carry an env var set to `""`, which is never "captured," same as not being set at all. */
export function localeFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Omit<TerminalLocator, "tty" | "outerApp"> {
  const locator: Omit<TerminalLocator, "tty" | "outerApp"> = {};
  for (const { env: name, field, transform } of ENV_LOCATOR_FIELDS) {
    const raw = env[name];
    if (!raw) continue;
    (locator as Record<string, string>)[field] = transform ? transform(raw) : raw;
  }
  return locator;
}

export interface PsWalkResult {
  tty?: string;
  outerApp?: string;
}

/** `?? ""` lines and `??`/`-` ttys (no controlling terminal) both read as "nothing captured" — never a literal `"??"` string written into the locator. */
function cleanField(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed && trimmed !== "??" && trimmed !== "-" ? trimmed : undefined;
}

/** The outermost `.app` bundle on a process's executable path — the FIRST `.app/` segment, never a helper nested inside it (`/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/…` → `/Applications/Orca.app`). Pure; `undefined` when the path carries no bundle. */
export function outermostApp(comm: string): string | undefined {
  return /^(.*?\.app)\//.exec(comm)?.[1];
}

/**
 * The real process-table read (research §2 — never run in a unit test;
 * `captureTerminalLocator`'s own `psWalk` parameter is what a test injects
 * instead): `ps -o tty=` for the hook's OWN controlling tty (the Terminal.app
 * / iTerm2 join key), and a bounded parent-PID walk for the outermost `.app`
 * on the path (the generic Level-1 fallback's own raise target). Bounded to
 * 32 hops — never infinite — and NEVER THROWS: a `ps` failure, an
 * unparseable line, or a walk that dead-ends at launchd (tmux/Zellij's own
 * known gap, research §1.2) all degrade to an absent field, never a crash
 * at SessionStart.
 */
export function defaultPsWalk(pid: number): PsWalkResult {
  const tty = cleanField(psField(String(pid), "tty"));

  let walkPid = String(pid);
  let outerApp: string | undefined;
  for (let hop = 0; hop < 32; hop++) {
    const line = psField(walkPid, "ppid=,comm=") ?? "";
    if (!line) break;
    const [ppid, ...commParts] = line.trim().split(/\s+/);
    const comm = commParts.join(" ");
    outerApp = outermostApp(comm) ?? outerApp;
    if (!ppid || ppid === "1" || ppid === walkPid) break;
    walkPid = ppid;
  }

  return { tty, outerApp };
}

function psField(pid: string, format: string): string | undefined {
  try {
    const proc = Bun.spawnSync(["ps", "-o", format.includes("=") ? format : `${format}=`, "-p", pid]);
    if (proc.exitCode !== 0) return undefined;
    return proc.stdout.toString("utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Ticket 02 ("a dead Session stops reading as live"): the hook's own
 * runtime pid, paired with its process-start marker — captured once at
 * SessionStart/SubagentStart so a LATER read can tell "this exact process
 * is still running" apart from "an unrelated process now happens to reuse
 * the same pid after a reboot" (the ticket's own named trap). `pid`
 * defaults to the SAME target `captureTerminalLocator`'s own walk already
 * reads at hop 0 (`process.ppid` — "the hook's parent is `claude`,"
 * research §2): Tenaza never spawns anything of its own to watch, it only
 * ever reads what the hook's own process table already names. `startedAt`
 * reuses THIS module's own `psField` (never a second ps-spawning routine)
 * rather than the bounded parent-PID walk `defaultPsWalk` does — that walk
 * answers a different question ("which app is outermost"); this one needs
 * exactly one field off exactly one pid.
 */
export interface ProcessMarker {
  pid: number;
  /** `ps -o lstart=`'s raw text for `pid` — opaque, never parsed as a date. `undefined` when `ps` couldn't report it (the process already gone by the time this ran, or a sandboxed test env with no real process table): `pid` is still captured, the reuse guard just can't be applied later. */
  startedAt?: string;
}

export function captureProcessMarker(
  pid: number = process.ppid,
  psRead: (pid: string, format: string) => string | undefined = psField,
): ProcessMarker {
  try {
    return { pid, startedAt: cleanField(psRead(String(pid), "lstart=")) };
  } catch {
    return { pid };
  }
}

/**
 * Capture the full locator for THIS SessionStart call — `env`/`pid` default
 * to the hook's own (`process.env`, `process.ppid`: "the hook's parent is
 * `claude`," research §2), and `psWalk` to the real process-table read
 * (`defaultPsWalk`); a test fixes all three. `undefined` (never an empty
 * `{}`) when nothing at all was captured — `sessionStartedEvent`'s own
 * `terminal` field is then omitted entirely, exactly as its doc comment
 * requires.
 */
export function captureTerminalLocator(
  env: Readonly<Record<string, string | undefined>> = process.env,
  pid: number = process.ppid,
  psWalk: (pid: number) => PsWalkResult = defaultPsWalk,
): TerminalLocator | undefined {
  const fromEnv = localeFromEnv(env);
  const walked = (() => {
    try {
      return psWalk(pid);
    } catch {
      return {};
    }
  })();

  const locator: TerminalLocator = { ...fromEnv };
  if (walked.tty) locator.tty = walked.tty;
  if (walked.outerApp) locator.outerApp = walked.outerApp;

  return Object.keys(locator).length > 0 ? locator : undefined;
}
