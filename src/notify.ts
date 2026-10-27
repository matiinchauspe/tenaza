import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Event } from "./contract/event";
import { findInboxRow, type InboxRow } from "./inbox";
import { readSessionEvents } from "./log";
import { notifyRecorderPath, notifySoundStatePath, tenazaHome } from "./paths";
import { buildSessionIndex, categoryWord, deriveProject, roleOf, type SessionNode } from "./sessions";
import { describeAction, UNBLOCKED_MARKER } from "./status";

/**
 * The single notifier port (ticket 08): everything upstream builds one of
 * these, pure, and `sendNotification` is the only place that decides HOW it
 * reaches the human. Nothing upstream of this file knows macOS exists.
 */
export interface Notification {
  /** A stable, deterministic key for this notification's identity — `inbox-<id>` or `threshold-<session>` (never random, never time-based): see `sendNotification`'s own doc for what this does and does not buy. */
  tag: string;
  title: string;
  subtitle: string;
  message: string;
}

/** What the recorder keeps: the Notification plus whether THIS send actually played a sound. */
export interface RecordedNotification extends Notification {
  sound: boolean;
}

/**
 * "A burst window (one sound per ~2s)" — the spec's own anti-spam rule.
 * Never blocks the notification itself (ticket 06's "never silently drop"
 * ethos applies here too): every matching Event still notifies, this only
 * throttles the SOUND across a burst of them.
 */
export const NOTIFY_BURST_WINDOW_MS = 2000;

/**
 * Pure: should THIS send play a sound, given when one last did? No prior
 * sound (a fresh `TENAZA_HOME`, or nothing sent yet) always plays one.
 */
export function shouldPlaySound(
  lastSoundAt: Date | undefined,
  now: Date,
  windowMs: number = NOTIFY_BURST_WINDOW_MS,
): boolean {
  if (!lastSoundAt) return true;
  return now.getTime() - lastSoundAt.getTime() >= windowMs;
}

/**
 * Pure: has `sample` just crossed `thresholdTokens` for the FIRST time —
 * i.e. every sample this Session had before now was below it, and this one
 * is not? `previousMax` is the Session's own highest `usage.sampled` value
 * before this one (never the latest alone — see `maxUsageSample`'s own doc
 * for why). `undefined` means "never sampled before," which can only ever
 * be a crossing, not a repeat.
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
 * The highest `usage.sampled` value a Session's log has ever carried — NOT
 * the latest one (which `sessions.ts`'s `SessionNode.contextTokens` already
 * tracks, "last write wins," for the context bar). Crossing detection needs
 * the running MAX instead: context can in principle read lower on a later
 * sample than an earlier one (e.g. after a compaction), and "once per
 * Session" must stay true even then — a Session that already crossed must
 * never notify again just because one later sample happened to read lower.
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
 * 🟡 — a new Inbox item (ticket 08, q19's own worked example):
 * `🟡 Tenaza · te espera · inbox #14` / `reservee / RES-131 / sesión b71` /
 * `Bash: gh pr merge 58 --merge · tenaza run 14`. An `mcp` Action (ticket 04)
 * describes the same way `status`'s Inbox line does (`describeAction`): the
 * tool's own name plus a short argument summary, never blank. An UNBLOCKED
 * item (ticket 06, ADR 0001) still notifies — the human still needs to know
 * it happened — but the message never says `tenaza run <id>`, which would
 * be wrong: `run` REFUSES on an unblocked item (`resolve.ts`). It gets the
 * SAME es-AR marker `status`'s own Inbox line already uses for it instead,
 * so the one piece of copy a human reads twice (notification, then
 * `status`) never disagrees with itself.
 */
export function buildInboxOpenedNotification(
  row: InboxRow,
  context: { project: string; role: string },
): Notification {
  const commandLine = describeAction(row.action);
  const message = row.blocked
    ? `${commandLine} · tenaza run ${row.id}`
    : `${commandLine}  ${UNBLOCKED_MARKER}`;

  return {
    tag: `inbox-${row.id}`,
    title: `🟡 Tenaza · ${categoryWord("waits", false)} · inbox #${row.id}`,
    subtitle: `${context.project} / ${context.role} / sesión ${row.session}`,
    message,
  };
}

/**
 * 🔴 — a Session crossing the Flag threshold, once per Session (q19):
 * `🔴 Tenaza · pasó 200k` / project / ticket / Session / tokens. The
 * threshold in the TITLE reflects the Policy's ACTUAL `thresholdTokens`
 * (ticket 07's own rule for the statusline's `⚑` suffix, applied here too)
 * rather than a hardcoded "200k" — the spec's worked example happens to use
 * the default, but a custom threshold must never leave this notification
 * disagreeing with the one that actually fired it.
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

/**
 * 🔴 — Tenaza itself is gravely degraded (ADR 0007, ticket 02): "binary
 * missing" can never reach this call site at all (nothing Tenaza owns runs
 * when its own binary isn't on PATH — that case prints its guard message
 * straight from `hooks.json`'s shell form, no notifier involved), so in
 * practice this fires for the OTHER grave case decision 01 names: no
 * last-known-good Policy ever, where every Rule is off. `message` carries
 * whatever `degraded.message` already says (English, same as every other
 * systemMessage) — only the title/subtitle chrome around it is es-AR, per
 * the project's own human-facing-copy split.
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
 * Fire 🔴 for a grave fault — the ONE call site (`cli.ts`'s `runHookClaude`,
 * right where `degraded.grave` is already decided, so it covers a grave
 * fault however it was noticed: the SessionStart self-check or a PreToolUse
 * call hitting the same Policy state). Swallows its own lookups failing
 * too, not just `sendNotification`'s own guard — same shape as
 * `notifyNewInboxItem`/`notifyThresholdCrossed` above.
 */
export function notifyGraveFault(home: string, message: string, now: Date = new Date()): void {
  try {
    sendNotification(home, buildGraveFaultNotification(message), now);
  } catch {
    // See `sendNotification`'s own doc.
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

/** Read back every notification the recorder seam captured, in order — the test oracle for "what would have been sent." */
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

/**
 * The real macOS sender: `osascript -e 'display notification …'` — ships
 * with every macOS, so installing Tenaza needs nothing extra for this (no
 * `terminal-notifier`, no new Homebrew dependency). The tradeoff, stated
 * plainly rather than papered over: `display notification` has no
 * identifier/group parameter, so it cannot ask Notification Center to
 * REPLACE an earlier banner the way a stable tag would with a tool that
 * supports one — `tag` here is Tenaza's own bookkeeping key, not an OS-level
 * one (see `Notification.tag`'s own doc). Fired with `Bun.spawn` and never
 * awaited: the hook must not block on, or fail because of, the human's
 * notification center.
 */
function sendMacNotification(notification: Notification, sound: boolean): void {
  const script =
    `display notification ${quoteAppleScriptString(notification.message)} ` +
    `with title ${quoteAppleScriptString(notification.title)} ` +
    `subtitle ${quoteAppleScriptString(notification.subtitle)}` +
    (sound ? ' sound name "Glass"' : "");
  Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" });
}

/**
 * The notifier port itself (ticket 08). Every caller funnels through here,
 * and this is the ONLY function that decides where a Notification actually
 * goes:
 *   - `TENAZA_NOTIFY_RECORDER` set (any truthy value) → append to the
 *     recorder file under THIS `home` instead of touching macOS at all —
 *     the test seam the ticket names ("swap the macOS sender for a recorder
 *     through the environment"). A repo-wide `bunfig.toml` preload sets
 *     this for every `bun test` run, so no test — old or new, unit or
 *     black-box — can ever fire a real notification by omission.
 *   - unset → the real macOS sender.
 * Either way, whether to actually PLAY A SOUND this time is decided first,
 * from the same burst-window state, so the recorder and the real sender
 * agree on it.
 *
 * Never throws (AC: "a failing notifier never fails the hook or changes its
 * allow/deny answer") — every step from here down is inside the guard.
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
    // A failing notifier (no osascript, a denied permission, a read/write
    // error on its own small state file, …) must never fail the hook.
  }
}

/** This one Session's project and role, the same way `tenaza status`'s tree row derives them — never the full multi-Session tree, which this doesn't need. */
function sessionContext(home: string, session: string): { project: string; role: string } {
  const index = buildSessionIndex(readSessionEvents(session, home));
  const node: SessionNode = index.get(session) ?? { id: session, capabilities: [], labels: {} };
  return { project: deriveProject(node), role: roleOf(node) };
}

/**
 * Fire 🟡 for the Inbox item `inboxId` names — the ONE call site for it
 * (`decide.ts`, at the moment it opens the item, for both the enforced deny
 * and the unblocked-but-still-surfaced case, ticket 06). Swallows its own
 * lookups failing too, not just `sendNotification`'s own guard — nothing
 * downstream of a human match may ever crash the hook.
 */
export function notifyNewInboxItem(home: string, inboxId: number, now: Date = new Date()): void {
  try {
    const row = findInboxRow(home, inboxId);
    if (!row) return;
    const context = sessionContext(home, row.session);
    sendNotification(home, buildInboxOpenedNotification(row, context), now);
  } catch {
    // See `sendNotification`'s own doc — the same guarantee, one level up.
  }
}

/**
 * Fire 🔴 for `session` crossing `thresholdTokens` with this `contextTokens`
 * sample — the ONE call site for it (`adapters/claude.ts`'s `sampleUsage`,
 * at the moment it appends the crossing `usage.sampled` Event, per
 * `shouldNotifyThresholdCrossing`).
 */
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
    // See `sendNotification`'s own doc.
  }
}
