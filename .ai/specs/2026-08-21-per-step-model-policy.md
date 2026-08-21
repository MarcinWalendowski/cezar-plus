# Per-step model policy for `spec-to-deploy`

**Status:** implemented (2026-08-21)

## TLDR

Every step of the default `spec-to-deploy` workflow now names its own model. Owner
instruction 2026-08-21: *"writing spec should be sonnet, review spec should be opus, then
all the rest should be sonnet again — change it right now for everything."* So:
`review-spec` runs on **opus**, and the other seven steps (`context`, `spec`, `implement`,
`run-tests`, `commit-push`, `document`, `deploy`) run on **sonnet**. "Everything" includes
the runs that were already on the board, whose frozen `workflowDef` had to be patched in
place — see Phase 2.

## Problem

Before this change no built-in workflow step carried a `model`, so every step of every run
fell through to `input.model` — the run-level model picked in the composer — and, when that
was empty (it was empty on all 18 live runs), to whatever the `claude` CLI defaults to.
One model for the whole eight-step chain.

That is the wrong shape for this chain. The steps are not the same kind of work. Reviewing
a spec is the last checkpoint before code is implemented, committed, pushed and deployed;
it is judgement work and it is cheap, one read-only pass over one file. Writing the spec,
implementing it, running gates, committing and deploying are construction work against an
artefact that already exists. Paying opus rates for the seven construction steps to get
opus on the one judgement step is the trade nobody chose — it just fell out of there being
a single knob.

Two facts make this a code change rather than a settings change:

- `defaultModels` (workspace config) is resolved **client-side**, in the web composer
  (`packages/web/src/routes/new-task.tsx`). The server never applies it. It cannot express
  a per-step policy and it does not reach runs created any other way.
- A run FREEZES its workflow definition at creation (`startRun` →
  `store.updateRun(run.id, { workflowDef: workflow })`), and `reviveWorkflow` prefers that
  frozen copy over the catalog. So editing the built-in reaches new runs only.

## Solution

Name the model on the step, where the policy actually lives.

`runAgentStep` resolves a step's model as `step.model ?? input.model` (guarded by
`agentModelsLocked`), so a per-step `model` is authoritative: it wins over the composer's
pick. That is deliberate here — the point of the instruction is that the chain's model
mix stops depending on what someone selected in a dropdown — but it is the one real
consequence of this change and it is called out in Risks.

Two named constants carry the policy so the intent survives the next edit:

```ts
const SPEC_TO_DEPLOY_STEP_MODEL = 'sonnet';
const SPEC_REVIEW_MODEL = 'opus';
```

Both are ids from `KNOWN_PRESETS_BY_RUNNER.claude`, so `normalizeModelForBackend` resolves
them and `modelConflictsWithRunner` does not refuse them.

## Architecture

Model resolution, unchanged, with the new input:

```
step.model  ──┐
              ├──► agentModelsLocked(repoRoot) ? undefined : (step.model ?? input.model)
input.model ──┘                          │
   (composer)                            ▼
                            normalizeModelForBackend(backend, model)
                                         │
                                         ▼
                                  backend wire form
```

Nothing about the resolution order changed. The only new thing is that
`SPEC_TO_DEPLOY_WORKFLOW`'s steps now populate the left input.

## Phases

**Phase 1 — the definition (future runs).** Add `model` to all eight steps of
`SPEC_TO_DEPLOY_WORKFLOW` in `packages/cezar/src/workflows/types.ts`. Every run created
after the deploy freezes the new def at creation and needs nothing else.

**Phase 2 — the runs already on the board (current tasks).** 17 queued + 1 running run in
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs.json` carry a frozen def with no models.
Patch `workflowDef.steps[].model` on every non-terminal run in place. `RunStore` holds
runs in an in-memory `Map` loaded once at construction and rewrites the whole file on
every save, so a live-server patch would be clobbered on the next write: the service is
STOPPED for the patch and started again after it.

## Data models

`workflowStepSchema.model` is `z.string().optional()` and already round-trips through
`workflowDefSchema` (the store parses `workflowDef` against it with `.catch(undefined)`).
No schema change. A patched run record is the same shape it was, with `model` present on
each step.

## API contracts

None changed. `GET /api/v1/workflows` already serializes each step's `model`, so the
cockpit's workflow view reports the policy without a UI change.

## Risks

- **The composer's model picker becomes inert for `spec-to-deploy`.** `step.model` wins,
  so picking opus for a task no longer makes the chain opus. This is the instruction's
  intent, but it is a real loss of a control that worked yesterday. The escape hatch that
  survives: a repo may still override the whole built-in by shipping
  `.ai/cezar/workflows/spec-to-deploy.yaml`, and `agentModelsLocked` still voids every
  per-step model at once.
- **A frozen def cannot be patched safely under a live server.** Addressed by stopping
  the service for the write (Phase 2). Getting this wrong is silent: the file looks
  patched until the next save overwrites it from memory.
- **Model ids drift.** `sonnet`/`opus` are aliases the `claude` CLI resolves, not pinned
  version ids — deliberately, so the chain follows the account's current tier. If the CLI
  ever stops accepting a bare alias, `normalizeModelForBackend` fails loud rather than
  substituting a default.

## Verification

1. **Unit (automated).** `packages/cezar/src/workflows/types.test.ts` asserts the policy
   with a floor: the step list is compared by identity (so a rename or a dropped step
   fails rather than passing vacuously), every step's model is asserted, and `opus` is
   asserted to be on `review-spec` and nowhere else. Both ids are asserted to be members
   of `KNOWN_PRESETS_BY_RUNNER.claude`, so a typo cannot pass.
2. **Gates.** `npm run typecheck`, `npm test`, `npm run build` green on the prod box under
   the scrubbed environment AGENTS.md § Validation prescribes.
3. **Runtime, on the record itself.** After the deploy and the Phase 2 patch, re-read
   `runs.json` and assert every non-terminal run's `workflowDef` reports
   `review-spec: opus` and sonnet everywhere else — and that the count of runs carrying
   the policy equals the count of non-terminal runs (the floor that catches a partial
   patch).
4. **In-band.** `GET /api/v1/workflows` on the deployed server reports the pinned models
   for the built-in `spec-to-deploy`, which is the same def a new run will freeze.
