import type { Action } from "../contract/event";
import { decideAction } from "../decide";

/** The subset of Claude Code's PreToolUse hook payload Tenaza reads. */
export interface ClaudeHookPayload {
  session_id: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface ClaudeHookResponse {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
  };
}

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
export function handleClaudeHook(
  home: string,
  payload: ClaudeHookPayload,
): ClaudeHookResponse | undefined {
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
