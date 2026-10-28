import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inboxIdentityHash } from "../src/identity";
import { deriveInbox } from "../src/inbox";
import { readHumanEvents } from "../src/log";
import { runCli } from "./support/cli";
import { spawnDaemon } from "./support/daemon";

/**
 * Ticket 10's own named integration seam ("Testing Decisions"): "the test
 * writes or keeps a fresh heartbeat, pipes a `human` match into the hook
 * process (it holds), POSTs approve/reject with a message to the Daemon,
 * and asserts the hook's output... and the item's closed state." Every
 * OTHER live-answering test exercises `decideAction`/`waitForLiveAnswer`
 * directly (`test/decide.test.ts`, `test/live.test.ts`) or the adapter
 * (`test/adapters/claude.test.ts`) — this file is the ONE place a REAL
 * `tenaza hook claude` subprocess (unawaited, so it can be interacted with
 * while it's still polling) and a REAL `tenaza ui` Daemon process run
 * CONCURRENTLY against the SAME temp `TENAZA_HOME`, exactly as a human's
 * machine would.
 */
describe("Live answering, end to end: a real hook process held by a real Daemon", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-live-e2e-"));
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      `
[[rule]]
match = "gh pr merge"
effect = "human"

[live]
wait_seconds = 5
`,
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** The FIRST `action.decided` line a fresh Session's own hook call ever writes is line 1 — matching `decideAction`'s own `inboxIdentityHash(session, line)`. */
  function fullIdFor(session: string): string {
    return inboxIdentityHash(session, 1);
  }

  function startHoldingHook(session: string) {
    return runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: session,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 58 --merge" },
      }),
    });
  }

  test("approve, with a message: the held hook process returns allow + additionalContext, and the item closes as done", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      // Started, deliberately NOT awaited yet — the hook subprocess is now
      // out there, holding and polling `state/human.jsonl` on its own.
      const hookPromise = startHoldingHook("sess-e2e-approve");
      await Bun.sleep(150); // give it time to append the "held" line and start polling

      const fullId = fullIdFor("sess-e2e-approve");
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${fullId}/answer`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: "approve", message: "dale, adelante" }),
      });
      expect(res.status).toBe(200);

      const result = await hookPromise;
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput.permissionDecision).toBe("allow");
      expect(output.hookSpecificOutput.additionalContext).toBe("dale, adelante");

      expect(deriveInbox(home)).toHaveLength(0); // closed
      const resolved = readHumanEvents(home).find((e) => e.type === "approval.resolved");
      expect(resolved).toMatchObject({ data: { outcome: "done", via: "live" } });
    } finally {
      await daemon.stop();
    }
  });

  test("reject, with a message: the held hook process returns deny + the human's own reason, and the item closes as dismissed", async () => {
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const hookPromise = startHoldingHook("sess-e2e-reject");
      await Bun.sleep(150);

      const fullId = fullIdFor("sess-e2e-reject");
      const res = await fetch(`http://127.0.0.1:${daemon.port}/items/${fullId}/answer`, {
        method: "POST",
        headers: { cookie: `tenaza_token=${daemon.token}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: "reject", message: "primero corré los tests" }),
      });
      expect(res.status).toBe(200);

      const result = await hookPromise;
      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(output.hookSpecificOutput.permissionDecisionReason).toBe("primero corré los tests");

      expect(deriveInbox(home)).toHaveLength(0); // closed
      const resolved = readHumanEvents(home).find((e) => e.type === "approval.resolved");
      expect(resolved).toMatchObject({ data: { outcome: "dismissed", via: "live" } });
    } finally {
      await daemon.stop();
    }
  });

  test(
    "reject with NO message: the agent reads a generic reason, never a blank one",
    async () => {
      const daemon = await spawnDaemon(["--port", "0"], { home });
      try {
        const hookPromise = startHoldingHook("sess-e2e-reject-blank");
        await Bun.sleep(150);

        const fullId = fullIdFor("sess-e2e-reject-blank");
        await fetch(`http://127.0.0.1:${daemon.port}/items/${fullId}/answer`, {
          method: "POST",
          headers: { cookie: `tenaza_token=${daemon.token}`, "content-type": "application/json" },
          body: JSON.stringify({ answer: "reject" }),
        });

        const result = await hookPromise;
        const output = JSON.parse(result.stdout);
        expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
        expect(output.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0);
      } finally {
        await daemon.stop();
      }
    },
    // `yun-diagnose-bug`, CI flake on the v0.2.0 release run: this exercises
    // the SAME real-subprocess-plus-real-Daemon seam as "the Daemon's own
    // heartbeat going stale mid-wait" below (two spawned processes, an HTTP
    // round trip, a 150ms settle and at least one of the hook's own 500ms
    // `waitForLiveAnswer` poll ticks) — never a hang, measured under
    // synthetic heavy CPU contention (Docker `--cpus=0.25`) to reliably
    // finish in ~7.3–7.8s and never longer. Bun's default per-test timeout
    // (5000ms) has no margin left for a loaded runner; this test had none of
    // the sibling's explicit budget. Matching that sibling's own number
    // rather than inventing a new one.
    15_000,
  );

  test("expiry (no answer within the window): the hook denies itself, with the es-AR wording, and the item stays open as pending", async () => {
    // A short window so this test doesn't actually wait 5s.
    writeFileSync(
      path.join(home, "config", "policy.toml"),
      '[[rule]]\nmatch = "gh pr merge"\neffect = "human"\n\n[live]\nwait_seconds = 1\n',
    );
    const daemon = await spawnDaemon(["--port", "0"], { home });
    try {
      const result = await startHoldingHook("sess-e2e-expiry"); // nobody ever answers
      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain("nadie respondió");

      expect(deriveInbox(home)).toHaveLength(1); // still open
    } finally {
      await daemon.stop();
    }
  });

  test(
    "the Daemon's own heartbeat going stale mid-wait denies at once, well inside the configured window",
    async () => {
      writeFileSync(
        path.join(home, "config", "policy.toml"),
        '[[rule]]\nmatch = "gh pr merge"\neffect = "human"\n\n[live]\nwait_seconds = 30\n',
      );
      const daemon = await spawnDaemon(["--port", "0"], { home });
      try {
        const hookPromise = startHoldingHook("sess-e2e-stale");
        await Bun.sleep(150);

        const startedWaitingAt = Date.now();
        await daemon.stop(); // kills the Daemon — its heartbeat stops being refreshed and goes stale

        const result = await hookPromise;
        const elapsedMs = Date.now() - startedWaitingAt;

        const output = JSON.parse(result.stdout);
        expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
        expect(output.hookSpecificOutput.permissionDecisionReason).toContain("nadie respondió");
        // The heartbeat's own staleness threshold is a FIXED ~5s
        // (`daemonlink.ts`'s `DEFAULT_HEARTBEAT_STALE_MS`, not currently
        // env-overridable) — this only proves it fires well inside the
        // 30s window configured above, never that it fires INSTANTLY.
        expect(elapsedMs).toBeLessThan(29_000);
      } finally {
        // Already stopped above — calling again is a harmless no-op (`stopDaemon`'s own kill-if-still-there).
        await daemon.stop();
      }
    },
    15_000,
  );
});
