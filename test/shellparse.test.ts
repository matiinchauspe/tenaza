import { describe, expect, test } from "bun:test";
import { matchesContiguousRun, parseExecutedCommands, words } from "../src/shellparse";

describe("words", () => {
  test("splits on whitespace", () => {
    expect(words("gh pr merge")).toEqual(["gh", "pr", "merge"]);
  });

  test("collapses runs of whitespace and trims the ends", () => {
    expect(words("  gh   pr  merge  ")).toEqual(["gh", "pr", "merge"]);
  });

  test("a single word is its own one-element list", () => {
    expect(words("gh")).toEqual(["gh"]);
  });
});

describe("matchesContiguousRun", () => {
  test("matches an exact run", () => {
    expect(matchesContiguousRun(["gh", "pr", "merge"], ["gh", "pr", "merge"])).toBe(true);
  });

  test("matches a run wrapped by other words on either side", () => {
    expect(
      matchesContiguousRun(["gh", "pr", "merge"], ["timeout", "60", "gh", "pr", "merge", "58"]),
    ).toBe(true);
  });

  test("does not match when the words are not contiguous", () => {
    expect(matchesContiguousRun(["gh", "pr", "merge"], ["gh", "status", "pr", "merge"])).toBe(false);
  });

  test("does not match out-of-order words", () => {
    expect(matchesContiguousRun(["gh", "pr", "merge"], ["merge", "pr", "gh"])).toBe(false);
  });

  test("an empty needle never matches", () => {
    expect(matchesContiguousRun([], ["gh", "pr", "merge"])).toBe(false);
  });

  test("a needle longer than the haystack never matches", () => {
    expect(matchesContiguousRun(["gh", "pr", "merge", "extra"], ["gh", "pr", "merge"])).toBe(false);
  });
});

describe("parseExecutedCommands", () => {
  test("a simple command is its own argv", async () => {
    const parsed = await parseExecutedCommands("gh pr merge 58");
    expect(parsed?.commands).toContainEqual(["gh", "pr", "merge", "58"]);
  });

  test("timeout 60 gh pr merge 58: no launcher table needed — one flat command", async () => {
    const parsed = await parseExecutedCommands("timeout 60 gh pr merge 58");
    expect(parsed?.commands).toContainEqual(["timeout", "60", "gh", "pr", "merge", "58"]);
  });

  test("sudo gh pr merge 58: same flattening", async () => {
    const parsed = await parseExecutedCommands("sudo gh pr merge 58");
    expect(parsed?.commands).toContainEqual(["sudo", "gh", "pr", "merge", "58"]);
  });

  test("a double-quoted argument stays ONE word, never splits on its inner spaces", async () => {
    const parsed = await parseExecutedCommands('rg "gh pr merge"');
    expect(parsed?.commands).toContainEqual(["rg", "gh pr merge"]);
    // crucially, the three words must never show up as a contiguous run —
    // the whole point of this ticket.
    expect(parsed?.commands.some((argv) => matchesContiguousRun(["gh", "pr", "merge"], argv))).toBe(
      false,
    );
  });

  test("a single-quoted word is dequoted, so git 'push' still matches git push", async () => {
    const parsed = await parseExecutedCommands("git 'push'");
    expect(parsed?.commands).toContainEqual(["git", "push"]);
  });

  test("&& splits into two separate candidate commands", async () => {
    const parsed = await parseExecutedCommands("git log --oneline -3 && gh pr merge 58");
    expect(parsed?.commands).toContainEqual(["git", "log", "--oneline", "-3"]);
    expect(parsed?.commands).toContainEqual(["gh", "pr", "merge", "58"]);
  });

  test("a pipeline splits into two separate candidate commands", async () => {
    const parsed = await parseExecutedCommands("gh pr merge 58 | tee out.log");
    expect(parsed?.commands).toContainEqual(["gh", "pr", "merge", "58"]);
    expect(parsed?.commands).toContainEqual(["tee", "out.log"]);
  });

  test("$(...) command substitution is its own candidate command", async () => {
    const parsed = await parseExecutedCommands("echo $(gh pr merge 58)");
    expect(parsed?.commands).toContainEqual(["gh", "pr", "merge", "58"]);
  });

  test("a backtick substitution is its own candidate command", async () => {
    const parsed = await parseExecutedCommands("echo `gh pr merge 58`");
    expect(parsed?.commands).toContainEqual(["gh", "pr", "merge", "58"]);
  });

  test("bash -c re-parses its script string into its own candidate commands", async () => {
    const parsed = await parseExecutedCommands('bash -c "gh pr merge 58"');
    expect(parsed?.commands).toContainEqual(["gh", "pr", "merge", "58"]);
  });

  test("sh -c and zsh -c re-parse too", async () => {
    const sh = await parseExecutedCommands('sh -c "gh pr merge 58"');
    expect(sh?.commands).toContainEqual(["gh", "pr", "merge", "58"]);

    const zsh = await parseExecutedCommands('zsh -c "gh pr merge 58"');
    expect(zsh?.commands).toContainEqual(["gh", "pr", "merge", "58"]);
  });

  test("a clustered -lc flag is still recognized as the -c form", async () => {
    const parsed = await parseExecutedCommands('bash -lc "gh pr merge 58"');
    expect(parsed?.commands).toContainEqual(["gh", "pr", "merge", "58"]);
  });

  test("eval re-parses its joined argument string", async () => {
    const parsed = await parseExecutedCommands('eval "gh pr merge 58"');
    expect(parsed?.commands).toContainEqual(["gh", "pr", "merge", "58"]);
  });

  test("the outer wrapper command is STILL a candidate too — unwrapping adds, never replaces", async () => {
    const parsed = await parseExecutedCommands('bash -c "echo hi"');
    expect(
      parsed?.commands.some((argv) => argv[0] === "bash" && argv.includes("-c")),
    ).toBe(true);
  });

  test("a heredoc body is data: writing a reserved command's text never contributes a candidate command", async () => {
    const parsed = await parseExecutedCommands(
      "cat <<'EOF' > ticket.md\nThe ticket mentions gh pr merge as an example.\nEOF\n",
    );
    expect(parsed?.commands).toContainEqual(["cat"]);
    expect(parsed?.commands.some((argv) => matchesContiguousRun(["gh", "pr", "merge"], argv))).toBe(
      false,
    );
  });

  test("an UNQUOTED heredoc's own $(...) still parses as a real command, because bash actually runs it", async () => {
    const parsed = await parseExecutedCommands("cat <<EOF\n$(gh pr merge 58)\nEOF\n");
    expect(parsed?.commands).toContainEqual(["gh", "pr", "merge", "58"]);
  });

  test("a commit message argument is data, never a candidate's words", async () => {
    const parsed = await parseExecutedCommands('git commit -m "mentions gh pr merge as an example"');
    expect(parsed?.commands.some((argv) => matchesContiguousRun(["gh", "pr", "merge"], argv))).toBe(
      false,
    );
  });

  test("an expansion keeps its literal text, so a Rule written against the placeholder still matches", async () => {
    const parsed = await parseExecutedCommands("psql $PROD_DATABASE_URL");
    expect(parsed?.commands).toContainEqual(["psql", "$PROD_DATABASE_URL"]);
  });

  test("an unterminated quote signals a parse failure (undefined), never a silent empty result", async () => {
    const parsed = await parseExecutedCommands('echo "unterminated');
    expect(parsed).toBeUndefined();
  });

  test("a NESTED -c script that fails to parse is a FULL parse failure, never a silent drop of just that layer (orchestrator review)", async () => {
    // The outer `bash -c '...'` is itself perfectly valid — only the
    // WRAPPED script (`gh pr merge 58; if`, a dangling `if` with no
    // `then`/`fi`) fails to parse. Before the fix, `unwrapLauncherCommands`
    // swallowed that failure as `[]`, so the outer argv kept the whole
    // script as one quoted token and nothing ever matched — a false
    // negative where v0.1's raw substring would have denied.
    const parsed = await parseExecutedCommands("bash -c 'gh pr merge 58; if'");
    expect(parsed).toBeUndefined();
  });

  test("hitting the reparse depth cap with a launcher still left to unwrap is also a full parse failure", async () => {
    // Four levels of `bash -c` wrapping, each correctly single-quoted via
    // the standard close/insert/reopen idiom so every level round-trips
    // through a real bash. MAX_REPARSE_DEPTH caps at 3 successful unwraps,
    // so the 4th layer is left unresolved — this must fail the WHOLE parse
    // rather than let the deepest, unresolved command's absence read as
    // "no match".
    const singleQuote = (text: string): string => `'${text.split("'").join(`'"'"'`)}'`;
    let script = "gh pr merge 58";
    for (let depth = 0; depth < 4; depth++) script = `bash -c ${singleQuote(script)}`;

    const parsed = await parseExecutedCommands(script);
    expect(parsed).toBeUndefined();
  });
});
