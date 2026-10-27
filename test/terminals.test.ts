import { describe, expect, test } from "bun:test";
import type { TerminalLocator } from "../src/contract/event";
import { detectRow, planFocus, reachFor, resolveTmuxOuterLive } from "../src/terminals";

/**
 * Ticket 11's own test requirement: "tested through a focuser port swapped
 * via the environment: per row, assert the command built from a captured
 * locator — never a real focus." `planFocus`/`reachFor` are the PURE core
 * this exercises directly (no process ever spawned here); `focus.test.ts`
 * covers the focuser port itself (the env-swap half of that sentence).
 */

describe("planFocus — no locator at all (legacy v0.1 data)", () => {
  test("undefined locator → unknown, no steps — never a crash", () => {
    expect(planFocus(undefined)).toEqual({ level: "unknown", appLabel: undefined, steps: [] });
  });

  test("an empty locator (nothing captured at all) → unknown, no steps", () => {
    expect(planFocus({})).toEqual({ level: "unknown", appLabel: undefined, steps: [] });
  });
});

describe("planFocus — Orca (verified, no prompt)", () => {
  const locator: TerminalLocator = { termProgram: "Orca", orcaHandle: "term_abc123", bundleId: "com.stablyai.orca" };

  test("builds the absolute-path switch command plus a Level-1 raise", () => {
    const plan = planFocus(locator);
    expect(plan.level).toBe("exact");
    expect(plan.appLabel).toBe("Orca");
    expect(plan.steps).toEqual([
      {
        kind: "spawn",
        argv: ["/Applications/Orca.app/Contents/Resources/bin/orca", "terminal", "switch", "--terminal", "term_abc123"],
      },
      { kind: "spawn", argv: ["open", "-b", "com.stablyai.orca"] },
    ]);
  });

  test("no orcaHandle captured → degrades to the generic app-level fallback", () => {
    const plan = planFocus({ termProgram: "Orca", bundleId: "com.stablyai.orca" });
    expect(plan.level).toBe("app");
    expect(plan.steps).toEqual([{ kind: "spawn", argv: ["open", "-b", "com.stablyai.orca"] }]);
  });
});

describe("planFocus — tmux (multiplexer, outer app resolved live)", () => {
  const locator: TerminalLocator = { termProgram: "tmux", tmuxSocket: "/tmp/tmux-501/default", tmuxPane: "%3" };

  test("multiplexer vars win: tmux is detected even when stale outer vars (inherited from whatever started the server) are also present", () => {
    const row = detectRow({ ...locator, termProgram: "Orca", orcaHandle: "term_stale", bundleId: "com.stablyai.orca" });
    expect(row?.id).toBe("tmux");
  });

  test("with a live-resolved client tty, builds switch-client -c plus the live outer app's raise", () => {
    const plan = planFocus(locator, { tmuxOuter: { clientTty: "/dev/ttys005", bundleId: "com.googlecode.iterm2" } });
    expect(plan.level).toBe("exact");
    expect(plan.appLabel).toBe("tmux");
    expect(plan.steps).toEqual([
      { kind: "spawn", argv: ["tmux", "-S", "/tmp/tmux-501/default", "switch-client", "-c", "/dev/ttys005", "-t", "%3"] },
      { kind: "spawn", argv: ["open", "-b", "com.googlecode.iterm2"] },
    ]);
  });

  test("live resolution came back with no bundle id → the exact step still runs, raise falls back to the captured (possibly stale) locator fields", () => {
    const plan = planFocus(
      { ...locator, bundleId: "com.stablyai.orca" },
      { tmuxOuter: { clientTty: "/dev/ttys005" } },
    );
    expect(plan.steps[0]).toEqual({
      kind: "spawn",
      argv: ["tmux", "-S", "/tmp/tmux-501/default", "switch-client", "-c", "/dev/ttys005", "-t", "%3"],
    });
    expect(plan.steps[1]).toEqual({ kind: "spawn", argv: ["open", "-b", "com.stablyai.orca"] });
  });

  test("no live facts at all (live resolution never attempted, or failed outright) → degrades to app, using the captured (stale) outer fields", () => {
    const plan = planFocus({ ...locator, bundleId: "com.stablyai.orca" });
    expect(plan.level).toBe("app");
    expect(plan.steps).toEqual([{ kind: "spawn", argv: ["open", "-b", "com.stablyai.orca"] }]);
  });

  test("reachFor is still optimistic (exact) ahead of any click — tmux ships in the same verified tier as Orca", () => {
    expect(reachFor(locator)).toEqual({ level: "exact", appLabel: "tmux", needsTcc: false });
  });
});

describe("planFocus — Zellij (ships as code, unverified locally — but its OWN pane command needs no live resolution)", () => {
  const locator: TerminalLocator = { zellijSession: "work", zellijPane: "terminal_1" };

  test("builds the focus-pane-id command straight from the locator, no live facts needed", () => {
    const plan = planFocus(locator);
    expect(plan.level).toBe("exact");
    expect(plan.steps[0]).toEqual({ kind: "spawn", argv: ["zellij", "--session", "work", "action", "focus-pane-id", "terminal_1"] });
  });

  test("the app raise falls back to whatever outer fields were captured (research's own documented, accepted gap — may be stale)", () => {
    const plan = planFocus({ ...locator, outerApp: "/Applications/Ghostty.app" });
    expect(plan.steps[1]).toEqual({ kind: "spawn", argv: ["open", "-a", "/Applications/Ghostty.app"] });
  });

  test("missing zellijSession → degrades to app (or unknown with nothing to raise)", () => {
    const plan = planFocus({ zellijPane: "terminal_1" });
    expect(plan.level).toBe("unknown");
  });
});

describe("planFocus — Apple Terminal (behind a TCC prompt)", () => {
  const locator: TerminalLocator = { termProgram: "Apple_Terminal", tty: "/dev/ttys003" };

  test("builds the tty-matching AppleScript — its own activate already raises, no separate Level-1 step", () => {
    const plan = planFocus(locator);
    expect(plan.level).toBe("exact");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.kind).toBe("osascript");
    expect((plan.steps[0] as { kind: "osascript"; script: string }).script).toContain('tty of t is "/dev/ttys003"');
  });

  test("needsTcc is true for this row", () => {
    expect(reachFor(locator).needsTcc).toBe(true);
  });

  test("no tty captured → degrades to app, raising the known bundle id", () => {
    const plan = planFocus({ termProgram: "Apple_Terminal" });
    expect(plan.level).toBe("app");
    expect(plan.steps).toEqual([{ kind: "spawn", argv: ["open", "-b", "com.apple.Terminal"] }]);
  });
});

describe("planFocus — iTerm2 (behind a TCC prompt)", () => {
  test("detected via ITERM_SESSION_ID even without TERM_PROGRAM=iTerm.app, builds the tty-matching AppleScript", () => {
    const plan = planFocus({ itermSessionId: "w0t0p0:ABC", tty: "/dev/ttys007" });
    expect(plan.level).toBe("exact");
    expect(plan.steps).toHaveLength(1);
    expect((plan.steps[0] as { kind: "osascript"; script: string }).script).toContain('tty of s is "/dev/ttys007"');
  });
});

describe("planFocus — Ghostty (behind a TCC prompt, cwd/title heuristic)", () => {
  test("builds the working-directory-match AppleScript from the captured PWD; focus already raises", () => {
    const plan = planFocus({ termProgram: "ghostty", pwd: "/Users/mati/repo" });
    expect(plan.level).toBe("exact");
    expect(plan.steps).toHaveLength(1);
    expect((plan.steps[0] as { kind: "osascript"; script: string }).script).toContain('working directory contains "/Users/mati/repo"');
  });

  test("no PWD captured → degrades to app, raising the known bundle id", () => {
    const plan = planFocus({ termProgram: "ghostty" });
    expect(plan.level).toBe("app");
    expect(plan.steps).toEqual([{ kind: "spawn", argv: ["open", "-b", "com.mitchellh.ghostty"] }]);
  });
});

describe("planFocus — WezTerm (ships as code, unverified locally)", () => {
  test("builds activate-pane with the socket set as the step's own env, plus a Level-1 raise (not known to raise on its own)", () => {
    const plan = planFocus({ weztermPane: "7", weztermSocket: "/tmp/wezterm/sock" });
    expect(plan.level).toBe("exact");
    expect(plan.steps).toEqual([
      { kind: "spawn", argv: ["wezterm", "cli", "activate-pane", "--pane-id", "7"], env: { WEZTERM_UNIX_SOCKET: "/tmp/wezterm/sock" } },
      { kind: "spawn", argv: ["open", "-b", "com.github.wez.wezterm"] },
    ]);
  });

  test("no socket captured → the spawn step carries no env override at all", () => {
    const plan = planFocus({ weztermPane: "7" });
    expect(plan.steps[0]).toEqual({ kind: "spawn", argv: ["wezterm", "cli", "activate-pane", "--pane-id", "7"] });
  });
});

describe("planFocus — kitty (exact only when remote control was configured)", () => {
  test("KITTY_WINDOW_ID + KITTY_LISTEN_ON both captured → exact, focus-window already raises", () => {
    const plan = planFocus({ kittyWindowId: "3", kittyListenOn: "unix:/tmp/kitty.sock" });
    expect(plan.level).toBe("exact");
    expect(plan.steps).toEqual([
      { kind: "spawn", argv: ["kitten", "@", "--to", "unix:/tmp/kitty.sock", "focus-window", "--match", "id:3"] },
    ]);
  });

  test("KITTY_WINDOW_ID alone (remote control never configured) → degrades to app, per research's own 'else Level 1'", () => {
    const plan = planFocus({ kittyWindowId: "3", bundleId: "net.kovidgoyal.kitty" });
    expect(plan.level).toBe("app");
    expect(plan.steps).toEqual([{ kind: "spawn", argv: ["open", "-b", "net.kovidgoyal.kitty"] }]);
  });

  test("reachFor reports 'app' for this session too — the static label never overpromises past what THIS locator can build", () => {
    expect(reachFor({ kittyWindowId: "3" }).level).toBe("app");
  });
});

describe("planFocus — the generic Level-1 fallback (Warp, Alacritty, VS Code, Cursor, unknown)", () => {
  test("a captured bundleId with no matching row raises by bundle id, labeled by the known-apps map", () => {
    const plan = planFocus({ termProgram: "WarpTerminal", bundleId: "dev.warp.Warp-Stable" });
    expect(plan).toEqual({ level: "app", appLabel: "Warp", steps: [{ kind: "spawn", argv: ["open", "-b", "dev.warp.Warp-Stable"] }] });
  });

  test("Cursor and VS Code tell apart by bundle id alone, same TERM_PROGRAM=vscode", () => {
    expect(planFocus({ termProgram: "vscode", bundleId: "com.todesktop.230313mzl4w4u92" }).appLabel).toBe("Cursor");
    expect(planFocus({ termProgram: "vscode", bundleId: "com.microsoft.VSCode" }).appLabel).toBe("VS Code");
  });

  test("only the PID-walk's outerApp was captured (no bundle id at all) → raises by -a, labeled from the .app basename", () => {
    const plan = planFocus({ outerApp: "/Applications/Alacritty.app" });
    expect(plan).toEqual({
      level: "app",
      appLabel: "Alacritty",
      steps: [{ kind: "spawn", argv: ["open", "-a", "/Applications/Alacritty.app"] }],
    });
  });

  test("an unrecognized bundle id still raises, labeled by the bundle id itself rather than nothing", () => {
    const plan = planFocus({ bundleId: "com.example.SomeNewTerminal" });
    expect(plan.appLabel).toBe("com.example.SomeNewTerminal");
  });
});

describe("detectRow — row priority (multiplexer vars win over outer vars)", () => {
  test("tmux is detected ahead of Orca when both are present (research §1.2's own reproduced gotcha)", () => {
    const row = detectRow({ tmuxPane: "%0", orcaHandle: "term_x", termProgram: "Orca" });
    expect(row?.id).toBe("tmux");
  });

  test("zellij is detected ahead of Apple Terminal when both are present", () => {
    const row = detectRow({ zellijPane: "p1", termProgram: "Apple_Terminal" });
    expect(row?.id).toBe("zellij");
  });
});

describe("resolveTmuxOuterLive — the ONE real I/O function here, never exercised by planFocus's own tests above", () => {
  test("a socket naming no real tmux server degrades to undefined, never throws", () => {
    expect(resolveTmuxOuterLive("/tmp/tenaza-test-no-such-tmux-socket-xyz")).toBeUndefined();
  });
});
