import type { Action } from "./contract/event";
import { DEFAULT_DAEMON_PORT } from "./paths";
import type { Rule } from "./policy";

/**
 * The built-in fence (decision 05, ADR 0004 amended by 06; ticket 09): an
 * agent `shell` Action that reads the Daemon's write token, or targets one
 * of its write routes, is denied and lands in the Inbox — the ONE block
 * v0.2 adds beyond `gh pr merge` / `git worktree remove` (spec's own scope
 * rule), because it guards the Live surface itself. ALWAYS ON: never a
 * `policy.toml` entry, never something the human disables — the human
 * never even sees this as a Rule to edit.
 *
 * Still "a guardrail against honest mistakes, not a security boundary"
 * (decision 05's own words — agents run as the same user as the Daemon),
 * but the scope rule everywhere else in this spec applies here too: "se
 * frena lo que se frena hoy, nada más" — a fence that is too WIDE is a
 * genuine regression (it blocks ordinary work this spec promises never to
 * touch), never an acceptable cost. Both halves below are therefore
 * matched as NARROWLY as the thing they actually need to catch, not as a
 * bare keyword:
 *
 * - The token: the FILE PATH's own trailing shape (`state/daemon.token`),
 *   never the bare word `daemon.token` — `rg -n daemon.token src/` (reading
 *   ABOUT the word, developing Tenaza itself) or `bat src/daemon.ts` must
 *   never match.
 * - A write route: the Daemon's OWN origin (`127.0.0.1`/`localhost`/
 *   `[::1]`, on ITS OWN port) immediately followed by one of its write
 *   paths, as ONE contiguous URL shape — never a bare `/items/` substring,
 *   which would catch `ls src/items/` or an unrelated REST API's own
 *   `/items/…` path on a completely different host.
 *
 * Neither half goes through `policy.ts`'s tree-sitter contiguous-argv-word
 * matcher (decision 02) — deliberately: that engine matches whole argv
 * WORDS, exactly right for "gh pr merge" as three separate tokens, but the
 * token's own path and the Daemon's write-route URL are each ONE argv word
 * in their own right (a path, a URL) — a word-boundary match could never
 * fire on a substring buried inside one at all. A plain pattern scan over
 * the raw command text is the only check that actually reaches them;
 * quoting/heredoc exclusions (decision 02's "text that only mentions a
 * command never matches") are not applied either, since there is no
 * tree-sitter parse happening to apply them to — a known, accepted gap
 * (below), not an invitation to widen the match to compensate for it.
 */
const DAEMON_TOKEN_PATH_MARKER = "state/daemon.token";

/**
 * Every write-route ACTION segment under `/items/<id>/<action>` (ticket 09
 * shipped `run`/`done`/`dismiss`; ticket 10 adds `answer` — the live-answer
 * POST a browser sends from a Session's own TE ESPERA card) — ticket 11
 * appends its own action here ONLY if it shares this exact `/items/<id>/…`
 * shape; a route that does NOT nest under `/items/` (ticket 11's `/focus`
 * may not) needs its own pattern added alongside `WRITE_ROUTE_PATTERN`
 * below, never a widening of this one.
 */
export const DAEMON_WRITE_ROUTE_ACTIONS: readonly string[] = ["run", "done", "dismiss", "answer"];

/**
 * Every host spelling that reaches the Daemon's own loopback listener
 * (`Bun.serve({ hostname: "127.0.0.1", ... })`, `daemon.ts`'s `runUi`) — a
 * command naming any OTHER host, even one that also happens to serve an
 * `/items/...` path of its own (a third-party REST API), never matches.
 */
const DAEMON_HOSTS = ["127\\.0\\.0\\.1", "localhost", "\\[::1\\]"];

/**
 * One combined pattern for "a request to the Daemon's own write routes":
 * an optional scheme, one of the Daemon's own hosts, a `:`, its OWN port
 * (`DEFAULT_DAEMON_PORT` — imported, never a second hardcoded `4747`
 * literal independent of `daemon.ts`'s own default), then immediately
 * `/items/<id>/<action>` with no path in between. `[^\s"'`]+` for the id
 * is deliberately unconstrained beyond "not whitespace or a quote" — the
 * fence does not need to know the identity hash's own shape (`identity.ts`
 * owns that), only that SOMETHING sits between the two literal path
 * segments.
 *
 * Known, accepted miss (same spirit as decision 02's own documented ones):
 * a Daemon started with a NON-DEFAULT `--port` escapes this half of the
 * fence entirely — there is no file a hook could read to learn the port a
 * currently-running `tenaza ui --port <n>` was launched with (unlike the
 * token, which `daemon.token` always names regardless of port), and
 * hardcoding every port a human might ever pick is not a narrowing this
 * fence can make. The token half of the fence is unaffected either way —
 * it never depends on the port at all.
 */
function buildWriteRoutePattern(port: number): RegExp {
  const host = `(?:${DAEMON_HOSTS.join("|")})`;
  const action = `(?:${DAEMON_WRITE_ROUTE_ACTIONS.join("|")})`;
  return new RegExp(`(?:https?:\\/\\/)?${host}:${port}\\/items\\/[^\\s"'\`]+\\/${action}\\b`);
}

const WRITE_ROUTE_PATTERN = buildWriteRoutePattern(DEFAULT_DAEMON_PORT);

/** The synthetic Rule a fence match logs onto `action.decided` — `match` names it as built-in so a skim of the Event log never mistakes it for a `policy.toml` entry. */
export const BUILT_IN_FENCE_RULE: Rule = { match: "<built-in: daemon token/write-route fence>", effect: "human" };

/**
 * Does this Action trip the fence? Only a `shell` Action can read a file or
 * shape a `curl`-style request at all — an `mcp` Action's own arguments are
 * never inspected here (decision 07 already rules out inspecting MCP
 * argument content beyond `unless`/`when` equality, and this fence has
 * nothing to do with MCP in the first place).
 */
export function matchesBuiltInFence(action: Action): boolean {
  if (action.kind !== "shell") return false;
  const { command } = action;
  if (command.includes(DAEMON_TOKEN_PATH_MARKER)) return true;
  return WRITE_ROUTE_PATTERN.test(command);
}
