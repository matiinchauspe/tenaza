import type { Action, Capability } from "../contract/event";
import {
  sessionEndedEvent,
  sessionLabeledEvent,
  sessionStartedEvent,
  usageSampledEvent,
} from "../contract/event";
import { decideAction } from "../decide";
import { runSelfCheck } from "../health";
import { appendEvent, readSessionEvents, sessionHasStarted } from "../log";
import { maxUsageSample, notifyThresholdCrossed, shouldNotifyThresholdCrossing } from "../notify";
import { loadPolicy, policyWarning } from "../policy";
import { captureTerminalLocator } from "../terminallocator";
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
  /** Common input field (ticket 05, M6) — read only to backfill a missing `session.started`, never otherwise. */
  cwd?: string;
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
 * `session_id`. `agent_transcript_path` (ticket 05, M3) is the SUBAGENT'S
 * OWN transcript — a distinct common field from `transcript_path`, which on
 * `SubagentStop` names the PARENT session's transcript and must never be
 * read for this Session's usage (verified against
 * code.claude.com/docs/en/hooks.md's own `SubagentStop` input example,
 * which carries both side by side). Both optional: a payload that omits
 * `agent_transcript_path` (or names a transcript with no readable usage)
 * still ends the Session, just without a usage sample — degrades silently,
 * never a crash (q9).
 */
export interface ClaudeSubagentStopPayload {
  session_id: string;
  hook_event_name: "SubagentStop";
  agent_id: string;
  transcript_path?: string;
  agent_transcript_path?: string;
  /**
   * A common input field the real payload carries — but deliberately
   * NEVER read here (ticket 05 fix): see `handleSubagentStop`'s own doc
   * comment for why backfilling `session.started` from it would defeat
   * `isNoiseSession`.
   */
  cwd?: string;
}

/** The top-level Session ending, carrying the runtime's own reason. `transcript_path` is optional — see `ClaudeSubagentStopPayload`. */
export interface ClaudeSessionEndPayload {
  session_id: string;
  hook_event_name: "SessionEnd";
  reason: string;
  transcript_path?: string;
  /** Common input field (ticket 05, M6) — read only to backfill a missing `session.started`, never otherwise. */
  cwd?: string;
}

/** The main agent finishing one turn — samples usage, but never ends the Session (that's SessionEnd's job). */
export interface ClaudeStopPayload {
  session_id: string;
  hook_event_name: "Stop";
  transcript_path?: string;
  /** Common input field (ticket 05, M6) — read only to backfill a missing `session.started`, never otherwise. */
  cwd?: string;
}

/**
 * One tool call completing. Counted toward the "every 25 tool calls" sample
 * (q9) — never logged itself, since an ordinary tool call matches no Policy
 * Rule and the Event contract only records what the Policy decided on.
 * `agent_id` (ticket 05, M2) names a subagent's OWN Session, exactly as on
 * `PreToolUse` — absent for a call in the main Session.
 */
export interface ClaudePostToolUsePayload {
  session_id: string;
  hook_event_name: "PostToolUse";
  /** The PARENT session's transcript when `agent_id` is present (ticket 05, M3's own recurrence here) — never read for a subagent's own sample; see `handlePostToolUse`. */
  transcript_path?: string;
  agent_id?: string;
  /** The SUBAGENT's own transcript — the only one `handlePostToolUse` ever samples from when `agent_id` is present. */
  agent_transcript_path?: string;
  /** Common input field (ticket 05, M6) — read only to backfill a missing `session.started`, never otherwise. */
  cwd?: string;
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
    /** Ticket 10: set only on a live-answering APPROVE that carried a message — "next to the tool result" (code.claude.com/docs/en/hooks' own `additionalContext` field, inside `hookSpecificOutput` alongside `permissionDecision`). */
    additionalContext?: string;
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
 * Normalize a PreToolUse payload into a runtime-neutral Action (ticket 04,
 * decision 07): a `Bash` call carrying a string command normalizes to
 * `shell`; any `mcp__*` tool call normalizes to `mcp`, carrying the tool's
 * own name and its raw arguments untouched — no per-provider code, and the
 * Policy alone decides what, if anything, those arguments mean. Everything
 * else (a non-Bash, non-MCP tool, or a Bash call Tenaza can't read a
 * command from) is not yet an Action Tenaza has a shape for, and is passed
 * through untouched.
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
 * pointed at `tenaza status` instead of a dead-end id. When present, it is
 * already the item's git-style SHORT hash (decision 03, ADR 0005, ticket
 * 06) — the same string `tenaza status`/`statusline`/the notification show
 * for this item, never a raw position.
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

/** Ticket 10: the agent-facing reason for a live-answering APPROVE's explicit allow — there is no "denial" to explain, so this names what actually happened instead of reusing `denyMessage`'s own deny-shaped wording. */
function liveApproveReason(): string {
  return "Approved by the human from the Live surface.";
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
 * Backfill `session.started` from THIS call's own `cwd` when the Session
 * has never had one (ticket 05, M6 — #1423's own fix, confirmed against
 * the real `tenaza status` dogfood, #1436): a Session whose start hook
 * never fired — it predates Tenaza's install — still lands under a real
 * project on the next call that happens to carry a `cwd`, instead of
 * reading "(sin proyecto) sin datos" forever. A no-op when `cwd` is absent,
 * or once the Session already has a `session.started` — this only ever
 * FILLS a gap, never overwrites or duplicates one. A side effect, same
 * guarantee as `handleSessionStart`'s own catch: failing to backfill must
 * never crash the call that triggered it (ADR 0007).
 *
 * Deliberately NEVER called from `handleSubagentStop` (ticket 05 fix):
 * `SubagentStop` DOES carry `cwd` as a common field, so backfilling there
 * would give Claude Code's own internal side-agents a `session.started`
 * too — exactly undoing `isNoiseSession` (`sessions.ts`), which hides a
 * Session whose only Events are its end plus a Usage sample precisely
 * because that is the side-agent signature. A subagent that did any REAL
 * work already got backfilled by its own `PreToolUse`/`PostToolUse` before
 * it ever reached `SubagentStop`; one that didn't is exactly what
 * `isNoiseSession` is for.
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

/**
 * Decide one Claude Code PreToolUse call against the Policy. Returns
 * `undefined` when there is nothing to tell the host — either the call
 * didn't normalize to an Action, it was a `tenaza label` announce (handled
 * separately, below), or the Policy's own verdict was an allow (whether
 * because nothing matched, or because a `flag` Rule did).
 */
async function handlePreToolUse(
  home: string,
  payload: ClaudeHookPayload,
): Promise<ClaudeHookOutput | undefined> {
  // `agent_id` names a subagent's OWN Session, never its parent's
  // `session_id` (ticket 05, M2 — #1423's own fix: v0.1 logged every
  // subagent decision under the PARENT's log instead of the subagent's
  // own). Resolved once, used everywhere below.
  const session = payload.agent_id ?? payload.session_id;
  backfillSessionStartedIfMissing(home, session, payload.cwd, payload.agent_id ? payload.session_id : undefined);

  const action = normalizeClaudeAction(payload);
  if (!action) return undefined;

  if (action.kind === "shell") {
    const labels = parseLabelCommand(action.command);
    if (labels) {
      // Never routed through the Policy: an announce isn't a Rule match,
      // so it's never logged as one (ADR 0003).
      appendEvent(home, sessionLabeledEvent(session, labels));
      return undefined;
    }
  }

  const result = await decideAction(home, session, action, CLAUDE_CAPABILITIES);
  const skippedLines = result.logged ? result.skippedLines : undefined;

  if (result.decision === "deny") {
    // Ticket 10: `result.reason` carries the live-answering wording
    // (a reject's own message or the generic fallback, or the es-AR expiry
    // text) when this deny came out of a hold — `denyMessage(inboxId)`
    // stays the fallback for every OTHER deny (no Daemon up at all),
    // unchanged from before ticket 10.
    return withSkippedLinesWarning(buildHookResponse("deny", result.reason ?? denyMessage(result.inboxId)), skippedLines);
  }

  // Ticket 10: a live-answering APPROVE is the ONE allow that explicitly
  // wants to skip Claude Code's own auto-mode classifier (decision 08) —
  // the human already said yes. Every OTHER allow (no Rule matched, a
  // `flag` Rule did, or the ADR 0001 unblockable case) returns NO
  // permission decision at all (decision 07, H2): an explicit hook `allow`
  // runs BEFORE that classifier and skips it, which is LESS safe than
  // saying nothing at all for any of THOSE cases — v0.1's own mistake,
  // fixed by ticket 01 and left untouched here.
  if (result.decision === "allow" && result.logged && result.live) {
    return withSkippedLinesWarning(
      buildHookResponse("allow", liveApproveReason(), result.additionalContext),
      skippedLines,
    );
  }

  // Only a skipped-log-line warning, when `decideAction` hit one, still
  // rides along as a bare systemMessage with no accompanying permission
  // decision.
  return skippedLines ? { systemMessage: describeSkippedLines(skippedLines) } : undefined;
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

/**
 * SessionStart: a new top-level Session — no parent. Its own append is
 * wrapped in its own catch (ADR 0007, ticket 02) — recording the start is a
 * side effect, not a decision, and a write failure here (e.g. an unwritable
 * state dir) must never crash the whole hook call and skip the self-check
 * that `runClaudeHookSafely` runs right after. A Session left without its
 * own `session.started` still gets one backfilled from a later Event's
 * `cwd` (ticket 05, M6) — never WITH a terminal locator, since the backfill
 * never runs at SessionStart (see `backfillSessionStartedIfMissing`'s own
 * doc).
 *
 * Ticket 11 (decision 09): also captures the runtime-neutral terminal
 * locator from this hook's own env and process table
 * (`captureTerminalLocator`) — `undefined` (never an empty `{}`) folds
 * away to nothing on `sessionStartedEvent`'s own `terminal` field when
 * nothing was captured at all (an SSH session, an unrecognized terminal, a
 * sandboxed test environment). Never called for a SUBAGENT
 * (`handleSubagentStart`, below) — "a subagent's card focuses its parent's
 * terminal" is resolved from the PARENT's own node at click time, so a
 * subagent's `session.started` carries no `terminal` field at all.
 */
export function handleSessionStart(home: string, payload: ClaudeSessionStartPayload): void {
  try {
    appendEvent(
      home,
      sessionStartedEvent(payload.session_id, {
        runtime: "claude",
        cwd: payload.cwd,
        capabilities: CLAUDE_CAPABILITIES,
        terminal: captureTerminalLocator(),
      }),
    );
  } catch {
    // See the doc comment above.
  }
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
 * one. Also samples usage for `agent_id` from `agent_transcript_path` —
 * NEVER `transcript_path`, which here names the PARENT's transcript
 * (ticket 05, M3) — a subagent's context is its own, never folded into its
 * parent's.
 *
 * Deliberately does NOT call `backfillSessionStartedIfMissing` (ticket 05
 * fix — see that function's own doc comment): this is the ONE lifecycle
 * event where backfilling would defeat `isNoiseSession`'s hide.
 */
export function handleSubagentStop(home: string, payload: ClaudeSubagentStopPayload): void {
  appendEvent(home, sessionEndedEvent(payload.agent_id, "subagent_stop"));
  sampleUsage(home, payload.agent_id, payload.agent_transcript_path);
}

/** SessionEnd: the top-level Session (`session_id`) ended, with the runtime's own reason. Also samples usage (q9). */
export function handleSessionEnd(home: string, payload: ClaudeSessionEndPayload): void {
  backfillSessionStartedIfMissing(home, payload.session_id, payload.cwd, undefined);
  appendEvent(home, sessionEndedEvent(payload.session_id, payload.reason));
  sampleUsage(home, payload.session_id, payload.transcript_path);
}

/** Stop: the main agent finished a turn — sample usage for `session_id`. Never ends the Session. */
export function handleStop(home: string, payload: ClaudeStopPayload): void {
  backfillSessionStartedIfMissing(home, payload.session_id, payload.cwd, undefined);
  sampleUsage(home, payload.session_id, payload.transcript_path);
}

/**
 * PostToolUse: count one tool call for the resolved Session, sampling
 * usage on exactly the 25th (and every 25th after) — AC2's own boundary.
 * Keyed by `agent_id ?? session_id` (ticket 05, M2), exactly like
 * `PreToolUse` — a subagent's own tool calls must land in ITS log, never
 * its parent's.
 */
export function handlePostToolUse(home: string, payload: ClaudePostToolUsePayload): void {
  const session = payload.agent_id ?? payload.session_id;
  backfillSessionStartedIfMissing(home, session, payload.cwd, payload.agent_id ? payload.session_id : undefined);
  const count = countToolCall(home, session);
  if (!shouldSampleOnToolCall(count)) return;
  // Inside a subagent, `transcript_path` names the PARENT's transcript —
  // the exact M3 bug, recurring here (ticket 05 fix). Never fall back to
  // it: no `agent_transcript_path` means no sample at all for this call,
  // never someone else's tokens recorded under this Session.
  const transcriptPath = payload.agent_id ? payload.agent_transcript_path : payload.transcript_path;
  sampleUsage(home, session, transcriptPath);
}

/**
 * Dispatch one Claude Code hook call by its `hook_event_name`. Only
 * PreToolUse ever answers back with a permission decision; every other
 * event (lifecycle, Stop, PostToolUse) just appends what it has and tells
 * the host nothing.
 */
export async function handleClaudeHook(
  home: string,
  payload: ClaudeHookInput,
): Promise<ClaudeHookOutput | undefined> {
  switch (payload.hook_event_name) {
    case "PreToolUse":
      return await handlePreToolUse(home, payload);
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
 * Compose the SessionStart self-check (ADR 0007, ticket 02) onto whatever
 * `handleClaudeHook` already did for this event — today, always nothing:
 * `handleSessionStart` only ever appends an Event and returns void. Mirrors
 * `withPolicyDegradation`'s own shape for PreToolUse: every check passing
 * stays silent, any check failing becomes BOTH this call's `systemMessage`
 * and the `degraded` report `runHookClaude` (cli.ts) writes to
 * `state/health.json` — and, when it's grave, fires the macOS notification
 * through the same report.
 */
function withSelfCheck(home: string): HookOutcome {
  const fault = runSelfCheck(home);
  if (!fault) return { output: undefined };
  return { output: { systemMessage: fault.message }, degraded: fault };
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
 *
 * Two events get their own post-processing on top of `handleClaudeHook`'s
 * own dispatch (ticket 02): PreToolUse re-checks the Policy
 * (`withPolicyDegradation`, ticket 01), and SessionStart runs the self-check
 * (`withSelfCheck`, once per top-level session — never SubagentStart, which
 * stays exactly as `handleClaudeHook` already left it). Every other event
 * passes `handleClaudeHook`'s response straight through, unchanged.
 */
export async function runClaudeHookSafely(home: string, raw: string): Promise<HookOutcome> {
  try {
    const payload = JSON.parse(raw);
    const response = await handleClaudeHook(home, payload);

    if (payload?.hook_event_name === "PreToolUse") {
      return withPolicyDegradation(home, response);
    }
    if (payload?.hook_event_name === "SessionStart") {
      return withSelfCheck(home);
    }

    return { output: response };
  } catch (error) {
    const message = `Tenaza guardrail degraded (${faultMessage(error)}) — Claude Code's own permission checks still apply.`;
    return { output: faultResponse(message), degraded: { message, grave: false } };
  }
}
