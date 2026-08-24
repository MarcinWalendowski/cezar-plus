# Brief: bounded broker retry — re-check finds the work already shipped

**Task:** `9e110775-a190-4d91-94aa-da4791752b7e`
**Step:** Gather the record only (workflow step id `context`, "step 1 of 8" in `spec-to-deploy`).
No spec, code, or test was written or changed in this step.

## Why this brief exists as a second document

A brief for this exact task already exists: `.ai/specs/briefs/2026-08-22-bounded-broker-retry.md`
(KB `specs-855ce6ed75c2`), written earlier today by an earlier `context` step of this same run. This
document does not replace it — it records what changed since: **the work that brief scoped has, in
the time between that step and this one, been designed, implemented, tested, merged to
`origin/main`, and documented.** The one-sentence version: **there is nothing left to design.** The
only step of the 8-step chain not yet executed is `deploy`.

## What already happened, in order, with citations

1. **Brief** — `.ai/specs/briefs/2026-08-22-bounded-broker-retry.md` (KB `specs-855ce6ed75c2`),
   21:18:24Z, correctly scoped the remaining defect as workflow-boundary retry classification, not
   the timeout budget or the scope-unit collision (both already fixed and production-verified:
   commits `8e20dfbf`, `0883256b`; KB `notion-d660e1080ec2`, `notion-8c1963ca2c16`; spec
   `.ai/specs/2026-08-22-broker-scope-unit-name-collision.md`, Status: `Implemented`).
2. **Spec** — `.ai/specs/2026-08-22-bounded-transient-broker-retry.md`, written 21:32:15Z, revised
   twice after review (verdicts: REVISE ×2, then approved). Final design: `BrokeredSession.giveUp`
   rejects a `BrokerUnavailableError { everAnswered }` only on the "neither spawnFailed nor
   launchFailure" branch (the case that used to be a bare, unclassified `Error`); the run engine
   retries **exactly once**, only when `!everAnswered`, and fails fast otherwise.
3. **Implementation** — commit `2258aee0` ("fix: retry a broker step once when it never answered,
   not when it was never started"), merged to `origin/main` at `541bc76d`, now an ancestor of
   current `origin/main` HEAD `ad7a0a41`. Files: `packages/cezar/src/core/brokered-session.ts`
   (`BrokerUnavailableError`, `isRetryableBrokerLaunch`, `everAnswered`), `packages/cezar/src/core/claude-cli-runner.ts`,
   `packages/cezar/src/workflows/run.ts` (`reapAbandonedColdLaunch` at ~L344; three call sites of
   `isRetryableBrokerLaunch` at ~L3894, ~L4475, ~L5366), plus `packages/cezar/src/workflows/broker-retry.test.ts`.
4. **Gates** — `npm run typecheck` EXIT=0; `npm test` 531 passed / 3 failed, all 3 in files this
   diff never touches (documented load-sensitive flakiness — `catalog.test.ts`, `cli-wiring.test.ts`,
   `project-context.test.ts`), per the handoff's run-tests log and the spec's own gate record.
5. **Document step** — `.ai/specs/2026-08-22-bounded-transient-broker-retry.md` line 3 now reads
   `Status: Implemented (code) — QA Needed (production E2E ... pending the next deploy)`; a
   project-scope KB decision entry was written (`decisions/2026-08-22-bounded-broker-retry-shipped.md`,
   per the handoff); commit `40a9be82` ("docs: record bounded broker retry shipped state") is on
   `origin/main`, merged forward as `ad7a0a41` and pushed.

**Both `REMAINING` acceptance criteria from the task are met, independently re-verified against
the code on this branch (HEAD `ad7a0a41`), not just claimed by the handoff:**

- *"a step whose session dies on a genuinely transient broker/control-channel error is retried
  ... and the retry and its reason are visible on the thread"* — CONFIRMED. `run.ts:3894-3910` and
  `run.ts:4471-4498` both reap the abandoned cold launch (`reapAbandonedColdLaunch`) and re-drive the
  step, and both append a `type: 'note'` event plus a `type: 'metric'` event
  (`name: 'run.step.retried_cold_broker', attempt: 2`) to the run's persisted event thread.
- *"the retry is bounded and does NOT mask a permanent failure ... must fail fast, with its
  cause"* — CONFIRMED. Bounded to exactly one attempt per step (`retriedColdBroker` flag at the
  3894 site; a `Set<string>` keyed by step id at the 4475 site). The never-started case is
  distinguished in `claude-cli-runner.ts:1104-1111` (`brokerNeverStarted`): if no `meta.json` was
  ever written, it returns a **plain `Error`**, not a `BrokerUnavailableError`, so
  `isRetryableBrokerLaunch` returns `false` and the run fails immediately with the launcher's real
  cause quoted, spending none of the retry budget.
- **Test coverage** — `packages/cezar/src/workflows/broker-retry.test.ts`, `describe('bounded cold
  broker retry')`: `'retries one cold broker once and makes the reason visible'`,
  `'fails a never-started broker immediately without spending the retry'`,
  `'relaunches a continuation broker with the same backend session context'`. All three exist and
  assert the behavior above (verified by direct read, not test-run output alone).

## One narrow, now-closed documentation gap

Before this step's verification, the KB's indexed copy of the spec (`specs-bbd072143122`) already
read `Implemented (code) — QA Needed`, but the on-disk file at that path still read `Status:
Proposed` as of `origin/main` `541bc76d` — a KB correction that had not yet been written back to the
file it describes. **This gap is now closed**: the `document` step (§ above, commit `40a9be82`)
updated the file itself, and the KB entry and the file agree as of `ad7a0a41`. Noted here only so
the next reader doesn't rediscover the same drift and doesn't need to fix anything.

## The one open, unrelated finding: this run's own chain dispatch is not honoring its resume point

Not part of the broker-retry design and not something this step should act on, but material to
whoever reads this run next: the run's ndjson (`/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/9e110775-....ndjson`)
records, after `commit-push` completed and `document` had started (line ~3146), a restart lifecycle
event that correctly computed `"chain re-queued at step \"document\" (2 of 8 step(s) remaining)"`
(line ~3163) — but the dispatch that followed it re-entered step id `context` (this step's own id,
per `SPEC_TO_DEPLOY_WORKFLOW` in `packages/cezar/src/workflows/types.ts`, 8-step order `context →
spec → review-spec → implement → run-tests → commit-push → document → deploy`) instead, twice
(iterations 2 and 3 at 22:47:03Z and 22:48:20Z — this document is being written during iteration 3).
Concurrently with this step running, `document` did in fact complete (handoff progress-log entry
timestamped 22:50Z, § above) — so the mis-dispatch did not lose the work, but it is unexplained
(this run's `.broker.log` is empty across the relevant window) and re-ran an already-finished step
at least twice. Worth a look by whoever owns `spec-to-deploy`'s restart-continuation path
(`.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md` is the existing spec for that
mechanism) — but it is a cezar-orchestrator bug, not a broker-retry defect, and out of scope here.

## What remains for this task

Per the workflow order above, only **step 8, `deploy`**, has not executed. `origin/main` HEAD
`ad7a0a41` already contains everything: the retry fix, its tests, and its documentation. Deploy is
gated by `.ai/deploy-targets.json`'s two probes (backend `GET /api/v1/ready` serving this HEAD or a
descendant of it; UI `GET /` serving the matching built bundle) per `AGENTS.md`'s standing
commit/push/deploy authorization for this repo. No further design work, spec revision, or
implementation is indicated.

## What I could not determine

- The root cause of the step-`context` mis-dispatch during chain restart (see section above) — the
  available artifacts (ndjson, empty broker.log) show the symptom, not the mechanism.
- Whether the production E2E the spec's `QA Needed` status is waiting on (steps 1-5 of the spec's
  own Verification section, exercised on `prod-host` after a real deploy) has been run before
  this brief was written — nothing in the handoff or KB claims it has; it is explicitly gated on
  "the next deploy," which per this brief has not yet happened.
