import { existsSync, readFileSync } from "node:fs";

/**
 * Includes `input_tokens` and both cache fields, never `output_tokens` —
 * that's what the model just generated, not what was read into context
 * for this call; it reappears as `cache_read`/`cache_creation` on the
 * NEXT turn's usage, so counting it here would double it one line early.
 *
 * Skips any line that fails to parse or isn't an assistant turn carrying
 * `usage`, rather than erroring — a transcript is an external, unversioned
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
