import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Event } from "./contract/event";
import { buildDaemonUrl, readDaemonToken } from "./daemonlink";
import { findInboxRow, type InboxRow } from "./inbox";
import { readSessionEvents } from "./log";
import { DEFAULT_DAEMON_PORT, notifyRecorderPath, notifySoundStatePath, tenazaHome } from "./paths";
import { buildSessionIndex, categoryWord, deriveProject, roleOf, type SessionNode } from "./sessions";
import { describeAction, UNBLOCKED_MARKER } from "./status";

/** Wording for a freshly-born live item — nothing has run yet, and nothing can be `tenaza run` either, since the agent itself is paused on the Live surface. */
const LIVE_HOLD_MARKER = "te espera tu respuesta en la vista";

/** The single notifier port: `sendNotification` is the only place that decides how a Notification reaches the human. */
export interface Notification {
  /** A stable, deterministic key for this notification's identity — `inbox-<id>` or `threshold-<session>` (never random, never time-based). */
  tag: string;
  title: string;
  subtitle: string;
  message: string;
  /** The Daemon URL `sendMacNotification` hands to `terminal-notifier -open`, so clicking opens the view. `undefined` when no Daemon has ever written a token. Only `buildInboxOpenedNotification` sets this. */
  openUrl?: string;
}

export interface RecordedNotification extends Notification {
  sound: boolean;
}

/** A burst window (one sound per ~2s) — never blocks the notification itself, only throttles the sound across a burst. */
export const NOTIFY_BURST_WINDOW_MS = 2000;

export function shouldPlaySound(
  lastSoundAt: Date | undefined,
  now: Date,
  windowMs: number = NOTIFY_BURST_WINDOW_MS,
): boolean {
  if (!lastSoundAt) return true;
  return now.getTime() - lastSoundAt.getTime() >= windowMs;
}

/**
 * Pure: has `sample` just crossed `thresholdTokens` for the first time?
 * `previousMax` is the Session's highest `usage.sampled` value before
 * this one, never the latest alone — `undefined` can only ever be a
 * crossing.
 */
export function shouldNotifyThresholdCrossing(
  previousMax: number | undefined,
  sample: number,
  thresholdTokens: number,
): boolean {
  if (sample < thresholdTokens) return false;
  return previousMax === undefined || previousMax < thresholdTokens;
}

/**
 * The highest `usage.sampled` value a Session's log has ever carried, not
 * the latest — context can read lower on a later sample (after a
 * compaction, say), and "once per Session" must hold even then, so a
 * Session that already crossed must never notify again on a lower one.
 */
export function maxUsageSample(events: Event[]): number | undefined {
  let max: number | undefined;
  for (const event of events) {
    if (event.type !== "usage.sampled") continue;
    if (max === undefined || event.data.context_tokens > max) max = event.data.context_tokens;
  }
  return max;
}

/**
 * 🟡 — a new Inbox item. An unblocked item still notifies, since the
 * human still needs to know it happened, but never says
 * `tenaza run <id>` — `run` refuses on an unblocked item.
 *
 * `shortId` is `row.id`'s shortest unique prefix at the moment this
 * fired, shown in the hint a human would type back. `tag` stays keyed on
 * the full hash instead, since a display prefix could lengthen later as
 * new items open — this key must never depend on that shifting.
 */
export function buildInboxOpenedNotification(
  row: InboxRow,
  shortId: string,
  context: { project: string; role: string },
  openUrl?: string,
): Notification {
  const commandLine = describeAction(row.action);
  const message =
    row.decision === "held"
      ? `${commandLine}  ${LIVE_HOLD_MARKER}`
      : row.blocked
        ? `${commandLine} · tenaza run ${shortId}`
        : `${commandLine}  ${UNBLOCKED_MARKER}`;

  return {
    tag: `inbox-${row.id}`,
    title: `🟡 Tenaza · ${categoryWord("waits")} · inbox ${shortId}`,
    subtitle: `${context.project} / ${context.role} / sesión ${row.session}`,
    message,
    openUrl,
  };
}

/**
 * 🔴 — a Session crossing the Flag threshold. The threshold in the title
 * reflects the Policy's actual `thresholdTokens`, never a hardcoded
 * "200k" — it must never disagree with the one that actually fired it.
 */
export function buildThresholdCrossedNotification(context: {
  project: string;
  role: string;
  session: string;
  contextTokens: number;
  thresholdTokens: number;
}): Notification {
  const thresholdK = Math.round(context.thresholdTokens / 1000);
  const contextK = Math.round(context.contextTokens / 1000);

  return {
    tag: `threshold-${context.session}`,
    title: `🔴 Tenaza · pasó ${thresholdK}k`,
    subtitle: `${context.project} / ${context.role} / sesión ${context.session}`,
    message: `${contextK}k tokens`,
  };
}

/** 🔴 — a run stopped on a decision only the human can make: same red as a Flag crossing, since both need the human to look. */
export function buildParkedNotification(context: {
  project: string;
  role: string;
  session: string;
  ticket: string | undefined;
}): Notification {
  const ticketLabel = context.ticket ?? context.session.slice(0, 4);
  return {
    tag: `parked-${context.session}`,
    title: "🔴 Tenaza · te espera",
    subtitle: `${context.project} / ${context.role} / sesión ${context.session}`,
    message: `#${ticketLabel} espera tu respuesta`,
  };
}

/**
 * 🔴 — Tenaza itself is gravely degraded. "binary missing" can't reach
 * this call site — that case prints its guard message straight from
 * `hooks.json`, no notifier involved — so in practice this fires for the
 * other grave case: no last-known-good Policy ever, every Rule off.
 * `message` carries `degraded.message` in English; only the
 * title/subtitle chrome is es-AR.
 */
export function buildGraveFaultNotification(message: string): Notification {
  return {
    tag: "health-grave",
    title: "🔴 Tenaza · degradado",
    subtitle: "guardrail apagado",
    message,
  };
}

/**
 * Fire 🔴 for a grave fault — the one call site, right where
 * `degraded.grave` is already decided, so it covers a grave fault however
 * it was noticed. Swallows its own lookups failing too, not just
 * `sendNotification`'s own guard.
 */
export function notifyGraveFault(home: string, message: string, now: Date = new Date()): void {
  try {
    sendNotification(home, buildGraveFaultNotification(message), now);
  } catch {
  }
}

function readLastSoundAt(home: string): Date | undefined {
  const file = notifySoundStatePath(home);
  if (!existsSync(file)) return undefined;
  const parsed = new Date(readFileSync(file, "utf8").trim());
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function writeLastSoundAt(home: string, now: Date): void {
  const file = notifySoundStatePath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, now.toISOString(), "utf8");
}

function appendRecorder(home: string, recorded: RecordedNotification): void {
  const file = notifyRecorderPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(recorded)}\n`, "utf8");
}

/** Read back every notification the recorder seam captured, in order — the test oracle for what would have been sent. */
export function readNotificationRecorder(home: string = tenazaHome()): RecordedNotification[] {
  const file = notifyRecorderPath(home);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedNotification);
}

function quoteAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface MacNotifierCommand {
  tool: "terminal-notifier" | "osascript";
  argv: string[];
}

/**
 * `osascript display notification` has no click-action parameter, so a
 * clickable notification needs `terminal-notifier -open <url>` instead.
 * `undefined` on a Linux Sandbox: it has no macOS notifier, and the host
 * Daemon tells the human.
 */
export function buildMacNotifierCommand(
  notification: Notification,
  sound: boolean,
  hasTerminalNotifier: boolean,
  hasOsascript: boolean,
): MacNotifierCommand | undefined {
  if (notification.openUrl && hasTerminalNotifier) {
    const argv = [
      "terminal-notifier",
      "-title",
      notification.title,
      "-subtitle",
      notification.subtitle,
      "-message",
      notification.message,
      "-open",
      notification.openUrl,
    ];
    if (sound) argv.push("-sound", "default");
    return { tool: "terminal-notifier", argv };
  }
  if (!hasOsascript) return undefined;

  const script =
    `display notification ${quoteAppleScriptString(notification.message)} ` +
    `with title ${quoteAppleScriptString(notification.title)} ` +
    `subtitle ${quoteAppleScriptString(notification.subtitle)}` +
    (sound ? ' sound name "Glass"' : "");
  return { tool: "osascript", argv: ["osascript", "-e", script] };
}

/**
 * `display notification` can't replace an earlier banner by tag — `tag` is
 * Tenaza's own bookkeeping key, not an OS-level one. Not awaited so the
 * hook never blocks on it.
 */
function sendMacNotification(notification: Notification, sound: boolean): void {
  const command = buildMacNotifierCommand(
    notification,
    sound,
    Bun.which("terminal-notifier") !== null,
    Bun.which("osascript") !== null,
  );
  if (!command) return;
  Bun.spawn(command.argv, { stdout: "ignore", stderr: "ignore" });
}

/**
 * The notifier port itself — the only function that decides where a
 * Notification actually goes. `TENAZA_NOTIFY_RECORDER` set → append to
 * the recorder file instead of touching macOS (a repo-wide preload sets
 * this for every `bun test` run). Unset → the real macOS sender. Never
 * throws — a failing notifier must never fail the hook or change its
 * allow/deny answer.
 */
export function sendNotification(home: string, notification: Notification, now: Date = new Date()): void {
  try {
    const sound = shouldPlaySound(readLastSoundAt(home), now);
    if (sound) writeLastSoundAt(home, now);

    if (process.env.TENAZA_NOTIFY_RECORDER) {
      appendRecorder(home, { ...notification, sound });
      return;
    }
    sendMacNotification(notification, sound);
  } catch {
  }
}

/** This one Session's project, role and `ticket` Label — never the full multi-Session tree, which this doesn't need. */
function sessionContext(home: string, session: string): { project: string; role: string; ticket: string | undefined } {
  const index = buildSessionIndex(readSessionEvents(session, home));
  const node: SessionNode = index.get(session) ?? { id: session, capabilities: [], labels: {} };
  return { project: deriveProject(node), role: roleOf(node), ticket: node.labels.ticket };
}

/**
 * Fire 🟡 for the Inbox item `fullId` names. `shortId` is the same
 * display hash the caller is about to hand back to the agent/CLI, so the
 * notification's text and the deny message never disagree. Swallows its
 * own lookups failing too — nothing downstream of a human match may ever
 * crash the hook.
 */
export function notifyNewInboxItem(home: string, fullId: string, shortId: string, now: Date = new Date()): void {
  try {
    const row = findInboxRow(home, fullId);
    if (!row) return;
    const context = sessionContext(home, row.session);
    // Only set when a Daemon has ever written a token; always the default
    // port, since no file names which port a non-default
    // `tenaza ui --port <n>` bound to.
    const token = readDaemonToken(home);
    const openUrl = token ? buildDaemonUrl(DEFAULT_DAEMON_PORT, token) : undefined;
    sendNotification(home, buildInboxOpenedNotification(row, shortId, context, openUrl), now);
  } catch {
  }
}

/** Fire 🔴 for `session` crossing `thresholdTokens` with this `contextTokens` sample, per `shouldNotifyThresholdCrossing`. */
export function notifyThresholdCrossed(
  home: string,
  session: string,
  contextTokens: number,
  thresholdTokens: number,
  now: Date = new Date(),
): void {
  try {
    const context = sessionContext(home, session);
    sendNotification(
      home,
      buildThresholdCrossedNotification({ ...context, session, contextTokens, thresholdTokens }),
      now,
    );
  } catch {
  }
}

export function notifyParked(home: string, session: string, now: Date = new Date()): void {
  try {
    const context = sessionContext(home, session);
    sendNotification(home, buildParkedNotification({ ...context, session }), now);
  } catch {}
}
