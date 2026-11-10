import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSessionEvents } from "../src/log";
import { policyPath } from "../src/paths";
import { runCli } from "./support/cli";

/**
 * Black-box seam the ticket names (announce-declaration/01): `tenaza hook
 * claude` declares the announce command to every Session it observes, so a
 * harness finds it by its shape — never by Tenaza's name. SessionStart and
 * SubagentStart both return it as `additionalContext`, which Claude Code adds
 * to that Session's own context before its first prompt
 * (code.claude.com/docs/en/hooks, SubagentStart: "String added to the
 * subagent's context at the start of its conversation").
 */
describe("announce-declaration/01: the announce command is declared to every Session", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-announce-declaration-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function hook(payload: Record<string, unknown>) {
    const result = await runCli(["hook", "claude"], { home, stdin: JSON.stringify(payload) });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout);
  }

  const sessionStart = () => hook({ session_id: "sess-1", hook_event_name: "SessionStart", cwd: "/repo" });
  const subagentStart = () =>
    hook({ session_id: "sess-1", hook_event_name: "SubagentStart", agent_id: "agent-1", cwd: "/repo" });

  test("SessionStart returns the declaration as additionalContext", async () => {
    const response = await sessionStart();

    expect(response.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext: expect.stringContaining("tenaza label <key>=<value>"),
    });
    expect(response.systemMessage).toBeUndefined();
  });

  test("SubagentStart returns the same declaration as additionalContext", async () => {
    const top = await sessionStart();
    const sub = await subagentStart();

    expect(sub.hookSpecificOutput).toEqual({
      hookEventName: "SubagentStart",
      additionalContext: top.hookSpecificOutput.additionalContext,
    });
  });

  test("the declaration is one sentence and never names a harness", async () => {
    const line: string = (await sessionStart()).hookSpecificOutput.additionalContext;

    expect(line).not.toContain("\n");
    expect(line.trim().match(/[.!?](\s|$)/g)).toHaveLength(1);
    expect(line.trim().endsWith(".")).toBe(true);
    expect(line.toLowerCase()).not.toContain("yunque");
    expect(line).toContain("project");
    expect(line).toContain("single-word values"); // the parser takes no quoting — say so (announce-declaration/01 review)
  });

  test("a SubagentStart whose log write fails still declares, like SessionStart", async () => {
    mkdirSync(path.join(home, "state"), { recursive: true });
    chmodSync(path.join(home, "state"), 0o555);
    try {
      const response = await subagentStart();
      expect(readSessionEvents("agent-1", home)).toHaveLength(0); // the write really failed
      expect(response.hookSpecificOutput?.additionalContext).toBe(
        (await sessionStart()).hookSpecificOutput?.additionalContext,
      );
      expect(response.hookSpecificOutput?.additionalContext).toContain("tenaza label");
    } finally {
      chmodSync(path.join(home, "state"), 0o755);
    }
  });

  test("following only the declared line, a subagent's announce labels that subagent's Session", async () => {
    const line: string = (await subagentStart()).hookSpecificOutput.additionalContext;
    const template = line.match(/`(tenaza label [^`]*)`/)?.[1];
    expect(template).toBeDefined();

    const command = template!.replace(/<key>=<value>(\s*…)?/, "project=acme ticket=T-1 verdict=pass");
    await runCli(["hook", "claude"], {
      home,
      stdin: JSON.stringify({
        session_id: "sess-1",
        agent_id: "agent-1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      }),
    });

    expect(readSessionEvents("agent-1", home)).toContainEqual(
      expect.objectContaining({
        type: "session.labeled",
        data: { labels: { project: "acme", ticket: "T-1", verdict: "pass" } },
      }),
    );
    expect(readSessionEvents("sess-1", home).some((event) => event.type === "session.labeled")).toBe(false);
  });

  test("a degraded SessionStart still declares, beside its self-check warning", async () => {
    mkdirSync(path.join(home, "config"), { recursive: true });
    writeFileSync(policyPath(home), "[[rule\nmatch = broken");

    const response = await sessionStart();

    expect(response.systemMessage).toContain("no Rules are active");
    expect(response.hookSpecificOutput.additionalContext).toContain("tenaza label");
  });
});
