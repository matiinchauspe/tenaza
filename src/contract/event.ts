import { z } from "zod";

/**
 * The Event contract: Tenaza's only on-disk state. Every Session's log is a
 * sequence of these, one JSON object per line. The core and every Adapter
 * agree on this shape and nothing else.
 */

export const DecisionSchema = z.enum(["allow", "deny"]);
export type Decision = z.infer<typeof DecisionSchema>;

export const EffectSchema = z.enum(["human", "flag"]);
export type Effect = z.infer<typeof EffectSchema>;

export const CapabilitySchema = z.enum(["observe", "block", "measure", "stop"]);
export type Capability = z.infer<typeof CapabilitySchema>;

/**
 * An agent's attempted operation, normalized by the Adapter into a
 * runtime-neutral shape Rules match on. v1 only normalizes shell commands;
 * `file.write` and `mcp` are named in the spec for later Adapters and are
 * added here when one needs them.
 */
export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("shell"),
    command: z.string(),
    /** The runtime's own name for the tool that ran this, for display — e.g. "Bash". */
    tool: z.string(),
  }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const RuleRefSchema = z.object({
  match: z.string(),
  effect: EffectSchema,
});

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
]);
export type Event = z.infer<typeof EventSchema>;
export type ActionDecidedEvent = Extract<Event, { type: "action.decided" }>;
export type SessionStartedEvent = Extract<Event, { type: "session.started" }>;
export type SessionLabeledEvent = Extract<Event, { type: "session.labeled" }>;
export type SessionEndedEvent = Extract<Event, { type: "session.ended" }>;
export type UsageSampledEvent = Extract<Event, { type: "usage.sampled" }>;

/** Build an `action.decided` Event envelope with the current timestamp. */
export function actionDecidedEvent(
  session: string,
  action: Action,
  decision: Decision,
  rule: { match: string; effect: Effect },
): ActionDecidedEvent {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "action.decided",
    data: { action, decision, rule },
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
 * item's stable id, as a string.
 */
export function approvalResolvedEvent(
  session: string,
  ref: string,
  outcome: "done" | "dismissed",
): Event {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "approval.resolved",
    data: { ref, outcome },
  });
}
