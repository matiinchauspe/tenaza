#!/usr/bin/env bash
# Fill packaging/homebrew/tenaza.rb's version and sha256 placeholders from a
# published GitHub Release, then (optionally) commit that file into the
# separate tap repo matiinchauspe/homebrew-tap.
#
# Usage:
#   packaging/homebrew/update-formula.sh <version> [path-to-homebrew-tap-checkout]
#
#   <version>                   e.g. 0.1.0 — WITHOUT a leading "v"; must
#                                match a release already tagged v<version>
#                                with tenaza-darwin-arm64, tenaza-darwin-x64
#                                and checksums.txt uploaded as assets.
#   [path-to-homebrew-tap-checkout]
#                                optional. When given, the filled formula is
#                                also copied to
#                                <path>/Formula/tenaza.rb. Commit and push
#                                that repo yourself — this script never
#                                touches git.
#
# Requires: gh (authenticated), sha256sum (or shasum on macOS — handled
# below).
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <version> [path-to-homebrew-tap-checkout]" >&2
  exit 1
fi

VERSION="$1"
TAP_PATH="${2:-}"
REPO="matiinchauspe/tenaza"
TAG="v${VERSION}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORMULA="${SCRIPT_DIR}/tenaza.rb"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "Fetching checksums.txt from release ${TAG}..." >&2
gh release download "$TAG" --repo "$REPO" --pattern "checksums.txt" --dir "$WORKDIR"

ARM64_SHA="$(awk '/tenaza-darwin-arm64$/ { print $1 }' "${WORKDIR}/checksums.txt")"
X64_SHA="$(awk '/tenaza-darwin-x64$/ { print $1 }' "${WORKDIR}/checksums.txt")"

if [[ -z "$ARM64_SHA" || -z "$X64_SHA" ]]; then
  echo "error: could not find both checksums in checksums.txt for release ${TAG}" >&2
  cat "${WORKDIR}/checksums.txt" >&2
  exit 1
fi

# awk, not sed: the formula has TWO sha256 lines (arm64's, then x64's), and
# a plain `s/sha256 "[0-9a-f]+"/.../ ` substitution matches every line that
# contains one, not just "the first" — a `0,/re/` GNU-sed range trick to
# scope it to just the first line was tried and tested against a scratch
# copy of this formula; it did not restrict the match as expected (BSD sed
# on macOS, where this script also has to run, doesn't honour it the same
# way), so it would have silently written the x64 hash onto BOTH lines. awk
# tracks which `url` line (…darwin-arm64 or …darwin-x64) came immediately
# before, so each sha256 line only ever gets its own architecture's hash,
# which also makes this portable across the GNU/BSD awk split.
awk -v arm_sha="$ARM64_SHA" -v x64_sha="$X64_SHA" -v ver="$VERSION" '
  /version "[0-9]/ { sub(/version "[0-9][0-9.]*"/, "version \"" ver "\"") }
  /darwin-arm64"$/ { arch = "arm" }
  /darwin-x64"$/   { arch = "x64" }
  /sha256 "/ {
    if (arch == "arm") sub(/sha256 "[0-9a-f]+"/, "sha256 \"" arm_sha "\"")
    else if (arch == "x64") sub(/sha256 "[0-9a-f]+"/, "sha256 \"" x64_sha "\"")
  }
  { print }
' "$FORMULA" >"${WORKDIR}/tenaza.rb.new"

cp "${WORKDIR}/tenaza.rb.new" "$FORMULA"

echo "Updated ${FORMULA}:" >&2
grep -E 'version "|sha256 "' "$FORMULA" >&2

if [[ -n "$TAP_PATH" ]]; then
  mkdir -p "${TAP_PATH}/Formula"
  cp "$FORMULA" "${TAP_PATH}/Formula/tenaza.rb"
  echo "Copied to ${TAP_PATH}/Formula/tenaza.rb — commit and push that repo yourself." >&2
fi
