import type { Action, Capability } from "../contract/event";
import { sessionEndedEvent, sessionStartedEvent } from "../contract/event";
import { decideAction } from "../decide";
import { appendEvent } from "../log";

/** The subset of Claude Code's PreToolUse hook payload Tenaza reads. */
export interface ClaudeHookPayload {
  session_id: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
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

/** A subagent Session ending — `agent_id` names it, not the parent `session_id`. */
export interface ClaudeSubagentStopPayload {
  session_id: string;
  hook_event_name: "SubagentStop";
  agent_id: string;
}

/** The top-level Session ending, carrying the runtime's own reason. */
export interface ClaudeSessionEndPayload {
  session_id: string;
  hook_event_name: "SessionEnd";
  reason: string;
}

export type ClaudeHookInput =
  | ClaudeHookPayload
  | ClaudeSessionStartPayload
  | ClaudeSubagentStartPayload
  | ClaudeSubagentStopPayload
  | ClaudeSessionEndPayload;

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
 * runtime name (ADR 0001). `measure` (usage.sampled) and `stop` are not yet
 * implemented, so neither is claimed here.
 */
const CLAUDE_CAPABILITIES: Capability[] = ["observe", "block"];

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
 * didn't normalize to an Action, or it normalized but matched no Rule
 * (allowed and NOT logged, per the Policy's own rule).
 */
function handlePreToolUse(home: string, payload: ClaudeHookPayload): ClaudeHookResponse | undefined {
  const action = normalizeClaudeAction(payload);
  if (!action) return undefined;

  const result = decideAction(home, payload.session_id, action);

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
 * Tenaza's own word for it — distinct from SessionEnd's runtime-supplied one.
 */
export function handleSubagentStop(home: string, payload: ClaudeSubagentStopPayload): void {
  appendEvent(home, sessionEndedEvent(payload.agent_id, "subagent_stop"));
}

/** SessionEnd: the top-level Session (`session_id`) ended, with the runtime's own reason. */
export function handleSessionEnd(home: string, payload: ClaudeSessionEndPayload): void {
  appendEvent(home, sessionEndedEvent(payload.session_id, payload.reason));
}

/**
 * Dispatch one Claude Code hook call by its `hook_event_name`. Only
 * PreToolUse ever answers back with a permission decision; every lifecycle
 * event (SessionStart, SubagentStart, SubagentStop, SessionEnd) just appends
 * its Event and tells the host nothing.
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
    default:
      return undefined;
  }
}
