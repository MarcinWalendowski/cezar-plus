# Brief — Meter the `document` step's fan-out after the rewritten prompt is deployed

**Task:** fb62168a-6972-49f0-afb4-ffe9c4ec9b01 · Phase 4 of
`.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md` · cezar todo
`221cf511-4e18-4f7b-ba46-e20edf956a16` (status `todo`, already `startedTaskId: fb62168a-…` — no
duplicate claim exists).

## Problem, in this repository's own terms

Phases 1–3 of the fan-out spec landed in one commit set: the `cez run stats` meter was fixed to
attribute sub-agent dispatches correctly (Phase 1), a per-step `peakContextTokens` metric was added
(Phase 2), and the `document` workflow step's fan-out instruction was rewritten into `context`'s
imperative voice (Phase 3, `packages/cezar/src/workflows/types.ts`). But that same run's own
`document` step executes **before** its own `deploy` step in the `spec-to-deploy` chain
(`context → spec → review-spec → implement → run-tests → commit-push → document → deploy`,
`types.ts:553-861`, pinned `types.test.ts:88`) — so the rewritten prompt could not reach the run
that wrote it. Two `document` baselines were recorded under the OLD prompt, with the FIXED meter:

| baseline run | own calls | trips | batch | `sub` | peak ctx |
| --- | ---: | ---: | ---: | ---: | ---: |
| `c10864d1-5dd1-4c03-b1ea-5443838c7347` | 38 | 38 | 1.00 | 0 | 141 783 |
| `7c2dd8f0-e53e-4e88-b4b3-b382c592bb12` | 45 | 44 | 1.02 | 0 | 167 235 |

Phase 4's job is to meter a `document` step that runs **after** the prompt-shipping deploy, and
record whatever the result is — including a falsification if `sub` is still 0.

## What the record already decided (with citations)

- **The rewritten prompt is merged to `main` and IS the deployed code, right now.** Commit
  `5ef7e6539` ("fix: the fan-out meter could not see a dispatch, and it billed the children to the
  parent", 2026-08-21) rewrote `types.ts` lines ~947–992 into the "go WIDE… run up to THREE
  sub-agents (`Task`)… READ-ONLY here" paragraph, confirmed by `git blame`. It is an ancestor of
  current `HEAD` `351626f5` (both the main checkout and this worktree sit exactly there, clean).
- **That build is what's actually running in production**, confirmed by three independent sources
  agreeing: `/opt/cezar-releases/deploy.json` (`current: "20260822T014340Z-351626f5"`, `sha:
  351626f5…`, `activatedAt: 2026-08-22T01:43:46.791Z`, `healthy: true`); `GET
  http://127.0.0.1:4321/api/v1/health` reporting the same release/sha/timestamp; and a direct grep
  of the **deployed** bundle `/opt/cezar/packages/cezar/dist/workflows/types.js`, which contains the
  rewritten strings verbatim at its own line 951/955, plus the Phase-3 spec-citation comment at
  line 918. This is not "the source says X" — the artifact actually serving requests was read
  directly.
- **The deploy that shipped it was task `e06f2169-7a55-4524-a035-7e5e8de8585b`** (todo `095a272e`),
  which finished and deployed at `2026-08-21T21:04:55Z` per its own handoff (commit `387ba439`,
  release `20260821T210309Z-387ba439`) — an *earlier* release than the current one
  (`20260822T014340Z-351626f5`, activated `2026-08-22T01:43:46.791Z`), which folded in further
  unrelated work (release-staging excludes, run-broker keepalive) on top without touching the
  fan-out prompt again. Either release carries the Phase 3 text; the current one is what's live.
- **`cez`/`cezar` are global wrapper scripts that always exec `/opt/cezar`'s deployed build**,
  regardless of invoking cwd (`/usr/local/bin/cez` → `exec node /opt/cezar/packages/cezar/dist/index.js
  "$@"`). So `cez run stats <runId> --repo <path>` reads a given run's NDJSON with the currently
  deployed (fixed) meter logic no matter which worktree it's run from — there is no need to build or
  run anything from this worktree to close this task; `--repo` just needs to point at the real repo
  (`/var/lib/cezar/loki-labs/cezar`) where `.ai/cezar/runs/` lives.
- **No run has yet produced a `document` step after the qualifying deploy.** One run,
  `d92e6b85-ae6f-4398-b923-3c76ccbb083f`, hit `document` at `2026-08-22T01:38:59.800Z` — 5 minutes
  **before** the `01:43:46` deploy, so it is still an old-prompt data point (consistent with, not a
  contradiction of, the baselines above; not usable for the A/B). As of the last check, four other
  chain runs were in flight, all started at/after the deploy, none yet at `document`:
  `bde0ec40…` (`context`, started `01:43:59.856Z`), `f2012c07…` (`context`, iteration 4, started
  `01:43:50.540Z`), `95d3c6f2…` (`spec`, iteration 5, as of `01:46:42.462Z`), `8ae78391…` (`context`,
  started `01:46:06Z`). None of these are this task; they are other in-flight worktrees/tasks
  progressing their own chains.
- **This task (fb62168a) is itself running the `spec-to-deploy` workflow** (handoff: "Workflow:
  spec-to-deploy"; the outer harness confirms "a chain of 8 agent steps" — matching
  `context/spec/review-spec/implement/run-tests/commit-push/document/deploy`, 8 named steps). So
  this run's *own* `document` step (step 7 of 8) will itself execute after the prompt is already
  live — it is a second valid candidate for the post-deploy `document` measurement, in addition to
  whichever of the four in-flight foreign runs gets there first.
- **The spec's own status log already documents a measurement trap that applies directly here**:
  *"an in-flight step cannot measure its own peak context, because the act of writing the
  measurement raises it… Only `ownToolCalls` and `sub` are safe to read from inside the step"*
  (`.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md:795-797`). It happened for
  real on that spec's own `document` step: read mid-step it showed `own 13 / peak ctx 104.7k` and
  by completion `own 29 / peak ctx 138.7k` — a 34k rise. Any run picked for this task's metering must
  be **fully finished** before `peakContextTokens` is read off it.
- **Exact CLI surface** (`packages/cezar/src/runs/stats-cli.ts:9,45`; table columns
  `stats.ts:973-987`): `cez run stats <runId> [--json] [--repo <dir>]`. Table now has more columns
  than the spec's example (`sleep`, `re-run`, `chars k` were added since) — read `sub` and `ctx k`
  for this task, `own`/`calls` for `ownToolCalls`.

## Which code is actually involved

- `packages/cezar/src/runs/stats.ts` — the fixed meter (`indexToolItems`, `childIds`/`dispatchIds`,
  `peakContextTokens`). Already deployed; nothing to change here for Phase 4.
- `packages/cezar/src/workflows/types.ts:936-1010` — the rewritten `document` prompt. Already
  deployed; nothing to change here either.
- `packages/cezar/src/runs/stats-cli.ts` — the CLI entry point actually invoked to close this task.
- `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md` — the status log this task's
  finding (positive or falsified) gets appended to, per the todo's third acceptance criterion. It
  already has a `## Status log — 2026-08-21` section with the exact table format to extend (see
  lines 601-797 of that file) — a `## Status log — 2026-08-22` (or an amendment to the existing
  "Phase 4, filed rather than pretended" section) is the natural target, not a new file.

## Prior decision this would contradict, if not careful

None found. This task is explicitly the follow-up the parent spec filed for itself
(`221cf511-4e18-4f7b-ba46-e20edf956a16`); there is no competing decision to reconcile. The one
constraint to respect is the "honesty" pattern the parent spec itself models repeatedly: report
directional/single-sample results as directional (R10: "Phase 4's A/B is a single uncontrolled
sample… Do not report a single A/B as proof of a magnitude"), and if `document` still shows `sub 0`,
write the falsification down rather than iterating the prompt more than once before recording what
was tried (§V4 step 5).

## Open questions the spec step will have to settle

1. **Which run to meter.** Two live candidates: (a) wait for one of the four already-in-flight
   foreign runs (`bde0ec40`, `f2012c07`, `95d3c6f2`, `8ae78391`) to reach and finish `document`, or
   (b) let this task's own chain proceed to its own `document`/`deploy` steps and meter this run
   after it fully completes. (b) is simpler (no cross-task monitoring) but this run cannot measure
   itself while still inside its own `document` step (see the mid-step-rises-34k trap above) — it
   would have to be metered from a *later* step in the same chain (e.g. from `deploy`, after
   `document` has closed) or from outside the run entirely once it's `done`. (a) risks picking a task
   whose `document` step content differs a lot in shape/size from either baseline (R10 already
   flags this as inherent, not new).
2. **Whether "no code change" is really the whole implementation.** This task's acceptance criteria
   are pure measurement + a spec-status update; there is a real question for the `spec` step whether
   `implement`/`run-tests`/`commit-push` should be near-no-ops (nothing to build) or whether the
   status-log edit itself is the "implementation" that flows through `commit-push`.
3. **Whether to also apply the parent spec's `directional` framing** (peak ctx < 130 000, own calls
   < 30, from §V4 step 4) as pass/fail thresholds here, or just report the raw numbers beside the
   baselines as the todo's acceptance criteria literally ask, without a threshold verdict.

## What I could not find

- No evidence yet of any run's `document` step executing after the `01:43:46Z` deploy — the
  measurement this task needs does not exist on disk yet as of this brief. It has to be produced
  (by waiting on an in-flight run, or by this run reaching its own `document` step) before it can be
  read.
- Did not confirm the **deployed** `dist/runs/stats.js` (as opposed to `dist/workflows/types.js`)
  still contains the Phase 1/2 meter fix by direct grep — only inferred from it being the same
  commit/release that carries the Phase 3 prompt text (verified in `main`/worktree source by a
  research agent). Low risk, same build, but not independently grepped in `dist`.

---

**Brief:** `.ai/specs/briefs/2026-08-22-document-fanout-post-deploy-metering.md`

**Four facts that most constrain the design:**
1. The rewritten `document` prompt (commit `5ef7e6539`) is **confirmed live in production right
   now** (release `20260822T014340Z-351626f5`, activated `2026-08-22T01:43:46.791Z`, verified by
   grepping the actual deployed `dist/workflows/types.js`) — there is nothing left to build or
   deploy for this task; it is pure measurement.
2. **No run has yet produced a post-deploy `document` step.** Four foreign runs are in flight and
   started after the deploy but haven't reached `document`; this task's own chain will also reach
   its own `document` step later. Either source works; neither exists yet.
3. `cez`/`cezar` are global wrappers that always run `/opt/cezar`'s deployed build regardless of cwd
   — `cez run stats <runId> --repo /var/lib/cezar/loki-labs/cezar` works from anywhere once a
   qualifying run exists.
4. The parent spec already learned the hard way that **a step cannot safely measure its own peak
   context while still running** (a live read rose from 104.7k to 138.7k by completion) — whatever
   run is chosen, it must be fully finished before `peakContextTokens` is read off it.
