import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Action } from "./contract/event";
import type { ActionSummary, BoardInboxItem, BoardPayload, BoardSession } from "./contract/live";
import { type InboxItem, deriveInbox } from "./inbox";
import { readAllSessionEvents } from "./log";
import {
  daemonAlivePath,
  daemonTokenPath,
  DEFAULT_DAEMON_PORT,
  humanLogPath,
  openRecorderPath,
  sessionsDir,
  tenazaHome,
} from "./paths";
import { loadPolicy } from "./policy";
import {
  UNKNOWN_PROJECT,
  buildSessionIndex,
  deriveProject,
  eventTypesBySession,
  isNoiseSession,
  type SessionNode,
} from "./sessions";
import { TENAZA_VERSION } from "./version";
import index from "./ui/index.html";

/** Re-exported from `paths.ts` (its real home — see that file's own doc comment on why) so every EXISTING caller that looks for it here, `tenaza ui`'s own default included, is unaffected. */
export { DEFAULT_DAEMON_PORT };

/** "rewritten every ~2 s" (ticket 07) — overridable via `TENAZA_HEARTBEAT_MS` so a test never waits 2 real seconds per assertion. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000;

/**
 * How stale a heartbeat has to read before a FUTURE reader (ticket 10's
 * live-answering hook) should treat the Daemon as gone — "heartbeat going
 * stale mid-wait → deny at once" (decision 06). Exposed here, in the one
 * place the heartbeat itself is written, so a later hook and this module
 * can never disagree on the threshold; ticket 07 writes the heartbeat and
 * defines this constant, but — "hooks never talk to it" — wires NOTHING to
 * it yet. 2.5x the write interval: generous enough that one slow tick under
 * load never reads as dead, tight enough to notice a genuinely gone process
 * within a few seconds.
 */
export const DEFAULT_HEARTBEAT_STALE_MS = 5000;

/** Overridable via `TENAZA_SSE_POLL_MS` (same reasoning as the heartbeat). */
export const DEFAULT_SSE_POLL_INTERVAL_MS = 500;

/** How long `GET /health` gets to answer before a second launch gives up and treats the port as free (ticket 07: a stale `daemon.alive`/`daemon.token` must not block a new launch — this is the OTHER half, a hung or absent listener). */
const PROBE_TIMEOUT_MS = 500;

/** The cookie a browser keeps once the page has seen a valid `?token=`. */
const TOKEN_COOKIE_NAME = "tenaza_token";

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function heartbeatIntervalMs(): number {
  return positiveIntFromEnv("TENAZA_HEARTBEAT_MS", DEFAULT_HEARTBEAT_INTERVAL_MS);
}

function ssePollIntervalMs(): number {
  return positiveIntFromEnv("TENAZA_SSE_POLL_MS", DEFAULT_SSE_POLL_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Heartbeat (state/daemon.alive)
// ---------------------------------------------------------------------------

/** Rewrite the heartbeat file with the current timestamp. Never throws — a failing write here must never crash the Daemon's own event loop. */
export function writeAlive(home: string, now: Date = new Date()): void {
  try {
    const file = daemonAlivePath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, now.toISOString(), "utf8");
  } catch {
    // See the doc comment above.
  }
}

/** The heartbeat's own timestamp, or `undefined` when absent or unreadable — never thrown. */
export function readAlive(home: string = tenazaHome()): Date | undefined {
  const file = daemonAlivePath(home);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = new Date(readFileSync(file, "utf8").trim());
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/** Pure: is the heartbeat read as fresh right now? Defined here for a future hook to call (ticket 10) — not called by anything in THIS ticket (decision 05: "hooks never talk to it"). */
export function isHeartbeatFresh(
  aliveAt: Date | undefined,
  now: Date,
  maxAgeMs: number = DEFAULT_HEARTBEAT_STALE_MS,
): boolean {
  if (!aliveAt) return false;
  return now.getTime() - aliveAt.getTime() <= maxAgeMs;
}

// ---------------------------------------------------------------------------
// Token (state/daemon.token)
// ---------------------------------------------------------------------------

/** A fresh random token, one per `tenaza ui` launch (decision 05) — not a security boundary (agents run as the same user), just honest mistake-proofing. */
export function generateDaemonToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Write the launch token, mode 0600 (ticket 07). `writeFileSync`'s own
 * `mode` option sets that on a FRESH file at creation (the common case: a
 * clean `clearDaemonFiles` leaves nothing behind) — but POSIX `open()`
 * ignores the `mode` argument when the path already exists, so a leftover
 * file from an earlier launch would otherwise keep whatever permission it
 * already had. `chmodSync` is the belt-and-suspenders for exactly that
 * stale-file case, not the normal path.
 */
export function writeDaemonToken(home: string, token: string): void {
  const file = daemonTokenPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const existedBefore = existsSync(file);
  writeFileSync(file, token, { mode: 0o600 });
  if (existedBefore) chmodSync(file, 0o600);
}

/** The CURRENT Daemon's token — whichever one is running, since there is only ever one `daemon.token` per `TENAZA_HOME` (the port is the lock, decision 05). `undefined` when no Daemon has ever written one, or the file can't be read. */
export function readDaemonToken(home: string = tenazaHome()): string | undefined {
  const file = daemonTokenPath(home);
  if (!existsSync(file)) return undefined;
  try {
    const token = readFileSync(file, "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

function removeIfExists(file: string): void {
  try {
    if (existsSync(file)) rmSync(file, { force: true });
  } catch {
    // Shutdown hygiene only — a failed cleanup must never stop the process from exiting.
  }
}

/** Clean shutdown hygiene (Ctrl-C): drop this launch's own alive/token files rather than leaving them to merely go stale. Never required for correctness — a crashed Daemon leaves the SAME files behind, and `probeExistingDaemon` below never trusts their mere presence either way — but tidier, and it closes the (harmless) window where a leftover token could still open a URL for a Daemon that already exited cleanly. */
export function clearDaemonFiles(home: string): void {
  removeIfExists(daemonAlivePath(home));
  removeIfExists(daemonTokenPath(home));
}

// ---------------------------------------------------------------------------
// The opener test seam (mirrors notify.ts's TENAZA_NOTIFY_RECORDER exactly)
// ---------------------------------------------------------------------------

function appendOpenRecorder(home: string, url: string): void {
  const file = openRecorderPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ url })}\n`, "utf8");
}

/** Read back every URL the opener seam captured, in order — the test oracle for "what would have been opened." */
export function readOpenRecorder(home: string = tenazaHome()): string[] {
  const file = openRecorderPath(home);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { url: string }).url);
}

/**
 * Open `url` in the human's browser — the ONLY function that decides HOW
 * (ticket 07's own "never actually open a browser in tests; make the
 * opener injectable/disabled"), same shape as `notify.ts`'s
 * `sendNotification`:
 *   - `TENAZA_OPEN_RECORDER` set → append to the recorder file instead of
 *     touching the OS at all.
 *   - unset → spawn the real `open <url>` (macOS).
 * Never throws — a failing opener must never fail the Daemon that just
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
    // See the doc comment above.
  }
}

// ---------------------------------------------------------------------------
// Derived state (what the SSE stream pushes)
// ---------------------------------------------------------------------------

/**
 * One Session's board row (ticket 08): resolved to a `project` and the
 * STRUCTURAL `role` server-side — `deriveProject` shells out to `git` and
 * can never ship to a browser bundle, and `role` here is deliberately NOT
 * `sessions.ts`'s own `roleOf` (which folds the `ticket` Label into the
 * fallback for the CLI's one compact line) — the board shows `ticket` and
 * `role` as separate fields, per the spec's own comma-separated list.
 * Everything else is a plain, time-independent fact; the board's pure
 * functions (`src/board.ts`) do the time-based classification against a
 * ticking clock.
 */
/** An `Action` (`contract/event.ts`), flattened to the `ActionSummary` shape the board's contract shares between an Inbox row's "tool + command" and a Session row's "last signal" — `command` only for a `shell` Action, same as `toBoardInboxItem`'s own previous inline version. */
function toActionSummary(action: Action): ActionSummary {
  return {
    kind: action.kind,
    tool: action.tool,
    command: action.kind === "shell" ? action.command : undefined,
  };
}

function toBoardSession(node: SessionNode): BoardSession {
  return {
    id: node.id,
    parentId: node.parent,
    project: deriveProject(node),
    ticket: node.labels.ticket,
    role: node.parent !== undefined ? "subagente" : "sesión",
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    lastEventTs: node.lastEventTs,
    hasMeasureCapability: node.capabilities.includes("measure"),
    contextTokens: node.contextTokens,
    lastSignal: node.lastAction ? toActionSummary(node.lastAction) : undefined,
  };
}

/** One pending Inbox item's board row — the owning Session's `project`/`ticket` resolved the SAME way a Session row's are, from the FULL (unfiltered) index: an Inbox item's own Session is never noise (it carries an `action.decided` Event, which `isNoiseSession` never matches), but resolving against the full index rather than the already-filtered list costs nothing and never depends on that happening to stay true. */
function toBoardInboxItem(row: InboxItem, fullIndex: ReadonlyMap<string, SessionNode>): BoardInboxItem {
  const session = fullIndex.get(row.session);
  return {
    id: row.id,
    sessionId: row.session,
    project: session ? deriveProject(session) : UNKNOWN_PROJECT,
    ticket: session?.labels.ticket,
    ts: row.ts,
    action: toActionSummary(row.action),
    blocked: row.blocked,
  };
}

/**
 * The Live surface's own payload (ticket 08, decision 04) — what `/events`
 * pushes, and the ONE shape `src/contract/live.ts` and the React client
 * agree on. Sessions and the Inbox, derived from the logs exactly like
 * `status` does — nothing kept beside them (ADR 0002) — minus the SAME
 * noise `renderSessionTree` already hides (`isNoiseSession`, reused here
 * rather than re-derived, so the board and `tenaza status` can never show
 * a different Session count for the same logs), plus the Policy numbers
 * (`stallMinutes`, `contextThresholdTokens`) the client's pure functions
 * need and must never hardcode a second copy of.
 */
export function buildBoardPayload(home: string): BoardPayload {
  const events = readAllSessionEvents(home);
  const fullIndex = buildSessionIndex(events);
  const eventTypes = eventTypesBySession(events);
  const visibleSessions = [...fullIndex.values()].filter(
    (node) => !isNoiseSession(eventTypes.get(node.id) ?? new Set()),
  );
  const policy = loadPolicy(home);

  return {
    v: 1,
    policy: { stallMinutes: policy.stallMinutes, contextThresholdTokens: policy.thresholdTokens },
    sessions: visibleSessions.map(toBoardSession),
    inbox: deriveInbox(home).map((row) => toBoardInboxItem(row, fullIndex)),
  };
}

/**
 * A cheap signature of everything the derived state above could possibly
 * depend on — every Session's own `*.jsonl` log (name/size/mtime) plus the
 * human log's own, the SAME files `buildBoardPayload` actually reads — so
 * the watcher below can tell "nothing changed" from "something did" WITHOUT
 * recomputing the (more expensive) derived state on every tick.
 *
 * Deliberately excludes `<session>.toolcalls` (orchestrator review): that
 * counter lives beside a Session's log (`paths.ts`'s own `sessionsDir`) and
 * is bumped on EVERY `PostToolUse` call (`toolcalls.ts`), not just the ones
 * that change derived state — `buildBoardPayload` never reads it at all
 * (only a `usage.sampled` Event, written on every 25th call, feeds the
 * context bar). Including it here would make nearly every tick under
 * ordinary tool-call traffic recompute and (absent the payload check
 * below) push a state that provably cannot have changed — the "transitions,
 * not calls" rule this signature exists to uphold.
 */
function computeStateSignature(home: string): string {
  const parts: string[] = [];
  const dir = sessionsDir(home);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".jsonl")).sort()) {
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
 * The state watcher (ticket 07): POLLING `~/.tenaza/state/`, not
 * `fs.watch`. Decided and justified, not defaulted to:
 *   - `fs.watch` has no portable recursive mode (Linux lacks `recursive`
 *     entirely; macOS's FSEvents-backed one is known to coalesce, reorder,
 *     or occasionally miss rapid successive writes to the same file —
 *     exactly the shape of two parallel hooks appending to one Session's
 *     log in the same instant, the case this project already has a
 *     regression fixture for elsewhere).
 *   - A cheap stat-based signature, polled on a fixed interval, degrades
 *     predictably instead: worst case it adds one interval's latency, never
 *     a missed or duplicated event, and it is identical code on every OS
 *     Bun targets.
 *   - Polling also coalesces bursts FOR FREE (ticket 07's own "coalesce
 *     bursts" requirement): several writes inside one interval collapse
 *     into the single recompute-and-push that interval's tick does, with no
 *     separate debounce timer to get wrong.
 * The one-time cost: up to one poll interval of latency between a write and
 * the SSE push. `TENAZA_SSE_POLL_MS` shortens that for tests; production
 * keeps the default.
 */
export function startStateWatcher(home: string, clients: Set<SseController>): { stop(): void } {
  let lastSignature: string | undefined;
  let lastPayload: string | undefined;

  const tick = (): void => {
    try {
      const signature = computeStateSignature(home);
      if (signature === lastSignature) return;
      lastSignature = signature;

      // The stat signature changing is necessary, not sufficient: a usage
      // sample that leaves the context bar's own number unchanged, or a
      // torn line `readLogTolerant` skips either way (ADR 0007), can still
      // move an mtime/size without moving the DERIVED value a client would
      // ever see. Comparing the actual serialized payload — not just the
      // stat signature — is what makes this push on "a change your client
      // could observe," never on "a tick where some file's mtime moved."
      const payload = JSON.stringify(buildBoardPayload(home));
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
      // A watcher tick must never crash the Daemon's own process.
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

/** Pull `tenaza_token` out of a `Cookie` header, if present. */
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
 * Does this request carry the Daemon's own current token — as the cookie a
 * prior page load already set, or (first load / a bare curl / a STALE
 * cookie from a previous launch) the `?token=` query parameter? The token
 * rotates every launch (decision 05: "a random token per Daemon launch"),
 * so a browser tab left open across a restart carries a cookie that no
 * longer matches — that must fall through to the query form rather than
 * fail outright, exactly like no cookie at all. A bare request with
 * neither is unauthorized (ticket 07's own "bare request → 403"). Not a
 * security boundary (decision 05: agents run as the same user as the
 * Daemon) — a plain string compare is enough.
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
}

function healthResponse(): Response {
  return Response.json({ tenaza: true, version: TENAZA_VERSION });
}

/**
 * `GET /auth?token=` (ticket 08 fix) — the ONE route a browser load now
 * carries the token in the URL for. `Bun.serve`'s `routes` table claims
 * `/` entirely for the static bundled page (decision 05's "open read, no
 * token" still holds for it), which left no per-request handler free to
 * set the HttpOnly cookie ticket 07's placeholder `indexResponse` used to
 * set inline — the regression this ticket shipped instead was a
 * CLIENT-SIDE `document.cookie` write from `main.tsx`, which can never be
 * HttpOnly, has no server-side check at all, and leaves the token sitting
 * in the URL the user's tab keeps. This route restores the server-side
 * shape: validate the token against THIS launch's own (never trust the
 * query blindly), set the SAME `HttpOnly; SameSite=Strict; Path=/` cookie
 * `indexResponse` used to, then 302 the browser on to the plain `/` — the
 * token never lingers in the address bar the human actually lands on. An
 * invalid or missing token sets no cookie and answers 401, never falling
 * through to the page: there is no path through this function that redirects
 * without having just set a correct cookie.
 */
function authResponse(ctx: DaemonContext, url: URL): Response {
  if (url.searchParams.get("token") !== ctx.token) {
    return new Response("unauthorized\n", { status: 401 });
  }
  const headers = new Headers({ location: "/" });
  // `Strict`, not `Lax` — same reasoning `indexResponse` carried: the
  // deny-by-default gate covers GET on every non-read path too, so a
  // `Lax` cookie (sent on a cross-site top-level GET navigation) would
  // hand an attacker-controlled page the same cookie a legitimate
  // same-site GET gets.
  headers.append("set-cookie", `${TOKEN_COOKIE_NAME}=${ctx.token}; HttpOnly; SameSite=Strict; Path=/`);
  return new Response(null, { status: 302, headers });
}

/** `GET /events` — an open read: the SSE stream, no token required. Pushes the current derived state immediately on connect, then whatever `startStateWatcher` enqueues later. */
function eventsResponse(ctx: DaemonContext): Response {
  let thisController: SseController | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      thisController = controller;
      ctx.clients.add(controller);
      controller.enqueue(encodeSseEvent(buildBoardPayload(ctx.home)));
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

/**
 * The Daemon's routing table for everything `routes` (below) doesn't claim
 * (ticket 07, narrowed by ticket 08). `GET /` moved OFF this fetch handler
 * and onto `Bun.serve`'s own `routes` table — the bundled React page is a
 * static HTML-import route now, which is what gives it (and every asset it
 * references) Bun's automatic bundling AND, per decision 05, the SAME "open
 * read, no token" treatment every other static route gets for free: there
 * is no per-request logic a static route could skip, unlike the old
 * `indexResponse` it replaces. `GET /health`, `GET /events` and `GET /auth`
 * are the only OPEN reads still answered HERE — `/auth` validates the
 * token itself, so it cannot sit behind the token gate below. Everything
 * else — any other path, any non-GET method, including every write route
 * tickets 09-11 will add (`run`, `done`, `dismiss`, answer, focus) — is
 * DENIED BY DEFAULT unless it carries the token: no route is individually
 * wrapped in a check it might one day be written without, because there is
 * no path to "write" here that skips this `else` branch at all. Ticket 07
 * itself defines no concrete write route yet (the resolve/answer/focus
 * routes are tickets 09-11's own job) — proven instead by hitting this
 * same default against an arbitrary path: 403 without the token, falling
 * through to a plain 404 with it, which is exactly what a real write route
 * will see too once one exists.
 */
export function createFetchHandler(ctx: DaemonContext): (req: Request) => Response {
  return (req: Request): Response => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") return healthResponse();
    if (req.method === "GET" && url.pathname === "/events") return eventsResponse(ctx);
    if (req.method === "GET" && url.pathname === "/auth") return authResponse(ctx, url);

    if (!isAuthorizedRequest(req, ctx.token)) {
      return new Response("forbidden\n", { status: 403 });
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
 * Identify whether a Tenaza is ALREADY serving on `port` by its `/health`
 * RESPONSE — never by the port merely being busy (ticket 07's own
 * distinction): a stale `daemon.alive`/`daemon.token` from a crashed Daemon
 * is never consulted here, so it can never block a new launch either. Three
 * outcomes: a live Tenaza (`"tenaza"`), something else answering on that
 * port (`"other"`, e.g. another dev server) — or nothing answering at all
 * (`"free"`, including a hung non-HTTP listener that a short timeout gives
 * up on exactly like a refused connection).
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

/**
 * The URL the launcher opens (ticket 08 fix) — `/auth?token=`, not `/?token=`:
 * `/auth` is the ONE route that still validates the token and sets the
 * cookie server-side (`authResponse`, above); landing straight on `/` with
 * the token would skip that entirely, which is exactly the regression this
 * ticket's own `bootstrapTokenCookie` reintroduced. No token to carry (the
 * `readDaemonToken` miss case) → open the plain page directly, since there
 * is nothing for `/auth` to validate.
 */
export function buildDaemonUrl(port: number, token: string | undefined): string {
  const origin = `http://127.0.0.1:${port}`;
  return token ? `${origin}/auth?token=${token}` : `${origin}/`;
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
}

/** Writes straight to process.stdout/stderr, same as every other command in `cli.ts` — tests observe this at the real black-box seam (spawn the CLI, read its stdout), never by importing this module's internals. */
function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * `tenaza ui` (ticket 07): serve the Daemon on `--port` (default 4747) until
 * Ctrl-C. Single instance first (the port is the lock, decision 05): a
 * Tenaza already there is opened, not duplicated; a non-Tenaza holder — or
 * a genuine bind race — gets a clear message, never a raw `EADDRINUSE`
 * (ticket 07's own AC).
 */
export async function runUi(options: RunUiOptions = {}): Promise<number> {
  const home = options.home ?? tenazaHome();
  const port = options.port ?? DEFAULT_DAEMON_PORT;

  /**
   * Register SIGINT/SIGTERM as the very FIRST thing this function does —
   * well before the bind, let alone the startup line a caller might be
   * waiting on. This is deliberate, not incidental ordering: a process
   * that prints "serving on ..." and is signaled within the SAME instant
   * (exactly what a test driving this over a pipe does, the instant it
   * sees that line) can still take the runtime's OWN default
   * signal-terminates-the-process disposition — exit 130, not "Ctrl-C
   * stops it" (ticket 07's own words) — if the OS-level signal watcher
   * underneath `process.on` hasn't finished wiring up yet (observed
   * directly: registering right before the `await` below raced and lost
   * to an immediate `kill -INT` about half the time; registering here,
   * first, gave the runtime's signal plumbing the whole probe+bind
   * sequence's worth of wall-clock time to settle, and it never raced
   * again). `shutdown` starts as a no-op and is replaced once there is
   * something real to tear down — a signal before that point (impossible
   * in practice; probing + binding is near-instant) would simply resolve
   * immediately with nothing to clean up yet.
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
    openBrowser(home, url);
    return 0;
  }
  if (probe.kind === "other") {
    printErr(
      `tenaza: port ${port} is already in use by something that isn't Tenaza — try \`tenaza ui --port <n>\``,
    );
    return 1;
  }

  const ctx: DaemonContext = { home, token: generateDaemonToken(), clients: new Set() };

  let server: ReturnType<typeof Bun.serve>;
  try {
    // `routes` claims "/" with the HTML import (ticket 08): Bun bundles the
    // React board and every asset it references — JS, CSS, the vendored
    // Geist woff2 files — and serves them, embedded straight into the
    // `--compile` binary, with no further wiring here. `fetch` stays the
    // fallback for everything `routes` doesn't claim (health, events, and
    // every write route tickets 09-11 add).
    server = Bun.serve({ port, hostname: "127.0.0.1", routes: { "/": index }, fetch: createFetchHandler(ctx) });
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
  const watcher = startStateWatcher(home, ctx.clients);

  shutdown = (): void => {
    clearInterval(heartbeat);
    watcher.stop();
    server.stop(true);
    clearDaemonFiles(home);
  };

  print(`tenaza: serving on ${url}`);
  openBrowser(home, url);

  await shutdownRequested;
  return 0;
}
