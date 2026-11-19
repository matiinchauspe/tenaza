import type { TerminalLocator } from "./contract/event";

/**
 * Focusing is core, not an Adapter — it isn't runtime-specific, so it
 * never reads `process.env` or spawns a process itself; that capture
 * happens once, in `terminallocator.ts`, at SessionStart.
 */

export type FocusLevel = "exact" | "app" | "unknown";

/** `env` (spawn only) is layered on top of the focuser's own process env, never replacing it — WezTerm needs `WEZTERM_UNIX_SOCKET` set this way to reach a non-default instance. */
export type FocusStep =
  | { kind: "spawn"; argv: string[]; env?: Record<string, string> }
  | { kind: "osascript"; script: string };

export interface FocusPlan {
  level: FocusLevel;
  /** The terminal app's own display name — undefined only when `level` is "unknown". */
  appLabel: string | undefined;
  /** In click order — an exact-tab step first (when one was built), then a Level-1 app raise unless the exact step already raises the window on its own. Empty exactly when `level` is "unknown". */
  steps: FocusStep[];
}

/**
 * What a live resolution contributes — needed only for tmux, whose client
 * tty for `switch-client -c` is never captured at SessionStart: the outer
 * vars captured then describe whatever started the tmux server, not the
 * attached client, so it's only discoverable live, via `list-clients`.
 */
export interface LiveFacts {
  tmuxOuter?: { clientTty: string; bundleId?: string };
}

interface TerminalRow {
  id: string;
  label: string;
  /** The row's own candidate bundle ids for the Level-1 raise, best first — empty for a multiplexer row, whose raise target is the outer app, never the multiplexer itself. */
  bundleIds: string[];
  needsTcc: boolean;
  /** This row's declared capability — tmux/zellij declare "exact" even though `buildExact` may still degrade to `undefined` for a given session. */
  level: "exact" | "app";
  isMultiplexer: boolean;
  /** True when this row's own exact-tab command already raises the window (every AppleScript `activate`, Ghostty's `focus`, kitty's `focus-window`) — a Level-1 raise is skipped only then. */
  raisesWindow: boolean;
  detect(locator: TerminalLocator): boolean;
  /** `undefined` when this row matched but the locator (plus `liveFacts`, for tmux) doesn't carry enough to build an exact command for this session — never a guess. */
  buildExact(locator: TerminalLocator, liveFacts: LiveFacts): FocusStep[] | undefined;
}

/** Escape a string for a double-quoted AppleScript literal — kept local rather than importing a notifier-named function into a module that has nothing to do with notifications. */
function quoteAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Tty is the documented, exposed join key in Apple Terminal's AppleScript dictionary — `TERM_SESSION_ID` isn't in the sdef at all. */
function appleTerminalScript(tty: string): string {
  const needle = quoteAppleScriptString(tty);
  return (
    `tell application "Terminal"\n` +
    `  repeat with w in windows\n` +
    `    repeat with t in tabs of w\n` +
    `      if tty of t is ${needle} then\n` +
    `        set selected of t to true\n` +
    `        set index of w to 1\n` +
    `        activate\n` +
    `        return\n` +
    `      end if\n` +
    `    end repeat\n` +
    `  end repeat\n` +
    `end tell`
  );
}

/** iTerm2 exposes `tty` as a documented session property — the common `ITERM_SESSION_ID` → UUID match is community knowledge only, never relied on here. */
function iterm2Script(tty: string): string {
  const needle = quoteAppleScriptString(tty);
  return (
    `tell application "iTerm2"\n` +
    `  repeat with w in windows\n` +
    `    repeat with t in tabs of w\n` +
    `      repeat with s in sessions of t\n` +
    `        if tty of s is ${needle} then\n` +
    `          select s\n` +
    `          activate\n` +
    `          return\n` +
    `        end if\n` +
    `      end repeat\n` +
    `    end repeat\n` +
    `  end repeat\n` +
    `end tell`
  );
}

/** Ghostty exports no per-surface id, so the match is a heuristic — the first terminal whose working directory contains the captured `PWD`; ambiguous when more than one surface matches. */
function ghosttyScript(pwd: string): string {
  const needle = quoteAppleScriptString(pwd);
  return `tell application id "com.mitchellh.ghostty" to focus (first terminal whose working directory contains ${needle})`;
}

const ORCA_CLI_PATH = "/Applications/Orca.app/Contents/Resources/bin/orca";

/**
 * Order matters here beyond readability: `detectRow` below is a plain
 * `.find`, so the two multiplexer rows come FIRST — a Session inside tmux
 * also carries stale, inherited outer-terminal vars, and matching Orca or
 * Apple Terminal on those first would raise the WRONG terminal entirely.
 */
const ROWS: TerminalRow[] = [
  {
    id: "tmux",
    label: "tmux",
    bundleIds: [],
    needsTcc: false,
    level: "exact",
    isMultiplexer: true,
    raisesWindow: false,
    detect: (l) => l.tmuxPane !== undefined,
    buildExact: (l, live) => {
      if (!l.tmuxSocket || !l.tmuxPane || !live.tmuxOuter) return undefined;
      return [
        { kind: "spawn", argv: ["tmux", "-S", l.tmuxSocket, "switch-client", "-c", live.tmuxOuter.clientTty, "-t", l.tmuxPane] },
      ];
    },
  },
  {
    id: "zellij",
    label: "Zellij",
    bundleIds: [],
    needsTcc: false,
    level: "exact",
    isMultiplexer: true,
    raisesWindow: false,
    detect: (l) => l.zellijPane !== undefined,
    buildExact: (l) => {
      if (!l.zellijSession || !l.zellijPane) return undefined;
      return [{ kind: "spawn", argv: ["zellij", "--session", l.zellijSession, "action", "focus-pane-id", l.zellijPane] }];
    },
  },
  {
    id: "orca",
    label: "Orca",
    bundleIds: ["com.stablyai.orca"],
    needsTcc: false,
    level: "exact",
    isMultiplexer: false,
    raisesWindow: false,
    detect: (l) => l.orcaHandle !== undefined,
    buildExact: (l) =>
      l.orcaHandle ? [{ kind: "spawn", argv: [ORCA_CLI_PATH, "terminal", "switch", "--terminal", l.orcaHandle] }] : undefined,
  },
  {
    id: "apple-terminal",
    label: "Terminal",
    bundleIds: ["com.apple.Terminal"],
    needsTcc: true,
    level: "exact",
    isMultiplexer: false,
    raisesWindow: true,
    detect: (l) => l.termProgram === "Apple_Terminal",
    buildExact: (l) => (l.tty ? [{ kind: "osascript", script: appleTerminalScript(l.tty) }] : undefined),
  },
  {
    id: "iterm2",
    label: "iTerm2",
    bundleIds: ["com.googlecode.iterm2"],
    needsTcc: true,
    level: "exact",
    isMultiplexer: false,
    raisesWindow: true,
    detect: (l) => l.termProgram === "iTerm.app" || l.itermSessionId !== undefined,
    buildExact: (l) => (l.tty ? [{ kind: "osascript", script: iterm2Script(l.tty) }] : undefined),
  },
  {
    id: "ghostty",
    label: "Ghostty",
    bundleIds: ["com.mitchellh.ghostty"],
    needsTcc: true,
    level: "exact",
    isMultiplexer: false,
    raisesWindow: true,
    detect: (l) => l.termProgram === "ghostty",
    buildExact: (l) => (l.pwd ? [{ kind: "osascript", script: ghosttyScript(l.pwd) }] : undefined),
  },
  {
    id: "wezterm",
    label: "WezTerm",
    bundleIds: ["com.github.wez.wezterm"],
    needsTcc: false,
    level: "exact",
    isMultiplexer: false,
    raisesWindow: false,
    detect: (l) => l.weztermPane !== undefined,
    buildExact: (l) => {
      if (!l.weztermPane) return undefined;
      const step: FocusStep = { kind: "spawn", argv: ["wezterm", "cli", "activate-pane", "--pane-id", l.weztermPane] };
      if (l.weztermSocket) step.env = { WEZTERM_UNIX_SOCKET: l.weztermSocket };
      return [step];
    },
  },
  {
    id: "kitty",
    label: "kitty",
    bundleIds: ["net.kovidgoyal.kitty"],
    needsTcc: false,
    level: "exact",
    isMultiplexer: false,
    raisesWindow: true,
    // Needs kitty's remote control enabled (`KITTY_LISTEN_ON` captured) to
    // reach level 2 — otherwise `planFocus` degrades to "app", never a guess.
    detect: (l) => l.kittyWindowId !== undefined,
    buildExact: (l) =>
      l.kittyWindowId && l.kittyListenOn
        ? [{ kind: "spawn", argv: ["kitten", "@", "--to", l.kittyListenOn, "focus-window", "--match", `id:${l.kittyWindowId}`] }]
        : undefined,
  },
];

export function detectRow(locator: TerminalLocator): TerminalRow | undefined {
  return ROWS.find((row) => row.detect(locator));
}

/** Friendly display names for well-known bundle ids — a bundle id not in this map falls back to `outerApp`'s basename, never a raw reverse-DNS string on the card. */
const KNOWN_APP_LABELS: Record<string, string> = {
  "dev.warp.Warp-Stable": "Warp",
  "org.alacritty": "Alacritty",
  "com.microsoft.VSCode": "VS Code",
  "com.todesktop.230313mzl4w4u92": "Cursor",
  "com.apple.Terminal": "Terminal",
};

function basenameWithoutAppSuffix(appPath: string): string {
  const base = appPath.split("/").pop() ?? appPath;
  return base.endsWith(".app") ? base.slice(0, -4) : base;
}

function genericAppLabel(locator: TerminalLocator): string | undefined {
  if (locator.bundleId) return KNOWN_APP_LABELS[locator.bundleId] ?? locator.bundleId;
  if (locator.outerApp) return basenameWithoutAppSuffix(locator.outerApp);
  return undefined;
}

function buildOpenStep(bundleId: string | undefined, outerApp: string | undefined): FocusStep | undefined {
  if (bundleId) return { kind: "spawn", argv: ["open", "-b", bundleId] };
  if (outerApp) return { kind: "spawn", argv: ["open", "-a", outerApp] };
  return undefined;
}

/** Raises whatever `.app` or bundle id the capture still caught, app-level only — there's no row here that knows how to build an exact tab. */
function genericFallbackPlan(locator: TerminalLocator): FocusPlan {
  const raise = buildOpenStep(locator.bundleId, locator.outerApp);
  if (!raise) return { level: "unknown", appLabel: undefined, steps: [] };
  return { level: "app", appLabel: genericAppLabel(locator), steps: [raise] };
}

/**
 * Resolves `locator` (plus whatever `liveFacts` a caller already resolved
 * live, for tmux) into the ordered steps the focuser port should run.
 * PURE — never spawns anything itself, so every row's command can be
 * asserted against a fixture locator. `locator` of `undefined` — no
 * capture at all — degrades to "unknown", no steps, never a crash.
 */
export function planFocus(locator: TerminalLocator | undefined, liveFacts: LiveFacts = {}): FocusPlan {
  if (!locator) return { level: "unknown", appLabel: undefined, steps: [] };

  const row = detectRow(locator);
  if (!row) return genericFallbackPlan(locator);

  const exactSteps = row.buildExact(locator, liveFacts);
  const steps: FocusStep[] = exactSteps ? [...exactSteps] : [];

  if (!exactSteps || !row.raisesWindow) {
    const liveBundle = row.isMultiplexer ? liveFacts.tmuxOuter?.bundleId : undefined;
    const bundle = row.bundleIds[0] ?? liveBundle ?? locator.bundleId;
    const raise = buildOpenStep(bundle, locator.outerApp);
    if (raise) steps.push(raise);
  }

  // A row matched but nothing could be built for this session (e.g.
  // Zellij's `zellijPane` captured without `zellijSession`) — `steps` is
  // empty, so report "unknown" rather than an "app" label with nothing
  // behind it.
  if (steps.length === 0) return { level: "unknown", appLabel: undefined, steps: [] };

  return { level: exactSteps ? row.level : "app", appLabel: row.label, steps };
}

/**
 * A synthetic `LiveFacts` for `reachFor` only — asks "if live resolution
 * succeeds at click time, what level would this row reach," without ever
 * being fed to the focuser port (the empty `clientTty` would build a
 * useless `-c ""`). Without it, every tmux card would render "app" even
 * though tmux is just as reliably exact as Orca; the real click-time call
 * always resolves `LiveFacts` for real, and degrades to "app" on its own
 * if that resolution ever comes back empty.
 */
const OPTIMISTIC_LIVE_FACTS: LiveFacts = { tmuxOuter: { clientTty: "" } };

/**
 * The pre-click reach a card's label renders from — computed without any
 * live resolution, which only ever happens inside the real click
 * (`daemon.ts`'s focus route). `needsTcc` rides along so the UI can warn
 * that macOS will prompt for permission.
 */
export function reachFor(
  locator: TerminalLocator | undefined,
): { level: FocusLevel; appLabel: string | undefined; needsTcc: boolean } {
  const plan = planFocus(locator, OPTIMISTIC_LIVE_FACTS);
  const row = locator ? detectRow(locator) : undefined;
  return { level: plan.level, appLabel: plan.appLabel, needsTcc: row?.needsTcc ?? false };
}

// ---------------------------------------------------------------------------
// The one I/O-performing resolution in this otherwise-pure module: tmux's
// live outer-app lookup, resolved fresh via `list-clients` rather than off
// the stale hook env. Used only by `daemon.ts`'s focus route at click
// time — `planFocus`/`reachFor` above never call it, only ever a fixture.
// ---------------------------------------------------------------------------

/** Walks a PID's parent chain to the outermost `.app` on its path — tmux's own outer app can't be read off the captured locator at all, only resolved live from a client's pid. */
function outermostAppPath(startPid: string): string | undefined {
  let pid = startPid;
  let lastApp: string | undefined;
  for (let hop = 0; hop < 32; hop++) {
    let line: string;
    try {
      const proc = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", pid]);
      if (proc.exitCode !== 0) break;
      line = proc.stdout.toString("utf8").trim();
    } catch {
      break;
    }
    if (!line) break;
    const [ppid, ...commParts] = line.split(/\s+/);
    const comm = commParts.join(" ");
    const appMatch = /^(.*\.app)\//.exec(comm);
    if (appMatch) lastApp = appMatch[1];
    if (!ppid || ppid === "1" || ppid === pid) break;
    pid = ppid;
  }
  return lastApp;
}

function bundleIdForAppPath(appPath: string): string | undefined {
  try {
    const proc = Bun.spawnSync(["mdls", "-name", "kMDItemCFBundleIdentifier", "-raw", appPath]);
    if (proc.exitCode !== 0) return undefined;
    const out = proc.stdout.toString("utf8").trim();
    return out && out !== "(null)" ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Picks the most recently active tmux client (by `client_activity`) when
 * several are attached, then walks its pid to the outermost `.app` for
 * the raise target. Never throws — any failure here falls through to the
 * captured locator's own (possibly stale) fields via `planFocus`'s
 * degrade path, never a crash on the human's click.
 */
export function resolveTmuxOuterLive(socket: string): { clientTty: string; bundleId?: string } | undefined {
  try {
    const proc = Bun.spawnSync([
      "tmux",
      "-S",
      socket,
      "list-clients",
      "-F",
      "#{client_tty}\t#{client_pid}\t#{client_activity}",
    ]);
    if (proc.exitCode !== 0) return undefined;
    const lines = proc.stdout
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return undefined;

    const [best] = [...lines].sort((a, b) => Number(b.split("\t")[2] ?? 0) - Number(a.split("\t")[2] ?? 0));
    const [clientTty, clientPid] = (best ?? "").split("\t");
    if (!clientTty || !clientPid) return undefined;

    const appPath = outermostAppPath(clientPid);
    const bundleId = appPath ? bundleIdForAppPath(appPath) : undefined;
    return { clientTty, bundleId };
  } catch {
    return undefined;
  }
}
