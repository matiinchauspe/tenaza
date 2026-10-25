# Optional reader daemon

Partly supersedes ADR 0002: "no daemon" becomes "no required daemon". The human may run `tenaza ui`
under launchd (`brew services`, opt-in) as a long-lived reader of the Session logs that serves the
Live surface, notices silences no hook can see, and runs an Inbox item's command only on the
human's click; hooks never ask it — they read its heartbeat file — so its absence degrades to
v0.1 and never opens a fail-mode choice. Trades a second always-on process for liveness, while
keeping ADR 0002's single-writer logs and hooks that depend on nothing running.
