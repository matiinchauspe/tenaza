# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each tagged
release's own section here is what `.github/workflows/release.yml` publishes as that release's
notes (`scripts/extract-changelog.sh`), with GitHub's own generated PR list appended below it.

## [0.3.0] - 2026-10-28

### Added

- **Working vs waiting for you**: a session reads ESPERÁNDOTE the moment its turn ends, with no
  ~60s wait for Claude Code's own idle prompt, and reads working again on your next message or
  its next tool call. The `Stop` hook now records a `turn.ended` event (ADR 0009).
- Background work stays visible while a session waits: "esperándote · N en segundo plano" on the
  board and in `tenaza status` while its subagents are still running. A `run_in_background`
  shell command fires no hook, so it is not counted.
- README "Notifications" section: why a Tenaza notification may never show (a Focus / Do Not
  Disturb mode suppresses it) and how to check.

### Changed

- A session whose process died now reads as ended. `session.started` records the runtime's pid
  and its start time, and every read checks it (ADR 0008). A closed window, a `kill` or a crash
  no longer leaves a session counted as "vivas" forever. Sessions recorded before 0.3.0 carry no
  pid and keep reading alive until archived.
- A TERMINÓ card offers archivar instead of the terminal button, and `t` ignores it.
- This repo is its own Homebrew tap: tap it by URL (`brew tap matiinchauspe/tenaza https://github.com/matiinchauspe/tenaza`) and\n  install by full name (`brew install matiinchauspe/tenaza/tenaza`). The
  separate `homebrew-tap` repo is gone. The README has an upgrade guide.

### Fixed

- `tenaza init`'s statusline snippet works inside an existing statusline script: it re-feeds the
  script's own input and prints Tenaza on a second line instead of being cut off.

## [0.2.0] - 2026-10-27

### Added

- The optional **Daemon** (`tenaza ui`, or `brew services start tenaza` as a user LaunchAgent) —
  a local web board, served over SSE, with every write route token-gated and a heartbeat file
  hooks can read. `brew install` starts nothing; the Daemon is opt-in end to end.
- **The board**: four columns (TE NECESITA, CORRIENDO, TRABADA, TERMINÓ); **live answering** —
  approve or reject a reserved action from the session's own card, with an optional message, no
  terminal hunt; a **resolution trace** on the card that raised a request; a short toast once a
  request is resolved; the `l` **activity panel** listing the latest board events; `t` to jump to
  the agent's own terminal; `x` to archive a finished session.
- `/tenaza`, the plugin's own Claude Code command — opens the board when the Daemon is up, prints
  how to start it when it isn't.
- The statusline's green live dot while the Daemon's heartbeat is fresh.
- `mcp` Actions: an MCP tool call is normalized and matched by a generic Rule (`tool` glob, plus
  optional `unless`/`when` conditions on its arguments) — no per-provider code.
- Short, git-style hash Inbox ids — any unique prefix of 4+ hex characters resolves; an ambiguous
  prefix is refused with every candidate listed.
- `tenaza --version`.
- Four warning channels for a degraded Tenaza: a `systemMessage` on the call itself, a
  SessionStart self-check, a red `degradado` statusline mark, and a macOS notification for grave
  faults (a missing binary, no Policy ever loaded).
- Claude Code's own native permission/idle prompts, and a typed prompt, are observed and shown as
  a non-actionable badge on the session's card — Tenaza only watches; it never answers them.
- Homebrew `service` block: `brew services start/stop tenaza`, a user LaunchAgent, never `sudo`.

### Changed

- Rules now match a command's real, **executed** argv (parsed with tree-sitter-bash), not its raw
  text — a heredoc, a commit message or a search that only *mentions* a reserved command is never
  denied again; `timeout 60 gh pr merge 58` and `sudo gh pr merge 58` still are.
- The starter Policy ships with only `gh pr merge` and `git worktree remove` active. The v0.1
  best-guess production-write Rules are removed; Neon/Vercel/Railway now ship as commented-out
  examples in `policy.example.toml`.
- A `flag` match now returns no decision at all, so it never again skips Claude Code's own
  permission prompt the way v0.1's `allow` effect did.
- A broken Tenaza never adds a new block: on any fault in the hook path, the call goes ahead
  exactly as if Tenaza were not installed, and a deny it already decided always holds.
- Subagent sessions are kept cleanly apart from their parent — their own log, their own tool-call
  count, their own transcript for token sampling — and Claude Code's internal side-agents no
  longer show as phantom "(sin proyecto)" sessions or duplicate cards.
- The board keeps up in real time: a quiet SSE connection no longer drops every ~10 seconds, and
  the per-tick cost of a changed Session no longer grows with a project's full history.

### Fixed

- A torn log line written after a deny no longer lets that call through — the deny still holds.
- A malformed `policy.toml` falls back to the last-known-good Policy instead of silently dropping
  every Rule.
- `tenaza run` executes a stored command in the Session's own directory, never the human's
  current one.
- Parallel denies can no longer collide on a shared id — short hashes replace v0.1's positional
  refs; refs already on disk are translated once, automatically, on upgrade.

## [0.1.0] - 2026-10-23

Initial release: Claude Code hooks, a Policy of Rules, `tenaza status`/`statusline`, the Inbox
(`run`/`done`/`dismiss`), and macOS notifications.
