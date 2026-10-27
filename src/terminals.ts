import type { TerminalLocator } from "./contract/event";

/**
 * Go to the agent's terminal (decision 09, ticket 11). "Focusing is NOT an
 * Adapter Capability: it belongs to the terminal, not the runtime" (spec) —
 * so this module is CORE, not an Adapter: it never reads `process.env`
 * itself (that is `terminallocator.ts`'s own job, at SessionStart, once),
 * and it resolves a terminal table over whatever `TerminalLocator` it is
 * handed. A new terminal is a new ROW here — never a new `if` branch
 * anywhere else in this file.
 *
 * Two levels, per the research (`docs/research/tenaza-focus-agent-terminal.md`):
 * level 1 always raises the terminal APPLICATION (`open -b <bundle>`);
 * level 2 focuses the exact tab/pane when the row can. `planFocus` below is
 * PURE — it never spawns a process itself (that is `focus.ts`'s own job,
 * the focuser port) — so every row's own command can be asserted directly
 * against a captured (fixture) locator, never a real focus.
 */

export type FocusLevel = "exact" | "app" | "unknown";

/** One step the focuser port (`focus.ts`) can run, in order. `env` (spawn only) layers ON TOP of the focuser's own process env — WezTerm's CLI needs `WEZTERM_UNIX_SOCKET` set exactly this way when reaching a non-default instance. */
export type FocusStep =
  | { kind: "spawn"; argv: string[]; env?: Record<string, string> }
  | { kind: "osascript"; script: string };

export interface FocusPlan {
  level: FocusLevel;
  /** The terminal app's own display name — undefined only when `level` is "unknown" (nothing was ever captured to raise). */
  appLabel: string | undefined;
  /** In click order — an exact-tab step first (when one was built), then a Level-1 app raise UNLESS the exact step already raises the window on its own. Empty exactly when `level` is "unknown". */
  steps: FocusStep[];
}

/**
 * What a LIVE resolution contributes, for the one row that structurally
 * needs it (tmux — research §1.2: the client tty to target with
 * `switch-client -c` is never captured at SessionStart, only discoverable
 * from `tmux list-clients` at CLICK time, since the outer vars captured
 * then describe whatever started the tmux SERVER, not the attached
 * client). `undefined` fields degrade gracefully — see `planFocus`'s own
 * doc on what happens when live resolution wasn't attempted or came back
 * empty.
 */
export interface LiveFacts {
  tmuxOuter?: { clientTty: string; bundleId?: string };
}

interface TerminalRow {
  id: string;
  label: string;
  /** The row's own candidate bundle ids for the Level-1 raise, best first — empty for a multiplexer row (tmux/zellij), whose raise target is the OUTER app, never the multiplexer itself. */
  bundleIds: string[];
  needsTcc: boolean;
  /** This row's own CAPABILITY when it matches — tmux/zellij declare "exact" even though building it may still degrade per-session (`buildExact` returning `undefined`): the ONE static fact per row the ticket's own data shape names. */
  level: "exact" | "app";
  isMultiplexer: boolean;
  /** True when this row's own exact-tab command ALREADY raises the window (every AppleScript `activate`, Ghostty's `focus`, kitty's `focus-window`) — a Level-1 raise is skipped only then. */
  raisesWindow: boolean;
  detect(locator: TerminalLocator): boolean;
  /** `undefined` when this row matched but the locator (plus `liveFacts`, for tmux) doesn't carry enough to build an exact command for THIS session — never a guess. */
  buildExact(locator: TerminalLocator, liveFacts: LiveFacts): FocusStep[] | undefined;
}

/** Escape a string for a double-quoted AppleScript literal — same two replacements `notify.ts`'s own `quoteAppleScriptString` already makes (backslash, then quote), kept local here rather than importing a notifier-named function into a module that has nothing to do with notifications. */
function quoteAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Apple Terminal (research §1.7): the tab whose own `tty` matches, selected, window 1 raised, then `activate` (which also raises the app — `raisesWindow: true`). Tty is the documented, exposed join key — `TERM_SESSION_ID` is not in the sdef at all. */
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

/** iTerm2 (research §1.3): sessions expose `tty` as a documented property (the ITERM_SESSION_ID → UUID match is community knowledge, never relied on here); `select` makes the session active in its tab, then `activate` raises the app. */
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

/** Ghostty (research §1.6): no per-surface id is exported, so the match is the documented heuristic — "every terminal whose working directory contains" the captured `PWD`; `focus` raises the window on its own. "best guess" when more than one surface matches is the UI's own label to show (`terminals.ts` never knows how many matched). */
function ghosttyScript(pwd: string): string {
  const needle = quoteAppleScriptString(pwd);
  return `tell application id "com.mitchellh.ghostty" to focus (first terminal whose working directory contains ${needle})`;
}

const ORCA_CLI_PATH = "/Applications/Orca.app/Contents/Resources/bin/orca";

/**
 * Ship ORDER matters here beyond readability: `detectRow` below is a plain
 * `.find`, and the two multiplexer rows come FIRST so "multiplexer vars
 * win" (spec, decision 09) falls out of array order alone — a Session
 * inside tmux also carries (stale, inherited) outer vars (research §1.2's
 * own reproduced gotcha), and matching Orca or Apple Terminal on those
 * first would raise the WRONG terminal entirely.
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
    // Research §1.5: only reachable at level 2 when remote control was configured (`KITTY_LISTEN_ON` captured) — otherwise `buildExact` returns `undefined` below and `planFocus` degrades this session's OWN level to "app", never claiming exact on a guess.
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

/** Friendly display names for the app-level fallback's own well-known bundle ids (research §1.8-§1.10) — a bundle id this map doesn't carry falls back to `outerApp`'s own basename, never a raw reverse-DNS string on the card. */
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

/**
 * The generic Level-1 fallback (research's own "covers Warp, Alacritty, VS
 * Code, Cursor and unknown terminals"): no row above matched at all, but
 * the capture still walked to an outermost `.app` or caught
 * `__CFBundleIdentifier` — raise it, app-level only, never an exact tab
 * (there is no row that knows how).
 */
function genericFallbackPlan(locator: TerminalLocator): FocusPlan {
  const raise = buildOpenStep(locator.bundleId, locator.outerApp);
  if (!raise) return { level: "unknown", appLabel: undefined, steps: [] };
  return { level: "app", appLabel: genericAppLabel(locator), steps: [raise] };
}

/**
 * Resolve `locator` (plus whatever `liveFacts` a caller already resolved
 * live, for tmux) into the ordered steps the focuser port should run.
 * PURE — never spawns anything itself. A `locator` of `undefined` (no
 * `session.started.terminal` at all — legacy v0.1 data, or a Session whose
 * start hook never captured anything) is the "terminal desconocida" case:
 * `level: "unknown"`, no steps, never a crash.
 */
export function planFocus(locator: TerminalLocator | undefined, liveFacts: LiveFacts = {}): FocusPlan {
  if (!locator) return { level: "unknown", appLabel: undefined, steps: [] };

  const row = detectRow(locator);
  if (!row) return genericFallbackPlan(locator);

  const exactSteps = row.buildExact(locator, liveFacts);
  const steps: FocusStep[] = exactSteps ? [...exactSteps] : [];

  // Append the Level-1 raise unless the exact step already raised the
  // window on its own (`raisesWindow`) — which never applies when there
  // was no exact step to begin with (a degraded-to-app session still needs
  // SOMETHING to raise).
  if (!exactSteps || !row.raisesWindow) {
    const liveBundle = row.isMultiplexer ? liveFacts.tmuxOuter?.bundleId : undefined;
    const bundle = row.bundleIds[0] ?? liveBundle ?? locator.bundleId;
    const raise = buildOpenStep(bundle, locator.outerApp);
    if (raise) steps.push(raise);
  }

  // A row matched, but neither an exact command nor a raise target could
  // ever be built for THIS session (no bundle id, no outer app, nothing —
  // e.g. Zellij detected on `zellijPane` alone with no `zellijSession` and
  // no captured outer vars at all). `steps` is empty either way, so "app"
  // would be a label with nothing behind it — report the honest
  // "unknown" instead, same as no row matching in the first place.
  if (steps.length === 0) return { level: "unknown", appLabel: undefined, steps: [] };

  return { level: exactSteps ? row.level : "app", appLabel: row.label, steps };
}

/**
 * A synthetic `LiveFacts` used ONLY by `reachFor` below, to ask "if live
 * resolution succeeds at click time, what level would this row reach" —
 * never fed to the focuser port, never returned to a caller that might
 * execute it (the empty `clientTty` would build a useless `-c ""`). The
 * REAL click-time call (`daemon.ts`'s focus route) always passes whatever
 * `terminals.ts`'s own `resolveTmuxOuterLive` actually resolved — which may
 * of course come back `undefined`, degrading that ONE session's own result
 * to "app" even though its card showed "exact" ahead of the click. Research
 * `docs/research/tenaza-focus-agent-terminal.md` ships tmux in the same
 * "verified, no prompt" tier as Orca — label it "exact" on that same
 * strength, never the conservative "app" a literal `liveFacts: {}` would
 * otherwise force it down to for every tmux card on every render.
 */
const OPTIMISTIC_LIVE_FACTS: LiveFacts = { tmuxOuter: { clientTty: "" } };

/**
 * The STATIC, pre-click reach a card's own label is built from (spec:
 * "Label by reach... ir a terminal ↗ / abrir App ↗ / terminal
 * desconocida") — computed WITHOUT attempting any live resolution (that
 * only ever happens inside the real click, server-side, in
 * `daemon.ts`'s focus route). `needsTcc` rides along so the UI can add the
 * spec's own "macOS va a pedir permiso" note.
 */
export function reachFor(
  locator: TerminalLocator | undefined,
): { level: FocusLevel; appLabel: string | undefined; needsTcc: boolean } {
  const plan = planFocus(locator, OPTIMISTIC_LIVE_FACTS);
  const row = locator ? detectRow(locator) : undefined;
  return { level: plan.level, appLabel: plan.appLabel, needsTcc: row?.needsTcc ?? false };
}

// ---------------------------------------------------------------------------
// The ONE real, I/O-performing resolution in this otherwise-pure module:
// tmux's own live outer-app lookup (research §1.2's own recommendation —
// "resolved live via list-clients, never from the stale hook env"). Used
// only by `daemon.ts`'s focus route at click time; never exercised by the
// `planFocus`/`reachFor` unit tests above, which pass `liveFacts` as a
// fixture instead of ever spawning a real `tmux`.
// ---------------------------------------------------------------------------

/** Bounded walk (never infinite) up a PID's own parent chain to the outermost `.app` on the path — same technique the research doc's §2 describes, reused here for the ONE row (tmux) whose outer app cannot be read from the captured locator at all. */
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
 * `tmux -S <socket> list-clients`, picking the most recently active client
 * (research §1.2: "With several clients attached, `client_activity` picks
 * the most recent") — its own `client_tty` is what `-c` targets, and its
 * `client_pid`, walked to the outermost `.app`, is the outer raise target.
 * Best-effort and NEVER THROWS: no tmux on PATH, no socket, no attached
 * client, or a `ps`/`mdls` call failing all degrade to `undefined` — the
 * caller (`daemon.ts`'s focus route) then falls through to the captured
 * (possibly stale) locator fields via `planFocus`'s own degrade path,
 * never a crash on the human's click.
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
