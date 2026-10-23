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

/** Build an `action.decided` Event envelope with the current timestamp. */
export function actionDecidedEvent(
  session: string,
  action: Action,
  decision: Decision,
  rule: { match: string; effect: Effect },
): Event {
  return EventSchema.parse({
    v: 1,
    ts: new Date().toISOString(),
    session,
    type: "action.decided",
    data: { action, decision, rule },
  });
}
