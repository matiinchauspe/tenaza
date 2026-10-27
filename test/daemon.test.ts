import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  actionDecidedEvent,
  approvalResolvedEvent,
  notificationObservedEvent,
  promptSubmittedEvent,
  sessionArchivedEvent,
  sessionEndedEvent,
  sessionStartedEvent,
  usageSampledEvent,
} from "../src/contract/event";
import { readFocusRecorder } from "../src/focus";
import {
  buildBoardPayload,
  isHeartbeatFresh,
  readDaemonToken,
  readOpenRecorder,
  DEFAULT_HEARTBEAT_STALE_MS,
} from "../src/daemon";
import { inboxIdentityHash } from "../src/identity";
import { deriveInbox } from "../src/inbox";
import { LIVE_ANSWER_CUTOFF_MS } from "../src/live";
import { postLiveAnswer } from "../src/resolve";
import { appendEvent, appendHumanEvent, createSessionLogCache, readHumanEvents, readSessionEvents } from "../src/log";
import {
  daemonAlivePath,
  daemonTokenPath,
  sessionLogPath,
  sessionTouchedPath,
  toolCallCounterPath,
  DEFAULT_DAEMON_PORT,
} from "../src/paths";
import { DEFAULT_CONTEXT_THRESHOLD, DEFAULT_STALL_MINUTES, DEFAULT_WAIT_SECONDS } from "../src/policy";
import { createCachingGitRootResolver } from "../src/sessions";
import { touchSession } from "../src/toolcalls";
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
   * Ticket 14 amendment: a REAL PostToolUse call can no longer isolate
   * `.toolcalls` on its own — it now ALSO touches `<session>.touched`
   * (`toolcalls.ts`'s `touchSession`, AC3), which `computeStateSignature`
   * DOES include on purpose (that file is now a real input to the derived
   * state — see its own doc comment). So this test bumps `.toolcalls`
   * DIRECTLY, bypassing the hook, to keep proving the ORIGINAL, narrower
   * claim: that file alone, isolated from `.touched`, still never pushes.
   * The next test below covers what a real call does now.
   */
  test("the SSE watcher does not push when only a Session's .toolcalls counter changed, never the Session's own log", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home, env: { TENAZA_SSE_POLL_MS: "50" } });
    try {
      const sse = await connectEvents(daemon.port);
      const initial = await sse.nextEvent(2000);
      expect(initial).toEqual(EMPTY_BOARD_PAYLOAD);

      // First call: backfills `session.started` (a real jsonl change) —
      // expect exactly one event for it, same as any other log write.
      await runCli(["hook", "claude"], {
        home,
        stdin: JSON.stringify({ session_id: "sess-1", hook_event_name: "PostToolUse", cwd: home }),
      });
      const afterBackfill = await sse.nextEvent(2000);
      expect(afterBackfill.sessions.length).toBe(1);

      // Bumps 2 through 10: ONLY `sess-1.toolcalls` grows (bytes 2..10 —
      // nowhere near the 25th-call sample boundary), never `sess-1.jsonl`
      // and, crucially, never `sess-1.touched` either — isolating exactly
      // the file this test is about.
      mkdirSync(path.dirname(toolCallCounterPath("sess-1", home)), { recursive: true });
      for (let i = 0; i < 9; i++) appendFileSync(toolCallCounterPath("sess-1", home), "x");

      // Give the watcher several poll intervals' worth of real time to
      // have pushed something, if it was going to.
      await sse.expectNoEventWithin(400);
    } finally {
      await daemon.stop();
    }
  });

  /**
   * Ticket 14, AC3: the counterpart to the regression test above — a REAL
   * ordinary PostToolUse call (no Rule match, below the 25th-call sample
   * boundary) now DOES reach the board, via its own `.touched` bump,
   * within one poll interval. This is "an ordinary tool call moves the
   * card's age" made concrete: before this ticket, calls 2-10 here would
   * have left `afterFirstCall` and the final payload byte-identical; now
   * the final payload's own `lastEventTs` has moved forward, PAST the
   * Session's own `session.started`/first-call ts, reflecting call #10's
   * own touch — still with ZERO new Events in the Session's log (`events`
   * stays at exactly one: the M6 backfill's `session.started`).
   */
  test("AC3: an ordinary PostToolUse call (no Rule match) moves the board's own lastEventTs within the poll interval, via its touch — never a new Event", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home, env: { TENAZA_SSE_POLL_MS: "50" } });
    try {
      const sse = await connectEvents(daemon.port);
      const initial = await sse.nextEvent(2000);
      expect(initial).toEqual(EMPTY_BOARD_PAYLOAD);

      const postToolUse = (): Promise<unknown> =>
        runCli(["hook", "claude"], {
          home,
          stdin: JSON.stringify({ session_id: "sess-1", hook_event_name: "PostToolUse", cwd: home }),
        });

      await postToolUse();
      const afterFirstCall = await sse.nextEvent(2000);
      expect(afterFirstCall.sessions).toHaveLength(1);
      const firstSession = afterFirstCall.sessions[0] as { lastEventTs?: string };
      const firstLastEventTs = firstSession.lastEventTs;
      expect(typeof firstLastEventTs).toBe("string");

      await new Promise((resolve) => setTimeout(resolve, 10));
      for (let i = 0; i < 9; i++) await postToolUse();

      const afterMoreCalls = await sse.nextEvent(2000);
      expect(afterMoreCalls.sessions).toHaveLength(1);
      const laterSession = afterMoreCalls.sessions[0] as { lastEventTs?: string };
      expect(laterSession.lastEventTs !== undefined && laterSession.lastEventTs > (firstLastEventTs as string)).toBe(
        true,
      );

      // Still exactly ONE Event in the log (the M6 backfill's own
      // session.started) — the 9 extra calls never grew it, per ADR 0002.
      const logLines = readFileSync(sessionLogPath("sess-1", home), "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
      expect(logLines).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// Ticket 13 — realtime parity, the Daemon side (criteria 2 and 3)
// ---------------------------------------------------------------------------

/**
 * Ticket 13, criterion 2: `Bun.serve`'s own idle timeout (documented default
 * 10 s; measured drop at ~10–12 s against the installed Bun version, 1.4.3)
 * dropped a QUIET `/events` connection — the measured cause of the board
 * "flapping all day." The fix is `eventsResponse`'s own
 * `server.timeout(req, 0)`, a PER-REQUEST override — not a server-wide
 * setting and not an SSE comment keepalive (tried first; see that
 * function's own doc comment for why it does NOT work on this Daemon's
 * exact `Bun.serve` shape). Nothing here is shortened by env, because
 * there is no interval left to shorten — this proves the fix against
 * Bun's REAL default idle timeout, which is why the test itself carries an
 * explicit, longer-than-default `bun:test` timeout (real seconds, never
 * real minutes, per the ticket's own bound).
 */
describe("tenaza ui — the /events idle-timeout override (ticket 13, criterion 2)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-daemon-idle-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("a quiet /events stream (no state change at all) survives past Bun's own default idle timeout", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/events`);
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDataFrame = false;

      // 13s: past the measured ~10-12s drop, comfortably inside this
      // test's own 20s timeout below.
      const WINDOW_MS = 13000;
      const start = Date.now();
      while (Date.now() - start < WINDOW_MS) {
        const remaining = WINDOW_MS - (Date.now() - start);
        const result = await Promise.race([
          reader.read().then((r) => ({ kind: "read" as const, ...r })),
          new Promise<{ kind: "timedOut" }>((resolve) => setTimeout(() => resolve({ kind: "timedOut" }), remaining)),
        ]);
        if (result.kind === "timedOut") break;
        if (result.done) {
          throw new Error("the /events stream closed before surviving past the idle timeout");
        }
        buffer += decoder.decode(result.value, { stream: true });
        if (buffer.includes("data: ")) sawDataFrame = true;
      }

      expect(sawDataFrame).toBe(true); // the initial connect-time push arrived and nothing dropped the connection since

      await reader.cancel();
    } finally {
      await daemon.stop();
    }
  }, 20000);
});

/**
 * Ticket 13, criterion 3: `buildBoardPayload` reading EVERY Session log on
 * every changed tick (a cost that grows with history; the measured ~440 ms
 * was the `git` spawns, covered further below) is now OPTIONALLY backed by
 * a per-process `SessionLogCache` (`log.ts`) keyed on each file's own
 * (mtime, size). This is a PERFORMANCE change, never a behaviour one —
 * the differential test below is the ticket's own acceptance bar: the
 * cached path's JSON output must be byte-identical to the uncached one,
 * over the SAME fixture home, cold AND after an incremental change.
 */
describe("buildBoardPayload — cached vs uncached (ticket 13, criterion 3)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-daemon-cache-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * A deliberately varied fixture — alive top-level Session with a
   * `flag`-effect last signal, a nested subagent, a plain ended ("TERMINÓ")
   * Session, an ended-AND-archived one (ticket 11, hidden from the board),
   * one OPEN Inbox item and one RESOLVED one (so the resolution trace is
   * non-empty too) — so the differential test below exercises every shape
   * `buildBoardPayload` folds together, not just the empty-home case.
   */
  function seedFixture(): void {
    appendEvent(
      home,
      sessionStartedEvent("parent-1", { runtime: "claude", cwd: home, capabilities: ["observe", "measure"] }),
    );
    appendEvent(home, usageSampledEvent("parent-1", { context_tokens: 12000 }));
    appendEvent(
      home,
      actionDecidedEvent("parent-1", { kind: "shell", command: "echo hi", tool: "Bash" }, "allow", {
        match: "echo",
        effect: "flag",
      }),
    );

    appendEvent(
      home,
      sessionStartedEvent("child-1", { parent: "parent-1", runtime: "claude", cwd: home, capabilities: ["observe"] }),
    );

    appendEvent(home, sessionStartedEvent("ended-1", { runtime: "claude", cwd: home, capabilities: ["observe"] }));
    appendEvent(home, sessionEndedEvent("ended-1", "clear"));

    appendEvent(home, sessionStartedEvent("archived-1", { runtime: "claude", cwd: home, capabilities: ["observe"] }));
    appendEvent(home, sessionEndedEvent("archived-1", "clear"));
    appendHumanEvent(home, sessionArchivedEvent("archived-1"));

    appendEvent(
      home,
      actionDecidedEvent("parent-1", { kind: "shell", command: "gh pr merge", tool: "Bash" }, "deny", {
        match: "gh pr merge",
        effect: "human",
      }),
    );

    appendEvent(home, sessionStartedEvent("resolved-1", { runtime: "claude", cwd: home, capabilities: ["observe"] }));
    appendEvent(
      home,
      actionDecidedEvent(
        "resolved-1",
        { kind: "shell", command: "git worktree remove x", tool: "Bash" },
        "deny",
        { match: "git worktree remove", effect: "human" },
      ),
    );
    appendHumanEvent(home, approvalResolvedEvent("resolved-1", inboxIdentityHash("resolved-1", 1), "done", "run"));
  }

  test("a cold cached read is byte-identical to the uncached read, and stays identical on a warm re-read with nothing changed", () => {
    seedFixture();

    const uncached = JSON.stringify(buildBoardPayload(home));

    const cache = createSessionLogCache();
    const cachedCold = JSON.stringify(buildBoardPayload(home, cache));
    expect(cachedCold).toBe(uncached);

    const cachedWarm = JSON.stringify(buildBoardPayload(home, cache));
    expect(cachedWarm).toBe(uncached);
  });

  test("after ONE Session's log changes, a warm cached read is byte-identical to a fresh uncached read of the SAME updated state", () => {
    seedFixture();

    const cache = createSessionLogCache();
    buildBoardPayload(home, cache); // warm it, same as the Daemon's own connect-time push

    // One more real Event lands on ONE Session — the realistic shape of a
    // single hook call between two watcher ticks.
    appendEvent(home, usageSampledEvent("parent-1", { context_tokens: 45000 }));

    const freshUncached = JSON.stringify(buildBoardPayload(home));
    const cachedAfterChange = JSON.stringify(buildBoardPayload(home, cache));
    expect(cachedAfterChange).toBe(freshUncached);
  });

  test("a Session log hand-deleted since the last warm read drops out of a cached read too — never served stale from the cache", () => {
    seedFixture();
    const cache = createSessionLogCache();
    buildBoardPayload(home, cache); // warms the cache with every fixture file, including "ended-1"

    rmSync(sessionLogPath("ended-1", home), { force: true });

    const freshUncached = JSON.stringify(buildBoardPayload(home));
    const cachedAfterDelete = JSON.stringify(buildBoardPayload(home, cache));
    expect(cachedAfterDelete).toBe(freshUncached);
    expect(JSON.parse(cachedAfterDelete).sessions.map((s: { id: string }) => s.id)).not.toContain("ended-1");
  });

  test("a brand-new Session's log, written after the cache was warmed, is picked up alongside every already-cached file", () => {
    seedFixture();
    const cache = createSessionLogCache();
    buildBoardPayload(home, cache);

    appendEvent(home, sessionStartedEvent("new-1", { runtime: "claude", cwd: home, capabilities: ["observe"] }));

    const freshUncached = JSON.stringify(buildBoardPayload(home));
    const cachedAfterChange = JSON.stringify(buildBoardPayload(home, cache));
    expect(cachedAfterChange).toBe(freshUncached);
    expect(JSON.parse(cachedAfterChange).sessions.map((s: { id: string }) => s.id)).toContain("new-1");
  });

  /**
   * Criterion 3's ACTUAL measured cause (found by profiling, not the
   * framing's own guess): `deriveProject`'s `git` spawn, once per Session
   * lacking a `project` Label — `createCachingGitRootResolver`
   * (`sessions.ts`) memoizes it by `cwd`. A FAKE resolver (never a real
   * `git` spawn — deterministic and CI-safe) proves two things: the
   * memoized resolver is called once per DISTINCT `cwd`, never once per
   * Session, and — same bar as every other cache in this ticket — it never
   * changes the resolved VALUE.
   */
  test("the git-root resolver cache is called once per DISTINCT cwd, never once per Session, and never changes the resolved project", () => {
    appendEvent(home, sessionStartedEvent("a-1", { runtime: "claude", cwd: "/repo/one", capabilities: ["observe"] }));
    appendEvent(home, sessionStartedEvent("a-2", { runtime: "claude", cwd: "/repo/one", capabilities: ["observe"] }));
    appendEvent(home, sessionStartedEvent("b-1", { runtime: "claude", cwd: "/repo/two", capabilities: ["observe"] }));

    let calls = 0;
    const fakeResolveGitRoot = (cwd: string): string | undefined => {
      calls += 1;
      return `/git-root-for${cwd}`;
    };

    const withoutMemo = JSON.stringify(buildBoardPayload(home, undefined, fakeResolveGitRoot));
    expect(calls).toBe(3); // one spawn per SESSION — the pre-ticket-13 shape, reproduced here with a fake

    calls = 0;
    const memoized = createCachingGitRootResolver(fakeResolveGitRoot);
    const withMemo = JSON.stringify(buildBoardPayload(home, undefined, memoized));
    expect(calls).toBe(2); // one spawn per DISTINCT cwd — "/repo/one" and "/repo/two"
    expect(withMemo).toBe(withoutMemo);

    // A second call through the SAME memoized resolver spawns nothing further.
    calls = 0;
    const secondCall = JSON.stringify(buildBoardPayload(home, undefined, memoized));
    expect(calls).toBe(0);
    expect(secondCall).toBe(withoutMemo);
  });
});

describe("buildBoardPayload — ticket 14: the touched-file merge and nativeWait", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-daemon-ticket14-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("AC3: a Session's own .touched file moves lastEventTs forward past its latest Event", () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: home, capabilities: [] }));
    const beforeTouch = buildBoardPayload(home).sessions[0]?.lastEventTs;

    touchSession(home, "sess-1");
    // Guarantee a strictly later ISO timestamp than whatever session.started carried.
    const future = new Date(Date.now() + 60_000);
    utimesSync(sessionTouchedPath("sess-1", home), future, future);

    const afterTouch = buildBoardPayload(home).sessions[0]?.lastEventTs;
    expect(afterTouch).toBeDefined();
    expect(afterTouch! > (beforeTouch as string)).toBe(true);
  });

  test("AC3: the touch never shrinks lastEventTs — a touch OLDER than the latest Event changes nothing", () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: home, capabilities: [] }));
    const started = buildBoardPayload(home).sessions[0]?.lastEventTs;

    touchSession(home, "sess-1");
    const past = new Date(Date.now() - 60_000);
    utimesSync(sessionTouchedPath("sess-1", home), past, past);

    expect(buildBoardPayload(home).sessions[0]?.lastEventTs).toBe(started);
  });

  test("a native permission_prompt is the most recent thing observed — nativeWait is present", () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: home, capabilities: [] }));
    appendEvent(home, notificationObservedEvent("sess-1", "permission_prompt"));

    const session = buildBoardPayload(home).sessions[0];
    expect(session?.nativeWait).toMatchObject({ kind: "permission_prompt" });
  });

  test("a later touch (ordinary tool-call activity) supersedes a stale native wait — no second Event ever written for the transition", () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: home, capabilities: [] }));
    appendEvent(home, notificationObservedEvent("sess-1", "idle_prompt"));
    expect(buildBoardPayload(home).sessions[0]?.nativeWait).toMatchObject({ kind: "idle_prompt" });

    touchSession(home, "sess-1");
    const future = new Date(Date.now() + 60_000);
    utimesSync(sessionTouchedPath("sess-1", home), future, future);

    const after = buildBoardPayload(home);
    expect(after.sessions[0]?.nativeWait).toBeUndefined();
    // Still just the two Events — superseding a native wait writes nothing new.
    expect(readSessionEvents("sess-1", home)).toHaveLength(2);
  });

  test("a later prompt.submitted Event (a fresh turn) also supersedes a stale native wait", async () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: home, capabilities: [] }));
    appendEvent(home, notificationObservedEvent("sess-1", "permission_prompt"));
    // A real turn boundary is always milliseconds apart in practice (a
    // SEPARATE Claude Code hook invocation) — nativeWaitFor's own ordering
    // check is a strict ts comparison (same accepted tie as log.ts's own
    // appendEventAtLine doc), so this guarantees a distinct, later ts
    // rather than asserting behavior the clock's own resolution could flake.
    await Bun.sleep(5);
    appendEvent(home, promptSubmittedEvent("sess-1"));

    expect(buildBoardPayload(home).sessions[0]?.nativeWait).toBeUndefined();
  });

  test("no notification.observed Event at all — nativeWait is undefined", () => {
    appendEvent(home, sessionStartedEvent("sess-1", { runtime: "claude", cwd: home, capabilities: [] }));
    expect(buildBoardPayload(home).sessions[0]?.nativeWait).toBeUndefined();
  });
});
