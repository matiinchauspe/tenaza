# A Session with no pid ends after 24h of silence, as a transition-only fallback

Every Session started before `session.started` began capturing `pid` (ADR 0008 — every Session
from the 0.2.0 binary) carries no `pid` at all, which means `isProcessGone`/`closeDeadProcesses`
can never confirm one of these gone: there is nothing to check against the live process table.
Found 2026-10-28: the statusline read "7 vivas" while only 2 `claude` processes existed — the
other 5 Sessions had no `pid` to check, so the pid rule could never end them, and `archiveSession`
refused to remove them from the board since nothing could ever set their `endedAt` either.

A second, time-based rule now closes exactly this gap: a Session with no `pid` whose `lastEventTs`
is more than `TERMINO_WINDOW_MS` old (the SAME 24h the board's own TERMINÓ column already uses —
never a second magic number) reads as ended too, under its own distinct reason
(`NO_PID_SILENT_REASON`, never confusable with `PROCESS_GONE_REASON`). Derived on read, exactly
like ADR 0008's own check — nothing is ever written back to the log, and a fresh Event revives the
Session immediately, with no extra step, by moving `lastEventTs` past the window again. A Session
WITH a pid is never a candidate for this rule at all, however long it's been silent — the two
rules are mutually exclusive by construction (gated on `pid !== undefined`), so they can never
disagree about the same Session. This is explicitly a TRANSITION-ONLY fallback: it can never fire
for a Session whose own `SessionStart`/`SubagentStart` hook fired under 0.3.0 or later, since
`handleSessionStart`/`handleSubagentStart` capture a pid unconditionally from that point on
(`captureProcessMarker` always returns ONE, defaulting to the hook's own `process.ppid` — only its
paired start marker can be absent). The one 0.3.0+ shape this rule still legitimately sweeps up is
a Session whose `SessionStart` hook never fired at all and was later backfilled from a different
Event's `cwd` (`backfillSessionStartedIfMissing`, ticket 05's own M6) — that path never captures a
pid either, by its own design, so it is exactly as unable to confirm liveness as a true pre-0.3.0
Session, and this rule is the correct fallback for it too, not a loophole. The day every pre-0.3.0
Session has either ended or been archived, this rule keeps applying only to that narrower
backfilled case — it never needs deleting or migrating away.

24h, not some shorter window, because that is already the number this project treats as "long
enough that a real Session would have said something by now" — the board's own TERMINÓ column.
Reusing it means a no-pid Session and a pid-confirmed-gone Session age out of "still running" on
the exact same clock a human already reads, rather than introducing a second threshold for them to
learn.

The synthesized `endedAt` is `lastEventTs` PLUS the window (`TERMINO_WINDOW_MS`) — the FIXED moment
this Session's silence first crossed the 24h line — never a bare `lastEventTs` and never `now`
(human's own call, 2026-10-28). A bare `lastEventTs` was ADR 0008's own pid-confirmed choice, but it
doesn't work here: by the time this rule can fire at all, `lastEventTs` is already more than 24h
old, so stamping `endedAt` with it would make the board's own 24h TERMINÓ window (`sessionColumn`,
the same `TERMINO_WINDOW_MS`) read the Session as already past its own window and drop the card
before a human ever sees it — "ended" on `tenaza status`/the statusline, but never reachable on the
one surface that can actually archive it (`archiveSession` is only ever invoked from a board card's
own "x"). `now` was tried first instead and rejected: it moves on every read, so `endedAt` never
settles on one value, the card never ages out of TERMINÓ on its own, and a human would have to
archive every single one of these by hand — the opposite of what this rule is for.

`lastEventTs + windowMs` gives the board exactly the SAME 24h-wide TERMINÓ window every other ended
Session already gets, just anchored to when the silence crossed the line rather than to when the
last real Event landed: the card reads TERMINÓ (archivable with "x") for total silence between 24h
and 48h, then drops off the board on its own past 48h — aging out exactly like any other ended
Session, never a permanent fixture a human must remember to clear. The board's own age label still
reads `lastEventTs`, never `endedAt` (`viewModel.ts`), so a card showing "12d" keeps showing "12d,"
never a misleading "0s." The accepted trade: a Session already silent past 48h the FIRST time this
rule ever observes it (e.g. right after this change ships, against data that was already stale for
weeks) never shows on the board at all — there is no real end moment to recover for data that old,
and a human would have had no 24h-wide window to catch it in regardless. `tenaza status`/the
statusline are unaffected either way: they gate on `endedAt !== undefined` alone, never on the
board's own window, so the Session still reads "ended" there.

Subagents follow the same rule on their own node, exactly like the pid-confirmed case — no special
walk to a parent.
