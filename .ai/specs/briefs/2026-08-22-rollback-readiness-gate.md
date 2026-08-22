# Brief: rollback readiness gate — RETRY finds the work already done

**Task id:** f28edef5-ab80-42b8-929e-c92182c8a5ce
**Step:** 1/8, Gather the record (this document is a brief, not a spec; no code written here)

## The most important finding first

**This exact task already ran to completion in this exact worktree/branch, and the fix is live
at `HEAD`.** The dispatch note for this run says "There is no prior work to build on — start this
task from scratch," but that instruction was written for a *different* failed run (the
codex/`sonnet`-alias HTTP-400 run described in `.ai/specs/2026-08-22-failed-turn-reads-as-done.md`,
which produced zero commits). It is not true of this worktree. A full 8-step chain for this same
task id already executed here on 2026-08-22 and left:

- `packages/cezar/src/server-install/deploy-strategy.ts:203-303` — `runRollback` now takes
  `probeReady` in its effects, calls it after the post-flip restart, records `ready`/`failedAt` on
  the ledger and the `deploy.rollback` event, returns `serving: { releaseId, ready, detail? }`,
  and — if the probe fails and there's a healthy `before` release to fall back to — makes one
  try/caught restoration attempt (fixed HEAD, verified by direct read, not the prior brief's
  claim).
- `packages/cezar/src/server-install/release-cli.ts:71-123` — the CLI branches on
  `operation === 'rollback'` and prints a rollback-specific failure block (`Rollback FAILED: …`)
  distinct from the deploy failure block and from the plain `Deploy complete.` success line.
- Test coverage in `deploy-strategy.test.ts` (`describe('explicit rollback readiness gate', …)`,
  ~10 cases covering probe-pass, probe-fail, restoration success/failure, both-fail) plus
  `release-deploy.test.ts` and `release-cli.test.ts`.
- Commit `2f91de4b` — "fix: probe readiness after an explicit rollback instead of reporting
  success blind" — **is an ancestor of this worktree's current `HEAD` (`0b21e625`)**, verified with
  `git merge-base --is-ancestor 2f91de4b HEAD` (exit 0). It was merged to `origin/main` at
  `c31af208` and is present on `origin/main` per `git log origin/main`.
- Commit `190cf588` — "docs: record the rollback readiness gate fix in place" — also an ancestor
  of `HEAD`, also on `origin/main`.
- `git status` on this worktree: **clean**, nothing uncommitted.
- The controlling spec, `.ai/specs/2026-08-22-rollback-readiness-gate.md`, opens with
  `**Status: IMPLEMENTED, QA Needed.**` and names the commit, the gate results (`npm run
  typecheck`, `npm test` server-install package 389/389, `npm run build`, `npm run test:unit`
  44/44, all green), and confirms the full-repo `npm test` failures and the `test:package` e2e
  flake are pre-existing/host-load, not caused by this diff.
- The corpus already carries the closure: KB entry `specs-d65b1e0f0e15` mirrors that same status.
  `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:174` and `:1086` both carry a
  **`CORRECTED 2026-08-22 — 6497f002 is fixed`** marker in place (old text left below, per this
  repo's correction doctrine). `AGENTS.md:13` carries the matching in-place correction on the
  trap sentence that used to warn "a rollback never probes readiness."
- The handoff file (`$CEZ_HANDOFF_FILE`) has a full progress log for this task id through
  `context → spec → review-spec (×3) → revise (×2) → implement → run-tests → document`, ending
  "Committed `190cf588`, merged `origin/main` (`0b21e625`), pushed to `origin/main`."

So both acceptance criteria in the task description are **already met in code, at this worktree's
`HEAD`, on `origin/main`**:
- [x] `runRollback` probes `/api/v1/ready` after restart and returns `ok:false` when it does not
  come up — `deploy-strategy.ts:263-276` (readiness-fail branch, no healthy `before` to restore)
  and `:279-303` (restoration attempted, itself reported distinctly whether it succeeds or not).
- [x] Failure is reported distinctly from success — `release-cli.ts:86-123`, plus the ledger's
  `serving: { releaseId, ready, detail? }` field and the `deploy.rollback` event's `ready`/
  `failedAt` fields.

## What is genuinely NOT done yet

One thing, named explicitly by the spec's own status line and by its own "out of scope" section:

1. **Verification §5 of `.ai/specs/2026-08-22-rollback-readiness-gate.md` — the real
   `systemd --user` E2E** driving an actual rollback onto a release that does not come back up, on
   a scratch install, has **not been run**. Gates-green proves the unit-level behavior; it does not
   prove a real rollback on `prod-host` now fails closed. This is why the spec's status is
   "IMPLEMENTED, QA Needed" rather than "Done" — consistent with this repo's own doctrine (root
   `AGENTS.md` / `CLAUDE.md`: gates green is necessary, not sufficient; a user-facing change needs a
   real runtime E2E before it is Done).
2. The spec's own "Out of scope" section names two adjacent, deliberately-unfixed items, so a
   later step must not scope-creep into them: the deploy path's own auto-rollback restoration is
   *also* unprobed (`deploy-strategy.ts:167-171`, same species of bug, one branch over — spec says
   "file it as a todo," not fix it here) and bare `--rollback` argv parsing (todo `f97ddd39`,
   `index.ts:269`) is a separate, still-open defect this spec works around by always writing
   `--rollback=`.
3. No standalone tracker/todo row exists for `6497f002` anywhere (`cezar todo list` → "no todos
   filed"; confirmed again this run) — it was always an informal id living only in spec prose, so
   there is nothing to formally close in a tracker, only the in-place corrections already made in
   the two knowledge documents named above.

## What the record already decided (for a spec step, if the retry needs to re-derive anything)

- Controlling KB entry: `specs-594acc539b36` (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`),
  which filed this exact defect as todo `6497f002` (lines 110-117, 167-176) and records the P5
  decision that a cutover succeeds only after a real-port `/api/v1/ready` probe, and that
  post-flip readiness failure is fail-closed (§ P5, "recovering is not a more dangerous operation
  than the thing that broke," `deploy-strategy.ts:113-115`).
- `deploy.drained` is a terminal event name only, not an actual drain step — this was independently
  confirmed by controlled re-measurement in the same spec (lines 142-166) and is called out
  explicitly in this task's own dispatch note. Do not read it as a drain operation in any later
  step.
- D4 (a new decision made by the already-landed spec, not pre-existing): a failed manual rollback
  makes exactly one bounded, probed restoration attempt back to the last known-healthy `before`
  release, and reports that attempt's own outcome distinctly — see
  `.ai/specs/2026-08-22-rollback-readiness-gate.md` phase P3.

## Code actually involved (current HEAD, `0b21e625` / merge of `2778fd52` lineage)

- `packages/cezar/src/server-install/deploy-strategy.ts` — `runRollback` (`:203-303`),
  `runGatedDeploy` (`:130-201`, the pattern `runRollback` now mirrors), `DeployEffects`/
  `DeployEvent`/`DeployOutcome` types (`:44-107`).
- `packages/cezar/src/server-install/release-deploy.ts` — `probeReady`/`waitForReady`
  (`~:259-285`), the `ReleaseDeployHost` seam the CLI and tests both drive, `smokeBootRelease`'s
  isolation env (`~:208-237`), rollback wiring (`~:366-372`).
- `packages/cezar/src/server-install/release-cli.ts` — `ReleaseDeployCliOptions.rollback`
  (`:31-44`), `releaseDeployCommand` and its rollback-branch output (`:48-123`).
- `packages/cezar/src/server-install/deploy-strategy.test.ts`,
  `packages/cezar/src/server-install/release-deploy.test.ts`,
  `packages/cezar/src/server-install/release-cli.test.ts` — existing coverage for the above.
- `.ai/deploy-targets.json` — unrelated to this fix's own gate, but relevant background: the
  `deploy` step's post-condition probes are what would catch a *deploy* landing broken; they do
  not probe `--rollback` at all, which is consistent with why this defect needed its own fix
  rather than being caught by the deploy gate.
- `packages/cezar/scripts/deploy-e2e-probe.mjs` — the existing continuous-client E2E harness for
  the *deploy* cutover (non-disruptive-self-deploy spec's own acceptance test), not the rollback
  path. Verification §5 of the rollback spec designs its own scratch-install recipe rather than
  reusing this script, per that spec's Verification section (not re-read line-by-line this pass;
  see the spec file itself).

## Duplicate / in-flight work check

- `git worktree list` shows 12 other active `cez/*` worktrees plus a handful of scratch trees
  under `/tmp` and `/var/lib/cezar`/`/var/tmp`. None of their branch names or HEAD shas reference
  this defect; nothing else currently touches `deploy-strategy.ts`'s rollback path per this pass
  (not independently re-diffed against every worktree — flagging as unconfirmed rather than
  asserting a full negative).
- `cezar todo list` — no todos filed at all, so no separate in-flight todo row exists for this
  defect or a duplicate of it.
- No other spec in `.ai/specs/` (30 most-recent listed by mtime) names `runRollback` readiness
  besides `2026-08-22-rollback-readiness-gate.md` itself and its controlling parent
  `2026-08-19-non-disruptive-cezar-self-deploy.md`.

## Open questions the next step should settle

1. **Given the fix is already implemented, tested, committed, pushed, and documented — is this
   run's remaining job to (a) re-verify/no-op given nothing has changed, or (b) actually execute
   the one missing piece, Verification §5's real scratch-install E2E, and move the spec from "QA
   Needed" to "Done"?** The task's acceptance criteria as literally written are satisfied by
   existing code; the repo's own Definition-of-Done doctrine (root `CLAUDE.md`/`AGENTS.md`) says
   gates-green code is not yet "Done" for a user-facing change until a real runtime E2E has run —
   and that E2E is exactly what's still missing here. The next step should decide explicitly
   rather than silently redoing already-landed implementation work.
2. If the answer is "run the E2E," the existing spec already designed that recipe (Verification
   §5) after three rounds of review that fixed unit-vs-system-unit mismatches, isolation-env gaps,
   and a restoration-unit-GC trap — a spec step should read and reuse it rather than re-deriving
   from scratch, since it was independently re-verified against code three times already (per the
   handoff log's step-3 re-review entries).
3. If nothing new needs to change in `deploy-strategy.ts`/`release-cli.ts`, this run's `spec` step
   should say so plainly and the chain's `implement` step becomes a no-op-and-verify rather than a
   rewrite — writing redundant code over an already-correct, already-tested implementation would
   itself be the kind of drift this repo's "changing a mechanism that already works" doctrine
   warns against.

## Not found, stated rather than invented

- No corpus/tracker row for `6497f002` beyond the two in-place-corrected spec/AGENTS.md mentions —
  confirmed again this pass, matches the prior brief's finding.
- Did not re-run `npm test` / `npm run typecheck` in this step (gather-only; the prior run already
  measured them green against this same code and `git status` is clean, so nothing has changed
  since that measurement).
- Did not independently re-diff every other active worktree against this defect; the duplicate
  check above is a targeted grep/list pass, not an exhaustive one.
