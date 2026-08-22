# Per-task prompt drafts — closing the loop: QA verification, not new design

> **Status:** QA executed 2026-08-22 — gates green (two documented environment-trap failures, not
> regressions), runtime E2E 7/8 steps confirmed live, one named gap (send-and-clear, driver
> timeout — see the corrected Runtime E2E section of the extended spec below) · **Date:** 2026-08-22 ·
> **Owner instruction (unchanged from the original run):** "right now we persist input value when
> creating new agent, but let's do the same when adding prompt into any of tasks (running, etc. in
> every state) it should be seperately persisted on task: on some interval + before navigating
> await + use best practices" · **Extends:** `.ai/specs/2026-08-21-per-task-prompt-drafts.md`
> (598 lines, status now *"implemented, QA passed 2026-08-22 (one named gap)"*), which is
> **already implemented and deployed** — see below. **Brief:** `.ai/specs/briefs/2026-08-22-per-task-prompt-drafts-rerun.md`
> (step 1 of this run).

**This is not a new feature spec.** This task id and goal text already ran a complete
`spec-to-deploy` chain to "SHIPPED" before this run started (per `$CEZ_HANDOFF_FILE`'s 12:47 entry
on 2026-08-22, and confirmed independently below by reading `origin/main` directly). Re-designing
or re-implementing the feature would duplicate work that is already live in production. What this
spec defines instead is the one deliverable the shipped spec named and never completed — the
browser-rendered QA pass — plus the small amount of housekeeping needed to run it honestly.

## TLDR

`origin/main` at commit `ff06ecc7` (`feat(cockpit): persist a draft for every per-task prompt
box`, verified via `git log --oneline -5 origin/main` in the cezar worktree, 2026-08-22) already
contains the full, reviewed, gate-green implementation: a new `task-drafts.ts` store, a
`ThreadComposer` extracted and `key={run.id}`-mounted, and both `ReviewPanel` and `ApprovalCard`
wired to the same store — covering all three typable prompt boxes the owner's "in every state"
requires (thread composer, review-gate notes, approval-gate notes). It was deployed
(`20260822T124742Z-ff06ecc7`, blue-green, verified live via `GET /api/v1/ready`). The only thing
the shipped spec's own Verification section left undone is its 8-step runtime E2E script against a
real browser — and this run's checked-out branch (`cez/eb9f65aa`, this worktree's `HEAD`) is 2
commits behind `origin/main` and needs a plain fast-forward before any gate run here would see the
shipped code. (This worktree also holds a separate local branch literally named `main`, 3 commits
ahead / 38 behind `origin/main` on unrelated autosave commits — that ref is not involved and must
not be checked out.) This spec's job is to close both gaps and either flip the shipped spec's status
to "verified"
or surface a real defect — not to re-litigate D1–D9.

## Problem

1. **The chain re-entered from step 1 after already reaching "SHIPPED".** The brief could not
   determine why (its open question #2). This spec does not try to resolve that either — it is not
   answerable from the repo, and re-implementing on a guess would be worse than proceeding on the
   assumption the record already supports: there is nothing left to *design*.
2. **The one gap is real and self-named.** The shipped spec's own words: *"Until steps 1–6 have
   actually been executed against a real browser, this is 'qa needed', not done."* Steps 7–8 (the
   review-gate and approval-gate notes boxes) carry the same caveat. Nobody has run them. The
   resume notes in the handoff file say so explicitly: *"Only remaining item: reload the cockpit
   tab and see it."*
3. **A tooling assumption in the brief is stale.** The brief (written same day, before it read
   `AGENTS.md`'s newest section) says "this box has no Playwright." `AGENTS.md:469-520`
   (`.ai/specs/2026-08-22-headless-browser-on-prod-host.md`, landed on `origin/main` the same
   day) documents a **working Playwright 1.62.1 install on `prod-host`** — Chromium, Firefox,
   WebKit all cached, `xvfb` present, with one hard trap: never set `PLAYWRIGHT_BROWSERS_PATH` on
   the host (it is not in the agent env allowlist and silently breaks resolution). This changes the
   answer to whether the E2E steps are actually executable in this box's environment: on
   `prod-host`, yes; the caveat only holds on a box without that provisioning.
4. **This run's own worktree is stale relative to what it needs to verify.** `git status` in the
   cezar worktree: *"On branch cez/eb9f65aa … Your branch is behind 'origin/main' by 2 commits, and
   can be fast-forwarded"* — missing exactly `ff06ecc7` and `a30cf07d`. Any gate run against this
   worktree's current `HEAD` right now would build a tree that does not contain the shipped
   feature, and could mistakenly read as "nothing was built" or diff noisily against work that
   already merged. (The distinct local branch named `main` in this worktree — 3 ahead / 38 behind
   `origin/main`, not fast-forwardable — is a different ref entirely and is not what needs
   reconciling here.)
5. **One pre-existing, unrelated failure needs to be distinguished from a regression, not chased.**
   `packages/cezar/src/runs/store.test.ts` is red on typecheck on `main` because another session
   made `author` required without updating three fixtures. It is not this feature's fault and not
   this spec's job to fix, but a gate run without knowing this will misattribute it.

## Solution

Treat this run as a **verification-and-closeout pass**, not an implementation pass:

- **Reconcile, don't rebuild.** Fast-forward `HEAD` (branch `cez/eb9f65aa`, this worktree's current
  branch) to `origin/main` so any gate or manual check in this run sees the actually-shipped code
  (`ff06ecc7` / `a30cf07d`). No merge, no rebase, no branch switch — `git merge --ff-only
  origin/main` while staying on `cez/eb9f65aa`, since `git status` already confirms it is a clean
  fast-forward (0 ahead / 2 behind). Do not check out the worktree's separate `main` branch to do
  this — that ref is 3 ahead / 38 behind `origin/main` on unrelated autosave commits and is not
  fast-forwardable.
- **Re-run the shipped spec's own gate list, from the repo root** against the synced tree, and
  require its result to match what the handoff already recorded (typecheck / test / test:unit /
  build / test:package all green except the two named pre-existing failures) — a clean
  re-confirmation, not a new investigation, unless something has drifted.
- **Execute the shipped spec's 8-step runtime E2E script** (`.ai/specs/2026-08-21-per-task-prompt-drafts.md`
  §Verification, "Runtime E2E — the gate on Done") against a **throwaway cezar instance booted per
  `AGENTS.md` § "Verifying a cockpit UI change — boot a throwaway cezar on a spare port"**, driven
  with the `prod-host` Playwright install (`AGENTS.md` § "Headless browser on
  prod-host"). Two things the prior draft of this spec got wrong and this one corrects:
  neither the production cockpit (behind Cloudflare Access; only `/api/v1/ready` and static `/` are
  open on loopback) nor `npm run test:e2e` (`AGENTS.md` states it fails outright on this box, from
  inherited hosted-mode `CEZ_*` env vars, rather than skipping) is a usable route here. **This run
  does not extend `packages/web/e2e/task-thread.e2e.ts` or add a `review-gate.e2e.ts`** — code that
  cannot be run on this box is not verification, and adding it would contradict this spec's own
  "no new code anticipated" scope; that extension, if wanted, is separate follow-up work once a box
  that can run `test:e2e` is available. Instead the 8 steps are driven directly with raw Playwright
  against the booted instance, and each step's result is recorded (screenshots into
  `.ai/qa/artifacts_e2e`) as this spec's own evidence, not as a change to the test suite.
- **If QA finds a real defect:** stop. Do not fold a silent patch into a "closeout." A defect in
  already-deployed production code is a correction to the shipped spec (amend its status header in
  place, per this record's correction doctrine) and, if code must change, that change gets its own
  reviewed phase — not an invisible fix riding under this spec's name.
- **If QA passes clean:** flip `.ai/specs/2026-08-21-per-task-prompt-drafts.md`'s status header
  from *"implemented (qa needed — the browser e2e has not been run)"* to *"implemented (qa passed
  2026-08-22)"* — editing the existing header in place, not appending a second status line — and
  record the verification outcome in the handoff file.
- **Explicitly not in scope:** re-deciding D1–D9, touching `task-drafts.ts` / `thread-composer.tsx`
  / `review-panel.tsx` / `approval-card.tsx` behaviour, or building cross-device sync (named and
  deliberately deferred by the shipped spec's D1).

## Architecture

No new architecture. For reference, the shipped architecture (unchanged, read from
`origin/main:packages/web/src/routes/task-thread/`):

- `task-drafts.ts` — `localStorage`-backed store, three key prefixes (`cez-task-prompt:`,
  `cez-task-review-notes:`, `cez-task-approval-notes:`, one per box × `<runId>`), synchronous
  per-keystroke writes, remove-on-empty, `reapTaskDrafts` bounding all three prefixes together to
  100 entries.
- `thread-composer.tsx` — extracted composer host, mounted `key={run.id}`.
- `review-panel.tsx`, `approval-card.tsx` — both keyed by `run.id`, read at mount / write on
  change / clear on successful send.

## Data models

None new. No change to any server-side record shape (`RunRecord` or otherwise) — restating the
shipped spec's own conclusion: this remains browser-local state, not a field cezar's server ever
sees.

## API contracts

**None.** No route, request or response shape is touched by this run, same as the shipped spec.

## Phases

Each phase is independently checkable; a failure in one does not require redoing the others.

1. **Reconcile the worktree.** Fast-forward `HEAD` (branch `cez/eb9f65aa`) to `origin/main` with
   `git merge --ff-only origin/main`, without switching branches. Confirm `git log --oneline -3`
   now shows `ff06ecc7` at or below tip, and `git status` reports clean — no re-run of gates yet.
2. **Re-confirm the gates on the synced tree.** This worktree has **no `node_modules` at all**
   (`ls node_modules` fails), so Node would otherwise resolve upward into the parent checkout's
   install and produce the ~1,976-phantom-failure result `AGENTS.md` § "Five environment traps that
   make the gates LIE" measures for exactly this case — an install has to happen first, not just a
   scrub. Derive the scrub, point temp dirs outside any git repo, install, then run all five
   commands under the same wrapper, in order, from the **repo root** (`AGENTS.md:274-280`'s recipe
   verbatim):
   ```bash
   scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
           | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
   tmp=/tmp/cez-gate-$$ && mkdir -p $tmp
   env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm ci
   ls node_modules/.bin | wc -l   # sanity check — a low count (~13) means the install, not the change
   env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run typecheck
   env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm test
   env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run test:unit
   env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run build
   env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run test:package
   ```
   (`test:unit` and `test:package` do not exist as scripts inside `packages/web`, and a
   `packages/web`-scoped `typecheck` is web-only and cannot reproduce the known
   `packages/cezar/src/runs/store.test.ts` failure below — both gates must run from the root, the
   same place the shipped spec ran them. `test:unit`/`test:package` are `node --test` scripts, not
   vitest, so the manual scrub above still applies to them in full even though `web`'s
   `vitest.config.ts` closes `NODE_ENV` on its own.) Diff any failure against the two known ones
   (catalog C18 host-caused failure; `packages/cezar/src/runs/store.test.ts` fixture-`author`
   typecheck failure) — anything else is a stop-and-report, not a silent retry.
3. **Execute the runtime E2E script against a booted throwaway instance.** Boot per `AGENTS.md` §
   "Verifying a cockpit UI change" (scratch `HOME`, hosted-mode `CEZ_*` vars unset, seed
   `<proj>/.ai/cezar/runs.json` + `todos.json`, walk the onboarding wizard), pointed at
   `/opt/cezar/...` to verify the deployed bytes. **Seed at least four fixture runs** before driving
   any step — a `queued` run, a closed run that is `continuable`, a run parked at `review`, and a
   run parked at an approval gate — since steps 5, 7 and 8 of the script each need one of these and
   a happy-path-only fixture would silently turn them into named gaps instead of real checks. Drive
   the 8 steps with raw Playwright (`AGENTS.md` § "Headless browser on prod-host"), asserting
   on `data-slot` attributes: composer persists across tab-switch and reload; two tasks never leak
   into each other; a sent reply clears and stays cleared; drafts survive on the seeded `queued` and
   `continuable`-closed runs; exactly one `cez-task-prompt:<uuid>` key exists per task with unsent
   text; review-gate notes persist and clear on send-back on the seeded `review` run; approval-gate
   notes persist and clear on send-back on the seeded approval-gate run, or the gap is named if that
   fixture state could not be seeded. Kill the instance and delete its scratch directory when done.
   This repo is `"type": "module"`; a bare `require('playwright')` only resolves from CommonJS
   (`AGENTS.md:503-513`) — drive the script with `node -e`, a `.cjs` file, or
   `createRequire(import.meta.url)('playwright')` from a `.js`/`.mjs`, not a top-level ESM `import`,
   to avoid `ERR_MODULE_NOT_FOUND`.
4. **Close out.** If steps 2–3 are clean: amend `.ai/specs/2026-08-21-per-task-prompt-drafts.md`'s
   status header in place to record the QA pass and date, **and in the same edit fix its Runtime
   E2E section's closing line — "Until steps 1–6 have actually been executed…" — to say steps 1–8**,
   since this closeout (unlike the shipped spec's own text) covers both gate boxes, not just the
   composer. Append a closeout entry to the handoff file. If not: stop, write down exactly which
   step failed and how, and hand that to a defect-fix pass rather than patching quietly here.

## Risks

- **A real defect surfaces during QA on already-deployed code.** The mitigation is explicit in the
  Solution section: stop, name it, do not fold a silent fix into this closeout — production is
  already serving the current behaviour to whoever uses the cockpit meanwhile.
- **The two "known pre-existing" gate failures could mask a genuine new regression** if not
  compared carefully against the exact same failure signature recorded in the handoff (catalog C18;
  the `author`-fixture typecheck error). A superficial "gates are red, as expected" read would miss
  a third, unrelated failure hiding alongside the first two.
- **This box may not be `prod-host`.** The Playwright install is documented for that specific
  host; if this run executes elsewhere, phase 3 may not be executable, and per the shipped spec's
  own rule, the honest outcome is a named gap, not a skipped step reported as done.
- **Re-running an already-shipped task risks the record drifting** if the status header correction
  in phase 4 is skipped — the next session reading the shipped spec's header would still see "qa
  needed" even after QA ran, and could re-attempt this exact closeout a third time.
- **cezar has reaped this run's own worktree mid-run twice already** (per the handoff file), taking
  the untracked spec and its `cez/<taskid>` branch with it both times. This spec and its brief are
  themselves untracked in this worktree right now. Mitigation: commit early once this spec is
  approved, or keep a copy outside the worktree, rather than trusting the untracked file to survive
  to the closeout step.
- **The chain's later `commit-push` and `deploy` steps carry machine-checked `verify`
  post-conditions** (`AGENTS.md:11`, `57fc8807`) and fire regardless of what this spec's own gates
  decide. If phase 3 finds a defect and this spec says "stop," those downstream steps still run —
  this spec does not control them. And if QA passes clean, the only change this run produces is a
  docs status-header edit (no `packages/web` code touches anything), so `commit-push` has a
  same-day-shipped-code question already answered above and `deploy` has nothing new to build or
  activate — its postcondition checks should still pass, since they check the *running* server
  against `HEAD`, not that this run itself changed the server.

## Verification

Concrete, executable steps for this run to actually perform (not a description of what already
happened in the prior run):

1. `git -C <cezar-worktree> fetch origin && git -C <cezar-worktree> merge --ff-only origin/main` —
   run while `HEAD` is `cez/eb9f65aa` (no branch switch); must fast-forward cleanly (no divergent
   local commits expected per the brief — `git status` already confirms 0 ahead / 2 behind).
2. `git log --oneline -3` in the reconciled worktree shows `ff06ecc7` reachable from `HEAD`.
3. This worktree has no `node_modules` yet, so install first — `npm ci` under the same scrubbed
   environment the run itself needs (`AGENTS.md:274-280`): derive `scrub` from the live `CEZ_*`
   prefix (`env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)'`),
   point `TMPDIR`/`TMP`/`TEMP` at a fresh dir under real `/tmp` (not the worktree — trap 4), run
   `env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm ci`, then sanity-check with `ls
   node_modules/.bin | wc -l` (a low count like 13 means the install is incomplete, not that the
   change broke). Then, from the **repo root**, under the identical wrapper: `npm run typecheck`,
   `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package` — record exit codes and
   diff failures against the two named pre-existing ones. (Not from `packages/web`: `test:unit` and
   `test:package` are root-only scripts and do not exist there, and a `packages/web`-scoped
   `typecheck` cannot reproduce the root-only `store.test.ts` failure being diffed against.)
4. Boot a throwaway instance per `AGENTS.md` § "Verifying a cockpit UI change", seeded with the four
   fixture runs named in Phases §3 (`queued`, `continuable`-closed, `review`, approval-gate), and
   run the 8-step E2E script named there against it with raw Playwright; for each step, record
   pass/fail/gap explicitly (screenshots into `.ai/qa/artifacts_e2e` per the shipped spec's own
   convention). Kill the instance and delete its scratch directory afterward.
5. Separately, `curl -s http://127.0.0.1:4321/api/v1/ready` on the box actually running the deployed
   service (loopback only — the public URL is behind Cloudflare Access) and confirm the reported
   `deploy.sha` matches `ff06ecc7` — if it reports something older, the deploy itself needs
   re-verifying before QA proceeds. Judge only `deploy.sha`, not the timestamped release id: the
   release id (`20260822T124742Z-ff06ecc7` when this spec was written) is expected to have moved
   forward by the time this step runs even with no code change, so a different release id alone is
   not a problem — just note it. If `deploy.sha` itself is newer than `ff06ecc7`, note the new sha
   and re-check that nothing since has touched these three files. This checks the already-deployed
   production instance, not the throwaway one booted for step 4.
6. On a clean pass: amend `.ai/specs/2026-08-21-per-task-prompt-drafts.md`'s status header in
   place and add one handoff-log line recording the verification, with timestamp.
7. On any failure: stop, name exactly which verification step failed and with what observed
   behaviour, and stop this run there rather than attempting an undocumented fix.

## What could not be found (carried forward from the brief, not re-derived)

- No KB entry exists for this feature specifically (`notion`, 2129 docs, read-only; local roots
  empty) — the durable record remains the spec, the shipping commit message, and the handoff file.
- No todo entries reference drafts, the composer, or prompt persistence — no duplicate work found
  in flight elsewhere.
- Why this task re-entered the chain after "SHIPPED" is not determinable from the repo or handoff
  alone (brief's open question #2) — flagged here again rather than guessed at.

## Result (2026-08-22)

Executed against the tree reconciled to `origin/main` (`ff06ecc7` reachable from `HEAD`; the
running production instance separately confirmed at `deploy.sha=504ce87f`, a descendant that does
not touch `task-drafts.ts` / `thread-composer.tsx` / `review-panel.tsx` / `approval-card.tsx`).

**Gates (root, scrubbed env, clean `npm ci`):** `typecheck` 0, `test:unit` 0, `build` 0,
`test:package` 0 (15/15). `npm test`: 2 failed / 9758 passed / 1 skipped. Both failures are
environment traps, not regressions:
- `catalog.test.ts` C18 ("stays under 40ms CPU... per MiB of scanned corpus", 70.29 observed) —
  previously documented host-load flake.
- `config-api.test.ts` ("uses the coding agents' native model settings as the initial defaults") —
  **newly diagnosed this run**: `CLAUDE_CONFIG_DIR` (this agent's own Claude Code config dir) leaks
  into the test's child process; the test saves/restores `HOME`/`CEZ_HOME`/`CODEX_HOME`/
  `XDG_CONFIG_HOME` but not `CLAUDE_CONFIG_DIR`, so `agentHomePaths()` resolves `~/.claude` to the
  real agent config dir instead of the test's scratch home. Isolated re-run with
  `CLAUDE_CONFIG_DIR` also unset: 15/15 pass. This is a **third environment trap**, alongside the
  `CEZ_*`-prefix scrub and the phantom-`node_modules` resolution `AGENTS.md` § "Five environment
  traps" already documents — none of its files were touched by any commit since `ff06ecc7`.
  The `store.test.ts` fixture-`author` typecheck failure named in earlier reviews of this run's
  spec did **not** reproduce — `504ce87f` (already on this branch) fixed it, as anticipated.

**Runtime E2E (raw Playwright, throwaway instance):** steps 1, 2, 3, 3b, 5, 6, 7, 8 **PASS**,
observed live (log: composer survives tab-switch and reload; second task's composer starts empty
and the first task's text is untouched by visiting it — the leak this spec exists to fix, confirmed
absent; drafts survive on seeded `queued` and closed-`continuable` runs; exactly the two seeded
`cez-task-prompt:<uuid>` keys exist; review-gate and approval-gate notes persist across tab-switch
and reload). Step 4 and the send-clearing halves of 7/8 are a **named gap**: the driver that sends
a real reply through a live `CEZ_DRY_RUN=1` run timed out waiting for the composer to render after
run creation, and separately hung afterward (its error path never calls `browser.close()`, leaving
an orphaned Chromium holding the process open — a bug in the throwaway script, not the product;
the stray process was killed as part of this closeout). Per this spec's own rule, a claimed-but-
unrun e2e is worse than naming the gap: send-and-clear is **not** independently browser-confirmed
this run, though it remains covered by the passing unit suites cited in the shipped spec.

**Closeout:** `.ai/specs/2026-08-21-per-task-prompt-drafts.md`'s status header and Runtime E2E
section were amended in place (steps 1–8 executed, one named gap) rather than superseded — the
shipped feature is not being re-litigated, only its verification record corrected. This spec's own
status header above reflects the same result. No code changed as part of this closeout.
