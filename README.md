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
tool calls on `PostToolUse` — v1 never stops a Session for its size, only shows it. The Inbox
follows below the tree.

State lives under `TENAZA_HOME` (default `~/.tenaza/`): `config/policy.toml` for the Policy
(an optional `[flag]` `threshold_tokens` overrides the default 200k), `state/sessions/<session>.jsonl`
for each Session's Events, `state/sessions/<session>.toolcalls` for its running PostToolUse count
(not an Event — never read as one), `state/human.jsonl` for Resolutions.
