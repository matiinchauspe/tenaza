import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Action, Capability, NotificationKind } from "../contract/event";
import {
  notificationObservedEvent,
  promptSubmittedEvent,
  sessionEndedEvent,
  sessionLabeledEvent,
  sessionStartedEvent,
  turnEndedEvent,
  usageSampledEvent,
} from "../contract/event";
import { decideAction } from "../decide";
import { runSelfCheck } from "../health";
import { appendEvent, readSessionEvents, sessionHasStarted } from "../log";
import { maxUsageSample, notifyParked, notifyThresholdCrossed, shouldNotifyThresholdCrossing } from "../notify";
import { sessionLabelsMarkerPath, usageSampleMarkerPath } from "../paths";
import { loadPolicy, policyWarning } from "../policy";
import { buildSessionIndex } from "../sessions";
import { captureProcessMarker, captureTerminalLocator } from "../terminallocator";
import { measureContextTokens } from "../transcript";
import { countToolCall, shouldSampleOnToolCall, touchSession } from "../toolcalls";

/** `agent_id` is present only when this call happens inside a subagent; absent for the main session's own calls. */
export interface ClaudeHookPayload {
  session_id: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  agent_id?: string;
  /** Read only to backfill a missing `session.started`; never otherwise. */
  cwd?: string;
}

export interface ClaudeSessionStartPayload {
  session_id: string;
  hook_event_name: "SessionStart";
  cwd: string;
}

/** Keyed by `agent_id` — `session_id` stays the parent's id. */
export interface ClaudeSubagentStartPayload {
  session_id: string;
  hook_event_name: "SubagentStart";
  agent_id: string;
  cwd: string;
}

/**
 * `agent_transcript_path` is the subagent's OWN transcript — `transcript_path`
 * here names the PARENT's. Missing `agent_transcript_path` ends the session
 * without a usage sample rather than reading the parent's by mistake.
 */
export interface ClaudeSubagentStopPayload {
  session_id: string;
  hook_event_name: "SubagentStop";
  agent_id: string;
  transcript_path?: string;
  agent_transcript_path?: string;
  /** Deliberately never read — see `handleSubagentStop` for why backfilling here would defeat `isNoiseSession`. */
  cwd?: string;
}

export interface ClaudeSessionEndPayload {
  session_id: string;
  hook_event_name: "SessionEnd";
  reason: string;
  transcript_path?: string;
  /** Read only to backfill a missing `session.started`; never otherwise. */
  cwd?: string;
}

/** Never ends the Session — that's SessionEnd's job. */
export interface ClaudeStopPayload {
  session_id: string;
  hook_event_name: "Stop";
  transcript_path?: string;
  /** Read only to backfill a missing `session.started`; never otherwise. */
  cwd?: string;
}

/**
 * An ordinary tool call matches no Policy Rule and is never logged on its
 * own. `agent_id` names a subagent's OWN session, exactly as on
 * `PreToolUse` — absent for a call in the main session.
 */
export interface ClaudePostToolUsePayload {
  session_id: string;
  hook_event_name: "PostToolUse";
  /**
   * The PARENT's transcript when `agent_id` is present — never sampled
   * directly for a subagent (see `resolveSampleTranscriptPath`). Claude
   * Code's real PostToolUse payload inside a subagent never carries
   * `agent_transcript_path`, so this field also serves as the derivation
   * source for the subagent's own transcript path in that case.
   */
  transcript_path?: string;
  agent_id?: string;
  /** The subagent's own transcript, when the payload carries it — wins over any derivation; see `resolveSampleTranscriptPath`. */
  agent_transcript_path?: string;
  /** Read only to backfill a missing `session.started`; never otherwise. */
  cwd?: string;
}

/** This event carries no decision capability in Claude Code's own contract — never answers back with a permission decision. */
export interface ClaudeUserPromptSubmitPayload {
  session_id: string;
  hook_event_name: "UserPromptSubmit";
  agent_id?: string;
}

/**
 * `hooks/hooks.json`'s matcher already narrows calls to
 * `permission_prompt`/`idle_prompt` — `handleNotification` checks
 * `notification_type` again, defensively. No decision capability exists
 * for this event either.
 */
export interface ClaudeNotificationPayload {
  session_id: string;
  hook_event_name: "Notification";
  agent_id?: string;
  notification_type?: string;
}

export type ClaudeHookInput =
  | ClaudeHookPayload
  | ClaudeSessionStartPayload
  | ClaudeSubagentStartPayload
  | ClaudeSubagentStopPayload
  | ClaudeSessionEndPayload
  | ClaudeStopPayload
  | ClaudePostToolUsePayload
  | ClaudeUserPromptSubmitPayload
  | ClaudeNotificationPayload;

export interface ClaudeHookResponse {
  /** Set only when `handlePreToolUse` noticed a degraded read (a skipped log line) while reaching its decision — independent of any permission decision. */
  systemMessage?: string;
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    /** Absent only on a decision-less answer that carries `additionalContext` alone (`LABEL_NOT_RECORDED`) — never an implicit allow. */
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
    /** Set only on a live-answering APPROVE that carried a message — shown next to the tool result. */
    additionalContext?: string;
  };
}

/**
 * Declared on every `session.started` so the core degrades by Capability,
 * never by runtime name. `stop` (halting a Session) is not implemented —
 * v1 never stops a Session.
 */
const CLAUDE_CAPABILITIES: Capability[] = ["observe", "block", "measure"];

/** What `parseLabelCommand` captures, told to the agent in both texts below. */
const PURE_LABEL_RULE =
  "a label counts only when `tenaza label <key>=<value> …` runs as its own shell command, with single-word values";

/**
 * The one line every observed Session gets in its own context — worded so
 * a caller finds it by shape without naming Tenaza, and as an offer, not
 * an order, since most Sessions have no caller that labels them.
 */
export const ANNOUNCE_DECLARATION = `A session observer is watching this session, and a caller may label it: ${PURE_LABEL_RULE} — \`project\` groups sessions, and any other key is shown as given.`;

/**
 * Shell syntax that makes a command more than a pure label call — see
 * `parseLabelCommand`. Quotes are deliberately excluded: alone they run
 * nothing, so a value wrapped in one matched pair is unwrapped instead.
 */
const SHELL_SYNTAX = /[;&|<>$`()\\\n]/;

/** One `key=value` token, its value optionally wrapped in one matched pair of quotes holding no quote itself. */
const LABEL_PAIR = /^([^=\s'"]+)=(?:"([^"]*)"|'([^']*)'|([^'"]*))$/;

/** A `tenaza label` named anywhere in a command — the shape that earns `LABEL_NOT_RECORDED` when it is not a pure one. */
const MENTIONS_LABEL = /(?:^|[\s;&|(`/])tenaza\s+label\b/;

/** What the agent is told when a `tenaza label` command was not pure, so it went unrecorded — the CLI's own `label` is a no-op, so without this the drop is silent. */
export const LABEL_NOT_RECORDED = `The \`tenaza label\` in this command was not recorded: ${PURE_LABEL_RULE}.`;

/**
 * Context only, never a denial. Names nothing of Yunque's beyond
 * "checkpoint": Tenaza does not depend on it.
 */
export const CHECKPOINT_NUDGE = "This session has crossed its context threshold. Write your checkpoint and end the run.";

/** The `additionalContext` answer SessionStart and SubagentStart give — context only, no decision. */
function declarationResponse(hookEventName: "SessionStart" | "SubagentStart"): ClaudeHookOutput {
  return { hookSpecificOutput: { hookEventName, additionalContext: ANNOUNCE_DECLARATION } };
}

/**
 * Normalize a PreToolUse payload into a runtime-neutral Action: no
 * per-provider code — the Policy alone decides what the arguments mean.
 * `undefined` means this call isn't yet an Action Tenaza has a shape for.
 */
export function normalizeClaudeAction(payload: ClaudeHookPayload): Action | undefined {
  if (payload.tool_name === "Bash") {
    const command = payload.tool_input?.command;
    return typeof command === "string" ? { kind: "shell", command, tool: "Bash" } : undefined;
  }
  if (payload.tool_name.startsWith("mcp__")) {
    return { kind: "mcp", tool: payload.tool_name, args: payload.tool_input ?? {} };
  }
  return undefined;
}

/**
 * Recognize `tenaza label key=value …` and parse its pairs. Matches the
 * BARE binary name only — a path-qualified `./tenaza` runs whatever file
 * sits there, so it is not provably the label call. A malformed pair is
 * skipped rather than failing the whole command; returns `undefined` (not
 * `{}`) so a caller can tell "not a label command" apart from "a label
 * command with nothing in it."
 *
 * Only a PURE label command counts: any shell syntax that could run
 * something else — chaining, pipes, substitution, redirection, a
 * background `&`, quoting — hands the whole command to the Policy instead.
 * Values are single words for the same reason: an unbalanced quote split on
 * whitespace would make the whole command not a label, rather than cut a
 * value.
 */
export function parseLabelCommand(command: string): Record<string, string> | undefined {
  if (SHELL_SYNTAX.test(command)) return undefined;
  const match = command.trim().match(/^tenaza\s+label(?:\s+(.*))?$/);
  if (!match) return undefined;

  const labels: Record<string, string> = {};
  for (const token of (match[1] ?? "").trim().split(/\s+/)) {
    if (!token) continue;
    const pair = token.match(LABEL_PAIR);
    if (pair) {
      labels[pair[1] as string] = pair[2] ?? pair[3] ?? pair[4] ?? "";
      continue;
    }
    if (/['"]/.test(token)) return undefined;
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

/**
 * `inboxId` is `undefined` exactly when it could not be derived — the deny
 * still holds either way; the agent is pointed at `tenaza status` instead
 * of a dead-end id. When present, it is already the item's short hash —
 * the same string `tenaza status`, the statusline and the notification
 * show, never a raw position.
 */
export function denyMessage(inboxId: string | undefined): string {
  const location = inboxId !== undefined ? `inbox ${inboxId}` : "the Inbox — run `tenaza status` to find it";
  return `Reserved for the human, ${location}. Do not retry or work around it. Tell the user, and continue.`;
}

function buildHookResponse(
  decision: "allow" | "deny",
  reason: string,
  additionalContext?: string,
): ClaudeHookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
      ...(additionalContext ? { additionalContext } : {}),
    },
  };
}

/** The agent-facing reason for a live-answering APPROVE — names what happened instead of reusing `denyMessage`'s deny-shaped wording. */
function liveApproveReason(): string {
  return "Approved by the human from the Live surface.";
}

function describeSkippedLines(skipped: number): string {
  return `${skipped} log line${skipped === 1 ? "" : "s"} could not be read and ${
    skipped === 1 ? "was" : "were"
  } skipped.`;
}

/**
 * Attaches to a response already being returned — never a reason to build
 * one that otherwise wouldn't exist. `skippedLines` comes from the one
 * read `decideAction` already needed, never a second rescan of the log.
 */
function withSkippedLinesWarning(response: ClaudeHookResponse, skippedLines: number | undefined): ClaudeHookResponse {
  if (!skippedLines) return response;
  return { ...response, systemMessage: describeSkippedLines(skippedLines) };
}

/**
 * Backfills `session.started` from this call's own `cwd` when the Session
 * never had one — a Session whose start hook never fired (it predates
 * Tenaza's install) still lands under a real project on the next call that
 * carries a `cwd`. A no-op when `cwd` is absent or the Session already has
 * one; otherwise a side effect, swallowed on failure like every other
 * lifecycle write in this file.
 *
 * Deliberately NEVER called from `handleSubagentStop`: that event DOES
 * carry `cwd`, so backfilling there would give Claude Code's own internal
 * side-agents a `session.started` too — undoing `isNoiseSession`'s hide,
 * which exists precisely to filter them out.
 */
function backfillSessionStartedIfMissing(
  home: string,
  session: string,
  cwd: string | undefined,
  parent: string | undefined,
): void {
  if (!cwd) return;
  try {
    if (sessionHasStarted(session, home)) return;
    appendEvent(
      home,
      sessionStartedEvent(session, { parent, runtime: "claude", cwd, capabilities: CLAUDE_CAPABILITIES }),
    );
  } catch {
    // See the doc comment above.
  }
}

function labelsFromLog(home: string, session: string): Record<string, string> {
  return buildSessionIndex(readSessionEvents(session, home)).get(session)?.labels ?? {};
}

function writeLabelsMarker(home: string, session: string, labels: Record<string, string>): void {
  try {
    writeFileSync(sessionLabelsMarkerPath(session, home), JSON.stringify(labels), "utf8");
  } catch {}
}

function recordLabels(
  home: string,
  session: string,
  previous: Record<string, string>,
  labels: Record<string, string>,
): void {
  writeLabelsMarker(home, session, { ...previous, ...labels });
}

/**
 * Decide one PreToolUse call against the Policy. `undefined` means there
 * is nothing to tell the host: no Action normalized, it was a
 * `tenaza label` announce, or the Policy's verdict was an allow.
 */
async function handlePreToolUse(
  home: string,
  payload: ClaudeHookPayload,
): Promise<ClaudePreToolUseOutput | undefined> {
  // agent_id names a subagent's OWN session, never its parent's
  // session_id — resolved once, used everywhere below.
  const session = payload.agent_id ?? payload.session_id;
  // Touch before anything else: a long-running call's own start is worth
  // showing immediately, not only once it completes.
  touchSession(home, session);
  backfillSessionStartedIfMissing(home, session, payload.cwd, payload.agent_id ? payload.session_id : undefined);

  const action = normalizeClaudeAction(payload);
  if (!action) return undefined;

  if (action.kind === "shell") {
    const labels = parseLabelCommand(action.command);
    if (labels) {
      const previous = readLabels(home, session);
      // Never routed through the Policy: an announce isn't a Rule match,
      // so it's never logged as one.
      appendEvent(home, sessionLabeledEvent(session, labels));
      recordLabels(home, session, previous, labels);
      if (labels.verdict === "parked" && previous.verdict !== "parked") notifyParked(home, session);
      return undefined;
    }
  }

  const unrecorded = action.kind === "shell" && isUnrecordedLabel(action.command);
  const response = await decidePreToolUse(home, session, action);
  return unrecorded ? withLabelNotRecorded(response) : response;
}

/**
 * A command that names `tenaza label` but is not shaped like a pure one — so
 * its label was dropped. A pure-shaped `tenaza label` with no usable pair is
 * not one of these: it was run as told, and degrades silently.
 */
function isUnrecordedLabel(command: string): boolean {
  if (!MENTIONS_LABEL.test(command)) return false;
  const pureShaped = !SHELL_SYNTAX.test(command) && /^tenaza\s+label(?:\s+[^'"]*)?$/.test(command.trim());
  return !pureShaped;
}

/** Tells the agent its `tenaza label` was not recorded, layered onto whatever the Policy already answered — a deny's reason, or a decision-less `additionalContext` that never becomes an implicit allow. */
function withLabelNotRecorded(response: ClaudePreToolUseOutput | undefined): ClaudePreToolUseOutput {
  const specific = response?.hookSpecificOutput;
  const additionalContext = [specific?.additionalContext, LABEL_NOT_RECORDED].filter(Boolean).join(" ");
  return {
    ...(response ?? {}),
    hookSpecificOutput: { ...(specific ?? { hookEventName: "PreToolUse" }), additionalContext },
  };
}

/** The Policy's answer for one Action that is not a pure label command. */
async function decidePreToolUse(
  home: string,
  session: string,
  action: Action,
): Promise<ClaudePreToolUseOutput | undefined> {
  const result = await decideAction(home, session, action, CLAUDE_CAPABILITIES);
  const skippedLines = result.logged ? result.skippedLines : undefined;

  if (result.decision === "deny") {
    // result.reason carries the live-answering wording (a reject's own
    // message, the generic fallback, or the es-AR expiry text) when this
    // deny came from a hold; denyMessage(inboxId) is the fallback when no
    // Daemon answered.
    return withSkippedLinesWarning(buildHookResponse("deny", result.reason ?? denyMessage(result.inboxId)), skippedLines);
  }

  // A live-answering APPROVE is the ONE allow that should skip Claude
  // Code's own auto-mode classifier — the human already said yes. Every
  // OTHER allow returns NO permission decision at all: an explicit hook
  // `allow` runs BEFORE that classifier and skips it, which is LESS safe
  // than saying nothing for any of those cases.
  if (result.decision === "allow" && result.logged && result.live) {
    return withSkippedLinesWarning(
      buildHookResponse("allow", liveApproveReason(), result.additionalContext),
      skippedLines,
    );
  }

  // A skipped-log-line warning, when there is one, rides along as a bare
  // systemMessage with no permission decision.
  return skippedLines ? { systemMessage: describeSkippedLines(skippedLines) } : undefined;
}

/** Best-effort mirror of the sample just logged: the `usage.sampled` Event stays the record. */
function recordLatestUsageSample(home: string, session: string, contextTokens: number): void {
  try {
    writeFileSync(usageSampleMarkerPath(session, home), String(contextTokens), "utf8");
  } catch {}
}

/**
 * Samples `session`'s context size and appends `usage.sampled` — only when
 * the transcript yields a number. A missing or unreadable transcript
 * degrades to doing nothing: a zero sample would be a LIE ("this Session
 * uses no context"), not an honest "unknown."
 *
 * The running max is read BEFORE this sample is appended, never after —
 * appending first would make the new sample its own "previous max," and
 * crossing the threshold could never be detected.
 */
function sampleUsage(home: string, session: string, transcriptPath: string | undefined): void {
  if (!transcriptPath) return;
  const contextTokens = measureContextTokens(transcriptPath);
  if (contextTokens === undefined) return;

  const previousMax = maxUsageSample(readSessionEvents(session, home));
  appendEvent(home, usageSampledEvent(session, { context_tokens: contextTokens }));
  recordLatestUsageSample(home, session, contextTokens);

  const { thresholdTokens } = loadPolicy(home);
  if (shouldNotifyThresholdCrossing(previousMax, contextTokens, thresholdTokens)) {
    notifyThresholdCrossed(home, session, contextTokens, thresholdTokens);
  }
}

/**
 * SessionStart: a new top-level Session — no parent. The append is wrapped
 * in its own catch: a write failure here (e.g. an unwritable state dir)
 * must never crash the hook call and skip the self-check that
 * `runClaudeHookSafely` runs right after. A Session left without its own
 * `session.started` still gets one backfilled from a later Event's `cwd`
 * — but never with a terminal locator, since the backfill never runs here.
 *
 * Captures the terminal locator (`captureTerminalLocator`) — never for a
 * SUBAGENT (`handleSubagentStart`): a subagent's card focuses its parent's
 * terminal, resolved from the parent's own node at click time, so a
 * subagent's `session.started` carries no `terminal` field at all.
 *
 * Also captures `pid`/`pidStartedAt` (`captureProcessMarker`) — UNLIKE the
 * terminal locator, this IS also captured for a subagent: it shares the
 * SAME OS process as its parent, so its own liveness check needs no
 * parent walk.
 */
export function handleSessionStart(home: string, payload: ClaudeSessionStartPayload): void {
  try {
    const marker = captureProcessMarker();
    appendEvent(
      home,
      sessionStartedEvent(payload.session_id, {
        runtime: "claude",
        cwd: payload.cwd,
        capabilities: CLAUDE_CAPABILITIES,
        terminal: captureTerminalLocator(),
        pid: marker.pid,
        pidStartedAt: marker.startedAt,
      }),
    );
  } catch {
    // See the doc comment above.
  }
}

/**
 * SubagentStart: its own Session, keyed by `agent_id`, parented to
 * `session_id`. Swallows a failed write the way `handleSessionStart` does,
 * so a subagent keeps its announce declaration exactly when a top-level
 * Session would.
 */
export function handleSubagentStart(home: string, payload: ClaudeSubagentStartPayload): void {
  try {
    const marker = captureProcessMarker();
    appendEvent(
      home,
      sessionStartedEvent(payload.agent_id, {
        parent: payload.session_id,
        runtime: "claude",
        cwd: payload.cwd,
        capabilities: CLAUDE_CAPABILITIES,
        pid: marker.pid,
        pidStartedAt: marker.startedAt,
      }),
    );
  } catch {
    // See the doc comment above.
  }
}

/**
 * SubagentStop: the subagent Session (`agent_id`) ended. Claude Code's own
 * payload carries no free-text reason, so this constant is Tenaza's own
 * word for it. Samples usage from `agent_transcript_path` — NEVER
 * `transcript_path`, which here names the PARENT's transcript: a
 * subagent's context is its own, never folded into its parent's.
 *
 * Deliberately omits `backfillSessionStartedIfMissing` — see that
 * function's own doc for why.
 *
 * Measured on the real `~/.tenaza/state` (216 such logs in 24h, 89%
 * inside a `run_in_background` window): Claude Code's own INTERNAL
 * side-agents fire SubagentStop WITHOUT ever firing SubagentStart —
 * nothing observed for this `agent_id` at all before this call. Appending
 * unconditionally used to BORN a brand-new log holding only this one
 * Event, which the board then rendered as a phantom "(sin proyecto) · sin
 * datos" card — one per side-agent, forever. Fixed at the source: an
 * `agent_id` with no existing log gets nothing written here. A real
 * subagent's log already exists either way, so it is unaffected.
 */
export function handleSubagentStop(home: string, payload: ClaudeSubagentStopPayload): void {
  if (readSessionEvents(payload.agent_id, home).length === 0) return;
  appendEvent(home, sessionEndedEvent(payload.agent_id, "subagent_stop"));
  sampleUsage(home, payload.agent_id, payload.agent_transcript_path);
}

export function handleSessionEnd(home: string, payload: ClaudeSessionEndPayload): void {
  backfillSessionStartedIfMissing(home, payload.session_id, payload.cwd, undefined);
  appendEvent(home, sessionEndedEvent(payload.session_id, payload.reason));
  sampleUsage(home, payload.session_id, payload.transcript_path);
}

/**
 * Stop: the main agent finished a Turn — samples usage, never ends the
 * Session (that's SessionEnd's job).
 *
 * Also appends `turn.ended`, UNCONDITIONALLY and LAST, after
 * `sampleUsage`: `sessions.ts`'s `turnWaitSince` reads "nothing happened
 * since the Turn ended" off this call's newest Event, with no ~60s wait
 * for an `idle_prompt`. Wrapped in its own try/catch, same as every other
 * lifecycle append in this file. Do not also touch the session here:
 * writing a separate touched-file after this append could make a board
 * tick see that file's mtime as newer than `turn.ended`'s own `ts`, which
 * `turnWaitSince`'s strict equality check would then read as already
 * superseded, silently losing the turn-boundary signal.
 */
export function handleStop(home: string, payload: ClaudeStopPayload): void {
  backfillSessionStartedIfMissing(home, payload.session_id, payload.cwd, undefined);
  sampleUsage(home, payload.session_id, payload.transcript_path);
  try {
    appendEvent(home, turnEndedEvent(payload.session_id));
  } catch {
    // See the doc comment above.
  }
}

/**
 * Claude Code's real PostToolUse payload inside a subagent never carries
 * `agent_transcript_path` — that field is SubagentStop's only — so every
 * 25th-call sample was silently skipped for a subagent's whole life until
 * this derivation existed (measured: subagents with 60/198/293 counted
 * tool calls, zero mid-run samples). A parent transcript at
 * `<dir>/<id>.jsonl` has its running subagents' own transcripts at
 * `<dir>/<id>/subagents/agent-<agent_id>.jsonl` — a sibling directory, not
 * the parent's transcript itself.
 */
function deriveSubagentTranscriptPath(parentTranscriptPath: string, agentId: string): string {
  const dir = path.dirname(parentTranscriptPath);
  const base = path.basename(parentTranscriptPath, ".jsonl");
  return path.join(dir, base, "subagents", `agent-${agentId}.jsonl`);
}

/**
 * Never falls back to sampling the parent's transcript directly when
 * derivation fails — that would silently attribute the PARENT's tokens to
 * this subagent. A missing or unreadable derived file degrades to no
 * sample instead, same as any other transcript `sampleUsage` handles.
 */
function resolveSampleTranscriptPath(payload: ClaudePostToolUsePayload): string | undefined {
  if (!payload.agent_id) return payload.transcript_path;
  if (payload.agent_transcript_path) return payload.agent_transcript_path;
  return payload.transcript_path
    ? deriveSubagentTranscriptPath(payload.transcript_path, payload.agent_id)
    : undefined;
}

export function shouldNudgeCheckpoint(latestSample: number | undefined, thresholdTokens: number): boolean {
  return latestSample !== undefined && latestSample >= thresholdTokens;
}

/** Only a run isolated on its own branch announces both; a session building on the current branch announces `ticket` alone and cannot checkpoint. */
export function isDispatchedRun(labels: Record<string, string>): boolean {
  return Boolean(labels.ticket) && Boolean(labels.base);
}

const EXIT_VERDICTS = new Set(["done", "parked", "checkpoint", "fail-fast"]);

/** A closed list: a run sent back overwrites `verdict` with any other value, and an unknown one reopens the nudge. */
export function hasExitVerdict(labels: Record<string, string>): boolean {
  return labels.verdict !== undefined && EXIT_VERDICTS.has(labels.verdict);
}

function readLatestUsageSample(home: string, session: string): number | undefined {
  try {
    const raw = readFileSync(usageSampleMarkerPath(session, home), "utf8").trim();
    if (raw === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Writes even `{}`, so an unlabelled Session replays its log once, never on every PostToolUse. */
function readLabels(home: string, session: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(sessionLabelsMarkerPath(session, home), "utf8"));
  } catch {
    const healed = labelsFromLog(home, session);
    writeLabelsMarker(home, session, healed);
    return healed;
  }
}

/** The latest sample, not the max: once a compaction lowers the reading, the next sample stops the nudge. */
function checkpointNudge(home: string, session: string): ClaudeContextOutput | undefined {
  const labels = readLabels(home, session);
  if (!isDispatchedRun(labels) || hasExitVerdict(labels)) return undefined;
  if (!shouldNudgeCheckpoint(readLatestUsageSample(home, session), loadPolicy(home).thresholdTokens)) return undefined;
  return { hookEventName: "PostToolUse", additionalContext: CHECKPOINT_NUDGE };
}

/**
 * PostToolUse: counts one tool call for the resolved Session, sampling
 * usage on exactly the 25th (and every 25th after). Keyed by
 * `agent_id ?? session_id`, like `PreToolUse` — a subagent's own tool
 * calls must land in ITS log, never its parent's. Also touches the
 * session's activity marker on every call — never an Event, so this never
 * grows the log.
 */
export function handlePostToolUse(home: string, payload: ClaudePostToolUsePayload): ClaudeContextOutput | undefined {
  const session = payload.agent_id ?? payload.session_id;
  touchSession(home, session);
  backfillSessionStartedIfMissing(home, session, payload.cwd, payload.agent_id ? payload.session_id : undefined);
  const count = countToolCall(home, session);
  if (shouldSampleOnToolCall(count)) {
    sampleUsage(home, session, resolveSampleTranscriptPath(payload));
  }
  return checkpointNudge(home, session);
}

/**
 * UserPromptSubmit: the human just submitted a new turn — once per turn,
 * never per tool call. Appends `prompt.submitted`, which moves
 * `lastEventTs` forward — so a stale `notification.observed` is
 * superseded the instant real human activity resumes. Wrapped in its own
 * try/catch, same as every other lifecycle append in this file.
 */
export function handleUserPromptSubmit(home: string, payload: ClaudeUserPromptSubmitPayload): void {
  const session = payload.agent_id ?? payload.session_id;
  try {
    appendEvent(home, promptSubmittedEvent(session));
  } catch {
    // See the doc comment above.
  }
}

/**
 * Notification: Claude Code's OWN signal that it is showing a permission
 * prompt, or that a turn has sat idle, nobody answering — NEVER Tenaza's
 * own `human` Rule hold (contrast `action.decided`'s `"held"`, which
 * Tenaza itself raised and can resolve with an answer). Every other
 * `notification_type` is a silent no-op. Wrapped in its own try/catch,
 * same as every other lifecycle append in this file.
 */
export function handleNotification(home: string, payload: ClaudeNotificationPayload): void {
  const kind = payload.notification_type;
  if (kind !== "permission_prompt" && kind !== "idle_prompt") return;
  const session = payload.agent_id ?? payload.session_id;
  try {
    appendEvent(home, notificationObservedEvent(session, kind as NotificationKind));
  } catch {
    // See the doc comment above.
  }
}

/**
 * Dispatch one hook call by `hook_event_name`. Only PreToolUse answers
 * with a permission decision; SessionStart/SubagentStart/PostToolUse
 * answer with context only; every other event just appends and tells the
 * host nothing. Overloaded so a PreToolUse caller gets PreToolUse's own
 * output shape, never the context-only one.
 */
export async function handleClaudeHook(home: string, payload: ClaudeHookPayload): Promise<ClaudePreToolUseOutput | undefined>;
export async function handleClaudeHook(home: string, payload: ClaudeHookInput): Promise<ClaudeHookOutput | undefined>;
export async function handleClaudeHook(
  home: string,
  payload: ClaudeHookInput,
): Promise<ClaudeHookOutput | undefined> {
  switch (payload.hook_event_name) {
    case "PreToolUse":
      return await handlePreToolUse(home, payload);
    case "SessionStart":
      handleSessionStart(home, payload);
      return declarationResponse("SessionStart");
    case "SubagentStart":
      handleSubagentStart(home, payload);
      return declarationResponse("SubagentStart");
    case "SubagentStop":
      handleSubagentStop(home, payload);
      return undefined;
    case "SessionEnd":
      handleSessionEnd(home, payload);
      return undefined;
    case "Stop":
      handleStop(home, payload);
      return undefined;
    case "PostToolUse": {
      const nudge = handlePostToolUse(home, payload);
      return nudge ? { hookSpecificOutput: nudge } : undefined;
    }
    case "UserPromptSubmit":
      handleUserPromptSubmit(home, payload);
      return undefined;
    case "Notification":
      handleNotification(home, payload);
      return undefined;
    default:
      return undefined;
  }
}

/**
 * What `tenaza hook claude` actually prints to stdout: widens
 * `ClaudeHookResponse` so `hookSpecificOutput` becomes optional —
 * `runClaudeHookSafely` needs to print a bare `{ systemMessage }` with no
 * permission decision, which `ClaudeHookResponse` can't express — and so
 * it may also be a context-only answer (`ClaudeContextOutput`),
 * discriminated on `hookEventName`. A PreToolUse caller sees
 * `ClaudePreToolUseOutput` instead.
 */
export interface ClaudeHookOutput {
  systemMessage?: string;
  hookSpecificOutput?: ClaudeHookResponse["hookSpecificOutput"] | ClaudeContextOutput;
}

/** PreToolUse's own answer: a permission decision or nothing, never context-only output. */
export interface ClaudePreToolUseOutput extends ClaudeHookOutput {
  hookSpecificOutput?: ClaudeHookResponse["hookSpecificOutput"];
}

/** A context-only `hookSpecificOutput`, never a decision. */
export interface ClaudeContextOutput {
  hookEventName: "SessionStart" | "SubagentStart" | "PostToolUse";
  additionalContext: string;
}

export interface HookOutcome {
  output: ClaudeHookOutput | undefined;
  /** Set exactly when this call was degraded — what broke, and whether it's grave — for `tenaza hook claude` to record to `state/health.json`. */
  degraded?: { message: string; grave: boolean };
}

function faultMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The answer to an unanticipated fault: `systemMessage` only, for every
 * event, never a `hookSpecificOutput`. An explicit hook `allow` runs
 * BEFORE Claude Code's own auto-mode classifier and skips it — answering
 * "allow" on a fault would be LESS safe than no Tenaza at all. Saying
 * nothing reproduces "the call goes ahead exactly as if Tenaza were not
 * installed."
 */
function faultResponse(message: string): ClaudeHookOutput {
  return { systemMessage: message };
}

/**
 * Re-checks whether the Policy itself is degraded — cheap (one small file,
 * re-read and re-parsed; never scans a Session log) and safe on every
 * PreToolUse call, unlike a full log rescan, which once ran on every call
 * and scaled with the number of Sessions. Combines with whatever
 * `response` already carries rather than overwriting it.
 */
function withPolicyDegradation(home: string, response: ClaudeHookOutput | undefined): HookOutcome {
  const warning = policyWarning(home);
  const existing = response?.systemMessage;
  if (!warning && !existing) return { output: response };

  const message = [existing, warning?.message].filter((part): part is string => Boolean(part)).join(" ");
  return {
    output: { ...(response ?? {}), systemMessage: message },
    degraded: { message, grave: warning?.grave ?? false },
  };
}

/**
 * Composes the SessionStart self-check onto whatever `handleClaudeHook`
 * already answered — the announce declaration, which a failing check
 * never removes. Mirrors `withPolicyDegradation`'s shape: a failing check
 * becomes both this call's `systemMessage` and the `degraded` report
 * `runHookClaude` writes to `state/health.json`, firing a macOS
 * notification when it's grave.
 */
function withSelfCheck(home: string, response: ClaudeHookOutput | undefined): HookOutcome {
  const fault = runSelfCheck(home);
  if (!fault) return { output: response };
  return { output: { ...(response ?? {}), systemMessage: fault.message }, degraded: fault };
}

/**
 * Runs one `tenaza hook claude` call: a top-level try/catch around the
 * entire dispatch, payload parsing included, so any unanticipated fault
 * degrades to "no block, the call goes ahead" instead of crashing the
 * process with nothing printed — an uncaught throw here once meant Claude
 * Code saw no decision at all. Known fault paths (a malformed Policy, a
 * torn log line) are already tolerated further down and surface as
 * `degraded` rather than a throw; this catch is the backstop for
 * everything else, a malformed payload included.
 *
 * Two events get their own post-processing on top of `handleClaudeHook`'s
 * dispatch: PreToolUse re-checks the Policy, and SessionStart runs the
 * self-check (never SubagentStart). Every other event passes
 * `handleClaudeHook`'s response straight through.
 */
export async function runClaudeHookSafely(home: string, raw: string): Promise<HookOutcome> {
  try {
    const payload = JSON.parse(raw);
    const response = await handleClaudeHook(home, payload);

    if (payload?.hook_event_name === "PreToolUse") {
      return withPolicyDegradation(home, response);
    }
    if (payload?.hook_event_name === "SessionStart") {
      return withSelfCheck(home, response);
    }

    return { output: response };
  } catch (error) {
    const message = `Tenaza guardrail degraded (${faultMessage(error)}) — Claude Code's own permission checks still apply.`;
    return { output: faultResponse(message), degraded: { message, grave: false } };
  }
}
