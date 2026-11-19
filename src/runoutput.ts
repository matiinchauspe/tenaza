/**
 * The streamed `run` output's own trailer format: a non-zero exit must be
 * visible in the card, not merely inferred from the Inbox staying open —
 * a stored command like `false` prints nothing on its own, so a silent
 * stream end reads exactly like a no-op success.
 *
 * `startInboxItemRunStream` (`resolve.ts`, server-side) appends this exact
 * trailer to the streamed bytes on any non-zero exit, immediately before
 * closing the stream. `InboxCard.tsx` (browser-side) parses it back out of
 * the accumulated output to style it red, separately from the command's
 * own stdout/stderr. Shared here, in a zero-import module, so the writer
 * and the reader can never disagree on the exact text to look for —
 * picking a different marker on either side would silently stop the error
 * from ever rendering as an error at all.
 */
export const RUN_FAILURE_MARKER = "✗ salió con código ";

/**
 * The exact bytes `startInboxItemRunStream` enqueues before closing a
 * failed run's stream — a leading newline (separating it from whatever
 * output came before) and a trailing one (so a client appending more text
 * after never runs onto this line).
 */
export function runFailureTrailer(exitCode: number): string {
  return `\n${RUN_FAILURE_MARKER}${exitCode}\n`;
}

export interface ParsedRunOutput {
  /**
   * Everything before the trailer — the command's own stdout+stderr, with
   * every trailing newline stripped (the command's own final newline, if
   * any, plus the trailer's own separating one — both are just whitespace
   * between two logical pieces, never meaningful content a `<pre>` needs
   * preserved).
   */
  body: string;
  /** The trailer line itself (no leading/trailing newline), or `undefined` when this output carries no failure trailer at all (still running, or exited 0). */
  error: string | undefined;
}

/**
 * Split an accumulated `run` output into its own body and (if present)
 * its failure trailer — the one place either side of this format is
 * parsed, so `InboxCard` never hand-rolls a second, possibly-drifting
 * split.
 */
export function parseRunOutput(output: string): ParsedRunOutput {
  const markerIndex = output.lastIndexOf(RUN_FAILURE_MARKER);
  if (markerIndex === -1) return { body: output, error: undefined };
  const body = output.slice(0, markerIndex).replace(/\n+$/, "");
  const error = output.slice(markerIndex).trimEnd();
  return { body, error };
}
