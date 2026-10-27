import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { type Event, EventSchema } from "./contract/event";
import { humanLogPath, sessionLogPath, sessionsDir, tenazaHome } from "./paths";

/**
 * True when `file` exists and its content does NOT already end in a
 * newline — a torn tail left by a process that died mid-write (ADR 0007,
 * H1's own side finding: the next append glued onto a fragment like this,
 * corrupting it further).
 */
function endsWithoutNewline(file: string): boolean {
  if (!existsSync(file)) return false;
  const content = readFileSync(file, "utf8");
  return content.length > 0 && !content.endsWith("\n");
}

/**
 * Append one Event to a log file, creating its directory on first write. A
 * file left mid-line by a crashed process gets a newline prepended first,
 * so this append lands on its OWN line instead of gluing onto that torn
 * tail (ADR 0007, ticket 01).
 */
function appendToLog(file: string, event: Event): void {
  const validated = EventSchema.parse(event);
  mkdirSync(path.dirname(file), { recursive: true });
  const prefix = endsWithoutNewline(file) ? "\n" : "";
  appendFileSync(file, `${prefix}${JSON.stringify(validated)}\n`, "utf8");
}

/** How many non-blank lines `content` holds — the line-numbering unit `appendEventAtLine` and `readLogWithLinesTolerant` both key off (ADR 0005, ticket 06). */
function countNonBlankLines(content: string): number {
  let count = 0;
  for (const raw of content.split("\n")) {
    if (raw.trim().length > 0) count += 1;
  }
  return count;
}

/**
 * Append one Event to its Session's own log and report the exact LINE it
 * landed on (1-indexed, among non-blank lines) — the half of an Inbox
 * item's identity (decision 03, ADR 0005) this module alone can answer,
 * since only the write itself knows where it truly landed.
 *
 * "No lock" (the ticket's own constraint) rules out the obvious shortcut —
 * read the current line count, then append, then report count+1 — because
 * that is TWO separate operations with a gap between them: a SECOND
 * `tenaza hook` process appending to the SAME Session's log in that gap
 * (two parallel tool calls inside one turn each spawn their own hook
 * process; ADR 0002's "one writer per Session" is a simplification this
 * identity cannot lean on) would make the read stale, and both processes
 * could compute the SAME line.
 *
 * What IS safe without a lock: a single `appendFileSync` call on a file
 * opened for append (`appendToLog`, above) is one atomic write — the OS
 * commits it as one indivisible, non-interleaved chunk relative to every
 * other append-mode writer on the same file (that guarantee is the whole
 * point of O_APPEND). So this reads the file's content BEFORE writing
 * (`before`) — content nothing happening during or after this call can
 * ever retroactively change — appends, then reads the file again and
 * locates THIS call's own serialized line inside whatever grew past
 * `before.length`. That window is guaranteed to contain our own chunk
 * whole, plus zero or more OTHER complete chunks that happened to race in
 * around it; `priorLineCount` (from the immutable `before`) plus our
 * chunk's position within the window is the one true, final line number —
 * stable forever once computed, since the file can only grow by appending
 * AFTER whatever this read already captured, never by inserting earlier.
 *
 * Known, accepted edge case: two concurrent appends to the SAME Session's
 * log with BYTE-IDENTICAL content (same millisecond `ts`, same Action,
 * same Rule — i.e. the exact same command denied twice in the same
 * instant) cannot be told apart by this search, and may both resolve to
 * the same line. Both physical lines still name the SAME Session and SAME
 * command either way, so this never points a caller at ANOTHER agent's
 * command — the safety property this exists for — it only means one of
 * the two resulting Inbox rows may need a second, redundant resolution.
 * Two DIFFERENT commands racing — the realistic case parallel tool calls
 * produce — are never confused.
 */
export function appendEventAtLine(home: string, event: Event): { event: Event; line: number } {
  const file = sessionLogPath(event.session, home);
  const validated = EventSchema.parse(event);
  const serialized = JSON.stringify(validated);

  mkdirSync(path.dirname(file), { recursive: true });
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const priorLineCount = countNonBlankLines(before);
  const needsNewline = before.length > 0 && !before.endsWith("\n");
  appendFileSync(file, `${needsNewline ? "\n" : ""}${serialized}\n`, "utf8");

  const after = readFileSync(file, "utf8");
  const windowLines = after
    .slice(before.length)
    .split("\n")
    .filter((raw) => raw.trim().length > 0);
  const idx = windowLines.indexOf(serialized);
  const line = priorLineCount + (idx === -1 ? windowLines.length : idx + 1);

  return { event: validated, line };
}

/**
 * Parse one log file into validated Events, in file order, plus how many
 * lines could NOT be read — a line torn by a crashed mid-write, or naming
 * an Event type (or schema version) this build doesn't know, is SKIPPED
 * and counted rather than thrown (ADR 0007, ticket 01: H1's root cause was
 * exactly this throwing). Both empty when the file is absent.
 */
function readLogTolerant(file: string): { events: Event[]; skipped: number } {
  if (!existsSync(file)) return { events: [], skipped: 0 };

  const events: Event[] = [];
  let skipped = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      events.push(EventSchema.parse(JSON.parse(line)));
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped };
}

/** One Event plus the 1-indexed line (among non-blank lines) it occupies in its file — the read-side counterpart to `appendEventAtLine`'s own numbering. */
export interface LoggedEvent {
  event: Event;
  line: number;
}

/**
 * Parse one log file into validated Events, each tagged with its own LINE
 * — a torn or unknown-type line is skipped and counted (same tolerance as
 * `readLogTolerant`) but still consumes a line number, so numbering never
 * drifts from the raw file's own layout regardless of what fails to parse.
 */
function readLogWithLinesTolerant(file: string): { rows: LoggedEvent[]; skipped: number } {
  if (!existsSync(file)) return { rows: [], skipped: 0 };

  const rows: LoggedEvent[] = [];
  let skipped = 0;
  let line = 0;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (raw.trim().length === 0) continue;
    line += 1;
    try {
      rows.push({ event: EventSchema.parse(JSON.parse(raw)), line });
    } catch {
      skipped += 1;
    }
  }
  return { rows, skipped };
}

/** Parse one log file into validated Events, in file order; empty when absent. Tolerant — see `readLogTolerant`. */
function readLog(file: string): Event[] {
  return readLogTolerant(file).events;
}

/**
 * Append one Event to its Session's own log file, creating the file and its
 * directory on first write. One log file per Session: a single writer, so
 * parallel Sessions never contend (ADR 0002).
 */
export function appendEvent(home: string, event: Event): void {
  appendToLog(sessionLogPath(event.session, home), event);
}

/** Parse one Session's log into validated Events, in file order. */
export function readSessionEvents(session: string, home: string = tenazaHome()): Event[] {
  return readLog(sessionLogPath(session, home));
}

/** One Session's log, each Event tagged with its own line (ADR 0005, ticket 06) — the read-time counterpart `inbox.ts` hashes identities from. */
export function readSessionEventsWithLines(session: string, home: string = tenazaHome()): LoggedEvent[] {
  return readLogWithLinesTolerant(sessionLogPath(session, home)).rows;
}

/**
 * Existence check (ticket 05, M6's own backfill guard in
 * `adapters/claude.ts`): does this Session's log already have a
 * `session.started` ANYWHERE in it? Two tiers, cheapest first:
 *
 *   1. FAST — `session.started` really is line 1, true for every Session
 *      whose start hook fired before anything else (the overwhelming
 *      majority). Reads only the first few KB, never the whole file. This
 *      matters here specifically: unlike every other reader in this
 *      module, this is asked on EVERY PreToolUse / PostToolUse call — the
 *      hottest path in the system.
 *   2. SLOW — line 1 is something else (a Session that predates a proper
 *      start, or one of ticket 01/02's own lifecycle-less fixtures): a
 *      full scan of the file. REQUIRED, not optional — line 1 for such a
 *      Session never changes (a backfilled `session.started` only ever
 *      APPENDS at the end), so trusting the fast path alone here would
 *      make the caller think "never started" FOREVER and re-append a
 *      fresh backfill on every single later call, growing the log
 *      unbounded and drifting `startedAt` to whichever call ran last
 *      (`buildSessionIndex` is last-write-wins). The slow path only runs
 *      once the fast one has already ruled itself out, so it costs
 *      nothing on the common case this function exists to be cheap for.
 */
export function sessionHasStarted(session: string, home: string = tenazaHome()): boolean {
  const file = sessionLogPath(session, home);
  if (!existsSync(file)) return false;
  if (firstLineIsSessionStarted(file)) return true;
  return readLog(file).some((event) => event.type === "session.started");
}

function firstLineIsSessionStarted(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0] ?? "";
    if (!firstLine) return false;
    return JSON.parse(firstLine)?.type === "session.started";
  } catch {
    // A torn or truncated first line doesn't mean the Session never
    // started — just that line 1 isn't readable as one. Fall through to
    // the slow path rather than report `false` outright.
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one Event to the human log (`state/human.jsonl`) — a Resolution the
 * CLI writes on the human's behalf, never a Session's own log (ticket 02).
 */
export function appendHumanEvent(home: string, event: Event): void {
  appendToLog(humanLogPath(home), event);
}

/** Parse the human log into validated Events, in file order; empty when absent. */
export function readHumanEvents(home: string = tenazaHome()): Event[] {
  return readLog(humanLogPath(home));
}

/**
 * Every Event across every Session's log, plus how many lines across all
 * of them could NOT be read right now (ADR 0007, ticket 01) — the ONE pass
 * that reads these files, so a caller that needs the skip count (today,
 * only `inbox.ts`'s `deriveInboxReport`) gets it from the SAME read
 * `readAllSessionEvents` below already has to do, never a second,
 * independent rescan.
 */
export function readAllSessionEventsTolerant(home: string = tenazaHome()): { events: Event[]; skipped: number } {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return { events: [], skipped: 0 };

  const names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  let events: Event[] = [];
  let skipped = 0;
  for (const name of names) {
    const result = readLogTolerant(path.join(dir, name));
    events = events.concat(result.events);
    skipped += result.skipped;
  }
  return { events, skipped };
}

/**
 * Every Event across every Session's log, each tagged with its OWN line
 * within its own Session's file (ADR 0005, ticket 06) — the one pass
 * `inbox.ts` reads to hash every human-Rule match's identity, mirroring
 * `readAllSessionEventsTolerant`'s own shape plus that one extra fact per
 * row.
 */
export function readAllSessionEventsWithLinesTolerant(
  home: string = tenazaHome(),
): { rows: LoggedEvent[]; skipped: number } {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return { rows: [], skipped: 0 };

  const names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  let rows: LoggedEvent[] = [];
  let skipped = 0;
  for (const name of names) {
    const result = readLogWithLinesTolerant(path.join(dir, name));
    rows = rows.concat(result.rows);
    skipped += result.skipped;
  }
  return { rows, skipped };
}

/**
 * Every Event across every Session's log — nothing is kept beside the logs
 * themselves, so every view (status, the Inbox) derives from this. No log
 * directory yet is not an error: it means no Session has written anything.
 */
export function readAllSessionEvents(home: string = tenazaHome()): Event[] {
  return readAllSessionEventsTolerant(home).events;
}

// ---------------------------------------------------------------------------
// The Daemon's per-process log cache (ticket 13, criterion 3): memoize ONE
// Session log's own parse by its (mtime, size) so a poll tick that finds a
// SINGLE Session's log changed never pays to re-read-and-reparse the
// thousand others that didn't. Not where ticket 13's measured ~440 ms went
// (that was `deriveProject`'s per-Session `git` spawn — `sessions.ts`'s
// `createCachingGitRootResolver`): re-reading every log measured ~3 ms at
// 1165 Sessions. It stays because that read still grows with total history,
// never with how much actually changed. In memory only, scoped to ONE Daemon process
// (`daemon.ts`'s `DaemonContext`) — never written to disk, never a second
// source of truth: ADR 0002's "no state beside the logs" governs what a
// READER trusts across RESTARTS, and a process-local memoization of a PURE
// function of the files' own (mtime, size, bytes) is neither — a fresh
// Daemon launch starts cold and reparses everything once, byte-for-byte the
// same result `readLogWithLinesTolerant` always gave. `tenaza status`, the
// hook path and every other one-shot caller keep reading fresh every time
// (no cache instance to pass), exactly as before this ticket.
// ---------------------------------------------------------------------------

interface CachedSessionLog {
  mtimeMs: number;
  size: number;
  rows: LoggedEvent[];
  skipped: number;
}

/**
 * One Daemon's own memoization table, keyed by Session log FILE NAME (every
 * entry already lives under the same `sessionsDir`, so the name alone is
 * unambiguous). `createSessionLogCache` is the only constructor — nothing
 * else builds one by hand, and nothing persists it past the process that
 * created it.
 */
export interface SessionLogCache {
  readonly files: Map<string, CachedSessionLog>;
}

/** A fresh, empty cache — one per Daemon launch (never shared across a different `TENAZA_HOME`, never reused across a restart). */
export function createSessionLogCache(): SessionLogCache {
  return { files: new Map() };
}

/**
 * Every Session's log, parsed WITH its own per-event line number (the
 * strictly more informative shape `readLogWithLinesTolerant` already gives
 * — `readAllSessionEventsCached` below derives the plain `Event[]` view from
 * this SAME pass, never a second one over the files), reusing a cached parse
 * for any file whose (mtime, size) hasn't moved since `cache` last saw it.
 * Same directory listing, in the SAME (unsorted) order, as
 * `readAllSessionEventsWithLinesTolerant` — ticket 13's own differential
 * test holds this to byte-identical output against the uncached path over
 * one fixture home, so the enumeration order can never drift between the
 * two paths.
 *
 * A (mtime, size) match is treated as "unchanged" — the SAME cheap signal
 * `daemon.ts`'s own `computeStateSignature` already keys its "did anything
 * change at all" check on, not a new assumption introduced here. A Session
 * log that disappeared since the last read (hand-deleted) drops out of the
 * cache in the SAME pass, so a later file that happens to reuse that exact
 * name can never resurrect a stale parse.
 */
export function readAllSessionLogsCached(
  home: string,
  cache: SessionLogCache,
): { rows: LoggedEvent[]; skipped: number } {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return { rows: [], skipped: 0 };

  const names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  const seen = new Set<string>();
  let rows: LoggedEvent[] = [];
  let skipped = 0;

  for (const name of names) {
    seen.add(name);
    const file = path.join(dir, name);
    const stat = statSync(file);
    const cached = cache.files.get(name);
    const hit = cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size;
    const result = hit ? cached : readLogWithLinesTolerant(file);
    if (!hit) {
      cache.files.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, rows: result.rows, skipped: result.skipped });
    }
    rows = rows.concat(result.rows);
    skipped += result.skipped;
  }

  for (const name of cache.files.keys()) {
    if (!seen.has(name)) cache.files.delete(name);
  }

  return { rows, skipped };
}

/** The plain `Event[]` view of `readAllSessionLogsCached` — what `buildSessionIndex`/`eventTypesBySession` need, derived from the SAME cached pass rather than a second, independent read. */
export function readAllSessionEventsCached(
  home: string,
  cache: SessionLogCache,
): { events: Event[]; skipped: number } {
  const { rows, skipped } = readAllSessionLogsCached(home, cache);
  return { events: rows.map((row) => row.event), skipped };
}

/** The human log's Events, plus how many of its lines could not be read — the human-log counterpart to `readAllSessionEventsTolerant`. */
export function readHumanEventsTolerant(home: string = tenazaHome()): { events: Event[]; skipped: number } {
  return readLogTolerant(humanLogPath(home));
}
