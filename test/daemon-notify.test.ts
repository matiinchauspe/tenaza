import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { actionDecidedEvent, sessionLabeledEvent } from "../src/contract/event";
import { inboxIdentityHash } from "../src/identity";
import { appendEvent } from "../src/log";
import { notifyNewInboxItem, readNotificationRecorder, type RecordedNotification } from "../src/notify";
import { runCli } from "./support/cli";
import { spawnDaemon } from "./support/daemon";

const POLL_MS = "50";

async function waitForNotifications(home: string, count: number, timeoutMs: number): Promise<RecordedNotification[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recorded = readNotificationRecorder(home);
    if (recorded.length >= count) return recorded;
    await Bun.sleep(25);
  }
  return readNotificationRecorder(home);
}

describe("the Daemon notifies Inbox items it reads from state", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-daemon-notify-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** Just the Inbox event, with no hook ever having attempted to notify it — no relay request lands from this alone. */
  function writeInboxEvent(session: string, command: string): string {
    appendEvent(home, sessionLabeledEvent(session, { project: "crisol" }));
    appendEvent(
      home,
      actionDecidedEvent(session, { kind: "shell", command, tool: "Bash" }, "held", { match: "gh pr merge", effect: "human" }),
    );
    return inboxIdentityHash(session, 2);
  }

  /** The one way a relay request lands in state: a hook's own failed delivery attempt. */
  function failedHookDelivery(id: string): void {
    const savedPath = process.env.PATH;
    const savedRecorder = process.env.TENAZA_NOTIFY_RECORDER;
    try {
      process.env.PATH = "";
      delete process.env.TENAZA_NOTIFY_RECORDER;
      notifyNewInboxItem(home, id, id.slice(0, 4));
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedRecorder === undefined) delete process.env.TENAZA_NOTIFY_RECORDER;
      else process.env.TENAZA_NOTIFY_RECORDER = savedRecorder;
    }
  }

  function writeRelayedSandboxItem(session: string, command: string): string {
    const id = writeInboxEvent(session, command);
    failedHookDelivery(id);
    return id;
  }

  /** Stamps the item's own `ts`, so a test can simulate a guest clock lagging the host's. */
  function writeRelayedSandboxItemAt(session: string, command: string, ts: string): string {
    appendEvent(home, sessionLabeledEvent(session, { project: "crisol" }));
    const event = actionDecidedEvent(session, { kind: "shell", command, tool: "Bash" }, "held", {
      match: "gh pr merge",
      effect: "human",
    });
    appendEvent(home, { ...event, ts });
    const id = inboxIdentityHash(session, 2);
    failedHookDelivery(id);
    return id;
  }

  test("an item a Sandbox hook's failed delivery left relayed gets exactly one from the running Daemon", async () => {
    const daemon = await spawnDaemon(["--port", "0", "--no-open"], { home, env: { TENAZA_SSE_POLL_MS: POLL_MS } });
    try {
      const id = writeRelayedSandboxItem("sess-1", "gh pr merge 58");

      const recorded = await waitForNotifications(home, 1, 3000);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.tag).toBe(`inbox-${id}`);
      expect(recorded[0]?.subtitle).toContain("crisol");
      expect(recorded[0]?.message).toContain("gh pr merge 58");

      appendEvent(home, sessionLabeledEvent("sess-1", { ticket: "02" }));
      await Bun.sleep(300);
      expect(readNotificationRecorder(home)).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });

  test("a relayed item written before any Daemon has ever started here is notified once one first starts", async () => {
    const id = writeRelayedSandboxItem("sess-1", "gh pr merge 58");

    const daemon = await spawnDaemon(["--port", "0", "--no-open"], { home, env: { TENAZA_SSE_POLL_MS: POLL_MS } });
    try {
      const recorded = await waitForNotifications(home, 1, 3000);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.tag).toBe(`inbox-${id}`);
    } finally {
      await daemon.stop();
    }
  });

  test("an item a host hook already notified for is not notified again by the Daemon", async () => {
    mkdirSync(path.join(home, "config"), { recursive: true });
    // `wait_seconds = 0` keeps the live hold from blocking the hook for the default window.
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      '[[rule]]\nmatch = "gh pr merge"\neffect = "human"\n\n[live]\nwait_seconds = 0\n',
    );
    const daemon = await spawnDaemon(["--port", "0", "--no-open"], { home, env: { TENAZA_SSE_POLL_MS: POLL_MS } });
    try {
      const hook = await runCli(["hook", "claude"], {
        home,
        stdin: JSON.stringify({
          session_id: "sess-1",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "gh pr merge 58" },
        }),
      });
      expect(hook.exitCode).toBe(0);

      await Bun.sleep(300);
      expect(readNotificationRecorder(home)).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });

  test("an open item with no relay request is never notified by the Daemon, across first start and a restart", async () => {
    writeInboxEvent("sess-1", "gh pr merge 58");
    await Bun.sleep(10);

    const first = await spawnDaemon(["--port", "0", "--no-open"], { home, env: { TENAZA_SSE_POLL_MS: POLL_MS } });
    try {
      await Bun.sleep(300);
      expect(readNotificationRecorder(home)).toEqual([]);
    } finally {
      await first.stop();
    }

    const second = await spawnDaemon(["--port", "0", "--no-open"], { home, env: { TENAZA_SSE_POLL_MS: POLL_MS } });
    try {
      await Bun.sleep(300);
      expect(readNotificationRecorder(home)).toEqual([]);
    } finally {
      await second.stop();
    }
  });

  test("an item a Sandbox hook's failed delivery relays while the Daemon is stopped is notified once it restarts", async () => {
    const first = await spawnDaemon(["--port", "0", "--no-open"], { home, env: { TENAZA_SSE_POLL_MS: POLL_MS } });
    await first.stop();

    const id = writeRelayedSandboxItem("sess-1", "gh pr merge 58");

    const second = await spawnDaemon(["--port", "0", "--no-open"], { home, env: { TENAZA_SSE_POLL_MS: POLL_MS } });
    try {
      const recorded = await waitForNotifications(home, 1, 3000);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.tag).toBe(`inbox-${id}`);
    } finally {
      await second.stop();
    }
  });

  test("an item a host hook already notified for stays notified once across a Daemon restart", async () => {
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      '[[rule]]\nmatch = "gh pr merge"\neffect = "human"\n\n[live]\nwait_seconds = 0\n',
    );
    const first = await spawnDaemon(["--port", "0", "--no-open"], { home, env: { TENAZA_SSE_POLL_MS: POLL_MS } });
    try {
      const hook = await runCli(["hook", "claude"], {
        home,
        stdin: JSON.stringify({
          session_id: "sess-1",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "gh pr merge 58" },
        }),
      });
      expect(hook.exitCode).toBe(0);
      await Bun.sleep(300);
      expect(readNotificationRecorder(home)).toHaveLength(1);
    } finally {
      await first.stop();
    }

    const second = await spawnDaemon(["--port", "0", "--no-open"], { home, env: { TENAZA_SSE_POLL_MS: POLL_MS } });
    try {
      await Bun.sleep(300);
      expect(readNotificationRecorder(home)).toHaveLength(1);
    } finally {
      await second.stop();
    }
  });

  test("an item a Sandbox hook relays after the Daemon started still gets notified, even with its guest clock behind the host's", async () => {
    const daemon = await spawnDaemon(["--port", "0", "--no-open"], { home, env: { TENAZA_SSE_POLL_MS: POLL_MS } });
    try {
      const id = writeRelayedSandboxItemAt("sess-1", "gh pr merge 58", new Date(0).toISOString());

      const recorded = await waitForNotifications(home, 1, 3000);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.tag).toBe(`inbox-${id}`);
    } finally {
      await daemon.stop();
    }
  });

  test("a banner the Daemon sends opens the port it is bound to, not the default", async () => {
    const daemon = await spawnDaemon(["--port", "0", "--no-open"], { home, env: { TENAZA_SSE_POLL_MS: POLL_MS } });
    try {
      writeRelayedSandboxItem("sess-1", "gh pr merge 58");

      const recorded = await waitForNotifications(home, 1, 3000);
      expect(recorded[0]?.openUrl).toBe(`http://127.0.0.1:${daemon.port}/auth?token=${daemon.token}`);
    } finally {
      await daemon.stop();
    }
  });
});
