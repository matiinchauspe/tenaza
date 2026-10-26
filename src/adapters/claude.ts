import type { Action, Capability } from "../contract/event";
import {
  sessionEndedEvent,
  sessionLabeledEvent,
  sessionStartedEvent,
  usageSampledEvent,
} from "../contract/event";
import { decideAction } from "../decide";
import { appendEvent, readSessionEvents } from "../log";
import { maxUsageSample, notifyThresholdCrossed, shouldNotifyThresholdCrossing } from "../notify";
import { loadPolicy, policyWarning } from "../policy";
import { measureContextTokens } from "../transcript";
import { countToolCall, shouldSampleOnToolCall } from "../toolcalls";

/**
 * The subset of Claude Code's PreToolUse hook payload Tenaza reads.
 * `agent_id` is one of the hooks docs' own "common input fields": present on
 * EVERY hook event — PreToolUse included — when it fires inside a subagent
 * (verified 2026-10-23 against code.claude.com/docs/en/hooks, both its
 * "Common input fields" table and its PreToolUse section). Optional because
 * it's absent for a call in the main Session.
 */
export interface ClaudeHookPayload {
  session_id: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  agent_id?: string;
}

/** A new top-level Session. Never carries a parent — only SubagentStart does. */
export interface ClaudeSessionStartPayload {
  session_id: string;
  hook_event_name: "SessionStart";
  cwd: string;
}

/**
 * A Claude Code subagent starting. It is its OWN Session, keyed by `agent_id`
 * — never `session_id`, which stays the parent's id (the ticket's own rule).
 */
export interface ClaudeSubagentStartPayload {
  session_id: string;
  hook_event_name: "SubagentStart";
  agent_id: string;
  cwd: string;
}

/**
 * A subagent Session ending — `agent_id` names it, not the parent
 * `session_id`. `transcript_path` is optional: a payload that omits it (or
 * names a transcript with no readable usage) still ends the Session, just
 * without a usage sample — degrades silently, never a crash (q9).
 */
export interface ClaudeSubagentStopPayload {
  session_id: string;
  hook_event_name: "SubagentStop";
  agent_id: string;
  transcript_path?: string;
}

/** The top-level Session ending, carrying the runtime's own reason. `transcript_path` is optional — see `ClaudeSubagentStopPayload`. */
export interface ClaudeSessionEndPayload {
  session_id: string;
  hook_event_name: "SessionEnd";
  reason: string;
  transcript_path?: string;
}

/** The main agent finishing one turn — samples usage, but never ends the Session (that's SessionEnd's job). */
export interface ClaudeStopPayload {
  session_id: string;
  hook_event_name: "Stop";
  transcript_path?: string;
}

/**
 * One tool call completing. Counted toward the "every 25 tool calls" sample
 * (q9) — never logged itself, since an ordinary tool call matches no Policy
 * Rule and the Event contract only records what the Policy decided on.
 */
export interface ClaudePostToolUsePayload {
  session_id: string;
  hook_event_name: "PostToolUse";
  transcript_path?: string;
}

export type ClaudeHookInput =
  | ClaudeHookPayload
  | ClaudeSessionStartPayload
  | ClaudeSubagentStartPayload
  | ClaudeSubagentStopPayload
  | ClaudeSessionEndPayload
  | ClaudeStopPayload
  | ClaudePostToolUsePayload;

export interface ClaudeHookResponse {
  /**
   * A warning shown to the human, independent of any permission decision
   * (ADR 0007, ticket 01) — set only when `handlePreToolUse` below itself
   * noticed a degraded read (a skipped log line) while reaching this
   * decision. Purely additive: every pre-existing caller that never
   * references it (every test included) is unaffected.
   */
  systemMessage?: string;
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
  };
}

/**
 * What the Claude Code Adapter can do today — declared on every
 * `session.started` it writes, so the core degrades by Capability, never by
 * runtime name (ADR 0001). `measure` (usage.sampled) is implemented as of
 * ticket 04; `stop` (actually halting a Session) is not — v1 never stops a
 * Session (q9).
 */
const CLAUDE_CAPABILITIES: Capability[] = ["observe", "block", "measure"];

/**
 * Normalize a PreToolUse payload into a runtime-neutral Action. Only `Bash`
 * calls carrying a string command normalize to `shell` — everything else
 * (a non-Bash tool, or a Bash call Tenaza can't read a command from) is not
 * yet an Action Tenaza has a shape for, and is passed through untouched.
 */
export function normalizeClaudeAction(payload: ClaudeHookPayload): Action | undefined {
  if (payload.tool_name !== "Bash") return undefined;
  const command = payload.tool_input?.command;
  if (typeof command !== "string") return undefined;
  return { kind: "shell", command, tool: "Bash" };
}

/**
 * Recognize `tenaza label key=value …` and parse its pairs — the Yunque
 * announce mechanism (ADR 0003). Matches the binary by its bare or
 * path-qualified name so `tenaza label …`, `/opt/homebrew/bin/tenaza label
 * …` and similar all recognize; anything else (a different `tenaza`
 * subcommand, an unrelated command) returns `undefined`, never throws. A
 * token with no `=`, or an empty key, is skipped rather than failing the
 * whole command — one malformed pair never loses the rest. Returns
 * `undefined` (not an empty object) when nothing usable was found, so a
 * caller can tell "not a label command" apart from "a label command with
 * nothing in it" without checking size itself.
 */
export function parseLabelCommand(command: string): Record<string, string> | undefined {
  const match = command.trim().match(/^(?:\S*\/)?tenaza\s+label(?:\s+(.*))?$/);
  if (!match) return undefined;

  const labels: Record<string, string> = {};
  for (const pair of (match[1] ?? "").trim().split(/\s+/)) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

/**
 * `inboxId` is `undefined` exactly when `decideAction` could not derive it
 * (ADR 0007, ticket 01) — the deny still holds either way; the agent is
 * pointed at `tenaza status` instead of a dead-end id.
 */
export function denyMessage(inboxId: number | undefined): string {
  const location = inboxId !== undefined ? `inbox #${inboxId}` : "the Inbox — run `tenaza status` to find it";
  return `Reserved for the human, ${location}. Do not retry or work around it. Tell the user, and continue.`;
}

function buildHookResponse(
  decision: "allow" | "deny",
  reason: string,
): ClaudeHookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

function describeSkippedLines(skipped: number): string {
  return `${skipped} log line${skipped === 1 ? "" : "s"} could not be read and ${
    skipped === 1 ? "was" : "were"
  } skipped.`;
}

/**
 * Attach a skip-count warning directly onto a response this call is
 * ALREADY returning (ADR 0007, ticket 01) — never a reason to build one
 * that otherwise wouldn't exist. `skippedLines` only ever comes from
 * `decideAction`'s own result, itself derived from the ONE read that call
 * needed anyway (`deriveInboxReport`) — never a second, independent
 * rescan of every Session's log.
 */
function withSkippedLinesWarning(response: ClaudeHookResponse, skippedLines: number | undefined): ClaudeHookResponse {
  if (!skippedLines) return response;
  return { ...response, systemMessage: describeSkippedLines(skippedLines) };
}

/**
 * Decide one Claude Code PreToolUse call against the Policy. Returns
 * `undefined` when there is nothing to tell the host — either the call
 * didn't normalize to an Action, it was a `tenaza label` announce (handled
 * separately, below), or it normalized but matched no Rule (allowed and NOT
 * logged, per the Policy's own rule).
 */
function handlePreToolUse(home: string, payload: ClaudeHookPayload): ClaudeHookResponse | undefined {
  const action = normalizeClaudeAction(payload);
  if (!action) return undefined;

  if (action.kind === "shell") {
    const labels = parseLabelCommand(action.command);
    if (labels) {
      // The agent doesn't know its own Session id; this hook does (ADR
      // 0003) — `agent_id` names a subagent's OWN Session, never its
      // parent's `session_id`. Never routed through the Policy: an
      // announce isn't a Rule match, so it's never logged as one.
      appendEvent(home, sessionLabeledEvent(payload.agent_id ?? payload.session_id, labels));
      return undefined;
    }
  }

  const result = decideAction(home, payload.session_id, action, CLAUDE_CAPABILITIES);
  const skippedLines = result.logged ? result.skippedLines : undefined;

  if (result.decision === "deny") {
    return withSkippedLinesWarning(buildHookResponse("deny", denyMessage(result.inboxId)), skippedLines);
  }
  if (result.logged) {
    return withSkippedLinesWarning(
      buildHookResponse("allow", `Flagged by Policy rule "${result.rule.match}" and recorded.`),
      skippedLines,
    );
  }
  return undefined;
}

/**
 * Sample `session`'s context size from `transcriptPath` and append
 * `usage.sampled` — but only when the transcript actually yields a number.
 * No transcript, a missing file, or one with no readable usage all degrade
 * to doing nothing: a zero sample would be a LIE ("this Session uses no
 * context"), not an honest "unknown" (q9).
 *
 * Also where 🔴 fires (ticket 08): the running max BEFORE this sample is
 * read first (never after appending — appending it first would make the
 * new sample its own "previous max" and crossing could never be detected),
 * so `shouldNotifyThresholdCrossing` sees an honest "has this Session ever
 * been at or past the threshold before now."
 */
function sampleUsage(home: string, session: string, transcriptPath: string | undefined): void {
  if (!transcriptPath) return;
  const contextTokens = measureContextTokens(transcriptPath);
  if (contextTokens === undefined) return;

  const previousMax = maxUsageSample(readSessionEvents(session, home));
  appendEvent(home, usageSampledEvent(session, { context_tokens: contextTokens }));

  const { thresholdTokens } = loadPolicy(home);
  if (shouldNotifyThresholdCrossing(previousMax, contextTokens, thresholdTokens)) {
    notifyThresholdCrossed(home, session, contextTokens, thresholdTokens);
  }
}

/** SessionStart: a new top-level Session — no parent. */
export function handleSessionStart(home: string, payload: ClaudeSessionStartPayload): void {
  appendEvent(
    home,
    sessionStartedEvent(payload.session_id, {
      runtime: "claude",
      cwd: payload.cwd,
      capabilities: CLAUDE_CAPABILITIES,
    }),
  );
}

/** SubagentStart: its own Session, keyed by `agent_id`, parented to `session_id`. */
export function handleSubagentStart(home: string, payload: ClaudeSubagentStartPayload): void {
  appendEvent(
    home,
    sessionStartedEvent(payload.agent_id, {
      parent: payload.session_id,
      runtime: "claude",
      cwd: payload.cwd,
      capabilities: CLAUDE_CAPABILITIES,
    }),
  );
}

/**
 * SubagentStop: the subagent Session (`agent_id`) ended. Claude Code's own
 * SubagentStop payload carries no free-text reason, so this constant is
 * Tenaza's own word for it — distinct from SessionEnd's runtime-supplied
 * one. Also samples usage for `agent_id` (q9) — a subagent's context is its
 * own, never folded into its parent's.
 */
export function handleSubagentStop(home: string, payload: ClaudeSubagentStopPayload): void {
  appendEvent(home, sessionEndedEvent(payload.agent_id, "subagent_stop"));
  sampleUsage(home, payload.agent_id, payload.transcript_path);
}

/** SessionEnd: the top-level Session (`session_id`) ended, with the runtime's own reason. Also samples usage (q9). */
export function handleSessionEnd(home: string, payload: ClaudeSessionEndPayload): void {
  appendEvent(home, sessionEndedEvent(payload.session_id, payload.reason));
  sampleUsage(home, payload.session_id, payload.transcript_path);
}

/** Stop: the main agent finished a turn — sample usage for `session_id`. Never ends the Session. */
export function handleStop(home: string, payload: ClaudeStopPayload): void {
  sampleUsage(home, payload.session_id, payload.transcript_path);
}

/**
 * PostToolUse: count one tool call for `session_id`, sampling usage on
 * exactly the 25th (and every 25th after) — AC2's own boundary.
 */
export function handlePostToolUse(home: string, payload: ClaudePostToolUsePayload): void {
  const count = countToolCall(home, payload.session_id);
  if (!shouldSampleOnToolCall(count)) return;
  sampleUsage(home, payload.session_id, payload.transcript_path);
}

/**
 * Dispatch one Claude Code hook call by its `hook_event_name`. Only
 * PreToolUse ever answers back with a permission decision; every other
 * event (lifecycle, Stop, PostToolUse) just appends what it has and tells
 * the host nothing.
 */
export function handleClaudeHook(
  home: string,
  payload: ClaudeHookInput,
): ClaudeHookResponse | undefined {
  switch (payload.hook_event_name) {
    case "PreToolUse":
      return handlePreToolUse(home, payload);
    case "SessionStart":
      handleSessionStart(home, payload);
      return undefined;
    case "SubagentStart":
      handleSubagentStart(home, payload);
      return undefined;
    case "SubagentStop":
      handleSubagentStop(home, payload);
      return undefined;
    case "SessionEnd":
      handleSessionEnd(home, payload);
      return undefined;
    case "Stop":
      handleStop(home, payload);
      return undefined;
    case "PostToolUse":
      handlePostToolUse(home, payload);
      return undefined;
    default:
      return undefined;
  }
}

/**
 * What `tenaza hook claude` actually prints to stdout: `ClaudeHookResponse`
 * widened so `hookSpecificOutput` becomes OPTIONAL (ADR 0007, ticket 01) —
 * `runClaudeHookSafely` below needs to print a bare `{ systemMessage }`
 * with NO permission decision at all, which `ClaudeHookResponse` itself
 * cannot express. `handleClaudeHook` keeps returning the narrower,
 * unchanged `ClaudeHookResponse`, so every existing caller's type checking
 * against IT is unaffected; only this wider type is used for what
 * actually reaches stdout.
 */
export interface ClaudeHookOutput {
  systemMessage?: string;
  hookSpecificOutput?: ClaudeHookResponse["hookSpecificOutput"];
}

export interface HookOutcome {
  output: ClaudeHookOutput | undefined;
  /** Set exactly when this call was degraded — what broke, and whether it's grave (H3's "no LKG ever" case) — for `tenaza hook claude` to record to `state/health.json`. */
  degraded?: { message: string; grave: boolean };
}

function faultMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The answer to an UNANTICIPATED fault (ADR 0007 point 1, decision 08 —
 * `docs/research/hook-allow-vs-classifier.md`): `systemMessage` ONLY, for
 * EVERY event, never a `hookSpecificOutput`. An explicit hook `allow` runs
 * BEFORE Claude Code's own auto-mode classifier and SKIPS it — so
 * answering "allow" on a fault would be LESS safe than no Tenaza at all
 * (H2's own mistake, repeated). Saying nothing about the permission
 * decision is what actually reproduces "the call goes ahead exactly as if
 * Tenaza were not installed": Claude Code's own classifier and permission
 * checks run completely unaffected by this hook's answer.
 */
function faultResponse(message: string): ClaudeHookOutput {
  return { systemMessage: message };
}

/**
 * Re-check whether the Policy itself is degraded right now — cheap (one
 * small file, re-read and re-parsed; `policyWarning` never scans a
 * Session log) and safe to run on EVERY PreToolUse call regardless of
 * whether a Rule matched, unlike a full rescan of every Session's log
 * (that cost scaled with the number of Sessions and ran on every call —
 * ticket 01's own review caught it; `handlePreToolUse`'s
 * `withSkippedLinesWarning` above reports a skipped LOG line instead,
 * sourced from `decideAction`'s own necessary read, never a second one).
 * Combines with whatever `response` already carries (that skip warning,
 * when `handlePreToolUse` set one) rather than overwriting it.
 */
function withPolicyDegradation(home: string, response: ClaudeHookResponse | undefined): HookOutcome {
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
 * Run one `tenaza hook claude` call (ADR 0007, ticket 01): a top-level
 * try/catch around the ENTIRE dispatch — payload parsing included — so ANY
 * unanticipated fault degrades to "no block, the call goes ahead" instead
 * of crashing the process with nothing printed (H1's own root cause: an
 * uncaught throw here meant Claude Code saw no decision at all). Known
 * fault paths (a malformed Policy, a torn log line) are already tolerated
 * further down (`decideAction`, `loadPolicy`, `readLog`) and surface here
 * as `degraded` rather than a throw; this catch is strictly the backstop
 * for everything else — a malformed payload among them.
 */
export function runClaudeHookSafely(home: string, raw: string): HookOutcome {
  try {
    const payload = JSON.parse(raw);
    const response = handleClaudeHook(home, payload);

    if (payload?.hook_event_name !== "PreToolUse") {
      return { output: response };
    }

    return withPolicyDegradation(home, response);
  } catch (error) {
    const message = `Tenaza guardrail degraded (${faultMessage(error)}) — Claude Code's own permission checks still apply.`;
    return { output: faultResponse(message), degraded: { message, grave: false } };
  }
}
