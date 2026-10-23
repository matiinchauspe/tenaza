import { describe, expect, test } from "bun:test";
import {
  EventSchema,
  actionDecidedEvent,
  approvalResolvedEvent,
  sessionEndedEvent,
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
});
