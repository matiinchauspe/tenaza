# Tenaza glossary

Tenaza is a decoupled agent control plane: it observes agent sessions, enforces policy on
human-reserved actions, and shows state. It never launches work.

## Observation

**Session**:
One agent context window — a main agent or a subagent — with an optional parent: the Session
that launched it. The unit Tenaza observes.
_Avoid_: Run, conversation, job

**Label**:
An opaque key=value attached to a Session by whoever announced it. Tenaza stores and shows Labels
without interpreting them — except the reserved `project`, which groups Sessions.
_Avoid_: Tag, metadata, annotation

**Event**:
One line in a Session's append-only log, in the contract's envelope (`v`, `ts`, `session`, `type`,
`data`). State is always derived from Events, never stored beside them.
_Avoid_: Record, entry, message

**Usage sample**:
An Event carrying a Session's context size (and cost when known) at a point in time.
_Avoid_: Metric, token count

**Process liveness**:
Whether a Session's runtime process (its OS pid, captured once at `session.started` and paired
with a start marker against pid reuse) is still running — checked fresh on every read, never
stored and never run from a hook. A Session whose process is confirmed gone reads as closed, with
a reason distinct from a real `SessionEnd`, even though no such Event ever arrived.
_Avoid_: Heartbeat, ping, health check

## Runtimes

**Adapter**:
The plugin that translates one agent runtime's hooks and transcripts into Events, and the only
code that knows that runtime exists.
_Avoid_: Integration, driver, connector

**Capability**:
Something an Adapter declares it can do — observe, block, measure, stop. The core degrades by
Capability, never by runtime name.
_Avoid_: Feature, support

## Policy

**Action**:
An agent's attempted operation, normalized by the Adapter into a runtime-neutral shape
(`shell`, `file.write`, `mcp`) that Rules match on.
_Avoid_: Tool call, command

**Rule**:
One entry of the Policy: a pattern and the Effect applied when an Action matches it — for a
`shell` Action, a word sequence that runs inside a command the Action actually executes (text the
command only carries, like a quoted argument or a heredoc body, never matches); for an `mcp`
Action, a tool name with optional conditions on its arguments.
_Avoid_: Guard, filter

**Effect**:
What a matching Rule does: `human` (deny, and open an Inbox item) or `flag` (allow, but record it).
_Avoid_: Verdict, outcome

**Policy**:
The user's set of Rules and thresholds — one global file for every project; a Rule for a tool a
project lacks simply never matches.
A guardrail against honest agent mistakes, not a security boundary.
_Avoid_: Config, permissions

**Flag**:
A mark on a Session or Action that crossed a threshold or matched a `flag` Rule — shown, never
enforced.
_Avoid_: Alert, warning, alarm

## The human

**Inbox item**:
An Action that matched a `human` Rule, carrying the exact command, surfaced for the human: denied
and awaiting their run when the Adapter has the `block` Capability to enforce it, or — when it
doesn't — already allowed (the call could not actually be stopped) but still recorded and shown,
never silently dropped (ADR 0001). It is born **live** when a Daemon is up — its agent holds,
waiting for the human's answer in the Live surface — and turns **pending** (denied, awaiting
their run) when the wait window lapses; one item, one id, throughout.
_Avoid_: Approval, pending, ticket

**Resolution**:
The human closing an Inbox item: `done` (they ran it, by hand or through `tenaza run`, which
executes the stored command on their request and closes the item on exit 0 — but REFUSES on an
item that already ran once, unblocked, rather than run it a second time) or `dismissed` (no
longer applies). Tenaza never runs a command on its own initiative.
_Avoid_: Approval, ack

**Live surface**:
The local page where the human watches their Sessions and Inbox change on their own, and acts on
them.
_Avoid_: Dashboard, UI, panel

**Daemon**:
The Tenaza process kept running by the OS service manager: it serves the Live surface, notices
the silences no hook sees, and runs a stored command only on the human's click — never on its own.
No hook depends on it, so its absence never leaves anything unsafe (ADR 0004).
_Avoid_: Server, service, agent

## Not Tenaza's language

- **Run** — Yunque's term (one ticket executed to completion). In Tenaza, a Yunque run is a Session
  carrying Labels.
