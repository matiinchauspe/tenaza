#!/usr/bin/env bun
import { handleClaudeHook } from "./adapters/claude";
import { tenazaHome } from "./paths";
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

async function main(argv: string[]): Promise<number> {
  const [command, subcommand] = argv;

  if (command === "hook" && subcommand === "claude") {
    return await runHookClaude();
  }

  if (command === "status") {
    return runStatus();
  }

  process.stderr.write(`tenaza: unknown command "${argv.join(" ")}"\n`);
  return 1;
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
