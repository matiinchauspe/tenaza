import { z } from "zod";

/**
 * The Event contract: Tenaza's only on-disk state. Every Session's log is a
 * sequence of these, one JSON object per line. The core and every Adapter
 * agree on this shape and nothing else. An optional field with nothing to
 * report is omitted entirely, never written as `undefined` or an empty
 * placeholder.
 */

/**
 * `"held"`: a `human` match the hook is currently waiting on a live answer
 * for — neither allowed nor denied yet. Written once, on the same
 * `action.decided` Event every other match uses, and never rewritten:
 * whether it still reads as live or has lapsed to pending is derived fresh
 * against the clock (`board.ts`'s `liveItemPhase`), never by writing a
 * second Event.
 */
export const DecisionSchema = z.enum(["allow", "deny", "held"]);
export type Decision = z.infer<typeof DecisionSchema>;

export const EffectSchema = z.enum(["human", "flag"]);
export type Effect = z.infer<typeof EffectSchema>;

export const CapabilitySchema = z.enum(["observe", "block", "measure", "stop"]);
export type Capability = z.infer<typeof CapabilitySchema>;

/**
 * An agent's attempted operation, normalized by the Adapter into a
 * runtime-neutral shape Rules match on — `mcp` carries the tool's own name
 * plus raw arguments, with no per-provider shape. `file.write` is not yet
 * implemented; add it here when an Adapter needs it.
 */
export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("shell"),
    command: z.string(),
    /** The runtime's own name for the tool that ran this, for display — e.g. "Bash". */
    tool: z.string(),
  }),
  z.object({
    kind: z.literal("mcp"),
    /** The MCP tool's own fully-qualified name, e.g. "mcp__neon__run_sql". */
    tool: z.string(),
    /** The call's raw arguments, exactly as the runtime handed them — never interpreted here. */
    args: z.record(z.string(), z.unknown()),
  }),
]);
export type Action = z.infer<typeof ActionSchema>;
export type ShellAction = Extract<Action, { kind: "shell" }>;
export type McpAction = Extract<Action, { kind: "mcp" }>;

/**
 * A matched Rule's own fields, stored on the `action.decided` Event — a
 * `shell` Rule ref (`match`, plus `reason` when the parse fell back to the
 * raw-substring check) or an `mcp` Rule ref (`tool`, plus whichever of
 * `unless`/`when` it carried). Structurally the same shape `policy.ts`'s
 * own `Rule` union already is — kept separate here so this contract module
 * never imports from `policy.ts`.
 */
const ShellRuleRefSchema = z.object({
  match: z.string(),
  effect: EffectSchema,
  /**
   * Set exactly when this match came from the raw-substring fallback
   * because the command failed to parse — absent on a clean tree-sitter
   * match, never written as `undefined`. A per-decision fact about how the
   * match was reached, not a property of the Rule itself.
   */
  reason: z.enum(["parse_error"]).optional(),
});
const McpRuleRefSchema = z.object({
  tool: z.string(),
  unless: z.record(z.string(), z.array(z.unknown())).optional(),
  when: z.record(z.string(), z.unknown()).optional(),
  effect: EffectSchema,
});
export const RuleRefSchema = z.union([ShellRuleRefSchema, McpRuleRefSchema]);
type DecidedRule =
  | { match: string; effect: Effect }
  | { tool: string; unless?: Record<string, unknown[]>; when?: Record<string, unknown>; effect: Effect };

/**
 * A runtime-neutral terminal locator, captured once at SessionStart from
 * the hook's own env and process table — never re-queried later, and never
 * carried by a subagent's own `session.started` at all: a subagent's card
 * focuses its parent's terminal, a resolution-time rule the core applies by
 * walking to the parent's own node, not something every Session needs its
 * own copy of. Every field is optional and independently absent — a locator
 * with none of them set is never written at all, and a v0.1 Session (or
 * one started over SSH, or any environment this capture recognizes nothing
 * in) simply has no `terminal` key, which the terminal table
 * (`terminals.ts`) reads as "unknown" — greyed, never a crash.
 *
 * `tty` and `outerApp` come from the hook's own PID walk, never from a
 * per-terminal env var — they are the generic fallback this app-level row
 * (Warp, Alacritty, VS Code, Cursor, an unrecognized terminal) resolves
 * against. The per-terminal keys below are the specific ones a known
 * terminal's own row (`terminals.ts`) detects on: multiplexer keys
 * (`tmuxPane`/`zellijPane`) are checked first at resolution time, because
 * the outer vars above go stale once a multiplexer server is running,
 * independent of the order these fields are declared here.
 */
const TerminalLocatorSchema = z.object({
  termProgram: z.string().optional(),
  /** `__CFBundleIdentifier` — undocumented, but the strongest single app hint this capture has. */
  bundleId: z.string().optional(),
  /** The hook's own controlling tty (`ps -o tty= -p $PPID`) — the join key Terminal.app and iTerm2 match a tab/session by. */
  tty: z.string().optional(),
  /** The outermost `.app` on the parent-PID walk — the generic Level-1 fallback's own raise target when no `bundleId` was captured either. */
  outerApp: z.string().optional(),
  /** `PWD` — Ghostty's own cwd/title heuristic match key (no per-surface id exists to capture instead). */
  pwd: z.string().optional(),
  orcaHandle: z.string().optional(),
  /** The first comma-field of `$TMUX` (the socket path) — `tmux -S <socket>` is how every live call reaches this session's own server. */
  tmuxSocket: z.string().optional(),
  tmuxPane: z.string().optional(),
  itermSessionId: z.string().optional(),
  weztermPane: z.string().optional(),
  weztermSocket: z.string().optional(),
  kittyWindowId: z.string().optional(),
  /** Present only when kitty's remote control is configured (`allow_remote_control` + `listen_on`) — absent means Level 1 only for this row, by design. */
  kittyListenOn: z.string().optional(),
  zellijSession: z.string().optional(),
  zellijPane: z.string().optional(),
});
export type TerminalLocator = z.infer<typeof TerminalLocatorSchema>;

const SessionStartedData = z.object({
  parent: z.string().optional(),
  runtime: z.string(),
  cwd: z.string(),
  capabilities: z.array(CapabilitySchema),
  /** Omitted when the capture yielded nothing. */
  terminal: TerminalLocatorSchema.optional(),
  /**
   * The runtime's own OS process id, captured once and never re-queried —
   * `sessions.ts`'s `closeDeadProcesses` checks it against the live
   * process table later to tell a dead Session apart from an idle one.
   * Omitted when the process table couldn't be read at all (a sandboxed
   * test env, or `backfillSessionStartedIfMissing`'s catch-up path) — such
   * a Session is simply never a candidate for that check.
   */
  pid: z.number().optional(),
  /**
   * `pid`'s own process-start marker (`ps -o lstart=`), captured at the
   * same moment — an opaque token, never parsed as a date, compared
   * byte-for-byte against a fresh read later: two reads of the same
   * process always agree, a pid reused by an unrelated process after a
   * reboot never does. Omitted when `pid` itself is, or when `ps` couldn't
   * report it even though `pid` was known — degrades to trusting the bare
   * pid alone (see `closeDeadProcesses`).
   */
  pidStartedAt: z.string().optional(),
});

const SessionLabeledData = z.object({
  labels: z.record(z.string(), z.string()),
});

const ActionDecidedData = z.object({
  action: ActionSchema,
  decision: DecisionSchema,
  rule: RuleRefSchema,
});

const UsageSampledData = z.object({
  context_tokens: z.number(),
  cost_usd: z.number().optional(),
});

const SessionEndedData = z.object({
  reason: z.string(),
});

const ApprovalResolvedData = z.object({
  ref: z.string(),
  outcome: z.enum(["done", "dismissed"]),
  /**
   * Which path produced this resolution, when the trace needs to tell it
   * apart from the plain, by-hand case — `"run"` (closed by a successful
   * `tenaza run`, CLI or streaming alike) or `"live"` (a live-answering
   * approve/reject). Absent for a plain `done`/`dismiss`, which the trace
   * reads as its own default. Never a third discriminator beyond what the
   * trace needs.
   */
  via: z.enum(["run", "live"]).optional(),
});

/**
 * The human's answer to a live Inbox item, appended to the human log by
 * the Daemon's write route the instant the browser posts it — the one
 * thing the waiting hook (`live.ts`) polls that file for. `ref` is the
 * item's full identity hash, the same one the `action.decided` `"held"`
 * line already fixed. Distinct from `approval.resolved`: that Event is the
 * hook's own record that it acted on this answer (closing the item); this
 * one is only the raw answer, and a crash or a browser double-post never
 * turns it into a second resolution on its own.
 */
const LiveAnsweredData = z.object({
  ref: z.string(),
  answer: z.enum(["approve", "reject"]),
  /** Optional on approve; a reject without one gets a generic deny reason — the hook's own call. */
  message: z.string().optional(),
});

/**
 * `tenaza run`/the view's own run exited non-zero. Never a Resolution —
 * the item stays open for a retry — so deliberately not folded into
 * `approval.resolved`'s `outcome`: `dedupOutstanding` (`inbox.ts`) only
 * reads `approval.resolved`, so this Event alone can never close an item.
 * Lives in the human log alongside `approval.resolved` for the resolution
 * trace to read back.
 */
const RunFailedData = z.object({
  ref: z.string(),
  exitCode: z.number(),
});

/**
 * A human Event in the log — no state is kept beside the logs. Carried
 * alongside `approval.resolved`/`live.answered`/`run.failed` (same
 * multi-writer convention: the Daemon writes this on the human's archive
 * click, never the Session's own single-writer log). No payload beyond the
 * envelope's own `session` — archiving names no command, carries no
 * outcome, and is never reversed (no "unarchive").
 */
const SessionArchivedData = z.object({});

/**
 * The human just submitted a new turn (Claude Code's own
 * `UserPromptSubmit` hook) — a pure activity signal with no decision
 * capability. Logged once per turn, not per tool call, the same cadence
 * `session.started`/`session.ended`/`SubagentStop` already use. Its only
 * job is to move `lastEventTs` forward so a long CORRIENDO stretch's last
 * turn-ending Stop never reads stale once a fresh prompt starts the next
 * turn, and to resolve a stale `notification.observed` (below) the instant
 * real human activity resumes. No payload beyond the envelope itself.
 */
const PromptSubmittedData = z.object({});

/**
 * The main agent's own `Stop` hook — one request-response Turn just ended.
 * A pure activity signal, same guarantee as `PromptSubmittedData` above.
 * Distinct from `usage.sampled`, which `Stop` also appends when a
 * transcript yields one: a usage sample and a Turn ending are two
 * independent facts that happen to share one hook — conflating them would
 * misread every other `usageSampledEvent` caller (`SessionEnd`,
 * `SubagentStop`, the 25th-call `PostToolUse` sample) as a Turn boundary
 * too. Recorded once per Turn, the same cadence `prompt.submitted` uses.
 */
const TurnEndedData = z.object({});

/**
 * The two `Notification` matcher values this project reads — never the
 * full matcher table Claude Code carries (`auth_success`,
 * `agent_completed`, …), which this project has no use for and
 * `adapters/claude.ts`'s `handleNotification` silently ignores.
 */
export const NotificationKindSchema = z.enum(["permission_prompt", "idle_prompt"]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

/**
 * Claude Code's own signal that it is showing a permission prompt, or that
 * a turn has sat idle ~60s unanswered — never Tenaza's own `human` Rule
 * hold (contrast `action.decided`'s `"held"`, which Tenaza raised and can
 * resolve itself). Observed only: nothing here carries a permission
 * decision, and nothing in this project answers it on the agent's behalf.
 * Resolution is inferred, never a second Event — `sessions.ts`'s
 * `nativeWaitFor` reads this as the most recent thing this Session did
 * until a later Event (a fresh prompt, a touch, another notification)
 * supersedes it.
 */
const NotificationObservedData = z.object({
  kind: NotificationKindSchema,
});

const envelope = <Type extends string, Data extends z.ZodType>(
  type: Type,
  data: Data,
) =>
  z.object({
    v: z.literal(1),
    ts: z.string(),
    session: z.string(),
    type: z.literal(type),
    data,
  });

export const EventSchema = z.discriminatedUnion("type", [
  envelope("session.started", SessionStartedData),
  envelope("session.labeled", SessionLabeledData),
  envelope("action.decided", ActionDecidedData),
  envelope("usage.sampled", UsageSampledData),
  envelope("session.ended", SessionEndedData),
  envelope("approval.resolved", ApprovalResolvedData),
  envelope("live.answered", LiveAnsweredData),
  envelope("run.failed", RunFailedData),
  envelope("session.archived", SessionArchivedData),
  envelope("prompt.submitted", PromptSubmittedData),
  envelope("notification.observed", NotificationObservedData),
  envelope("turn.ended", TurnEndedData),
]);
export type Event = z.infer<typeof EventSchema>;
export type ActionDecidedEvent = Extract<Event, { type: "action.decided" }>;
export type SessionStartedEvent = Extract<Event, { type: "session.started" }>;
export type SessionLabeledEvent = Extract<Event, { type: "session.labeled" }>;
export type SessionEndedEvent = Extract<Event, { type: "session.ended" }>;
export type UsageSampledEvent = Extract<Event, { type: "usage.sampled" }>;
export type ApprovalResolvedEvent = Extract<Event, { type: "approval.resolved" }>;
export type LiveAnsweredEvent = Extract<Event, { type: "live.answered" }>;
export type RunFailedEvent = Extract<Event, { type: "run.failed" }>;
export type SessionArchivedEvent = Extract<Event, { type: "session.archived" }>;
export type PromptSubmittedEvent = Extract<Event, { type: "prompt.submitted" }>;
export type NotificationObservedEvent = Extract<Event, { type: "notification.observed" }>;
export type TurnEndedEvent = Extract<Event, { type: "turn.ended" }>;

/** `reason` is folded into the stored `rule` ref only when set — never written as an explicit `undefined` key. */
export function actionDecidedEvent(
  session: string,
  action: Action,
  decision: Decision,
  rule: DecidedRule,
  reason?: "parse_error",
): ActionDecidedEvent {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "action.decided",
    data: { action, decision, rule: reason ? { ...rule, reason } : rule },
  }) as ActionDecidedEvent;
}

/**
 * No `parent` is a top-level Session; a `parent` names the Session that
 * spawned this one — a Claude Code subagent, keyed by the hook's own
 * `agent_id`, parented to the hook's `session_id`. `capabilities` is the
 * Adapter's own declaration — the core degrades by Capability, never by
 * runtime name.
 */
export function sessionStartedEvent(
  session: string,
  data: {
    parent?: string;
    runtime: string;
    cwd: string;
    capabilities: Capability[];
    terminal?: TerminalLocator;
    pid?: number;
    pidStartedAt?: string;
  },
): SessionStartedEvent {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "session.started",
    data,
  }) as SessionStartedEvent;
}

/**
 * `labels` is whatever the announce carried, stored opaquely — Tenaza
 * interprets only the reserved `project` key, and that happens on read
 * (`deriveProject`), never here. Multiple `session.labeled` Events for the
 * same Session accumulate (`buildSessionIndex` merges them in file order),
 * so a later announce adds or overrides keys without this builder needing
 * the Session's prior labels.
 */
export function sessionLabeledEvent(
  session: string,
  labels: Record<string, string>,
): SessionLabeledEvent {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "session.labeled",
    data: { labels },
  }) as SessionLabeledEvent;
}

/** `reason` is the runtime's own word for why — e.g. Claude Code's SessionEnd reason, or the constant Tenaza uses for a SubagentStop. */
export function sessionEndedEvent(session: string, reason: string): SessionEndedEvent {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "session.ended",
    data: { reason },
  }) as SessionEndedEvent;
}

/**
 * A Session's context size, and cost when the Adapter knows it. `cost_usd`
 * is omitted — never written as `undefined` or `0` — when there is
 * nothing to report: `context_tokens` is always known at the point an
 * Adapter samples it, but cost in USD depends on pricing data v1's Claude
 * Adapter does not compute.
 */
export function usageSampledEvent(
  session: string,
  data: { context_tokens: number; cost_usd?: number },
): UsageSampledEvent {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "usage.sampled",
    data,
  }) as UsageSampledEvent;
}

/**
 * `session` is the Session whose denied Action this Resolution closes —
 * not who is resolving it (the human, through the CLI). `ref` is the Inbox
 * item's stable id as a string. `via` is omitted entirely, never as an
 * explicit `undefined` key, for the plain `done`/`dismiss` case — see
 * `ApprovalResolvedData` for what each value means.
 */
export function approvalResolvedEvent(
  session: string,
  ref: string,
  outcome: "done" | "dismissed",
  via?: "run" | "live",
): ApprovalResolvedEvent {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "approval.resolved",
    data: via ? { ref, outcome, via } : { ref, outcome },
  }) as ApprovalResolvedEvent;
}

/**
 * `session` is the item's own Session, resolved server-side from the
 * Inbox row — never trusted from the browser, same convention as
 * `approvalResolvedEvent`. `message` is omitted entirely when absent,
 * never written as an empty string.
 */
export function liveAnsweredEvent(
  session: string,
  ref: string,
  answer: "approve" | "reject",
  message?: string,
): LiveAnsweredEvent {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "live.answered",
    data: message ? { ref, answer, message } : { ref, answer },
  }) as LiveAnsweredEvent;
}

/**
 * Appended by `resolve.ts`'s `runInboxItem`/`startInboxItemRunStream` on a
 * non-zero exit, so the resolution trace has something to read back even
 * though the item itself stays open — see `RunFailedData`.
 */
export function runFailedEvent(session: string, ref: string, exitCode: number): RunFailedEvent {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "run.failed",
    data: { ref, exitCode },
  }) as RunFailedEvent;
}

/**
 * Appended to the human log by the Daemon's archive write route the
 * instant the human's archive click reaches it (`resolve.ts`'s
 * `archiveSession`). `session` is the archived Session's own id.
 */
export function sessionArchivedEvent(session: string): SessionArchivedEvent {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "session.archived",
    data: {},
  }) as SessionArchivedEvent;
}

/** Appended by `adapters/claude.ts`'s `handleUserPromptSubmit` on every `UserPromptSubmit` call, once per turn. */
export function promptSubmittedEvent(session: string): PromptSubmittedEvent {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "prompt.submitted",
    data: {},
  }) as PromptSubmittedEvent;
}

/**
 * Appended by `adapters/claude.ts`'s `handleNotification` only for the two
 * matcher values this project reads (`NotificationKindSchema`); every
 * other `notification_type` never reaches this builder.
 */
export function notificationObservedEvent(session: string, kind: NotificationKind): NotificationObservedEvent {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "notification.observed",
    data: { kind },
  }) as NotificationObservedEvent;
}

/** Appended by `adapters/claude.ts`'s `handleStop` on every `Stop` call, regardless of whether that same call also samples usage. */
export function turnEndedEvent(session: string): TurnEndedEvent {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "turn.ended",
    data: {},
  }) as TurnEndedEvent;
}
