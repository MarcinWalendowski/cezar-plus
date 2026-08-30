# Brief: Backlog composer current state

**Task:** Finish and deploy Backlog composer  
**Date:** 2026-08-29  
**Scope:** record gathering only. No specification, implementation, build, test, recovery, merge, or deployment was performed.

## Problem in this repository's terms

The handoff describes recovery and landing of a retained Backlog composer. Current repository evidence contradicts that premise: the feature, its C18 rebaseline, and the dedicated browser E2E are already on current `origin/main`. The next step must not reapply `cez/15ff402b`. It needs to establish the fresh remote tip, assess open C18 todos against the current guard, execute existing merged-tree verification, and then determine whether manual blue-green deployment and corpus correction remain necessary.

## Record already decided, with citations

- KB `specs-e2c7601d0487`, [`.ai/specs/2026-08-22-backlog-add-without-starting.md`](../2026-08-22-backlog-add-without-starting.md:7), requires one project-scoped submit to file exactly one unstarted todo. It is a third composer mode, not a second composer or fan-out (`:60-105`), has no server or contract change (`:179-202`), and is absent outside project scope (`:140-171`).
- KB `specs-f20d37a98c1a`, [`.ai/specs/2026-08-24-land-the-backlog-composer.md`](../2026-08-24-land-the-backlog-composer.md:1), orders C18, browser E2E, merged-tree gates, then deployment (`:10-32`). Its claim that the retained branch is absent from `main` (`:53-69`) is stale and must be corrected in place.
- The dispatch-mode record preserves Backlog as separate, single-project, filing-only behavior ([`.ai/specs/2026-08-25-composer-dispatch-mode.md`](../2026-08-25-composer-dispatch-mode.md:134)).
- `AGENTS.md` and [`domains/cezar.md`](/var/lib/cezar/loki-labs/notion-export/domains/cezar.md:1) require a fresh SHA-matching build stamp before manual `cezar server-deploy --strategy=blue-green`. Agent-run deployment parks for manual action.

## What Git and current code show

- `cez/15ff402b` at `b5bd0d4e` is an ancestor of local `HEAD` `0a46010b` and current `origin/main` `bb97df43`. `48f9892c` (feature), `c406f2fa` (landing merge), and follow-up composer commits `53af6a51`, `d033c5d2`, and `33ea5803` are likewise ancestors. `git diff origin/main...cez/15ff402b` is empty. Do not merge or reapply the retained branch.
- The scoped client call is at [`packages/web/src/api/client.ts`](../../packages/web/src/api/client.ts:807). Backlog mode calls `createTodo({ summary: text, origin: 'composer' })`, clears the draft, invalidates todo queries, and routes to `/tasks` ([`new-task.tsx`](../../packages/web/src/routes/new-task.tsx:551)); the choice is hidden for workspace scope (`:903`).
- Draft state is `start | plan | backlog` ([`new-task-draft.ts`](../../packages/web/src/routes/new-task-draft.ts:44)) with legacy `planFirst` normalization (`:215`). The mode has an E2E selector, `data-slot="mode-backlog"` ([`new-task.tsx`](../../packages/web/src/routes/new-task.tsx:1575)). Unit tests include provider-independent filing and segment behavior ([`new-task.test.tsx`](../../packages/web/src/routes/new-task.test.tsx:714), [`new-task.test.tsx`](../../packages/web/src/routes/new-task.test.tsx:1590)).
- The demanded runtime proof already exists: [`packages/web/e2e/backlog-composer.e2e.ts`](../../packages/web/e2e/backlog-composer.e2e.ts:97) creates a registered non-boot fixture, submits once at `/p/fixture/new`, asserts one unstarted todo and no fixture run, reaches global `/tasks`, and sees the Filed row (`:98-143`).
- C18 now uses `C18_MAX_MS_PER_MIB = 59.2` ([`catalog.test.ts`](../../packages/cezar/src/knowledge/catalog.test.ts:268)) with serialized CPU-time minimum-of-three sampling (`:270-325`), not the historical `<40 ms/MiB` assertion. The older landing spec's sibling-baseline proposal is not current code.

## Current related work and contradictions

- C18 todo `d9ebe916-4f0b-4a57-8cb3-608013e8aa60` remains in [`.ai/cezar/todos.json`](../../.ai/cezar/todos.json:3257). Earlier entries at `:2072` and `:2113` appear duplicate. Task todo `30d9e835-f15f-4c9b-a0ef-624fbfc61cd4` at `:3303` still carries obsolete recovery instructions.
- `cezar todo list` returned no visible todos from this worktree, contrary to the project record. Resolve that discrepancy before changing task tracking.
- The historical three-checkout recovery claim was not re-executed. A current read-only check found cezar main with only untracked briefs and chat dirty more broadly than the historical deletion. Any recovery requires a fresh scoped inspection first.
- `cez/265c2695` (Active/Backlog tables) and `cez/1909f34e` (Filed task detail) are related but not duplicate composer work; their E2Es cannot substitute for the dedicated composer E2E.

## Prior decision this would contradict

Re-merging `cez/15ff402b` contradicts current ancestry. Replacing current C18 with the old unmeasured proposal contradicts present code. Deploying before browser and merged-tree gates contradicts the release gate.

## Questions the next specification must settle

1. What exact fresh `origin/main` SHA must be verified?
2. Does current C18 pass and still satisfy the diagnostic todo's meaningful-regression requirement?
3. Does the existing E2E execute unchanged with retained artifacts?
4. What real-checkout dirt, if any, still needs recovery before deployment?
5. After green verification, which corpus corrections and manual blue-green steps are still required?

## Not found

No unlanded or alternate Backlog-composer implementation was found. No fresh gate, runtime E2E, health probe, live-bundle check, deployment state, or real-checkout recovery evidence was collected in this read-only step.
