---
description: Open Tenaza's Live surface (the Daemon's board) — or print how to start it.
allowed-tools: Bash(tenaza:*)
---

Run `tenaza open` and show its output to the user, verbatim, with no extra commentary of your
own — no summary, no restated instructions, nothing added or removed. That command alone decides
what happens: it opens the board in the browser when the Daemon is up, or prints how to start it
when it is down. Never run `tenaza ui` or any other `tenaza` command yourself to "help" — this
command's entire job is to run `tenaza open` once and relay what it printed.

!`tenaza open`
