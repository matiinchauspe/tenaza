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
import { actionDecidedEvent, approvalResolvedEvent, sessionEndedEvent, sessionStartedEvent } from "../src/contract/event";
import { readFocusRecorder } from "../src/focus";
import { isHeartbeatFresh, readDaemonToken, readOpenRecorder, DEFAULT_HEARTBEAT_STALE_MS } from "../src/daemon";
import { inboxIdentityHash } from "../src/identity";
import { deriveInbox } from "../src/inbox";
import { LIVE_ANSWER_CUTOFF_MS } from "../src/live";
import { postLiveAnswer } from "../src/resolve";
import { appendEvent, appendHumanEvent, readHumanEvents } from "../src/log";
import { daemonAlivePath, daemonTokenPath, DEFAULT_DAEMON_PORT } from "../src/paths";
import { DEFAULT_CONTEXT_THRESHOLD, DEFAULT_STALL_MINUTES, DEFAULT_WAIT_SECONDS } from "../src/policy";
import { RUN_FAILURE_MARKER } from "../src/runoutput";
import { TENAZA_VERSION } from "../src/version";

/** Ticket 08: `/events` now also carries the Live surface's own contract envelope and Policy numbers — every "freshly started, nothing observed yet" assertion below includes this. */
const EMPTY_BOARD_PAYLOAD = {
  v: 1,
  policy: { stallMinutes: DEFAULT_STALL_MINUTES, contextThresholdTokens: DEFAULT_CONTEXT_THRESHOLD, waitSeconds: DEFAULT_WAIT_SECONDS },
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
      // The Daemon prints "serving on" BEFORE its opener appends to the recorder — poll, or a loaded suite races it.
      let opened = readOpenRecorder(home);
      for (let i = 0; opened.length === 0 && i < 40; i++) {
        await Bun.sleep(50);
        opened = readOpenRecorder(home);
      }
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
      // Ticket 10: this Daemon is genuinely up with a fresh heartbeat, so a
      // `human` match would otherwise go LIVE and hold for the default
      // ~180s wait window — this test cares about the SSE push, not live
      // answering, so `wait_seconds = 0` makes the hold expire on its own
      // first check (no answer posted), landing on the exact same "deny,
      // Inbox opens" outcome this test already asserted pre-ticket-10.
      writeFileSync(
        path.join(home, "config", "policy.toml"),
        '[[rule]]\nmatch = "gh pr merge"\neffect = "human"\n\n[live]\nwait_seconds = 0\n',
      );

      const healthCheck = await fetch(`http://127.0.0.1:${daemon.port}/events`);
      expect(healthCheck.headers.get("content-type")).toContain("text/event-stream");
      await healthCheck.body?.cancel();

      const sse = await connectEvents(daemon.port);

      const initial = await sse.nextEvent(2000);
      // `wait_seconds = 0` above (this test's own Policy) is the only
      // difference from `EMPTY_BOARD_PAYLOAD`'s default — everything else
      // still matches a freshly-started, nothing-observed-yet Daemon.
      const expectedInitial = { ...EMPTY_BOARD_PAYLOAD, policy: { ...EMPTY_BOARD_PAYLOAD.policy, waitSeconds: 0 } };
      expect(initial).toEqual(expectedInitial);

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
      // Ticket 10: a `run.failed` Event IS written now (never a
      // Resolution — the item stays open) — the resolution trace's own
      // raw material for "falló (código N)".
      expect(readHumanEvents(home)).toHaveLength(1);
      expect(readHumanEvents(home)[0]).toMatchObject({ type: "run.failed", data: { ref: id, exitCode: 1 } });
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

/**
 * `POST /items/<id>/answer` (ticket 10, decision 06) — the browser's own
 * write from a Session card's rechazar/aprobar buttons. Items are opened
 * directly with `appendEvent`/`actionDecidedEvent`, same convention as the
 * run/done/dismiss suite above: this is the HTTP surface's own job, not a
 * re-proof of `decide.ts`'s hold loop (covered in `test/decide.test.ts` and
 * `test/adapters/claude.test.ts`).
 */
describe("write route — answer (ticket 10)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-daemon-answer-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** A freshly-born-live item (`decision: "held"`) for `session`, at `heldAt` (defaulting to now). */
  function openLiveItem(session: string, command: string, heldAt: Date = new Date()): string {
    const event = actionDecidedEvent(session, { kind: "shell", command, tool: "Bash" }, "held", {
      match: command,
      effect: "human",
    });
    appendEvent(home, { ...event, ts: heldAt.toISOString() });
    return inboxIdentityHash(session, 1);
  }

  function spawnAnswerDaemon() {
    return spawnDaemon(["--port", "0"], { home });
  }

  test("POST /items/<id>/answer with approve appends a live.answered Event, token required", async () => {
    const id = openLiveItem("sess-1", "gh pr merge 58");
    const daemon = await spawnAnswerDaemon();
    try {
      const bare = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/answer`, {
        method: "POST",
        body: JSON.stringify({ answer: "approve" }),
      });
      expect(bare.status).toBe(403);

      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/answer`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
        body: JSON.stringify({ answer: "approve", message: "dale" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const events = readHumanEvents(home);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "live.answered",
        session: "sess-1",
        data: { ref: id, answer: "approve", message: "dale" },
      });
    } finally {
      await daemon.stop();
    }
  });

  test("POST /items/<id>/answer with reject, no message, appends a live.answered Event with no message key", async () => {
    const id = openLiveItem("sess-1", "gh pr merge 58");
    const daemon = await spawnAnswerDaemon();
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/answer`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
        body: JSON.stringify({ answer: "reject" }),
      });
      expect(res.status).toBe(200);

      const events = readHumanEvents(home);
      expect(events[0]).toMatchObject({ data: { ref: id, answer: "reject" } });
      expect((events[0] as { data: { message?: string } }).data.message).toBeUndefined();
    } finally {
      await daemon.stop();
    }
  });

  test("an invalid answer value is a plain 400, never a 500 or a silent accept", async () => {
    const id = openLiveItem("sess-1", "gh pr merge 58");
    const daemon = await spawnAnswerDaemon();
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/answer`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
        body: JSON.stringify({ answer: "maybe" }),
      });
      expect(res.status).toBe(400);
      expect(readHumanEvents(home)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  test("a plain pending item (never born live) refuses with 409 — nothing is appended", async () => {
    const command = "gh pr merge 58";
    appendEvent(
      home,
      actionDecidedEvent("sess-1", { kind: "shell", command, tool: "Bash" }, "deny", {
        match: command,
        effect: "human",
      }),
    );
    const id = inboxIdentityHash("sess-1", 1);
    const daemon = await spawnAnswerDaemon();
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/answer`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
        body: JSON.stringify({ answer: "approve" }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("not-live");
      expect(readHumanEvents(home)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  test("a live item whose window already lapsed refuses with 409 — TIME IS STATE, `decision` alone is not enough", async () => {
    const longAgo = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago, past any sane wait_seconds
    const id = openLiveItem("sess-1", "gh pr merge 58", longAgo);
    const daemon = await spawnAnswerDaemon();
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/answer`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
        body: JSON.stringify({ answer: "approve" }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("not-live");
      expect(readHumanEvents(home)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  test("an answer inside the window's last cutoff is refused as not-live — the hook may already be denying on expiry", () => {
    const heldAt = new Date("2026-10-27T12:00:00.000Z");
    const id = openLiveItem("sess-1", "gh pr merge 58", heldAt);
    const deadlineMs = heldAt.getTime() + DEFAULT_WAIT_SECONDS * 1000;

    const tooLate = postLiveAnswer(home, id, "approve", undefined, new Date(deadlineMs - LIVE_ANSWER_CUTOFF_MS / 2));
    expect(tooLate).toEqual({ kind: "not-live" });
    expect(readHumanEvents(home)).toEqual([]);

    const inTime = postLiveAnswer(home, id, "approve", undefined, new Date(deadlineMs - LIVE_ANSWER_CUTOFF_MS * 2));
    expect(inTime).toEqual({ kind: "accepted" });
    expect(readHumanEvents(home)).toHaveLength(1);
  });

  test("an already-resolved item refuses with 409", async () => {
    const id = openLiveItem("sess-1", "gh pr merge 58");
    appendHumanEvent(home, approvalResolvedEvent("sess-1", id, "done", "live"));
    const daemon = await spawnAnswerDaemon();
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${id}/answer`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
        body: JSON.stringify({ answer: "approve" }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("already-resolved");
    } finally {
      await daemon.stop();
    }
  });

  test("an unknown id 404s, same shape as run/done/dismiss", async () => {
    const daemon = await spawnAnswerDaemon();
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${"0".repeat(40)}/answer`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
        body: JSON.stringify({ answer: "approve" }),
      });
      expect(res.status).toBe(404);
    } finally {
      await daemon.stop();
    }
  });

  test("the built-in fence covers the answer route too — an agent targeting it is denied and lands in the Inbox", async () => {
    const id = openLiveItem("sess-1", "gh pr merge 58");
    // The fence's write-route pattern is text-only and keys ONLY off
    // `DEFAULT_DAEMON_PORT` (`fence.ts`'s own documented, accepted gap —
    // never the port a `--port 0` test daemon actually bound to), so the
    // curl text below targets that literal port regardless of where
    // `spawnAnswerDaemon()` is really listening. This Daemon is genuinely
    // up with a fresh heartbeat, so the fence match (itself a
    // `human`-effect Rule) would otherwise go LIVE and hold for the
    // default ~180s window — `wait_seconds = 0` makes it expire on its own
    // first check instead, landing on the same "deny" outcome this test
    // cares about.
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(path.join(home, "config", "policy.toml"), "[live]\nwait_seconds = 0\n");
    const daemon = await spawnAnswerDaemon();
    try {
      const result = await runCli(["hook", "claude"], {
        home,
        stdin: JSON.stringify({
          session_id: "sess-2",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: {
            command: `curl -X POST http://127.0.0.1:${DEFAULT_DAEMON_PORT}/items/${id}/answer -d '{"answer":"approve"}'`,
          },
        }),
      });
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      await daemon.stop();
    }
  });
});

/**
 * `POST /sessions/<id>/focus` (decision 09, ticket 11): drives the SAME
 * black-box seam every other write route is already tested through — a
 * REAL `tenaza ui` process over real HTTP. The spawned process inherits
 * `process.env` (`spawnDaemon`'s own default), which already carries
 * `TENAZA_FOCUS_RECORDER=1` from this repo's `bunfig.toml` preload — so the
 * Daemon's own focus route records its plan instead of ever touching a
 * real `tmux`/`osascript`/`open`, and this test reads that recording back
 * straight off disk (`readFocusRecorder`), the same convention
 * `readOpenRecorder` already uses elsewhere in this file.
 */
describe("write route — focus (ticket 11)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-daemon-focus-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("a captured locator's own exact command plus a Level-1 raise are recorded, token required", async () => {
    appendEvent(
      home,
      sessionStartedEvent("sess-1", {
        runtime: "claude",
        cwd: home,
        capabilities: ["observe", "block"],
        terminal: { termProgram: "Apple_Terminal", tty: "/dev/ttys003" },
      }),
    );
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const bare = await fetch(`http://127.0.0.1:${daemon.port}/sessions/sess-1/focus`, { method: "POST" });
      expect(bare.status).toBe(403);
      expect(readFocusRecorder(home)).toEqual([]);

      const res = await fetch(`http://127.0.0.1:${daemon.port}/sessions/sess-1/focus`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, level: "exact" });

      // Apple Terminal's own `activate` already raises the window
      // (`raisesWindow: true`, `terminals.ts`) — exactly ONE step, never a
      // separate Level-1 `open -b` alongside it.
      const steps = readFocusRecorder(home);
      expect(steps).toHaveLength(1);
      expect(steps[0]?.kind).toBe("osascript");
      expect((steps[0] as { kind: "osascript"; script: string }).script).toContain('tty of t is "/dev/ttys003"');
    } finally {
      await daemon.stop();
    }
  });

  test("a subagent's focus resolves to its PARENT's terminal — never its own (it never captures one at all)", async () => {
    appendEvent(
      home,
      sessionStartedEvent("sess-1", {
        runtime: "claude",
        cwd: home,
        capabilities: ["observe", "block"],
        terminal: { bundleId: "com.stablyai.orca", orcaHandle: "term_parent" },
      }),
    );
    appendEvent(
      home,
      sessionStartedEvent("agent-1", { parent: "sess-1", runtime: "claude", cwd: home, capabilities: ["observe"] }),
    );
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/sessions/agent-1/focus`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(200);

      const steps = readFocusRecorder(home);
      expect(steps[0]).toEqual({
        kind: "spawn",
        argv: ["/Applications/Orca.app/Contents/Resources/bin/orca", "terminal", "switch", "--terminal", "term_parent"],
      });
    } finally {
      await daemon.stop();
    }
  });

  test("a Session with no terminal locator at all (legacy v0.1 data) still answers 200 with level unknown, recording nothing", async () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: home, capabilities: ["observe"] }));
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/sessions/sess-1/focus`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, level: "unknown" });
      expect(readFocusRecorder(home)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  test("an unknown Session id 404s", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/sessions/no-such-session/focus`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(404);
    } finally {
      await daemon.stop();
    }
  });

  test("the built-in fence covers the focus route too — an agent targeting it is denied and lands in the Inbox", async () => {
    // No Daemon spawned here at all (unlike the `answer` route's own fence
    // test, which legitimately needs one up to prove the route itself) —
    // the fence match is a plain TEXT pattern, independent of whether a
    // real Daemon is running; with none up, `daemon.alive` is absent and
    // the match denies AT ONCE, exactly like the plain `/items/` fence
    // tests above. Spawning one here would send this match LIVE instead
    // (a fresh heartbeat), holding for the default ~180s wait window with
    // nobody ever answering it — the bug this comment exists to prevent
    // from recurring.
    const result = await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-2",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `curl -X POST http://127.0.0.1:${DEFAULT_DAEMON_PORT}/sessions/sess-1/focus` },
      }),
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

/**
 * `POST /sessions/<id>/archive` (ticket 11, added 2026-10-27): "tested over
 * HTTP and at the board" (ticket) — this suite covers both halves: the
 * write route itself, AND (the last test) that an archived Session's card
 * actually disappears from the very next `/events` push.
 */
describe("write route — archive (ticket 11)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-daemon-archive-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function endedSession(id: string): void {
    appendEvent(home, sessionStartedEvent(id, { runtime: "claude", cwd: home, capabilities: ["observe"] }));
    appendEvent(home, sessionEndedEvent(id, "clear"));
  }

  test("archives an ended Session, 200, token required", async () => {
    endedSession("sess-1");
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const bare = await fetch(`http://127.0.0.1:${daemon.port}/sessions/sess-1/archive`, { method: "POST" });
      expect(bare.status).toBe(403);

      const res = await fetch(`http://127.0.0.1:${daemon.port}/sessions/sess-1/archive`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, alreadyArchived: false });
    } finally {
      await daemon.stop();
    }
  });

  test("a Session that never ended refuses with 409 not-ended — x on any other card does nothing", async () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: home, capabilities: ["observe"] }));
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/sessions/sess-1/archive`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "not-ended" });
    } finally {
      await daemon.stop();
    }
  });

  test("archiving twice is idempotent — 200 both times, only one Event ever written", async () => {
    endedSession("sess-1");
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const first = await fetch(`http://127.0.0.1:${daemon.port}/sessions/sess-1/archive`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ ok: true, alreadyArchived: false });

      const second = await fetch(`http://127.0.0.1:${daemon.port}/sessions/sess-1/archive`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ ok: true, alreadyArchived: true });
    } finally {
      await daemon.stop();
    }
  });

  test("an unknown Session id 404s", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/sessions/no-such-session/archive`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(res.status).toBe(404);
    } finally {
      await daemon.stop();
    }
  });

  test("AT THE BOARD: an archived Session's card disappears from the very next /events push", async () => {
    endedSession("sess-1");
    const daemon = await spawnDaemon(["--port", "0"], { home, env: { TENAZA_SSE_POLL_MS: "50" } });
    try {
      const before = await fetch(`http://127.0.0.1:${daemon.port}/events`);
      const beforeReader = before.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const readOneFrame = async (): Promise<{ sessions: { id: string }[] }> => {
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
          const { value, done } = await beforeReader.read();
          if (done) throw new Error("SSE stream closed early");
          buffer += decoder.decode(value, { stream: true });
        }
      };

      const initial = await readOneFrame();
      expect(initial.sessions.map((s) => s.id)).toContain("sess-1");

      const archiveRes = await fetch(`http://127.0.0.1:${daemon.port}/sessions/sess-1/archive`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(archiveRes.status).toBe(200);

      const afterArchive = await readOneFrame();
      expect(afterArchive.sessions.map((s) => s.id)).not.toContain("sess-1");

      await beforeReader.cancel();
    } finally {
      await daemon.stop();
    }
  });

  /**
   * Orchestrator review, 2026-10-27: `archivedSessionIds` + `buildBoardPayload`
   * used to hide a Session FOREVER once a `session.archived` Event existed
   * — but a Claude Code Session can be RESUMED (`claude --resume`/
   * `--continue`) under the SAME `session_id`, firing SessionStart again.
   * TIME IS STATE / "every failure visible": a real SessionStart hook call
   * (never an artificial fixed timestamp — this is a genuinely LATER real
   * Event, strictly after the archive above in actual wall-clock time, no
   * gap-sizing needed) must bring the card back.
   */
  test("AT THE BOARD: a RESUMED Session (fresh SessionStart after being archived) comes back — never hidden forever", async () => {
    endedSession("sess-1");
    const daemon = await spawnDaemon(["--port", "0"], { home, env: { TENAZA_SSE_POLL_MS: "50" } });
    try {
      const archiveRes = await fetch(`http://127.0.0.1:${daemon.port}/sessions/sess-1/archive`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}` },
      });
      expect(archiveRes.status).toBe(200);

      const sse = await connectEvents(daemon.port);
      const hidden = await sse.nextEvent(2000);
      expect((hidden.sessions as { id: string }[]).map((s) => s.id)).not.toContain("sess-1");

      // The Session RESUMES under the SAME session_id — a real SessionStart
      // hook call, strictly after the archive above.
      const resumeResult = await runCli(["hook", "claude"], {
        home,
        stdin: JSON.stringify({ session_id: "sess-1", hook_event_name: "SessionStart", cwd: home }),
      });
      expect(resumeResult.exitCode).toBe(0);

      const visibleAgain = await sse.nextEvent(3000);
      expect((visibleAgain.sessions as { id: string }[]).map((s) => s.id)).toContain("sess-1");

      await sse.cancel();
    } finally {
      await daemon.stop();
    }
  });

  test("the built-in fence covers the archive route too — an agent targeting it is denied and lands in the Inbox", async () => {
    // Same reasoning as the focus route's own fence test above: no Daemon
    // spawned, so the match denies at once rather than going live.
    const result = await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-2",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `curl -X POST http://127.0.0.1:${DEFAULT_DAEMON_PORT}/sessions/sess-1/archive` },
      }),
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
