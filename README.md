<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/tenaza-dark.svg">
    <img src="assets/tenaza-light.svg" alt="Tenaza" width="200">
  </picture>
</p>

<h1 align="center">Tenaza</h1>

<p align="center">
  <strong>Hold your coding agents with tongs.</strong><br>
  See every session, keep the dangerous moves for yourself, and know when a context is running hot.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.0-2dd4bf" alt="version 0.2.0">
  <img src="https://img.shields.io/badge/license-MIT-34d399" alt="license MIT">
  <img src="https://img.shields.io/badge/platform-macOS-8b93a0" alt="platform macOS">
</p>

---

A *tenaza* is the blacksmith's tongs: the tool that holds hot metal so your hands don't have
to. Tenaza does that for coding agents. It hooks into Claude Code and:

- **Watches** every session and subagent, grouped by project, with a live context bar.
- **Holds back** the actions you reserve for yourself, like `gh pr merge` or a production write.
  The agent is told to stop and tell you, and the action waits in your **Inbox**.
- **Taps you on the shoulder** with a macOS notification when something waits for you, or when
  a session crosses its context threshold.
- **Answers you live**, if you turn on the optional Daemon: approve or reject from a board in
  your browser, and the agent reads your answer inside the same tool call — no terminal hunt.

It never launches work and never runs a command on its own. Your agents do the work, and Tenaza
keeps the parts you reserved for your own hands.

<p align="center">
  <img src="assets/board.png" alt="Tenaza's Live surface board: TE NECESITA, CORRIENDO, TRABADA and TERMINÓ columns, a session's context track and the activity panel" width="760">
</p>

## Qué hay de nuevo en 0.2

v0.1 was "muy on demand" and couldn't be trusted yet. 0.2 is a rebuild, not a patch:

- **Trust.** Rules now match the command a line actually *executes* (tree-sitter-bash), not its
  text — a heredoc, a commit message or an `rg` that only mentions `gh pr merge` is never denied
  again. MCP tool calls become Actions a generic Rule can match (`tool` + `unless`/`when`), with
  no per-provider code. A broken Tenaza never adds a new block and shouts through four channels
  instead of failing silently. Inbox ids are short, git-style hashes — one can never point at
  another agent's command.
- **The optional Daemon.** `brew services start tenaza` (or `tenaza ui` by hand) serves a local
  web board, opened from any session with `/tenaza` or a clicked notification. Hooks never depend
  on it; `brew install` starts nothing.
- **The board.** Live answering — approve or reject a reserved action from the card that's
  waiting, no terminal hunt. TE NECESITA lists pending requests, each with a resolution trace and
  a toast once it closes. The `l` key opens an activity panel of the latest events. `t` jumps to
  the agent's own terminal; `x` archives a finished session.
  - **Realtime.** Typed prompts, native permission/idle prompts and ordinary activity all reach
    the board now, live — a busy agent never reads frozen, a waiting one never reads idle, and
    subagent token counts move as the agent runs, not just at the end.
- **The statusline.** A green dot while the Daemon's heartbeat is fresh, alongside the usual
  counts and the red `degradado` mark.

## Install

Requires macOS and [Claude Code](https://code.claude.com).

```bash
brew install matiinchauspe/tap/tenaza
tenaza init
```

Then, inside Claude Code, add the plugin that wires up the hooks:

```
/plugin marketplace add matiinchauspe/tenaza
/plugin install tenaza@tenaza
```

That's it. Every session from now on, main or subagent, is observed.

`tenaza init` does two things, and running it again changes nothing:

1. Writes a starter Policy to `~/.tenaza/config/policy.toml`, but never over an existing one.
2. Points Claude Code's statusline at Tenaza, but only if you don't have one yet. If you do,
   your settings are left untouched and it prints a line for you to add to your own script.

Nothing above starts the **Daemon** — that's opt-in, and a separate step. See
[The Daemon: live, in your browser](#the-daemon-live-in-your-browser) below.

## A day with Tenaza

An agent tries to merge a PR:

```
gh pr merge 58 --merge
```

Claude Code's hook asks Tenaza first. The Policy reserves `gh pr merge` for you, so the call is
denied, and the agent reads:

> Reserved for the human, inbox dce9. Do not retry or work around it. Tell the user, and continue.

A notification appears (🟡 *Tenaza · te espera · inbox dce9*), and the item waits. The id is a
short, git-style hash — any unique prefix of at least 4 hex characters works too:

```bash
tenaza status         # the session tree and the Inbox
tenaza run dce9        # run the stored command yourself, now; closes the item on success
tenaza done dce9       # or: you ran it by hand
tenaza dismiss dce9    # or: it no longer applies
```

`tenaza status` groups sessions by project, a tree per project with a context bar and an age next
to each one, then the Inbox below:

```
reservee
  ⏸ RES-131  sess-1  ████░░░░░░┊░░░░░ 76k  te espera  0s
  ○ RES-132  sess-2  ████░░░░░░┊░░░░░ 76k  cerró  0s

rudy
  ● RUDY-12  sess-3  ██████████┊██░░░ ⚑242k  vivo  0s

Inbox:
  c9bd  Bash: gh pr merge 58 --merge
```

## The Daemon: live, in your browser

Everything above works with no Daemon at all — `tenaza status` and the terminal notification are
always there. The Daemon is an **optional** extra: a local web board that shows every session
updating on its own, and lets you answer a reserved action from your browser instead of a
terminal.

`brew install` starts nothing. Turn the Daemon on, either way:

```bash
brew services start tenaza   # a background service, restarted on login and after a crash
# or, in the foreground, Ctrl-C to stop it:
tenaza ui
```

Either way, open the board from any Claude Code session with `/tenaza` (the plugin command) —
it opens your browser if the Daemon is up, or tells you how to start it if it isn't. Clicking a
🟡 notification opens it too.

**Live answering.** When the Daemon is up and an agent hits a reserved action (`gh pr merge`,
`git worktree remove`), its session's own card grows a **TE ESPERA** block with the command, a
draining wait bar (3 minutes by default), a message box and *rechazar* / *aprobar*. Press `a` to
approve — the agent's call proceeds in the same tool call, no `!` line, no terminal hunt — or `r`
and type a reason to reject; the agent reads it as the deny message. If you're away and the
window lapses, the card turns into an ordinary pending Inbox item: `tenaza run <id>` still works
from the terminal exactly as it always has. Resolving a request — approved, rejected, run,
marked done or dismissed — leaves a short-lived toast and a resolution trace on the session's own
card, and shows up in the `l` activity panel alongside every other board event.

<p align="center">
  <img src="assets/board-live.png" alt="A session's card in TE ESPERA, holding a live gh pr merge call with its draining wait bar and the rechazar/aprobar buttons" width="420">
</p>

Press `l` any time to open the activity panel — the latest events, newest first, with a toast
confirming whatever you just resolved:

<p align="center">
  <img src="assets/board-activity.png" alt="The l activity panel open at the bottom right, listing recent resolutions and session transitions, with a confirmation toast after approving a live request" width="420">
</p>

**If the Daemon is down, or you never turn it on, nothing changes**: a reserved action denies at
once and lands in your Inbox, same as v0.1. The Daemon only adds the live path; it is never a
dependency hooks need. If it crashes, you only lose the live view and the TRABADA / stalled-session
detection no hook can do on its own — every guardrail keeps working exactly as before.

**Go to the terminal.** Every card has an "ir a terminal ↗" button (key `t`) that brings the
terminal running that session to the front. How far it can reach depends on the terminal itself:

| Level | Terminals | Notes |
| --- | --- | --- |
| Exact tab/pane, no prompt | Orca, tmux | Resolved live, never from a stale captured value. |
| App only, no prompt | Warp, Alacritty, VS Code, Cursor, and anything else unrecognized | Raises the app; you still have to find the tab. |
| Exact tab/pane, behind a macOS prompt | Terminal.app, iTerm2, Ghostty | macOS asks for Automation permission the first time you click. |
| Unverified (shipped as code, not yet confirmed live) | WezTerm, kitty, Zellij | kitty needs `KITTY_LISTEN_ON` set to be captured at all. |

A subagent's card always focuses its *parent* session's terminal.

**Known matching misses.** Rules match a command's real, executed argv (parsed with
tree-sitter-bash) — not its text — so a heredoc, a commit message or an `rg` that only *mentions*
`gh pr merge` is never caught, and `timeout 60 gh pr merge 58` or `sudo gh pr merge 58` still are.
A few shapes are never caught, on purpose (no per-launcher table, no variable tracking, no
re-running a written file — see the comments in `policy.example.toml`):

- `ssh host "gh pr merge 58"` — the remote command is one quoted string, data to the local shell.
- `C=gh; $C pr merge 58` — variable indirection.
- A script written to a file, then run (e.g. `./deploy.sh`).
- `git -C some/dir worktree remove x` — an interleaved global flag breaks the contiguous run.

And one rare false positive: an unquoted `echo gh pr merge` is itself a real command whose argv
literally contains the words in order — there is nothing left to tell that apart from a
deliberate one.

**If Tenaza breaks**, a broken Daemon or a broken hook never blocks anything *new*: on any fault,
the call goes ahead exactly as if Tenaza weren't installed, and you're told loudly — a message in
the session, a statusline `degradado` mark, and (for a grave fault like a missing binary) a macOS
notification.

## Commands

| Command | What it does |
| --- | --- |
| `tenaza init` | Prepare this machine: a starter Policy and the statusline. |
| `tenaza status` | Sessions as a tree per project, with context bars, then the Inbox. |
| `tenaza statusline` | One terse line for Claude Code's statusline. |
| `tenaza ui [--port <n>]` | Start the Daemon in the foreground. Ctrl-C stops it. |
| `tenaza open` | Open the Daemon's board if it's up; print how to start it if it isn't. What the plugin's `/tenaza` runs. |
| `tenaza run <id>` | Run an Inbox item's command at your request. Closes on exit 0. |
| `tenaza done <id>` | Close an item you ran yourself. |
| `tenaza dismiss <id>` | Close an item that no longer applies. |
| `tenaza label key=value …` | Let an agent label its own session (e.g. `ticket=RES-131 project=reservee`). |
| `tenaza --version` | Print the installed version. |
| `tenaza hook claude` | The entry point Claude Code's hooks call. You never run it by hand. |

Tenaza only ever executes a stored command through `tenaza run`, and closing an item twice is
harmless.

## The Policy

`~/.tenaza/config/policy.toml` is a list of Rules. Each matches text in a shell command, and the
first match wins:

```toml
[[rule]]
match = "gh pr merge"
effect = "human"   # deny it, and put it in your Inbox

[[rule]]
match = "git push --force"
effect = "flag"    # let it run, but record it

[flag]
threshold_tokens = 200000   # when a session's context is flagged
```

The starter Policy ships with exactly two active Rules: `gh pr merge` and `git worktree remove` —
"se frena lo que se frena hoy, nada más." A few more (Neon, Vercel, Railway) ship **commented
out** in `policy.example.toml` as best-guess examples; uncomment and adjust the ones you actually
use.

An MCP tool call gets its own Rule shape — `tool` is a glob on the tool name, with optional
`unless`/`when` conditions on its arguments:

```toml
[[rule]]
tool = "mcp__*neon*__run_sql*"
unless = { branch_id = ["br-dev-example", "br-staging-example"] }
effect = "human"
```

An absent argument is never treated as safe — a Neon `run_sql` call with no `branch_id` hits the
default branch, which is usually production. SQL or any other argument *content* is never
inspected, only equality/membership on the arguments named above.

A Policy is a guardrail against honest mistakes, not a security boundary. An agent that words a
command differently walks right past a Rule.

## Reading the screen

| | |
| --- | --- |
| `⏸` *te espera* | Something in this session waits for you in the Inbox. |
| `●` *vivo* | Working. It reads *sin señal* if it has gone quiet for 15 minutes. |
| `✓` *terminó* / `○` *cerró* | A subagent finished, or a session closed. |
| `████░░┊░░` | Context used, 20k tokens per cell. `┊` marks your threshold, and cells past it turn red. |
| `⚑242k` | The session crossed the threshold. Tenaza only shows it, never stops it. |

A parent session shows the most urgent state among its subagents, so a waiting subagent is never
hidden. The statusline folds all of this into one line, with a trailing green dot while the
Daemon's heartbeat is fresh:

```
tenaza │ ● 2 vivas · ⚑ 1 >200k · ✉ 1 → dce9 gh pr merge · ● daemon
```

## Labels

An agent can name the work it is doing by running `tenaza label ticket=RES-131 project=reservee`.
The hook catches the command and labels the session the call really came from, even inside a
subagent. The `ticket` label replaces the role on the session's row, and `project` decides the
group. Without a `project` label, sessions group by their git repository.

[Yunque](https://github.com/matiinchauspe/yunque), the agent harness Tenaza was built alongside,
announces these labels for you.

## Notifications

- 🟡 when an action lands in your Inbox.
- 🔴 the first time a session crosses the context threshold.

Nothing else notifies: no edits, no sessions ending, no resolutions. Several matches within two
seconds play a single sound. Notifications are sent with `osascript`, so there is nothing extra
to install, but macOS may ask for permission the first time. A failed notification never changes
whether an action is allowed.

## How it works

```
Claude Code hook ──► tenaza hook claude ──► ~/.tenaza/state/sessions/<session>.jsonl
                                                        │
                       tenaza status / statusline ◄─────┤   (state is derived on read)
                                                        │
                                  tenaza ui (optional) ◄┘   (the SAME logs, watched and pushed live)
```

Hooks never talk to the Daemon, and never wait on it — each one is still a short command that
appends Events to one log per session, and `tenaza status`/`statusline` still derive every view
from those logs on demand, exactly as in v0.1. The Daemon, when you turn it on, only *reads* that
same state: it watches `~/.tenaza/state/` and pushes it live to the board, notices the silences no
short-lived hook ever could (a stalled session), and runs a pending item's command only when you
click it. If it dies, you lose the live view and that silence detection — nothing a hook depends
on. An adapter translates each agent runtime's hooks into Tenaza's Events and declares what it can
do (`observe`, `block`, `measure`). The core degrades by that declaration, never by the runtime's
name. The decisions behind this shape live in [`docs/adr/`](docs/adr/).

| Setting | Default | Purpose |
| --- | --- | --- |
| `TENAZA_HOME` | `~/.tenaza` | Policy and session state. |
| `TENAZA_CLAUDE_SETTINGS` | `~/.claude/settings.json` | The settings file `tenaza init` edits. |

## Limits in v0.2

- **Claude Code only.** The core is runtime-free; other adapters can come later.
- **MCP Rules match the call, never its content.** An `mcp` Rule matches a tool name and
  conditions on its arguments (`unless` / `when`); the SQL text or other argument content
  itself is never inspected.
- **A few shell shapes are never matched**, on purpose — see Known matching misses above.
- **macOS notifications cannot be replaced.** Each one is a new banner, unless
  `terminal-notifier` is on your PATH, in which case clicking one opens the board.
- **The Daemon is not a security boundary.** Its write token and Policy guard against honest
  mistakes; an agent runs as the same user and could in principle work around either.
- **Release binaries are unsigned.** Installing through Homebrew avoids the Gatekeeper prompt.

## Uninstall

```bash
brew services stop tenaza   # only if you ever started it
brew uninstall tenaza
rm -rf ~/.tenaza
```

Then, inside Claude Code: `/plugin uninstall tenaza@tenaza`. Claude Code keeps working as before,
statusline included: the line `tenaza init` wrote prints nothing once `tenaza` is gone.

## Develop

```bash
bun install
bun test             # black-box tests against a temporary TENAZA_HOME; never a real notification
bun run typecheck
bun run build        # a single binary at dist/tenaza
```

Releases are built by CI on every `v*` tag, for macOS arm64 and x64.

## License

[MIT](LICENSE)
