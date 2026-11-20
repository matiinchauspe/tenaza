#!/usr/bin/env bash
# Runs on each Linux release build, where no macOS notifier exists, so a pass also proves the
# hook never needs one.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tenaza-binary>" >&2
  exit 1
fi

BIN="$1"
HOME_DIR="$(mktemp -d)"
trap 'rm -rf "$HOME_DIR"' EXIT

# The test suite's recorder would hide the real notifier path this smoke exists to run.
unset TENAZA_NOTIFY_RECORDER

mkdir -p "$HOME_DIR/config"
cat >"$HOME_DIR/config/policy.toml" <<'EOF'
[[rule]]
match = "gh pr merge"
effect = "human"
EOF

fail() {
  echo "smoke-hook: FAIL — $1" >&2
  exit 1
}

hook() {
  local command="$1" err="$HOME_DIR/hook.err"
  printf '{"session_id":"smoke","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "$command" |
    TENAZA_HOME="$HOME_DIR" "$BIN" hook claude 2>"$err" || fail "'$command' exited $?: $(cat "$err")"
  if [[ -s "$err" ]]; then fail "'$command' wrote to stderr: $(cat "$err")"; fi
}

allowed="$(hook "ls -la")"
[[ -z "$allowed" ]] || fail "allowed command got an answer: $allowed"

reserved="$(hook "gh pr merge 1")"
[[ "$reserved" == *'"permissionDecision":"deny"'* ]] || fail "reserved command was not denied: $reserved"
[[ "$reserved" != *systemMessage* ]] || fail "reserved command carried a warning: $reserved"

[[ -s "$HOME_DIR/state/sessions/smoke.jsonl" ]] || fail "no session log under TENAZA_HOME/state"
status="$(TENAZA_HOME="$HOME_DIR" "$BIN" status)"
[[ "$status" == *"gh pr merge 1"* ]] || fail "the Inbox does not list the reserved command: $status"

echo "smoke-hook: pass — allowed passed, reserved denied and in the Inbox"
