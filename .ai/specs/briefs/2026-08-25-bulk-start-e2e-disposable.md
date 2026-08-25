# Brief: bulk-start disposable E2E

**Task:** `E2E disposable: 480e0282 #1`
**Step:** Gather the record only, 2026-08-25

## Headline

This is not a new feature request. `480e0282` identifies the prior bulk-start run, whose implementation commit is `7932cf4d83ff6a4f263ae7181ec0d8e9fa81ea7f` (`feat: bulk start filed tasks`). Its explicitly outstanding work is the production browser E2E with disposable filed todos, cleanup, and a corpus outcome. The feature must not be reimplemented or re-specified as a server bulk endpoint.

There is a material checkout-state constraint: this worktree's `HEAD` is `b3d3a44c`, and `7932cf4d` is not an ancestor of it (`git merge-base --is-ancestor 7932cf4d HEAD` exits 1), although it is an ancestor of `origin/main` (`git merge-base --is-ancestor 7932cf4d origin/main` exits 0). The next step must establish the live deployed SHA and use a checkout containing the feature before exercising it.

## Problem in repository terms

The global `/tasks` Filed board now supports selecting visible, project-qualified todo rows and starting them serially without navigating away. The release gates passed, but cezar's definition of done requires a real runtime/browser E2E for user-facing behavior. The required proof is two disposable todos started as one batch, with exactly two resulting runs, unchanged browser location, retained artifacts, and complete cleanup. Gates alone are not that proof. [KB `notion-cfbbd6d2ebda`; `domains/cezar.md`, “Five-command gate” and runtime-E2E doctrine]

## What the record already decided

| Decision | Citation | Consequence |
| --- | --- | --- |
| Bulk start is client orchestration, not a new server bulk API or persisted model. | `7932cf4d:.ai/specs/2026-08-24-bulk-start-filed-tasks.md:39-50`; `:72-74` | Do not add an API, compatibility layer, bulk archive, or shift-click behavior. |
| Selection is keyed by `${projectId}:${todo.id}` and only filtered, sorted, rendered rows can start. | `7932cf4d:.ai/specs/2026-08-24-bulk-start-filed-tasks.md:18-25,53-70`; `7932cf4d:packages/web/src/routes/global-tasks.tsx:790-802,1522-1530` | Test cross-project identity and the visible-page boundary. Hidden/filter/pagination-selected entries must not be started. |
| Starts are serial, later starts continue after a failure, and batch start does not navigate. | `7932cf4d:packages/web/src/routes/global-tasks.test.tsx:1500-1586` | The E2E needs an unchanged `/tasks` assertion and exactly two successful start responses. |
| Production QA must create two disposable todos, capture their IDs, start the batch, verify two runs, then cancel/delete by captured ID. | `/var/lib/cezar/loki-labs/cezar/.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md:803-950` | Cleanup must be `finally`-safe and bounded to the recorded fixture IDs, never a broad delete. |
| Artifacts cannot live in a disposable worktree, and loopback verification is not proof of the Cloudflare Access edge. | `/var/lib/cezar/loki-labs/cezar/.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md:252-255,817-821,1091-1095` | Name a stable artifact path and separately decide the auth-edge coverage claim. |
| The original run recorded gates green but P4 deploy, P5 production browser E2E, and P6 corpus status unresolved. | `/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/480e0282-a967-4936-a12e-3c4e56450586.handoff.md:18-25,30-140` | Do not mark the feature verified or the corpus requirement complete. |

## Code and test surface

- `7932cf4d:packages/web/src/lib/filed-tasks.ts` owns Filed-table selection helpers.
- `7932cf4d:packages/web/src/routes/global-tasks.tsx:790-802,1522-1530` derives selected visible rows and calls `startWorkspaceTodo` serially.
- `7932cf4d:packages/web/src/routes/global-tasks.test.tsx:1464-1586` covers cross-project posts, unchanged navigation, hidden/paginated exclusions, and continuation after a failure.
- The existing disposable-browser fixture precedent is `7932cf4d:packages/web/e2e/backlog-composer.e2e.ts:53-143`: isolated `CEZ_HOME`, two temporary git repos, a dry-run server, browser screenshots, and unconditional teardown.
- `.ai/scripts/e2e.sh:1-72` is the existing browser-suite entry point; `.ai/scripts/test-env-up.sh:50-64` supplies dry-run and isolated state for the shared environment.

## Related work and duplicates

The tracker in this checkout reports no open todos. The prior parent todo was `5e9bb266-1b61-447b-bdc5-aad19708513f`, and the two exact fixture children have tombstones in the original checkout's `.ai/cezar/todos.json:3589-3603,3697-3729`; they are not an active duplicate. The prior run still has a live lease at `/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktree-leases/480e0282-a967-4936-a12e-3c4e56450586.json`, so it must not be assumed abandoned.

No corpus knowledge entry for bulk start was found. The source of truth currently consists of KB records `specs-85e563c425df` (the original brief) and `specs-06402c11d9f7` (the feature spec), plus the handoff and commit cited above. No retained screenshot or video for the required E2E was found.

## Open questions for the next spec or QA step

1. Is the live deployment at `7932cf4d` or a descendant, and which clean checkout may safely provide the browser harness?
2. Does the task require loopback production verification only, as the existing recipe describes, or a separate Cloudflare Access edge proof?
3. Which stable, non-worktree artifact directory is approved for screenshots/video, and how will it be retained?
4. Has the corpus-proposal application path become available? The original run could propose a record but could not verify that the KB indexed it.

## What was not found

The title itself contains no functional requirements beyond the fixture convention. No code or matching spec exists in this stale worktree, and no standalone bulk-start E2E or prior production artifacts were found. Those absences are why this brief scopes the next action to verification of the already-built feature, subject to deployed-SHA confirmation.
