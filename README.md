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
echo '<PreToolUse hook payload>' | tenaza hook claude
tenaza status
```

State lives under `TENAZA_HOME` (default `~/.tenaza/`): `config/policy.toml` for the Policy,
`state/sessions/<session>.jsonl` for each Session's Events.
