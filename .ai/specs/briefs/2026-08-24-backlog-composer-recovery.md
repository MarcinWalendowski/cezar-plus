# Brief: Backlog composer recovery

## Problem

The Backlog composer is implemented but unshipped. The retained task branch can file exactly one project-scoped, unstarted todo from `/new`; failed workspace settlement left it outside `origin/main` and contaminated three real checkouts. The remaining work is recovery, reconciliation, a host-correct C18 catalog gate, and a browser proof of the actual Filed-board outcome. It is not a new todo API or a second composer.

## Record already decided

- The landing record is KB `specs-f20d37a98c1a`, [`.ai/specs/2026-08-24-land-the-backlog-composer.md`](../2026-08-24-land-the-backlog-composer.md:1). It records retained branch `cez/15ff402b` at `b5bd0d4e`, based on `504ce87f`, absent from main, with a clean current merge tree. The current `origin/main` observed in this worktree is `c10644b7`; merge-tree remains clean and produced `8a7db657` during this brief.
- The original feature design remains only on the retained branch, `cez/15ff402b:.ai/specs/2026-08-22-backlog-add-without-starting.md:1-17`. It is deliberately partial: focused implementation landed there, but C18 was red and browser runtime E2E was not run. Its product rule is one project-scoped todo per submit, not fan-out or a second composer (`:60-74`, `:107-177`). This extends the prior reversal of two-composer routing recorded by KB `notion-82a85b288169`, cited from KB `specs-d54e830b8f08`.
- Filed semantics already exist: the server creates a `status: 'todo'` item without `startedTaskId`; Filed renders it and it can be started later. Reuse that lifecycle, rather than add a new state or endpoint. The chained project route is `packages/cezar/src/server/server.ts:6078-6104`; its contract accepts `origin: 'composer'` in `packages/contract/src/skills.ts:90-110,170-193`.
- C18 is mandatory and separate from the composer. Diagnostic todo `d9ebe916-4f0b-4a57-8cb3-608013e8aa60` at `.ai/cezar/todos.json:3250-3259` records 73.726 ms/MiB against the absolute 40 ms/MiB budget and requires a measured per-host baseline that still detects regressions. The existing warm, CPU-time measurement and absolute assertion are `packages/cezar/src/knowledge/catalog.test.ts:250-330`, specifically `:324`; the landing spec records idle host measurements of 54-65 ms/MiB and specifies baseline and negative-control requirements (`2026-08-24-land-the-backlog-composer.md:109-126,320-355`). Skipping C18 or merely widening an absolute constant contradicts that record.
- Production must use rootless blue-green deployment. The domain record [`/var/lib/cezar/loki-labs/notion-export/domains/cezar.md`](../../../../../../notion-export/domains/cezar.md:1) and repository `AGENTS.md` prescribe `cezar server-deploy --strategy=blue-green`, after a fresh build whose stamp agrees with the source checkout HEAD. Deployment cannot precede all gates.

## Code actually involved

The retained delta is seven files, 549 additions and 43 deletions, with no server or contract change:

- `cez/15ff402b:.ai/specs/2026-08-22-backlog-add-without-starting.md`
- `packages/web/src/api/client.ts` and `client.test.ts`
- `packages/web/src/routes/new-task-draft.ts` and `new-task-draft.test.ts`
- `packages/web/src/routes/new-task.tsx` and `new-task.test.tsx`

The retained web client adds the typed scoped `createTodo` wrapper at `cez/15ff402b:packages/web/src/api/client.ts:797-806`. Draft state becomes `runMode: 'start' | 'plan' | 'backlog'`, defaulting to Start while normalizing old `planFirst` drafts, at `cez/15ff402b:packages/web/src/routes/new-task-draft.ts:44-46,135-146,206-211`.

In project Backlog mode, the retained composer calls `createTodo({ summary: text, origin: 'composer' })`, clears the draft, invalidates every todo query, toasts, and navigates with the unscoped router to `/tasks` (`cez/15ff402b:packages/web/src/routes/new-task.tsx:535-543`). Predicate invalidation is required: scoped lists use `[projectId, 'todos']` while global Filed uses `['workspace', 'todos']` (`packages/web/src/api/queries.ts:374,1313-1318,2247-2261`). Backlog is deliberately absent in workspace scope and filing remains enabled with no agent provider (`cez/15ff402b:packages/web/src/routes/new-task.tsx:714-733,876-880,1464-1529`). Focused tests already pin one POST, no run or plan, global navigation, draft clearing, and all-board invalidation (`:1636-1677`), but are mocked tests.

The runtime E2E precedent is `packages/web/e2e/new-task.e2e.ts:48-220`, which starts a fixture server and drives `AgentBrowser`. No existing browser E2E visits global `/tasks` or Filed, per the landing record (`2026-08-24-land-the-backlog-composer.md:148-152`).

## Reconciliation and recovery constraints

- Preserve and merge `cez/15ff402b`; do not reimplement or discard it. It and `origin/main` are not ancestors of each other, so first fast-forward the task branch to current main, then create a no-fast-forward merge of the retained branch, as prescribed in the landing spec (`2026-08-24-land-the-backlog-composer.md:222-260`).
- Recover three real checkouts before deployment. `/var/lib/cezar/loki-labs` has an incorrect staged revert but legitimate unstaged doctrine corrections, so requires mixed reset plus restoring `tools/doctrine-sync`, then a doctrine commit. `/var/lib/cezar/loki-labs/chat` has a staged deletion of its shared-instructions spec and must be restored without a commit. The production source checkout `/var/lib/cezar/loki-labs/cezar` has 38 staged reverted paths, 239 insertions and 4,515 deletions, empty unstaged diff, and missing source files; it must receive `git checkout HEAD -- .` before it can be passed as deployment source. Exact evidence and commands are in `2026-08-24-land-the-backlog-composer.md:29-108,156-220`.
- The E2E must use a registered non-boot fixture project. Boot registration is unconditionally suppressed in `packages/cezar/src/index.ts:526-543`, while the global Filed board reads the registry. Testing the boot project could reach `/tasks` with no row and produce a vacuous result. This is recorded in `2026-08-24-land-the-backlog-composer.md:16-24`.

## Questions the implementation spec must settle

1. Which measured host-relative C18 baseline and regression margin satisfy the diagnostic todo without changing the test into a waiver?
2. How will the browser fixture register a non-boot project, submit Backlog once, and assert exactly one unstarted todo appears in global Filed?
3. After merging current main and retained work, do the seven retained-file changes remain the complete composer scope, with no server or contract divergence?
4. What exact merged-tree gate sequence, build-stamp verification, blue-green command, health readback, and live behavior check prove the deployed SHA is the landed SHA?

## Not found

No duplicate Backlog-composer implementation branch was found. No existing browser runtime E2E proves Backlog submission to global Filed. `cezar todo list` returned no visible todos in this worktree; the C18 diagnostic todo is nevertheless present in the project todo record cited above.
