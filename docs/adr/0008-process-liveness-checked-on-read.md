# Process liveness is checked on read, never stored or hook-triggered

A Session whose runtime process has exited, with no `SessionEnd` ever fired (a closed terminal, a
killed process, a crash), used to stay "alive" forever — "alive" meant only "no `session.ended`
Event in the log." `session.started` now also captures the runtime's own OS process id and its
`ps`-reported start marker (paired to defeat pid reuse after a reboot); `tenaza status`, `statusline`
and the board each check that pid against the live process table on read (`sessions.ts`'s
`closeDeadProcesses`) and, when it's confirmed gone, derive the SAME `endedAt`/a distinct
`endedReason` a real `SessionEnd` would carry — never written back to the log (ADR 0002: Events stay
the only state) and never run from a hook's own answer path (ADR 0007: the check never blocks,
delays or alters the runtime). Chosen over writing a synthetic `session.ended` Event at the moment
of discovery, which would make Tenaza's own read path a second writer to a single-writer log, and
over polling from a Daemon-only background job, which would leave `status`/`statusline` wrong
whenever the Daemon isn't running (decision 05: nothing here depends on it). Trades one extra `ps`
spawn per read (batched across every still-open Session's distinct pid in one call, never one per
Session) for never needing a second write path or a background watcher just to answer "is this
Session actually still running."
