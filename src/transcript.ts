import { existsSync, readFileSync } from "node:fs";

/**
 * The context size Tenaza reports for a Session at one moment: the total
 * tokens that were IN the model's context window for the LATEST assistant
 * turn in its transcript — `input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens`, the same three numbers the Anthropic API bills
 * for that turn's prompt. `output_tokens` is deliberately excluded: it is
 * what the model just generated, not what was read into context for this
 * call — it reappears as `cache_read`/`cache_creation` on the NEXT turn's
 * usage, so adding it here would double-count it one line early. (Build-time
 * judgment call, ticket 04 — the ticket names the Event's shape but not this
 * formula; this is the ecosystem's own convention for "current context
 * size", not something the spec states.)
 *
 * Scans from the end of the file backward so "latest" never means "first" or
 * "largest" — the file's own chronological order decides. Any line that
 * fails to parse, or isn't an assistant turn carrying `usage`, is skipped
 * rather than treated as an error: a transcript is an external, unversioned
 * format Tenaza does not own.
 */
export function measureContextTokens(transcriptPath: string): number | undefined {
  if (!existsSync(transcriptPath)) return undefined;

  const lines = readFileSync(transcriptPath, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;

    const total = usageTotalFromLine(line);
    if (total !== undefined) return total;
  }
  return undefined;
}

function usageTotalFromLine(line: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;
  if (record.type !== "assistant") return undefined;

  const message = record.message;
  if (typeof message !== "object" || message === null) return undefined;

  const usage = (message as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return undefined;

  const usageRecord = usage as Record<string, unknown>;
  const input = numberField(usageRecord.input_tokens);
  if (input === undefined) return undefined;

  const cacheCreation = numberField(usageRecord.cache_creation_input_tokens) ?? 0;
  const cacheRead = numberField(usageRecord.cache_read_input_tokens) ?? 0;

  return input + cacheCreation + cacheRead;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
