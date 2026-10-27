import type { ActionSummary, BoardInboxItem, BoardPayload, BoardSession } from "../../src/contract/live";

/** A minimal, valid `BoardPayload` — tests spread in only the fields they care about. */
export function makeBoardPayload(overrides: Partial<BoardPayload> = {}): BoardPayload {
  return {
    v: 1,
    policy: { stallMinutes: 15, contextThresholdTokens: 200_000, waitSeconds: 180 },
    sessions: [],
    inbox: [],
    ...overrides,
  };
}

export function makeSession(overrides: Partial<BoardSession> = {}): BoardSession {
  return {
    id: "sess-1",
    project: "tenaza",
    role: "sesión",
    hasMeasureCapability: true,
    resolutions: [],
    terminalReach: "unknown",
    terminalNeedsTcc: false,
    ...overrides,
  };
}

/** `action` overrides merge onto the default shell "gh pr merge 58" action — e.g. `makeInboxItem({ action: { kind: "mcp", tool: "mcp__neon__run_sql", command: undefined } })`. */
export function makeInboxItem(
  overrides: Partial<Omit<BoardInboxItem, "action">> & { action?: Partial<ActionSummary> } = {},
): BoardInboxItem {
  const { action, ...rest } = overrides;
  return {
    id: "a1b2",
    sessionId: "sess-1",
    project: "tenaza",
    ts: "2026-01-01T00:00:00.000Z",
    action: { kind: "shell", tool: "Bash", command: "gh pr merge 58", ...action },
    blocked: true,
    decision: "deny",
    terminalReach: "unknown",
    terminalNeedsTcc: false,
    ...rest,
  };
}
