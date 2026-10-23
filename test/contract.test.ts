import { describe, expect, test } from "bun:test";
import { EventSchema, actionDecidedEvent, approvalResolvedEvent } from "../src/contract/event";

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
});
