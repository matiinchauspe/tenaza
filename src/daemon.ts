import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Action, TerminalLocator } from "./contract/event";
import type { ActionSummary, BoardInboxItem, BoardPayload, BoardSession, ResolutionTraceEntry, TerminalReach } from "./contract/live";
import {
  buildDaemonUrl,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_STALE_MS,
  generateDaemonToken,
  heartbeatIntervalMs,
  isHeartbeatFresh,
  readAlive,
  readDaemonToken,
  writeAlive,
  writeDaemonToken,
} from "./daemonlink";
import { runFocusPlan } from "./focus";
import { type InboxItem, deriveInbox, deriveResolutionTraceBySession } from "./inbox";
import { createSessionLogCache, readAllSessionEvents, readAllSessionEventsCached, type SessionLogCache } from "./log";
import { notifyUnnotifiedInboxItems } from "./notify";
import {
  daemonAlivePath,
  daemonTokenPath,
  DEFAULT_DAEMON_PORT,
  humanLogPath,
  openRecorderPath,
  sessionsDir,
  tenazaHome,
} from "./paths";
import { effectiveWaitSeconds, loadPolicy } from "./policy";
import {
  archiveSession,
  postLiveAnswer,
  resolveInboxItem,
  startInboxItemRunStream,
  UnknownInboxItemError,
  type ArchiveRefusal,
  type ResolutionOutcome,
  type RunRefusal,
} from "./resolve";
import {
  UNKNOWN_PROJECT,
  buildSessionIndex,
  childrenIndex,
  closedOutSessionIndex,
  countActiveDescendants,
  createCachingGitRootResolver,
  deriveProject,
  eventTypesBySession,
  isArchived,
  isNoiseSession,
  latestArchiveTimestamps,
  nativeWaitFor,
  readTouchedTimestamps,
  turnWaitSince,
  UnknownSessionError,
  type SessionNode,
} from "./sessions";
import { detectRow, planFocus, reachFor, resolveTmuxOuterLive, type LiveFacts } from "./terminals";
import { TENAZA_VERSION } from "./version";
import index from "./ui/index.html";

/** Re-exported from `paths.ts` so existing callers that look for it here — `tenaza ui`'s own default included — are unaffected. */
export { DEFAULT_DAEMON_PORT };

/**
 * Re-exported from `daemonlink.ts`, their real home, so existing callers
 * that looked for them here are unaffected.
 */
export {
  buildDaemonUrl,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_STALE_MS,
  generateDaemonToken,
  isHeartbeatFresh,
  readAlive,
  readDaemonToken,
  writeAlive,
  writeDaemonToken,
};

/** Overridable via `TENAZA_SSE_POLL_MS`, so a test never waits the real poll interval. */
export const DEFAULT_SSE_POLL_INTERVAL_MS = 500;

/** How long `GET /health` gets to answer before a second launch gives up and treats the port as free — the hung-or-absent-listener half of guarding against a new launch getting blocked (a stale `daemon.alive`/`daemon.token` is the other half, handled elsewhere). */
const PROBE_TIMEOUT_MS = 500;

/** The cookie a browser keeps once the page has seen a valid `?token=`. */
const TOKEN_COOKIE_NAME = "tenaza_token";

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ssePollIntervalMs(): number {
  return positiveIntFromEnv("TENAZA_SSE_POLL_MS", DEFAULT_SSE_POLL_INTERVAL_MS);
}

function removeIfExists(file: string): void {
  try {
    if (existsSync(file)) rmSync(file, { force: true });
  } catch {
    // Shutdown hygiene only — a failed cleanup must never stop the process from exiting.
  }
}

/** Not required for correctness — a crashed Daemon leaves the same files behind, and `probeExistingDaemon` below never trusts their mere presence either way — but it closes the harmless window where a leftover token could still open a URL for a Daemon that already exited cleanly. */
export function clearDaemonFiles(home: string): void {
  removeIfExists(daemonAlivePath(home));
  removeIfExists(daemonTokenPath(home));
}

// ---------------------------------------------------------------------------
// The opener test seam
// ---------------------------------------------------------------------------

function appendOpenRecorder(home: string, url: string): void {
  const file = openRecorderPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ url })}\n`, "utf8");
}

/** Read back every URL the opener seam captured, in order — the test oracle for what would have been opened. */
export function readOpenRecorder(home: string = tenazaHome()): string[] {
  const file = openRecorderPath(home);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { url: string }).url);
}

/**
 * Open `url` in the human's browser — the only function that decides how:
 *   - `TENAZA_OPEN_RECORDER` set → append to the recorder file instead of
 *     touching the OS at all.
 *   - unset → spawn the real `open <url>` (macOS).
 * Never throws — a failing opener must never fail a Daemon that already
 * started successfully.
 */
export function openBrowser(home: string, url: string): void {
  try {
    if (process.env.TENAZA_OPEN_RECORDER) {
      appendOpenRecorder(home, url);
      return;
    }
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  } catch {
  }
}

// ---------------------------------------------------------------------------
// Derived state (what the SSE stream pushes)
// ---------------------------------------------------------------------------

/** An `Action`, flattened to the shape the board's contract shares between an Inbox row's "tool + command" and a Session row's "last signal" — `command` only for a `shell` Action. */
function toActionSummary(action: Action): ActionSummary {
  return {
    kind: action.kind,
    tool: action.tool,
    command: action.kind === "shell" ? action.command : undefined,
  };
}

/**
 * A subagent's card focuses its parent's terminal: resolved here against
 * the FULL, unfiltered index, since a subagent's own `session.started`
 * never carries a `terminal` field at all. `fullIndex` is the same index
 * `buildBoardPayload` already built — never rebuilt here.
 */
function terminalInfoFor(
  node: SessionNode,
  fullIndex: ReadonlyMap<string, SessionNode>,
): { reach: TerminalReach; appLabel: string | undefined; needsTcc: boolean } {
  const parent = node.parent !== undefined ? fullIndex.get(node.parent) : undefined;
  const locator = (parent ?? node).terminalLocator;
  const { level, appLabel, needsTcc } = reachFor(locator);
  return { reach: level, appLabel, needsTcc };
}

/**
 * One session's board row: resolved to a `project` and the structural
 * `role` server-side — `deriveProject` shells out to `git` and can never
 * ship to a browser bundle, and `role` here is deliberately not
 * `sessions.ts`'s own `roleOf` (which folds the `ticket` Label into its
 * fallback for the CLI's one compact line) — the board shows `ticket` and
 * `role` as separate fields. Everything else is a plain, time-independent
 * fact; `board.ts`'s pure functions do the time-based classification
 * against a ticking clock.
 */
function toBoardSession(
  node: SessionNode,
  resolutions: ReadonlyMap<string, ResolutionTraceEntry[]>,
  fullIndex: ReadonlyMap<string, SessionNode>,
  childrenOf: ReadonlyMap<string, SessionNode[]>,
  resolveGitRoot?: (cwd: string) => string | undefined,
): BoardSession {
  const terminal = terminalInfoFor(node, fullIndex);
  // `turnWaitSince` already defers to a more specific native wait when
  // one is current — never double-badged.
  const turnWait = turnWaitSince(node);
  return {
    id: node.id,
    parentId: node.parent,
    project: deriveProject(node, resolveGitRoot),
    ticket: node.labels.ticket,
    verdict: node.labels.verdict,
    role: node.parent !== undefined ? "subagente" : "sesión",
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    lastEventTs: node.lastEventTs,
    hasMeasureCapability: node.capabilities.includes("measure"),
    contextTokens: node.contextTokens,
    lastSignal: node.lastAction ? toActionSummary(node.lastAction) : undefined,
    // Newest-first, already derived by `deriveResolutionTraceBySession` — never re-sorted or re-filtered here.
    resolutions: resolutions.get(node.id) ?? [],
    terminalReach: terminal.reach,
    terminalAppLabel: terminal.appLabel,
    terminalNeedsTcc: terminal.needsTcc,
    // `node.lastEventTs` already carries the touched-file merge (below) —
    // `nativeWaitFor` uses it to tell a current native wait from a stale
    // one any later activity has superseded.
    nativeWait: nativeWaitFor(node),
    // `backgroundCount` is computed only when `turnWait` is present, so a
    // working/ended session never pays for a traversal nobody will read.
    turnWait: turnWait ? { since: turnWait, backgroundCount: countActiveDescendants(node.id, childrenOf) } : undefined,
  };
}

/** One pending Inbox item's board row — `project`/`ticket` resolved from the FULL, unfiltered index: an Inbox item's own session is never noise, but resolving against the full index rather than relying on that costs nothing and stays correct either way. */
function toBoardInboxItem(
  row: InboxItem,
  fullIndex: ReadonlyMap<string, SessionNode>,
  resolveGitRoot?: (cwd: string) => string | undefined,
): BoardInboxItem {
  const session = fullIndex.get(row.session);
  // Resolved from the owning session. A session this payload never
  // observed (shouldn't happen — an Inbox item's own session always
  // carries at least its `action.decided` Event) degrades to "unknown,"
  // never a crash.
  const terminal = session ? terminalInfoFor(session, fullIndex) : { reach: "unknown" as const, appLabel: undefined, needsTcc: false };
  return {
    id: row.id,
    sessionId: row.session,
    project: session ? deriveProject(session, resolveGitRoot) : UNKNOWN_PROJECT,
    ticket: session?.labels.ticket,
    ts: row.ts,
    action: toActionSummary(row.action),
    blocked: row.blocked,
    decision: row.decision,
    terminalReach: terminal.reach,
    terminalAppLabel: terminal.appLabel,
    terminalNeedsTcc: terminal.needsTcc,
  };
}

/**
 * The Live surface's own payload — what `/events` pushes, and the one
 * shape `contract/live.ts` and the React client agree on. Sessions and
 * the Inbox are derived from the logs on every call, filtered through the
 * same noise check `renderSessionTree` already uses (`isNoiseSession`,
 * reused rather than re-derived, so the board and `tenaza status` can
 * never show a different session count for the same logs), plus the
 * Policy numbers the client's pure functions need and must never hardcode
 * a second copy of.
 *
 * `cache` and `resolveGitRoot` are both optional and change nothing about
 * the value returned — only how cheaply it gets there. Omitted, every
 * session log is read and parsed fresh and every session's project is
 * resolved with its own fresh `git` spawn. Passed, a session log whose
 * (mtime, size) hasn't moved since `cache` last saw it is never re-read,
 * and a `cwd` `resolveGitRoot` has already resolved is never spawned
 * twice. Of the two, `resolveGitRoot` is what actually avoids the
 * expensive part — repeated `git` spawns, not the log reads `cache` alone
 * addresses.
 */
export function buildBoardPayload(
  home: string,
  cache?: SessionLogCache,
  resolveGitRoot?: (cwd: string) => string | undefined,
): BoardPayload {
  const events = cache ? readAllSessionEventsCached(home, cache).events : readAllSessionEvents(home);
  // `closedOutSessionIndex` folds each session's own touch
  // (`toolcalls.ts`'s `touchSession`) into `lastEventTs` BEFORE the
  // close-detection checks run — one fixed order, not several call sites
  // re-deriving it by hand.
  const fullIndex = closedOutSessionIndex(events, readTouchedTimestamps(home));
  const eventTypes = eventTypesBySession(events);
  // An archived session's card is hidden from the board alone, never
  // `tenaza status`, filtered the same way noise already is. `isArchived`
  // re-judges each node's own `lastEventTs` against its latest archive ts
  // on every read rather than a permanent set, so a session resumed after
  // being archived comes straight back the next time this runs.
  const archivedAt = latestArchiveTimestamps(home);
  const visibleSessions = [...fullIndex.values()].filter(
    (node) =>
      !isNoiseSession(eventTypes.get(node.id) ?? new Set(), node.endedReason) &&
      !isArchived(archivedAt.get(node.id), node.lastEventTs),
  );
  const policy = loadPolicy(home);
  const resolutions = deriveResolutionTraceBySession(home);
  // Built once per read against the FULL index — a noise or archived
  // child is always `endedAt`-set, so it never counts toward
  // `countActiveDescendants` anyway, which is what makes reusing the
  // unfiltered structure here safe.
  const childrenOf = childrenIndex([...fullIndex.values()]);

  return {
    v: 1,
    policy: {
      stallMinutes: policy.stallMinutes,
      contextThresholdTokens: policy.thresholdTokens,
      waitSeconds: effectiveWaitSeconds(policy),
    },
    sessions: visibleSessions.map((node) => toBoardSession(node, resolutions, fullIndex, childrenOf, resolveGitRoot)),
    inbox: deriveInbox(home, cache).map((row) => toBoardInboxItem(row, fullIndex, resolveGitRoot)),
  };
}

/**
 * A cheap signature of every file the derived state above could possibly
 * depend on — each session's own `*.jsonl` log (name/size/mtime) plus the
 * human log's own, the same files `buildBoardPayload` actually reads — so
 * the watcher below can tell "nothing changed" from "something did"
 * without recomputing the more expensive derived state on every tick.
 *
 * `*.touched` is included because `buildBoardPayload` now reads it (the
 * touched-file merge, above) — leaving it out would mean an ordinary tool
 * call's own touch could bump `lastEventTs` on disk with the watcher
 * never noticing, reintroducing a "busy agent reads frozen" gap. The
 * payload-equality check in `startStateWatcher` still coalesces every
 * touch inside one poll interval into at most one push — nothing here
 * pushes per call, only per tick that found something new.
 *
 * Deliberately excludes `<session>.toolcalls`: that counter is bumped on
 * every `PostToolUse` call, not just the ones that change derived state,
 * and `buildBoardPayload` never reads it at all. Including it would make
 * nearly every tick under ordinary tool-call traffic recompute for a
 * value that provably cannot have changed.
 */
function computeStateSignature(home: string): string {
  const parts: string[] = [];
  const dir = sessionsDir(home);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)
      .filter((entry) => entry.endsWith(".jsonl") || entry.endsWith(".touched"))
      .sort()) {
      const stat = statSync(path.join(dir, name));
      parts.push(`${name}:${stat.mtimeMs}:${stat.size}`);
    }
  }
  const humanFile = humanLogPath(home);
  if (existsSync(humanFile)) {
    const stat = statSync(humanFile);
    parts.push(`human:${stat.mtimeMs}:${stat.size}`);
  }
  return parts.join("|");
}

// ---------------------------------------------------------------------------
// The SSE broadcaster
// ---------------------------------------------------------------------------

type SseController = ReadableStreamDefaultController<Uint8Array>;

function encodeSseFrame(payloadJson: string): Uint8Array {
  return new TextEncoder().encode(`data: ${payloadJson}\n\n`);
}

function encodeSseEvent(data: unknown): Uint8Array {
  return encodeSseFrame(JSON.stringify(data));
}

/**
 * Polls `~/.tenaza/state/` on an interval rather than using `fs.watch`:
 *   - `fs.watch` has no portable recursive mode (Linux lacks it entirely;
 *     macOS's FSEvents-backed one is known to coalesce, reorder, or miss
 *     rapid successive writes to the same file — exactly the shape of two
 *     parallel hooks appending to one session's log at once).
 *   - A cheap stat-based signature, polled on a fixed interval, degrades
 *     predictably instead: worst case it adds one interval's latency,
 *     never a missed or duplicated event, and it's identical code on
 *     every OS Bun targets.
 *   - Polling also coalesces bursts for free: several writes inside one
 *     interval collapse into the single recompute-and-push that tick
 *     does, with no separate debounce timer to get wrong.
 * The cost: up to one poll interval of latency between a write and the
 * SSE push. `TENAZA_SSE_POLL_MS` shortens that for tests.
 *
 * `cache` and `resolveGitRoot` are the Daemon's own per-process log cache
 * and git-root memoization, threaded into `buildBoardPayload` so a tick
 * never pays to re-read a session log that didn't change or re-spawn
 * `git` for a `cwd` it already resolved (see that function's own doc for
 * which one actually matters). Both optional only so a caller without
 * them still gets the same value; `runUi` below always passes both.
 *
 * `onStateChange` runs on every tick the signature moved, before the
 * payload comparison, since a write can matter to it without changing what
 * a client sees.
 */
export function startStateWatcher(
  home: string,
  clients: Set<SseController>,
  cache?: SessionLogCache,
  resolveGitRoot?: (cwd: string) => string | undefined,
  onStateChange?: () => void,
): { stop(): void } {
  let lastSignature: string | undefined;
  let lastPayload: string | undefined;

  const tick = (): void => {
    try {
      const signature = computeStateSignature(home);
      if (signature === lastSignature) return;
      lastSignature = signature;
      onStateChange?.();

      // The stat signature changing is necessary, not sufficient — a usage
      // sample that leaves the context bar's number unchanged, or a torn
      // line the reader skips either way, can still move an mtime/size
      // without moving the derived value a client would ever see.
      // Comparing the serialized payload, not just the signature, is what
      // makes this push on a change a client could observe.
      const payload = JSON.stringify(buildBoardPayload(home, cache, resolveGitRoot));
      if (payload === lastPayload) return;
      lastPayload = payload;

      const chunk = encodeSseFrame(payload);
      for (const controller of clients) {
        try {
          controller.enqueue(chunk);
        } catch {
          clients.delete(controller);
        }
      }
    } catch {
      // A watcher tick must never crash the Daemon's process.
    }
  };

  const interval = setInterval(tick, ssePollIntervalMs());
  return {
    stop(): void {
      clearInterval(interval);
    },
  };
}

// ---------------------------------------------------------------------------
// Auth (token-gated writes; reads stay open)
// ---------------------------------------------------------------------------

function cookieToken(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === TOKEN_COOKIE_NAME) return rawValue.join("=");
  }
  return undefined;
}

/**
 * Does this request carry the Daemon's own current token — the cookie a
 * prior page load set, or (first load, a bare curl, or a stale cookie from
 * a previous launch) the `?token=` query parameter? The token rotates
 * every launch, so a browser tab left open across a restart carries a
 * cookie that no longer matches — that falls through to the query form
 * rather than failing outright, same as no cookie at all. Not a security
 * boundary — agents run as the same user as the Daemon — so a plain
 * string compare is enough.
 */
export function isAuthorizedRequest(req: Request, token: string): boolean {
  const fromCookie = cookieToken(req);
  if (fromCookie !== undefined && fromCookie === token) return true;
  const url = new URL(req.url);
  return url.searchParams.get("token") === token;
}

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

interface DaemonContext {
  home: string;
  token: string;
  clients: Set<SseController>;
  /** Warmed across every connect-time push and watcher tick alike. */
  logCache: SessionLogCache;
  /** Never invalidated within one Daemon's run. */
  resolveGitRoot: (cwd: string) => string | undefined;
}

function healthResponse(): Response {
  return Response.json({ tenaza: true, version: TENAZA_VERSION });
}

/**
 * `GET /auth?token=` — the one route a browser load carries the token in
 * the URL for. `Bun.serve`'s `routes` table claims `/` entirely for the
 * static bundled page, leaving no per-request handler there to set the
 * HttpOnly cookie, so that has to happen on its own route instead: this
 * one validates the token against THIS launch's own, sets the cookie, and
 * 302s on to the plain `/` — the token never lingers in the address bar
 * the human lands on. An invalid or missing token sets no cookie and
 * answers 401: there is no path through this function that redirects
 * without having just set a correct cookie.
 */
function authResponse(ctx: DaemonContext, url: URL): Response {
  if (url.searchParams.get("token") !== ctx.token) {
    return new Response("unauthorized\n", { status: 401 });
  }
  const headers = new Headers({ location: "/" });
  // `Strict`, not `Lax`: a `Lax` cookie (sent on a cross-site top-level GET
  // navigation) would hand an attacker-controlled page the same cookie a
  // legitimate same-site GET gets, and the deny-by-default gate below
  // covers GET on every non-read path too.
  headers.append("set-cookie", `${TOKEN_COOKIE_NAME}=${ctx.token}; HttpOnly; SameSite=Strict; Path=/`);
  return new Response(null, { status: 302, headers });
}

/**
 * `GET /events` — an open read: the SSE stream, no token required. Pushes
 * the current derived state immediately on connect, then whatever
 * `startStateWatcher` enqueues later.
 *
 * `server.timeout(req, 0)` disables `Bun.serve`'s own idle timeout for
 * this connection — without it, a quiet `/events` connection gets dropped
 * after a short idle window. A periodic SSE comment keepalive does NOT
 * reset that idle clock on this server's shape (`routes` claiming `/`
 * alongside `fetch` handling everything else) the way it would on a
 * `fetch`-only server, so the per-request override is the only mechanism
 * that actually works here. `clients.delete` on `cancel()`/a failed
 * `enqueue()` is unaffected — only the server-initiated idle drop is gone.
 */
function eventsResponse(ctx: DaemonContext, req: Request, server: ReturnType<typeof Bun.serve>): Response {
  server.timeout(req, 0);
  let thisController: SseController | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      thisController = controller;
      ctx.clients.add(controller);
      controller.enqueue(encodeSseEvent(buildBoardPayload(ctx.home, ctx.logCache, ctx.resolveGitRoot)));
    },
    cancel() {
      if (thisController) ctx.clients.delete(thisController);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Write routes: resolve a pending Inbox item from the view
// ---------------------------------------------------------------------------

/** `POST /items/<id>/run|done|dismiss|answer`. A future action route is only added here if it shares this exact `/items/<id>/…` shape — never by widening this pattern. `id` is the item's full identity hash: the board's own contract never carries anything shorter, so there's no prefix to resolve. */
const ITEM_ACTION_PATTERN = /^\/items\/([0-9a-f]{4,64})\/(run|done|dismiss|answer)$/;

/** A refusal with nothing spawned, translated to a client error the view shows inline. `already-resolved`/`unblockable`/`not-runnable` are "this item's own state forbids it" (409); `no-cwd`/`cwd-missing` get 422 instead — distinct enough to point the human at a different fix. */
function runRefusalResponse(refusal: RunRefusal): Response {
  if (refusal.kind === "no-cwd" || refusal.kind === "cwd-missing") {
    return Response.json({ error: refusal.kind, ...refusal }, { status: 422 });
  }
  return Response.json({ error: refusal.kind }, { status: 409 });
}

/** Spawning the shell itself threw — answers 500 with the raw message rather than letting an uncaught exception reach `Bun.serve`'s own generic, message-less error response. */
function spawnFailedResponse(message: string): Response {
  return Response.json({ error: "spawn-failed", message }, { status: 500 });
}

/**
 * `POST /items/<id>/run`: starts the item's stored command and hands its
 * `ReadableStream` straight back as the response body — chunked, so the
 * card can render output as it arrives. `content-type: text/plain`
 * deliberately: this is raw combined stdout+stderr, never a structured
 * envelope. The run's own outcome is never carried in this response at
 * all — it's derived from the Inbox like every other resolution, which is
 * what lets the board's own `/events` SSE be the one place a client needs
 * to check for it once the stream here ends.
 */
function runItemResponse(ctx: DaemonContext, id: string): Response {
  try {
    const result = startInboxItemRunStream(ctx.home, id);
    if (result.kind === "stream") {
      return new Response(result.stream, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (result.kind === "spawn-failed") return spawnFailedResponse(result.message);
    return runRefusalResponse(result);
  } catch (error) {
    if (error instanceof UnknownInboxItemError) return new Response("not found\n", { status: 404 });
    throw error;
  }
}

/** `POST /items/<id>/done|dismiss`: closes the item by hand, exactly as the CLI's own `done`/`dismiss` do — never executes anything. */
function resolveItemResponse(ctx: DaemonContext, id: string, outcome: ResolutionOutcome): Response {
  try {
    const result = resolveInboxItem(ctx.home, id, outcome);
    return Response.json({ outcome, alreadyResolved: result.alreadyResolved });
  } catch (error) {
    if (error instanceof UnknownInboxItemError) return new Response("not found\n", { status: 404 });
    throw error;
  }
}

/**
 * `POST /items/<id>/answer`: the one write route the browser's TE ESPERA
 * card posts to — appends the human's raw answer for the item's own held
 * hook to read back and act on. Never closes the item itself, and never
 * touches the agent's own call — only records what the human said. A
 * malformed body is a plain 400, never a 500 or a silent accept; a refusal
 * with nothing written (already resolved, or no longer live) is a 409.
 */
async function answerItemResponse(ctx: DaemonContext, id: string, req: Request): Promise<Response> {
  let body: { answer?: unknown; message?: unknown };
  try {
    body = (await req.json()) as { answer?: unknown; message?: unknown };
  } catch {
    return Response.json({ error: "invalid-body" }, { status: 400 });
  }
  if (body.answer !== "approve" && body.answer !== "reject") {
    return Response.json({ error: "invalid-answer" }, { status: 400 });
  }
  const message = typeof body.message === "string" && body.message.length > 0 ? body.message : undefined;

  try {
    const result = postLiveAnswer(ctx.home, id, body.answer, message);
    if (result.kind === "accepted") return Response.json({ ok: true });
    return Response.json({ error: result.kind }, { status: 409 });
  } catch (error) {
    if (error instanceof UnknownInboxItemError) return new Response("not found\n", { status: 404 });
    throw error;
  }
}

/** Dispatch one `/items/<id>/<action>` write — `undefined` when `pathname` doesn't match the shape, so the caller falls through to the same bare 404 any other unrecognized path gets. */
async function itemActionResponse(ctx: DaemonContext, pathname: string, req: Request): Promise<Response | undefined> {
  const match = ITEM_ACTION_PATTERN.exec(pathname);
  if (!match) return undefined;
  const [, id, action] = match as unknown as [string, string, "run" | "done" | "dismiss" | "answer"];

  if (action === "run") return runItemResponse(ctx, id);
  if (action === "answer") return answerItemResponse(ctx, id, req);
  return resolveItemResponse(ctx, id, action === "done" ? "done" : "dismissed");
}

// ---------------------------------------------------------------------------
// Write routes: go to the agent's terminal, and archive a card. Neither
// shares `ITEM_ACTION_PATTERN`'s `/items/<id>/…` shape, so they get their
// own pattern and dispatcher.
// ---------------------------------------------------------------------------

/** `id` here is a session id (Claude Code's own `session_id`/`agent_id`) — never an Inbox item's hash, and not constrained to a hex shape like `ITEM_ACTION_PATTERN` is, since a runtime's session ids are opaque strings this project doesn't define. */
const SESSION_ACTION_PATTERN = /^\/sessions\/([^/]+)\/(focus|archive)$/;

/**
 * This session's own locator (or, for a subagent, its parent's) —
 * resolved against the FULL cross-session index, the same way
 * `terminalInfoFor` does for the board payload, so a click and the card's
 * own pre-click label can never resolve to two different terminals.
 */
function resolveFocusLocator(home: string, id: string): TerminalLocator | undefined {
  const fullIndex = buildSessionIndex(readAllSessionEvents(home));
  const node = fullIndex.get(id);
  if (!node) throw new UnknownSessionError(id);
  const parent = node.parent !== undefined ? fullIndex.get(node.parent) : undefined;
  return (parent ?? node).terminalLocator;
}

/**
 * `POST /sessions/<id>/focus`: the Daemon runs the focus command only on
 * this click, never on its own. Resolves the live tmux outer app here,
 * server-side — the one place a real process can be spawned; `planFocus`
 * itself stays pure and never does. Fire-and-forget past that point: a
 * failing or partial focus is never worse than not focusing at all, so
 * this always answers `{ ok: true }` once a plan was built; `level` rides
 * along for the human's own curiosity, never asserted on by the view.
 */
function focusSessionResponse(ctx: DaemonContext, id: string): Response {
  let locator: TerminalLocator | undefined;
  try {
    locator = resolveFocusLocator(ctx.home, id);
  } catch (error) {
    if (error instanceof UnknownSessionError) return new Response("not found\n", { status: 404 });
    throw error;
  }

  const row = locator ? detectRow(locator) : undefined;
  const liveFacts: LiveFacts = {};
  if (row?.id === "tmux" && locator?.tmuxSocket) {
    liveFacts.tmuxOuter = resolveTmuxOuterLive(locator.tmuxSocket);
  }

  const plan = planFocus(locator, liveFacts);
  runFocusPlan(ctx.home, plan.steps);
  return Response.json({ ok: true, level: plan.level });
}

/** A refusal with nothing appended — "this session's own state forbids it," answered as 409. */
function archiveRefusalResponse(refusal: ArchiveRefusal): Response {
  return Response.json({ error: refusal.kind }, { status: 409 });
}

/** `POST /sessions/<id>/archive`: the human's `x`/archivar click on a TERMINÓ card. Idempotent — a repeat archive still 200s with `alreadyArchived: true`. */
function archiveSessionResponse(ctx: DaemonContext, id: string): Response {
  try {
    const result = archiveSession(ctx.home, id);
    if (result.kind === "accepted") return Response.json({ ok: true, alreadyArchived: result.alreadyArchived });
    return archiveRefusalResponse(result);
  } catch (error) {
    if (error instanceof UnknownSessionError) return new Response("not found\n", { status: 404 });
    throw error;
  }
}

/** Dispatch one `/sessions/<id>/<action>` write — same `undefined`-falls-through shape `itemActionResponse` already gives. */
function sessionActionResponse(ctx: DaemonContext, pathname: string): Response | undefined {
  const match = SESSION_ACTION_PATTERN.exec(pathname);
  if (!match) return undefined;
  const [, id, action] = match as unknown as [string, string, "focus" | "archive"];

  if (action === "focus") return focusSessionResponse(ctx, id);
  return archiveSessionResponse(ctx, id);
}

/**
 * The Daemon's routing table for everything `routes` (below) doesn't
 * claim. `GET /` is a static HTML-import route on `Bun.serve`'s own
 * `routes` table instead — that gives it (and every asset it references)
 * Bun's automatic bundling and the same "open read, no token" treatment
 * every other static route gets for free. `GET /health`, `GET /events`
 * and `GET /auth` are the only open reads still answered here — `/auth`
 * validates the token itself, so it can't sit behind the token gate
 * below. Everything else is denied by default unless it carries the
 * token: `itemActionResponse` and `sessionActionResponse` are called only
 * AFTER that gate, never wrapped around any route individually, so there
 * is no path to a write here that could skip it.
 *
 * Takes `server` as the handler's second parameter only so `/events` can
 * call `server.timeout(req, 0)` — no other route needs it.
 */
export function createFetchHandler(
  ctx: DaemonContext,
): (req: Request, server: ReturnType<typeof Bun.serve>) => Response | Promise<Response> {
  return async (req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") return healthResponse();
    if (req.method === "GET" && url.pathname === "/events") return eventsResponse(ctx, req, server);
    if (req.method === "GET" && url.pathname === "/auth") return authResponse(ctx, url);

    if (!isAuthorizedRequest(req, ctx.token)) {
      return new Response("forbidden\n", { status: 403 });
    }

    if (req.method === "POST") {
      const handled = (await itemActionResponse(ctx, url.pathname, req)) ?? sessionActionResponse(ctx, url.pathname);
      if (handled) return handled;
    }

    return new Response("not found\n", { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Single instance (the port is the lock)
// ---------------------------------------------------------------------------

export type DaemonProbeResult =
  | { kind: "tenaza"; version: string }
  | { kind: "other" }
  | { kind: "free" };

/**
 * Identifies whether a Tenaza is already serving on `port` by its
 * `/health` response — never by the port merely being busy: a stale
 * `daemon.alive`/`daemon.token` from a crashed Daemon is never consulted
 * here, so it can never block a new launch either. Three outcomes: a live
 * Tenaza (`"tenaza"`), something else answering (`"other"`, e.g. another
 * dev server), or nothing answering at all (`"free"`, including a hung
 * non-HTTP listener that a short timeout gives up on like a refused
 * connection).
 */
export async function probeExistingDaemon(
  port: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<DaemonProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!res.ok) return { kind: "other" };
    const body = (await res.json().catch(() => undefined)) as { tenaza?: unknown; version?: unknown } | undefined;
    if (body && body.tenaza === true && typeof body.version === "string") {
      return { kind: "tenaza", version: body.version };
    }
    return { kind: "other" };
  } catch {
    return { kind: "free" };
  } finally {
    clearTimeout(timer);
  }
}

function describeBindError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// `tenaza ui`
// ---------------------------------------------------------------------------

export interface RunUiOptions {
  port?: number;
  home?: string;
  /**
   * `false` for the Homebrew `service` block's own launch
   * (`tenaza ui --no-open`) — never pop a browser window on a LaunchAgent
   * (re)start nobody asked for. Defaults to `true`.
   */
  open?: boolean;
}

/** Writes straight to process.stdout/stderr — tests observe this at the black-box seam (spawn the CLI, read its stdout), never by importing this module's internals. */
function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * `tenaza ui`: serves the Daemon on `--port` (default 4747) until Ctrl-C.
 * Single instance first — the port is the lock: a Tenaza already there is
 * opened, not duplicated; a non-Tenaza holder, or a genuine bind race,
 * gets a clear message, never a raw `EADDRINUSE`.
 */
export async function runUi(options: RunUiOptions = {}): Promise<number> {
  const home = options.home ?? tenazaHome();
  const port = options.port ?? DEFAULT_DAEMON_PORT;
  const shouldOpen = options.open ?? true;

  /**
   * Registered as the very first thing this function does, well before
   * the bind or the startup line a caller might be waiting on — a
   * deliberate ordering, not incidental. A process signaled in the same
   * instant it prints "serving on ..." can still fall through to the
   * runtime's own default signal-terminates-the-process disposition (exit
   * 130, not a clean stop) if the OS-level signal watcher underneath
   * `process.on` hasn't finished wiring up yet; registering it here,
   * before the probe+bind sequence, gives that wiring the whole
   * sequence's worth of time to settle. `shutdown` starts as a no-op and
   * is replaced once there is something real to tear down — a signal
   * before that point is near-impossible (probing + binding is
   * near-instant) and would simply resolve with nothing to clean up yet.
   */
  let shutdown: () => void = () => {};
  const shutdownRequested = new Promise<void>((resolve) => {
    const onSignal = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      shutdown();
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });

  const probe = await probeExistingDaemon(port);
  if (probe.kind === "tenaza") {
    const existingToken = readDaemonToken(home);
    const url = buildDaemonUrl(port, existingToken);
    print(`tenaza: a Tenaza is already serving on port ${port} (v${probe.version}) — opening it`);
    if (shouldOpen) openBrowser(home, url);
    return 0;
  }
  if (probe.kind === "other") {
    printErr(
      `tenaza: port ${port} is already in use by something that isn't Tenaza — try \`tenaza ui --port <n>\``,
    );
    return 1;
  }

  const ctx: DaemonContext = {
    home,
    token: generateDaemonToken(),
    clients: new Set(),
    logCache: createSessionLogCache(),
    resolveGitRoot: createCachingGitRootResolver(),
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    // `routes` claims "/" with the HTML import: Bun bundles the React
    // board and every asset it references — JS, CSS, the vendored Geist
    // woff2 files — straight into the `--compile` binary, no further
    // wiring here. `fetch` stays the fallback for everything `routes`
    // doesn't claim. `Bun.serve`'s own `idleTimeout` is left untouched
    // here — the fix for a long-lived connection is `eventsResponse`'s own
    // per-request `server.timeout(req, 0)`, never a server-wide setting,
    // since every other route on this server finishes instantly and has
    // no reason to opt out of the default.
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      routes: { "/": index },
      fetch: createFetchHandler(ctx),
    });
  } catch (error) {
    printErr(
      `tenaza: could not start the Daemon on port ${port} (${describeBindError(error)}) — try \`tenaza ui --port <n>\``,
    );
    return 1;
  }

  const boundPort = server.port ?? port;
  writeDaemonToken(home, ctx.token);
  writeAlive(home);
  const url = buildDaemonUrl(boundPort, ctx.token);

  const heartbeat = setInterval(() => writeAlive(home), heartbeatIntervalMs());
  const knownInboxIds = new Set(deriveInbox(home, ctx.logCache).map((row) => row.id));
  const watcher = startStateWatcher(home, ctx.clients, ctx.logCache, ctx.resolveGitRoot, () =>
    notifyUnnotifiedInboxItems(home, knownInboxIds, new Date(), ctx.logCache, boundPort),
  );

  shutdown = (): void => {
    clearInterval(heartbeat);
    watcher.stop();
    server.stop(true);
    clearDaemonFiles(home);
  };

  print(`tenaza: serving on ${url}`);
  if (shouldOpen) openBrowser(home, url);

  await shutdownRequested;
  return 0;
}
