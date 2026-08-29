#!/bin/sh
# om-prepare-test-env: generated entrypoint (contract v2)
# regenerate with: om-prepare-test-env --regenerate
# history:
#   2026-07-14 generated — mirrors test-env-up.sh; no services to remove, so this
#             only stops the app PID this repo started and marks the descriptor stopped.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
QA_DIR="$REPO_ROOT/.ai/qa"
ENV_DESCRIPTOR="$QA_DIR/test-env.json"

log() { echo "[test-env] $*" >&2; }

[ -f "$ENV_DESCRIPTOR" ] || { log "no descriptor — nothing to stop"; exit 0; }

pid=$(node -e '
  const fs = require("fs");
  try {
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (d.startedByThisRepo && d.app && d.app.pid) process.stdout.write(String(d.app.pid));
  } catch { /* corrupt descriptor → nothing safe to stop */ }
' "$ENV_DESCRIPTOR" 2>/dev/null || true)

# Only ever stop what this repo started; safe to run twice.
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  log "stopping cezar (pid $pid)"
  kill "$pid" 2>/dev/null || true
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -9 "$pid" 2>/dev/null || true
else
  log "app is already stopped"
fi

# The D2 scratch TMPDIR (a candidate launch condition, `.ai/qa/test-env.json`'s
# `browser.env.TMPDIR`) belongs to this environment's lifetime, not to the OS's own /tmp
# cleanup — remove it alongside everything else this run owns.
scratch_tmpdir=$(node -e '
  const fs = require("fs");
  try {
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const t = d.browser && d.browser.env && d.browser.env.TMPDIR;
    if (t) process.stdout.write(t);
  } catch { /* corrupt descriptor → nothing safe to remove */ }
' "$ENV_DESCRIPTOR" 2>/dev/null || true)
case "$scratch_tmpdir" in
  /tmp/cez-e2e.*) rm -rf "$scratch_tmpdir" 2>/dev/null || true ;;
  *) : ;; # empty, or not one of ours — never rm -rf a path this script did not create
esac

node -e '
  const fs = require("fs");
  const f = process.argv[1];
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.status = "stopped";
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  } catch { /* leave a corrupt descriptor alone — up will treat it as stale */ }
' "$ENV_DESCRIPTOR"

rm -rf "$QA_DIR/test-env.lock" 2>/dev/null || true
echo "TEST_ENV_STATUS=stopped"
