import { z } from "zod";

/**
 * The Event contract: Tenaza's only on-disk state. Every Session's log is a
 * sequence of these, one JSON object per line. The core and every Adapter
 * agree on this shape and nothing else.
 */

/**
 * `"held"` (ticket 10, decision 06): a `human` match the hook is currently
 * WAITING on a live answer for — neither allowed nor (yet) denied. Written
 * exactly once, at the moment the item is born live, on the SAME
 * `action.decided` Event every other match already uses (ADR 0005's own
 * identity line never moves). The line never changes again afterward —
 * TIME IS STATE: whether a `"held"` row still reads as live or has lapsed
 * to pending is derived fresh against the clock (`board.ts`'s
 * `liveItemPhase`), never by writing a second Event over this one.
 */
export const DecisionSchema = z.enum(["allow", "deny", "held"]);
export type Decision = z.infer<typeof DecisionSchema>;

export const EffectSchema = z.enum(["human", "flag"]);
export type Effect = z.infer<typeof EffectSchema>;

export const CapabilitySchema = z.enum(["observe", "block", "measure", "stop"]);
export type Capability = z.infer<typeof CapabilitySchema>;

/**
 * An agent's attempted operation, normalized by the Adapter into a
 * runtime-neutral shape Rules match on. v1 normalizes shell commands; v0.2
 * (ticket 04, decision 07) adds `mcp` — an MCP tool call, carried as the
 * tool's own name plus its raw arguments, with NO per-provider shape.
 * `file.write` stays named in the spec for a later Adapter and is added
 * here when one needs it.
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
 * v0.1 raw-substring check) or an `mcp` Rule ref (`tool`, plus whichever of
 * `unless`/`when` it carried, ticket 04). Structurally the same shape
 * `policy.ts`'s own `Rule` union already is — kept separate here so this
 * contract module never imports from `policy.ts`.
 */
const ShellRuleRefSchema = z.object({
  match: z.string(),
  effect: EffectSchema,
  /**
   * Set exactly when THIS match came from the v0.1 raw-substring fallback
   * because the command failed to parse (ticket 03, decision 02, ADR
   * 0006) — absent on a clean tree-sitter match, never written as
   * `undefined`. A per-decision fact about how the match was reached, not
   * a property of the Rule itself (which never carries this).
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

const SessionStartedData = z.object({
  parent: z.string().optional(),
  runtime: z.string(),
  cwd: z.string(),
  capabilities: z.array(CapabilitySchema),
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
   * Ticket 10: which PATH produced this resolution, when the resolution
   * trace needs to tell it apart from the plain, by-hand case — `"run"`
   * (closed by a successful `tenaza run`, CLI or the view's own streaming
   * run alike) or `"live"` (a live-answering approve/reject). Absent for a
   * plain `done`/`dismiss` (by hand, CLI or the view) — the trace reads
   * THAT as "cerrado como listo" / "descartado", its own default. Never a
   * third discriminator beyond what the trace actually needs.
   */
  via: z.enum(["run", "live"]).optional(),
});

/**
 * Ticket 10: the human's answer to a LIVE Inbox item, appended to the human
 * log (`state/human.jsonl`) by the Daemon's write route the instant the
 * browser posts it — the ONE thing the waiting hook (`live.ts`) polls that
 * file for. `ref` is the item's FULL identity hash (ADR 0005) — the same
 * one the `action.decided` "held" line already fixed. Distinct from
 * `approval.resolved`: THAT Event is the hook's own record that it actually
 * acted on this answer (closing the item); THIS one is only the raw answer
 * itself, and a hook that crashes or a browser double-post never turns it
 * into a second resolution on its own.
 */
const LiveAnsweredData = z.object({
  ref: z.string(),
  answer: z.enum(["approve", "reject"]),
  /** Optional on approve (spec: "with an optional message"); reject without one gets a generic deny reason — the hook's own call, never stored as an empty string here. */
  message: z.string().optional(),
});

/**
 * Ticket 10: `tenaza run`/the view's own run exited non-zero. Spec: "falló
 * (código N) (the item stays open)" — this is NEVER a Resolution (the item
 * stays open for a retry), so it is deliberately NOT folded into
 * `approval.resolved`'s `outcome` — `dedupOutstanding` (`inbox.ts`) only
 * ever reads `approval.resolved`, so a `run.failed` Event can never close an
 * item on its own. Lives in the human log alongside `approval.resolved`
 * (same writer, same reason to exist: a human-initiated attempt, not
 * something the Session itself did) purely for the resolution trace to
 * read back.
 */
const RunFailedData = z.object({
  ref: z.string(),
  exitCode: z.number(),
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

/**
 * Build an `action.decided` Event envelope with the current timestamp.
 * `reason` (ticket 03) is folded into the stored `rule` ref only when it's
 * actually set — never written as an explicit `undefined` key, so every
 * pre-ticket-03 caller and assertion is unaffected.
 */
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
 * Build a `session.started` Event envelope with the current timestamp. No
 * `parent` is a top-level Session; a `parent` names the Session that spawned
 * this one (ticket 03: a Claude Code subagent, keyed by the hook's own
 * `agent_id`, parented to the hook's `session_id`). `capabilities` is the
 * Adapter's own declaration — the core degrades by Capability, never by
 * runtime name (ADR 0001).
 */
export function sessionStartedEvent(
  session: string,
  data: { parent?: string; runtime: string; cwd: string; capabilities: Capability[] },
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
 * Build a `session.labeled` Event envelope with the current timestamp
 * (ticket 05, ADR 0003): `labels` is whatever the announce carried, stored
 * opaquely — Tenaza interprets only the reserved `project` key, and that
 * happens on read (`deriveProject`), never here. Multiple `session.labeled`
 * Events for the same Session accumulate (`buildSessionIndex` merges them in
 * file order), so a later announce adds or overrides keys without this
 * builder needing to know the Session's prior labels.
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

/**
 * Build a `session.ended` Event envelope with the current timestamp. `reason`
 * is the runtime's own word for why (e.g. Claude Code's SessionEnd reason, or
 * the constant Tenaza uses for a SubagentStop).
 */
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
 * Build a `usage.sampled` Event envelope with the current timestamp (q9): a
 * Session's context size, and cost when the Adapter knows it. `cost_usd` is
 * omitted — never written as `undefined` or `0` — when there is nothing to
 * report, since a Session's context_tokens is always known at the point an
 * Adapter samples it, but its cost in USD depends on pricing data v1's
 * Claude Adapter does not compute.
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
 * Build an `approval.resolved` Event envelope with the current timestamp.
 * `session` is the Session whose denied Action this Resolution closes (not
 * who is resolving it — the human, through the CLI); `ref` is the Inbox
 * item's stable id, as a string. `via` (ticket 10) is omitted entirely —
 * never written as an explicit `undefined` key — for the plain, by-hand
 * `done`/`dismiss` case; see `ApprovalResolvedData`'s own doc for what each
 * value means to the resolution trace.
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
 * Build a `live.answered` Event envelope with the current timestamp (ticket
 * 10) — appended to the human log by the Daemon's `/items/<id>/answer`
 * write route the instant the browser posts an answer. `session` is the
 * item's OWN Session (resolved server-side from the Inbox row, never trusted
 * from the browser) — same convention as `approvalResolvedEvent`. `message`
 * is omitted entirely when absent, never written as an empty string.
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
 * Build a `run.failed` Event envelope with the current timestamp (ticket
 * 10) — appended by `resolve.ts`'s `runInboxItem`/`startInboxItemRunStream`
 * on a non-zero exit, so the resolution trace has something to read back
 * for "falló (código N)" even though the item itself stays open (never a
 * Resolution — see `RunFailedData`'s own doc).
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
