# Upstream sync triage — `d3aff0aa..6a97d0ff` (v0.9.3)

**Date:** 2026-08-13 · **Status:** executed on branch `sync/upstream-0.9.3`, typecheck green,
**not committed** · see §7 for what execution changed about this plan.

Upstream `open-mercato/cezar` is 33 commits ahead of our fork; we are 10 ahead with the
central-hub work (knowledge base, sources, notifications, auth, orgs/teams, per-org
supervisor). A straight `git merge upstream/main` conflicts in 37 files.

Triaged by 7 parallel agents over thematic commit groups, plus 5 adversarial
verification passes. Method note: every commit was read from its **diff**, never its
message — `2d297746`'s message describes a design that is not what shipped, understating
the commit by ~1000 lines.

---

## 1. Verdicts

### Take — clean, zero conflicts (17)

| sha | what | why |
|---|---|---|
| `b4f9541f` | composer git state from project, not boot folder | **fixes a live defect in our product** — see §3.1 |
| `89c88240` | anchor task diff at freshest base | our hosted checkouts never `git pull`; every diff number we show an org is inflated |
| `f1c186ce` | SIGKILL escalation regardless of `ChildProcess.killed` | leaked agent processes; exposure verified present at 7 sites |
| `600b864f` | resume ask answers through idle teardown | more likely for us — hosted means tabs sit open across the idle window |
| `38a99e2a` | `markAllRead` stops stamping usage-limit-parked runs | **bug is live in our tree**; our cross-project board is a second consumer |
| `4712daba` | keep legacy `claude-cli` runner id parseable | cheap; and it is the precedent for the fix in §3.2 |
| `ec4925a9` | resume parked monitors, expand `/skill` on continuations | restart recovery corrupts the resumed prompt today. **Default decision — see §4** |
| `24221cde` | synchronize the repo-root lease test | our suite is slower than upstream's, which is what makes the old timer lose |
| `6521acdd` | "Mark unread" | prerequisite for `bbd77e9b` (mechanically, not semantically) |
| `57683d02` | restore registered-project uninstall guard | guard has been dead since written. **Needs widening — see §3.7** |
| `5828ee30` | `/new` header follows resolved run mode | removes a false claim from a page we ship |
| `f0208aa6` | canonical model identity on agent badge | first reader of a field that is otherwise write-only |
| `ef0041be` | drop unused `KNOWN_PROVIDERS` | verified zero importers; not a protected surface |
| `0e027431` | top-right toast stack | our own settings pages are the surfaces it fixes |
| `386e82b6` | CLI alias bare specifier | keeps `alias-cezar/bin.js` byte-identical to upstream |
| `bcc101c4` | root LICENSE (MIT) | **we have none** while 5 manifests declare MIT; `PLAN.md` open question #3 |
| `60650171` | 0.9.2 contributor credits | stops CHANGELOG diverging by one more hunk |

### Take — real integration work (8)

| sha | what | cost |
|---|---|---|
| `c23fb562` | per-task TMPDIR + preflight | owns **all four** `run.ts` conflict hunks in the whole merge. **Trap — §2.1** |
| `e8db2931` | gate automations behind `CEZ_AUTOMATIONS` | 21 conflicts, all mechanical unions. Kills an unattended agent-launcher — §3.3 |
| `bbd77e9b` | progressive history loading | contract change, parity-safe (verified: no clock-derived field, cursor is offsets+seq) |
| `08b2c298` | sidebar task names **+ the e2e path fix** | take first — §3.4 |
| `8566a2ed` | sidebar collapse + last location to `localStorage` | worth more to us than upstream — §3.5. **Trap — §2.4** |
| `b2c2f421` | settings General page | 2 conflicts; reword folder copy for hosted mode |
| `abd5d155` | launcher injectable seam | we re-implemented ~70% independently; take the 2 missed sites + `refuseSpawnUnderTest` |
| `5c26b056` | OpenCode model discovery | low value (we don't use OpenCode) but unblocks the range; 2 import conflicts |

### Defer — decision required first (4)

- **`4bc94f6c` + `31e48bed`** — global search + global Tasks page. The board decision, §5.
- **`9a649ce9`** foldable columns — walks *against* `8566a2ed`: puts a browser-shaped
  preference back on the server, so one org member folding a column folds it for the team.
- **`0d7e23f7`** repo-lock bypass — see §3.6.
- **`b28495a0`** PR/issue chips — hard-blocked (edits two files we don't have), and inert
  until the installer provisions `gh` per org.

### Skip (2)

- **`6a97d0ff` nightly npm publish — do not merge.** §3.8.
- **`6170128c`** release from `release/*` — widens a publish path we can't use.

### Skip the runner, lift the substrate

**`2d297746`** (pi runner, 68 files, +1768). Taking it adds pi to `ui-parity`'s
`BACKENDS`, binding us to keep pi's mapper emitting **10 capability rows forever**, on a
runner nobody here exercises — and `fixtureEvents` does a bare `readdirSync` with no
existence check, so a partial take throws ENOENT rather than skipping. Lift only the
`RUNNER_IDS` tuple + `isRunnerId` hoist and the `MULTI_PROVIDER_PREFIXES` extraction
(~40 lines).

---

## 2. Merge execution — four traps that pass a green gate

Three separate agents independently found the same failure shape: **resolving the visible
conflict markers is not enough, and the gate does not always catch what's left.**

### 2.1 `run.ts` — a type break outside every conflict block

`c23fb562` narrows `let continueProfile: { env; profileId }` / `let stepProfile: {…}`
around `agentEnvForStep`, which in our tree also returns `knowledgeSummary`. The
assignment is legal (a wider type is assignable to a narrower one; excess-property
checking applies only to fresh literals), so the error lands at the property **reads** —
merged lines **2437 and 3031**, both *outside* every conflict block.

Sequencing is the hazard: the unresolved file has conflict markers, which are syntax
errors, so `tsc` dies on those first. TS2339 surfaces only **after** the resolver has
fixed all four visible conflicts and believes the file is done.

**Fix:** widen both annotations to include `knowledgeSummary: KnowledgePromptSummary | undefined`,
or revert them to `const` inside the try.

### 2.2 `server.ts:6259` — an absence assertion satisfied by deletion

The `workspaceV1` mount chain conflicts: our side lists four `.route()` calls, upstream's
two. Take "ours" and `runsIndexRoutes` never registers — global search is silently dead.

- `route-parity` asserts `expect(keys).not.toContain('GET /workspace/runs-index')` — a
  **deleted** route satisfies that perfectly.
- `bc-route-inventory`'s `missing` filter is one-directional: registered-but-not-documented
  fails; documented-but-not-registered passes.

Two of five guards blind to the same deletion, in the same direction. Only upstream's own
`runs-index-api.test.ts` catches it. **Resolution: union all five `.route()` lines.**

### 2.3 `capabilities.ts:209` — caught loudly, but sits next to a whitespace-looking choice

Taking "ours" deletes `automations: env.CEZ_AUTOMATIONS === '1'` while the contract still
requires the key. Caught twice (TS2739 + the exhaustive `toEqual`). Keep both lines.

### 2.4 `routes.tsx` — our onboarding gate must stay above the `lastLocation` restore

`8566a2ed` deletes the `locationToRestore` readers. Our onboarding gate sits directly
above that call (`routes.tsx:296-303`, the `FIXED 2026-08-07 (D15 runtime E2E)` block).
Keep the gate above whatever replaces it.

### 2.5 The two doc files are **not** noise

- **`CHANGELOG.md`** — ours +212, theirs +143, two hunks, both pure adjacent insertions
  inside `# Unreleased`, zero overlapping deletions. **Union merge.** Taking upstream's
  side deletes our entire auth/orgs/supervisor record, including two in-place `CORRECTED`
  lead-ins that doctrine requires stay attached to what they invalidate.
- **`BACKWARD_COMPATIBILITY.md` is a build gate**, not documentation —
  `bc-route-inventory.test.ts` reads it off disk and asserts every registered `/api/v1/*`
  route appears in §2. **Neither side alone passes**: "ours" leaves upstream's 5 new routes
  undocumented; "theirs" drops our ~40 scaffold routes. Union required, and a lazy
  resolution fails the suite by name rather than shipping silently.
  **Except hunk 2** — the Workspace `projects` bullet is one ~2000-character line that both
  sides rewrote in full. A diff tool offers a whole-line choice and either choice silently
  drops half the contract. Hand-merge to `{maxParallel?, tags?, teamId?}` with the union
  entry shape `{id, name, root, branch?, status, source, lastOpenedAt, forge?, maxParallel?,
  repoUrl?, tags?, teamId?, teamName?}`.

### 2.6 Guard verdicts after a correct union

| guard | verdict |
|---|---|
| `route-parity` | PASS (manifest) / **cannot determine statically** (byte-identity on the two new history GETs and the newly-live `/automations*` family) |
| `ui-parity` | PASS (+10 permanent assertions if pi is taken) |
| `bc-route-inventory` | PASS — §2 conflict proven prose-only (141 routes either way) |
| `versioned-surface` | PASS — all 26 upstream-added paths are `/api/v1/*` |
| `api-types` | PASS — neither side touched what it pins |

If byte-identity goes red, look first at **epoch-millisecond** timestamps: `stripTimestamps`
matches ISO-8601 only, and is gated on `path.startsWith('/github')`.

---

## 3. Fork-private defects this surfaced (none fixed by taking upstream)

1. **Every composer run in our hosted product executes in the repository root.** Our per-org
   boot dir is deliberately not a git repo (`provision-user.ts:135`), so boot-scoped
   `/health.repo` is null → `hasGit` false → `resolveComposerRunMode` forces
   `worktree: false`. Worktree chip hidden, variants pinned to 1, Push dark, runs
   serialized one-at-a-time. **`b4f9541f` fixes it.**
2. **`workspace/run-index.ts:266` `safeParse`s the whole runs array** against the
   *contract's* schema (narrower than the store's). One unparseable record erases an entire
   project from the workspace board as a health failure. Copy `4712daba`'s parse-and-fold.
3. **`markAllRead` is missing the `autoResumeAt` clause** `isUnread` already has — #803 is
   live for us. Fixed by `38a99e2a`.
4. **16 e2e spec files / 17 spawn sites have never run.** All inline
   `join(repoRoot, 'dist/index.js')` themselves — dead since the monorepo split — and match
   no `include` in any of the three vitest projects. `npm run test:e2e` is in neither CI job,
   and even by hand `.ai/scripts/e2e.sh` exits **0** with `TEST_E2E_STATUS=skipped` when no
   browser provider is installed. `08b2c298` fixes all 17 and makes the path one exported
   fact. **It buys runnability, not coverage** — the specs haven't executed since before the
   split and our onboarding gate changed what `/` renders.
   *Trap to remember:* `npm run test:package` runs `packages/cezar/test/e2e/` — a different
   tree from `packages/web/e2e/`. A gate command with "e2e" in its path reads as covering
   the e2e suite and does not.
5. **`ui-state.json` is unscoped per principal.** Under D10 an org shares one unix user and
   one `CEZ_HOME`, so today one member navigating decides where every teammate's bare-root
   launch lands, and one member collapsing a group collapses it for the team. `8566a2ed`
   fixes it, or we spec a per-user partition.
6. **`opencode-server-runner.ts:182,237,239,249`** keeps the `!child.killed` bug
   `f1c186ce` fixes everywhere else. One file, reuse `trackChildExit`, upstreamable.
7. **After taking `57683d02`, the uninstall guard still won't fire on a hetzner host** — it
   counts one `CEZ_HOME`'s registry, and every org has its own. Widen to
   `~/.cezar/server-instances/*.json` or the supervisor's org registry, or
   `server-uninstall --platform hetzner` tears down every org with no confirm.
8. **Our own `BACKWARD_COMPATIBILITY.md` is now false in two places** (rule 3a: correct in
   place, don't append):
   - §2 scaffold bullet says all five flag-gated families are "inert… no handler does
     anything real yet… turning a flag on changes nothing observable." **Four of five are
     live** (`sources` 436 lines, `notifications` 755, `knowledge` 272, `workspace-runs` 135);
     only `notes` is still a placeholder.
   - §9 lists three `~/.cezar/` files; we added five more and documented none:
     `identity/`, `notes.json` + `notes-log.ndjson`, `notifications.json`,
     `notifications/outbox.ndjson`, `supervisor/`. **`identity/` holds org membership and the
     D4 root→org claim**, so §9's "losing it is an inconvenience, not data loss" is flatly
     untrue of it. §2 has a mechanical guard and stayed honest; §9 has none and drifted.
9. **The C2 import guard has no floor.** Three `not.toMatch` calls, zero positive assertions.
   Tested: catches the `.ts` static import it was written for; **misses** `.js` specifiers,
   `import()`, `require()`, and barrel re-exports, and would go green against a one-line
   `export *` shim. Also note the causality: our board is safe because of **where its route
   is mounted** (`createWorkspaceRunsRoutes()` takes no deps and mounts into `workspaceV1`,
   where no route starts with `/p/`), not because of this guard. Do not cite the guard as
   the mechanism.
10. **Our flag-gated routes pass `route-parity` vacuously.** `CEZ_KB`/`CEZ_SOURCES` are unset
    in the suite, so ~9 knowledge/sources assertions compare three identical flag-off
    payloads. Upstream just wrote this exact argument for automations (#801) and fixed it by
    setting the flag in `beforeEach`. Two-line fix.
11. **`tasks` is not in `RESERVED_PROJECT_IDS`.** `31e48bed` adds a top-level `/tasks`
    segment without reserving it — the same shape as our own `onboarding` slip one release
    earlier (recorded at `workspace/projects.ts:43-46`). No live break found (no bare
    `/:projectId` route today). One-word fix when it lands.
12. **CI is red.** One recorded run ever — push on `main`, 2026-08-08, `9b5f62b8` — failed at
    "Run server and cockpit unit suites". Not the e2e specs (they can't load). Needs the run
    log.

---

## 4. Decisions for the owner

1. **The cross-project board** — see §5. Blocking; must be decided *before* the merge.
2. **`ec4925a9` turns monitoring wake ON by default at 5 minutes.** Under per-org `CEZ_HOME`
   the opt-out is per-org config with **no workspace-wide knob**, so across N tenants this is
   recurring token spend adopted by default. If we want `null`, write it into the config
   `server-install --platform hetzner` generates.
3. **Tags vs teams** (`31e48bed`). Upstream invented project tags because it has no org/team
   model; we already have teams. Recommend deferring tags rather than shipping both axes.
4. **Merge shape.** Recommend merging in upstream order rather than cherry-picking:
   ordering conflicts are structurally zero in order (every commit's predecessors sit
   earlier in the range), and 19 of 33 are clean regardless. Cost is concentrated —
   `e8db2931` + `31e48bed` are 36 of ~64 resolutions. The `capabilitiesSchema` tax
   **compounds if deferred**: it is all-required booleans, so every capability addition
   conflicts ~13 hand-built health fixtures, forever, in both directions. A fork-private
   `baseCapabilities()` test helper is the highest-leverage change available if we mean to
   stay mergeable.

---

## 5. The board decision

**Both forks independently built the same non-instantiating cross-project reader.**
Upstream's `runs/run-index.ts` docblock says almost word for word what ours says: building
a `ProjectContext` calls `manager.recover()`, so "typing into a search box would spend
tokens." This was never safe-vs-unsafe.

| | ours | upstream |
|---|---|---|
| route | `GET /api/v1/workspace/runs` | `GET /api/v1/workspace/runs-index` |
| module | `workspace/run-index.ts` (mtime+size cached) | `runs/run-index.ts` |
| gate | `CEZ_WORKSPACE_VIEWS === '1'`, off by default | none — always on |
| carries | per-project health (`ok:false, reason`) | live `usage`, cost, peak RSS/proc, task refs |
| UI | `/workspace/tasks`, read-only, project multi-select | `/tasks`, facets + grouping, **row mutations** |

**They merge clean** — different paths, different route names, and `bc-route-inventory` is
satisfied by both. That is worse than a conflict, because a conflict would force a choice.
Merge without deciding and we ship two implementations of one idea, two caches over the
same `runs.json`, and two BC.md entries promising the same invariant.

**Our board has never served a hosted request.** `CEZ_WORKSPACE_VIEWS` appears nowhere in
`server-install/`, and the per-org systemd unit's `Environment=` list is fixed at five
variables with no passthrough seam. It has automated coverage and zero production exposure.

**The `noteId` argument for keeping our shape is refuted** — no producer writes it (our own
reader does `Omit<…, 'noteId'>`), no consumer reads it, `packages/cezar/src/notes/` does not
exist, and the Notes routes are an inert scaffold that ignores their own flag.

**Recommendation:** adopt upstream's `runs-index` as the single reader; retire
`GET /api/v1/workspace/runs` or re-implement it as a thin projection. Port our two real
advantages onto it — the capability gate and per-project health (so a dead project renders
instead of vanishing) — and repoint our structural import guard at `runs/run-index.ts`
after giving it a floor (§3.9).

**Precondition before that page is exposed:** the row actions need a non-instantiating
mutation path. `archiveProjectRun`/`setProjectRunRead` POST to `/api/v1/p/:projectId/…`,
and `resolveProjectScope` (`server.ts:1737`) calls `contexts.context()` — the *building*
accessor — on a method-agnostic `use('*')`. `build()` runs `pruneOrphans` +
`reclaimWorktrees` (deleting worktree directories) then `await manager.recover()`, which
resumes **every** interrupted run in that project into `spawn('bash', ['-lc', command],
{ env: process.env })`. The trigger is the project, not the row: marking one finished row
read in project B resumes B's other interrupted runs, in middleware, before the handler
runs. Our board is read-only today, so `31e48bed` *introduces* this rather than inheriting it.

---

## 6. Follow-ups

- Notion sync is **pending** — no code has changed yet. When the merge lands: one ✅ Tasks
  row + a dated 📝 Changelog entry. Read the live `Project`/`Area` option sets first; do not
  guess an option (a `select` silently rejects an unknown value and leaves the field empty).
- The `automations` 409 default flip and the `lastLocation` silent no-op (write surface
  survives, read surface removed — "still accepted" reads as "still works") both belong in
  **our** release notes, not only upstream's, since we publish the same package.
- §7 parity prose now describes a derivation no code performs: `BACKENDS` is a hardcoded
  literal, so a future runner added without editing that array is exempt from parity by
  omission. Deriving it from the `__fixtures__/` listing is a two-line fix.

---

## 7. Execution record (2026-08-13)

Merged `upstream/main` into `sync/upstream-0.9.3` in upstream order, as recommended in §4.4.
**299 files, +26,071/−1,947. All 37 conflicts resolved. `npm run typecheck` green (server + web).
Not committed; `main` untouched. Only typecheck was run — `test`, `test:unit`, `build` and
`test:package` are UNVERIFIED.**

### The four predicted traps were all real and all handled
`run.ts` annotations widened (`:2405`, `:3002`) · mount chain unioned to five routes (`server.ts:6197`)
· `automations` kept in `capabilities.ts:210` · onboarding gate still above the location restore
(`routes.tsx:296`). The server suite compiles only because of the first, so typecheck confirms it.

### Three things this plan did NOT predict, found during execution

1. **Union-merging is not safe by itself — you must check what each side ALREADY has.** Splicing
   upstream's route block in whole duplicated the entire `/settings/global` block (ours already had
   it), leaving a dangling `.map((section) => (`. Only `/tasks` was genuinely new. Caught as a
   syntax error, so loud — but it is the same mistake this plan warned others about.
2. **The `capabilitiesSchema` tax lands on files that never conflict.** `knowledge.test.tsx` and
   `workspace-tasks.test.tsx` are fork-only, so git had nothing to flag, yet both broke the moment
   upstream's required `automations` key arrived. §4.4's `baseCapabilities()` helper would have
   prevented this; it is now the concrete argument for building it.
3. **A conflict can align two UNRELATED definitions.** In `projects-section.tsx`, git aligned
   `TeamPicker` (ours) and `ProjectTagsEditor` (upstream) on a shared `/**` opener and shared
   trailing `)\n}`, so the conflict read as one component edited two ways. Either side taken
   literally deletes a whole working component and no gate names it. Split back into two.

### Behavioural questions settled during the merge, not merged around

- **Empty `PATCH /projects/:id` now answers 400, not 200.** Our 200 was an accident of 5c relaxing
  `maxParallel` to optional; nobody designed "empty body = no-op". Upstream's `.refine` restores the
  400 with the better rationale, and §2's BC clause (a build gate) states 400 — leaving the test at
  200 would have put the gate in contradiction with the suite. The superseded reasoning is marked in
  place in `projects-api.test.ts`, and a **new** test neither side had now pins that a `teamId`-only
  body stays legal: that is what 5c existed for, and what a future narrowing of the refine would
  silently break.
- **`updateProjectInputSchema`** carries `maxParallel` + `teamId` + `tags`, refine widened. Our team
  reassignment runs first so a refused one leaves nothing half-written; the semaphore refresh fires
  only when `maxParallel` changed.
- **Deleted the duplicate `updateProjectSchema` in `server.ts`** — already dead (the route validates
  against the contract's copy), and a second definition claiming to mirror the contract is how they
  drift.
- **Dropped the `useWorkspaceUiState()` read in `routes.tsx`** — after `8566a2ed`, `locationToRestore`
  reads localStorage, so that wait gated on a value nothing consumes.
- **`isProjectCollapsed` moved, it was not lost** — relocated to `lib/sidebar-collapse.ts` with its
  `describe` block. Verified before accepting the import change.

### Deliberate omissions carried into the branch

`nightly.yml` deleted (§3.8). Everything else in the range came across, **including the things §1
marked defer/skip** — pi, tags, foldable columns, the repo-lock bypass, the global Tasks page — because
merging in order is what keeps ordering conflicts at zero. They are now present in the tree and still
undecided. In particular: **the two-boards duplication of §5 is now live in the branch**, with a
`TODO(upstream-sync)` at the `/tasks` route pointing here, and the row-action hazard is unguarded.
Decide §5 before this reaches production, not before it is committed.
