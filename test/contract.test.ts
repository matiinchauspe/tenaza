import { describe, expect, test } from "bun:test";
import {
  EventSchema,
  actionDecidedEvent,
  approvalResolvedEvent,
  sessionEndedEvent,
  sessionLabeledEvent,
  sessionStartedEvent,
  usageSampledEvent,
} from "../src/contract/event";

describe("Event contract", () => {
  test("accepts a well-formed action.decided line", () => {
    const line = {
      v: 1,
      ts: "2026-10-23T10:00:00.000Z",
      session: "sess-1",
      type: "action.decided",
      data: {
        action: { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
        decision: "deny",
        rule: { match: "gh pr merge", effect: "human" },
      },
    } as const;

    expect(EventSchema.parse(line)).toEqual(line);
  });

  test("rejects an envelope with an unknown type", () => {
    const line = {
      v: 1,
      ts: "2026-10-23T10:00:00.000Z",
      session: "sess-1",
      type: "something.else",
      data: {},
    };

    expect(() => EventSchema.parse(line)).toThrow();
  });

  test("rejects a version other than 1", () => {
    const line = {
      v: 2,
      ts: "2026-10-23T10:00:00.000Z",
      session: "sess-1",
      type: "session.ended",
      data: { reason: "done" },
    };

    expect(() => EventSchema.parse(line)).toThrow();
  });

  test("actionDecidedEvent builds a schema-valid envelope", () => {
    const evt = actionDecidedEvent(
      "sess-1",
      { kind: "shell", command: "gh pr merge 58", tool: "Bash" },
      "deny",
      { match: "gh pr merge", effect: "human" },
    );

    expect(() => EventSchema.parse(evt)).not.toThrow();
    expect(evt.type).toBe("action.decided");
    expect(evt.v).toBe(1);
  });

  test("approvalResolvedEvent builds a schema-valid envelope", () => {
    const evt = approvalResolvedEvent("sess-1", "1", "done");

    expect(() => EventSchema.parse(evt)).not.toThrow();
    expect(evt.type).toBe("approval.resolved");
    expect(evt.v).toBe(1);
    expect(evt).toMatchObject({ session: "sess-1", data: { ref: "1", outcome: "done" } });
  });

  test("sessionStartedEvent builds a schema-valid envelope, parent omitted for a top-level Session", () => {
    const evt = sessionStartedEvent("sess-1", {
      runtime: "claude",
      cwd: "/repo",
      capabilities: ["observe", "block"],
    });

    expect(() => EventSchema.parse(evt)).not.toThrow();
    expect(evt.type).toBe("session.started");
    expect(evt).toMatchObject({
      session: "sess-1",
      data: { runtime: "claude", cwd: "/repo", capabilities: ["observe", "block"] },
    });
    expect((evt as { data: { parent?: string } }).data.parent).toBeUndefined();
  });

  test("sessionStartedEvent carries a parent for a subagent Session", () => {
    const evt = sessionStartedEvent("agent-1", {
      parent: "sess-1",
      runtime: "claude",
      cwd: "/repo",
      capabilities: ["observe", "block"],
    });

    expect(evt).toMatchObject({ session: "agent-1", data: { parent: "sess-1" } });
  });

  test("sessionEndedEvent builds a schema-valid envelope", () => {
    const evt = sessionEndedEvent("sess-1", "clear");

    expect(() => EventSchema.parse(evt)).not.toThrow();
    expect(evt.type).toBe("session.ended");
    expect(evt).toMatchObject({ session: "sess-1", data: { reason: "clear" } });
  });

  test("usageSampledEvent builds a schema-valid envelope, cost_usd omitted when unknown", () => {
    const evt = usageSampledEvent("sess-1", { context_tokens: 242170 });

    expect(() => EventSchema.parse(evt)).not.toThrow();
    expect(evt.type).toBe("usage.sampled");
    expect(evt).toMatchObject({ session: "sess-1", data: { context_tokens: 242170 } });
    expect((evt as { data: { cost_usd?: number } }).data.cost_usd).toBeUndefined();
  });

  test("usageSampledEvent carries cost_usd when given", () => {
    const evt = usageSampledEvent("sess-1", { context_tokens: 100, cost_usd: 0.42 });

    expect(() => EventSchema.parse(evt)).not.toThrow();
    expect(evt).toMatchObject({ data: { context_tokens: 100, cost_usd: 0.42 } });
  });

  test("accepts a well-formed action.decided line for an mcp Action/Rule (ticket 04)", () => {
    const line = {
      v: 1,
      ts: "2026-10-26T10:00:00.000Z",
      session: "sess-1",
      type: "action.decided",
      data: {
        action: { kind: "mcp", tool: "mcp__neon__run_sql", args: { branch_id: "br-prod" } },
        decision: "deny",
        rule: { tool: "mcp__*neon*__run_sql*", unless: { branch_id: ["br-dev"] as string[] }, effect: "human" },
      },
    } as const;

    expect(EventSchema.parse(line)).toEqual(line);
  });

  test("actionDecidedEvent builds a schema-valid envelope for an mcp Rule ref", () => {
    const evt = actionDecidedEvent(
      "sess-1",
      { kind: "mcp", tool: "mcp__neon__run_sql", args: { branch_id: "br-prod" } },
      "deny",
      { tool: "mcp__*neon*__run_sql*", unless: { branch_id: ["br-dev"] }, effect: "human" },
    );

    expect(() => EventSchema.parse(evt)).not.toThrow();
    expect(evt.data.rule).toEqual({
      tool: "mcp__*neon*__run_sql*",
      unless: { branch_id: ["br-dev"] },
      effect: "human",
    });
  });

  test("rejects an mcp Action missing its args record", () => {
    const line = {
      v: 1,
      ts: "2026-10-23T10:00:00.000Z",
      session: "sess-1",
      type: "action.decided",
      data: {
        action: { kind: "mcp", tool: "mcp__neon__run_sql" },
        decision: "allow",
        rule: { tool: "mcp__*neon*", effect: "flag" },
      },
    };

    expect(() => EventSchema.parse(line)).toThrow();
  });

  test("sessionLabeledEvent builds a schema-valid envelope carrying the given labels", () => {
    const evt = sessionLabeledEvent("sess-1", { ticket: "RES-131", project: "reservee" });

    expect(() => EventSchema.parse(evt)).not.toThrow();
    expect(evt.type).toBe("session.labeled");
    expect(evt).toMatchObject({
      session: "sess-1",
      data: { labels: { ticket: "RES-131", project: "reservee" } },
    });
  });
});
