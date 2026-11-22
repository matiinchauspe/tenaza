# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each tagged
release's own section here is what `.github/workflows/release.yml` publishes as that release's
notes (`scripts/extract-changelog.sh`), with GitHub's own generated PR list appended below it.

## [0.5.2] - 2026-11-22

### Fixed

- The musl builds `tenaza-linux-arm64-musl` and `tenaza-linux-x64-musl` are published. 0.5.1
  shipped without them: their smoke test ran on an Alpine image missing the `libstdc++` and
  `libgcc` they link. An Alpine sandbox needs both (`apk add libstdc++ libgcc`).

## [0.5.1] - 2026-11-22

### Added

- **musl builds for an Alpine sandbox**: each release also ships `tenaza-linux-arm64-musl` and
  `tenaza-linux-x64-musl`, listed in `checksums.txt`. The glibc builds do not start on Alpine, even
  with `gcompat`. Each one is smoke-tested in `alpine:3.20` before it is published.

## [0.5.0] - 2026-11-21

### Added

- **Linux binaries for the hook**: each release also ships `tenaza-linux-arm64` and
  `tenaza-linux-x64`, for running `tenaza hook claude` inside a Linux sandbox that mounts the
  host's `~/.tenaza`. Only the hook runs there; the Daemon, the board and notifications stay on
  the macOS host.
- **The Daemon relays what a sandbox hook could not send**: a hook with no macOS notifier leaves
  the Inbox item for the running Daemon, which notifies it at most once, never twice. An item
  written while the Daemon was down is notified when it starts. The relay covers Inbox items only.

### Fixed

- A session whose hook runs in a sandbox no longer reads TERMINÓ on the host board while it is
  still working.
- A grave fault a hook could not deliver keeps ringing on the next call that can, instead of
  counting as notified.
- A notification that cannot be delivered no longer silences the sound of the next one.
- A banner the Daemon sends opens the port it is bound to (`tenaza ui --port <n>`), not the
  default.

## [0.4.0] - 2026-11-18

### Added

- **Labels any caller can find**: every session and subagent is told, in its own context, how to
  label itself with `tenaza label <key>=<value> …`. A harness finds the command there without
  naming Tenaza. A command that mentions `tenaza label` but is not a pure label call gets a notice
  that its label was not recorded.
- **Checkpoint nudge**: a session labelled with both `ticket` and `base` (a dispatched run) is told
  to write its checkpoint and end the run once its latest context sample crosses
  `[flag] threshold_tokens`. It is context only, never a block, and other sessions never get it.
- **Run outcomes on the board**: a TERMINÓ card shows TE ESPERA for a session labelled
  `verdict=parked` and CONTINÚA for `verdict=checkpoint`.
- A `verdict=parked` label sends one notification ("#<ticket> espera tu respuesta"), never a
  second for the same session.

### Changed

- Only a pure `tenaza label` command skips the Policy: the bare binary, no shell syntax, and
  single-word values. A command chained after a label is now checked like any other.

### Fixed

- `tenaza status` reads `[live] stall_minutes` from the Policy, like the board, instead of a fixed
  15 minutes.
- `tenaza status`, the statusline, the board and archive now agree on a session's state. A session
  busy with ordinary tool calls no longer reads "sin señal" in the CLI while the board shows it
  running, and a prompt you already answered no longer keeps reading "esperándote" there.

## [0.3.1] - 2026-10-29

### Fixed

- A session waiting for you no longer lands in TRABADA on the board. When its turn has ended, or
  Claude Code is showing its own permission or idle prompt, it stays in CORRIENDO with its
  ESPERÁNDOTE badge, however long you take. TRABADA now means only a session that was working and
  went silent. The activity feed no longer reports "se trabó" for a waiting session either.
  `tenaza status` already read these sessions this way.

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
  no longer leaves a session counted as "vivas" forever.
- A session recorded before 0.3.0 has no pid, so it reads as ended after 24 hours with no events
  (ADR 0010). It shows in TERMINÓ until 48 hours of silence, then leaves the board. A new event
  brings it back.
- A TERMINÓ card offers archivar instead of the terminal button, and `t` ignores it.
- When Tenaza does not know a session's terminal, its card shows no terminal button at all
  (before: a greyed "terminal desconocida"), and `t` ignores it.
- This repo is its own Homebrew tap: tap it by URL
  (`brew tap matiinchauspe/tenaza https://github.com/matiinchauspe/tenaza`) and install by full name
  (`brew install matiinchauspe/tenaza/tenaza`). The separate `homebrew-tap` repo is gone. The README has an upgrade guide.

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
