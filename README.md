# Tenaza

A decoupled control plane for coding agents: observes agent Sessions, enforces a Policy on
human-reserved Actions, and shows state. It never launches work. See `GLOSSARY.md` for its
ubiquitous language and `docs/adr/` for the decisions behind its shape.

## Develop

```bash
bun install
bun test        # black-box, against a temporary TENAZA_HOME
bun run typecheck
bun run build    # bun build --compile -> dist/tenaza
```

## Use

```bash
echo '<hook payload>' | tenaza hook claude   # PreToolUse, SessionStart, SubagentStart, SubagentStop, SessionEnd, Stop, PostToolUse
tenaza status
tenaza run <id>       # execute the stored command at your request; closes on exit 0
tenaza done <id>      # close an item you ran yourself, by hand
tenaza dismiss <id>   # close an item that no longer applies
tenaza label key=value [key=value …]   # announce Labels on the caller's own Session
```

Tenaza never executes a stored command except through `tenaza run`. Resolving an
already-closed item is a no-op — safe to repeat.

`tenaza status` shows every observed Session as a tree, grouped by project (derived from a
`project` Label, else the git root of the Session's cwd, else the cwd itself). A Claude Code
subagent is its own Session, nested under its parent; a parent's glyph rolls up its most urgent
descendant (waits for the human > alive > done > ended). Each row carries a context bar — 15
cells over 300k (20k per cell), a `┊` mark at the Policy's threshold (default 200k), cells past
it in red, and the number as `243k`, or `⚑243k` once Flagged. The Claude Adapter samples it by
parsing the Session's own transcript at `Stop`, `SubagentStop` and `SessionEnd`, and every 25
tool calls on `PostToolUse` — v1 never stops a Session for its size, only shows it. Each row
shows its `ticket` Label when one was announced, else its structural role ("sesión" /
"subagente"). The Inbox follows below the tree.

An agent doesn't know its own Session id, so it announces Labels by running `tenaza label
ticket=RES-131 project=reservee`; the Claude Code Adapter's `PreToolUse` hook intercepts that
exact command and writes `session.labeled` into the RIGHT Session's log — the one the hook
itself fired in (`agent_id` when the call came from inside a subagent, `session_id` otherwise),
never the one the agent happened to spell in the command (ADR 0003). The command's own process
exit code is always 0 regardless of its args; it never does the labeling itself and never fails.
Labels are opaque strings, stored and shown as given — only `project` is ever interpreted (for
grouping). A later announce adds or overrides keys; earlier ones remain.

State lives under `TENAZA_HOME` (default `~/.tenaza/`): `config/policy.toml` for the Policy
(an optional `[flag]` `threshold_tokens` overrides the default 200k), `state/sessions/<session>.jsonl`
for each Session's Events, `state/sessions/<session>.toolcalls` for its running PostToolUse count
(not an Event — never read as one), `state/human.jsonl` for Resolutions.
