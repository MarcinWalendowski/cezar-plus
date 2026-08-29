# Brief: Logged-Out Fallback Landing

## Problem

The task was filed to land PR #11's logged-out-account fallback. The live record shows that
landing already happened: GitHub merged PR #11 as `c569aee8` on 2026-08-25, its branch tip was
`d385cd5c`, and both are ancestors of current `origin/main` (`2f0a50b2`, PR #12). The supplied
task context is therefore stale about the merge. What remains is to prove and ship the behavior on
the current deploy candidate: V6, V7, a real pool dispatch, deployment, and the corresponding
corpus correction.

The behavior itself is still important. A provider-less `pool:*` must select from viable Claude
and Codex accounts. A disconnected account must not be started or held, while a connected but
quota-limited account remains eligible for the existing hold path.

## Record already decided

- The authoritative decision is KB `notion-eb0154f0fbb7`,
  `notion-export/knowledge/notes/pool-dispatch-pinned-a-provider-so-a-logged-out-account-blocked-the-task--local.md:16-34`.
  A stored route supplies the run requirement; only runner-pinned steps narrow through
  `selectionFor`. Viability is per account, not per provider.
- The feature spec is
  `.ai/specs/2026-08-25-logged-out-account-fallback.md:3-8` on `origin/main`. It records
  implementation, PR #11 merge `c569aee8`, a green full gate on merged revision `d385cd5c`, and
  explicitly retains QA Needed until V6, V7, and deploy. Its three-tier contract is at
  `:18-25` and `:175-218`: runnable, waitable, disconnected.
- V6 is a production-host isolated-secondary-server E2E. It must not alter live credentials,
  must keep artifacts, and is required before the feature stops being QA Needed
  (`.ai/specs/2026-08-25-logged-out-account-fallback.md:2023-2082`, `:2267-2422`).
- V7 is a packed-artifact headless CLI E2E. It must run without `CEZ_DRY_RUN`, using auth shims,
  and must prove healthy fallback exits 0 on Codex while terminal cases exit 1 with their exact
  messages (`.ai/specs/2026-08-25-logged-out-account-fallback.md:2419-2504`).
- The corpus changelog was already corrected for landing but not deploy:
  `notion-3979979f15e0`,
  `notion-export/changelog/2026-08-25-account-fallback-instead-of-blocking-dispatch--local.md:1-49`.
  It says merged, records the prior green merged-tree gate, and says V6, V7, and deploy remain.
- The reported `config-api.test.ts` failure was pre-existing, then fixed separately by
  `fe4287c2` / `.ai/specs/2026-08-24-config-api-env-isolation.md`; the changelog says the merged
  rerun no longer failed. It must not be attributed to PR #11.

## Code involved now

Current code must be inspected from `origin/main`, not this worktree, which is stale at
`2fd01a16` and lacks the feature files.

- `packages/cezar/src/workspace/account-viability.ts:14-25` declares the three tiers;
  `:53-77` intentionally reads raw per-account auth cache so a provider-wide banner latch cannot
  mark a healthy sibling disconnected; `:117-150` makes a provider-less `pool:*` span every
  enabled profile-capable account; `:175-218` is the read-only gate decision.
- `packages/cezar/src/workspace/agent-route-select.ts:240-294` filters disconnected accounts from
  run-level pool selection and records which were skipped. `:299-331` keeps a runner-pinned step
  within its pinned provider.
- The implementation also changes `core/provider-auth.ts`, `server.ts`,
  `server/provider-action-gate.ts`, `workflows/run.ts`, `planner.ts`, `index.ts`, contract and web
  surfaces, plus account viability, gating, fallback, planner and packed-CLI tests. Source:
  `b18c0cbc` diff tree.

## Current integration state and risks

- `gh pr view 11` reports `MERGED`, branch `cez/90836867`, merge commit `c569aee8`, on 2026-08-25.
  `git merge-base --is-ancestor c569aee8 origin/main` and the equivalent check for `d385cd5c`
  both exit 0.
- The historical full gate proves the exact merged revision `d385cd5c`, not current
  `origin/main` `2f0a50b2`. Later main changes overlap `packages/cezar/src/workflows/run.ts`,
  `packages/cezar/src/index.ts`, and `packages/cezar/src/server/server.ts`. Run the full current
  gate before deploy and review the fallback behavior, not only textual merge status.
- Preserve all of these semantic boundaries: wildcard pools cross providers; explicit account
  fallback obeys its setting; a pinned step stays in its provider; mixed-provider workflows require
  every required dispatch to be placeable; disconnected is never selected or held; waitable is
  held rather than treated as disconnected; disabled providers remain terminal.
- No duplicate active todo was listed by `cezar todo list`. The feature spec names historical todo
  `21e18103-dd69-41de-8343-b6d401df75db`; its live tracker state was not found in the command
  output and should be checked before closure.

## Open questions for the next step

1. What exact current `origin/main` revision will be built and gated for the manual deploy?
2. Are the required dedicated Codex fixture home and the live service's Codex home available for
   V6? The spec makes absence a hard stop, not a fabricated fixture or a skip.
3. What deploy release ID results, so the corpus changelog can be corrected in place after a
   successful V6, V7, gate, deploy, and real dispatch?

## Verification plan

1. Update to current `origin/main`, then run the repository's full gate suite on that exact tree.
   Treat any failure as a stop and compare any suspected pre-existing failure against its merge
   base.
2. Execute V6 twice on `prod-host` with the isolated secondary server, retaining artifacts
   and quoting the recorded output. Confirm live-service baseline is unchanged.
3. Execute V7 via `npm run test:package` without dry-run auth short-circuiting, quoting its output.
4. Deploy only after gates and both E2Es pass. Perform the real `pool:*` dispatch proof with one
   disconnected account and a viable alternative. Correct the corpus changelog in place with the
   deployed release ID, then confirm KB indexing finds the correction.

## What was not found

No evidence was found that V6, V7, a post-merge live dispatch proof, or deployment has run. No
duplicate implementation work was found. The requested spec is not present in this stale worktree,
so all current-code citations above are explicitly against `origin/main`.
