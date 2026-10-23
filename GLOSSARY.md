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
One entry of the Policy: an Action pattern and the Effect applied when it matches.
_Avoid_: Guard, filter

**Effect**:
What a matching Rule does: `human` (deny, and open an Inbox item) or `flag` (allow, but record it).
_Avoid_: Verdict, outcome

**Policy**:
The user's set of Rules and thresholds — one global file with optional per-project sections.
A guardrail against honest agent mistakes, not a security boundary.
_Avoid_: Config, permissions

**Flag**:
A mark on a Session or Action that crossed a threshold or matched a `flag` Rule — shown, never
enforced.
_Avoid_: Alert, warning, alarm

## The human

**Inbox item**:
A denied Action awaiting the human, carrying the exact command for the human to run.
_Avoid_: Approval, pending, ticket

**Resolution**:
The human closing an Inbox item: `done` (they ran it, by hand or through `tenaza run`, which executes the stored command on their request and closes the item on exit 0) or `dismissed` (no longer applies). Tenaza never runs a command on its own initiative.
_Avoid_: Approval, ack

## Not Tenaza's language

- **Run** — Yunque's term (one ticket executed to completion). In Tenaza, a Yunque run is a Session
  carrying Labels.
