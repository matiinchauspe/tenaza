# A Turn ending is its own Event; waiting is still derived on read, never stored

Before this: "waiting on the human" came only from `nativeWaitFor` — a Session's last observed
thing being a native `permission_prompt`/`idle_prompt` Notification. Claude Code only fires
`idle_prompt` after ~60s idle, so from the moment a Turn actually ended (`Stop`) until that timer
(or never, if the human reads and talks without typing) the Session kept reading "working," with
no signal distinguishing a plain finished Turn from an ordinary mid-Turn pause.

`Stop` now appends its own `turn.ended` Event, unconditionally, alongside whatever `usage.sampled`
it already writes — a `usage.sampled` alone is ambiguous (`SessionEnd`, `SubagentStop` and the
25th-call `PostToolUse` sample all write one too), so it could never double as "the Turn just
ended" on its own. Whether a Session reads working or waiting stays a READ-TIME derivation, exactly
`nativeWaitFor`'s own convention (ADR 0002: no flag stored, no second Event for the transition back)
— a Session is waiting while `turn.ended` (or a native prompt) is the LATEST thing observed for it,
and reads working again the instant anything later supersedes it (a fresh `prompt.submitted`, an
ordinary tool-call touch) with nothing further ever written for that flip.

The two signals are resolved to never double-badge: a current native prompt (more specific — it
names `permission_prompt` vs. the idle timeout) always wins over the plain Stop-derived wait, which
exists precisely to cover the gap before either native signal ever fires, or when neither ever does.

Trades one more Event per Turn (never per tool call — the same cadence `prompt.submitted` already
logs at, nowhere near the per-call growth ADR 0002 guards the single-writer log against) for a
Session that reads waiting IMMEDIATELY once its Turn ends, rather than up to ~60s late or never.
Also removes ticket 14's own `touchSession` call from `Stop` — `turn.ended` now closes that same
"Stop with no transcript" activity gap more precisely (it also NAMES the moment as a Turn boundary),
and removing the touch removes a race by construction: keeping both risked a touched-file mtime
written after `turn.ended`'s own append bumping `lastEventTs` past it on the very next board read,
silently swallowing the new signal the instant it mattered most.
