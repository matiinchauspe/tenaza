import { Language, type Node, Parser } from "web-tree-sitter";
// Bun's `with { type: "file" }` import attribute hands back a PATH, never
// the bytes — `web-tree-sitter.wasm` is the Emscripten-compiled parser
// RUNTIME, `tree-sitter-bash.wasm` is the bash GRAMMAR loaded on top of
// it.
import treeSitterRuntimeWasm from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import bashGrammarWasm from "tree-sitter-bash/tree-sitter-bash.wasm" with { type: "file" };

/**
 * `bash`/`sh`/`zsh`/`dash`/`ksh` invoked with `-c` (clustered forms like
 * `-lc`/`-ec` included) carry their script as a STRING argument
 * tree-sitter never parses on its own — it stays one opaque token. `eval`
 * does the same with its (possibly several) arguments, joined into one
 * script. Both get re-parsed as their own program; every other launcher
 * (`timeout`, `sudo`, …) needs NO special handling, because tree-sitter
 * has no notion of "launcher" — it flattens the whole wrapped invocation
 * into one `command` node's argv, which is exactly what lets a Rule's
 * contiguous-run match catch `sudo gh pr merge 58` with no table.
 */
const SHELL_LAUNCHERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const SHELL_DASH_C_FLAG = /^-\w*c\w*$/;

/** Caps how many times a `-c`/`eval` string re-parses into another, so a crafted chain can't recurse forever. */
const MAX_REPARSE_DEPTH = 3;

/**
 * Thrown internally — and ONLY caught by `parseExecutedCommands`'s own
 * top-level try/catch — when a nested `-c`/`eval` string fails to parse,
 * or a launcher chain outruns `MAX_REPARSE_DEPTH` while a launcher is
 * still left to unwrap. Either way, this run's command set is INCOMPLETE:
 * the one command that couldn't resolve might have been exactly the one a
 * Rule names, so its absence must never read as "no match" — it makes the
 * WHOLE outer line count as a parse failure instead.
 */
class UnresolvedReparseError extends Error {}

let languagePromise: Promise<Language> | undefined;

/**
 * Load the bash grammar exactly once per process, lazily — nothing here
 * runs until the first call, which is the prefilter's whole point
 * (`policy.ts`'s `matchRule`): most Bash calls never mention any Rule's
 * first word and so never reach this at all.
 */
function loadBashLanguage(): Promise<Language> {
  if (!languagePromise) {
    languagePromise = (async () => {
      await Parser.init({ locateFile: () => treeSitterRuntimeWasm });
      return Language.load(bashGrammarWasm);
    })();
  }
  return languagePromise;
}

/**
 * Strip one layer of shell quoting from a literal node's own text — never
 * a word split, only quote removal: `"gh pr merge"` keeps its spaces as
 * ONE word, `'push'` becomes `push`.
 */
function stripQuotes(text: string): string {
  if (text.length >= 2 && text.startsWith("$'") && text.endsWith("'")) return text.slice(2, -1);
  const first = text[0];
  const last = text[text.length - 1];
  if (text.length >= 2 && (first === '"' || first === "'") && last === first) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * The literal text a command's name or one of its arguments contributes to
 * its argv: quoted strings and heredoc bodies are DATA, so a quoted
 * string's own text is dequoted but never split on whitespace — `rg "gh pr
 * merge"` stays one argv word, never three. Expansions (`$FOO`, `${...}`)
 * keep their literal source text, so a Rule written against the literal
 * placeholder (`psql $PROD_DATABASE_URL`) still matches the word as
 * written.
 */
function wordText(node: Node): string {
  switch (node.type) {
    case "command_name":
    case "translated_string":
      return node.firstNamedChild ? wordText(node.firstNamedChild) : node.text;
    case "concatenation":
      return node.namedChildren.map(wordText).join("");
    case "string":
    case "raw_string":
    case "ansi_c_string":
      return stripQuotes(node.text);
    default:
      return node.text;
  }
}

/** One executed command's flat argv: its name, then its arguments, in source order — never its redirects, never a leading `variable_assignment` (those are separate fields/children this never reads). */
function commandArgv(command: Node): string[] {
  const name = command.childForFieldName("name");
  const args = command.childrenForFieldName("argument");
  return [...(name ? [wordText(name)] : []), ...args.map(wordText)];
}

/**
 * Every `command` node anywhere under `root`, at any depth. A quoted
 * heredoc body has no command children at all, so its text is never
 * walked into — this is what keeps a heredoc that merely WRITES a
 * reserved command's text from ever contributing a candidate.
 */
function collectCommandNodes(node: Node, out: Node[]): void {
  if (node.type === "command") out.push(node);
  for (const child of node.namedChildren) collectCommandNodes(child, out);
}

/**
 * `bash|sh|zsh|dash|ksh -c <script>` or `eval <script>...`: re-parses the
 * wrapped script as its OWN program and returns its commands — in
 * ADDITION to the outer command's own argv, never in place of it, so a
 * Rule can never be dodged by this unwrap getting the outer layer wrong.
 */
async function unwrapLauncherCommands(command: Node, depth: number): Promise<string[][]> {
  const name = command.childForFieldName("name");
  if (!name) return [];
  const args = command.childrenForFieldName("argument");
  const head = wordText(name);
  const headBase = head.includes("/") ? (head.split("/").pop() ?? head) : head;

  const isEval = headBase === "eval";
  const dashCIndex = SHELL_LAUNCHERS.has(headBase)
    ? args.findIndex((arg) => SHELL_DASH_C_FLAG.test(wordText(arg)))
    : -1;

  if (!isEval && dashCIndex === -1) return [];

  // There IS a launcher here needing a re-parse — only NOW does the depth
  // cap apply (checking it before this point would also fire for every
  // ordinary command once deep enough, which has nothing to unwrap at all).
  if (depth >= MAX_REPARSE_DEPTH) {
    throw new UnresolvedReparseError("max reparse depth reached with a launcher still to unwrap");
  }

  if (isEval) {
    const script = args.map(wordText).join(" ").trim();
    return script ? parseScript(script, depth + 1) : [];
  }

  const scriptArg = args[dashCIndex + 1];
  if (!scriptArg) return [];
  return parseScript(wordText(scriptArg), depth + 1);
}

async function commandsFromTree(root: Node, depth: number): Promise<string[][]> {
  const nodes: Node[] = [];
  collectCommandNodes(root, nodes);

  const argvLists: string[][] = [];
  for (const node of nodes) {
    argvLists.push(commandArgv(node));
    argvLists.push(...(await unwrapLauncherCommands(node, depth)));
  }
  return argvLists;
}

/**
 * Parses a re-parsed `-c`/`eval` script as its own bash program. A failed
 * parse HERE throws `UnresolvedReparseError` rather than degrading to
 * "contributed nothing" — caught only by the top-level catch.
 */
async function parseScript(script: string, depth: number): Promise<string[][]> {
  const language = await loadBashLanguage();
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(script);
    if (!tree || tree.rootNode.hasError) {
      throw new UnresolvedReparseError("a re-parsed -c/eval script failed to parse");
    }
    return await commandsFromTree(tree.rootNode, depth);
  } finally {
    parser.delete();
  }
}

export interface ParsedCommands {
  /** Every executed command's flat argv — the line's own commands plus whatever a `-c`/`eval` string re-parsed into. */
  commands: string[][];
}

/**
 * Parses `line` with tree-sitter-bash and returns every command it
 * actually EXECUTES, as its flat argv. `undefined` means the parse itself
 * failed, the grammar flagged an error (`hasError`) — zsh-only syntax, an
 * unterminated quote, a grammar gap — OR a NESTED `-c`/`eval` string
 * failed the same way, or outran the reparse depth cap
 * (`UnresolvedReparseError`, caught here and nowhere else). Either way the
 * caller MUST fall back to the raw-substring match on the ORIGINAL line
 * rather than treat this as "no match": a command this function couldn't
 * resolve is NOT the same fact as a command that resolved and matched
 * nothing, and the guard must never go empty on either kind of failure.
 */
export async function parseExecutedCommands(line: string): Promise<ParsedCommands | undefined> {
  let parser: Parser | undefined;
  try {
    const language = await loadBashLanguage();
    parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(line);
    if (!tree || tree.rootNode.hasError) return undefined;
    return { commands: await commandsFromTree(tree.rootNode, 0) };
  } catch {
    // Catches the grammar failing to load, the parser throwing, and an
    // `UnresolvedReparseError` bubbling up from a nested reparse — all
    // three degrade to "could not parse" here.
    return undefined;
  } finally {
    parser?.delete();
  }
}

export function matchesContiguousRun(needle: readonly string[], haystack: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

/** Split on whitespace, dropping empty tokens — shared by a Rule's own `match` text and by finding its first word. */
export function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}
