# frozen_string_literal: true

# Tenaza: a decoupled control plane for coding agents. Prebuilt-binary
# formula, no source build — the binary ships from `tenaza`'s own GitHub
# Release (see `.github/workflows/release.yml`).
#
# Filled in by packaging/homebrew/update-formula.sh from a published
# release — do not hand-edit version/url/sha256 below; edit the script's
# inputs instead and re-run it.
class Tenaza < Formula
  desc "Decoupled control plane for coding agents: observe, enforce, show"
  homepage "https://github.com/matiinchauspe/tenaza"
  version "0.0.0"
  license "MIT"

  # The two sha256 values below are dummy 64-char hex placeholders (ending
  # ...1 / ...2 only so the two branches aren't byte-identical) —
  # update-formula.sh overwrites both with the real digests from the
  # release's checksums.txt.
  if Hardware::CPU.arm?
    url "https://github.com/matiinchauspe/tenaza/releases/download/v#{version}/tenaza-darwin-arm64"
    sha256 "0000000000000000000000000000000000000000000000000000000000000001"
  else
    url "https://github.com/matiinchauspe/tenaza/releases/download/v#{version}/tenaza-darwin-x64"
    sha256 "0000000000000000000000000000000000000000000000000000000000000002"
  end

  def install
    # The release asset is the bare `bun build --compile` binary (no
    # archive), named for its target (tenaza-darwin-arm64 /
    # tenaza-darwin-x64) — rename it to the command name on install.
    bin.install Dir["tenaza-darwin-*"].first => "tenaza"
  end

  test do
    assert_match "Inbox:", shell_output("TENAZA_HOME=#{testpath} #{bin}/tenaza status")
  end
end
