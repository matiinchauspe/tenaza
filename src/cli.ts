#!/usr/bin/env bun
import { runClaudeHookSafely } from "./adapters/claude";
import { handleFakeHook } from "./adapters/fake";
import { runUi } from "./daemon";
import { readHealth, recordDegraded, recordHealthy } from "./health";
import { MIN_SHORT_HASH_LENGTH, resolvePrefix } from "./identity";
import { runInit } from "./init";
import { allInboxIdentityHashes, shortIdIndex } from "./inbox";
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
import { TENAZA_VERSION } from "./version";

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

/**
 * Parse an inbox id argument: a hex string (the hash `status`/the
 * notification showed, or any unique prefix of it), at least
 * `MIN_SHORT_HASH_LENGTH` characters long (decision 03, ADR 0005, ticket
 * 06) — never a bare position any more. Case-insensitive, normalized to
 * lowercase so `resolvePrefix` (which stores and compares hashes in
 * lowercase hex) matches regardless of how the human typed it.
 */
function parseInboxIdArg(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-9a-f]+$/i.test(raw)) return undefined;
  if (raw.length < MIN_SHORT_HASH_LENGTH) return undefined;
  return raw.toLowerCase();
}

function reportBadId(raw: string | undefined): number {
  process.stderr.write(
    `tenaza: "${raw ?? ""}" is not a valid inbox id — use the hash shown ` +
      `(at least ${MIN_SHORT_HASH_LENGTH} hex characters)\n`,
  );
  return 1;
}

function reportUnknown(prefix: string): number {
  process.stderr.write(`tenaza: unknown inbox item ${prefix}\n`);
  return 1;
}

/** "refused with both candidates listed" (decision 03) — never guesses between them. */
function reportAmbiguous(prefix: string, candidates: string[]): number {
  process.stderr.write(
    `tenaza: "${prefix}" matches more than one inbox item — be more specific:\n` +
      candidates.map((candidate) => `  ${candidate}\n`).join(""),
  );
  return 1;
}

type ResolvedId = { id: string } | { error: number };

/**
 * Resolve whatever the human typed — the full hash, or any unique prefix
 * of it, at least `MIN_SHORT_HASH_LENGTH` long — to exactly ONE full
 * identity hash, against the FULL history (resolved or not): a human may
 * still type an already-closed item's hash (e.g. running `done` twice),
 * which must report "already closed," never "unknown" (decision 03).
 * Never guesses: `run`/`done`/`dismiss` all funnel through this one
 * resolver so the three commands can never disagree about what a prefix
 * means.
 */
function resolveInboxIdArg(home: string, raw: string | undefined): ResolvedId {
  const prefix = parseInboxIdArg(raw);
  if (prefix === undefined) return { error: reportBadId(raw) };

  const universe = allInboxIdentityHashes(home);
  const match = resolvePrefix(prefix, universe);
  if (match.kind === "not-found") return { error: reportUnknown(prefix) };
  if (match.kind === "ambiguous") {
    const candidates = match.indices.flatMap((index) => {
      const hash = universe[index];
      return hash !== undefined ? [hash] : [];
    });
    return { error: reportAmbiguous(prefix, candidates) };
  }
  const id = universe[match.index];
  if (id === undefined) return { error: reportUnknown(prefix) };
  return { id };
}

/** The short, human-facing form of a FULL identity hash we already resolved — falls back to the full hash itself if it's somehow absent from the index (should not happen; defensive only). */
function displayId(home: string, id: string): string {
  return shortIdIndex(home).get(id) ?? id;
}

function runResolve(idArg: string | undefined, outcome: ResolutionOutcome): number {
  const home = tenazaHome();
  const resolved = resolveInboxIdArg(home, idArg);
  if ("error" in resolved) return resolved.error;
  const { id } = resolved;
  const shown = displayId(home, id);

  try {
    const result = resolveInboxItem(home, id, outcome);
    process.stdout.write(
      result.alreadyResolved
        ? `tenaza: inbox ${shown} is already closed\n`
        : `tenaza: inbox ${shown} closed (${outcome})\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof UnknownInboxItemError) return reportUnknown(shown);
    throw error;
  }
}

async function runRun(idArg: string | undefined): Promise<number> {
  const home = tenazaHome();
  const resolved = resolveInboxIdArg(home, idArg);
  if ("error" in resolved) return resolved.error;
  const { id } = resolved;
  const shown = displayId(home, id);

  try {
    const outcome = await runInboxItem(home, id);
    if (outcome.kind === "closed") {
      process.stdout.write(`tenaza: inbox ${shown} closed (done)\n`);
      return 0;
    }
    if (outcome.kind === "already-resolved") {
      process.stdout.write(`tenaza: inbox ${shown} is already closed\n`);
      return 0;
    }
    if (outcome.kind === "unblockable") {
      // ADR 0001, ticket 06: this Action already ran once, unblocked — `run`
      // would execute it a SECOND time, so it refuses outright. Human-facing
      // CLI copy, es-AR, same as `status`'s own Inbox marker for this case.
      process.stderr.write(
        `tenaza: inbox ${shown} ya corrió y no se pudo bloquear — no se puede volver a correr. ` +
          `Cerralo con \`tenaza done ${shown}\` o \`tenaza dismiss ${shown}\`.\n`,
      );
      return 1;
    }
    if (outcome.kind === "not-runnable") {
      // Decision 07, ticket 04: an `mcp` item has no stored shell command at
      // all. Human-facing CLI copy, es-AR, same tone as the unblockable case.
      process.stderr.write(
        `tenaza: inbox ${shown} es una llamada MCP y no tiene comando para correr. ` +
          `Cerralo con \`tenaza done ${shown}\` o \`tenaza dismiss ${shown}\`.\n`,
      );
      return 1;
    }
    if (outcome.kind === "no-cwd") {
      // Ticket 06: the Session never started (no cwd to run in at all) —
      // refuse outright rather than silently run somewhere the human never
      // asked for (`resolve.ts`'s own doc comment).
      process.stderr.write(
        `tenaza: inbox ${shown} no tiene cwd conocido para su Session — no se corrió nada. ` +
          `Corré el comando a mano: ${outcome.command}\n`,
      );
      return 1;
    }
    if (outcome.kind === "cwd-missing") {
      // Ticket 06: the Session's own directory no longer exists (e.g. a
      // worktree already removed) — same refusal, different reason.
      process.stderr.write(
        `tenaza: inbox ${shown}: el directorio de su Session ya no existe (${outcome.cwd}) — ` +
          `no se corrió nada. Corré el comando a mano: ${outcome.command}\n`,
      );
      return 1;
    }
    process.stderr.write(
      `tenaza: inbox ${shown} stays open — command exited ${outcome.exitCode}\n`,
    );
    return 1;
  } catch (error) {
    if (error instanceof UnknownInboxItemError) return reportUnknown(shown);
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

/** `tenaza ui --port <n>` (ticket 07): the only flag this command takes. An invalid or dangling `--port` is a clear argument error, never a silent fallback to the default. */
function parseUiArgs(args: string[]): { port?: number } | { error: string } {
  let port: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--port") continue;
    const raw = args[i + 1];
    const parsed = raw !== undefined ? Number(raw) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { error: `invalid --port value: "${raw ?? ""}"` };
    }
    port = parsed;
    i++;
  }
  return { port };
}

async function main(argv: string[]): Promise<number> {
  const [command, subcommand] = argv;

  // `tenaza --version` (ticket 05): prints the SAME single-source constant
  // `health.ts`'s self-check already reads — never a second, independently
  // bumped copy (e.g. `package.json`'s own version, which a compiled
  // `bun build --compile` binary cannot read at runtime anyway).
  if (command === "--version") {
    process.stdout.write(`${TENAZA_VERSION}\n`);
    return 0;
  }

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

  if (command === "ui") {
    const parsed = parseUiArgs(argv.slice(1));
    if ("error" in parsed) {
      process.stderr.write(`tenaza: ${parsed.error}\n`);
      return 1;
    }
    return await runUi({ port: parsed.port });
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
