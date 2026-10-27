#!/usr/bin/env bun
import { runClaudeHookSafely } from "./adapters/claude";
import { handleFakeHook } from "./adapters/fake";
import { readHealth, recordDegraded, recordHealthy } from "./health";
import { runInit } from "./init";
import { notifyGraveFault } from "./notify";
import { claudeSettingsPath, policyPath, tenazaHome } from "./paths";
import {
  type ResolutionOutcome,
  resolveInboxItem,
  runInboxItem,
  UnknownInboxItemError,
} from "./resolve";
import { renderStatus } from "./status";
import { formatStatusline } from "./statusline";

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

/**
 * Has Tenaza just crossed INTO this grave fault, rather than already being
 * in it (orchestrator review, ticket 02)? Reads `state/health.json` as it
 * stood BEFORE this call's own `recordDegraded` — absent, healthy, a
 * non-grave fault, or a DIFFERENT grave message (a distinct fault earns its
 * own alert even while another grave one never cleared) all count as a
 * transition; the SAME grave message repeating does not. Without this, a
 * grave Policy fault — which makes EVERY PreToolUse call grave — would ring
 * once per Bash/MCP call across every parallel agent, not once per fault
 * (the spec's own "a macOS notification... for grave faults", singular per
 * fault, not per call).
 *
 * Concurrency: this read and the `recordDegraded` write right after it are
 * two separate, non-atomic steps, and `tenaza hook claude` runs as a fresh
 * process per call — two hooks racing on the FIRST grave call can both read
 * "healthy" before either writes, so both notify. Accepted, not fixed with
 * a lock: it costs one duplicate banner on the rare race that opens a
 * grave state, never a banner per ordinary call once it's already open.
 */
function enteredGraveState(home: string, degraded: { message: string; grave: boolean }): boolean {
  if (!degraded.grave) return false;
  const previous = readHealth(home);
  return previous === undefined || !previous.grave || previous.cause !== degraded.message;
}

/**
 * `hook claude` (ADR 0007, tickets 01-02): the whole dispatch runs through
 * `runClaudeHookSafely`, which never throws — on any fault, known or not,
 * it hands back a non-blocking answer plus a `systemMessage` naming it.
 * This entry point's own job is just the surrounding bookkeeping: read
 * stdin, print whatever comes back, keep `state/health.json` in step
 * (written on a degraded answer, cleared by the next healthy one), and —
 * the ONE call site, so it covers a grave fault however it was noticed
 * (the SessionStart self-check or a PreToolUse call hitting the same
 * Policy state) — fire the macOS notification on the TRANSITION into a
 * grave state only, never on every call it stays grave through (see
 * `enteredGraveState`'s own doc).
 */
async function runHookClaude(): Promise<number> {
  const home = tenazaHome();
  const raw = await readStdin();
  const { output, degraded } = await runClaudeHookSafely(home, raw);

  if (degraded) {
    const shouldNotify = enteredGraveState(home, degraded);
    recordDegraded(home, degraded.message, degraded.grave);
    if (shouldNotify) notifyGraveFault(home, degraded.message);
  } else {
    recordHealthy(home);
  }

  if (output) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
  return 0;
}

/**
 * `hook fake` — the test Adapter's own entry point (ADR 0001, ticket 06): a
 * repo-internal tool for the black-box test seam, never wired into a real
 * agent runtime. Naming "claude" and "fake" here, in the CLI's own command
 * dispatch, is unavoidable wiring (routing one argument to one Adapter
 * module) — never the CORE branching ADR 0001 forbids, which lives in
 * `decide.ts`/`sessions.ts` and knows Capabilities only, never this string.
 */
async function runHookFake(): Promise<number> {
  const raw = await readStdin();
  const payload = JSON.parse(raw);
  const response = await handleFakeHook(tenazaHome(), payload);
  if (response) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
  return 0;
}

function runStatus(): number {
  process.stdout.write(renderStatus(tenazaHome()));
  return 0;
}

/**
 * `tenaza statusline` (ticket 07, q19/q20): Claude Code pipes its own
 * statusline JSON on stdin (model, cost, workspace, …) — Tenaza's line comes
 * entirely from its OWN derived state (no daemon, ADR 0002), never from that
 * payload, so stdin is drained and ignored outright rather than parsed. That
 * also makes AC3 ("accepts the statusline JSON on stdin without failing, and
 * ignores fields it does not use") hold even for malformed or non-JSON
 * input: there is nothing here that could ever throw on it.
 */
async function runStatusline(): Promise<number> {
  await readStdin();
  process.stdout.write(`${formatStatusline(tenazaHome())}\n`);
  return 0;
}

/** Parse an inbox id argument: a positive integer, written exactly as digits. */
function parseInboxId(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  return id > 0 ? id : undefined;
}

function reportBadId(raw: string | undefined): number {
  process.stderr.write(`tenaza: "${raw ?? ""}" is not a valid inbox id\n`);
  return 1;
}

function reportUnknown(id: number): number {
  process.stderr.write(`tenaza: unknown inbox item #${id}\n`);
  return 1;
}

function runResolve(idArg: string | undefined, outcome: ResolutionOutcome): number {
  const id = parseInboxId(idArg);
  if (id === undefined) return reportBadId(idArg);

  try {
    const result = resolveInboxItem(tenazaHome(), id, outcome);
    process.stdout.write(
      result.alreadyResolved
        ? `tenaza: inbox #${id} is already closed\n`
        : `tenaza: inbox #${id} closed (${outcome})\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof UnknownInboxItemError) return reportUnknown(id);
    throw error;
  }
}

async function runRun(idArg: string | undefined): Promise<number> {
  const id = parseInboxId(idArg);
  if (id === undefined) return reportBadId(idArg);

  try {
    const outcome = await runInboxItem(tenazaHome(), id);
    if (outcome.kind === "closed") {
      process.stdout.write(`tenaza: inbox #${id} closed (done)\n`);
      return 0;
    }
    if (outcome.kind === "already-resolved") {
      process.stdout.write(`tenaza: inbox #${id} is already closed\n`);
      return 0;
    }
    if (outcome.kind === "unblockable") {
      // ADR 0001, ticket 06: this Action already ran once, unblocked — `run`
      // would execute it a SECOND time, so it refuses outright. Human-facing
      // CLI copy, es-AR, same as `status`'s own Inbox marker for this case.
      process.stderr.write(
        `tenaza: inbox #${id} ya corrió y no se pudo bloquear — no se puede volver a correr. ` +
          `Cerralo con \`tenaza done ${id}\` o \`tenaza dismiss ${id}\`.\n`,
      );
      return 1;
    }
    if (outcome.kind === "not-runnable") {
      // Decision 07, ticket 04: an `mcp` item has no stored shell command at
      // all. Human-facing CLI copy, es-AR, same tone as the unblockable case.
      process.stderr.write(
        `tenaza: inbox #${id} es una llamada MCP y no tiene comando para correr. ` +
          `Cerralo con \`tenaza done ${id}\` o \`tenaza dismiss ${id}\`.\n`,
      );
      return 1;
    }
    process.stderr.write(
      `tenaza: inbox #${id} stays open — command exited ${outcome.exitCode}\n`,
    );
    return 1;
  } catch (error) {
    if (error instanceof UnknownInboxItemError) return reportUnknown(id);
    throw error;
  }
}

/**
 * `tenaza init` (ticket 09, q16): prepare a machine. Prints exactly what it
 * did (or deliberately didn't) to each of the two files it touches — the
 * Policy and Claude Code's own settings — so a human re-running it is never
 * left guessing why nothing changed.
 */
function runInitCommand(): number {
  const result = runInit();

  process.stdout.write(
    result.policyWritten
      ? `tenaza: wrote ${policyPath()} from policy.example.toml — review it before trusting any Rule\n`
      : `tenaza: left ${policyPath()} untouched (already exists)\n`,
  );

  if (result.statusLine === "set") {
    process.stdout.write(`tenaza: set statusLine in ${claudeSettingsPath()} to run \`tenaza statusline\`\n`);
  } else if (result.statusLine === "already-set") {
    process.stdout.write(
      `tenaza: statusLine already set in ${claudeSettingsPath()} — left it untouched. Paste this into your script:\n` +
        `  ${result.pasteLine}\n`,
    );
  } else {
    process.stdout.write(
      `tenaza: could not read ${claudeSettingsPath()} as JSON — left it untouched. Paste this into your script:\n` +
        `  ${result.pasteLine}\n`,
    );
  }

  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, subcommand] = argv;

  if (command === "hook" && subcommand === "claude") {
    return await runHookClaude();
  }

  if (command === "hook" && subcommand === "fake") {
    return await runHookFake();
  }

  if (command === "status") {
    return runStatus();
  }

  if (command === "init") {
    return runInitCommand();
  }

  if (command === "statusline") {
    return await runStatusline();
  }

  if (command === "run") {
    return await runRun(subcommand);
  }

  if (command === "done") {
    return runResolve(subcommand, "done");
  }

  if (command === "dismiss") {
    return runResolve(subcommand, "dismissed");
  }

  if (command === "label") {
    // The real work happens in the PreToolUse hook, which alone knows this
    // call's agent_id/session_id (ADR 0003) — this subprocess has neither,
    // so it does nothing with its args and only ever exits 0, whatever they
    // are. Never fails: a confusing error here would be the opposite of
    // the point of announcing this way.
    return 0;
  }

  process.stderr.write(`tenaza: unknown command "${argv.join(" ")}"\n`);
  return 1;
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
