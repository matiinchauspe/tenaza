import { describe, expect, test } from "bun:test";
import { captureProcessMarker, captureTerminalLocator, localeFromEnv, outermostApp } from "../src/terminallocator";

/**
 * `localeFromEnv` is PURE (env vars in, locator fields out, no I/O) and
 * `captureTerminalLocator` takes an injectable `psWalk` — same shape
 * `sessions.ts`'s own `deriveProject`/`resolveGitRoot` pair already uses —
 * so the one real process-table read (`defaultPsWalk`) is never exercised
 * by a unit test here.
 */

describe("localeFromEnv — every per-terminal key, pure mapping", () => {
  test("an empty env captures nothing at all", () => {
    expect(localeFromEnv({})).toEqual({});
  });

  test("Orca's own env", () => {
    expect(localeFromEnv({ TERM_PROGRAM: "Orca", ORCA_TERMINAL_HANDLE: "term_abc", __CFBundleIdentifier: "com.stablyai.orca" })).toEqual(
      { termProgram: "Orca", orcaHandle: "term_abc", bundleId: "com.stablyai.orca" },
    );
  });

  test("TMUX's own comma-delimited value: only the first field (the socket path) is captured", () => {
    expect(localeFromEnv({ TMUX: "/private/tmp/tmux-501/default,51691,0", TMUX_PANE: "%2" })).toEqual({
      tmuxSocket: "/private/tmp/tmux-501/default",
      tmuxPane: "%2",
    });
  });

  test("every other per-terminal key copies straight through", () => {
    expect(
      localeFromEnv({
        ITERM_SESSION_ID: "w0t0p0:ABC",
        WEZTERM_PANE: "3",
        WEZTERM_UNIX_SOCKET: "/tmp/wezterm/sock",
        KITTY_WINDOW_ID: "1",
        KITTY_LISTEN_ON: "unix:/tmp/kitty.sock",
        ZELLIJ_SESSION_NAME: "work",
        ZELLIJ_PANE_ID: "terminal_1",
        PWD: "/Users/mati/repo",
      }),
    ).toEqual({
      itermSessionId: "w0t0p0:ABC",
      weztermPane: "3",
      weztermSocket: "/tmp/wezterm/sock",
      kittyWindowId: "1",
      kittyListenOn: "unix:/tmp/kitty.sock",
      zellijSession: "work",
      zellijPane: "terminal_1",
      pwd: "/Users/mati/repo",
    });
  });

  test("an env var set to the empty string is never captured — same as absent", () => {
    expect(localeFromEnv({ TERM_PROGRAM: "", ORCA_TERMINAL_HANDLE: "term_abc" })).toEqual({ orcaHandle: "term_abc" });
  });

  test("undefined values (how process.env actually types unset vars) are skipped too", () => {
    expect(localeFromEnv({ TERM_PROGRAM: undefined, PWD: "/tmp" })).toEqual({ pwd: "/tmp" });
  });
});

describe("captureTerminalLocator — combines the env mapping with an injectable psWalk", () => {
  test("merges tty/outerApp from psWalk onto the env-derived fields", () => {
    const locator = captureTerminalLocator(
      { TERM_PROGRAM: "Apple_Terminal" },
      1234,
      () => ({ tty: "/dev/ttys003", outerApp: "/Applications/Utilities/Terminal.app" }),
    );
    expect(locator).toEqual({ termProgram: "Apple_Terminal", tty: "/dev/ttys003", outerApp: "/Applications/Utilities/Terminal.app" });
  });

  test("nothing captured at all (empty env, psWalk finds neither tty nor outerApp) → undefined, never an empty object", () => {
    const locator = captureTerminalLocator({}, 1234, () => ({}));
    expect(locator).toBeUndefined();
  });

  test("a throwing psWalk degrades to the env-only fields rather than crashing SessionStart", () => {
    const locator = captureTerminalLocator({ TERM_PROGRAM: "WarpTerminal" }, 1234, () => {
      throw new Error("ps unavailable in this sandbox");
    });
    expect(locator).toEqual({ termProgram: "WarpTerminal" });
  });

  test("psWalk alone (no env vars at all) still yields a locator — the generic fallback's own raise target", () => {
    const locator = captureTerminalLocator({}, 1234, () => ({ outerApp: "/Applications/Alacritty.app" }));
    expect(locator).toEqual({ outerApp: "/Applications/Alacritty.app" });
  });
});

describe("captureProcessMarker (ticket 02) — pid + its process-start marker, via an injectable psRead", () => {
  test("pairs the given pid with psRead's own lstart output", () => {
    const marker = captureProcessMarker(1234, (pid, format) => {
      expect(pid).toBe("1234");
      expect(format).toBe("lstart=");
      return "Wed Oct 28 10:00:00 2026";
    });
    expect(marker).toEqual({ pid: 1234, startedAt: "Wed Oct 28 10:00:00 2026" });
  });

  test("defaults pid to process.ppid — the SAME hop captureTerminalLocator's own walk targets", () => {
    const marker = captureProcessMarker(undefined, () => "whatever");
    expect(marker.pid).toBe(process.ppid);
  });

  test("psRead returning nothing (ps couldn't report lstart) still captures the bare pid", () => {
    const marker = captureProcessMarker(1234, () => undefined);
    expect(marker).toEqual({ pid: 1234, startedAt: undefined });
  });

  test("a throwing psRead degrades to the bare pid alone, never crashes SessionStart", () => {
    const marker = captureProcessMarker(1234, () => {
      throw new Error("ps unavailable in this sandbox");
    });
    expect(marker).toEqual({ pid: 1234 });
  });
});

describe("outermostApp — the generic fallback's raise target", () => {
  test("a helper nested inside the app resolves to the outer bundle, never the helper", () => {
    expect(outermostApp("/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper")).toBe(
      "/Applications/Orca.app",
    );
  });

  test("a plain app binary", () => {
    expect(outermostApp("/Applications/Alacritty.app/Contents/MacOS/alacritty")).toBe("/Applications/Alacritty.app");
  });

  test("a path with no bundle captures nothing", () => {
    expect(outermostApp("/bin/zsh")).toBeUndefined();
    expect(outermostApp("-zsh")).toBeUndefined();
  });
});
