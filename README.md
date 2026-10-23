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
echo '<hook payload>' | tenaza hook claude   # PreToolUse, SessionStart, SubagentStart, SubagentStop, SessionEnd
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
descendant (waits for the human > alive > done > ended). The Inbox follows below the tree.

State lives under `TENAZA_HOME` (default `~/.tenaza/`): `config/policy.toml` for the Policy,
`state/sessions/<session>.jsonl` for each Session's Events, `state/human.jsonl` for Resolutions.
