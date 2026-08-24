#!/usr/bin/env bash
#
# Verifies a brokered run survives a genuine `systemctl stop cezar.socket cezar.service &&
# systemctl start cezar.socket cezar.service`, not just a `restart`
# (.ai/specs/2026-08-22-broker-scope-isolation-full-stop-survival.md, Phase 0.4).
#
# This is not "run the commands by hand" turned into a script for convenience. Review of this
# spec's first draft found two reasons a hand-run test on this box produces a false PASS or, worse,
# strands production down with nothing to bring it back:
#
#   1. cezar.service is socket-activated. `cezar.socket` stays listening on 127.0.0.1:4321 and
#      re-triggers the service on the very next inbound request, so stopping the service alone may
#      never produce a real down window at all — "no interrupted event" would then mean nothing was
#      tested. Step 5 stops BOTH units, and Step 6 asserts InvocationID/MainPID/ActiveEnterTimestamp
#      actually changed, which is the only proof the stop was real.
#   2. The shell issuing the stop can live inside the very cgroup the test disrupts (this worktree's
#      own shell does, for instance). If the mechanism under test is broken, the stop can kill that
#      shell before it reaches the `start` half, leaving nothing to bring the service back. Step 3
#      arms an independent restore — a detached `systemd-run --on-active=…` transient unit, created
#      BEFORE the stop, from outside the target cgroup — as the safety net that does not depend on
#      this script's own process surviving.
#
# Must run as ROOT: arming the watchdog in Step 3 creates a SYSTEM transient unit, which the
# `cezar` service user's polkit grant deliberately does not extend to
# (docs/server-install/hetzner.md, "grant it narrowly ... never the right to create system
# transient units, which run as root").
#
# Usage:
#   sudo verify-stop-survival.sh --run-id <id> [--watchdog-seconds 180] [--yes]
#                                 [--data-dir <path>] [--health-url http://127.0.0.1:4321]
#
# Exit code is the verdict: 0 = every assertion held, 1 = at least one did not (or a precondition
# was not met — a precondition failure is not a pass, and is not reported as one).

set -euo pipefail

# ---- args -------------------------------------------------------------------------------------

RUN_ID=""
WATCHDOG_SECONDS=180
ASSUME_YES=0
# `/var/lib/cezar/loki-labs/cezar/.ai/cezar` is where this run's own dataDir lives on
# prod-host today (`RunManager`'s dataDir is `<repoRoot>/.ai/cezar`) — a concrete default so
# the common case needs no flag, overridable because the repo root a `cezar.service` unit runs
# against is host-specific and not something this script can discover on its own.
DATA_DIR="${CEZ_DATA_DIR:-/var/lib/cezar/loki-labs/cezar/.ai/cezar}"
HEALTH_URL="http://127.0.0.1:4321"
SERVICE_UNIT="cezar.service"
SOCKET_UNIT="cezar.socket"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id) RUN_ID="$2"; shift 2 ;;
    --watchdog-seconds) WATCHDOG_SECONDS="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --health-url) HEALTH_URL="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$RUN_ID" ]]; then
  echo "usage: verify-stop-survival.sh --run-id <id> [--watchdog-seconds N] [--yes] [--data-dir <path>] [--health-url <url>]" >&2
  exit 1
fi

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "FAIL: must run as root — Step 3 arms the restore watchdog as a SYSTEM transient unit," >&2
  echo "      which the cezar service user's polkit grant does not extend to. Re-run with sudo." >&2
  exit 1
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

note() {
  echo "-- $*"
}

# ---- Step 1: precondition — health must already read 'scope' -----------------------------------

note "Step 1: checking $HEALTH_URL/api/v1/health reports runtime.runBrokerIsolation == scope"
isolation_before="$(curl -fsS "$HEALTH_URL/api/v1/health" | jq -r '.runtime.runBrokerIsolation')"
[[ "$isolation_before" == "scope" ]] || fail "runtime.runBrokerIsolation is '$isolation_before', not 'scope' — the box is not in a state this test can pass from. Do not proceed."
note "   isolation = scope (AC1 precondition met)"

# ---- Step 2: baseline capture -------------------------------------------------------------------

note "Step 2: capturing baseline for run $RUN_ID"

RUNS_JSON="$DATA_DIR/runs.json"
[[ -f "$RUNS_JSON" ]] || fail "no run index at $RUNS_JSON — wrong --data-dir?"

run_status="$(jq -r --arg id "$RUN_ID" '.[] | select(.id == $id) | .status' "$RUNS_JSON")"
[[ -n "$run_status" ]] || fail "no run '$RUN_ID' in $RUNS_JSON"

run_backend="$(jq -r --arg id "$RUN_ID" '.[] | select(.id == $id) | .backend // ""' "$RUNS_JSON")"
[[ "$run_backend" == "claude" ]] || fail "run '$RUN_ID' backend is '$run_backend', not a brokered backend (today just 'claude') — this run cannot reattach regardless of isolation mode, and the test would measure nothing."

SPOOL_DIR="$DATA_DIR/runs/$RUN_ID.spool"
META_JSON="$SPOOL_DIR/meta.json"
[[ -f "$META_JSON" ]] || fail "no spool meta at $META_JSON — run '$RUN_ID' is not brokered, or its spool is gone"

meta_backend="$(jq -r '.backend' "$META_JSON")"
[[ "$meta_backend" == "claude" ]] || fail "spool meta backend is '$meta_backend', not a brokered backend — same as above, at the spool rather than the run-record layer"

step_id="$(jq -r '.stepId // ""' "$META_JSON")"
[[ -n "$step_id" ]] || fail "spool meta has no stepId — reattachBrokeredRun requires one to match against the open step"

step_status="$(jq -r --arg id "$RUN_ID" --arg step "$step_id" '.[] | select(.id == $id) | .steps[] | select(.id == $step) | .status' "$RUNS_JSON")"
case "$step_status" in
  done|failed|cancelled|skipped)
    fail "step '$step_id' is terminal ('$step_status') — a run sitting between steps is exactly the false-negative case this test must avoid. Pick a run that is genuinely mid-step." ;;
  "")
    fail "step '$step_id' (named by spool meta) not found on run '$RUN_ID' — meta and the run record disagree" ;;
esac
note "   run status=$run_status step=$step_id (status=$step_status), backend=claude — a valid test subject"

broker_pid="$(jq -r '.pid' "$META_JSON")"
[[ "$broker_pid" =~ ^[0-9]+$ ]] || fail "spool meta .pid is not a number: '$broker_pid'"
kill -0 "$broker_pid" 2>/dev/null || fail "broker pid $broker_pid (from spool meta) is not alive — nothing to watch"
broker_cgroup_before="$(cat "/proc/$broker_pid/cgroup")"
note "   broker pid=$broker_pid cgroup=$broker_cgroup_before"

NDJSON_FILE="$DATA_DIR/runs/$RUN_ID.ndjson"
[[ -f "$NDJSON_FILE" ]] || fail "no event log at $NDJSON_FILE"
baseline_line_count="$(wc -l < "$NDJSON_FILE")"
baseline_seq="$(tail -n 1 "$NDJSON_FILE" | jq -r '.seq')"
note "   ndjson: $baseline_line_count lines, last seq=$baseline_seq"

# One property per call, not `-p A -p B -p C` in one call: MEASURED on prod-host that
# `systemctl show --value -p X -p Y -p Z` does NOT print values in the order the flags were given
# (it prints in the unit's own property order — alphabetical here: ActiveEnterTimestamp,
# InvocationID, MainPID — regardless of `-p` order), so positional unpacking silently mislabels
# every value. One call per property has no ordering to get wrong.
unit_prop() {
  systemctl show "$1" --value -p "$2"
}
svc_invocation_before="$(unit_prop "$SERVICE_UNIT" InvocationID)"
svc_mainpid_before="$(unit_prop "$SERVICE_UNIT" MainPID)"
svc_active_since_before="$(unit_prop "$SERVICE_UNIT" ActiveEnterTimestamp)"
socket_state_before="$(unit_prop "$SOCKET_UNIT" ActiveState)"
note "   $SERVICE_UNIT: InvocationID=$svc_invocation_before MainPID=$svc_mainpid_before ActiveEnterTimestamp=$svc_active_since_before"
note "   $SOCKET_UNIT: ActiveState=$socket_state_before"

# ---- Step 3: arm the independent restore watchdog, BEFORE the stop -----------------------------

watchdog_ts="$(date -u +%s 2>/dev/null || echo fallback)"
WATCHDOG_UNIT="cezar-restore-watchdog-${watchdog_ts}"
note "Step 3: arming restore watchdog '$WATCHDOG_UNIT' (fires in ${WATCHDOG_SECONDS}s if this script does not clean it up)"
systemd-run --on-active="${WATCHDOG_SECONDS}" --unit="$WATCHDOG_UNIT" \
  /bin/systemctl start "$SOCKET_UNIT" "$SERVICE_UNIT" >/dev/null
note "   armed — lives outside ${SERVICE_UNIT}'s cgroup and outside this shell, so it fires even if the stop kills this script"

# ---- Step 4: confirm ----------------------------------------------------------------------------

if [[ "$ASSUME_YES" -ne 1 ]]; then
  echo
  echo "About to run: systemctl stop $SOCKET_UNIT $SERVICE_UNIT ; sleep 5 ; systemctl start $SOCKET_UNIT $SERVICE_UNIT"
  echo "This disrupts EVERY currently in-flight task on this box that is not in 'scope' isolation."
  echo "Restore watchdog '$WATCHDOG_UNIT' is armed as a backstop (fires in ${WATCHDOG_SECONDS}s)."
  read -r -p "Type 'yes' to proceed: " confirm
  [[ "$confirm" == "yes" ]] || { echo "Aborted — not proceeding. Cleaning up the watchdog." >&2; systemctl stop "${WATCHDOG_UNIT}.timer" 2>/dev/null || true; exit 1; }
fi

# ---- Step 5: the disruption ----------------------------------------------------------------------

note "Step 5: stopping $SOCKET_UNIT $SERVICE_UNIT"
systemctl stop "$SOCKET_UNIT" "$SERVICE_UNIT"
sleep 5
note "Step 5: starting $SOCKET_UNIT $SERVICE_UNIT"
systemctl start "$SOCKET_UNIT" "$SERVICE_UNIT"

# ---- Step 6: post-check against the Step 2 baseline ----------------------------------------------

note "Step 6: post-check"

svc_invocation_after="$(unit_prop "$SERVICE_UNIT" InvocationID)"
svc_mainpid_after="$(unit_prop "$SERVICE_UNIT" MainPID)"
svc_active_since_after="$(unit_prop "$SERVICE_UNIT" ActiveEnterTimestamp)"

if [[ "$svc_invocation_after" == "$svc_invocation_before" || "$svc_mainpid_after" == "$svc_mainpid_before" || "$svc_active_since_after" == "$svc_active_since_before" ]]; then
  fail "$SERVICE_UNIT's InvocationID/MainPID/ActiveEnterTimestamp did not all change (before: $svc_invocation_before/$svc_mainpid_before/$svc_active_since_before, after: $svc_invocation_after/$svc_mainpid_after/$svc_active_since_after) — the stop was not real, this run proves nothing. Do not read a pass below as valid."
fi
note "   $SERVICE_UNIT genuinely restarted (InvocationID/MainPID/ActiveEnterTimestamp all changed) — the stop was real"

kill -0 "$broker_pid" 2>/dev/null || fail "broker pid $broker_pid is GONE after the stop/start — the run did NOT survive (AC2/AC3 failed)"
broker_cgroup_after="$(cat "/proc/$broker_pid/cgroup")"
[[ "$broker_cgroup_after" == "$broker_cgroup_before" ]] || fail "broker pid $broker_pid's cgroup changed ($broker_cgroup_before -> $broker_cgroup_after) — investigate before trusting anything else here"
note "   broker pid $broker_pid still alive, same cgroup ($broker_cgroup_after) — AC2 holds"

new_lines="$(tail -n "+$((baseline_line_count + 1))" "$NDJSON_FILE")"
kept_going_count="$(printf '%s\n' "$new_lines" | grep -c 'cezar restarted — this run kept going' || true)"
interrupted_count="$(printf '%s\n' "$new_lines" | grep -c 'interrupted — cezar process exited during the run' || true)"
resumed_count="$(printf '%s\n' "$new_lines" | grep -c 'cezar restarted — resuming the interrupted task from its last session' || true)"

[[ "$interrupted_count" -eq 0 ]] || fail "transcript logged 'interrupted — cezar process exited during the run' $interrupted_count time(s) — the broker was killed"
[[ "$resumed_count" -eq 0 ]] || fail "transcript logged 'cezar restarted — resuming the interrupted task from its last session' $resumed_count time(s) — this is the LEGACY force-resume path, exactly the failure mode this test exists to catch"
[[ "$kept_going_count" -eq 1 ]] || fail "expected exactly one 'cezar restarted — this run kept going' event, saw $kept_going_count. Either the re-attach path was not taken (0 — check the reenterChain branch at run.ts:1653, which logs neither string this test greps for) or something is duplicating events ($kept_going_count > 1)."
note "   exactly one 'cezar restarted — this run kept going' event, no 'interrupted' or 'resuming' event — AC3/AC4 (event evidence) hold"

mapfile -t all_seqs < <(jq -r '.seq' "$NDJSON_FILE")
prev=""
for s in "${all_seqs[@]}"; do
  if [[ -n "$prev" ]] && (( s != prev + 1 )); then
    fail "seq is not strictly consecutive: $prev then $s — a gap or a repeat happened across the stop/start"
  fi
  prev="$s"
done
note "   seq is strictly consecutive across the whole transcript, no gap, no repeat — AC4 (seq evidence) holds"

isolation_after="$(curl -fsS "$HEALTH_URL/api/v1/health" | jq -r '.runtime.runBrokerIsolation')"
[[ "$isolation_after" == "scope" ]] || fail "runtime.runBrokerIsolation is '$isolation_after' after the restart, not 'scope' — AC1 does not hold post-restart even though it held going in"
note "   isolation = scope, post-restart — AC1 re-confirmed against a real process boot"

# ---- Step 7: clean up the watchdog if it never fired ----------------------------------------------

if systemctl is-active --quiet "${WATCHDOG_UNIT}.timer" 2>/dev/null; then
  note "Step 7: watchdog '$WATCHDOG_UNIT' still pending — stopping it (recovery succeeded on its own)"
  systemctl stop "${WATCHDOG_UNIT}.timer" 2>/dev/null || true
else
  note "Step 7: watchdog '$WATCHDOG_UNIT' already fired or was never armed as a timer — not treated as a failure"
fi

echo
echo "PASS — run $RUN_ID survived a full 'systemctl stop $SOCKET_UNIT $SERVICE_UNIT && systemctl start $SOCKET_UNIT $SERVICE_UNIT'."
echo "  broker pid:        $broker_pid (unchanged cgroup)"
echo "  $SERVICE_UNIT InvocationID: $svc_invocation_before -> $svc_invocation_after"
echo "  $SERVICE_UNIT MainPID:      $svc_mainpid_before -> $svc_mainpid_after"
echo "  seq range:          baseline=$baseline_seq, final=${prev:-$baseline_seq}, no gap/dup"
exit 0
