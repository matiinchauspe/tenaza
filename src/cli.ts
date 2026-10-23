#!/usr/bin/env bun
import { handleClaudeHook } from "./adapters/claude";
import { tenazaHome } from "./paths";
import {
  type ResolutionOutcome,
  resolveInboxItem,
  runInboxItem,
  UnknownInboxItemError,
} from "./resolve";
import { renderStatus } from "./status";

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

async function runHookClaude(): Promise<number> {
  const raw = await readStdin();
  const payload = JSON.parse(raw);
  const response = handleClaudeHook(tenazaHome(), payload);
  if (response) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
  return 0;
}

function runStatus(): number {
  process.stdout.write(renderStatus(tenazaHome()));
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
    process.stderr.write(
      `tenaza: inbox #${id} stays open — command exited ${outcome.exitCode}\n`,
    );
    return 1;
  } catch (error) {
    if (error instanceof UnknownInboxItemError) return reportUnknown(id);
    throw error;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, subcommand] = argv;

  if (command === "hook" && subcommand === "claude") {
    return await runHookClaude();
  }

  if (command === "status") {
    return runStatus();
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

  process.stderr.write(`tenaza: unknown command "${argv.join(" ")}"\n`);
  return 1;
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
