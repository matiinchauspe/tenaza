import type { Action, Capability } from "../contract/event";
import {
  sessionEndedEvent,
  sessionLabeledEvent,
  sessionStartedEvent,
  usageSampledEvent,
} from "../contract/event";
import { decideAction } from "../decide";
import { appendEvent } from "../log";
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

export function denyMessage(inboxId: number): string {
  return (
    `Reserved for the human, inbox #${inboxId}. ` +
    "Do not retry or work around it. Tell the user, and continue."
  );
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

  if (result.decision === "deny") {
    return buildHookResponse("deny", denyMessage(result.inboxId));
  }
  if (result.logged) {
    return buildHookResponse(
      "allow",
      `Flagged by Policy rule "${result.rule.match}" and recorded.`,
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
 */
function sampleUsage(home: string, session: string, transcriptPath: string | undefined): void {
  if (!transcriptPath) return;
  const contextTokens = measureContextTokens(transcriptPath);
  if (contextTokens === undefined) return;
  appendEvent(home, usageSampledEvent(session, { context_tokens: contextTokens }));
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
