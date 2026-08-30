# Brief: Remove the Open Mercato vendor coupling from cezar

**For task:** `4d9a3166-1ac5-4e7e-9e54-368eba57bd07` (worktree `cez/4d9a3166`)
**Gathered:** 2026-08-30

## The one fact that reframes this task

**The described work is already shipped.** Commit `22121904` ("feat: remove the Open
Mercato vendor coupling; rename to `@loki-labs/better-cezar`", 2026-08-16 16:14:02
+0200) did everything the task's "What to do" section describes, and it **is an
ancestor of the current `HEAD`** (verified: `git merge-base --is-ancestor 22121904 HEAD`
→ true; current `HEAD` is `0a46010b`, 2026-08-29). The spec it implements,
`.ai/specs/2026-08-16-remove-open-mercato-coupling.md`, is headed `**Status:**
implemented (2026-08-16)`. `CHANGELOG.md:1321-1367` already carries the dated entry.

The task's own tracker record — `notion-export/tasks/3beb9863-remove-the-open-mercato-vendor-coupling-from-cezar.md`
— is a **stale snapshot frozen at commit time**: it still reads "Blocked on: Not
committed" and has the last two acceptance boxes (commit, changelog) unchecked,
because nobody went back to flip them after the commit landed **the same day**. This
looks like the reason the task got re-surfaced and a new run started against it today
(2026-08-30) — the tracker never caught up to the code. This is bookkeeping debt, not
undone engineering.

So the real job for this run is narrower than the task text implies:
1. Close the tracker record (mark done, note the commit).
2. Fix a **genuine residual defect** the original commit's diff missed (below) —
   found by re-checking the live UI against the acceptance criteria rather than
   trusting the frozen "what was done" list.
3. Confirm there is nothing else load-bearing left.

## What the record already decided (citations)

- **Spec:** `.ai/specs/2026-08-16-remove-open-mercato-coupling.md` — Status: implemented
  (2026-08-16). Sections A–D cover the skills-repo default, the banner/updater removal,
  the brand mark, the npm scope rename, and §C2 the partial supersession of D2.
- **Commit:** `22121904` on the current branch's history (ancestor of `HEAD`). Full
  commit message documents scope, verification (typecheck/test:unit/build/test:package
  green; `npm test` 8184/4-fail attributed to a concurrent unrelated `backup` feature in
  the same working tree at commit time), and an explicit note that it also swept in that
  parallel session's in-flight backup-feature files at the owner's instruction
  ("commit everything we have locally").
- **KB:** `specs-05bebb0f9dc8` "Remove the Open Mercato vendor coupling" (root: specs,
  status: current) and `notion-8bad5a5b1f00` (the task doc itself, root: notion, status:
  current — this is the stale record described above, not an independent second source).
- **D2 supersession, marked in place:** `.ai/specs/2026-08-06-knowledge-base-mounts-search.md:43`
  — `**D2 PARTLY SUPERSEDED 2026-08-16 by `.ai/specs/2026-08-16-remove-open-mercato-coupling.md`**`,
  original text preserved below it per the "correct in place" convention. Nothing further
  to do here; already done correctly.
- **Guard narrowed, not deleted:** `packages/cezar/src/notifications/transports/webhook.test.ts:390`
  — `describe('upstream purity (spec Verification #10, whole tree)', ...)`, with the
  strip-the-fork's-own-specifier logic and (per the commit message) a negative control.
  Confirmed present at `HEAD`; not re-verified test-by-test in this step (that's step 2/3's job).
- **CHANGELOG.md:1321-1367** — the dated entry already exists in the repo's own changelog.

## What is actually still wrong, verified against code at `HEAD` (not the frozen task doc)

**`packages/web/src/routes/skills.tsx:158-175`** — the "Manage skills" import row (shown
whenever `canImport` is true, i.e. whenever `/api/v1/skills/importable` returns any
skills) still hardcodes vendor naming:

```tsx
<span className="ml-auto shrink-0 rounded-full border border-border px-2 py-px font-mono text-[10.5px] text-soft-foreground">
  open-mercato
</span>
...
<span className="pl-[22px] text-xs text-soft-foreground">
  Choose which open-mercato skills appear in your catalog.
</span>
```

`git blame` on these exact lines: `eb9764093` (Patryk Tomczyk, 2026-07-22), i.e. they
predate the removal commit and were never touched by it. Confirmed by reading
`git show 22121904 -- packages/web/src/routes/skills.tsx`: that commit's diff on this
file only reworked imports (`@open-mercato/cezar-api-client` → `@loki-labs/better-cezar-api-client`)
and removed now-dead `useProjects`/`useProjectScope` wiring passed into
`<ImportSkillsPanel projectId={...} />` — it never touched the "Manage skills" row's
badge/copy block at lines 158-175, which sits ~50 lines above what it edited.

This directly contradicts two of the task's own (checked!) acceptance criteria:
- "No `om-*` skill in the catalog or composer picker" — not a skill name, but this *is*
  vendor naming surfaced in exactly the composer/skills picker the criterion is about.
- "No vendor banner, updater, or naming in the cockpit" — this is live vendor naming,
  today, in a component that renders whenever any importable skills exist (which is now
  possible again for any operator who opts into `skillsRepos`).

No other live (non-test, non-historical-record) code references Open Mercato by name.
Full sweep, `HEAD`:
- `packages/cezar/src/config.ts`, `cluster/corpus-store.ts` — comments only, citing the
  2026-08-16 decision or crediting `@open-mercato/cezar` as the upstream project. Fine —
  the spec's own §D says the dated record and historical citations are not rewritten.
- `packages/cezar/src/server/forge/github.ts:2034`, `contract/src/runs.ts:726`,
  `web/src/lib/tasks-table.ts` (233, 297, 350, 362), `web/src/routes/settings/projects-section.tsx`
  (167, 691) — all comments or test-fixture URLs citing `open-mercato/cezar` as a
  provenance/example reference (ported-design credits, PR-link test fixtures). Not vendor
  coupling; matches the spec's "dated record kept" carve-out.
- `packages/web/src/components/skills-import-panel.tsx:33` — comment citing the 2026-08-16
  spec by name. Fine.
- Test files (`task-markers.test.ts`, `task-refs.test.ts`, `store.test.ts`,
  `automations-api.test.ts`, `checkout.test.ts`, `github.test.ts`) use
  `open-mercato/cezar` purely as a realistic example GitHub URL/owner string for
  generic PR/issue-link parsing tests — unrelated to vendor branding, not in scope.
- `packages/web/public/` — only `cezar.svg` present; no `open-mercato.svg` on disk.
  `packages/web/src/components/app-shell.tsx:57` — `brandLogoUrl = '/cezar.svg'`. Brand
  mark replacement confirmed intact.
- `DEFAULT_SKILLS_REPOS` confirmed `[]` at `packages/cezar/src/config.ts:33`, still.
- No `skills-banner.ts`, no `CEZ_NO_BANNER` anywhere in the tree.

## Things that could contradict or complicate a spec here

- **The 2026-08-16 commit deliberately bundled in unrelated work**: a parallel session's
  in-flight `2026-08-16-provider-agnostic-platform-backup.md` implementation, at the
  owner's explicit instruction at the time ("commit everything we have locally"). That
  spec now also shows as a normal file in `.ai/specs/` with no flag distinguishing it —
  worth knowing so nobody mistakes backup-feature files as part of *this* task's diff if
  reviewing `22121904`'s full diff for reference.
- **`.ai/specs/2026-08-16-upstream-sync-v0.10.0.md`**: a later upstream merge
  (`e43b912d`, "chore: sync upstream cezar into @loki-labs/better-cezar (v0.10.0)") pulled
  from `open-mercato/cezar` after the removal commit. Checked: it did not reintroduce
  `DEFAULT_SKILLS_REPOS`, `skills-banner.ts`, or the OM brand asset — the sync's
  CHANGELOG entry (`CHANGELOG.md:160`) confirms `@loki-labs/better-cezar*` identity was
  kept via `manifests resolved keep-ours; upstream's release-bump and README branding
  commits resolved away`. So this is not the source of the residual skills.tsx bug either
  — that bug predates both the removal commit and the sync.
- **No duplicate in-flight work found**: `cezar todo list` returned no open todos, and no
  spec dated after 2026-08-16 revisits this area other than the upstream-sync spec above
  (which is closed and unrelated to the residual).

## Open questions for the spec step

1. **Scope of the fix in `skills.tsx`**: replace `open-mercato` badge/copy with something
   source-agnostic (e.g. drop the badge entirely, or make it reflect whichever
   `skillsRepos`/`gatedSkillsRepos` are actually configured) rather than swapping in
   another hardcoded vendor string. The component has no per-repo identity plumbed into
   it today (`ImportSkillsPanel` takes no `projectId` since the 2026-08-16 commit removed
   it) — worth deciding whether the row should just say "team skills" generically, since
   the source is now zero-or-more arbitrary opt-in repos, not a single named vendor.
2. **Tracker closure mechanism**: given the production cutover (2026-08-19, this repo's
   own `CLAUDE.md`/`AGENTS.md`), Notion is a read-only archive and the corpus at
   `/var/lib/cezar/loki-labs/notion-export/` on `prod-host` is the record. The task
   doc `tasks/3beb9863-remove-the-open-mercato-vendor-coupling-from-cezar.md` needs its
   checkboxes and "Blocked on" section corrected in place (per the "correct in place"
   house rule) — not rewritten as if newly done, since the underlying work really did
   land on 2026-08-16; only the fix below and the bookkeeping are new. This step did not
   attempt that write (out of scope for "gather the record"); flag it for whichever step
   does tracker sync.
3. **Whether a full new dated spec is warranted** for what is now a small, single-file
   fix plus a bookkeeping correction, versus amending
   `.ai/specs/2026-08-16-remove-open-mercato-coupling.md` in place with a `CORRECTED
   2026-08-30` note (this repo's own convention per `AGENTS.md` "keep the record
   straight" / "a correction marks what it invalidates, in place"). Given the repo's own
   spec-numbering is date-slugged rather than numbered, either is mechanically possible;
   the spec step should decide based on how the repo's own specs handle small follow-up
   fixes to an already-"implemented" spec (no clear precedent found in the 40 most recent
   spec filenames sampled — worth a quick check by whoever writes the spec).
4. No investigation was done in this step into whether `getTeamSkillsCached` /
   `/api/v1/skills/importable` can currently return anything at all on a fresh
   zero-config install (i.e., whether the "Manage skills" row even renders for a typical
   user today) — that's relevant to how urgently the residual string needs fixing and
   should be checked before writing the fix.

## Facts that most constrain the design

1. **This is not a from-scratch feature — it's a bookkeeping correction plus one
   small residual UI-string fix.** The 2026-08-16 commit (`22121904`) already shipped
   and is on `HEAD`; re-doing the described "What to do" work would be redundant/wrong.
2. **The one real defect** is `packages/web/src/routes/skills.tsx:158-175` (hardcoded
   `open-mercato` badge + "Choose which open-mercato skills appear in your catalog."),
   missed by the original commit's diff on that same file.
3. **Everything else flagged by a raw grep for "open-mercato" is legitimate** — dated-record
   citations, ported-design-credit comments, and generic test-fixture URLs — per the
   original spec's own §D carve-out ("the dated record is not rewritten").
4. **The tracker record (Notion task doc) is what's actually stale**, not the code; fixing
   it means correcting the frozen "Blocked on" / unchecked boxes in place, per this
   workspace's "correct in place" rule, referencing commit `22121904`.

Brief written to:
`.ai/specs/briefs/2026-08-30-remove-open-mercato-vendor-coupling.md`
