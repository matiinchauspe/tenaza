# frozen_string_literal: true

# Tenaza: a decoupled control plane for coding agents. Prebuilt-binary
# formula, no source build — the binary ships from `tenaza`'s own GitHub
# Release (see `.github/workflows/release.yml`).
#
# This repo is its own tap: `brew tap matiinchauspe/tenaza
# https://github.com/matiinchauspe/tenaza` reads this file straight from
# main. Filled in by packaging/homebrew/update-formula.sh from a published
# release — do not hand-edit version/url/sha256 below; re-run the script
# and commit the result instead.
class Tenaza < Formula
  desc "Decoupled control plane for coding agents: observe, enforce, show"
  homepage "https://github.com/matiinchauspe/tenaza"
  version "0.3.1"
  license "MIT"

  # The two sha256 values below are the real digests from the release's
  # checksums.txt — update-formula.sh overwrites both on every release.
  if Hardware::CPU.arm?
    url "https://github.com/matiinchauspe/tenaza/releases/download/v#{version}/tenaza-darwin-arm64"
    sha256 "016303996d6e13e04ab5a55f90929061897f92b191e1e88a2f48afe4b6a73b46"
  else
    url "https://github.com/matiinchauspe/tenaza/releases/download/v#{version}/tenaza-darwin-x64"
    sha256 "160955ff3b3662487b6038ead27f5a0b24fdbc23962e7932bee4ac26567a8041"
  end

  def install
    # The release asset is the bare `bun build --compile` binary (no
    # archive), named for its target (tenaza-darwin-arm64 /
    # tenaza-darwin-x64) — rename it to the command name on install.
    bin.install Dir["tenaza-darwin-*"].first => "tenaza"
  end

  # The Daemon's optional LaunchAgent (decision 05, ADR 0004): a USER agent,
  # never `sudo` — Tenaza watches one human's own `~/.tenaza/state/` and
  # focuses that human's own terminals, neither of which a system daemon
  # could do. `brew services start tenaza` is what installs and loads this;
  # `brew install` on its own never touches launchd at all (Homebrew only
  # registers a `service` block on an explicit `services` command), which is
  # how "brew install starts nothing" holds with no extra code here.
  service do
    run [opt_bin/"tenaza", "ui", "--no-open"]
    # `--no-open`: a LaunchAgent restarts on its own (a reboot, KeepAlive
    # after a crash) far more often than a human types `brew services start
    # tenaza` — popping a browser window on every one of those would be
    # Tenaza acting on its own initiative (ADR 0007, spec's own "nothing
    # starts on its own"), the exact thing v0.2 is built to never do. A
    # human who wants the view opens it by hand: `tenaza ui`, or the
    # plugin's `/tenaza`.
    keep_alive true
    # Homebrew's own PATH, not launchd's bare minimal one — `tenaza ui`
    # shells out to `open`, `osascript`, `tmux` and the terminal CLIs (ticket
    # 11's own focuser) to bring a terminal to the front; launchd's default
    # PATH has none of them.
    environment_variables PATH: std_service_path_env
    log_path var/"log/tenaza.log"
    error_log_path var/"log/tenaza.log"
  end

  def caveats
    <<~EOS
      Next: run `tenaza init` — writes a starter Policy and wires up the statusline.
      Safe to re-run any time; it never overwrites a Policy or a statusline you already have.

      The Daemon (the Live surface's board, live answering) is OPT-IN.
      Installing Tenaza starts nothing — no service, no process, no port.

      Start it as a background service, restarted on login/crash:
        brew services start tenaza
      Or run it yourself, in the foreground (Ctrl-C stops it):
        tenaza ui

      Either way, open the board from any Claude Code session with /tenaza.
    EOS
  end

  test do
    assert_match "Inbox:", shell_output("TENAZA_HOME=#{testpath} #{bin}/tenaza status")
  end
end
