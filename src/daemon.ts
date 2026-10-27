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
  createCachingGitRootResolver,
  deriveProject,
  eventTypesBySession,
  isArchived,
  isNoiseSession,
  latestArchiveTimestamps,
  nativeWaitFor,
  readTouchedTimestamps,
  UnknownSessionError,
  type SessionNode,
} from "./sessions";
import { detectRow, planFocus, reachFor, resolveTmuxOuterLive, type LiveFacts } from "./terminals";
import { TENAZA_VERSION } from "./version";
import index from "./ui/index.html";

/** Re-exported from `paths.ts` (its real home — see that file's own doc comment on why) so every EXISTING caller that looks for it here, `tenaza ui`'s own default included, is unaffected. */
export { DEFAULT_DAEMON_PORT };

/**
 * Re-exported from `daemonlink.ts` (its real home, as of ticket 10 — see
 * that module's own doc comment on why the heartbeat/token surface moved
 * out of this file) so every EXISTING caller that looked for them HERE
 * (ticket 07's own tests included) is unaffected.
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

/**
 * Ticket 11: this Session's own static terminal reach — "a subagent's card
 * focuses its PARENT's terminal" (spec) resolved HERE, against the FULL
 * (unfiltered) index, since a subagent's own `session.started` never
 * carries a `terminal` field at all (`adapters/claude.ts`'s
 * `handleSubagentStart`). `fullIndex` is the SAME index `buildBoardPayload`
 * already built for `toBoardInboxItem`'s own project/ticket lookup — never
 * a second rebuild.
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

function toBoardSession(
  node: SessionNode,
  resolutions: ReadonlyMap<string, ResolutionTraceEntry[]>,
  fullIndex: ReadonlyMap<string, SessionNode>,
  resolveGitRoot?: (cwd: string) => string | undefined,
): BoardSession {
  const terminal = terminalInfoFor(node, fullIndex);
  return {
    id: node.id,
    parentId: node.parent,
    project: deriveProject(node, resolveGitRoot),
    ticket: node.labels.ticket,
    role: node.parent !== undefined ? "subagente" : "sesión",
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    lastEventTs: node.lastEventTs,
    hasMeasureCapability: node.capabilities.includes("measure"),
    contextTokens: node.contextTokens,
    lastSignal: node.lastAction ? toActionSummary(node.lastAction) : undefined,
    // Ticket 10: newest-first, already derived (`deriveResolutionTraceBySession`) — never re-sorted or re-filtered here.
    resolutions: resolutions.get(node.id) ?? [],
    terminalReach: terminal.reach,
    terminalAppLabel: terminal.appLabel,
    terminalNeedsTcc: terminal.needsTcc,
    // Ticket 14: `node.lastEventTs` here already carries `buildBoardPayload`'s
    // own touched-file merge (below) — `nativeWaitFor` reads it to tell a
    // CURRENT native wait apart from a stale one any later activity, ordinary
    // tool calls included, already superseded.
    nativeWait: nativeWaitFor(node),
  };
}

/** One pending Inbox item's board row — the owning Session's `project`/`ticket` resolved the SAME way a Session row's are, from the FULL (unfiltered) index: an Inbox item's own Session is never noise (it carries an `action.decided` Event, which `isNoiseSession` never matches), but resolving against the full index rather than the already-filtered list costs nothing and never depends on that happening to stay true. */
function toBoardInboxItem(
  row: InboxItem,
  fullIndex: ReadonlyMap<string, SessionNode>,
  resolveGitRoot?: (cwd: string) => string | undefined,
): BoardInboxItem {
  const session = fullIndex.get(row.session);
  // Ticket 11: "from any card" (spec) — resolved from the OWNING Session,
  // same convention `project`/`ticket` already use on this row. A Session
  // this payload has never observed at all (should not happen — an Inbox
  // item's own Session always carries at least its `action.decided` Event)
  // degrades to "unknown," never a crash.
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
 * The Live surface's own payload (ticket 08, decision 04) — what `/events`
 * pushes, and the ONE shape `src/contract/live.ts` and the React client
 * agree on. Sessions and the Inbox, derived from the logs exactly like
 * `status` does — nothing kept beside them (ADR 0002) — minus the SAME
 * noise `renderSessionTree` already hides (`isNoiseSession`, reused here
 * rather than re-derived, so the board and `tenaza status` can never show
 * a different Session count for the same logs), plus the Policy numbers
 * (`stallMinutes`, `contextThresholdTokens`) the client's pure functions
 * need and must never hardcode a second copy of.
 *
 * `cache` and `resolveGitRoot` (ticket 13, criterion 3) are BOTH OPTIONAL
 * and change nothing about the VALUE returned — only how cheaply it gets
 * there. Omitted (every caller before this ticket, and every test that
 * calls this directly), every Session log is read and parsed fresh and
 * every Session's project is resolved with its own fresh `git` spawn,
 * exactly as before. Passed (only `startStateWatcher`'s own tick and
 * `eventsResponse`'s connect-time push, both via `DaemonContext`), a
 * Session log whose (mtime, size) hasn't moved since `cache` last saw it is
 * never re-read, and a `cwd` `resolveGitRoot` has already resolved is never
 * spawned twice — proven byte-identical to the fully-uncached path by this
 * ticket's own differential tests (`test/daemon.test.ts`). `resolveGitRoot`
 * turned out to be where the MEASURED ~440 ms at real scale actually came
 * from (not the log reads `cache` alone addresses — see
 * `createCachingGitRootResolver`'s own doc comment in `sessions.ts`).
 */
export function buildBoardPayload(
  home: string,
  cache?: SessionLogCache,
  resolveGitRoot?: (cwd: string) => string | undefined,
): BoardPayload {
  const events = cache ? readAllSessionEventsCached(home, cache).events : readAllSessionEvents(home);
  const fullIndex = buildSessionIndex(events);
  // Ticket 14 (AC3): fold each Session's own "last ordinary activity" touch
  // (`toolcalls.ts`'s `touchSession`, bumped on every PreToolUse/PostToolUse/
  // Stop call, matched or not — never an Event) into its `lastEventTs` here,
  // the ONE place the Event-sourced timeline and this file-sourced signal
  // ever merge. `buildSessionIndex` itself stays a pure function of
  // `Event[]` — it has no reason to know `.touched` files exist at all.
  // This is also what lets `nativeWaitFor` (`toBoardSession`, below) tell a
  // CURRENT native prompt apart from one any later ordinary activity has
  // already superseded, with no second Event ever written for that
  // transition.
  const touchedAt = readTouchedTimestamps(home);
  for (const node of fullIndex.values()) {
    const touched = touchedAt.get(node.id);
    if (touched && (!node.lastEventTs || touched > node.lastEventTs)) node.lastEventTs = touched;
  }
  const eventTypes = eventTypesBySession(events);
  // Ticket 11: an archived Session's card is hidden from the BOARD alone
  // (never `tenaza status` — `sessions.ts`'s `isArchived` doc) — filtered
  // the SAME way noise already is, so a card that was both noise AND
  // somehow archived (should never happen — noise carries no
  // `action.decided` match, let alone an ended state to archive) is still
  // dropped exactly once.
  //
  // Orchestrator review, 2026-10-27: NEVER a permanent Set of ever-archived
  // ids — `isArchived` re-judges each node's OWN `lastEventTs` against its
  // latest archive ts on every read, so a Session resumed after being
  // archived (a fresh SessionStart/tool Event landing later) comes straight
  // back the next time this is computed, exactly like every other
  // time-based classification here (TIME IS STATE).
  const archivedAt = latestArchiveTimestamps(home);
  const visibleSessions = [...fullIndex.values()].filter(
    (node) =>
      !isNoiseSession(eventTypes.get(node.id) ?? new Set(), node.endedReason) &&
      !isArchived(archivedAt.get(node.id), node.lastEventTs),
  );
  const policy = loadPolicy(home);
  const resolutions = deriveResolutionTraceBySession(home);

  return {
    v: 1,
    policy: {
      stallMinutes: policy.stallMinutes,
      contextThresholdTokens: policy.thresholdTokens,
      waitSeconds: effectiveWaitSeconds(policy),
    },
    sessions: visibleSessions.map((node) => toBoardSession(node, resolutions, fullIndex, resolveGitRoot)),
    inbox: deriveInbox(home, cache).map((row) => toBoardInboxItem(row, fullIndex, resolveGitRoot)),
  };
}

/**
 * A cheap signature of everything the derived state above could possibly
 * depend on — every Session's own `*.jsonl` log (name/size/mtime) plus the
 * human log's own, the SAME files `buildBoardPayload` actually reads — so
 * the watcher below can tell "nothing changed" from "something did" WITHOUT
 * recomputing the (more expensive) derived state on every tick.
 *
 * `*.touched` (ticket 14) is included for exactly the opposite reason
 * `<session>.toolcalls` stays excluded below: `buildBoardPayload` NOW reads
 * it (the touched-file merge, above) — it is a real input to the derived
 * state, so leaving it out of this signature would mean an ordinary tool
 * call's own touch could bump `lastEventTs` on disk and the watcher would
 * never notice, silently reintroducing the exact "busy agent reads frozen"
 * gap AC3 exists to close. This is still "transitions, not calls": the
 * payload-equality check below (`startStateWatcher`) still coalesces every
 * touch inside one poll interval into at most one push, the SAME free
 * coalescing every other file change here already gets — nothing here
 * pushes PER call, only per POLL TICK that found something the last push
 * didn't already carry.
 *
 * Deliberately excludes `<session>.toolcalls` (orchestrator review,
 * unchanged by ticket 14): that counter lives beside a Session's log
 * (`paths.ts`'s own `sessionsDir`) and is bumped on EVERY `PostToolUse`
 * call (`toolcalls.ts`), not just the ones that change derived state —
 * `buildBoardPayload` never reads IT at all (only a `usage.sampled` Event,
 * written on every 25th call, feeds the context bar; the NEW `.touched`
 * signal above is a SEPARATE file with a SEPARATE writer, serving a
 * SEPARATE purpose). Including `.toolcalls` here would still make nearly
 * every tick under ordinary tool-call traffic recompute for a value that
 * provably cannot have changed — the "transitions, not calls" rule this
 * signature exists to uphold, for THAT file specifically.
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
 *
 * `cache` and `resolveGitRoot` (ticket 13, criterion 3): the Daemon's own
 * per-process log cache and git-root memoization (`DaemonContext.logCache`
 * / `.resolveGitRoot`), both threaded into `buildBoardPayload` so a tick
 * never pays to re-read-and-reparse a Session log that didn't change, or
 * re-spawn `git` for a `cwd` it already resolved — the measured ~440 ms
 * cost at 1165 Sessions (profiling found the SECOND one, not the first,
 * was where almost all of it actually went — see `buildBoardPayload`'s own
 * doc comment) that grew with total history regardless of how little
 * actually changed. Both optional only so a caller without them still gets
 * the pre-ticket-13 behavior byte-for-byte; `runUi` below always has both
 * to pass.
 */
export function startStateWatcher(
  home: string,
  clients: Set<SseController>,
  cache?: SessionLogCache,
  resolveGitRoot?: (cwd: string) => string | undefined,
): { stop(): void } {
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
  /** Ticket 13: this Daemon's own per-process log cache, warmed across every connect-time push and watcher tick alike — see `buildBoardPayload`'s own doc comment. */
  logCache: SessionLogCache;
  /** Ticket 13, criterion 3: this Daemon's own per-process `cwd → git root` memoization (`sessions.ts`'s `createCachingGitRootResolver`) — the ACTUAL measured cause of the per-tick cost, never invalidated within one Daemon's run. */
  resolveGitRoot: (cwd: string) => string | undefined;
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

/**
 * `GET /events` — an open read: the SSE stream, no token required. Pushes
 * the current derived state immediately on connect, then whatever
 * `startStateWatcher` enqueues later.
 *
 * `server.timeout(req, 0)` (ticket 13, criterion 2): disables `Bun.serve`'s
 * own idle timeout for THIS request's connection — "reset the idle timeout
 * … `0` means no timeout," confirmed against the installed Bun version
 * (1.4.3) both in its own type declarations (`serve.d.ts`) and empirically.
 * The measured cause was that idle timeout (its documented default is 10 s;
 * a quiet `/events` connection — nothing written between board changes —
 * dropped at ~10–12 s every time this was probed). An SSE comment keepalive
 * was tried FIRST and discarded: on THIS Daemon's exact `Bun.serve` shape —
 * `routes` claiming `/` alongside `fetch` handling everything else — a
 * periodic write to the stream controller did NOT reset the per-connection
 * idle clock the way it does on a `fetch`-only server (confirmed
 * empirically: a comment every 150 ms still dropped at the SAME ~4 s a
 * silent stream did, with `idleTimeout` shortened for the probe). The
 * per-request override is the mechanism that actually works for this
 * server's shape, so it is the only one shipped — see the ticket's own
 * report for the full probe. `clients.delete` on `cancel()`/a failed
 * `enqueue()` is unaffected: a connection that genuinely closes (the
 * browser tab, a network drop the OS eventually notices) is still cleaned
 * up the same way; only the SERVER-INITIATED idle drop is gone.
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
// Write routes (ticket 09): resolve a pending Inbox item from the view
// ---------------------------------------------------------------------------

/** `POST /items/<id>/run|done|dismiss|answer` (ticket 09 shipped the first three; ticket 10 adds `answer`) — ticket 11 adds its own paths alongside this one ONLY if they share this exact `/items/<id>/…` shape, never by widening this pattern. `id` is the item's FULL identity hash (ADR 0005) — the board's own contract (`contract/live.ts`) never carries anything shorter, so the view has no prefix to resolve. */
const ITEM_ACTION_PATTERN = /^\/items\/([0-9a-f]{4,64})\/(run|done|dismiss|answer)$/;

/** A refusal `startInboxItemRunStream` reported WITHOUT ever spawning anything — translated to a client error the view can show inline, never a 200 with no content. `already-resolved`/`unblockable`/`not-runnable` are all "this item's own state forbids it" (409); `no-cwd`/`cwd-missing` are "Tenaza cannot resolve where to run it" (422) — distinct enough from a plain conflict to point the human at a different fix (the stored command itself, printed back, same as the CLI's own refusal messages). */
function runRefusalResponse(refusal: RunRefusal): Response {
  if (refusal.kind === "no-cwd" || refusal.kind === "cwd-missing") {
    return Response.json({ error: refusal.kind, ...refusal }, { status: 422 });
  }
  return Response.json({ error: refusal.kind }, { status: 409 });
}

/** Review fix: spawning the shell itself threw (`startInboxItemRunStream`'s own try/catch) — 500, with the raw message, rather than an uncaught exception reaching `Bun.serve`'s own generic (message-less) error response. */
function spawnFailedResponse(message: string): Response {
  return Response.json({ error: "spawn-failed", message }, { status: 500 });
}

/**
 * `POST /items/<id>/run` (decisions 05, 06, ticket 09): start the item's
 * stored command through the view's own streaming run
 * (`startInboxItemRunStream`, `resolve.ts`) and hand its `ReadableStream`
 * straight back as the response body — chunked, so the card can render
 * output as it arrives rather than waiting for the whole run to finish.
 * `content-type: text/plain` deliberately: this is raw combined
 * stdout+stderr, never a structured envelope — the run's own outcome
 * (closed as `done`, or left open) is never carried IN this response at
 * all; it is derived from the Inbox exactly like every other resolution
 * (ADR 0002), which is what lets the board's OWN `/events` SSE be the one
 * place a client ever needs to check for it, the instant the stream here
 * ends.
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

/** `POST /items/<id>/done|dismiss`: close the item by hand, exactly as the CLI's own `done`/`dismiss` do (`resolveInboxItem`, unchanged from ticket 06) — never executes anything. */
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
 * `POST /items/<id>/answer` (ticket 10, decision 06): the ONE write route
 * the browser's own TE ESPERA card ever posts to — appending the human's
 * raw answer (`postLiveAnswer`, `resolve.ts`) for the item's own HELD hook
 * to read back and act on. This route never closes the item itself, and
 * never touches the agent's own call — it only records what the human
 * said. A malformed body (no valid JSON, or `answer` not exactly
 * `"approve"`/`"reject"`) is a plain 400, never a 500 or a silent accept; a
 * refusal `postLiveAnswer` reports WITHOUT writing anything (already
 * resolved, or no longer live) is a 409 — the SAME "this item's own state
 * forbids it" shape `runRefusalResponse` already uses for `run`.
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

/** Dispatch one `/items/<id>/<action>` write — `undefined` when `pathname` doesn't even match the shape, so the caller falls through to the SAME bare 404 any other unrecognized path already gets. */
async function itemActionResponse(ctx: DaemonContext, pathname: string, req: Request): Promise<Response | undefined> {
  const match = ITEM_ACTION_PATTERN.exec(pathname);
  if (!match) return undefined;
  const [, id, action] = match as unknown as [string, string, "run" | "done" | "dismiss" | "answer"];

  if (action === "run") return runItemResponse(ctx, id);
  if (action === "answer") return answerItemResponse(ctx, id, req);
  return resolveItemResponse(ctx, id, action === "done" ? "done" : "dismissed");
}

// ---------------------------------------------------------------------------
// Write routes (ticket 11): go to the agent's terminal + archive a card.
// Neither shares `ITEM_ACTION_PATTERN`'s `/items/<id>/…` shape (`fence.ts`'s
// own doc comment on why), so they get their own pattern and dispatcher.
// ---------------------------------------------------------------------------

/** `id` here is a SESSION id (Claude Code's own `session_id`/`agent_id`) — never an Inbox item's hash, and never constrained to a hex shape the way `ITEM_ACTION_PATTERN` is, since a runtime's own session ids are opaque strings this project does not define. */
const SESSION_ACTION_PATTERN = /^\/sessions\/([^/]+)\/(focus|archive)$/;

/**
 * This Session's own locator (or, for a subagent, its PARENT's — "a
 * subagent's card focuses its parent's terminal," spec) — resolved against
 * the FULL cross-Session index, exactly like `toBoardSession`'s own
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
 * `POST /sessions/<id>/focus` (decision 09, ticket 11): the Daemon runs the
 * focus command ONLY on this click — never on its own (spec's own
 * "never," ADR 0007's whole "Tenaza running any command on its own
 * initiative" being out of scope). Resolves the live tmux outer app HERE,
 * server-side, the one place a real process can be spawned — `planFocus`
 * itself stays pure and never does. Fire-and-forget past that point, same
 * shape every other port in this project already has: a failing or
 * partial focus (the exact step failed, only the app raised) is never
 * worse than before this ticket existed, so this always answers `{ ok:
 * true }` once a plan was built at all; `level` rides along for the
 * human's own curiosity, never asserted on by the view.
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

/** A refusal `archiveSession` reported WITHOUT appending anything — "this Session's own state forbids it" (409), the same shape `runRefusalResponse`/`resolveItemResponse` already use for an Inbox item. */
function archiveRefusalResponse(refusal: ArchiveRefusal): Response {
  return Response.json({ error: refusal.kind }, { status: 409 });
}

/** `POST /sessions/<id>/archive` (ticket 11, added 2026-10-27): the human's `x`/archivar click on a TERMINÓ card. Idempotent — a repeat archive still 200s (`alreadyArchived: true`), same convention `/items/<id>/done` already follows. */
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
 * The Daemon's routing table for everything `routes` (below) doesn't claim
 * (ticket 07, narrowed by ticket 08, extended by ticket 09). `GET /` moved
 * OFF this fetch handler and onto `Bun.serve`'s own `routes` table — the
 * bundled React page is a static HTML-import route now, which is what
 * gives it (and every asset it references) Bun's automatic bundling AND,
 * per decision 05, the SAME "open read, no token" treatment every other
 * static route gets for free: there is no per-request logic a static route
 * could skip, unlike the old `indexResponse` it replaces. `GET /health`,
 * `GET /events` and `GET /auth` are the only OPEN reads still answered
 * HERE — `/auth` validates the token itself, so it cannot sit behind the
 * token gate below. Everything else — any other path, any non-GET method,
 * including every write route ticket 09 (`run`, `done`, `dismiss`), ticket
 * 10 (`answer`) and ticket 11 (`/sessions/<id>/focus`, `/sessions/<id>/archive`
 * — their own pattern, never nested under `/items/`) add — is DENIED BY
 * DEFAULT unless it carries the token: `itemActionResponse` and
 * `sessionActionResponse` are called only AFTER that gate, never wrapped
 * around any route individually, so there is no path to "write" here that
 * could ever be written without it.
 *
 * Takes `server` as the handler's own second parameter (`Bun.serve`'s own
 * shape — `fetch(req, server)`) ONLY so `/events` can call
 * `server.timeout(req, 0)` (ticket 13, criterion 2) — no other route needs
 * it.
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

  const ctx: DaemonContext = {
    home,
    token: generateDaemonToken(),
    clients: new Set(),
    logCache: createSessionLogCache(),
    resolveGitRoot: createCachingGitRootResolver(),
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    // `routes` claims "/" with the HTML import (ticket 08): Bun bundles the
    // React board and every asset it references — JS, CSS, the vendored
    // Geist woff2 files — and serves them, embedded straight into the
    // `--compile` binary, with no further wiring here. `fetch` stays the
    // fallback for everything `routes` doesn't claim (health, events, and
    // every write route tickets 09-11 add). `Bun.serve`'s own `idleTimeout`
    // (default 10s) is left untouched here — ticket 13, criterion 2's fix
    // is `eventsResponse`'s own per-request `server.timeout(req, 0)`,
    // never a server-wide setting, since every OTHER route on this server
    // is a plain request/response that finishes instantly and has no
    // reason to opt out of the default.
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
  const watcher = startStateWatcher(home, ctx.clients, ctx.logCache, ctx.resolveGitRoot);

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
