#!/usr/bin/env bash
# Extract one version's own section out of CHANGELOG.md (Keep a Changelog
# style: "## [<version>] - <date>" headings, one per release) — what
# .github/workflows/release.yml feeds to softprops/action-gh-release's
# `body_path`, so a tagged release's notes are always exactly what shipped
# in the changelog for that version, never empty and never hand-typed at
# release time. GitHub's own generated PR list still appends below it
# (`generate_release_notes: true`), unaffected by this script.
#
# Usage:
#   scripts/extract-changelog.sh <version> [changelog-path]
#
#   <version>           e.g. 0.2.0 — WITHOUT a leading "v". The release
#                       workflow strips the tag's own "v" before calling
#                       this; a bare `<version>` keeps this script portable
#                       to any future tag scheme that isn't "v"-prefixed.
#   [changelog-path]    optional; defaults to CHANGELOG.md next to this
#                       script's own repo root.
#
# Prints the matched section's BODY to stdout — everything between its own
# "## [<version>]" heading and the next "## [" heading (or EOF), leading
# and trailing blank lines trimmed, never the heading line itself (the
# release's own title already carries the version). A version with NO
# heading at all exits 1 with a message on stderr and prints nothing: a
# missing section must fail the release job loudly, never publish an empty
# or wrong body silently.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <version> [changelog-path]" >&2
  exit 1
fi

VERSION="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHANGELOG="${2:-${SCRIPT_DIR}/../CHANGELOG.md}"

if [[ ! -f "$CHANGELOG" ]]; then
  echo "error: no changelog at ${CHANGELOG}" >&2
  exit 1
fi

# Plain awk, not grep+sed: one pass finds the version's own heading (an
# EXACT prefix match on "## [<version>]" followed by either end-of-line or
# a space — never a substring match, so "0.2.0" can never match a
# "## [10.2.0]" or "## [0.2.0-rc1]" heading), buffers every line after it
# until the NEXT "## [" heading, then trims only the leading/trailing
# blank lines before printing. Done entirely in awk (no separate sed pass)
# because a leading/trailing-blank-line trim is exactly the kind of thing
# GNU sed and BSD/macOS sed disagree on for range addresses
# (packaging/homebrew/update-formula.sh's own doc comment has the story) —
# awk behaves identically across this project's dev machines and CI.
set +e
RESULT="$(awk -v ver="$VERSION" '
  BEGIN { found = 0; printing = 0; n = 0 }
  /^## \[/ {
    if (printing) exit
    prefix = "## [" ver "]"
    if (index($0, prefix) == 1) {
      rest = substr($0, length(prefix) + 1)
      if (rest == "" || substr(rest, 1, 1) == " ") {
        found = 1
        printing = 1
        next
      }
    }
    next
  }
  printing { lines[n++] = $0 }
  END {
    if (!found) exit 2
    start = 0
    while (start < n && lines[start] == "") start++
    last = n - 1
    while (last >= start && lines[last] == "") last--
    for (i = start; i <= last; i++) print lines[i]
  }
' "$CHANGELOG")"
STATUS=$?
set -e

if [[ "$STATUS" -eq 2 ]]; then
  echo "error: CHANGELOG.md has no section for version ${VERSION}" >&2
  exit 1
elif [[ "$STATUS" -ne 0 ]]; then
  exit "$STATUS"
fi

printf '%s\n' "$RESULT"
