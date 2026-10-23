import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Event, EventSchema } from "./contract/event";
import { sessionLogPath, sessionsDir, tenazaHome } from "./paths";

/**
 * Append one Event to its Session's own log file, creating the file and its
 * directory on first write. One log file per Session: a single writer, so
 * parallel Sessions never contend (ADR 0002).
 */
export function appendEvent(home: string, event: Event): void {
  const validated = EventSchema.parse(event);
  const file = sessionLogPath(validated.session, home);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(validated)}\n`, "utf8");
}

/** Parse one Session's log into validated Events, in file order. */
export function readSessionEvents(session: string, home: string = tenazaHome()): Event[] {
  const file = sessionLogPath(session, home);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => EventSchema.parse(JSON.parse(line)));
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
