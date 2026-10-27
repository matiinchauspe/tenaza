import { describe, expect, test } from "bun:test";
import { parseRunOutput, runFailureTrailer, RUN_FAILURE_MARKER } from "../src/runoutput";

describe("runFailureTrailer / parseRunOutput (ticket 09 review fix)", () => {
  test("a stream with no trailer at all parses as pure body, no error", () => {
    const parsed = parseRunOutput("hola\nmundo\n");
    expect(parsed).toEqual({ body: "hola\nmundo\n", error: undefined });
  });

  test("an empty output (nothing ran yet, or a silent success) parses as empty body, no error", () => {
    expect(parseRunOutput("")).toEqual({ body: "", error: undefined });
  });

  test("a failure trailer with no preceding output parses to an empty body and the trailer as error", () => {
    const output = `${runFailureTrailer(1)}`;
    const parsed = parseRunOutput(output);
    expect(parsed.body).toBe("");
    expect(parsed.error).toBe(`${RUN_FAILURE_MARKER}1`);
  });

  test("a failure trailer after real output separates cleanly, stripping all trailing newlines from the body", () => {
    const output = `falló${runFailureTrailer(3)}`;
    const parsed = parseRunOutput(output);
    expect(parsed.body).toBe("falló");
    expect(parsed.error).toBe(`${RUN_FAILURE_MARKER}3`);
  });

  test("different exit codes round-trip through the marker", () => {
    expect(parseRunOutput(runFailureTrailer(127)).error).toBe(`${RUN_FAILURE_MARKER}127`);
    expect(parseRunOutput(runFailureTrailer(2)).error).toBe(`${RUN_FAILURE_MARKER}2`);
  });

  test("output that merely MENTIONS the marker text, with no real trailer appended, still parses it — this is a cheap textual split, not a structured protocol", () => {
    // Documented limitation: the marker is plain text, not escaped/framed —
    // a command that happens to print the exact marker string itself would
    // be (mis)read as a failure trailer. Accepted: no real command prints
    // "✗ salió con código " as its own output.
    const output = `echo "${RUN_FAILURE_MARKER}1"`;
    expect(parseRunOutput(output).error).toBe(`${RUN_FAILURE_MARKER}1"`);
  });
});
