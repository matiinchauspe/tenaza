import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { usageSampledEvent } from "../src/contract/event";
import {
  buildGraveFaultNotification,
  buildInboxOpenedNotification,
  buildMacNotifierCommand,
  buildThresholdCrossedNotification,
  maxUsageSample,
  NOTIFY_BURST_WINDOW_MS,
  notifyGraveFault,
  readNotificationRecorder,
  sendNotification,
  shouldNotifyThresholdCrossing,
  shouldPlaySound,
} from "../src/notify";

describe("shouldPlaySound (ticket 08's burst-window anti-spam: one sound per ~2s)", () => {
  test("plays when nothing has sounded yet", () => {
    expect(shouldPlaySound(undefined, new Date(0))).toBe(true);
  });

  test("stays silent inside the window", () => {
    expect(shouldPlaySound(new Date(0), new Date(500))).toBe(false);
  });

  test("plays again once the window has fully passed", () => {
    expect(shouldPlaySound(new Date(0), new Date(NOTIFY_BURST_WINDOW_MS))).toBe(true);
  });

  test("the boundary is inclusive — exactly the window counts as passed, one tick short does not", () => {
    expect(shouldPlaySound(new Date(1000), new Date(1000 + NOTIFY_BURST_WINDOW_MS))).toBe(true);
    expect(shouldPlaySound(new Date(1000), new Date(1000 + NOTIFY_BURST_WINDOW_MS - 1))).toBe(false);
  });
});

describe("shouldNotifyThresholdCrossing", () => {
  test("never sampled before, and this sample is AT the threshold — a crossing (Flag's own >=)", () => {
    expect(shouldNotifyThresholdCrossing(undefined, 200_000, 200_000)).toBe(true);
  });

  test("never sampled before, below the threshold — not a crossing", () => {
    expect(shouldNotifyThresholdCrossing(undefined, 100, 200_000)).toBe(false);
  });

  test("already past the threshold before this sample — never a crossing again", () => {
    expect(shouldNotifyThresholdCrossing(210_000, 242_000, 200_000)).toBe(false);
  });

  test("was below before, now at or past — a crossing", () => {
    expect(shouldNotifyThresholdCrossing(150_000, 200_000, 200_000)).toBe(true);
  });
});

describe("maxUsageSample", () => {
  test("undefined for a Session with no usage.sampled Events at all", () => {
    expect(maxUsageSample([])).toBeUndefined();
  });

  test("ignores other Event types", () => {
    const events = [usageSampledEvent("sess-1", { context_tokens: 50_000 })];
    expect(maxUsageSample(events)).toBe(50_000);
  });

  test("the HIGHEST sample ever seen, never just the latest — a later, lower sample must not lower it (e.g. after a compaction)", () => {
    const events = [
      usageSampledEvent("sess-1", { context_tokens: 50_000 }),
      usageSampledEvent("sess-1", { context_tokens: 210_000 }),
      usageSampledEvent("sess-1", { context_tokens: 90_000 }),
    ];
    expect(maxUsageSample(events)).toBe(210_000);
  });
});

describe("buildInboxOpenedNotification (🟡)", () => {
  test("matches the spec's own worked example, field for field (ids updated to ticket 06's short hashes)", () => {
    const notification = buildInboxOpenedNotification(
      {
        id: "dce936648342af60c57be01d81e2fc98abd32a27",
        session: "b71",
        ts: "2026-01-01T00:00:00.000Z",
        action: { kind: "shell", command: "gh pr merge 58 --merge", tool: "Bash" },
        blocked: true,
        decision: "deny",
      },
      "dce9",
      { project: "reservee", role: "RES-131" },
    );

    expect(notification).toEqual({
      tag: "inbox-dce936648342af60c57be01d81e2fc98abd32a27",
      title: "🟡 Tenaza · te espera · inbox dce9",
      subtitle: "reservee / RES-131 / sesión b71",
      message: "Bash: gh pr merge 58 --merge · tenaza run dce9",
    });
  });

  test("an unblocked item (ADR 0001, ticket 06) never says `tenaza run` — it already ran once and run would refuse", () => {
    const notification = buildInboxOpenedNotification(
      {
        id: "3333333333333333333333333333333333333a",
        session: "fake-1",
        ts: "2026-01-01T00:00:00.000Z",
        action: { kind: "shell", command: "gh pr merge 58", tool: "fake" },
        blocked: false,
        decision: "allow",
      },
      "3333",
      { project: "(sin proyecto)", role: "sesión" },
    );

    expect(notification.message).toContain("ya corrió");
    expect(notification.message).not.toContain("tenaza run");
  });

  test("an mcp Action (ticket 04) describes as the tool name plus a short args summary, never blank", () => {
    const notification = buildInboxOpenedNotification(
      {
        id: "9999999999999999999999999999999999999b",
        session: "sess-1",
        ts: "2026-01-01T00:00:00.000Z",
        action: { kind: "mcp", tool: "mcp__neon__run_sql", args: { branch_id: "br-prod" } },
        blocked: true,
        decision: "deny",
      },
      "9999",
      { project: "reservee", role: "RES-131" },
    );

    expect(notification.message).toBe("mcp__neon__run_sql  branch_id=br-prod · tenaza run 9999");
  });

  test("the tag is a stable, deterministic function of the Inbox item's FULL identity hash — never random, never time-based, and never shortened (unlike the display id)", () => {
    const row = {
      id: "7777777777777777777777777777777777777c",
      session: "sess-1",
      ts: "2026-01-01T00:00:00.000Z",
      action: { kind: "shell" as const, command: "x", tool: "Bash" },
      blocked: true,
      decision: "deny" as const,
    };
    const first = buildInboxOpenedNotification(row, "7777", { project: "p", role: "r" });
    const second = buildInboxOpenedNotification(row, "7777", { project: "p", role: "r" });
    expect(first.tag).toBe(`inbox-${row.id}`);
    expect(first.tag).toBe(second.tag);
  });

  test("ticket 10: a freshly-born-live item (decision 'held') never says 'tenaza run' — there's nothing to run yet, the agent itself is paused", () => {
    const notification = buildInboxOpenedNotification(
      {
        id: "dce936648342af60c57be01d81e2fc98abd32a27",
        session: "b71",
        ts: "2026-01-01T00:00:00.000Z",
        action: { kind: "shell", command: "gh pr merge 58 --merge", tool: "Bash" },
        blocked: true,
        decision: "held",
      },
      "dce9",
      { project: "reservee", role: "RES-131" },
    );

    expect(notification.message).not.toContain("tenaza run");
    expect(notification.message).toContain("te espera tu respuesta en la vista");
  });

  test("ticket 10: carries the openUrl given, for the clickable notifier to use", () => {
    const notification = buildInboxOpenedNotification(
      {
        id: "dce936648342af60c57be01d81e2fc98abd32a27",
        session: "b71",
        ts: "2026-01-01T00:00:00.000Z",
        action: { kind: "shell", command: "gh pr merge 58 --merge", tool: "Bash" },
        blocked: true,
        decision: "held",
      },
      "dce9",
      { project: "reservee", role: "RES-131" },
      "http://127.0.0.1:4747/auth?token=abc",
    );

    expect(notification.openUrl).toBe("http://127.0.0.1:4747/auth?token=abc");
  });

  test("openUrl stays undefined when the caller passes none — the plain pre-ticket-10 shape, byte for byte", () => {
    const notification = buildInboxOpenedNotification(
      {
        id: "dce936648342af60c57be01d81e2fc98abd32a27",
        session: "b71",
        ts: "2026-01-01T00:00:00.000Z",
        action: { kind: "shell", command: "gh pr merge 58 --merge", tool: "Bash" },
        blocked: true,
        decision: "deny",
      },
      "dce9",
      { project: "reservee", role: "RES-131" },
    );

    expect(notification).toEqual({
      tag: "inbox-dce936648342af60c57be01d81e2fc98abd32a27",
      title: "🟡 Tenaza · te espera · inbox dce9",
      subtitle: "reservee / RES-131 / sesión b71",
      message: "Bash: gh pr merge 58 --merge · tenaza run dce9",
    });
  });
});

describe("buildMacNotifierCommand (ticket 10: terminal-notifier -open <url>, else osascript with no click action)", () => {
  const notification = {
    tag: "inbox-abc",
    title: "🟡 Tenaza · te espera · inbox abc1",
    subtitle: "reservee / RES-131 / sesión b71",
    message: "Bash: gh pr merge 58 · tenaza run abc1",
  };

  test("terminal-notifier on PATH AND an openUrl present → terminal-notifier -open <url>", () => {
    const command = buildMacNotifierCommand({ ...notification, openUrl: "http://127.0.0.1:4747/auth?token=t" }, true, true);

    expect(command.tool).toBe("terminal-notifier");
    expect(command.argv[0]).toBe("terminal-notifier");
    expect(command.argv).toContain("-open");
    expect(command.argv).toContain("http://127.0.0.1:4747/auth?token=t");
    expect(command.argv).toContain("-sound");
  });

  test("terminal-notifier missing → falls back to osascript, no click action, even with an openUrl", () => {
    const command = buildMacNotifierCommand({ ...notification, openUrl: "http://127.0.0.1:4747/auth?token=t" }, true, false);

    expect(command.tool).toBe("osascript");
    expect(command.argv[0]).toBe("osascript");
    expect(command.argv.join(" ")).not.toContain("http://127.0.0.1:4747");
  });

  test("no openUrl at all → osascript even when terminal-notifier IS on PATH (nothing to open)", () => {
    const command = buildMacNotifierCommand(notification, true, true);

    expect(command.tool).toBe("osascript");
  });

  test("no sound this time → terminal-notifier argv omits -sound", () => {
    const command = buildMacNotifierCommand({ ...notification, openUrl: "http://x" }, false, true);

    expect(command.argv).not.toContain("-sound");
  });
});

describe("buildThresholdCrossedNotification (🔴)", () => {
  test("reflects the Policy's ACTUAL threshold, never a hardcoded 200k", () => {
    const notification = buildThresholdCrossedNotification({
      project: "reservee",
      role: "RES-131",
      session: "b71",
      contextTokens: 242_170,
      thresholdTokens: 100_000,
    });

    expect(notification.title).toBe("🔴 Tenaza · pasó 100k");
    expect(notification.subtitle).toBe("reservee / RES-131 / sesión b71");
    expect(notification.message).toBe("242k tokens");
    expect(notification.tag).toBe("threshold-b71");
  });
});

describe("buildGraveFaultNotification (ADR 0007, ticket 02: grave-only)", () => {
  test("es-AR chrome around the (English) fault message, a stable deterministic tag", () => {
    const notification = buildGraveFaultNotification("policy.toml is invalid and no last-known-good policy exists yet — no Rules are active.");

    expect(notification).toEqual({
      tag: "health-grave",
      title: "🔴 Tenaza · degradado",
      subtitle: "guardrail apagado",
      message: "policy.toml is invalid and no last-known-good policy exists yet — no Rules are active.",
    });
  });

  test("the tag never changes with the message — never random, never time-based", () => {
    expect(buildGraveFaultNotification("a").tag).toBe(buildGraveFaultNotification("b").tag);
  });
});

describe("notifyGraveFault (the ONE call site: cli.ts's runHookClaude, when degraded.grave)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-notify-grave-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("records the grave-fault notification through the SAME recorder seam", () => {
    notifyGraveFault(home, "no Rules are active", new Date(0));

    const recorded = readNotificationRecorder(home);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.title).toBe("🔴 Tenaza · degradado");
    expect(recorded[0]?.message).toBe("no Rules are active");
  });

  test("never throws, even when its own bookkeeping fails", () => {
    writeFileSync(path.join(home, "state"), "not a directory");
    expect(() => notifyGraveFault(home, "whatever")).not.toThrow();
  });
});

describe("sendNotification (the notifier port itself, via the recorder test seam)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-notify-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("records what would have been sent, sound:true when nothing has sounded yet", () => {
    sendNotification(home, { tag: "t", title: "T", subtitle: "S", message: "M" }, new Date(0));

    expect(readNotificationRecorder(home)).toEqual([
      { tag: "t", title: "T", subtitle: "S", message: "M", sound: true },
    ]);
  });

  test("three sends within the burst window record sound:false for everything after the first (AC: one sound)", () => {
    sendNotification(home, { tag: "a", title: "A", subtitle: "", message: "" }, new Date(0));
    sendNotification(home, { tag: "b", title: "B", subtitle: "", message: "" }, new Date(500));
    sendNotification(home, { tag: "c", title: "C", subtitle: "", message: "" }, new Date(1000));

    const notifications = readNotificationRecorder(home);
    expect(notifications).toHaveLength(3); // every Event still notifies — only the SOUND is throttled
    expect(notifications.map((n) => n.sound)).toEqual([true, false, false]);
  });

  test("once the burst window passes, the next send sounds again", () => {
    sendNotification(home, { tag: "a", title: "A", subtitle: "", message: "" }, new Date(0));
    sendNotification(
      home,
      { tag: "b", title: "B", subtitle: "", message: "" },
      new Date(NOTIFY_BURST_WINDOW_MS + 1),
    );

    expect(readNotificationRecorder(home).map((n) => n.sound)).toEqual([true, true]);
  });

  test("a failing notifier never throws — even when its OWN bookkeeping fails, not just macOS", () => {
    // `state/` is a FILE, not a directory: the sound-state and recorder
    // writes underneath it both throw ENOTDIR. The guard must hold anyway.
    writeFileSync(path.join(home, "state"), "not a directory");

    expect(() =>
      sendNotification(home, { tag: "t", title: "T", subtitle: "S", message: "M" }),
    ).not.toThrow();
  });
});
