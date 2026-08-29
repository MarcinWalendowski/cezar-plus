#!/usr/bin/env bash
#
# Activate origin/main on this box: the whole manual deploy, as one command.
#
# WHY THIS EXISTS. cezar's two deploy targets are `"manual": true` (owner decision 2026-08-24,
# `.ai/specs/2026-08-24-default-workflow-ten-stages.md` D6): a person activates cezar, not an
# agent. That decision is unchanged. What this script changes is the SHAPE of the person's job.
# The handoff card used to ask for THIS RUN'S OWN WORKTREE, once per parked run, which meant the
# toil grew with the backlog and two divergent task branches could leave each other permanently
# red. Stage 8 lands a run on the base branch before the deploy step runs, so `origin/main`
# already contains the parked HEAD, and ONE activation of main satisfies EVERY parked run whose
# HEAD is an ancestor of it. See `.ai/specs/2026-08-26-activate-main-not-worktrees.md`.
#
# WHAT IT DOES NOT DO. No privileged step of its own, and no gate of its own: `server-deploy`
# keeps every check it already has (build-stamp/HEAD agreement, `staleSource`, and the divergence
# refusal at `server-install/release-deploy.ts`). This is a runbook that cannot be mistyped.
#
#   Usage:  bash scripts/activate-main.sh [--dry-run]
#   Env:    DEPLOY_CHECKOUT  (default /var/lib/cezar/deploy/cezar)
#           CEZAR_CLI        (default /opt/cezar/packages/cezar/dist/index.js)
#           CEZAR_URL        (default http://127.0.0.1:4321)
#           REPO_URL         (default: origin of REFERENCE_CHECKOUT, else the HTTPS GitHub URL)
#           REFERENCE_CHECKOUT (default /var/lib/cezar/loki-labs/cezar — read for its remote only)
#
# Run it as `cezar`, never as root: a root-owned file under /var/lib/cezar indexes fine and reads
# as a success while the services that must read it get EACCES forever.

set -uo pipefail

DEPLOY_CHECKOUT="${DEPLOY_CHECKOUT:-/var/lib/cezar/deploy/cezar}"
CEZAR_CLI="${CEZAR_CLI:-/opt/cezar/packages/cezar/dist/index.js}"
CEZAR_URL="${CEZAR_URL:-http://127.0.0.1:4321}"
# The clone URL is READ FROM A CHECKOUT THAT ALREADY WORKS, never hardcoded to a scheme.
#
# This defaulted to `git@github.com:MarcinWalendowski/cezar.git`, and the one box it exists for
# cannot use it: the `cezar` user has no SSH key for GitHub (`Permission denied (publickey)`,
# measured 2026-08-29) and reaches the remote over HTTPS through `gh auth git-credential`. The
# default is only consulted on the FIRST activation — the one where the deploy checkout does not
# exist yet — so it would have failed at the clone precisely when there was nothing to fall back
# on, which is the state prod-host was actually in. Asking a checkout that demonstrably
# fetches keeps this right on a box configured either way.
REFERENCE_CHECKOUT="${REFERENCE_CHECKOUT:-/var/lib/cezar/loki-labs/cezar}"
if [ -z "${REPO_URL:-}" ]; then
  REPO_URL=$(git -C "$REFERENCE_CHECKOUT" remote get-url origin 2>/dev/null) || REPO_URL=''
fi
REPO_URL="${REPO_URL:-https://github.com/MarcinWalendowski/cezar.git}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

die() { echo "activate-main: $*" >&2; exit 1; }
say() { echo "==> $*"; }

# A DEDICATED checkout, not the shared one. /var/lib/cezar/loki-labs/cezar is what task worktrees
# fork from, so `reset --hard` there is a bad habit even on the occasions it is harmless.
case "$DEPLOY_CHECKOUT" in
  */loki-labs/cezar) die "refusing: $DEPLOY_CHECKOUT is the shared checkout task worktrees fork from. Use a dedicated one." ;;
esac

if [ ! -d "$DEPLOY_CHECKOUT/.git" ]; then
  say "no deploy checkout at $DEPLOY_CHECKOUT — cloning"
  mkdir -p "$(dirname "$DEPLOY_CHECKOUT")" || die "cannot create $(dirname "$DEPLOY_CHECKOUT")"
  git clone "$REPO_URL" "$DEPLOY_CHECKOUT" || die "clone failed"
fi

cd "$DEPLOY_CHECKOUT" || die "cannot cd to $DEPLOY_CHECKOUT"

# Fail closed on a checkout that is mid-something. `reset --hard` through a rebase or a merge
# throws the operation away silently, and this script must never be the thing that lost work.
for marker in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD BISECT_LOG; do
  [ -e ".git/$marker" ] && die "refusing: $DEPLOY_CHECKOUT is mid-operation (.git/$marker). Finish or abort it first."
done
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "refusing: $DEPLOY_CHECKOUT has local changes. This checkout is for deploys only — nothing should ever edit it."
fi

say "fetching origin"
git fetch origin --prune --quiet || die "git fetch failed"
target=$(git rev-parse --verify origin/main) || die "cannot resolve origin/main"

live=$(curl -fsS --max-time 10 "$CEZAR_URL/api/v1/ready" 2>/dev/null \
  | grep -o '"deploy":{[^}]*}' | grep -o '"sha":"[0-9a-f]*"' | grep -o '[0-9a-f]\{7,40\}' | head -1)
if [ -n "$live" ]; then
  say "live=$live  incoming=${target:0:8}"
  if git cat-file -e "$live^{commit}" 2>/dev/null; then
    if git merge-base --is-ancestor "$target" "$live"; then
      say "nothing to do: the live sha already contains origin/main"
      exit 0
    fi
    behind=$(git rev-list --count "$live..$target")
    say "origin/main is $behind commit(s) ahead of what is running"
    git log --oneline "$live..$target" | sed 's/^/    /'
  else
    say "live sha $live is not in this checkout's object db — server-deploy will judge the relation"
  fi
else
  say "could not read a live sha from $CEZAR_URL/api/v1/ready — server-deploy will decide whether that is safe"
fi

if [ "$DRY_RUN" = 1 ]; then
  say "--dry-run: would reset to ${target:0:8}, npm ci, npm run build, then server-deploy. Stopping here."
  exit 0
fi

say "resetting to origin/main (${target:0:8})"
git reset --hard "$target" >/dev/null || die "git reset failed"

# `npm run build` AFTER the reset, always: the build stamp records a sha and a time, and
# server-deploy refuses to stage when the stamp disagrees with HEAD or is older than any tracked
# source file. Building first and resetting after is exactly the stale ship that gate exists for.
say "npm ci"
npm ci || die "npm ci failed"
say "npm run build"
npm run build || die "npm run build failed"

say "server-deploy --strategy=blue-green"
# The restart is expected and survivable: restart-continuation resumes in-flight runs, and the
# recover() sweep re-probes every parked manual-deploy handoff on the way back up, so no Resolve
# press should be needed afterwards.
node "$CEZAR_CLI" server-deploy --strategy=blue-green --source="$PWD" --sha="$(git rev-parse HEAD)" \
  || die "server-deploy failed — nothing was flipped, or use --rollback= to go back"

say "waiting for readiness"
deadline=$(( $(date +%s) + 120 ))
while :; do
  now=$(curl -fsS --max-time 10 "$CEZAR_URL/api/v1/ready" 2>/dev/null \
    | grep -o '"deploy":{[^}]*}' | grep -o '"sha":"[0-9a-f]*"' | grep -o '[0-9a-f]\{7,40\}' | head -1)
  case "$target" in "$now"*) say "live: $now == origin/main. Done."; exit 0;; esac
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep 3
done
die "the service did not report deploy.sha=${target:0:8} within 120s (it reported '${now:-nothing}'). Check: journalctl -u cezar.service -n 100"
