import type { Action, Capability } from "../contract/event";
import { sessionEndedEvent, sessionStartedEvent } from "../contract/event";
import { decideAction } from "../decide";
import { appendEvent } from "../log";
import { isShellRule } from "../policy";

/**
 * A test Adapter (ADR 0001, ticket 06): it emits the same Events every real
 * Adapter does, but DELIBERATELY declares fewer Capabilities than the Claude
 * Adapter does — no `measure`, no `block` — so tests prove the core degrades
 * by Capability, never by runtime name. It is never wired into a real agent
 * runtime; it exists only behind `tenaza hook fake`, for the test seam
 * itself.
 */
export const FAKE_CAPABILITIES: Capability[] = ["observe"];

/** A new Session (optionally a subagent of `parent`), mirroring a real runtime's start hook. */
export interface FakeStartPayload {
  kind: "start";
  session: string;
  parent?: string;
  cwd?: string;
}

/** One attempted Action — the fake Adapter only ever normalizes a `shell` command, same as Claude's. */
export interface FakeActionPayload {
  kind: "action";
  session: string;
  command: string;
}

/** A Session ending. */
export interface FakeEndPayload {
  kind: "end";
  session: string;
  reason?: string;
}

export type FakeHookInput = FakeStartPayload | FakeActionPayload | FakeEndPayload;

export interface FakeHookResponse {
  decision: "allow" | "deny";
  message: string;
}

function normalizeFakeAction(payload: FakeActionPayload): Action {
  return { kind: "shell", command: payload.command, tool: "fake" };
}

/**
 * Decide one fake Action against the Policy, declaring this Adapter's own
 * (narrower) Capabilities. `decideAction` is the one place that enforces
 * ADR 0001's degradation — this Adapter never checks `block` itself, it
 * only reports whatever the core already decided, honestly.
 */
async function handleFakeAction(
  home: string,
  payload: FakeActionPayload,
): Promise<FakeHookResponse | undefined> {
  const action = normalizeFakeAction(payload);
  const result = await decideAction(home, payload.session, action, FAKE_CAPABILITIES);

  if (result.decision === "deny") {
    // Unreachable while FAKE_CAPABILITIES excludes "block" — decideAction
    // itself refuses to deny without it. Kept so this branch stays honest
    // if this Adapter's declared Capabilities ever change.
    return { decision: "deny", message: `Reserved for the human, inbox #${result.inboxId ?? "?"}.` };
  }
  if (result.logged) {
    const enforceable = result.rule.effect !== "human";
    // This Adapter only ever normalizes a `shell` Action (above), so the
    // matched Rule is always a `shell` Rule too — `isShellRule` just keeps
    // that honest for the type checker now that `Rule` also covers `mcp`.
    const label = isShellRule(result.rule) ? result.rule.match : result.rule.tool;
    return {
      decision: "allow",
      message: enforceable
        ? `Flagged by Policy rule "${label}" and recorded.`
        : `Matched Policy rule "${label}" (effect: human), but this Adapter has no "block" Capability — could not be denied. Recorded instead.`,
    };
  }
  return undefined;
}

/** Dispatch one fake hook call by its `kind`. Only "action" ever answers back; "start" and "end" just append what they have. */
export async function handleFakeHook(
  home: string,
  payload: FakeHookInput,
): Promise<FakeHookResponse | undefined> {
  switch (payload.kind) {
    case "start":
      appendEvent(
        home,
        sessionStartedEvent(payload.session, {
          parent: payload.parent,
          runtime: "fake",
          cwd: payload.cwd ?? "",
          capabilities: FAKE_CAPABILITIES,
        }),
      );
      return undefined;
    case "action":
      return await handleFakeAction(home, payload);
    case "end":
      appendEvent(home, sessionEndedEvent(payload.session, payload.reason ?? "fake_end"));
      return undefined;
  }
}
