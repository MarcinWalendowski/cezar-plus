# Brief: rollback readiness gate

**Task id:** f28edef5-ab80-42b8-929e-c92182c8a5ce  
**Step:** 1/8, Gather the record (this document is a brief, not a spec)

## Problem, in this repository's own terms

The blue-green deploy strategy claims that every deploy step is fail-closed and that rollback is
no more dangerous than deploy (`packages/cezar/src/server-install/deploy-strategy.ts:104-115`).
The explicit rollback path does not uphold that guarantee.

`runRollback` resolves a requested or previous release, flips `/opt/cezar`, updates the ledger,
restarts the service, emits `deploy.rollback`, and unconditionally returns `{ ok: true }`
(`packages/cezar/src/server-install/deploy-strategy.ts:203-217`). Its effect type deliberately
omits `probeReady`, so it cannot check the restarted release. The CLI consequently prints
`Deploy complete.` and exits 0 even when the selected release never answers `/api/v1/ready`
(`packages/cezar/src/server-install/release-cli.ts:80-92`).

The normal deploy path already has the missing gate. After restart it calls `probeReady`; on
failure it marks the candidate unhealthy, flips back, restarts, emits a readiness rollback event,
and returns `ok:false` with detail (`packages/cezar/src/server-install/deploy-strategy.ts:147-190`).
It only marks the release healthy, prunes, emits `deploy.drained`, and returns success after the
probe passes (`packages/cezar/src/server-install/deploy-strategy.ts:192-199`). There is no drain
effect in `DeployEffects` (`packages/cezar/src/server-install/deploy-strategy.ts:64-84`):
`deploy.drained` is only the terminal event name.

## What the record already decided

- The controlling KB entry is `specs-594acc539b36`, backed by
  `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`. It records this exact defect as
  todo `6497f002`: explicit rollback flips and restarts without probing, so a dead target still
  prints `Deploy complete` (lines 167-176). The same passage explicitly says
  `deploy.drained` is not a drain operation.
- The production observation is real but did not include a failed release. The spec records five
  cutovers on `prod-host`, including three explicit rollback flips (lines 120-124). Those
  rollbacks happened to be healthy. The record therefore proves the missing check, not the dead
  target outcome.
- A nearby suspected drain defect was refuted. Controlled retry showed the connection refusals
  were intermittent client behavior, not evidence that rollback uniquely skipped a drain
  (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:162-165`). This task must not expand
  into drain mechanics.
- P1 decided that rollback is an atomic symlink flip plus restart
  (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:345-358`). P5 decided that a cutover
  is successful only after the real-port `/api/v1/ready` gate, and that post-flip readiness
  failure is fail-closed (`:502-518`). The readiness endpoint is the deep gate, distinct from
  `/health`, covering store load, project stores, workspace configuration, and backend detection
  (`:627-635`).
- Ledger semantics depend on that proof: `healthy: true` is set by the post-flip readiness probe
  (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:570-580`). Reporting manual rollback
  success without the probe contradicts the ledger and readiness decisions. This change restores
  the prior architecture rather than replacing it.
- Analytics already define `deploy.rollback` with `reason` and `failedAt`
  (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:786-795`). The existing event and
  outcome types can represent `failedAt: 'readiness'`
  (`packages/cezar/src/server-install/deploy-strategy.ts:34-57,94-102`), although the event name
  currently conflates a requested rollback with an automatic rollback caused by a failed deploy.
- `3f4e9c33` introduced `runGatedDeploy` and `runRollback` together. `git blame` attributes the
  current functions to that commit, and no later commit on this branch changed the explicit
  rollback path. A separate `1343c7cd` exists only on `cez/312fe333`, is not an ancestor of HEAD,
  and is not current precedent.
- The same spec contains stale and later evidence about automatic rollback. Lines 1071-1079 say
  boot-then-fail remained unproven, while lines 994-1003 and 1175-1178 record the later real proof.
  That contradiction concerns automatic rollback only. This task concerns explicit
  `runRollback`, which remains ungated.
- The curated domain record at
  `/var/lib/cezar/loki-labs/notion-export/domains/cezar.md` contains production and shipping
  context but no separate rollback-readiness decision. Exact KB searches for `runRollback` and
  `6497f002` found only the controlling spec and an unrelated brief. No standalone corpus task or
  knowledge note was found.

## Code actually involved

- `packages/cezar/src/server-install/deploy-strategy.ts:203-217`: `runRollback`, its narrowed
  effects type, unconditional success, and primary fix site.
- `packages/cezar/src/server-install/deploy-strategy.ts:147-199`: the existing restart, readiness,
  automatic rollback, health marking, prune, and event ordering that constrains the manual path.
- `packages/cezar/src/server-install/release-deploy.ts:116-128,167-176`: `ReleaseDeployHost`
  already exposes the real `probeReady(port)` effect.
- `packages/cezar/src/server-install/release-deploy.ts:258-274`: the shared probe issues a
  five-second loopback request to `/api/v1/ready` and preserves HTTP, body, and fetch failure
  detail. `waitForReady` retries but is private and currently used only for smoke boot
  (`:245-250,276-285`); the ordinary post-restart deploy gate uses one `probeReady` call.
- `packages/cezar/src/server-install/release-deploy.ts:366-371`: the rollback caller passes only
  restart, emit, and now, then maps `outcome.ok` and `outcome.detail` into the command result.
  Normal deploy wires the existing probe at `:390-405`.
- `packages/cezar/src/server-install/releases.ts:155-176`: activation makes the outgoing current
  release `previous`, and `markHealthy` is available. After a failed explicit rollback, the
  previously healthy release is therefore addressable, but the dead requested target is already
  current unless another flip occurs.
- `packages/cezar/src/server-install/release-cli.ts:80-92`: all failures are currently called
  `Deploy failed`; any result with `rolledBackTo` also prints that the named release is serving;
  all successes print `Deploy complete`. Reusing those fields for failed explicit rollback could
  make the failure message itself false.
- `packages/cezar/src/server-install/release-cli.ts:95-109`: detached `--follow` waits for the
  transient unit to become inactive and returns 0 without deriving the deploy result. This may be
  outside the narrow fix, but a spec must not claim failure reporting across every mode unless it
  settles this behavior.

## Existing coverage and verification precedent

- Explicit rollback tests cover only a healthy flip/restart and missing-target refusal
  (`packages/cezar/src/server-install/deploy-strategy.test.ts:183-203`). They do not assert a
  probe, restart-before-probe order, a failed outcome and detail, ledger health, recovery, or a
  distinct failure event.
- The integration seam pins healthy rollback, one restart, and no staging
  (`packages/cezar/src/server-install/release-deploy.test.ts:181-196`) but does not count
  `probeReady` or simulate its failure.
- Normal deploy tests provide the patterns: exact stage/smoke/restart/probe order
  (`deploy-strategy.test.ts:55-82`), readiness failure with detail and a second restart
  (`:133-163`), and command-result error propagation
  (`release-deploy.test.ts:136-153`). No unit test was found for `releaseDeployCommand` wording or
  exit codes.
- The prior runtime verification polls `/api/v1/ready` at 10 requests per second across flip and
  automatic rollback (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:701-726`). A future
  spec should require a real explicit rollback to a controlled non-ready release, with artifacts,
  before calling the user-facing behavior verified.

## Duplicate and in-flight work check

`cezar todo list` returned no todos for this project. Repo and corpus searches found `6497f002`
only in the controlling spec and an unrelated brief that enumerates known deploy defects. No
duplicate implementation or current branch was found. The historical todo id remains the record
of the defect even though it is not present in the current tracker listing.

## Open questions the spec must settle

1. On failed explicit rollback readiness, does cezar leave the requested dead release current and
   only return `ok:false`, or fail closed by flipping back to the release that was current before
   the request and restarting again? The acceptance criteria require only `ok:false`; the existing
   architecture argues for restoration, but the record does not explicitly decide it.
2. If restoration is attempted, must cezar probe the restored release too? P5 proves the candidate
   before success, but does not explicitly define the terminal state when both the requested target
   and the restoration target fail readiness.
3. Should the failed requested target be marked `healthy:false`, matching normal deploy readiness
   failure? This affects future selection and ledger truth, but the acceptance criteria do not say.
4. What result and event fields distinguish successful manual rollback, failed manual rollback,
   and automatic rollback after failed deploy without widening published status unions? Existing
   `failedAt:'readiness'`, `reason`, and `detail` may suffice, but the spec must remove the CLI's
   false `the previous release is serving` possibility.
5. Does distinct reporting apply only to the direct command result, or also to detached
   `--follow`? The latter currently returns 0 when the transient unit merely becomes inactive.
6. Should explicit rollback use the same single five-second probe as normal post-restart deploy,
   or retry through `waitForReady`? Consistency favors the existing single probe; changing retry
   semantics would broaden the task and needs an explicit decision.

## Facts that most constrain the design

- The readiness capability already exists end to end; only the rollback effect type and caller
  wiring omit it.
- A false result is already propagated to exit 1, but current wording and `rolledBackTo` semantics
  can falsely claim a dead target is serving.
- The old healthy release becomes `previous` during activation, so fail-closed restoration is
  mechanically available, but it is not required by the task text and must be decided in the spec.
- `deploy.drained` is not a drain step, and the production connection-race observation was already
  refuted as a rollback-specific mechanism issue.
