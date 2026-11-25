## Sandbox

This repo runs one Task at a time in an isolated Sandbox with Crisol, which leaves exactly one named
branch in this repo and never touches its working tree.

- Run one Task:
  `crisol run --file <package> --base <ref> --name <branch> --gate "<cmd>" --adapter claude-code --json`
  `<package>` is a file whose whole content is the Task. `<ref>` must be a local branch, tag or sha;
  `<branch>` must not exist yet. `--gate` is repeatable and replaces the Gates in
  `.crisol/config.toml`; leave it out to use those.
- Continue a Run by its branch:
  `crisol run --continue <branch> --file <request> --adapter claude-code --json`
  sends `<request>` to the same agent session, on the same branch, and moves that branch forward.
- Both print one JSON line, the Run result: `branch`, `status` (`verified`, `unverified`,
  `not-converged`, `parked` or `checkpoint`) and `finalMessage`, the agent's last message verbatim.
- Read `status`, not the exit code. A provider failure (a rate limit, a quota, a failed login) exits
  0 as `not-converged` with `reason: "provider: …"`, and a Run that failed after it started exits 1
  but still prints its Run result. Nothing on stdout means no Run result was written; stderr says why.
