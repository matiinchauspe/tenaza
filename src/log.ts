import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Event, EventSchema } from "./contract/event";
import { humanLogPath, sessionLogPath, sessionsDir, tenazaHome } from "./paths";

/** Append one Event to a log file, creating its directory on first write. */
function appendToLog(file: string, event: Event): void {
  const validated = EventSchema.parse(event);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(validated)}\n`, "utf8");
}

/** Parse one log file into validated Events, in file order; empty when absent. */
function readLog(file: string): Event[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => EventSchema.parse(JSON.parse(line)));
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
 * Every Event across every Session's log — nothing is kept beside the logs
 * themselves, so every view (status, the Inbox) derives from this. No log
 * directory yet is not an error: it means no Session has written anything.
 */
export function readAllSessionEvents(home: string = tenazaHome()): Event[] {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return [];

  const sessions = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length));

  return sessions.flatMap((session) => readSessionEvents(session, home));
}
