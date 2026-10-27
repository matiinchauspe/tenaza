import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { actionDecidedEvent, sessionStartedEvent } from "../src/contract/event";
import { isHeartbeatFresh, readDaemonToken, readOpenRecorder, DEFAULT_HEARTBEAT_STALE_MS } from "../src/daemon";
import { inboxIdentityHash } from "../src/identity";
import { deriveInbox } from "../src/inbox";
import { appendEvent, readHumanEvents } from "../src/log";
import { daemonAlivePath, daemonTokenPath } from "../src/paths";
import { DEFAULT_CONTEXT_THRESHOLD, DEFAULT_STALL_MINUTES } from "../src/policy";
import { RUN_FAILURE_MARKER } from "../src/runoutput";
import { TENAZA_VERSION } from "../src/version";

/** Ticket 08: `/events` now also carries the Live surface's own contract envelope and Policy numbers — every "freshly started, nothing observed yet" assertion below includes this. */
const EMPTY_BOARD_PAYLOAD = {
  v: 1,
  policy: { stallMinutes: DEFAULT_STALL_MINUTES, contextThresholdTokens: DEFAULT_CONTEXT_THRESHOLD },
  sessions: [],
  inbox: [],
};
import { runCli } from "./support/cli";
import { spawnDaemon } from "./support/daemon";

interface DerivedStatePayload {
  sessions: unknown[];
  inbox: unknown[];
}

/**
 * Connect to `/events` and hand back a small reader shared by every SSE
 * test below — factored out so the "no spurious push" regression test
 * (orchestrator review) doesn't have to duplicate the frame-parsing loop
 * the original SSE test already had.
 */
async function connectEvents(port: number): Promise<{
  nextEvent(timeoutMs: number): Promise<DerivedStatePayload>;
  expectNoEventWithin(windowMs: number): Promise<void>;
  cancel(): Promise<void>;
}> {
  const res = await fetch(`http://127.0.0.1:${port}/events`);
  if (res.status !== 200) throw new Error(`GET /events returned ${res.status}, not 200`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function nextEvent(timeoutMs: number): Promise<DerivedStatePayload> {
    return await Promise.race([
      (async (): Promise<DerivedStatePayload> => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const idx = buffer.indexOf("\n\n");
          if (idx !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
            if (dataLine) return JSON.parse(dataLine.slice("data: ".length));
            continue;
          }
          const { value, done } = await reader.read();
          if (done) throw new Error("SSE stream closed before an event arrived");
          buffer += decoder.decode(value, { stream: true });
        }
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for an SSE event")), timeoutMs),
      ),
    ]);
  }

  /** The inverse assertion the regression test needs: NO event arrives within `windowMs` — a timeout here is success, an event is the failure. */
  async function expectNoEventWithin(windowMs: number): Promise<void> {
    let arrived = false;
    try {
      await nextEvent(windowMs);
      arrived = true;
    } catch {
      arrived = false;
    }
    expect(arrived).toBe(false);
  }

  return {
    nextEvent,
    expectNoEventWithin,
    async cancel() {
      await reader.cancel();
    },
  };
}

/**
 * Ticket 07's own black-box seam: drive `tenaza ui --port 0` in a temp
 * `TENAZA_HOME` over real HTTP. `TENAZA_HEARTBEAT_MS` / `TENAZA_SSE_POLL_MS`
 * are the SAME seam `TENAZA_NOTIFY_RECORDER` already establishes elsewhere
 * — shortened intervals through the environment so these tests run in
 * milliseconds, not the production ~2s.
 */
describe("tenaza ui — the Daemon (ticket 07)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-daemon-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("GET /health returns the version over a real HTTP round trip", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ tenaza: true, version: TENAZA_VERSION });
    } finally {
      await daemon.stop();
    }
  });

  /**
   * Ticket 07 defines no concrete write route yet — `run`/`done`/`dismiss`
   * are ticket 09's job, and the live-answer route is ticket 10's. So this
   * proves the token GATE itself, structurally, against the default every
   * future write route will inherit: anything that isn't one of the three
   * explicit open reads (`/health`, `/events`, `/`) is denied without the
   * token, and falls through to the SAME "not found" a real route would
   * reach too, once ticket 09/10/11 actually defines one — i.e. passing
   * the gate, never a feature invented ahead of its own ticket.
   */
  test("a write-shaped request (non-GET, non-open-read path) is 403'd without the token, and passes the gate with it", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const bare = await fetch(`http://127.0.0.1:${daemon.port}/anything`, { method: "POST" });
      expect(bare.status).toBe(403);

      const withToken = await fetch(`http://127.0.0.1:${daemon.port}/anything`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(withToken.status).not.toBe(403);
      expect(withToken.status).toBe(404);

      const withQueryToken = await fetch(
        `http://127.0.0.1:${daemon.port}/anything?token=${daemon.token}`,
        { method: "POST" },
      );
      expect(withQueryToken.status).not.toBe(403);

      const withWrongToken = await fetch(`http://127.0.0.1:${daemon.port}/anything`, {
        method: "POST",
        headers: { cookie: "tenaza_token=not-the-real-one" },
      });
      expect(withWrongToken.status).toBe(403);
    } finally {
      await daemon.stop();
    }
  });

  /**
   * Orchestrator review, hardening: the token rotates every launch
   * (decision 05), so a browser tab left open across a restart carries a
   * STALE cookie that can never match the new one. `isAuthorizedRequest`
   * must fall back to the `?token=` query in that case rather than failing
   * outright — the same way it already does for no cookie at all.
   */
  test("a stale cookie falls back to the correct query token; a stale cookie alone still 403s", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const staleCookieWithGoodQuery = await fetch(
        `http://127.0.0.1:${daemon.port}/anything?token=${daemon.token}`,
        { method: "POST", headers: { cookie: "tenaza_token=stale-from-a-previous-launch" } },
      );
      expect(staleCookieWithGoodQuery.status).not.toBe(403);

      const staleCookieAlone = await fetch(`http://127.0.0.1:${daemon.port}/anything`, {
        method: "POST",
        headers: { cookie: "tenaza_token=stale-from-a-previous-launch" },
      });
      expect(staleCookieAlone.status).toBe(403);
    } finally {
      await daemon.stop();
    }
  });

  /**
   * Ticket 08 fix: `GET /auth?token=` replaces the client-side
   * `bootstrapTokenCookie` regression (`main.tsx`) — it must be the route
   * that actually validates the token and sets the cookie SERVER-SIDE,
   * same name/attributes ticket 07's own `indexResponse` used, then send
   * the browser on to the plain `/` with the token no longer in the URL
   * the human's tab keeps.
   */
  test("GET /auth with the correct token sets an HttpOnly, SameSite=Strict cookie and 302s to /", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/auth?token=${daemon.token}`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");

      const cookie = res.headers.get("set-cookie");
      expect(cookie).toBeTruthy();
      expect(cookie).toContain(`tenaza_token=${daemon.token}`);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
    } finally {
      await daemon.stop();
    }
  });

  test("GET /auth with a missing or wrong token sets no cookie and answers 401", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const missing = await fetch(`http://127.0.0.1:${daemon.port}/auth`, { redirect: "manual" });
      expect(missing.status).toBe(401);
      expect(missing.headers.get("set-cookie")).toBeNull();

      const wrong = await fetch(`http://127.0.0.1:${daemon.port}/auth?token=not-the-real-one`, {
        redirect: "manual",
      });
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get("set-cookie")).toBeNull();
    } finally {
      await daemon.stop();
    }
  });

  test("the launcher opens /auth?token=, not /?token= — the route that validates server-side", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const opened = readOpenRecorder(home);
      expect(opened.length).toBeGreaterThan(0);
      for (const url of opened) expect(url).toContain("/auth?token=");
    } finally {
      await daemon.stop();
    }
  });

  test("reads stay open: GET /, /health and /events never require the token", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const page = await fetch(`http://127.0.0.1:${daemon.port}/`);
      expect(page.status).toBe(200);

      const health = await fetch(`http://127.0.0.1:${daemon.port}/health`);
      expect(health.status).toBe(200);

      const events = await fetch(`http://127.0.0.1:${daemon.port}/events`);
      expect(events.status).toBe(200);
      await events.body?.cancel();
    } finally {
      await daemon.stop();
    }
  });

  /**
   * Ticket 08: `GET /` now serves the real, bundled React board (Bun's
   * `routes` HTML import, `daemon.ts`) instead of ticket 07's "no page
   * yet" placeholder — and every asset the page references (its bundled
   * JS, its bundled CSS) must resolve too, as an open read like the page
   * itself (decision 05: the page and its assets are open reads; nothing
   * NEW is writable). This is the one server-side seam for the whole UI
   * layer; the page's own behaviour is verified by hand (ticket's AC).
   */
  test("GET / serves the bundled board page, and every asset URL it references resolves, open, with no token", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const page = await fetch(`http://127.0.0.1:${daemon.port}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");

      const html = await page.text();
      expect(html).toContain('id="root"');

      const assetPaths = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]!);
      expect(assetPaths.length).toBeGreaterThan(0); // the bundler rewrote at least the entry script

      for (const assetPath of assetPaths) {
        const asset = await fetch(`http://127.0.0.1:${daemon.port}${assetPath}`);
        expect(asset.status).toBe(200);
      }
    } finally {
      await daemon.stop();
    }
  });

  test("the heartbeat file is rewritten on an interval", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home, env: { TENAZA_HEARTBEAT_MS: "50" } });
    try {
      const first = readFileSync(daemonAlivePath(home), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = readFileSync(daemonAlivePath(home), "utf8");
      expect(second).not.toBe(first);
    } finally {
      await daemon.stop();
    }
  });

  /** Orchestrator review, hardening: mode 0600 from the moment the file is CREATED, not applied as an afterthought that a reader could in principle (however briefly) race. */
  test("the token file is created at mode 0600 — owner read/write only, nobody else", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const stat = statSync(daemonTokenPath(home));
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      await daemon.stop();
    }
  });

  test("single instance: a second `tenaza ui` on the same port opens the running one, without minting a new token", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const second = await runCli(["ui", "--port", String(daemon.port)], { home });

      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("already serving");
      expect(second.stdout).toContain(`port ${daemon.port}`);

      // Untouched by the second launch — the SAME token the first process minted.
      expect(readDaemonToken(home)).toBe(daemon.token);

      const opened = readOpenRecorder(home);
      expect(opened.length).toBeGreaterThanOrEqual(2); // the first launch's own open, plus the second's
      for (const url of opened) expect(url).toContain(daemon.token);
    } finally {
      await daemon.stop();
    }
  });

  test("a non-Tenaza port holder gets a clear message suggesting --port, never a raw EADDRINUSE", async () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.end();
        },
        data() {},
        close() {},
        error() {},
      },
    });
    try {
      const result = await runCli(["ui", "--port", String(listener.port)], { home });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).not.toContain("eaddrinuse");
      expect(result.stderr).toContain("--port");
    } finally {
      listener.stop(true);
    }
  });

  test("an SSE connection receives a fresh event after a real hook writes a new Action", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home, env: { TENAZA_SSE_POLL_MS: "50" } });
    try {
      mkdirSync(path.join(home, "config"), { recursive: true });
      writeFileSync(
        path.join(home, "config", "policy.toml"),
        '[[rule]]\nmatch = "gh pr merge"\neffect = "human"\n',
      );

      const healthCheck = await fetch(`http://127.0.0.1:${daemon.port}/events`);
      expect(healthCheck.headers.get("content-type")).toContain("text/event-stream");
      await healthCheck.body?.cancel();

      const sse = await connectEvents(daemon.port);

      const initial = await sse.nextEvent(2000);
      expect(initial).toEqual(EMPTY_BOARD_PAYLOAD);

      const hookResult = await runCli(["hook", "claude"], {
        home,
        stdin: JSON.stringify({
          session_id: "sess-1",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "gh pr merge 58" },
        }),
      });
      expect(hookResult.exitCode).toBe(0);

      const afterWrite = await sse.nextEvent(3000);
      expect(afterWrite.inbox.length).toBeGreaterThan(0);

      await sse.cancel();
    } finally {
      await daemon.stop();
    }
  });

  /**
   * Orchestrator review, defect: `computeStateSignature` used to stat
   * EVERY file under `state/sessions/`, including `<session>.toolcalls`
   * (`toolcalls.ts`'s own per-call counter, bumped on every PostToolUse —
   * ticket 05). With a few agents working, nearly every poll tick would
   * recompute and push a state that provably hadn't changed, breaking the
   * "transitions, not calls" rule and growing CPU with tool-call rate, not
   * with actual Session/Inbox changes.
   *
   * Reproduced here with REAL PostToolUse calls below the 25-call sample
   * boundary (`SAMPLE_EVERY_N_TOOL_CALLS`): each one bumps ONLY the
   * `.toolcalls` file (never the Session's own `.jsonl` log, since no
   * `usage.sampled` Event is written until the 25th). The first call for a
   * brand-new Session is excluded on purpose — the M6 backfill writes a
   * `session.started` Event on it, which IS a real jsonl change and
   * correctly produces one event; the regression is only about the calls
   * AFTER that.
   */
  test("the SSE watcher does not push when only a Session's .toolcalls counter changed, never the Session's own log", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home, env: { TENAZA_SSE_POLL_MS: "50" } });
    try {
      const sse = await connectEvents(daemon.port);
      const initial = await sse.nextEvent(2000);
      expect(initial).toEqual(EMPTY_BOARD_PAYLOAD);

      const postToolUse = (): Promise<unknown> =>
        runCli(["hook", "claude"], {
          home,
          stdin: JSON.stringify({
            session_id: "sess-1",
            hook_event_name: "PostToolUse",
            cwd: home,
          }),
        });

      // First call: backfills `session.started` (a real jsonl change) —
      // expect exactly one event for it, same as any other log write.
      await postToolUse();
      const afterBackfill = await sse.nextEvent(2000);
      expect(afterBackfill.sessions.length).toBe(1);

      // Calls 2 through 10: only `sess-1.toolcalls` grows (bytes 2..10 —
      // nowhere near the 25th-call sample boundary), never `sess-1.jsonl`.
      for (let i = 0; i < 9; i++) await postToolUse();

      // Give the watcher several poll intervals' worth of real time to
      // have pushed something, if it was going to.
      await sse.expectNoEventWithin(400);
    } finally {
      await daemon.stop();
    }
  });

  test("Ctrl-C (SIGINT) stops the Daemon cleanly: exit 0, launch files cleared, port freed", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });

    daemon.proc.kill("SIGINT");
    const exitCode = await Promise.race([
      daemon.proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 3000)),
    ]);
    expect(exitCode).toBe(0);

    expect(existsSync(daemonAlivePath(home))).toBe(false);
    expect(existsSync(daemonTokenPath(home))).toBe(false);

    let stillUp = true;
    try {
      await fetch(`http://127.0.0.1:${daemon.port}/health`, {
        signal: AbortSignal.timeout(500),
      });
    } catch {
      stillUp = false;
    }
    expect(stillUp).toBe(false);
  });

  test("hooks never talk to the Daemon: a hook call works correctly with none running at all", async () => {
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      '[[rule]]\nmatch = "gh pr merge"\neffect = "human"\n',
    );

    const result = await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 58" },
      }),
    });

    expect(result.exitCode).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("isHeartbeatFresh (ticket 07 exposes the freshness rule; no hook is wired to it yet)", () => {
  test("undefined (never written) is never fresh", () => {
    expect(isHeartbeatFresh(undefined, new Date())).toBe(false);
  });

  test("a recent heartbeat is fresh", () => {
    const now = new Date("2026-01-01T00:00:10.000Z");
    const aliveAt = new Date("2026-01-01T00:00:09.000Z");
    expect(isHeartbeatFresh(aliveAt, now)).toBe(true);
  });

  test("a heartbeat older than the stale threshold is not fresh", () => {
    const now = new Date("2026-01-01T00:01:00.000Z");
    const aliveAt = new Date(now.getTime() - DEFAULT_HEARTBEAT_STALE_MS - 1000);
    expect(isHeartbeatFresh(aliveAt, now)).toBe(false);
  });
});

/**
 * Write routes — `run`/`done`/`dismiss` (ticket 09). Drives the SAME
 * black-box seam ticket 07/08 already established: a REAL `tenaza ui`
 * process over real HTTP, against a temp `TENAZA_HOME` both the test and
 * the Daemon share on disk. Inbox items are opened directly with
 * `appendEvent`/`actionDecidedEvent` (the SAME helper shape
 * `test/resolve.test.ts` already uses) rather than through a real hook
 * call — this suite's own job is the HTTP surface and the gate around it,
 * not re-proving Rule matching. `TENAZA_RUN_SHELL=/bin/sh` is passed into
 * the DAEMON's own process env (never the test's) so its `run` spawns
 * through a fast, profile-free shell (`resolve.ts`'s own test seam).
 */
describe("write routes — run/done/dismiss (ticket 09)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-daemon-items-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** A blocked (enforced-deny) Inbox item for `session`, with a fresh `session.started` so `cwd` resolves to `home` itself — line 1 is the start, line 2 is the match, so the item's id hashes against line 2. */
  function openBlockedItem(session: string, command: string, cwd: string = home): string {
    appendEvent(home, sessionStartedEvent(session, { runtime: "fake", cwd, capabilities: ["observe", "block"] }));
    appendEvent(
      home,
      actionDecidedEvent(session, { kind: "shell", command, tool: "Bash" }, "deny", {
        match: command,
        effect: "human",
      }),
    );
    return inboxIdentityHash(session, 2);
  }

  /** ADR 0001's unblocked ("YA CORRIÓ") shape — `decision: "allow"` on a `human`-effect match, `blocked: false`. No `session.started` needed; `run` refuses this before ever consulting `cwd`. */
  function openUnblockedItem(session: string, command: string): string {
    appendEvent(
      home,
      actionDecidedEvent(session, { kind: "shell", command, tool: "Bash" }, "allow", {
        match: command,
        effect: "human",
      }),
    );
    return inboxIdentityHash(session, 1);
  }

  function openMcpItem(session: string, tool: string): string {
    appendEvent(
      home,
      actionDecidedEvent(session, { kind: "mcp", tool, args: {} }, "deny", { tool: "mcp__*", effect: "human" }),
    );
    return inboxIdentityHash(session, 1);
  }

  function spawnItemsDaemon(envOverrides: Record<string, string> = {}) {
    return spawnDaemon(["--port", "0"], { home, env: { TENAZA_RUN_SHELL: "/bin/sh", ...envOverrides } });
  }

  test("POST /items/<id>/run with a stored `true` streams to completion and closes the item as done", async () => {
    const id = openBlockedItem("sess-1", "true");
    const daemon = await spawnItemsDaemon();
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/run`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(200);
      await res.text();

      expect(deriveInbox(home)).toEqual([]);
      expect(readHumanEvents(home)[0]).toMatchObject({ data: { ref: id, outcome: "done" } });
    } finally {
      await daemon.stop();
    }
  });

  test("POST /items/<id>/run with a stored `false` streams to completion, leaves the item open, and ends with the failure trailer — review fix, 'stays open WITH THE ERROR'", async () => {
    const id = openBlockedItem("sess-1", "false");
    const daemon = await spawnItemsDaemon();
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/run`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.text();

      expect(deriveInbox(home)).toHaveLength(1);
      expect(readHumanEvents(home)).toEqual([]);
      expect(body).toContain(`${RUN_FAILURE_MARKER}1`);
    } finally {
      await daemon.stop();
    }
  });

  test("a spawn failure (the configured shell does not exist) answers 500 with a clear message — never an unexplained crash", async () => {
    const id = openBlockedItem("sess-1", "true");
    const daemon = await spawnItemsDaemon({ TENAZA_RUN_SHELL: path.join(tmpdir(), "tenaza-no-such-shell-xyz") });
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/run`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("spawn-failed");
      expect(typeof body.message).toBe("string");
      expect(body.message.length).toBeGreaterThan(0);

      expect(deriveInbox(home)).toHaveLength(1); // untouched — nothing ran
      expect(readHumanEvents(home)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  test("POST /items/<id>/run with a stored `pwd` streams the REQUESTING Session's own cwd, never the Daemon's", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "tenaza-daemon-run-cwd-"));
    try {
      const id = openBlockedItem("sess-1", "pwd", cwd);
      const daemon = await spawnItemsDaemon();
      try {
        const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/run`, {
          method: "POST",
          headers: { cookie: `tenaza_token=${daemon.token}` },
        });
        const output = await res.text();
        expect(realpathSync(output.trim())).toBe(realpathSync(cwd));
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("POST /items/<id>/run without the token 403s and spawns nothing", async () => {
    const marker = path.join(home, "should-not-exist");
    const id = openBlockedItem("sess-1", `touch ${marker}`);
    const daemon = await spawnItemsDaemon();
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/run`, { method: "POST" });
      expect(res.status).toBe(403);
      await res.text();

      expect(existsSync(marker)).toBe(false);
      expect(deriveInbox(home)).toHaveLength(1); // untouched
    } finally {
      await daemon.stop();
    }
  });

  test("an already-resolved item refuses run with 409, reporting its own kind", async () => {
    const id = openBlockedItem("sess-1", "true");
    const daemon = await spawnItemsDaemon();
    try {
      await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/done`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });

      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/run`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "already-resolved" });
    } finally {
      await daemon.stop();
    }
  });

  test("a YA CORRIÓ (unblocked) item offers no run — 409, never a second execution", async () => {
    const marker = path.join(home, "should-not-exist");
    const id = openUnblockedItem("sess-1", `touch ${marker}`);
    const daemon = await spawnItemsDaemon();
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/run`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "unblockable" });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  test("an mcp item offers no run — 409 not-runnable, it has no stored shell command", async () => {
    const id = openMcpItem("sess-1", "mcp__neon__run_sql");
    const daemon = await spawnItemsDaemon();
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/run`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "not-runnable" });
    } finally {
      await daemon.stop();
    }
  });

  test("an unknown id 404s on run, done and dismiss alike", async () => {
    const daemon = await spawnItemsDaemon();
    try {
      for (const action of ["run", "done", "dismiss"]) {
        const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${"0".repeat(40)}/${action}`, {
          method: "POST",
          headers: { cookie: `tenaza_token=${daemon.token}` },
        });
        expect(res.status).toBe(404);
      }
    } finally {
      await daemon.stop();
    }
  });

  test("POST /items/<id>/done closes the item, 200 with its outcome, token required", async () => {
    const id = openBlockedItem("sess-1", "gh pr merge 58");
    const daemon = await spawnItemsDaemon();
    try {
      const bare = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/done`, { method: "POST" });
      expect(bare.status).toBe(403);
      expect(deriveInbox(home)).toHaveLength(1); // untouched

      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/done`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: "done", alreadyResolved: false });
      expect(deriveInbox(home)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  test("POST /items/<id>/dismiss closes the item as dismissed, idempotently", async () => {
    const id = openBlockedItem("sess-1", "gh pr merge 58");
    const daemon = await spawnItemsDaemon();
    try {
      const first = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/dismiss`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ outcome: "dismissed", alreadyResolved: false });

      const second = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/dismiss`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(await second.json()).toEqual({ outcome: "dismissed", alreadyResolved: true });
    } finally {
      await daemon.stop();
    }
  });
});
