/**
 * Tenaza's own version — one literal, baked into every build. Bumped by
 * hand alongside `packaging/homebrew/update-formula.sh`'s argument and the
 * release tag, never read from `package.json` at runtime: a `bun build
 * --compile` binary embeds a module like this one at build time, so a dev
 * `bun run` invocation and the compiled release always agree, where a
 * filesystem read of `package.json` could drift between the two. `tenaza
 * --version` (ticket 05) prints this same constant; the SessionStart
 * self-check (ADR 0007, ticket 02) reads it too, for the same reason: one
 * source of truth for "which Tenaza is this."
 */
export const TENAZA_VERSION = "0.2.0";
