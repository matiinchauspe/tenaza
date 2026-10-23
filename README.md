# Tenaza

A decoupled control plane for coding agents: observes agent Sessions, enforces a Policy on
human-reserved Actions, and shows state. It never launches work. See `GLOSSARY.md` for its
ubiquitous language and `docs/adr/` for the decisions behind its shape.

## Develop

```bash
bun install
bun test        # black-box, against a temporary TENAZA_HOME
bun run typecheck
bun run build    # bun build --compile -> dist/tenaza
```

## Use

```bash
tenaza init           # prepare this machine: write a starter Policy, wire up the statusline
echo '<hook payload>' | tenaza hook claude   # PreToolUse, SessionStart, SubagentStart, SubagentStop, SessionEnd, Stop, PostToolUse
echo '<hook payload>' | tenaza hook fake     # the test Adapter: start, action, end — never a real runtime
tenaza status
tenaza statusline     # one line for Claude Code's statusLine; reads and ignores any JSON on stdin
tenaza run <id>       # execute the stored command at your request; closes on exit 0
                      # refuses on an item that already ran once, unblocked (see below)
tenaza done <id>      # close an item you ran yourself, by hand
tenaza dismiss <id>   # close an item that no longer applies
tenaza label key=value [key=value …]   # announce Labels on the caller's own Session
```

Tenaza never executes a stored command except through `tenaza run`. Resolving an
already-closed item is a no-op — safe to repeat.

`tenaza init` prepares a machine, idempotently — running it twice changes nothing the second
time. It writes `config/policy.toml` from the shipped `policy.example.toml` the FIRST time it
finds none there, and never again: an existing `policy.toml` is always left alone, so edit it
freely once it exists. The shipped example is a starting point, not a finished Policy — review
and adjust its Rules (some of them are a stated best guess, e.g. the exact Railway/Neon
production-write command strings) before trusting it. It also wires up Claude Code's own
`statusLine` setting, because a plugin can set only `agent`/`subagentStatusLine`, never the main
one: with no `statusLine` in the user's Claude Code settings, it sets it to run
`tenaza statusline`; with one already there, it leaves that settings file byte-for-byte untouched
and prints one line to paste into your own script instead:
`command -v tenaza >/dev/null && tenaza statusline`. A settings file it cannot even parse as JSON
is left untouched the same way, rather than risk a destructive rewrite.

`tenaza status` shows every observed Session as a tree, grouped by project (derived from a
`project` Label, else the git root of the Session's cwd, else the cwd itself). A Claude Code
subagent is its own Session, nested under its parent; a parent's glyph rolls up its most urgent
descendant (waits for the human > alive > done > ended). Each row carries a context bar — 15
cells over 300k (20k per cell), a `┊` mark at the Policy's threshold (default 200k), cells past
it in red, and the number as `243k`, or `⚑243k` once Flagged. The Claude Adapter samples it by
parsing the Session's own transcript at `Stop`, `SubagentStop` and `SessionEnd`, and every 25
tool calls on `PostToolUse` — v1 never stops a Session for its size, only shows it. Each row
shows its `ticket` Label when one was announced, else its structural role ("sesión" /
"subagente"). A Session whose Adapter never declared the `measure` Capability shows `sin datos`
there instead — no bar, no `⚑` — the core degrading by Capability, never by runtime name (ADR
0001; the `fake` Adapter behind `tenaza hook fake` is what exercises this, and the `human`-Rule
case below, in tests). The Inbox follows below the tree.

`tenaza statusline` folds the same derived state into one terse line:
`tenaza │ ● 4 vivas · ⚑ 1 >200k · ✉ 2 → #14 gh pr merge` (calm:
`tenaza │ ● 2 vivas · ⚑ 0 · ✉ 0`). `vivas` counts every Session not yet done
or ended; `⚑` counts Sessions at or past the Policy's threshold (the number
tracks a custom one, never a hardcoded 200k); `✉` is the open Inbox's own
length, blocked or not — an unblocked item (see below) still counts and can
still be the one named, since it is still open and still real. The named item
is the MOST RECENTLY opened one. Claude Code pipes its own statusline JSON on
stdin; Tenaza drains and ignores it outright, deriving its line only from its
own state.

The Inbox holds every Action that matched a `human` Rule. The common case is a deny an Adapter
with the `block` Capability enforced — `#id  Tool: command`, awaiting `tenaza run <id>`. An
Adapter WITHOUT `block` cannot actually stop the call, so Tenaza never claims it denied one: the
Action is still recorded and still shown, marked `(ya corrió — no se pudo bloquear)`. On such an
item `tenaza run` REFUSES outright — no spawn, no Event, exit code 1, an es-AR message explaining
it already ran and naming `tenaza done <id>` / `tenaza dismiss <id>` — since running it again
would execute the command a SECOND time (a merge, a prod write, …). `done` and `dismiss` close it
exactly as they would any other item.

An agent doesn't know its own Session id, so it announces Labels by running `tenaza label
ticket=RES-131 project=reservee`; the Claude Code Adapter's `PreToolUse` hook intercepts that
exact command and writes `session.labeled` into the RIGHT Session's log — the one the hook
itself fired in (`agent_id` when the call came from inside a subagent, `session_id` otherwise),
never the one the agent happened to spell in the command (ADR 0003). The command's own process
exit code is always 0 regardless of its args; it never does the labeling itself and never fails.
Labels are opaque strings, stored and shown as given — only `project` is ever interpreted (for
grouping). A later announce adds or overrides keys; earlier ones remain.

State lives under `TENAZA_HOME` (default `~/.tenaza/`): `config/policy.toml` for the Policy
(an optional `[flag]` `threshold_tokens` overrides the default 200k), `state/sessions/<session>.jsonl`
for each Session's Events, `state/sessions/<session>.toolcalls` for its running PostToolUse count
(not an Event — never read as one), `state/human.jsonl` for Resolutions. `tenaza init` reads and
edits Claude Code's OWN settings file (default `~/.claude/settings.json`, overridable with
`TENAZA_CLAUDE_SETTINGS` — a different root than `TENAZA_HOME` entirely) to wire up the
statusline.

A hook fires a macOS notification the moment it opens an Inbox item (🟡, blocked or not — ADR
0001) or a Session crosses the Flag threshold for the first time (🔴, once per Session — never on
an edit, a Session ending on its own, or a Resolution). It's sent with `osascript -e 'display
notification …'` — nothing to install beyond macOS itself, but with a real limitation worth
knowing: `display notification` has no identifier/group parameter, so Tenaza cannot ask
Notification Center to REPLACE an earlier banner (a tool like `terminal-notifier` could, at the
cost of a second Homebrew dependency — not taken in v1). A burst of matches within ~2s still
notifies for each one, but only the first plays a sound. Setting `TENAZA_NOTIFY_RECORDER=1`
swaps the real sender for a recorder at `state/notify-recorder.jsonl` instead — the test seam
`bun test` always runs under (see `bunfig.toml`), so no test ever pops a real notification. A
failing notifier (no `osascript`, a denied permission, …) never fails the hook or changes its
allow/deny answer.
