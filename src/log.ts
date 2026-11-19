import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { type Event, EventSchema } from "./contract/event";
import { humanLogPath, sessionLogPath, sessionsDir, tenazaHome } from "./paths";

/**
 * True when `file` exists and doesn't end in a newline — a process that
 * died mid-write can leave a torn tail, and appending straight onto it
 * would corrupt that line further.
 */
function endsWithoutNewline(file: string): boolean {
  if (!existsSync(file)) return false;
  const content = readFileSync(file, "utf8");
  return content.length > 0 && !content.endsWith("\n");
}

function appendToLog(file: string, event: Event): void {
  const validated = EventSchema.parse(event);
  mkdirSync(path.dirname(file), { recursive: true });
  const prefix = endsWithoutNewline(file) ? "\n" : "";
  appendFileSync(file, `${prefix}${JSON.stringify(validated)}\n`, "utf8");
}

/** Lines split on `\n` leave a trailing empty string when the file ends in one — skipped so it never counts as a line. */
function countNonBlankLines(content: string): number {
  let count = 0;
  for (const raw of content.split("\n")) {
    if (raw.trim().length > 0) count += 1;
  }
  return count;
}

/**
 * Append one Event to its Session's log and report the exact line it
 * landed on (1-indexed, among non-blank lines) — only the write itself
 * knows where a line truly lands, since two parallel tool calls in one
 * turn can each spawn their own `tenaza hook` process appending to the
 * same Session's log at once.
 *
 * No lock is available, which rules out reading the current line count,
 * then appending, then reporting count+1: that is two separate steps with
 * a gap between them where a second writer could land in between, making
 * the read stale and letting both processes compute the same line.
 *
 * What a lock-free append-mode write (`appendFileSync`, via `appendToLog`)
 * does guarantee is that each call's write lands as one atomic,
 * non-interleaved chunk (O_APPEND). So this reads the file before writing,
 * appends, then reads again and locates its own serialized line within
 * whatever grew past the earlier length — that window always contains
 * this call's whole chunk, plus zero or more complete chunks from writers
 * that raced in around it, so `priorLineCount` plus this chunk's position
 * in the window is the true, final line number.
 *
 * Accepted edge case: two concurrent appends with byte-identical content
 * (same millisecond, Action and Rule) can't be told apart and may resolve
 * to the same line — both still name the same Session and command, so
 * this never points a caller at another agent's command; it only means
 * one of two resulting Inbox rows may need a redundant second resolution.
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
 * lines could not be read — a line torn by a crashed mid-write, or naming
 * an Event type this build doesn't know, is skipped and counted rather
 * than thrown. Both empty when the file is absent.
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
 * Parse one log file into validated Events, each tagged with its own line
 * — a torn or unknown-type line is skipped but still consumes a line
 * number, so numbering never drifts from the file's own layout regardless
 * of what fails to parse.
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

function readLog(file: string): Event[] {
  return readLogTolerant(file).events;
}

/** Append one Event to its Session's log, creating the file and its directory on first write. One log file per Session, so parallel Sessions never contend for the same file. */
export function appendEvent(home: string, event: Event): void {
  appendToLog(sessionLogPath(event.session, home), event);
}

/** Parse one Session's log into validated Events, in file order. */
export function readSessionEvents(session: string, home: string = tenazaHome()): Event[] {
  return readLog(sessionLogPath(session, home));
}

/** One Session's log, each Event tagged with its own line — the read-time counterpart `inbox.ts` hashes identities from. */
export function readSessionEventsWithLines(session: string, home: string = tenazaHome()): LoggedEvent[] {
  return readLogWithLinesTolerant(sessionLogPath(session, home)).rows;
}

/**
 * Does this Session's log already have a `session.started` anywhere in
 * it? Two tiers, cheapest first:
 *
 *   1. Fast — `session.started` is line 1, true for the overwhelming
 *      majority of Sessions. Reads only the first few KB. This matters
 *      here specifically: unlike every other reader in this module, this
 *      runs on every PreToolUse/PostToolUse call — the hottest path in
 *      the system.
 *   2. Slow — line 1 is something else (a Session that predates a proper
 *      start): a full scan. Required, not optional — line 1 never changes
 *      for such a Session (a backfilled `session.started` only ever
 *      appends at the end), so trusting the fast path alone would make
 *      the caller think "never started" forever and re-append a fresh
 *      backfill on every later call, growing the log unbounded. The slow
 *      path only runs once the fast one has ruled itself out, so it costs
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

/** Append one Event to the human log (`state/human.jsonl`) — a Resolution the CLI writes on the human's behalf, never into a Session's own log. */
export function appendHumanEvent(home: string, event: Event): void {
  appendToLog(humanLogPath(home), event);
}

/** Parse the human log into validated Events, in file order; empty when absent. */
export function readHumanEvents(home: string = tenazaHome()): Event[] {
  return readLog(humanLogPath(home));
}

/**
 * Every Event across every Session's log, plus how many lines across all
 * of them could not be read — the one pass that reads these files, so a
 * caller that needs the skip count gets it from the same read
 * `readAllSessionEvents` below already has to do, rather than a second,
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
 * Every Event across every Session's log, each tagged with its own line
 * within its own Session's file — the one pass `inbox.ts` reads to hash
 * every human-Rule match's identity.
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
// The Daemon's per-process log cache: memoize one Session log's own parse by
// its (mtime, size) so a poll tick that finds a single Session's log changed
// never pays to re-read-and-reparse every other one. It stays in memory
// only, scoped to one Daemon process, and is never written to disk — a
// fresh Daemon launch starts cold and reparses everything, byte-for-byte
// the same result `readLogWithLinesTolerant` always gave, so it can never
// become a stale second source of truth across a restart. `tenaza status`,
// the hook path and every other one-shot caller read fresh every time (no
// cache instance to pass).
// ---------------------------------------------------------------------------

interface CachedSessionLog {
  mtimeMs: number;
  size: number;
  rows: LoggedEvent[];
  skipped: number;
}

/** One Daemon's own memoization table, keyed by Session log file name — every entry already lives under the same `sessionsDir`, so the name alone is unambiguous. */
export interface SessionLogCache {
  readonly files: Map<string, CachedSessionLog>;
}

/** A fresh, empty cache — one per Daemon launch, never shared across a different `TENAZA_HOME` or reused across a restart. */
export function createSessionLogCache(): SessionLogCache {
  return { files: new Map() };
}

/**
 * Every Session's log, parsed with its own per-event line number, reusing
 * a cached parse for any file whose (mtime, size) hasn't moved since
 * `cache` last saw it. A Session log that disappeared since the last read
 * drops out of the cache in the same pass, so a later file that happens to
 * reuse that exact name can never resurrect a stale parse.
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

/** The plain `Event[]` view of `readAllSessionLogsCached`, derived from that same cached pass rather than a second, independent read. */
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
