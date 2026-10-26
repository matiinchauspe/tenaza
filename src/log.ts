import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
 * Every Event across every Session's log — nothing is kept beside the logs
 * themselves, so every view (status, the Inbox) derives from this. No log
 * directory yet is not an error: it means no Session has written anything.
 */
export function readAllSessionEvents(home: string = tenazaHome()): Event[] {
  return readAllSessionEventsTolerant(home).events;
}

/** The human log's Events, plus how many of its lines could not be read — the human-log counterpart to `readAllSessionEventsTolerant`. */
export function readHumanEventsTolerant(home: string = tenazaHome()): { events: Event[]; skipped: number } {
  return readLogTolerant(humanLogPath(home));
}
