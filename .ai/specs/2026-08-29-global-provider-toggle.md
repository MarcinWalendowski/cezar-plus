# Global provider toggle

**Status: Implemented (dispatch), QA Needed. CORRECTED 2026-08-30** — the gap this header
described is closed. D4's eight dispatch sites, D5's pool narrowing, D3b's two spawn gates and
admission branch, D3c's ladder rule, D4a's lock-aware fallback notes, D6/D6a's account
re-resolution and D4c's three remaining model-call paths (auto-naming, the task classifier, the
note triage pass) are wired and covered by `workflows/runner-lock-dispatch.test.ts` plus lock
cases in `task-classifier.test.ts`, `runs/auto-name.test.ts` and `notes/processor.test.ts`. Every
one of those was mutation-checked: unwrapping a site turns a named test red. Gates green
(`typecheck` 0 errors, `test` 12300 passed / 0 failed, `test:package` 25/25, `check:pack` ok).
**QA Needed, not Done**: the runtime E2E on `prod-host` (V8) has not been run.

**AMENDED 2026-08-30, later the same day — Phase 3 shipped too, and the D3c line above was
wrong.** The paragraph below said D3c's Settings note was outstanding; it is not, and never was —
it landed with the original feature commit and is covered by two paired cases in
`packages/web/src/routes/settings/resources-section.test.tsx`. The error came from reading Phase
3's own "also not shipped" bullet as a list of everything missing, when it was a list of what the
*commit's diff* did not contain. Its original text is struck through below.

**~~Still not shipped from this spec:~~** ~~Phase 2a (the cluster link — single-node installs are
unaffected), Phase 3's picker-fixed-rendering across the six composer/retarget surfaces and
`picker-pill.tsx`'s lock-conditional advisory copy, and D3c's Settings note beside the
"Account fallback" control. Those are UI honesty, not mechanism: the lock now governs what runs,
but the pickers still render as though they were free.~~

**Still not shipped: Phase 2a alone** (the cluster link — single-node installs are unaffected).

**Phase 3 is now wired.** Every engine picker renders the locked provider as fixed rather than
free: the menu narrows to it, the provider-spanning `balance · everything` row goes away, the
`ADVISORY_NOTE` footer is replaced by `lockDisclosure(runner)`, and **model and same-provider
account selection are untouched** (D6a). The resolution happens at three points — `RunnerPill`
(the menu and the label, for all six surfaces at once), `useResolvedEngine`, `new-task.tsx` and
`useContinuationProvider` — through one pure `effectiveLock(lock, available)` that returns `null`
for a lock this host cannot honour, which is D3 restated where a picker can read it.

**One surface the Phase 3 file table missed: `retarget-menu.tsx`.** The header's and the mobile
menu's "Run on…" is a second renderer of `useRetargetAction`, and its entire content is a list of
providers — so it was the clearest possible place for the contradiction to survive ("Run on
claude" posting `{runner:'claude'}` and producing a codex run). `useRetargetAction` now narrows
its `runners` to the lock and the menu names the reason. Cases in
`packages/web/src/routes/task-thread/retarget-hint.test.tsx`.

Verification: V5d's cases, each paired with the unlocked control, in
`agent-pool-rows.test.tsx` (10), `engine-pills.test.ts` (6), `new-task.test.tsx` (6),
`follow-up-engine.test.tsx` (3), `retarget-hint.test.tsx` (3) and `new-task-form.test.ts` (4).
**Fourteen mutations, fourteen named reds** — one per lock-aware branch, including the two that
only the request-body assertions catch (`runnerExplicit` under a lock that equals the project
default, and a `pool:*` draft under a lock).

The original text follows unchanged, as the record of what was true until 2026-08-30.

**SUPERSEDED 2026-08-30 by the correction above:** ~~Partially implemented. Committed as
`58f5ede5`, merged into `origin/main` as
`b3a7c153`. Gates (`test:package`) were green and the merge landed, but **the mechanism this spec
exists for — D4's dispatch-time enforcement — was not wired**, so a lock set today does not change
what provider a run or step actually executes on. See "Known implementation gap" immediately
below, written 2026-08-29 by this spec's own documentation step after re-reading the landed diff
line by line. **Do not run V8. Do not read this as `Implemented` or `QA Needed` in the
gates-passed-so-it-works sense** — V8 would fail on acceptance criterion 3 as shipped. What
genuinely landed: the storage/contract layer (D7), the pre-flight 409 entry gates (D4b, in
`provider-action-gate.ts`), the `onRunnerLockChanged` queue-clear hook (D7a), the shell UI (D9,
`EngineLockBar` + the onboarding narrowing), the Settings mirror, and the pure, unit-tested
`applyRunnerLock` helper that nothing calls yet.~~
**Date:** 2026-08-29
**Repo:** `cezar`
**Read at:** `95b93175` (worktree `41f30bd7-8553-4f88-9b96-04d6aaf64714`, clean, branch `cez/41f30bd7`)
**Brief:** `.ai/specs/briefs/2026-08-29-global-provider-toggle.md` (written by step 1 of this run into
the MAIN checkout, `/var/lib/cezar/loki-labs/cezar/.ai/specs/briefs/`, not into this worktree, it is
therefore not in this branch's diff and the next reader should look for it there)

**On the spec number.** The task framing says to take a number from `tools/next-spec`. **That
allocator does not exist in this repository** (`ls tools/` → no such directory; `scripts/` holds
`activate-main.sh`, `dev.mjs`, `release-snapshot.mjs`, `release.mjs`, `write-build-stamp.mjs`). cezar
names specs `YYYY-MM-DD-kebab-title.md` and does not number them at all, all 207 files in
`.ai/specs/` follow that form. This file follows the repo's own convention rather than inventing a
numbering scheme, and the instruction is recorded here rather than silently ignored.

**Extends:**
`.ai/specs/2026-08-24-codex-only-default-workflow.md` (`pinWorkflowRunner`, the codex sibling, and D8, which this spec inverts),
`.ai/specs/2026-08-23-never-block-a-task.md` (availability outranks a pin, **upheld**, see D3),
`.ai/specs/2026-08-23-step-runner-account-resolution.md` (`resolvePoolForProvider`, the narrowing this reuses),
`.ai/specs/2026-08-23-retarget-task-to-another-engine.md` ("Run on…", and the advisory copy this changes),
`.ai/specs/2026-08-21-one-settings-area.md` (where the mirrored setting lives, and `appliesTo`),
`.ai/specs/2026-08-24-codex-step-model-and-effort.md` (`byRunner`, which is why forcing a runner needs no model work),
`.ai/specs/2026-08-25-logged-out-account-fallback.md` (the credentials tier the pool narrowing must keep honouring).

**Decides, as a new decision, the question todo `81ab4ebd` closed by declining it.** That todo
("Decide whether an explicit per-task runner should constrain the account pool", status **done**,
read from `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json` (the **main checkout**, since
`.ai/cezar/` in this worktree holds only `knowledge-index/`) was resolved on 2026-08-23 in favour of
the advisory branch, and its
resolution note says, verbatim: *"A hard pin would be a new decision and a new setting, not a
correction of this one."* This spec is that new decision and that new setting. It does not reopen
`81ab4ebd`; it supersedes the scope of its answer for the case where a lock is set, and leaves the
unlocked behaviour exactly as `81ab4ebd` left it.

## Known implementation gap — CLOSED 2026-08-30

**The heading said "Known implementation gap (written 2026-08-29, this document step)" and the
gap is now closed.** Amended in the heading, not only in the body, because a reader scanning
headings must not carry away a falsehood.

**What closed it, and what the gap cost in the meantime.** The gap was found in production on
2026-08-30 by the owner, from the symptom rather than the code: a task created in the composer
with **Codex** checked, on a workspace whose shell-bar lock was **Codex**, ran on
`anthropic/sonnet`. Run `2ac77920-d5e5-4695-97da-70bba72c87a4` in project `cezar`, and its own
event stream is the whole diagnosis:

```
run.workflow.selected   requestedRunner: "codex"
run.account_fallback    site: "pool", requestedRoute: "pool:*",
                        selectedProvider: "claude", selectedAccount: "claude:secondary"
lifecycle               run started — workflow "quick-task" (runner: claude)
note                    model: anthropic/sonnet
```

**Two mechanisms, and the lock was only one of them.** `/var/lib/cezar/.cezar/agent-accounts.json`
on that box has `defaults: { claude: "pool:*", codex: "pool:*" }`, so a request naming `codex`
with no explicit account looked up **codex's own default account setting** and got a route that
spans every provider — which then re-picked the provider and discarded the pick that had produced
the lookup. `runnerLock: "codex"` was set in `~/.cezar/config.json` and, per this section, reached
nothing. Neither control could win, and the failure was silent in the direction that matters: the
cockpit rendered `codex` on the bar and `codex` on the pill while the run executed on Claude.

That `pool:*` behaviour was already known and already written down —
`workflows/step-runner-account.test.ts`'s fixture comment says *"a wildcard pool picks the
PROVIDER as well as the login ... That is a real bug, but it is a different one"* — which is why
the negative control in `runner-lock-dispatch.test.ts` asserts it still happens **unlocked**. D5
narrows the pool under a lock; it deliberately does not redefine `pool:*` (todo `81ab4ebd`
decided that separately, in favour of the wildcard). **A user who wants their composer pill to
beat a wildcard pool with no lock set is still not served, and that is a live open question, not
an oversight of this change.**

The original finding follows unchanged.

**CORRECTED 2026-08-30 — wired. The paragraph below was true from 2026-08-29 to 2026-08-30.**
~~The dispatch-time mechanism (D4) — the entire reason this spec exists — is not wired.~~
Measured directly against `b3a7c153` (`origin/main`), by grepping every file the feature commit
(`58f5ede5`) touched or should have touched:

- `run.ts` imports `applyRunnerLock` (`workflows/run.ts:119`) and **never calls it.** `grep -n
  "applyRunnerLock(" packages/cezar/src/workflows/run.ts` (a call, not the import/declaration)
  returns nothing. None of D4's eight dispatch sites — `resolvePoolForDispatch`'s
  `fallbackProvider`, `taskBackend`, the per-step `backend = downgrade?.runner ?? step.runner ??
  taskBackend`, `downgradePinnedRunner`, `rerouteExplicitAccountIfUnavailable`, `heldAccountFor` —
  reads the lock. `run.ts`'s entire diff against pre-feature `main` is 24 lines: the import, the
  `onRunnerLockChanged()` hook (D7a, clears `heldAtSpawn`/`heldNotified` on a lock change — real,
  but it is cleanup for a mechanism that doesn't otherwise exist), and nothing else.
- `input.runner` is never assigned from `runnerLock` anywhere. `grep -n "input\.runner\s*="
  packages/cezar/src/workflows/run.ts packages/cezar/src/server/server.ts` returns nothing. The
  route that starts a run from a workflow (`server.ts:6604-6607`) passes `runner:
  parsed.data?.runner` — the caller's raw request — straight into `manager.startRun`, lock or no
  lock.
- `provider-action-gate.ts`'s requirement builders **do** read `runnerLock` (D4b — confirmed
  wired, e.g. `:201-214`), but that machinery answers one question only: *is this HTTP action
  allowed to proceed* (a pre-flight 409 check against account viability). It is disconnected from
  what `RunManager` actually dispatches on. A gate computed against the locked provider can pass
  while the run it lets through still executes on whatever `config.defaultRunner` /
  `input.runner` / `pool:*` / `step.runner` would have picked anyway — which is unaffected by any
  of this, per the two bullets above.
- `runner-lock.test.ts` — the only test file for `applyRunnerLock` — unit-tests the pure function
  in complete isolation (three cases, no `RunManager`, no dispatch). **No test anywhere asserts
  that a run with a lock set actually executes on the locked provider.** `run-tests` reporting
  green is exactly what you'd expect from a gap with no coverage, not evidence against this
  finding.
- **Consequence for the acceptance criteria:** criterion 3 ("a newly started run … executes EVERY
  step on claude … including a project whose settings and `pool:*` account selection would
  otherwise have chosen codex") is false as shipped. A locked project whose `defaultRunner` is
  codex still dispatches on codex.
- **CLOSED 2026-08-30 — ~~Also not shipped:~~** the picker rendering below shipped later the same
  day; see the amendment at the top of this file for what landed and where it is verified. The
  original bullet, unchanged: ~~Phase 3's picker-fixed-rendering across the six surfaces D2 rank 5 / D6
  name (`engine-pills.tsx:168`, `new-task.tsx`, `follow-up-engine.tsx`, `retarget-engine.tsx`,
  `inbox.tsx:347`, `github/hand-to-agent.tsx:265`) and P6's lock-conditional `ADVISORY_NOTE` string
  in `picker-pill.tsx`. None of those five component files, nor `picker-pill.tsx`, appear in the
  feature commit's diff. What *did* ship of Phase 3: the `AppShell` `globalBar` slot, the
  `EngineLockBar`/`EngineLockBarContainer` pair, the Settings → Providers mirror, and the D3c
  `resources-section.tsx` copy.~~

**What is genuinely true and durable regardless of this gap:** the *decision* — D2's precedence
table and D3's "overrides settings, not availability" ruling — was made, reviewed thirteen times,
and is sound. What is missing is entirely mechanical follow-through: threading `applyRunnerLock`
(already written, already unit-tested) through the eight call sites D4 already enumerates by name
and line. A todo is filed for this (see Tracker sync in this step's report) rather than fixed here,
because writing dispatch-path code is implementation work, not documentation, and doing it without
a fresh implementation+test pass would repeat the exact failure mode this note exists to catch.

## TLDR

The owner's task: a control **fixed at the top of every cockpit screen** that switches the whole
platform between Claude and Codex and **wins over every other provider setting, for every workflow**.

Nothing at that scope exists. Five separate mechanisms decide which provider a step runs on today,
and at `95b93175` a user has no way to sit above any of them:

| # | mechanism | where | beats |
| --- | --- | --- | --- |
| 1 | `config.defaultRunner` (project) / `agentDefaults.runner` (machine) | `run.ts:5522` | nothing |
| 2 | `input.runner`, the composer's engine pill | `run.ts:5522` | #1 |
| 3 | `pool:*` provider substitution | `run.ts:5487,5522`; `agent-route-select.ts:263-271` | #1, #2 |
| 4 | `step.runner`, a workflow step pin (incl. the whole `spec-to-deploy-codex` sibling) | `run.ts:7045` | #1, #2, #3 |
| 5 | `downgradePinnedRunner`, quota/credentials fallback | `run.ts:3397-3478`, called at `:7036-7045` | #4, and therefore all of them |

**The solution is not a sixth workflow variant.** `pinWorkflowRunner` (`types.ts:1778-1788`) is
already generic over `RunnerId`, but the registration that uses it (`load.ts:87-99`) is a hardcoded
`if` block for exactly one provider on exactly one workflow, and `startRun` **freezes the resolved
`workflowDef` onto the run record**, so a derivation-time pin is a per-workflow, per-provider
combinatorial and is frozen at start.

**The solution is a workspace-scoped `runnerLock` read at DISPATCH.** One nullable key in
`~/.cezar/config.json`, live-applied into the in-memory snapshot every `RunManager` already reads
synchronously, consulted through one pure function at the eight dispatch sites D4 enumerates (which
is where all five mechanisms above resolve). It reaches every workflow,
built-in, file-defined and derived, with no per-workflow work, applies to a run already in flight
at its next step, and is byte-for-byte today's behaviour when unset.

**The precedence ruling, stated up front because it is the thing this spec exists to settle:**

> **The toggle overrides every SETTING. It does not override AVAILABILITY.**
>
> It beats the project default, the machine default, the composer's engine pill, a `pool:*`
> provider hop, a workflow step pin, the `spec-to-deploy-codex` sibling, a follow-up runner
> override, and the per-task "Run on…" retarget. It does **not** beat `downgradePinnedRunner`:
> when every account of the locked provider is out of quota or logged out, work moves to the other
> provider and says so, loudly, in the run. And when **no** account is runnable anywhere, the work
> waits, exactly as it does today, because "proceed on the next available provider" has no meaning
> when there is no next available provider (D3a).

The two owner rulings only *look* like they collide. The 2026-08-29 instruction is about **settings**
("overriding every other runner setting"); the 2026-08-23 ruling is about **availability** (*"Task
should never be blocked. if model is unavailable or limit is hit it should always automatically
proceed on next available provider & model"*). Being out of quota is not a setting. Read that way
both rulings stand in full, and `.ai/specs/2026-08-23-never-block-a-task.md` is **upheld, not
superseded**. D3 states the alternative that was rejected and why.

## Problem

### P1. There is no always-visible surface to put the control on

Measured directly in `packages/web/src/components/app-shell.tsx` at `95b93175`:

- the main column is a four-row grid, `grid-rows-[auto_auto_1fr_auto]` (`:299`);
- row 1 is `MobileTopBar` (`:300`), and `MobileTopBar` itself is `md:hidden` (`:953`), **mobile
  only**;
- row 2 is a *conditional* banner slot, `{!chromeless && banner ? … : null}` (`:302-306`), whose only
  caller passes `<ProviderBannerContainer/>` (`app-shell-container.tsx:178`);
- rows 3 and 4 are `main` and an empty composer dock.

Desktop chrome is the **sidebar** and nothing else. **There is no desktop top bar at all.** So this
is genuinely new shell surface, not a Settings-page control, and the task's own acceptance criteria
say so ("a shell-level region, not the mobile-only MobileTopBar").

The brief flagged, correctly, that the task framing named `apps/web/src/components/app-shell.tsx`.
That path does not exist. The file is `packages/web/src/components/app-shell.tsx`.

### P2. `pool:*` is the production default and already defeats an explicit provider choice

`resolvePoolForDispatch` (`agent-route-select.ts:240-295`) parses the task's route, or the project's
stored selection for `fallbackProvider`, and on a wildcard `pool:*`:

```ts
const all = poolCandidates(route, listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS));  // :268
```

`poolCandidates` (`:106-112`) filters by provider **only when the route names one**; a bare `pool:*`
returns every profile-capable account of every provider. The chosen account's provider then wins
outright:

```ts
const taskBackend: RunnerId = chosen?.provider ?? input.runner ?? config.defaultRunner;  // run.ts:5522
```

with the comment at `run.ts:5483-5484` stating this is deliberate: *"`pool:*` picks the PROVIDER too,
which is why this sits above `taskBackend` rather than inside the account lookup."* KB
`notion-4dee7a4df2f1` records the user-visible consequence: *"a task created explicitly on codex can
be dispatched to a claude account… The per-task provider picker had no effect at all."*

`domains/cezar.md:39` is cited by the task framing as saying `pool:*` is the production default;
this spec did not independently read `~/.cezar/agent-accounts.json` on `prod-host`, and
V8 makes that a **measured precondition of the live run** rather than an assumption.

**So a toggle that does not re-order pool resolution fails the task's own acceptance criterion 3**,
which requires the Claude-locked run to hold on a project "whose settings and `pool:*` account
selection would otherwise have chosen codex".

### P3. A step pin outranks everything a user can currently express

`run.ts:7045`: `const backend = downgrade?.runner ?? step.runner ?? taskBackend;`

Read directly from `SPEC_TO_DEPLOY_WORKFLOW` at `95b93175`, because the summary carried over from
`.ai/specs/2026-08-24-codex-only-default-workflow.md` P1 is **stale**: that spec's table describes a
nine-step chain with two pins, and the chain has since grown a tenth stage. Current facts:

**Ten agent stages**, in order: `context`, `spec`, `review-spec-local`, `review-spec`, `implement`,
`run-tests`, `commit-push`, `merge`, `document`, `deploy`.

**Three authored runner pins, not two:**

| step | `runner` | source |
| --- | --- | --- |
| `spec` | `'claude'` | `SPEC_AUTHORING_RUNNER` (`types.ts:911`) |
| `review-spec-local` | `'claude'` | `SPEC_AUTHORING_RUNNER`, the stage the older spec predates |
| `review-spec` | `'codex'` | literal, with `byRunner.claude` as its fallback |

The other seven stages name no runner. The `spec-to-deploy-codex` sibling pins **all ten**. So a lock
set to Codex has **two** Claude-pinned stages to override, not one, and the count that matters for
the hot-path arithmetic in D3 is ten, not nine.

`.ai/specs/2026-08-24-codex-only-default-workflow.md` **D8** states the rule this spec inverts, in as
many words: *"When the engine pill and the workflow disagree, the workflow wins, visibly."*

A "toggle overrides every runner setting" inverts D8 for the runner dimension. That is a reversal of
a decision made five days ago and it has to be written down as one.

### P4. The one standing ruling that genuinely points the other way

`.ai/specs/2026-08-23-never-block-a-task.md`, owner verbatim: *"Task should never be blocked. if
model is unavailable or limit is hit it should always automatically proceed on next available
provider & model."* KB `notion-5ce876561d8f`: *"An engine choice is now a preference, and a
preference never stops work."*

The mechanism is `downgradePinnedRunner` (`run.ts:3397-3478`), gated on
`this.semaphore.fallbackAcrossAccountsWhenLimited()` (**default `true`**, `semaphore.ts:143,321-322`),
keyed on **every** account of the pinned provider being unusable (`:3407-3409` returns `undefined` the
moment one is runnable). It emits a `note` and a `run.step.runner_downgraded` metric and returns the
substitute provider, which `run.ts:7045` then prefers over the pin.

If the toggle is absolute, a Claude-locked workspace with every Claude account held stops working
entirely. That is the reversal this spec declines to make. D3 settles it.

### P5. The narrower, still-open ask this must not duplicate

Todo `3c0639ea-e8de-4f38-a743-3dbda53e88d3`, **status `todo`, priority high**, filed 2026-08-22
(read directly from `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json`, the main checkout: the
worktree this spec is written in has no `todos.json`, only `.ai/cezar/knowledge-index/`, the same
reason the header gives the brief's absolute path). Summary: *"Per-step model and runner policy
belongs in
global settings, and the 'rest' should load balance across codex and claude."* Owner instruction
verbatim: *"writing spec + spec review should be by opus always, the rest can be load balanced by
codex or claude sonnet (add a task to add this type of configuration to settings global)."*

Its acceptance criteria ask for a **settings-editable per-step policy table** and for a step that can
name a **set** of acceptable runners to load-balance across. That is a strictly more nuanced
mechanism than a single blunt global pin, and it is not what this task asks for. D8 below rules on
the relationship rather than leaving two overlapping items open.

### P6. The picker's own copy becomes false under a lock

`packages/web/src/components/picker-pill.tsx:169-170` ships this line, shown whenever
`fallbackAcrossAccountsWhenLimited` is on (`:222`, `:285`):

> `'Preference, not a pin — a rate-limited or logged-out agent is skipped for the next available one.'`

Under a lock the picker is not a preference at all, it is inert for the provider dimension. Leaving
that sentence in place would make the UI state the opposite of what the platform does.

Two test files exercise that string today:
`packages/web/src/routes/task-thread/follow-up-engine.test.tsx:424,435,445` (note the path: it is
**not** under `components/`) and `packages/web/src/components/agent-pool-rows.test.tsx:144,155,169`.
**Be precise about what that coverage does and does not buy**, because it is easy to overstate: both
files import `ADVISORY_NOTE` as a **symbol** (`follow-up-engine.test.tsx:13`,
`agent-pool-rows.test.tsx:5`), so rewording the existing string reddens **nothing**. What needs new
cases is the second, lock-conditional string and the condition that chooses between them: which is
what Phase 3 actually schedules. The existing assertions still matter as the unlocked control: they
pin that the advisory line is unchanged when no lock is set.

## Solution

### D1. A dispatch-time lock, not a derived workflow

The lock is a **workspace value read when a step is dispatched**, not a property stamped onto a
workflow definition. Three reasons, each of which independently rules out the derivation route:

1. **`startRun` freezes the resolved `workflowDef` onto the run record** and `reviveWorkflow` prefers
   that frozen copy (recorded in todo `3c0639ea`'s own context, which describes having had to patch
   `runs.json` by hand with the service stopped for exactly this reason). A pin applied at derivation
   is frozen at start and cannot be changed for a run in flight.
2. **It does not scale.** `load.ts:87-99` is a hardcoded `if (!fileNames.has(SPEC_TO_DEPLOY_CODEX_NAME))`
   block, not a loop. "Every workflow, always" via derivation is one registration block per workflow
   per provider, and a repo shipping its own `foo.yaml` gets nothing.
3. **It cannot reach the pool.** Pool substitution happens *above* the workflow (`run.ts:5487`), so no
   amount of step pinning constrains which provider the balancer picks for the run.

### D2. Precedence: the ruling, exhaustively

Highest first. Everything below the line is a **setting** and the lock beats it; the one thing above
is **availability** and it beats the lock.

| rank | thing | under a lock |
| --- | --- | --- |
| 0 | `downgradePinnedRunner`, every account of the locked provider held or logged out | **wins over the lock**, loudly (D3) |
| 1 | **`runnerLock`** | - |
| 2 | `step.runner`, including every step of `spec-to-deploy-codex` | overridden (inverts D8 of the codex spec) |
| 3 | `pool:*` provider substitution | narrowed to the locked provider; still balances ACCOUNTS within it (D5) |
| 4 | per-task "Run on…" retarget, and a follow-up's runner override | provider fixed; **model** still chosen, and the account is **re-resolved** for the locked provider, never carried across (D6) |
| 5 | `input.runner`, the composer engine pill | overridden; the paired `input.agentProfile` is re-resolved, not kept (D6) |
| 6 | `config.defaultRunner` (project) / `agentDefaults.runner` (machine) | overridden |

**Applies to a run already in flight**, at its next step dispatch, not only to new runs. That is
what "global" has to mean for the control to be usable as a recovery lever ("everything is stuck on
codex, flip it"). The cost is stated in R2.

**Does not apply when unset.** `runnerLock: null` is the default and is today's behaviour byte for
byte, at every one of the sites below.

### D3. never-block-a-task is UPHELD. The lock loses to AVAILABILITY

**Ruling: a locked provider whose accounts are ALL unusable still downgrades to the other provider,
exactly as today.** `.ai/specs/2026-08-23-never-block-a-task.md` and KB `notion-5ce876561d8f` stand
unamended.

**"Availability", not "quota", and the heading said quota until this revision.** Quota is only one of
the two causes `downgradePinnedRunner` handles: it computes `cause: 'quota' | 'credentials' |
'quota+credentials'` (`run.ts:3421-3423`) from `waitable` (out of quota) and `disconnected` (logged
out) accounts, and it crosses providers for either. A logged-out account is no more a *setting* than
an exhausted one, so both belong on the availability side of this spec's central distinction; naming
only quota would have left the credentials path looking unruled while the code crossed the lock for
it anyway. `.ai/specs/2026-08-25-logged-out-account-fallback.md` is the spec that added that second
cause, and it is extended, not narrowed, here.

Three reasons this is the right side of the trade, written out because the opposite reading of the
owner's sentence is available and someone will have it later:

1. **The two instructions are about different objects.** "Overriding every other runner *setting*"
   and "a task is never *blocked*" are only in tension if quota exhaustion is a setting. It is not:
   nobody set it, and it clears itself.
2. **The failure mode of the other choice is total.** One person flipping a switch on a shell bar
   present on every screen would silently convert every future quota window into a full stop for the
   whole workspace, on every project and every node. That is a large blast radius for a control whose
   entire affordance is "click me".
3. **Zero config forbids the escape hatch.** The obvious mitigation is a "strict" sub-mode. AGENTS.md
   § Zero config: *"When a feature seems to need configuration, the design is wrong."* A blunt
   platform switch that needs a modifier is not a blunt platform switch. **A strict mode is an
   explicit non-goal.**

What changes instead is **visibility**, on the theory that a degraded promise must be loud rather
than prevented (the same theory `.ai/specs/2026-08-24-codex-only-default-workflow.md` D6 applied to
the codex sibling):

- the existing `note` at `run.ts:3432-3440` already names the substitution; under a lock its text
  says the **lock** is what was asked for, not the step (`this workspace is locked to claude, and
  every claude account is out of quota, running on codex:default instead`);
- **the park note gets the same treatment**, and it is a second string, not the same one.
  `holdStepOnWaitableAccount` composes its own message at `run.ts:3502-3504` (*"this step asks for
  ${pinned}…"*), and under a lock `pinned` is the lock's value, so an unamended note tells the user
  the **step** asked for something the **workspace** asked for. Both notes are lock-aware or
  neither is: the runnable path and the park path are the two halves of the same story, and D3a
  made the park path reachable under a lock in the first place. V3's park case asserts the phrasing,
  not merely that a note exists;
- the existing `run.step.runner_downgraded` metric gains a `lockedRunner` field, so a
  downgrade-under-lock is countable separately from an ordinary step-pin downgrade;
- **the divergence is reported per RUN, in the run, and NOT on the bar.** An earlier draft promised
  the bar would read `Claude · running on Codex` while the run loop was downgrading. **That promise
  is withdrawn**, because it named no data source and no lifecycle: there is no API contract that
  exposes workspace-level downgrade state, no rule for what the bar shows when two runs disagree
  (one downgraded, one not), and no rule for when the indication clears. Inventing an aggregated,
  push-updated "is anything currently downgrading" signal is a second feature with its own
  transport, its own multi-run semantics and its own staleness bug, and it is not what the task
  asked for.

  What ships instead is honest and already has a home: the `note` and the two metric events above,
  which live **on the run** and are read in the thread where the divergence actually happened. The
  bar states the **setting** (`Auto` / `Claude` / `Codex`), which is a fact it owns and can always
  render truthfully, and nothing more. A bar that says `Claude` therefore means "Claude is what is
  asked for", never "Claude is what every in-flight step is on": and D3 is the paragraph that makes
  that distinction true rather than a weasel.

  If an aggregated indicator is wanted later it is a follow-up with its own spec, needing at minimum:
  a server-side source of truth, a WebSocket topic (per the repo's "add a topic, never a second
  socket" rule), a defined multi-run reduction, and a clearing rule.

One consequence that must be stated because it widens a hot path: **under a lock, every agent step
goes through `downgradePinnedRunner`**, because every step is effectively pinned. Today only steps
carrying an explicit `runner` do (`run.ts:7036`: `const pinned = step.runner ?? undefined`). Per P3's
re-read of the current chain, that is **ten** evaluations per `spec-to-deploy` run instead of
**three** (`spec`, `review-spec-local`, `review-spec`), each two `readFile`s. It is the same widening
`spec-to-deploy-codex` already shipped, which pins all ten.

The comment at `run.ts:3438-3441` states that widening with the **old** counts: *"nine steps can
downgrade on `spec-to-deploy-codex` where the default chain has two"*, and both numbers are stale at
`95b93175` for the same reason P3 records: `review-spec-local` was added after that sentence was
written. **Phase 4 corrects it in place** along with the other doc comments, to ten and three.
Precedented, and measured by V3.

**D3a. What `waitable` actually means, and why the lock does NOT get to discard it.** An earlier
draft of this subsection ruled that a lock-supplied pin should discard a `waitable`-only downgrade
and "spawn on the locked provider anyway", on the theory that the lock must never add a wait. **That
was wrong, and it is corrected here rather than quietly dropped**, because it would have produced the
worst outcome in the whole design: a spawn on a provider with no usable account.

Read `downgradePinnedRunner` (`run.ts:3407-3416`): it returns early when any account of the pinned
provider is `runnable`, and it only reaches the `waitable` tier when `runnable.length === 0`,
meaning **no runnable account exists anywhere, on any provider**. `holdStepOnWaitableAccount`
(`run.ts:3494-3509`) is what that state is for: it spawns nothing, writes a note naming the account
and the window, and arms auto-resume. Its sibling gates do the same at their own layers
(`holdRunOnAccount` for a run, `parkContinuationOnAccount` at `run.ts:4747` for a continuation, whose
comment says in as many words that nothing may spawn because there is no `requeueWhileHeld` behind
that caller).

**Ruling: all three parks are preserved under a lock, unchanged.** When no runnable account exists,
the honest answer is a visible appointment with a real `autoResumeAt`, which costs no quota and
recovers by itself. Spawning into that state does not make a task un-blocked; it makes it fail, on a
login nobody could have used, and then park anyway one turn later having burned the attempt.

This is consistent with, not an exception to, the ruling in D3. "A preference never stops work"
means work proceeds **on the next available provider**: the owner's own words are *"always
automatically proceed on next available provider & model"*. When there is no next available provider,
waiting is what the standing ruling already prescribes, lock or no lock, and `run.ts:3689-3696`
records the same conclusion being reached the hard way once before: *"The ruling is that a task
proceeds on the next AVAILABLE provider; when there is none, a visible appointment with a real
`autoResumeAt` is the honest answer and costs no quota."*

So the precise claim D3 makes is narrower than "the lock never causes a wait", and it is stated that
way from here on: **the lock never causes a wait while a runnable account exists.** D3b is what makes
that true at the gates above dispatch; this subsection is what keeps it from overreaching at
dispatch. V3 asserts a park with a visible appointment and **no spawn** for the no-runnable-account
case, not a spawn on a disconnected provider.

**D3c. An active lock turns the availability ladder ON, regardless of
`fallbackAcrossAccountsWhenLimited`. That setting governs Auto mode only.** Without this rule the
lock has a hole that is worse than either behaviour it is built from, and it is only reachable by
combining two decisions this spec already made.

`fallbackAcrossAccountsWhenLimited` is read at exactly **three** places in `run.ts`, and all three
matter here (`grep -n 'fallbackAcrossAccountsWhenLimited()' packages/cezar/src/workflows/run.ts` →
`:2159`, `:3297`, `:3402`):

| site | effect when the setting is off |
| --- | --- |
| `heldAccountFor` (`:2159`), at **admission** | holds a queued run whose record names a held account (D3b item 3) |
| `rerouteExplicitAccountIfUnavailable` (`:3297`) | returns `undefined`, no cross-provider reroute |
| `downgradePinnedRunner` (`:3402`) | returns `undefined`, no downgrade |

It defaults to `true` (`semaphore.ts:143`), but a workspace may turn it off, and one that has says
"do not move my work off the account I named".

Now compose that with D3b, which bypasses the pre-dispatch holds for a **lock-chosen** account. With
the setting off, a lock on a fully held or logged-out provider produces **two distinct failures at
two different layers**:

- **at admission**, `heldAccountFor`'s own-account branch holds the run at dequeue on the account the
  *record* names, and the lock never reaches any layer below (D3b item 3);
- **at dispatch**, if it does get through, `downgradePinnedRunner` returns `undefined` before it ever
  looks at the other provider, `backend` stays the locked provider, and the step **spawns on a
  provider with no usable account**. That is the precise failure D3a exists to prevent, arrived at
  from the opposite direction: not by discarding a `waitable` result, but by never computing one.

**Ruling: when `runnerLock` is set, all three sites run as though
`fallbackAcrossAccountsWhenLimited` were `true`.** The reasoning is that the setting and the lock are
answers to two different questions, and only one of them is being asked at a time:

- with **no lock**, the provider a run lands on is the user's own choice (pill, project default,
  pool), and the setting decides whether cezar may move work off it. Unchanged, in full;
- with a **lock**, the provider is *not* a per-run choice: it is a platform-wide routing rule the
  same user set on the shell bar. "Do not move my work off the account I named" has no referent,
  because they did not name an account for this run; they named a provider for the workspace. What
  the lock asks for is that work run on that provider **when it can**, and D3 has already ruled that
  availability outranks it when it cannot.

The alternative (honouring the setting under a lock) is strict mode by the back door: it would
make a locked run stop dead on an exhausted provider, which D3 rejected on the merits and which
`.ai/specs/2026-08-23-never-block-a-task.md` forbids. Having rejected strict mode as an explicit
opt-in, this spec must not reintroduce it as an emergent property of two settings interacting.

**What this does not do:** it does not change the setting's stored value, its meaning in the API, or
its behaviour for any unlocked run on the same machine. Clearing the lock restores it exactly. V3
covers the composition.

**What it DOES require, in a named file, because a ruling that makes existing copy false owes that
copy a fix.** The control lives in `packages/web/src/routes/settings/resources-section.tsx`: its
rationale comment at `:101-112`, the value read at `:113`, and its two toasts at `:118-121`. The
**off** toast currently promises *"Tasks will wait for the account they were given if it is only out
of quota"*: which this ruling makes **false while a lock is set**. So:

- a one-line note beside the control, rendered **only when `runnerLock` is non-null**, saying the
  global engine lock overrides this setting while it is set;
- the same condition on the off-toast wording, so it does not promise a wait that will not happen.

A setting that is silently overridden by another control is otherwise a support question waiting to
happen, and worse here: the user turned this one **on purpose**. Scheduled in Phase 3 and asserted by
V5, rather than left as a sentence in a decision section, which is what an earlier draft did, and it
is the reason a promise like this goes unbuilt.

**D3b. The parks D3a preserves are the ones taken WITH a resolved alternative. Two spawn gates and an
admission memo sit ABOVE dispatch and park WITHOUT one, and those must be lock-aware.** Left as they
are, a locked run never reaches the step loop at all, so nothing ever looks at the other provider.

| gate | where | what it does today |
| --- | --- | --- |
| spawn gate, initial | `run.ts:5527` `requeueWhileHeld(runId, workflow, input, taskBackend, undefined, chosen)` | parks the run if `taskBackend`'s account is held |
| spawn gate, post-lease | `run.ts:5739`, the same call after the exclusive repo-root lease | re-asks, because the account can close while the run prepares |
| admission memo | `heldAtSpawn` (`run.ts:1203`), read by `heldAccountFor` (`:2162-2166`) | remembers the account a spawn refused and holds the run back at dequeue |
| **admission, own-account branch** | **`heldAccountFor`'s first branch, `run.ts:2158-2161`** (the function is declared at `:2131` and called from the dequeue sweep at `:2100` and the `noteHeldRuns` predicate at `:2003`) | when `fallbackAcrossAccountsWhenLimited` is **off**, holds a queued run at admission because the account **the record names** is held |

The mechanism that makes these bite under a lock: `requeueWhileHeld` keys on `accountUsageKey` built
from `resolved` when dispatch chose something, else `runAccountKey({ ...run, runner }, runner)`
(`run.ts:3697-3699`). A lock that forces `taskBackend` to a provider whose accounts are all held
therefore parks the run at `:5527` **before any step runs**, and `holdRunOnAccount` writes the memo
at `run.ts:3758`, so the run is then also held back at admission on every later pump sweep.

**Ruling: a hold on an account the LOCK chose is not a reason to wait AT THESE GATES. It may still be
one at dispatch.** The two halves matter equally, and the second is what keeps this consistent with
the corrected D3a: these gates are *early*, and they refuse without having resolved an alternative.
Dispatch is the only layer that knows whether a runnable account exists anywhere. So the lock buys a
locked run passage **to** dispatch, never passage **through** it: if dispatch then finds nothing
runnable, `holdStepOnWaitableAccount` / `holdRunOnAccount` park it exactly as D3a preserves, and the
run ends up parked with a real appointment rather than spawned into a dead provider. What the lock
removes is a park decided *before* the alternative was ever looked for.

1. Both `requeueWhileHeld` call sites are told whether `taskBackend` is the lock's answer or the
   run's own. When it is the lock's and the resulting account is held, the gate **does not park**:
   it falls through to dispatch, which is the only place allowed to resolve an alternative, and
   `downgradePinnedRunner` then either does the loud cross-provider move D3 specifies or, with
   nothing runnable anywhere, parks per D3a. This is a
   narrower version of the "skip the hold whenever the never-block setting is on" attempt that
   `run.ts:3689-3696` records as **too blunt** and rolled back: that one disabled the hold outright
   on a default host, including the herd control. This one is scoped to the single case where the
   account being held is one the *user did not choose*, and it leaves every unlocked hold, and every
   hold on an account the run itself named, exactly as it is.
2. **Writing the lock DROPS `heldAtSpawn` (and `heldNotified`) for every queued run whose target it
   changes. The lock write is a retarget of the whole queue.** An earlier draft of this item said a
   pre-existing memo "needs no change" because it self-clears on read, which is false and was the
   one place D3b contradicted its own V3. `heldAccountFor` clears the memo **only** when
   `accountHeldOn(atSpawn, …)` is false (`run.ts:2162-2166`), so a memo naming a held **codex**
   account keeps a **claude**-locked run out of the queue for the entire duration of that codex
   hold. The run never reaches admission's fall-through, never reaches the spawn gates of item 1,
   and never reaches dispatch: so nothing ever looks at the locked provider. It also breaks the
   recovery case D2 names in as many words ("everything is stuck on codex, flip it"), because the
   queued runs are held by memos written *before* the flip.

   **The repo already rules on exactly this shape, and implements it.** `retargetQueuedRun`'s
   docblock (`run.ts:2219-2223`) says the memo *"is stale the instant the target changes — it would
   otherwise keep the run out of the queue on the strength of a verdict about a DIFFERENT account, so
   the retarget would appear to do nothing until the old account's hold expired"*, and `run.ts:2293`
   drops `heldAtSpawn` and `heldNotified` together for that reason. Setting or clearing the lock
   changes the target of every queued run it applies to, so it is the same event and takes the same
   action.

   **But NOT "at the `PUT` that writes the lock", which an earlier draft said and which that route
   cannot do.** `heldAtSpawn` is `private readonly` on `RunManager` (`run.ts:1203`): one map per
   project manager. `PUT /api/v1/workspace/config` is workspace-level: it holds `deps.semaphore` and
   reaches managers **only** through `semaphore.refresh()`, and `SemaphoreParticipant`
   (`semaphore.ts:101-131`) exposes just `busySlots`, `pump`, `oldestQueuedAt`, `accountHolds?` and
   `accountInflight?`: no hook that could clear a memo. The precedent cited above does not transfer
   by itself either: `retargetQueuedRun` is called on a **single project-scoped** `manager` taken
   from the request context (`server.ts:5726`), which a workspace route does not have.

   **Mechanism, named and placed:** a new optional participant method
   `onRunnerLockChanged?(): void` on `SemaphoreParticipant`
   (`packages/cezar/src/workspace/semaphore.ts:101-131`, optional exactly like `accountHolds?` so
   stub participants and older callers keep working), implemented at `RunManager`'s registration
   (`run.ts:1295-1301`) to drop `heldAtSpawn`/`heldNotified` for every queued run whose target the
   lock changes, and fanned out from `WorkspaceSemaphore.refresh()` (`semaphore.ts:435-443`)
   alongside the `release()` it already performs. The bulk-clear itself is not new code shape:
   `run.ts:1993` already clears both maps wholesale when nothing is held anywhere.

   Two things fall out of putting it there, and both are why this beats a lock-generation counter
   compared in `pump()`. **D7's "refresh on a lock-only `PUT`" becomes the single trigger for both
   halves** of this feature's live-apply: the snapshot the run loop reads and the memos the queue
   reads, so there is one thing to get right and one thing to test, rather than two mechanisms that
   can disagree about whether a lock write happened. And it reaches **every** manager including the
   boot project's, which is the property `accountInflight`'s own doc comment (`semaphore.ts:124-131`)
   records having been got wrong once before by assembling participants from the project-context map
   instead of from registration.

   **And the write rule is narrower than "a locked run writes no memos".** That was the other half of
   the earlier draft and it is too broad: the memo is written by `holdRunOnAccount`
   (`run.ts:3758`) and `parkContinuationOnAccount` (`:3807`), and **D3a explicitly preserves both
   under a lock**. A memo written by a dispatch-level park is a real post-resolve refusal, and it is
   the write-storm brake `run.ts:2140-2147` records (*"37 identical 'held in the queue' notes in 1.5
   seconds"*). So, precisely:

   - **no memo** when the **spawn gate** waved a locked run through per item 1: there was no
     refusal to remember;
   - **memo still written** when **dispatch** parks per D3a: there was one, after a full resolve,
     and throwing it away would reopen the storm the brake exists for.
3. **`heldAccountFor`'s own-account branch does not hold under a lock**, and it needs its own
   sentence because item 1's phrasing does not reach it. That branch keys on
   `runAccountKey(run, defaultRunner)` (`run.ts:2158`): **the pre-lock routing decision**, read off
   the record, not on anything the lock chose, so "a hold on an account the LOCK chose" is simply
   not what it tests. Under a lock the record's account is not what the run will run on at all, so a
   hold on it is a hold on a **stale routing decision**, and admission must fall through to dispatch:
   the only layer allowed to resolve an alternative. The `heldAtSpawn` half of the same predicate is
   not covered by this item: it is governed by item 2 above, which **drops** the memo at the lock
   write rather than leaving it to self-clear. Both halves of `heldAccountFor` therefore stop holding
   a locked run, for two different reasons: this one because the account it names is stale, item 2's
   because the verdict it remembers is.

   This is the same composition D3c closes, at a **third** site: `heldAccountFor` is gated on
   `fallbackAcrossAccountsWhenLimited` too (`run.ts:2159`), and it sits **above** both the spawn
   gates of item 1 and the dispatch functions of D3c. With the setting off, it holds the run at
   dequeue and the lock never gets a turn at any of the layers below.

**Why not simply let these gates park and rely on auto-resume.** Because the run would park on an
account the user never picked, for a window they cannot see from the toggle, **without anything
having checked whether the other provider was free**: which is the whole point of the lock. The
herd-control argument that justified the original hold does not apply here either: the herd is runs
converging on one closed window, and a locked run is being *sent* to a different provider, not
queued behind the same one. When the other provider is *also* unusable, the park still happens, one
layer later and with a resolved account behind it (D3a).

V3 covers all three: the initial gate, the post-lease gate, and a queued run that already carries a
memo when the lock is set, each asserting that the run reaches dispatch, not that it necessarily
spawns.

### D4. One pure function, one named decision, eight call sites

**WIRED 2026-08-30.** All eight are live in `packages/cezar/src/workflows/run.ts`; the line
numbers in the table below are as-read at `95b93175` and have moved. Grep `applyRunnerLock(` for
the call sites and `runner-lock-dispatch.test.ts` for the coverage.

A lock that is spelled `lock ?? x` inline at eight expressions is a lock that drifts at the ninth.
New module `packages/cezar/src/workflows/runner-lock.ts`:

```ts
export interface RunnerLockDecision {
  /** What actually runs. */
  runner: RunnerId;
  /** True only when the lock CHANGED the answer, the key the metric and the UI note read. */
  locked: boolean;
  /** What would have run with no lock. Never omitted, so the record can always say what was overridden. */
  wouldHaveBeen: RunnerId;
}

/** PURE. `undefined` lock ⇒ `{ runner: requested, locked: false, wouldHaveBeen: requested }`:
 *  identity, which is what makes "unset is byte-for-byte today" a testable claim rather than a hope. */
export function applyRunnerLock(lock: LockableRunner | undefined, requested: RunnerId): RunnerLockDecision;
```

Every site becomes `applyRunnerLock(this.runnerLock(), <today's expression>)`. `locked` is what the
metric keys on; nothing re-derives "did the lock bite?" from the inputs a second time.

The eight sites, each read at `95b93175`:

| # | file:line | today | under the lock |
| --- | --- | --- | --- |
| a | `run.ts:5487` | `fallbackProvider: (input.runner ?? config.defaultRunner)` | the lock becomes the lookup provider |
| b | `run.ts:5522` | `chosen?.provider ?? input.runner ?? config.defaultRunner` | wrapped |
| c | `run.ts:7036` | `const pinned = step.runner ?? undefined` | under a lock, `pinned` is the lock for EVERY agent step (D3) |
| d | `run.ts:7045` | `downgrade?.runner ?? step.runner ?? taskBackend` | `step.runner` and `taskBackend` wrapped; `downgrade` still wins (D3) |
| e | `run.ts:2956` | `const stepBackend = def.runner ?? run.runner ?? 'claude'` | wrapped, **synchronous**, see D7 |
| f | `run.ts:4541` | `const targetRunner = opts.runner ?? run.runner ?? 'claude'` (continuation) | wrapped (D6) |
| g | `run.ts:920`, `run.ts:2249` | `target.runner ?? …` (retarget / queued retarget) | wrapped (D6) |
| **h** | **`run.ts:3289`** `rerouteExplicitAccountIfUnavailable`, called at **`:5507`** (execute) and **`:4738`** (continuation) | `listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS)` at `:3323`, **every provider** | see D4a |

**D4a. Site h is availability, so it MAY cross the lock, but it must say so and it must not
persist the crossing as a new pin.** This site was missed in the first draft of this spec and is the
one that would have made the feature leak in production, so it is ruled on explicitly rather than
folded into D3.

`rerouteExplicitAccountIfUnavailable` fires only when the account a run NAMED is already unusable
(`:3320`: `if (currentTier === 'runnable') return undefined` is the cheap exit). That is the same
class of fact as `downgradePinnedRunner`: nobody set it, and it clears itself. So by D3 it **keeps
its cross-provider candidate set** and is not narrowed the way the pool is in D5. Two obligations
come with that:

1. **It must be lock-aware in what it says.** When a lock is set and the reroute crosses it, the
   note at `:3336-3344` names the **lock** as what was overridden, and the accompanying
   `run.account_fallback` metric carries `lockedRunner` alongside its existing `site` field, exactly
   as D3 requires of `run.step.runner_downgraded`. A silent cross here is the one outcome that makes
   the toggle a lie.
2. **The continuation path must not persist the crossed provider as the run's new pin.**
   `run.ts:4771-4774` writes `{ runner: rerouted.provider, agentProfile: rerouted.accountId }` onto
   the record, and that write is correct today for the reason its own comment gives (a crossed
   `runner`/`agentProfile` pair resolves against the wrong provider's login list). Under a lock it
   is **not** correct as a *pin*: an unattended auto-resume would move a locked run to the other
   provider and leave it there, so the next step reads `run.runner` and never comes back. **Ruling:
   the write stays** (the pair must stay coherent) **and site e/b re-derive the backend from the lock
   on the next dispatch anyway**, which is what brings the run home once the locked provider is
   healthy. The record therefore reports what actually ran, and the lock still governs what runs
   next. V3 asserts both halves.

**D4b. The eight sites above are DISPATCH. There is a whole tier of provider-viability gates that
runs BEFORE dispatch and can refuse with a 409 without `applyRunnerLock` ever executing.** Listing
only the dispatch sites was the gap: a locked run whose *unlocked* provider is unavailable or
disabled would be refused at the door, and the lock that would have routed it somewhere runnable
never gets a turn.

The gate tier is `packages/cezar/src/server/provider-action-gate.ts`, consumed by `guardRunStart`
(`server.ts:2778-2800`, wired at `:7410`) and by five more entry points:

| entry point | where | requirement builder |
| --- | --- | --- |
| `POST /runs` (and `/workspace/runs`) | `server.ts:5303` via `guardRunStart` | `requirementsForWorkflowRun` (`:185`) |
| todo start | `server.ts:6456` | `requirementsForWorkflowRun` |
| headless `cezar run` | `index.ts:1078` | `requirementsForWorkflowRun` |
| Continue | `server.ts:5669` | `requirementForExistingRun` (`:217`) |
| parked-message resume (the reopen branch of `/runs/:id/messages`) | `server.ts:5538` | `requirementForExistingRun` |
| retarget, "Run on…" | `server.ts:5721` | `requirementForRetarget` (`:235`) |
| **`POST /plan`** | **`server.ts:4911`** via `planAccountGate` (`:1728`, refusal at `:1764`) | **`requirementForPlanner` (`:257`)** |

All four builders derive their provider from the **unlocked** world:
`requirementsForWorkflowRun` takes `fallback: body.runner ?? config.defaultRunner` and adds one
requirement per **explicitly pinned** workflow step (`:196-208`); `requirementForExistingRun` and
`requirementForRetarget` both call `providerForExistingRun(run, override)`; and
`requirementForPlanner` takes `provider: defaultRunner` with
`route: parseAgentRoute(selectionFor(accounts, repoRoot, defaultRunner))` (`:263-268`).

**The `/plan` row is the one an earlier draft of this spec got wrong twice**, and it is worth being
explicit about the failure, because it is the exact shape D4b exists to close: a workspace locked to
Claude, on a project whose `defaultRunner` is `codex`, has `/plan` **refused at the door** whenever
codex is unavailable: a refusal computed entirely against a provider the lock has overridden.

Two things follow, and both halves are required:

1. **`requirementForPlanner` takes the locked provider** as `provider`, and re-derives its `route`
   for that provider rather than for `config.defaultRunner`. This is not only about the refusal:
   `server.ts:1723` states that this gate resolves a full `Viability` on the way to `null` precisely
   because *"the caller needs the requirement's `runnable` set either way, to tell `planChain`'s
   injected chooser which account to prefer"*. So the candidate set behind `chooseAccount` **is**
   this requirement's `runnable` set, and D4c's ruling that `planner.ts` prefers the lock is
   literally not implementable until this builder is lock-aware. The gate and the execution path are
   one mechanism, not two.
2. **The cheap disabled-provider exit is outside any builder and must be handed the lock at its call
   site.** `planAccountGate` short-circuits on `unavailableProviderMessage([defaultRunner], known)`
   (`server.ts:1735-1739`) *before* it ever calls `requirementForPlanner`, so fixing the builder
   alone leaves a locked workspace refused because the **overridden** provider is disabled in
   settings. That literal array is the second edit.

**Ruling: the lock is applied inside the four builders, not at each of the seven call sites.** Seven
call sites is seven places to forget it; the builders are the one place they all already agree on,
and they are pure functions with an existing unit suite (`server/provider-action-gating.test.ts`).

**And "inside the builders" is only half a rule, because the builders are PURE and today take no
lock.** An earlier draft stopped there, which named an outcome and no data path. The other half:

- **each builder gains a `runnerLock: LockableRunner | undefined` input**:
  `WorkflowRunRequirementsInput` gains a field (it is already an options object,
  `provider-action-gate.ts:164-175`), and the three positional builders
  (`requirementForExistingRun`, `requirementForRetarget`, `requirementForPlanner`) take it as an
  argument beside the `fallbackAcrossAccountsWhenLimited` boolean they already accept. Same shape,
  same purity, one more input;
- **every caller reads it from ONE workspace snapshot per request.** The five server sites already
  load `workspaceConfig.load()` or hold `workspace` for `fallbackAcrossAccountsWhenLimited`
  (`guardRunStart` at `server.ts:2778-2800`, the retarget at `:5721` reading
  `workspace.resources.fallbackAcrossAccountsWhenLimited`), so the lock rides that **same** read
  rather than a second one. Two callers need the read added, and they are the ones an
  audit-by-grep misses: **`POST /plan`**'s `planAccountGate` (`server.ts:1728-1745`, which loads
  `workspaceConfig.load()` at `:1738` already) and **headless `cezar run`** (`index.ts:1078`, which
  today builds requirements from project config alone);
- **one snapshot per decision, never two reads.** A gate that read the lock separately from the
  value it hands the builder can refuse on one answer and route on another, which is the class of
  bug D7a exists to prevent one layer down.

Under a lock:

- `requirementsForWorkflowRun` computes its run-level requirement against the locked provider, and
  **emits no per-step requirement for a pinned step whose pin the lock overrides**: that pin is not
  going to be honoured, so demanding its provider be viable would refuse a run over a provider the
  run will never touch. This is the gate-tier mirror of D2 rank 2;
- `requirementForExistingRun` and `requirementForRetarget` use the locked provider as
  `provider`, and the route is re-derived for it rather than inherited, for the same
  provider-scoped-account reason as D6a;
- `reroutable` is unchanged in meaning. A locked requirement is still reroutable exactly when
  today's rules say so, because D3 keeps availability above the lock and the gate must not promise
  otherwise.

V4 covers a locked start and a locked resume where the **overridden** provider is unavailable or
disabled, which is the case that 409s today.

**D4c. `/plan` is NOT left alone, and neither are the three other model calls that never touch
`RunManager` at all.** An earlier draft excluded `/plan` on the grounds that `planChain` has no
`RunManager` behind it. That is true and it is the wrong conclusion: having no `RunManager` is
exactly why it would keep calling Claude while the platform is locked to Codex. The owner asked for a
switch that moves **the whole platform**, and a lock that visibly fails to move planning, task
naming, classification and note triage is a lock with holes in it that a user will find within a day.

Four paths build a runner directly from `config.defaultRunner`, none of them through any of the eight
dispatch sites. **Three of the four are behind no entry gate either; `/plan` is the exception and is
behind the seventh gate D4b now lists** (`planAccountGate` → `requirementForPlanner`). That makes
`/plan` the one path needing **both** halves: the gate must stop refusing on the overridden provider,
*and* the execution below it must build its runner from the lock. The other three are execution only:

| path | file:line | what it does today |
| --- | --- | --- |
| plan chain (`/plan`) | `planner.ts:96-103` | `chooseAccount?.(repoRoot, config.defaultRunner)`, then `provider = choice?.provider ?? config.defaultRunner`, `createRunner(provider)`, `resolveProfileEnvForRoot(repoRoot, provider)` |
| run auto-naming | `runs/auto-name.ts:156-161` | `createRunner(config.defaultRunner)`; `config.namerModel` only when that is claude |
| task classifier | `task-classifier.ts:137-140` | `runnerId = config.defaultRunner`, `CHEAPEST_MODEL[runnerId]`, `resolveProfileEnvForRoot(repoRoot, runnerId)` |
| note triage pass | `notes/processor.ts:187-193` | `runnerId = config.defaultRunner`; `config.plannerModel` only when that is claude |

**Ruling: all four prefer `runnerLock` over `config.defaultRunner`, and each keeps its own existing
degradation behaviour unchanged.** The change in each is the *source* of the provider, not the
control flow around it.

**How the value REACHES them, which an earlier draft left unsaid.** All four are library functions
that today call `loadConfig(repoRoot)` and nothing else: no `RunManager`, no semaphore, no workspace
config. "Prefer the lock" without a data path is an outcome, not a design, so it is specified here:

| function | dependency added | production owner passes it |
| --- | --- | --- |
| `planChain` (`planner.ts:96-103`) | `runnerLock?: LockableRunner` on its existing options object | `planAccountGate`'s caller, the `/plan` route (`server.ts:4911`), from the same snapshot D4b threads into `requirementForPlanner` |
| `generateRunName` (`runs/auto-name.ts:156-161`) | `runnerLock?: LockableRunner` on its options | `RunManager`, which already owns a live `semaphore.runnerLock()` (D7) |
| `classifyTask` (`task-classifier.ts:137-140`) | same, beside its existing `runnerFactory?` seam (`:103`) | `RunManager` (`run.ts:7256`, `autoTaskChoice`) |
| `NoteProcessor.ask` (`notes/processor.ts:187-193`) | a `runnerLock: () => LockableRunner \| undefined` **accessor** on `NoteProcessorDeps` | whoever constructs the processor at boot, wired to `semaphore.runnerLock` |

Two shapes, and the difference is **read timing**, not taste:

- a **value** where the caller is already inside one decision and holds a snapshot (`planChain` per
  request, `generateRunName`/`classifyTask` per run). Passing a live accessor there would let the
  provider change *between* the gate's answer and the runner's construction, which is the two-reads
  bug D4b's "one snapshot per decision" rule forbids one layer up;
- an **accessor** for `NoteProcessor`, which is long-lived: it is constructed once at boot and asks
  repeatedly, so a value captured at construction would pin it to whatever the lock was when the
  server started and never move again. That is the failure the sync accessor exists for (D7), and
  it is why this one is not a value.

**A plain optional keeps every existing caller and test compiling**, and absent means exactly
today's behaviour: the same "unset is byte-for-byte today" property `applyRunnerLock` has.

The per-function changes:

- **`planner.ts` already has the right shape**, but it is **not** the least work, because its input
  comes from the gate. Its `chooseAccount` seam (`:76-78`) prefers a `runnable` account on the
  requested provider, then any other `runnable` candidate, then `undefined`: so handing it the lock
  gives the whole availability ladder D3 describes for free, including the degraded fallback plan
  when nothing is runnable, and `/plan` needs no separate park ruling because it already has one.
  **What it does not give for free is the candidate set**: those candidates are
  `planAccountGate`'s `runnable`, computed by `requirementForPlanner` against the unlocked
  `defaultRunner` (`server.ts:1723`). Change `planner.ts:96-103` alone and it will faithfully choose
  from a list the lock never touched. Both edits, or neither.
- **The three others have no account ladder and must not grow one here.** They pass the locked
  provider to `createRunner` and to `resolveProfileEnvForRoot`, and they keep failing the way they
  already fail: the classifier's own comment (`task-classifier.ts:24-26`) says a runner that is
  absent or unauthenticated is *"not a condition a second attempt fixes"*, and auto-naming and note
  triage are both best-effort passes whose failure is already non-fatal. A lock must not convert a
  best-effort pass into a blocking one.
- **The model aliases stay claude-conditional.** `config.namerModel` and `config.plannerModel` are
  read only when the provider is claude (`auto-name.ts:157`, `notes/processor.ts:189`); under a
  Codex lock those conditions are simply false and each backend picks its own default, which is the
  behaviour those lines already implement for a codex `defaultRunner` today. No new model mapping.

**Deliberately not in scope:** giving these four the full pool/downgrade machinery. They are
single-shot helper calls, not runs; `planner.ts` has its ladder because it was given one for its own
reasons, and inventing three more is a different feature. V4 covers routing for all four with an
**opposing project default** (project `defaultRunner: 'codex'`, lock `claude`, assert the runner
factory is called with `claude`), which is the assertion that would fail today.

### D5. Pool narrowing reuses the narrowing that already exists

`resolvePoolForDispatch` gains one option:

```ts
/** When the workspace is locked to a provider, candidates are confined to it, the pool still
 *  balances ACCOUNTS, it just may no longer hop providers. Absent ⇒ today's wildcard behaviour. */
lock?: ProviderId;
```

Implementation is **not new logic**: `resolvePoolForProvider` (`agent-route-select.ts:323-360`)
already does exactly this narrowing, and its own comment says why it is written that way:
*"`provider` from the caller, never `route.provider` — that is the narrowing, and reading it off the
route would reintroduce the wildcard's provider hop"* (`:338-339`). `resolvePoolForDispatch` builds
its candidate set the same way when `lock` is set:

```ts
const all = poolCandidates(
  options.lock ? { kind: 'pool', provider: options.lock } : route,
  listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS),
);
```

Everything downstream is untouched: the `disconnected` tier still filters candidates
(`.ai/specs/2026-08-25-logged-out-account-fallback.md`), `selectPoolAccount` still ranks by load and
still returns a limited account rather than nothing, and the dispatch cursor still advances at the
choice.

`selectionFor(accounts, repoRoot, fallbackProvider)` is also handed the lock as its provider (site
**a**), so the stored selection consulted is the locked provider's, not the unlocked default's,
whose route might name the other provider outright.

**What this deliberately does not do:** it does not make `pool:*` mean something different. Unlocked,
`pool:*` still picks the provider, exactly as KB `notion-4dee7a4df2f1` and todo `81ab4ebd` recorded.

### D6. An explicit per-task engine act does NOT escape the lock

Ruling: **the lock overrides "Run on…" and a follow-up's runner override too.** Those pickers keep
their **model** choice and lose their **provider** choice while a lock is set, showing the locked
provider with a one-line reason. They also keep an **account** choice, but only among the locked
provider's own accounts, for the reason D6a makes non-negotiable.

**D6a. An account id is provider-scoped, so a lock-forced provider change MUST re-resolve the
account. It is never carried across.** An earlier draft of this section said the pickers "keep their
account choice", full stop. That is not implementable, and the failure it produces is one this
repository has already measured in production.

Concretely, with the lock at `claude` and `input.agentProfile` naming a **codex** account id:
`run.runner` becomes `claude` while `run.agentProfile` stays the codex id. At `run.ts:1621-1622`

```ts
const profileId = options.recordedProfileId
  ?? (backend === runRunner ? run?.agentProfile : steppedProfile);
```

the guard `backend === runRunner` is now **satisfied** (both are `claude`), so the codex id is handed
to `resolveProfileEnvForRoot(root, 'claude', '<codex id>')`, `selectProfile` finds no claude account
by that id, and it degrades to claude's **default** login: no pool ranking, no limited-skip. That is
exactly the defect `run.ts:3301-3310` records from `prod-host` (*"a run pinned to
`codex:secondary` … kept resolving to (and failing on) the held `codex:default`, while a real,
unlimited … account sat idle"*), and `run.ts:4756-4761` independently names the crossed
`runner`/`agentProfile` pair as corrupting.

**Rule: whenever `applyRunnerLock` changes the provider, `agentProfile` is dropped and the account is
re-resolved for the locked provider via `resolvePoolForProvider`**, the mechanism `run.ts:1611-1618`
already runs for exactly this case when `backend !== runRunner`, added by
`.ai/specs/2026-08-23-step-runner-account-resolution.md` for the identical reason. The lock makes
that branch unreachable by making the two providers agree, so the re-resolution has to be moved to
where the lock is applied rather than left to a guard the lock defeats. Asserted by V3.

The alternative (an explicit human act in the moment beats a standing default, recorded as a
per-run opt-out) was considered and rejected. It needs a new field on the run record, a rule about
when it expires, and it produces the one state this feature must not have: a screen-pinned control
saying "Claude" over a run quietly executing on Codex for a reason nothing on that screen explains.
The escape hatch does not need to be per-task, because the control is **on every screen**: flipping
it to Auto is one click from wherever the user already is.

Keeping the **account** picker live under a lock, scoped to the locked provider's own accounts, is
the same reasoning `.ai/specs/2026-08-24-codex-only-default-workflow.md` D8 gave for not disabling
the pill on a pinned workflow: the pill also selects the account within a provider, and that choice
stays meaningful. What D8's reasoning does **not** license is keeping a *foreign* provider's account
id alive across the switch, which is D6a.

### D7. Storage, live-apply, and why the read must be synchronous

**Stored** as a new key on the workspace config, `~/.cezar/config.json`, typed
`runnerLock?: LockableRunner | null`: **optional** in the parsed file shape (an install that has
never set it has no key at all) and narrowed to `'claude' | 'codex'`, per Data models,
default `null`.

- **Not** `localStorage`. The acceptance criteria require persistence "across reload and **across
  sessions**"; `theme.ts:9`/`sidebar-width.ts`/`appearance.ts` are explicitly single-browser, and a
  browser-only lock would not reach `cezar run` from a terminal, a cron automation, or a headless run.
- **Not** the project config (`.ai/cezar/config.json`). "Global" means every project.
- **Not** inside `agentDefaults`. `agentDefaults.runner` is documented on the wire as a *preference*
  consulted "only where the repo's own `.ai/cezar/config.json` is silent — a repo that chose is never
  overruled" (`packages/contract/src/workspace.ts:53-59`). Putting an override with the opposite
  semantics into the same object is how the two get read as one. Top-level key, own name.

**Live-applied** through the mechanism that already exists, **but that mechanism does not reach this
key for free, and an earlier draft of this paragraph claimed it did.** `WorkspaceSemaphore`
(**`packages/cezar/src/workspace/semaphore.ts`**, note the directory: it is not a neighbour of the
`packages/cezar/src/workflows/runner-lock.ts` module D4 proposes) carries
`fallbackAcrossAccountsWhenLimited` from workspace config (`semaphore.ts:60,143,168`) and exposes it
as a **synchronous** accessor (`:321-322`), refreshed by `semaphore.refresh()`. `runnerLock` rides in
the same snapshot with a sibling accessor `semaphore.runnerLock(): LockableRunner | undefined`, and
three
things have to be changed for that snapshot to ever contain it. Measured at `95b93175`:

| # | today | required |
| --- | --- | --- |
| 1 | `loadResourceLimits` (`semaphore.ts:153-172`) reads `const { resources, projects } = await loadWorkspaceConfig()` and copies **`resources` keys only** | it must also read and return `runnerLock`, which is a top-level key (D7's own storage decision), not a `resources` key |
| 2 | `PUT /api/v1/workspace/config` refreshes **only** when resources changed: `if (resources !== undefined) await deps.semaphore?.refresh();` (`server.ts:4647-4649`) | refresh when `resources !== undefined` **or** `runnerLock !== undefined`; a lock-only PUT must not be a silent no-op on the running loop |
| 3 | `PUT /api/v1/providers/:provider/enabled` (`server.ts:2867`) performs **no** `semaphore.refresh()` at all | it must refresh after D10's clear-the-lock write, or the loop keeps running a lock the file no longer holds |

**#3 is the one that fails most quietly**, because the disk and the API both look correct: `GET
/workspace/config` reports `runnerLock: null` (it reads the file) while the run loop keeps pinning
the disabled provider from a stale in-memory snapshot, until something unrelated happens to call
`refresh()`. `WorkspaceResourceLimits` is a published-adjacent internal shape and is **not** renamed
for carrying one non-resource key, for the same reason the `limits` bag is not (see below); its doc
comment gains the same "workspace policy, of which limits are one kind" note.

`PATCH /api/v1/projects/:id` also reuses `refresh()` (`server.ts:4098-4101`) and needs no change: it
cannot alter the lock. V4 asserts the synchronous accessor after **both** write paths that can.

**D7a. `refresh()` is NOT a lock-change event, so the D3b item 2 fan-out must be gated on an actual
transition.** This is the hazard created by putting the memo drop on the semaphore, and it has to be
closed here rather than left to the implementer. `refresh()` is called from **four** places at
`95b93175`, and only one of them can involve a lock at all:

| caller | why it refreshes |
| --- | --- |
| `index.ts:786`, `index.ts:1121` | boot |
| `server.ts:4101` | `PATCH /projects/:id`, a `maxParallel` change |
| `server.ts:4649` | `PUT /workspace/config`: **the only one that can carry a lock**, and it also fires for a resources-only body |

A parameterless hook fired on every `refresh()` would clear `heldAtSpawn` and `heldNotified` on boot,
on a per-project cap change, and on any unrelated settings save, throwing away the queue dedupe and
reopening the write-storm the brake at `run.ts:2140-2147` exists to prevent (*"37 identical 'held in
the queue' notes in 1.5 seconds"*). That is a worse bug than the one D3b item 2 fixes, arrived at by
fixing it.

**Rule, stated as four properties `refresh()` must have:**

1. it captures the **normalized previous** lock (`this.limits.runnerLock`) before loading;
2. it compares it to the **successfully loaded next** value;
3. it invokes `onRunnerLockChanged` on every participant **only when the two differ**, and
   **before** `release()`: the memos must be stale-free before the pump that reads them runs, or
   the first sweep after a lock change still holds runs back on the old verdict;
4. it invokes **nothing** when `this.load()` threw. `refresh()` already swallows that and keeps the
   last good snapshot (`semaphore.ts:436-440`), so the lock did not change; firing the hook there
   would clear memos on the strength of a read that failed.

`null`/absent normalize to the same value, so clearing an already-clear lock is not a transition.
V4 covers all three negatives (a same-value lock PUT, a resources-only refresh, and a failed load),
because each of them is a way to fire the hook when nothing happened, and none of them is visible in
the positive test.

That the read is **synchronous and in-memory is load-bearing, not incidental.** Site **e**
(`run.ts:2956`) is a recovery-sweep predicate whose own comment refuses to become async for exactly
this reason: *"Resolving it properly means re-asking the downgrade question, which is async and reads
two JSON files, from a synchronous predicate that runs on every recovery sweep — and getting that
wrong reattaches a session to the wrong provider, which corrupts the run."* A lock read that needed
a `readFile` could not be consulted there, and a lock that is not consulted there restarts steps it
should have resumed.

**Naming note:** the semaphore's bag is called `limits` and a lock is not a limit. It is **not
renamed**, cezar publishes `@loki-labs/cezar-plus` and `BACKWARD_COMPATIBILITY.md` applies. The
bag's doc comment is amended to say it carries workspace *policy* the run loop reads synchronously,
of which the limits are one kind.

### D8. Todo `3c0639ea` COEXISTS. It is not closed and not duplicated

Ruling: **the lock is the coarse override; `3c0639ea`'s per-step policy table is what runs when the
lock is `null`.** They compose as ranks 1 and 6 of D2's table.

They are different asks and closing one with the other loses real scope. `3c0639ea` wants a table
editable in Settings, a step able to name a **set** of acceptable runners to balance across, no
hand-patching of frozen `workflowDef` copies, and save-time refusal of a model a runner cannot serve.
A single global pin delivers none of those. Phase 5 appends one line to that todo's context recording
the relationship and the new precedence rank; **its status stays `todo`.**

### D9. The shell region

One new grid row in `AppShell`, always rendered when not `chromeless`:

```
grid-rows-[auto_auto_1fr_auto]  →  grid-rows-[auto_auto_auto_1fr_auto]
row 1  MobileTopBar        (unchanged, md:hidden)
row 2  globalBar slot      NEW, data-slot="global-bar", always present
row 3  banner slot         (was row-start-2)
row 4  main                (was row-start-3)
row 5  composer dock       (was row-start-4)
```

**Row 2 is a SLOT, not a mounted component, and that boundary is not negotiable.** An earlier draft
of this section put `<EngineLockBar/>` directly in `AppShell`. That cannot ship: `AppShell` is
deliberately presentational and **must render where no `QueryClient` is provided**. The file says so
about itself twice (`app-shell.tsx:819-826`: the Add-project dialogs are *"mounted only while open,
ON PURPOSE: they are the one part of this shell that talks to the API … and the shell itself must
keep rendering in the places that mount it without a QueryClient"*), and `app-shell.test.tsx:56-68`
records the same rule from the test side, noting that mounting a query-driven child unconditionally
"would … force a `QueryClientProvider` onto this presentational shell — which every test in this
file renders without one, on purpose". A bar that reads `GET /workspace/config` is exactly such a
child.

So, following the pattern already in the file:

- **`AppShell` gains `globalBar?: ReactNode`**, declared beside `banner?: ReactNode`
  (`app-shell.tsx:119-122`) and rendered into row 2 under the same `!chromeless` guard. It knows
  nothing about locks, providers or queries.
- **`AppShellContainer` owns the data**, passing `globalBar={<EngineLockBarContainer/>}` next to its
  existing `banner={<ProviderBannerContainer/>}` (`app-shell-container.tsx:178`). That line is the
  precedent this copies verbatim in shape.
- **`EngineLockBarContainer`** holds the `useWorkspaceConfig` read, the provider-status read for
  which segments render, and the `PUT` mutation. **`EngineLockBar`** stays presentational and takes
  `value`/`options`/`onChange`, so it is unit-testable without a client too.

One structural difference from `banner`, deliberate: the banner slot is conditional
(`{!chromeless && banner ? … : null}`, `:302-306`) and leaves its row empty when absent, whereas the
global-bar row is **always** rendered when not `chromeless`: that is what "pinned to every screen"
means, and it is why the row's presence is asserted rather than its contents.

- **One instance, one DOM node, one selector.** Not a desktop copy plus a mobile copy behind
  `hidden md:flex` / `md:hidden`, two renders of one control duplicate ids, break
  `querySelector`-based e2e assertions, and drift. Above `md` the row is the only chrome at the top
  of the column (the sidebar is beside it); below `md` it sits directly under `MobileTopBar`.
- **`MobileTopBar`'s reserved `data-slot="mobile-status"` (`:973`) is left alone.** Its comment
  reserves it for the thread's run status dot / kebab; taking it here would put the control in two
  different places depending on viewport.
- **`chromeless` is NOT one surface, and "renders nothing" was too coarse.** An earlier draft said
  the bar is absent under `chromeless`, matching the sidebar, drawer, top bar and banner
  (`:296-306`). That silently rode on someone else's decision and contradicted this task's own
  "every cockpit screen". `chromeless` is `needsOnboardingGate(probe)`
  (`app-shell-container.tsx:78`), which is **three** states
  (`routes/onboarding/onboarding-gate.ts:101-106`), and they are not alike:

  | probe | what it is | bar |
  | --- | --- | --- |
  | `signed-out` | an **authentication boundary**, not a cockpit screen. No session, so `GET/PUT /workspace/config` cannot be read or written; a control there would 401 or lie | **absent** |
  | `needs-org` | authenticated, no org yet | **present** |
  | `ready && !hasProjects` | authenticated, org exists, no project adopted yet | **present** |

  The last two are *authenticated local surfaces* where the workspace config is fully readable and
  writable, and where the lock the user sets is the lock their first run will use. Hiding it there
  means the first thing they do in the cockpit is discover a platform switch they could not see
  while setting the platform up.

  **Split so that policy lives in one file.** `AppShell` renders the row **whenever `globalBar` is
  provided**, independently of `chromeless`: that one prop is its whole rule, and it is the single
  place the shell deviates from "chromeless hides chrome" (the sidebar, drawer, top bar and banner
  are still suppressed, because those are navigation and D14 is about navigation).
  `AppShellContainer` decides, from the probe it already reads at `:78`, whether to pass
  `globalBar` at all: **not** for `signed-out`, **yes** for the other two. A shell that consulted
  the probe itself would be a presentational component reading auth state, which is the boundary D9
  exists to protect.

  **This narrows D14 of `.ai/specs/2026-08-06-org-team-auth-onboarding.md`**, an owner decision that
  *"no dashboard element renders before the first organization exists. The wizard is the entire
  surface until onboarding completes."* The narrowing is deliberate and argued, not incidental: D14's
  subject is the **dashboard**: data, navigation, a cockpit to get lost in before there is anything
  in it. The lock bar is neither data nor navigation; it is a machine-wide **setting**, and settings
  are exactly what onboarding is for. Phase 4 corrects D14 in place rather than leaving the two
  documents to disagree, and `signed-out` keeps D14 whole for the case it most cares about.
- **Compact by construction.** 36px, a three-segment control `Auto · Claude · Codex`. The iOS sweep
  (`packages/web/e2e/ios-sweep.e2e.ts`) asserts `scrollWidth <= innerWidth` at 390 CSS px on every
  primary view, and this row is now on every one of them.

**Which segments render.** The contract types the lock as `lockableRunnerSchema`
(`'claude' | 'codex'`, see Data models for why it is narrower than `runnerSchema`), so the bar's
segment set and the API's value set are the same set by construction rather than by agreement. Of
those, the bar renders only the ones that are discovered and not in `disabledProviders`: so a
machine with codex disabled shows `Auto · Claude`, and there is no second hardcoded list to fall out
of step with the first.

**Mirrored, not duplicated, in Settings.** `.ai/specs/2026-08-21-one-settings-area.md` owns where
settings live and makes scope a field (`appliesTo`). The lock appears in Settings → Providers
(`appliesTo: 'workspace'`, `registry.tsx`) as a read-write control over the same
`PUT /api/v1/workspace/config` key. One value, two renderers, no second store.

### D10. Interaction with `disabledProviders`: orthogonal, but fail closed

`disabledProviders` (workspace config; `PUT /api/v1/providers/:provider/enabled`, registered at
`server.ts:2867`, with the `mergeWrite` that maintains `config.disabledProviders` at
`server.ts:2876-2879`) answers "may this provider be used at all". The lock answers "which one is
used". Orthogonal, with two incoherent combinations closed at the write:

- `PUT /workspace/config { runnerLock: 'codex' }` while codex is disabled ⇒ **400**, nothing
  persisted (the route already has this shape for a rejected workspace root:
  `packages/contract/src/workspace.ts:87-90`).
- disabling the currently-locked provider ⇒ the lock is **cleared to `null`** in the same write.

Setting the lock never disables the other provider, a downgrade (D3) still needs to reach it.

**D10a. "…and the response says so" was false, and the fix is a client-side reconcile, not a
contract change.** An earlier draft of the bullet above ended that way. Measured at `95b93175`:
`providerStatusResponseSchema` is `{ providers }` and nothing else
(`packages/contract/src/workspace.ts:465-467`), so the disable response has no field that could
carry a cleared lock; provider **enablement** writes only `workspaceQueryKeys.providerStatus`; and
the `provider-status` SSE event carries a **single provider row** (`server.ts:2888-2889`). The lock
lives under `workspaceQueryKeys.config` (`packages/web/src/api/queries.ts:322`), which none of those
three touch.

**The enablement path is `queueToggle` (`provider-settings.tsx:94-140`), not a `useMutation`, and
an earlier draft pointed at the wrong line.** It cited `:154` as "invalidating the same key": that
line belongs to the **Connect** mutation's `onSuccess` and has nothing to do with enable/disable.
`queueToggle` is a `useCallback` that: reads the cached `providerStatus`, writes an **optimistic**
`setQueryData`, bumps a per-provider sequence, and appends to a serialized `writeChain` promise which
calls `setProviderEnabled` and reconciles or rolls back by `setQueryData` against
`lastConfirmed.current`. **There is no invalidation on this path at all**: which is deliberate, and
is why the reconcile has to be added rather than assumed.

So the server clears the lock on disk and **the mounted bar keeps rendering the old value until
something else refetches the workspace config**: a reload, or an unrelated settings save. A control
pinned to every screen, showing a lock that no longer exists, is the exact "a control that claims a
state the platform is not in" failure D3 already rejected once.

**Ruling: keep the provider response contract as it is, and reconcile `workspaceQueryKeys.config`
inside `queueToggle`'s existing `writeChain`.** Widening `providerStatusResponseSchema` to carry an
unrelated key would put workspace-config state on a provider-status route and give two query keys a
claim to the same value: the drift this repo's "one shape, one owner" rule exists to prevent, and a
published contract change for a client-cache problem. Invalidation is the cheaper and more honest
fix: the server is already the source of truth, and `GET /workspace/config` already answers
correctly.

Placed precisely, so the existing machinery is preserved rather than worked around:

- **inside the `writeChain` step, after `await setProviderEnabled(provider, false)` resolves**: so
  it inherits the serialization that chain exists for, and it never runs for a call that failed;
- **guarded on the cached workspace config having been locked to *this* provider**
  (`queryClient.getQueryData(workspaceQueryKeys.config)?.runnerLock === provider`), then
  `invalidateQueries({ queryKey: workspaceQueryKeys.config })`. Not on every toggle: enabling a
  provider cannot clear a lock, and disabling an unlocked one changes no lock;
- **only for `enabled === false`**, and **not** in the `catch` branch: a rolled-back toggle did not
  clear a lock server-side either, so invalidating there would refetch for nothing and could race the
  rollback's own `setQueryData`;
- **the optimistic write, the `seq === latestWrites.current[provider]` staleness check, and the
  `lastConfirmed.current` rollback are untouched.** This adds one guarded invalidation of a
  *different* key; it does not change how `providerStatus` is written, ordered, or rolled back.

Phase 3 carries the change and V5 proves it: a locked provider is disabled and the mounted bar moves
to **Auto without a reload**.

### D11. Models come for free

No model work is needed, and this is worth stating because "force every step onto codex" sounds like
it should need a model table. `resolveStepModel(step, backend, …)` (`types.ts:292-306`) reads
`step.byRunner?.[backend]`, so a step forced from claude to codex resolves the codex row of its own
authored table, `spec`'s dead `byRunner.codex = CODEX_COMPLEX` becomes reachable, exactly as
`.ai/specs/2026-08-24-codex-only-default-workflow.md` D3 established for the sibling. Beyond that,
`modelForBackend` + `normalizeModelForBackend` already drop a cross-runner model pin fail-loud
(`run.ts:7255-7262`), and `agentModelsLocked` still short-circuits classification.

## Architecture

```
                       ~/.cezar/config.json   { "runnerLock": "claude" | "codex" | null }
                                  │
   PUT /api/v1/workspace/config ─────────────┬──> persisted (atomic tmp+rename, 0600)
   PUT /api/v1/providers/:p/enabled (clears) ─┴──> semaphore.refresh()   ← D7: BOTH routes must
                                                            │              call it, and the loader
                                          WorkspaceSemaphore snapshot     must carry runnerLock;
                                                (in-memory)               neither is true today
                                                            │  sync
                                       ┌────────────────────┴────────────────────┐
                                       │        RunManager.runnerLock()          │
                                       └────────────────────┬────────────────────┘
                                                            │
   ── ENTRY GATES (D4b): 7 call sites, 4 builders, run BEFORE dispatch, can 409 ──┤
       guardRunStart · todo start · headless `cezar run` · Continue · parked-message resume
         · retarget · POST /plan (planAccountGate, server.ts:1728)
       requirementsForWorkflowRun (:185) · requirementForExistingRun (:217)
         · requirementForRetarget (:235) · requirementForPlanner (:257)
       each takes runnerLock; one workspace snapshot per request (D4b)
                                                            │
   ── SPAWN GATES (D3b): can park before any step runs ──────┤
       requeueWhileHeld (:5527 initial, :5739 post-lease) · heldAtSpawn memo (:1203, read :2162)
                                                            │
   ── DISPATCH (D4) ────────────────────────────────────────┤
       ┌──────────────────────┬──────────────────┬──────────┴───────┬──────────────────────┐
       │ a  pool lookup       │ b  taskBackend   │ c/d  step        │ e  resume affinity   │ f/g retarget
       │    (:5487)           │    (:5522)       │      (:7036/45)  │     (:2956, sync)    │  (:920/2249/4541)
       │  lock ⇒ candidates   │  applyRunnerLock │  lock ⇒ pinned;  │  applyRunnerLock     │  applyRunnerLock
       │  confined to lock    │                  │  downgrade wins  │                      │
       └──────────────────────┴──────────────────┴──────────────────┴──────────────────────┘
       h  rerouteExplicitAccountIfUnavailable (:3289, from :5507 and :4738): availability, may cross (D4a)
                                                            │
                                              GET /api/v1/workspace/config
                                                            │
                                 ┌──────────────────────────┴─────────────────────────┐
                     AppShellContainer                              Settings → Providers
                       globalBar={<EngineLockBarContainer/>}          same key, same route
                            │  (same ownership as banner={<ProviderBannerContainer/>})
                            ▼
                     AppShell: presentational, NO QueryClient (app-shell.tsx:819-826)
                       row 2 renders the globalBar slot, data-slot="global-bar", every screen
                            │
                            ▼
                     EngineLockBar: value / options / onChange, no queries


   ── CLUSTER (Phase 2a), hub-authoritative, MINOR protocol bump 1→2 ──────────────

     HUB                                              SPOKE
     semaphore.refresh() sees a transition (D7a)
        ├── on placement ──> dispatch frame + runnerLock ──> offerDispatch
        └── on transition ─> NEW `runner-lock` frame ─────>  SpokeRuntime.hubRunnerLock
             (and on handshake, so a reconnect converges)       (IN MEMORY, never persisted)
                                                                     │
                                              resolveDispatchManager's start path
                                                                     │
                                        applyRunnerLock(hubRunnerLock ?? own, …)
                                                                     │
                                   dispatched runs follow the HUB; spoke-authored
                                   runs keep the spoke's own ~/.cezar/config.json
     link down: keep last hubRunnerLock for dispatched work, own value for self-authored;
                a restart while disconnected has no hubRunnerLock and falls back to own
     older spoke: parseDownlink drops the unknown frame, socket stays open (corpus-changed rule)
```

## Data models

`~/.cezar/config.json`, one new top-level key, additive:

```jsonc
{
  "runnerLock": "claude"   // "claude" | "codex" | null   (absent or null = Auto)
}
```

`packages/cezar/src/workspace/config.ts`, house rules of that file apply verbatim: optional,
`.catch(undefined)` so a bad value degrades to "no lock" rather than discarding the file,
`.passthrough()` preserved, bounds mirroring the PUT schema exactly.

```ts
runnerLock: lockableRunnerSchema.nullable().optional().catch(undefined),
```

**`lockableRunnerSchema` is `z.enum(['claude', 'codex'])`, NOT `runnerSchema` / `PROVIDER_IDS`, and
that narrowing is deliberate.** An earlier draft typed the lock over all four `RunnerId`s "generic,
like `pinWorkflowRunner`". That creates API states nothing can honour: `PROFILE_ENV_VAR`
(`core/agent-profiles.ts:40-45`) maps `opencode` and `pi` to `null`, so
`PROFILE_CAPABLE_PROVIDERS` (`:48-50`) is exactly `['claude', 'codex']`: and that is the list every
mechanism this spec touches is built on. `resolvePoolForDispatch`, `resolvePoolForProvider` and
`downgradePinnedRunner` all draw candidates from `listAgentProfiles(accounts,
PROFILE_CAPABLE_PROVIDERS)`, so a lock of `pi` would be a value the bar cannot offer, the pool
cannot resolve, and the downgrade ladder cannot fall back from. A schema that admits it is a
400-shaped bug the type system could have refused.

`pinWorkflowRunner` being generic is not a precedent for this: it stamps a value that a human
authored into a workflow file, whereas the lock is a value this spec's own UI writes and this spec's
own account machinery must resolve.

**One list, pinned in both directions.** `packages/contract/` is node-free (README rule 1) and
cannot import from `packages/cezar/src/`, so `lockableRunnerSchema` is declared in the contract
beside `runnerSchema` (`packages/contract/src/health.ts:4`) and `workspace/config.ts` imports it
rather than restating the pair, the same rule that file already follows for `PROJECT_TAGS_MAX`
(`:9`) and `PROVIDER_IDS` (`:10`). To stop the two lists drifting silently, the cezar side asserts
that the contract enum and `PROFILE_CAPABLE_PROVIDERS` still agree.

**That assertion has to be a RUNTIME test, not the pair of type assignments an earlier draft
proposed**, and the reason is worth stating so nobody reintroduces them.
`PROFILE_CAPABLE_PROVIDERS` is declared `readonly ProviderId[]` (`agent-profiles.ts:48`): a widened
type, not a literal tuple, because it is computed by `.filter()` over `Object.keys(PROFILE_ENV_VAR)`.
So `const _a: LockableRunner[] = [...PROFILE_CAPABLE_PROVIDERS]` does **not compile today** (a
`ProviderId` is not assignable to `LockableRunner`) and would be deleted as broken, while the reverse
`const _b: ProviderId[] = [...LOCKABLE_RUNNERS]` compiles forever and checks only that the lock's
values are *some* provider: precisely blind to the widening it was meant to catch. Two assertions,
one that never compiles and one that never fails.

The honest check compares the values:

```ts
// packages/cezar/src/workspace/runner-lock-list.test.ts
it('the lockable runners are exactly the profile-capable providers', () => {
  expect([...LOCKABLE_RUNNERS].sort()).toEqual([...PROFILE_CAPABLE_PROVIDERS].sort())
})
```

It goes red the day a third provider becomes profile-capable, which is the day the lock, the bar and
the pool each need a decision rather than a silent widening. Named in Verification as **V1a**.

(The alternative is to make the source literal-aware: declare `PROFILE_ENV_VAR` with `satisfies` and
derive a literal union, which would give a genuine compile-time guarantee. It is a change to a
shared core type for the benefit of this one feature, so it is **not** taken here; the runtime test
buys the same protection at the cost of one test file.)

Expanding the lock to all four providers is possible, but it is not a schema change: it is
implementation and verification work on the pool, the downgrade ladder and multi-account support,
and it is out of scope here.

**`.catch(undefined)`, not `.catch('claude')`:** a corrupt value must degrade to *no opinion*, never
to a silent platform-wide pin nobody set.

`WorkspaceSemaphore` snapshot (`semaphore.ts`), beside `fallbackAcrossAccountsWhenLimited`:

```ts
runnerLock?: LockableRunner;                // absent = Auto
runnerLock(): LockableRunner | undefined;   // sync accessor, mirrors :321-322
```

**Cluster (Phase 2a), and note none of it is persisted on the spoke:**

```ts
// packages/contract/src/cluster.ts: additive, MINOR bump to 2
clusterDispatchFrameSchema: { …, runnerLock: lockableRunnerSchema.nullish() }   // :1784

export const clusterRunnerLockFrameSchema = z.object({   // new downlink frame, modelled on
  type: z.literal('runner-lock'),                        // clusterCorpusChangedFrameSchema (:1766)
  protocol: clusterProtocolSchema,
  runnerLock: lockableRunnerSchema.nullable(),           // null = Auto
}).strict();

// spoke, IN MEMORY on SpokeRuntime: never written to ~/.cezar/config.json
hubRunnerLock?: LockableRunner;   // absent = no hub opinion; the spoke's own value applies
```

**Why in-memory rather than persisted** is the same argument as the separation itself: a value
written to the spoke's config would outlive the link, survive a restart, and read to an operator on
that machine as their own setting. Losing it on restart is correct: a disconnected spoke that
cannot know the hub's current intent must fall back to its own, not act on a stale one.

Run record: **no new field.** D6 removes the need for a per-run opt-out, and the step's `backend`
column already records what actually ran (`run.ts:7046`), which is the only per-run fact needed.

## API contracts

Both changes are **additive**, which matters: cezar publishes `@loki-labs/cezar-plus` and
`BACKWARD_COMPATIBILITY.md` applies. An older client ignores the key; an older server receiving it
answers 400 from its own strict schema, which is the honest answer.

`packages/contract/src/workspace.ts`, `workspaceConfigResponseSchema` gains (this file already
imports `runnerSchema` from `packages/contract/src/health.ts:4`; `lockableRunnerSchema` is declared
alongside it there and is added to that same import, so no new module dependency appears, and one
symbol serves both schemas below):

```ts
/** The global provider lock (`.ai/specs/2026-08-29-global-provider-toggle.md`). `null` = Auto,
 *  which is byte-for-byte the behaviour that predates this key. ALWAYS present on the wire,
 *  `workspaceConfigBody` materializes it, with the tri-state in the value, matching how
 *  `projectDefaults` reports absence. */
runnerLock: lockableRunnerSchema.nullable(),
```

`setWorkspaceConfigInputSchema` gains:

```ts
/** `null` CLEARS the lock back to Auto, the one thing a bare absent key cannot say in a partial
 *  patch, same convention as `agentDefaults.runner` and `projectDefaults`. */
runnerLock: lockableRunnerSchema.nullable().optional(),
```

with `lockableRunnerSchema` declared beside `runnerSchema` in `packages/contract/src/health.ts` and
exported for the cezar side:

```ts
/** The providers a global lock may name: exactly the profile-capable ones. Narrower than
 *  `runnerSchema` on purpose, see Data models for why a four-value lock is an unhonourable API. */
export const LOCKABLE_RUNNERS = ['claude', 'codex'] as const;
export const lockableRunnerSchema = z.enum(LOCKABLE_RUNNERS);
export type LockableRunner = z.infer<typeof lockableRunnerSchema>;
```

A body naming `opencode` or `pi` is therefore a **400 from the schema**, not a value that persists
and then fails to resolve at dispatch. That is the whole point of narrowing it here rather than
guarding it in the handler.

`PUT /api/v1/workspace/config` semantics:

| body | result |
| --- | --- |
| `{ runnerLock: "claude" }` | 200; persisted; `semaphore.refresh()`; live from the next dispatch |
| `{ runnerLock: null }` | 200; cleared to Auto |
| `{ runnerLock: "codex" }` while codex ∈ `disabledProviders` | **400**, nothing persisted (D10) |
| absent key | untouched (partial-patch rule, unchanged) |

`PUT /api/v1/providers/:provider/enabled { enabled: false }` on the locked provider additionally
clears `runnerLock` to `null` in the same write (D10).

**Cluster wire (Phase 2a).** Two additive changes to the hub→spoke downlink, `CLUSTER_PROTOCOL_MINOR`
1 → 2, no MAJOR bump:

| change | direction | when |
| --- | --- | --- |
| `runnerLock` on `clusterDispatchFrameSchema` (`cluster.ts:1784`) | hub → spoke | every offer, carrying the hub's value at placement |
| new `runner-lock` frame | hub → spoke | on a `refresh()` lock transition (D7a) and on handshake |

Compatibility is the `corpus-changed` precedent verbatim: an older spoke's `parseDownlink` fails to
`safeParse` the unknown frame, warns, drops that one frame, and leaves the socket open. It keeps
running under its own lock (the pre-Phase-2a behaviour), which is degradation, not
half-application. No uplink change: the spoke reports the `backend` it ran on through the run
record it already replicates, so the hub needs no acknowledgement frame to see whether the lock
took.

No new HTTP route. No change to `POST /runs`, `POST /workspace/runs`, `POST /runs/:id/agent` or
`cezar run` bodies, the lock is read server-side at dispatch, which is precisely why it reaches
every caller including the CLI.

### Analytics

Named while designing, per the workspace rule:

| event | when | fields |
| --- | --- | --- |
| `run.runner_locked` | a dispatch where `applyRunnerLock().locked === true` | `runId`, `stepId?`, `workflow`, `lockedRunner`, `wouldHaveBeen`, `site: 'pool' \| 'run' \| 'step' \| 'resume' \| 'retarget'` |
| `run.step.runner_downgraded` | **existing**, `run.ts:3443-3450` (`:3438-3442` is its comment block) | **+ `lockedRunner`**, a downgrade under a lock must be countable apart from an ordinary step-pin downgrade |
| `run.account_fallback` | **existing**, `run.ts:3459-3472` (pinned-step site) and the explicit-reroute site | **+ `lockedRunner`**, required by D4a for the reroute that crosses a lock |
| `settings.runner_lock_set` | a successful `PUT` of the key, emitted **server-side** in the route handler | `runner` (`'claude' \| 'codex' \| null`), `previous`, `source: 'workspace-config-put' \| 'provider-disabled'` |

Two corrections to an earlier draft of this table, both of which were internal contradictions rather
than matters of taste:

- **`run.account_fallback` is NOT left alone.** The earlier text said it was, on the grounds that its
  `site: 'pinned-step'` value stays accurate: which is true and beside the point. D4a requires the
  cross-lock reroute to be countable, and V3 asserts `lockedRunner` on this event. Its `site` field
  is unchanged; the new field is additive, exactly like `run.step.runner_downgraded`'s.
- **`surface: 'global-bar' | 'settings'` is dropped**, and replaced by `source` above. There is no
  client-side analytics transport in this design and the shared `PUT /workspace/config` body carries
  no surface discriminator, so a `surface` field could only have been produced by inventing one or
  by guessing: and a guessed provenance field is worse than no provenance field. `source`
  distinguishes the two writes that actually exist **server-side**: the ordinary PUT (D7) and the
  implicit clear when the locked provider is disabled (D10), which is the distinction that matters
  for reading the data ("did a person turn this off, or did the system?"). If per-surface attribution
  is wanted later it needs a real discriminator on the request, which is a contract change and is not
  smuggled in here.

Both event shapes are named by tests: `run.account_fallback`'s `lockedRunner` in V3, and
`settings.runner_lock_set`'s two `source` values in V4 (the PUT path and the provider-disable path,
which V4 already exercises for the accessor).

## Phases

Phases 1 through 4, **including 2a**, are **logical slices, not separate commits**: each is
independently reviewable, and they land together as ONE feature commit in Phase 5 after the gate of
V7, per the repo's one-commit-per-feature rule. (2a is lettered rather than renumbered because it is
the same interception as Phase 2, applied across the cluster link; it is reachable only on a
multi-node install and inert on the single-node default.) **Phase 4 (the tracked record) is inside that set deliberately**, it
edits tracked files, so it has to be in the commit rather than after it. Only Phase 6 (untracked and
external) and Phase 7 (QA evidence that does not exist yet) come later.

**Where a phase names a verification, that is a dependency, not authorization to run it.** Per
Verification's opening rule, every command in this spec (unit suites, the browser e2e, `typecheck`,
`test`, `test:unit`, `build`, `test:package`, and the live runs) needs explicit owner approval
before execution. A phase saying "Verified by V2, V3" means those must pass before it is done, and
that someone has to be asked before they are run.

**Phase 1: the value and its plumbing (no behaviour change).** `lockableRunnerSchema` +
`LOCKABLE_RUNNERS` in the contract and the drift assertion against `PROFILE_CAPABLE_PROVIDERS` (Data
models); the key on both workspace schemas; `workspaceConfigBody` materializes it;
`workspace/config.ts` schema entry with `.catch(undefined)`; the `WorkspaceSemaphore` snapshot field
and sync accessor **plus all three D7 wiring changes** (`loadResourceLimits` carries `runnerLock`,
the workspace `PUT` refreshes on a lock-only body, and the provider-disable route refreshes at all);
the `PUT` validation of D10 and the enable/disable interaction; `runner-lock.ts` with
`applyRunnerLock`; the `settings.runner_lock_set` event; and the **`onRunnerLockChanged?()` seam**
that D3b item 2 needs: declared on `SemaphoreParticipant`
(`packages/cezar/src/workspace/semaphore.ts:101-131`, optional) and fanned out from
`WorkspaceSemaphore.refresh()` (`:435-443`), with `RunManager`'s implementation deferred to Phase 2.
Declaring the seam here and filling it there keeps Phase 1's "no behaviour change" claim true: an
unimplemented optional hook does nothing. Verified by **V1, V1a, V4**.

**Phase 2: the interception (the feature).** The eight dispatch sites of D4 plus the pool narrowing
of D5; the D4b entry gates: the `runnerLock` input on all **four** requirement builders plus the
snapshot threading at all **seven** callers, including the two that need a workspace read added
(`planAccountGate`, `server.ts:1728-1745`; headless `cezar run`, `index.ts:1078`); the D3b spawn
gates and the
`heldAtSpawn` memo rule: `RunManager`'s `onRunnerLockChanged` implementation at its registration
(`run.ts:1295-1301`), dropping `heldAtSpawn`/`heldNotified` for every queued run whose target the
lock changes, as `retargetQueuedRun` does at `run.ts:2293` and in the shape `run.ts:1993` already
uses; write none from a waved-through spawn gate; keep the one a D3a dispatch park writes;
`heldAccountFor`'s own-account branch (`run.ts:2158-2161`, D3b item 3) and
the D3c rule that all three `fallbackAcrossAccountsWhenLimited` sites (`:2159`, `:3297`, `:3402`)
behave as enabled under a lock; the widened `pinned` of D3 with the three dispatch-level parks left intact
per D3a and the amended downgrade note; the account re-resolution of D6a; the four D4c model-call
paths; the `run.runner_locked`, `run.step.runner_downgraded` and `run.account_fallback` event
changes. Verified by **V2, V3**, and by V4's gate-tier and model-call cases.

**Phase 2a: the lock crosses the cluster, hub-authoritative.** Only reachable on a multi-node
install, and skipped entirely on the single-node default: but not optional there, per the withdrawn
non-goal below.

- **The hub's lock is the platform's lock.** A spoke's own `runnerLock` does not govern dispatched
  work; it governs work that spoke starts for itself. This mirrors how `acceptsDispatch` is already
  stored on both sides with the **spoke** enforcing (`dispatch.ts:18-22`): the two nodes hold their
  own state, and which one wins is decided per question rather than globally.
- **Two paths, not one, because a dispatch field alone cannot deliver a mid-run flip.** An earlier
  draft said "a field on the dispatch offer" and left it there. That is necessary and insufficient:
  the offer is sent **once**, at placement, so a lock flipped while a remote run is in flight would
  never reach the spoke: and the mid-run flip is half of what V2a exists to prove. Both paths:

  1. **Initial, on the offer.** `clusterDispatchFrameSchema` (`packages/contract/src/cluster.ts:1784`)
     gains `runnerLock: lockableRunnerSchema.nullish()`. The offer already travels by value
     (`dispatch.ts:24-25`, *"The workflow travels by value, never by name"*), and the lock is that
     kind of value: a fact about a decision the hub already made.
  2. **Updates, on a new `runner-lock` downlink frame**, modelled on `corpus-changed`
     (`contract/cluster.ts:1766-1776`): hub → spoke, `{ type, protocol, runnerLock }`, emitted
     when `refresh()` observes an actual transition (D7a's rule, reused rather than restated) and
     on handshake so a reconnecting spoke converges without waiting for a dispatch.

- **Protocol compatibility: MINOR, not MAJOR, and that is measured rather than assumed.** The rule
  at `CLUSTER_PROTOCOL_MAJOR` (`cluster.ts:80-85`) reserves MAJOR for *"a new envelope key, a
  REMOVED frame, or a changed meaning"*; an added frame and an added optional field are neither.
  `corpus-changed`'s own docblock records the measurement for exactly this case: `link-client.ts`'s
  `parseDownlink` `safeParse`s the union and drops one unparseable frame while leaving the socket
  open, so **an older spoke ignores the lock frame and keeps working**, which is degradation rather
  than half-application. Bump `CLUSTER_PROTOCOL_MINOR` to 2.
- **Stored SEPARATELY from the spoke's own lock, and this is the load-bearing part.** The spoke does
  **not** write the hub's value into its `~/.cezar/config.json` and does **not** mutate its
  `WorkspaceSemaphore` snapshot. Doing either would override the spoke's **local** work with the
  hub's lock, which contradicts the hub-authoritative rule's own scope ("a spoke's own `runnerLock`
  governs work that spoke starts for itself") and would silently rewrite an operator's machine
  setting from another host. Instead the spoke holds it in memory on its cluster runtime,
  `SpokeRuntime`, beside the dispatch state it already keeps, as `hubRunnerLock`, and
  `resolveDispatchManager`'s start path passes it down as the run's lock.
- **How a cluster-dispatched run reads it.** `applyRunnerLock` already takes the lock as an
  argument (D4), so the only change is *which* value the spoke hands it for a dispatched run:
  `hubRunnerLock` when set, the spoke's own `semaphore.runnerLock()` otherwise. One expression, at
  the dispatch executor, so locally-started work on the same spoke is untouched by construction.
- **Clearing.** `runnerLock: null` on either path clears it; the frame is sent for a
  lock→Auto transition exactly as for any other. `null` and absent are the same value, per Data
  models: so a spoke that never receives a frame and one told "Auto" behave identically.
- **D2's next-step semantics hold across the link.** A remote run already in flight picks the lock
  up at its **next step**, because the spoke's dispatch sites (D4) read `hubRunnerLock` at each
  step: the same rule as a local run, with the same cost noted in R2. This is what the update frame
  buys, and it is why the offer field alone is not enough.
- **Link-down semantics, stated for both directions.** A spoke that cannot hear the hub keeps the
  last `hubRunnerLock` it was told for runs already dispatched (the hub's last known intent beats
  guessing), and starts anything it authors **itself** under its own local value, exactly as
  `account-grants.ts:369-370` specifies for balancing (*"when the hub is unreachable at dispatch,
  the spoke balances locally"*). Nothing blocks on the link. A spoke that restarts while
  disconnected has no `hubRunnerLock` (it is in-memory, deliberately) and falls back to its own,
  the honest answer, since it cannot know the hub's current intent and must not act on a stale one
  it persisted.
- **Degrades to today when the link is down.** A spoke that cannot hear the hub runs what it
  authored under its own value, exactly as `account-grants.ts:369-370` already specifies for
  balancing (*"when the hub is unreachable at dispatch, the spoke balances locally"*). Nothing
  blocks on the link; that is the standing cluster rule and this does not get to break it.

Verified by **V2a**, the two-process remote-dispatch case, which is the only thing that can prove
this: a hub-set lock and a mid-run flip, asserted on the **spoke's** run record.

**Phase 3: the surface.** The D9 boundary, in three pieces so the presentational shell stays
query-free: the `globalBar?: ReactNode` prop on `AppShell` (beside `banner`, `app-shell.tsx:119-122`)
rendered into the new row, including the `row-start-N` renumbering of the three rows below it;
`globalBar={<EngineLockBarContainer/>}` in `AppShellContainer` next to the existing
`banner={<ProviderBannerContainer/>}` (`app-shell-container.tsx:178`); and the two components
themselves: `EngineLockBarContainer` (queries + the `PUT`) and the presentational `EngineLockBar`.
Then the Settings → Providers mirror; the
`picker-pill.tsx` copy change of P6 (a second string chosen by lock state, with
`packages/web/src/routes/task-thread/follow-up-engine.test.tsx` and
`packages/web/src/components/agent-pool-rows.test.tsx` updated); **the `resources-section.tsx` copy
of D3c** (`packages/web/src/routes/settings/resources-section.tsx`: the lock-override note beside
the `fallbackAcrossAccountsWhenLimited` control at `:113`, and the conditional off-toast wording at
`:118-121`); **the D10a cache reconcile** in `packages/web/src/routes/settings/provider-settings.tsx`, inside
`queueToggle`'s serialized `writeChain` (`:94-140`) after a successful
`setProviderEnabled(provider, false)`, guarded on the cached config being locked to that provider,
**not** at `:154`, which is the Connect mutation and unrelated; and **the provider-fixed rendering of
every engine picker**, per D2 rank 5 and D6.

**That last item is a list, not a phrase.** An earlier draft said "the retarget and follow-up
pickers", which named no file and omitted the composer pill: the one D2 rank 5 is actually about,
and the first place a user meets the contradiction:

| surface | file |
| --- | --- |
| the shared pill component every picker renders through | `packages/web/src/components/engine-pills.tsx:168` |
| the composer (`/new`), D2 rank 5's own subject | `packages/web/src/routes/new-task.tsx` |
| the follow-up composer in a thread | `packages/web/src/routes/task-thread/follow-up-engine.tsx` |
| "Run on…" retarget | `packages/web/src/routes/task-thread/retarget-engine.tsx` |
| Inbox quick-start | `packages/web/src/routes/inbox.tsx:347` |
| GitHub hand-to-agent | `packages/web/src/routes/github/hand-to-agent.tsx:265` |
| the advisory/lock disclosure line the pills render | `packages/web/src/components/picker-pill.tsx:169` (P6) |

The last two are the ones a "retarget and follow-up" reading drops entirely, and both start runs.

**Behaviour, uniform across all of them** (D6, D6a): while a lock is set the **provider is displayed
and fixed**: not hidden, so the user can see *why* they cannot change it, with the one-line reason;
**model selection is preserved** in full; and **account selection is preserved but scoped to the
locked provider's own accounts**, never a foreign provider's id (D6a's provider-scoped-account
rule). Doing this in `engine-pills.tsx` and `picker-pill.tsx` rather than six times is what makes
the six surfaces agree by construction. Cases in **V5d**.

Verified by **V5, V6**.

**Phase 4: the tracked record, BEFORE the gate.** Everything in this phase edits a **tracked file**,
so it belongs in the feature commit, not after it. An earlier draft ordered this the other way and
that ordering cannot satisfy the repo's one-commit-per-feature rule: committing Phases 1-3 first and
then editing this spec, `2026-08-24-codex-only-default-workflow.md` and five source comments leaves
a dirty tree behind the feature commit, which then needs either a second commit or an amend. Both are
the thing the rule forbids. The `commit-push` step's own post-condition (`nothing uncommitted and
nothing unpushed`, AGENTS.md) would fail on it too.

So: do Phase 4's items 1 and 2 below, **then** V7, **then** the single commit.

1. Set this spec's **Status** to `Implemented / QA Needed`. `Implemented` only after **V8** has
   actually run and passed, which is a later, separate edit (Phase 7).
2. **Correct nine documents in place**, house form, a bolded `**CORRECTED 2026-08-29
   (`.ai/specs/2026-08-29-global-provider-toggle.md`):** …` lead-in with the **original text left
   below it unchanged**, never a rewrite:
   - `.ai/specs/2026-08-24-codex-only-default-workflow.md`, a spec-level banner, and a lead-in on
     **D8** ("the workflow wins, visibly"), which is false while a lock is set. This satisfies the
     task's acceptance criterion 4.
   - `packages/cezar/src/workflows/run.ts:7022-7045`, the comment block explaining the pin/downgrade
     precedence. **Three facts in it, not one.** The precedence claim no longer describes the top of
     the stack; and the block carries two stale counts of exactly the kind two bullets below correct,
     from the same `review-spec-local` cause: `:7028` says the codex sibling *"pins all nine
     steps"* (P3: **ten**), and `:7027` says *"Today only `spec` pins Claude"* (P3: **three**
     authored pins: `spec` and `review-spec-local` on `SPEC_AUTHORING_RUNNER`, `review-spec` on
     codex). The citation is widened to `:7022` to take in that sentence. Correcting "nine" at
     `:3438` while leaving "nine" at `:7028` would make the record contradict itself **inside one
     file**, which is the failure the `:3438` bullet's own rationale argues against.
   - `packages/cezar/src/workspace/agent-route-select.ts:314-316`, *"This does NOT decide todo
     `81ab4ebd`"*, plus the `resolvePoolForDispatch` docblock at `run.ts:5483-5484` (*"`pool:*` picks
     the PROVIDER too"*), now true only when the lock is unset.
   - `packages/web/src/components/picker-pill.tsx:163-170`, the `ADVISORY_NOTE` rationale (P6).
   - `packages/cezar/src/workflows/run.ts:3438-3441`, whose downgrade-count sentence (*"nine steps
     can downgrade on `spec-to-deploy-codex` where the default chain has two"*) was already stale at
     `95b93175`, before this feature: the chain gained `review-spec-local`, so the true counts are
     **ten** and **three** (P3, D3). Correcting it is a prerequisite for the arithmetic in D3 being
     checkable against the code rather than against a comment that disagrees with it.
   - `packages/cezar/src/workflows/types.ts:904`, the `SPEC_AUTHORING_RUNNER` doc comment, which
     says *"The other six steps carry no runner"* when there are now **seven**. Same family and same
     cause as the bullet above (`review-spec-local`), found while re-reading the chain for P3, and
     the same argument applies: a reader who trusts it counts the chain wrong.
   - `packages/web/src/components/app-shell.tsx:158-166`, the **"Layout contract"** docblock, which
     states *"The main column is a `auto auto 1fr auto` grid, top bar / banner / scroller / composer
     dock"*. D9 takes that grid to **five** rows, so this is the one comment **this spec's own
     change** makes false rather than one it merely found stale. Corrected to
     `auto auto auto 1fr auto` with the global bar named between the top bar and the banner, and the
     `row-start-*` sentence kept: it is still the rule, and it is now load-bearing for five rows
     instead of four. **R4 is precisely the risk of this grid and its description disagreeing**, and
     Phase 3 already edits this file, so it costs nothing to keep them in step. **The same edit fixes
     the inline `{/* Row 4: the composer dock … */}` comment at `app-shell.tsx:316`**, which the
     renumber makes false in the same file: the dock is row 5 once the global bar exists.

   - `packages/cezar/src/workspace/semaphore.ts:58-59`, which documents
     `fallbackAcrossAccountsWhenLimited` as *"Default OFF: overriding an explicit pick is a product
     decision, not a bug fix"* while the actual default has been **ON** since
     `.ai/specs/2026-08-23-never-block-a-task.md` (`:143` sets `true`, and the accessor at
     `:321-322` is `?? true`). D3c reasons directly about that default, and
     `resources-section.tsx:101-108` already carries the corrected version of the same note, so this
     is one comment disagreeing with both the code beneath it and the UI above it.

   - `.ai/specs/2026-08-06-org-team-auth-onboarding.md` **D14** (its table row at `:82` and the
     decision at `:1391`), which says *"no dashboard element renders before the first organization
     exists. The wizard is the entire surface until onboarding completes."* D9 narrows it: the
     global lock bar renders on the two **authenticated** onboarding states (`needs-org`,
     `ready && !hasProjects`) because it is a machine-wide setting rather than a dashboard element,
     while `signed-out` keeps D14 exactly as written. This is an **owner decision being narrowed**,
     so the lead-in says so explicitly and points here for the argument, rather than presenting it
     as a stale fact: it is neither stale nor wrong, it is being scoped.

   Note this is now **nine** documents, not four. Six are stale facts this spec discovered rather
   than created; `app-shell.tsx` is one it creates; and D14 is a live decision it narrows, which is
   the one that most needs marking, because nothing about D14 reads as provisional today.

**Phase 5: the gate and the commit.** V7, then ONE commit carrying Phases 1-4 (2a included), the code and the
tracked record together, which is what leaves the tree clean. **Ask before running V7**: it is five
commands including a full `build` and a `test:package` pack, and the standing rule covers builds and
tests alike. Committing on a gate nobody was allowed to run is not an option either: so the ask
happens here, before the gate, not after it.

**Phase 6: the external record, after the commit.** Nothing here touches a tracked file, the KB
write file is outside the repo, and `.ai/cezar/` (so `todos.json`) is gitignored (`.gitignore:11`),
which is *why* this is the only record work that may follow the commit. In the same session:

1. Append to `CEZ_KB_WRITE_FILE` (NDJSON, never a direct edit of a mounted doc): one `upsert`
   recording **the precedence rule of D2/D3** as a durable decision, and one `upsert` for the
   changelog entry. This is the task's acceptance criterion 4, second half.
2. Append `supersede` proposals against the two records that read as current and become partly false:
   **`notion-4dee7a4df2f1`** (*"a task created explicitly on codex can be dispatched to a claude
   account"*, still true unlocked, false under a lock) and **`notion-5ce876561d8f`** (*"An engine
   choice is now a preference"*, narrowed: still true of the pill, no longer true of the lock).
   Both land as **proposals**, since a `supersede` op cannot rewrite the read-only `notion` mount, and
   the correction is real only once applied through the cockpit or `cez kb proposals`.
3. Append one line to todo `3c0639ea`'s context per D8. **Do not close it.**
4. **The corpus write is not a KB write until reindexed**, and the failure is silent both ways:

   ```bash
   cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex
   cez kb search "global provider lock precedence"        # must return the new entry
   grep -ac "global-provider-toggle" /var/lib/cezar/loki-labs/.ai/cezar/knowledge-index/catalog.ndjson  # want 1
   find /var/lib/cezar -not -user cezar | wc -l           # must be 0
   ```

**Phase 7: QA, not code.** **V8**, the live runs, on owner approval. Until V8 passes this is
`Implemented / QA Needed` and must say so in its own Status line.

**CORRECTED 2026-08-29, after the feature commit landed:** do not run V8 yet. See "Known
implementation gap" near the top of this document — D4's dispatch-time wiring is missing, so V8
would fail on its own acceptance check rather than pass or reveal a smaller defect. Phase 7 is
blocked on a follow-up implementation pass, not on owner approval to spend quota.

Flipping that Status to `Implemented`, and recording V8's three run ids and step tables, is a second,
later edit to this tracked file. It is **not** a violation of the one-commit rule and must not be
folded into the feature commit: it records evidence that does not exist yet at commit time, on a run
that needs owner approval to start. It is a follow-up commit about QA, not part of the feature.

**Explicit non-goals**, stated so they are not read as oversights:

- **A strict "never downgrade" mode.** Rejected in D3; the reasons are there, and reversing it is an
  owner decision, not an implementation detail.
- **Per-project locks.** "Global" is the whole ask.
- **A per-step policy table, or a step naming a SET of runners to balance across.** That is todo
  `3c0639ea` and it stays open (D8).
- ~~**Cluster propagation.**~~ **WITHDRAWN as a non-goal; it is Phase 2a.** An earlier draft deferred
  this on the strength of not having read the cluster spec. Read now, it is not deferrable:
  **remote dispatch is shipped and the spoke RUNS the work.** `spoke-runtime.ts:44-61` records
  Milestone C (2026-08-23): a dispatched run is accepted and started through the spoke's **own**
  `RunManager`, resolved by `resolveDispatchManager` (`:350-361`), through the same `startTodoRun`
  autostart uses, `via: 'cluster-dispatch'`. That manager reads **its own** node's
  `semaphore.runnerLock()`, which is `~/.cezar/config.json` on the worker. So a hub locked to Claude
  would render Claude while a worker executed Codex: the toggle stating something false about the
  owner's own platform, which is the single outcome this spec exists to prevent. Deferring it also
  fails the task's own words twice over, "switches the whole platform" and "for every workflow".
- **Removing `spec-to-deploy-codex`.** It stays; under a lock it is redundant, unlocked it is not.

## Risks

**R1: a stale in-memory lock runs the wrong provider silently, and the existing wiring does NOT
prevent this on its own.** The read is in-memory (D7), so a `RunManager` whose semaphore missed
`refresh()` uses the old value with nothing on screen saying so. An earlier draft called this
"mitigated by riding the existing hook", which was wrong three ways, all measured at `95b93175` and
now specified as work in D7: the loader copies only `resources`, the workspace `PUT` refreshes only
when `resources` changed, and the provider-disable route never refreshes. The failure is
particularly nasty because `GET /workspace/config` reads the **file** and so reports the new value
while the loop still runs the old one, making the API agree with the user and the behaviour disagree
with both. Mitigated by the three D7 changes and by V4 asserting the accessor after **both** write
paths, with a lock-only PUT body (a test that also sets `maxParallel` passes on the old gate and
proves nothing).

**R2: flipping the lock mid-run restarts a resumed step rather than resuming it.** `run.ts:2948-2960`
starts a step fresh when `sessionBackend !== stepBackend`, and its comment already calls that "safe in
both directions and lossy in one". A flip makes the mismatch deliberate. **Accepted**: a session is
never handed to the wrong provider, and the cost is one re-run turn. Stated so it is not later
diagnosed as a bug.

**R3: a lock funnels the whole workspace into the downgrade path.** Locking to a provider whose
accounts are all held means every step of every run evaluates and takes the downgrade, and D3b means
the run is no longer parked before it gets there. Loud rather than silent, but **loud in the RUN**,
not on the bar (D3 withdrew that promise): the notes and the two metric events are the only place
this is visible, so a user watching the toggle alone sees `Claude` while work runs on Codex. That is
a real change in cost, in what the record contains, and in what the shell can tell you.

**R4: the `AppShell` grid renumbering fails silently.** Adding a row means three `row-start-N`
values shift; a missed one overlaps two regions with no error. V5a asserts the numbers, in the
no-QueryClient shell suite, so the check survives the D9 container split.

**R5: published-package surface.** `@loki-labs/cezar-plus` is public and
`BACKWARD_COMPATIBILITY.md` applies. Both schema changes are additive and `null`/absent is exactly
today; nothing is renamed, including the semaphore's `limits` bag (D7).

**R6: one switch, whole workspace, every project, every user of the box.** That is what "global"
means and it is the ask, but on `prod-host` it is also a shared machine. The mitigation is
visibility rather than permission: the control is on every screen, so nobody can be locked without
seeing it. No per-user scoping is in scope.

**R7: the mobile row costs 36px on every screen.** Real, and it is why the row is a compact
segmented control and why V6 re-asserts the 390px no-overflow property that `ios-sweep.e2e.ts`
already owns.

## Verification

Concrete and executable. Every command runs from the repo root of `cezar`.

**Every command in this section needs explicit owner approval before it is run: not only V8.** The
standing instruction is to ask before building or running anything, and an earlier draft of this
section gated only the live runs, which reads as scheduling V1 through V7 to execute on sight. That
is wrong in both directions: it under-asks for the five commands of V7 (a full build and a package
pack), and it makes V8's own approval line look like the exception rather than the rule.

So: **the spec lists what must pass and how to check it; it does not authorize running any of it.**
Ask once, for the set you are about to run, and say which. The distinction that survives is about
*cost and blast radius*, not about permission:

- **V1-V6** are local and read-only in effect (unit suites, a browser e2e against a dry-run
  environment). One approval covers a batch.
- **V7** is the full gate: `typecheck`, `test`, `test:unit`, `build`, `test:package`. It writes
  `dist/`, packs a tarball, and takes real time.
- **V8** starts **real runs and spends real quota** on a live box, so it needs its own approval every
  time, not a batch one, and it is called out again at its own heading.

Phases 1-3, 5 and 7 each name the verification they depend on; that naming is a dependency, never a
licence to execute.

**V1 (unit, Phase 1): the precedence function, as a table.**
New `packages/cezar/src/workflows/runner-lock.test.ts`. `applyRunnerLock`:

- `(undefined, 'codex')` ⇒ `{ runner: 'codex', locked: false, wouldHaveBeen: 'codex' }`, the
  identity that makes "unset is byte-for-byte today" testable;
- `('claude', 'codex')` ⇒ `{ runner: 'claude', locked: true, wouldHaveBeen: 'codex' }`;
- `('claude', 'claude')` ⇒ `locked: false`, the lock agreeing with the request is not an override,
  and the metric must not fire.

`npm test -- packages/cezar/src/workflows/runner-lock.test.ts`

**V1a (unit, Phase 1): the two provider lists have not drifted.**
New `packages/cezar/src/workspace/runner-lock-list.test.ts`, the runtime equality check Data models
specifies in place of the two type assignments that could not work:
`[...LOCKABLE_RUNNERS].sort()` deep-equals `[...PROFILE_CAPABLE_PROVIDERS].sort()`. Red the day a
third provider becomes profile-capable, which is exactly when this feature needs a decision.
`npm test -- packages/cezar/src/workspace/runner-lock-list.test.ts`

**V2 (unit, Phase 2): the pool may no longer hop providers.**
`packages/cezar/src/workspace/agent-route-select.test.ts` (existing home of this module's tests) over
a tmp home with `agent-accounts.json` defaults `{ claude: 'pool:*', codex: 'pool:*' }` and at least
one runnable account of each provider:

- with `lock: 'claude'`, 50 consecutive `resolvePoolForDispatch` calls **never** return a codex
  account, while still distributing across the claude accounts (the balancer is narrowed, not
  disabled);
- with no `lock`, the wildcard still crosses providers, the unlocked behaviour of KB
  `notion-4dee7a4df2f1` is unchanged;
- with `lock: 'claude'` and every claude account `disconnected`, the result is `undefined` (it does
  **not** fall back to a codex account here), the downgrade is V3's job, not the pool's.

This is literally todo `81ab4ebd`'s unshipped criterion 2, now shipped under the new decision.

`npm test -- packages/cezar/src/workspace/agent-route-select.test.ts`

**V3 (unit, Phase 2): never-block-a-task is upheld, and says so.**
`packages/cezar/src/workflows/account-fallback.test.ts` (existing home of the downgrade behaviour):

- lock `claude`, every claude account limited, a codex account runnable,
  `fallbackAcrossAccountsWhenLimited` on ⇒ the step's resolved backend is **codex**, a `note` event
  is appended naming the **lock** (not the step) as what was asked for, and
  `run.step.runner_downgraded` carries `lockedRunner: 'claude'`;
- same, with a claude account runnable ⇒ backend is claude and **no** downgrade event fires;
- lock `codex` on a step whose definition pins `runner: 'claude'` (the `spec` step) with codex
  runnable ⇒ backend is **codex**, and `run.runner_locked` fires with
  `wouldHaveBeen: 'claude', site: 'step'`. This is the D2 rank-2 assertion, the lock beating a step
  pin, and it must be a test, not a code-review observation;
- **the D3a park case, and note that its expected outcome is the OPPOSITE of what an earlier draft
  of this spec asserted:** lock `claude`, every claude account **logged out**, every codex account
  limited-but-`waitable`, i.e. **no runnable account anywhere** ⇒ the step **parks**.
  `holdStepOnWaitableAccount` IS called, its note names the target account and the window **and
  attributes the request to the LOCK rather than to the step** (the `run.ts:3502-3504` phrasing
  change of D3, asserted as text, not merely as "a note exists"), an auto-resume timer is armed, and
  **no session is spawned** (assert `createRunner` was never invoked for this step). A spawn on the
  logged-out claude provider is the failure this case exists to catch, and it is what the earlier
  draft would have shipped;
- **the D3c composition case, which is only reachable by combining two of this spec's own rulings:**
  `fallbackAcrossAccountsWhenLimited: false`, lock `claude`, every claude account held or logged
  out, one codex account `runnable` ⇒ the step runs on **codex**. On a naive implementation this
  spawns on claude instead, because `downgradePinnedRunner` returns `undefined` at `run.ts:3402`
  before it looks at anything, while D3b has already waved the run past the pre-dispatch hold. Also
  assert the **unlocked** control in the same file: with no lock and the setting off, a pinned step
  in the identical account state does **not** cross providers, the setting still means what it
  means for Auto;
- **the D3c/D3b-item-3 admission case, at the third `fallbackAcrossAccountsWhenLimited` site**, in
  `auto-resume.test.ts` (the home of the dequeue sweep): `fallbackAcrossAccountsWhenLimited: false`,
  lock `claude`, the **run record's own codex account** held, one claude account `runnable` ⇒ the run
  is **admitted** (not held back by `heldAccountFor`) and dispatches on **claude**. This one fails
  ahead of every other locked-run assertion on today's code, because the run never leaves the queue,
  so nothing below admission is even exercised. Plus the unlocked control: no lock, identical state
  ⇒ the run is still held at admission, exactly as today;
- **the D3a control, one runnable account away:** the same lock and the same logged-out claude
  accounts, but one codex account `runnable` ⇒ the step **does not park** and runs on codex, per D3.
  The pair is what proves the rule is "no wait while a runnable account exists" rather than either
  "never wait" or "always wait";
- **the D6a account case, which is the one that fails silently:** lock `claude` with
  `input.agentProfile` set to a **codex** account id ⇒ the value reaching
  `resolveProfileEnvForRoot` is a **claude** account resolved through `resolvePoolForProvider`, and
  is never the codex id. Assert the id, not just the provider: the whole defect is that the provider
  looks right while the account is foreign, so an assertion on `backend` alone passes on the bug;
- **the D4a reroute case:** lock `claude`, the run's named account unusable, only codex runnable ⇒
  `rerouteExplicitAccountIfUnavailable` still crosses to codex (availability, D3), the note names the
  **lock**, `run.account_fallback` carries `lockedRunner: 'claude'`, and, per D4a(2), after
  `run.ts:4771-4774` has persisted `runner: 'codex'`, the **next** dispatch with claude healthy again
  resolves back to claude. The second half is what proves the lock still governs, not just the first.

And the three D3b gates, which sit above every case listed so far and are the ones that stop a run
before any step exists. These belong in `packages/cezar/src/workflows/auto-resume.test.ts` (the
existing home of the hold/park/requeue behaviour, and the suite `run.ts:3695` records as having
correctly reddened when this hold was once bypassed too bluntly):

- **initial spawn gate** (`run.ts:5527`): lock `claude`, every claude account held, a codex account
  runnable ⇒ the run is **not** requeued, reaches the step loop, and the step lands on codex via the
  ordinary D3 downgrade. Assert no `holdRunOnAccount` note was appended;
- **post-lease spawn gate** (`run.ts:5739`): same, with the hold arriving *after* admission and
  before the lease is granted, which is the case that second call exists for. Same expectation;
- **the admission memo, in three parts** (D3b item 2), because "the memo is gone" and "the memo is
  still written" are both required and a test for either alone passes a broken implementation:
  - **(a) a lock change drops it.** A queued run carries a `heldAtSpawn` entry naming a held
    **codex** account; the workspace lock becomes `claude` and **`semaphore.refresh()` runs** ⇒ the
    entry (and `heldNotified`) is **gone**, the run is admitted, and it dispatches on **claude**.
    Drive it through `refresh()` / the new `onRunnerLockChanged` participant hook, **not** through a
    `PUT`: this is a `workflows` unit test with no HTTP in it, and D3b item 2 places the mechanism on
    the semaphore precisely because the workspace route cannot reach a `RunManager`'s private map.
    Assert the map is empty for that run id, not merely that the run started: a run that starts
    because the codex hold happened to expire proves nothing. This is the D2 recovery case
    ("everything is stuck on codex, flip it") and it fails on today's code for the whole duration of
    the old hold. The `PUT`→`refresh()` half of the wiring is V4's job, not this test's;
  - **(b) the spawn gate writes none.** A locked run waved through per item 1 has **no**
    `heldAtSpawn` entry afterwards. Without this the memo would re-park it on the next pump sweep
    and (a) would be worthless;
  - **(c) a dispatch park still writes one.** A locked run that dispatch parks per D3a **does** carry
    an entry afterwards, so the write-storm brake `run.ts:2140-2147` records survives. This is the
    assertion that stops (b) from being implemented as "a locked run never writes a memo", which
    would reopen the 37-notes-in-1.5-seconds failure;
- **the control, which is what keeps D3b from being a blanket hold-bypass:** with **no** lock, every
  gate above still parks exactly as it does today, and a pre-existing `heldAtSpawn` entry still holds
  its run back. `run.ts:3689-3696` records that the blunt version of this change reddened 23 tests in
  this very file and that they were right; this control is how the narrow version proves it did not
  repeat that.

`npm test -- packages/cezar/src/workflows/account-fallback.test.ts packages/cezar/src/workflows/auto-resume.test.ts`

**V2a (two-process cluster e2e, Phase 2a): the lock crosses the link.** The repo already has the
harness (`npm run test:e2e:cluster` → `.ai/scripts/cluster-two-node-e2e.mjs`), so this extends a
real two-node run rather than inventing one. Nothing below is provable in a single process, which is
why it is not a unit test:

- **initial lock:** hub locked to `claude`, a run dispatched to the spoke and accepted ⇒ every agent
  step on the **spoke's own** run record reports `backend: 'claude'`, even with the spoke's local
  `runnerLock` set to `codex` and its project `defaultRunner` codex. Assert on the spoke's record,
  never on the hub's projection: the projection is what a wrong implementation would make look
  right;
- **mid-run flip (D2 across the link), which is what proves the UPDATE path exists:** with a
  dispatched run in flight, flip the hub to `codex` ⇒ a `runner-lock` frame is emitted, and the
  run's **next** step reports `codex` while the steps before it still report `claude`. The second
  half matters: it proves the flip took effect at a step boundary rather than rewriting history.
  **An implementation that only put the lock on the dispatch offer passes the first case and fails
  this one**: which is the whole reason Phase 2a specifies two paths;
- **the spoke's own state is untouched:** after both cases, the spoke's `~/.cezar/config.json` still
  has whatever `runnerLock` it started with, and a run the **spoke itself** starts (not dispatched)
  uses that local value, not the hub's. This is the hub-authoritative rule's scope boundary, and
  without this assertion the simplest implementation (write the hub's value into the spoke's
  semaphore) passes everything above while silently rewriting an operator's machine;
- **clearing:** hub → `Auto` ⇒ a `runner-lock` frame carrying `null`, and the next dispatched step
  falls back to the spoke's own value;
- **older-spoke compatibility:** a spoke whose `parseDownlink` rejects the new frame keeps its socket
  open and keeps running: the `corpus-changed` degradation, asserted rather than assumed, because
  "additive is safe" is the claim that justifies the MINOR bump;
- **link down:** with the hub unreachable, the spoke runs what it authored under its own value and
  does **not** block. This is the `account-grants.ts:369-370` rule, and a lock that broke it would
  turn a network partition into a stopped worker.

Approval, per this section's opening rule, and note this one boots two processes.
`npm run test:e2e:cluster`

**V4 (server, Phase 1): the key, its clear, and its two refusals.**
`packages/cezar/src/server/workspace-api.test.ts` (existing home of `GET/PUT /workspace/config`):

- `PUT { runnerLock: 'claude' }` ⇒ 200, `GET` answers `runnerLock: 'claude'`, and
  `semaphore.runnerLock()` is `'claude'` **without a restart**;
- `PUT { runnerLock: null }` ⇒ 200, cleared, accessor `undefined`;
- a `PUT` omitting the key leaves it untouched (partial-patch rule);
- `PUT { runnerLock: 'codex' }` with codex disabled ⇒ **400** and the file is byte-identical
  afterwards (nothing persisted);
- `PUT /providers/codex/enabled { enabled: false }` while locked to codex ⇒ 200, the lock is `null`
  **and `semaphore.runnerLock()` is `undefined` immediately afterwards**: the D7 #3 assertion, and
  the one that fails today because that route calls no `refresh()` at all;
- **the D7 #2 assertion, which a resources-carrying test would hide:** a PUT whose body contains
  `runnerLock` and **no** `resources` key still refreshes, i.e. the accessor moves. Send exactly
  `{ runnerLock: 'claude' }`: a test that also sets `maxParallel` passes on the old
  `if (resources !== undefined)` gate and proves nothing;
- **the other half of that same refresh, per D3b item 2:** the lock-only PUT also reaches every
  registered participant's `onRunnerLockChanged`. Register a stub participant and assert it was
  called. This is the wiring V3 case (a) deliberately does **not** cover, because that case drives
  the hook directly and would still pass if the route never called `refresh()` at all;
- **the three D7a negatives, each of which is a way to fire the hook when nothing happened** and
  none of which the positive case above can see. The stub participant's `onRunnerLockChanged` is
  **not** called when:
  - **(i) the PUT sets the lock to the value it already has** (`claude` → `claude`), and equally
    when it clears an already-clear lock (`null` → absent): normalization means that is not a
    transition either;
  - **(ii) the refresh carries no lock at all**: a resources-only `PUT /workspace/config`, and a
    `PATCH /projects/:id` `maxParallel` change (`server.ts:4101`), which reaches the same
    `refresh()`;
  - **(iii) `load()` throws.** Inject a failing loader: `refresh()` keeps the last good snapshot
    (`semaphore.ts:436-440`), so no transition occurred and no memo may be dropped on the strength
    of a read that failed.

  Also assert **ordering** for the positive case: the hook runs **before** `release()`. A test that
  only checks "it was called" passes an implementation that pumps first, which leaves the first
  sweep after a lock change still holding runs back on the old verdict: the D3b item 2 failure,
  one tick later;
- `runnerLock: 'pi'` (or `'opencode'`) ⇒ **400 from the schema**, nothing persisted: the Data
  models narrowing, asserted rather than assumed;
- a config file whose `runnerLock` is garbage (`"gpt"`, `7`, `{}`) loads as **no lock** and every
  other key survives, the `.catch(undefined)` degradation;
- `settings.runner_lock_set` is emitted with `source: 'workspace-config-put'` on the PUT path and
  `source: 'provider-disabled'` on the disable path (Analytics).

Plus the D4b gate tier, in `packages/cezar/src/server/provider-action-gating.test.ts` (the existing
home of these pure builders):

- **a locked start whose overridden provider is unavailable:** lock `claude`, `body.runner: 'codex'`,
  every codex account disconnected, a claude account healthy ⇒ `requirementsForWorkflowRun` demands
  **claude** and the route does **not** 409. Today it demands codex and refuses;
- **a locked start over a disabled overridden provider:** same shape with codex in
  `disabledProviders`;
- **a pinned step whose pin the lock overrides emits no requirement for its provider**: the
  gate-tier mirror of D2 rank 2. Assert the requirement list by provider, not just its length;
- **a locked resume:** `requirementForExistingRun` and `requirementForRetarget` each report the
  locked provider, with the route re-derived for it rather than inherited (D6a).

**And the caller wiring, not only the pure builders**, because a builder that takes a lock nobody
passes is green in unit tests and inert in production. Through the **routes**, in
`provider-action-gating.test.ts` (which already exercises them) and `request-validation.test.ts`:

- a lock set in the workspace config, then `POST /runs`, `POST /runs/:id/continue`,
  `POST /runs/:id/agent`, the reopen branch of `/runs/:id/messages`, todo start, and **`POST /plan`**
  each refuse-or-admit on the **locked** provider, not the project default. `/plan` is the one whose
  gate needed a workspace read added, so it is the one most likely to be wired last and tested
  never;
- **headless `cezar run`** (`index.ts:1078`) likewise, in the package/CLI suite that owns it: a
  locked workspace with an unavailable project default starts rather than refusing. This is the path
  with no HTTP and no cockpit, and it is exactly where "the lock reaches everything" quietly stops
  being true.

Plus the D4b `/plan` gate, in `provider-action-gating.test.ts` (already invoked above, and the home
of the other three builders' tests): `requirementForPlanner` reports the **locked** provider with its
route re-derived for it, and `planAccountGate` does **not** refuse when the *overridden* provider is
disabled, the `unavailableProviderMessage([defaultRunner], known)` short-circuit at
`server.ts:1735-1739`, which sits outside the builder and would otherwise pass a builder-only fix.

Plus the four D4c model-call paths, each with an **opposing project default** so the assertion fails
on today's code: project `defaultRunner: 'codex'`, lock `'claude'`, assert the runner factory is
asked for **claude** and `resolveProfileEnvForRoot` is called with **claude**.

**Three of the four test files exist; `packages/cezar/src/planner.test.ts` does NOT and this spec
creates it.** There is no planner unit test anywhere in the repo today: `planChain` is exercised
only indirectly, from `server/request-validation.test.ts` and `server/provider-action-gating.test.ts`,
so naming it in a command without creating it fails with "no test files found" rather than red.
`runs/auto-name.test.ts`, `task-classifier.test.ts` and `notes/processor.test.ts` all exist and are
extended in place.

- `planner.ts` (**new file**): assert the lock is what `chooseAccount` is asked about, that the
  candidate set it chooses from is the one `requirementForPlanner` built for the **locked** provider
  (the two-halves rule of D4b/D4c, a test that stubs the candidates would pass on a half-fix), and
  that the existing degraded fallback plan still happens unchanged when nothing is runnable (the
  ladder is preserved, not bypassed);
- `runs/auto-name.ts`: and, under a codex lock, that `config.namerModel` is **not** sent (the
  claude-only alias condition is false), with the naming pass still failing soft;
- `task-classifier.ts`: `CHEAPEST_MODEL` is indexed by the **locked** runner, and a runner error
  still returns the existing "no class" answer rather than becoming fatal;
- `notes/processor.ts`: same shape, with `config.plannerModel` suppressed under a codex lock.

The soft-failure half of each is not decoration: the risk of routing these four through a lock is
turning a best-effort helper into a blocking one, so each test asserts the degradation path survives.

**And one caller-level test per function, because passing the new option is the part that gets
forgotten.** A unit test that calls `classifyTask({ runnerLock: 'claude' })` proves the parameter
works, not that anything in production supplies it:

- `planChain`: through the `/plan` route with a lock set, asserting the runner built is the locked
  one (`server/request-validation.test.ts` or `provider-action-gating.test.ts`, both of which
  already reach that route);
- `generateRunName` and `classifyTask`: through `RunManager`, in the workflows suites that already
  drive a run, asserting the value handed down is `semaphore.runnerLock()` and not
  `config.defaultRunner`;
- `NoteProcessor.ask`: **the live-change case, which only it has**: with the processor already
  constructed, change the lock, then ask again and assert the **new** provider. A value-shaped
  dependency passes every other test in this list and fails exactly this one, which is why the
  accessor is specified above rather than left to the implementer.

`npm test -- packages/cezar/src/server/workspace-api.test.ts packages/cezar/src/server/provider-action-gating.test.ts packages/cezar/src/planner.test.ts packages/cezar/src/runs/auto-name.test.ts packages/cezar/src/task-classifier.test.ts packages/cezar/src/notes/processor.test.ts`

**V5 (web unit, Phase 3): the shell region, split along D9's component boundary.** The split is not
tidiness: `renderShell` (`app-shell.test.tsx`) supplies only `ThemeProvider` and `MemoryRouter`, and
every test in that file renders **without a `QueryClientProvider` on purpose** (`:56-68`). An earlier
draft put the bar's provider-and-mutation assertions there, which cannot execute.

**V5a: the slot, in `packages/web/src/components/app-shell.test.tsx` (existing, no query client).**
Assert structure only, through a stub passed to `renderShell`. **The stub must NOT carry
`data-slot="global-bar"`**: that marker belongs to `AppShell`'s own row wrapper (D9, and V6 asserts
that wrapper with the real container inside it), so a stub wearing it makes
`querySelectorAll('[data-slot="global-bar"]')` return **2** and the "exactly one" assertion fail on a
correct implementation. Use a distinct marker:

```tsx
renderShell('/', { globalBar: <div data-testid="global-bar-stub" />, banner: <p>banner content</p> })
```

`banner` is passed deliberately: `app-shell.tsx:302` renders the banner slot **only when `banner` is
truthy**, so the row-numbering bullet below cannot see `[data-slot="banner-slot"]` without it. Both
existing row tests in this file already pass one for the same reason (`app-shell.test.tsx:555`,
`:562`).

- rendering the shell for each of six routes puts exactly **one** `[data-slot="global-bar"]` in the
  DOM (`AppShell`'s row), and it **contains the stub** (`getByTestId('global-bar-stub')`): the
  second half is what proves the slot is wired rather than merely present;
- **the row follows the `globalBar` prop, not `chromeless`**: with `chromeless` set **and** a
  `globalBar` passed, the row still renders (and the sidebar / drawer / top bar / banner are still
  absent, unchanged); with no `globalBar`, no row, `chromeless` or not. That is the shell half of
  D9's three-state ruling, and it is the only place `AppShell` deviates from "chromeless hides
  chrome": deliberately, because **which** of the three onboarding states gets a bar is the
  container's decision, and the shell must not encode onboarding policy;
- **the grid string itself**, which is an existing assertion this change turns red:
  `app-shell.test.tsx:566` asserts `column.className` contains `grid-rows-[auto_auto_1fr_auto]`, and
  D9 makes it `grid-rows-[auto_auto_auto_1fr_auto]`. Update it in place rather than discovering it
  as a mystery failure: it is the same edit as the renumber below, on the other half of the grid
  declaration;
- `[data-slot="banner-slot"]`, `[data-slot="main"]` and `[data-slot="composer"]` carry
  `row-start-3`, `row-start-4`, `row-start-5`, the R4 assertion, which is the only thing that
  catches a missed renumber. Note `:568` currently asserts `row-start-2` for the banner slot, so
  this is an update to a live assertion too, not a new one;
- **the shell still renders with no `QueryClient`**: the same assertion the account-usage panel
  already makes in this file, and the guard that keeps a future refactor from dragging the container
  back into the shell.

**V5a-onboarding: the three-state ruling, in
`packages/web/src/components/app-shell-container.test.tsx`**: its existing
`describe('D14 onboarding gate (chromeless)')` block (`:526`) already drives the probe and asserts
`data-chromeless`, so this is three cases in the suite that owns the decision:

- probe `signed-out` ⇒ **no** `[data-slot="global-bar"]` (the authentication boundary);
- probe `needs-org` ⇒ the bar **renders**, while `data-chromeless` is still set and the sidebar is
  still absent: the pair is the assertion, because "bar present" alone would also pass a build that
  quietly stopped honouring D14 for navigation;
- probe `ready` with `hasProjects: false` ⇒ same.

**V5b: the bar's behaviour, in a new `packages/web/src/components/engine-lock-bar.test.tsx`**, which
wraps `EngineLockBarContainer` in a `QueryClientProvider` (the ordinary pattern for container tests
here):

- segments render only for enabled, discovered providers: a workspace with codex disabled shows
  `Auto · Claude`;
- the current `runnerLock` is reflected as the selected segment, and `null` selects `Auto`;
- choosing a segment issues the `PUT` with that value, and `Auto` sends `null`;
- the presentational `EngineLockBar` can be rendered with plain props and no client at all, which is
  what keeps the boundary honest in both directions.

**V5c: the D10a reconcile, in `packages/web/src/routes/settings/provider-settings.test.tsx`.** Mount
`EngineLockBarContainer` beside `ProviderSettings` under **one shared `QueryClientProvider`**, seed
`workspaceQueryKeys.config` with `runnerLock: 'claude'`, and drive the **real `queueToggle` path**
(click the provider's enable control) rather than calling a mutation directly:

- disabling **claude** ⇒ the bar renders **Auto**, with no reload and no second navigation;
- **negative control:** disabling the **other**, unlocked provider leaves the bar on `Claude`, so the
  reconcile stays scoped to the case D10a names;
- **serialization control:** the existing optimistic write and rollback still behave: a failing
  `setProviderEnabled` rolls `providerStatus` back and does **not** invalidate the config key.

Assert through the rendered bar, never by spying on `invalidateQueries`: the spy passes an
implementation that invalidates a key nothing re-reads.

**V5d: the pickers, which Phase 3 changes and no earlier draft of V5 verified.** Two halves: the
disclosure string (P6) and the provider-fixed behaviour (D2 rank 5 / D6), in the suites that already
own them:

- **`packages/web/src/components/agent-pool-rows.test.tsx`** (owns `RunnerPill` + `ADVISORY_NOTE` at
  `:144,155,169`): **unlocked** ⇒ `ADVISORY_NOTE` renders exactly as today (the three existing
  assertions stay green, which is the P6 control); **locked** ⇒ the advisory string is **absent** and
  the lock string renders in its place. Assert it lands in the pill's `status` **footer**
  (`picker-pill.tsx:114-116`, reached via `status={…}` at `:285`) and **not** as a selectable row,
  a lock disclosure that renders as an option is a control the user can try to pick;
- **`packages/web/src/routes/task-thread/follow-up-engine.test.tsx`** (owns the same string at
  `:424,435,445`): the same locked/unlocked pair through the follow-up composer, since it selects
  `ADVISORY_NOTE` by its own conditions and could disagree with the pill;
- **provider fixed, model and same-provider account free**: the D6/D6a assertion, once at the shared
  component so the six Phase-3 surfaces inherit it: with lock `claude`, the pill shows **claude** and
  offers no other provider; the **model** picker is unchanged and still selectable; the **account**
  list contains claude's accounts and **no codex account id**. The negative that catches the naive
  implementation: unlocked, all of it behaves exactly as today.

Plus the D3c copy, in `packages/web/src/routes/settings/resources-section.tsx`'s own existing suite,
`packages/web/src/routes/settings/resources-section.test.tsx`: the lock-override note beside the
`fallbackAcrossAccountsWhenLimited` control **renders when `runnerLock` is non-null and does not
render when it is `null`**. Both halves, because a note that is always on is as wrong as one that is
never on: it would tell an unlocked workspace its setting is being overridden when it is not.

`npm test -- packages/web/src/components/app-shell.test.tsx packages/web/src/components/app-shell-container.test.tsx packages/web/src/components/engine-lock-bar.test.tsx packages/web/src/components/agent-pool-rows.test.tsx packages/web/src/routes/task-thread/follow-up-engine.test.tsx packages/web/src/routes/settings/resources-section.test.tsx packages/web/src/routes/settings/provider-settings.test.tsx`

(The two picker suites were missing from this command in an earlier draft while Phase 3 named them
as updated: so the one gate that would have caught a broken `ADVISORY_NOTE` replacement did not run
it.)

(`engine-lock-bar.test.tsx` is a **new** file this spec creates, like `planner.test.ts` in V4; the
other three exist.)

**V6 (browser e2e, Phase 3): the acceptance criterion 2 test.**
New `packages/web/e2e/engine-lock.e2e.ts`, on the shared dry-run environment, written to the
conventions of `settings-agents.e2e.ts` (save the store in `beforeAll`, restore byte-for-byte in
`afterAll`; poll the additive `GET` rather than assume the fire-and-forget `PUT` beat the assertion):

1. **Desktop, 1440×900.** For each of `/`, `/tasks`, `/settings/providers`, `/skills`, `/knowledge`
   and a task thread: `[data-slot="global-bar"]` exists and is visible.
1b. **The onboarding surface, both viewports (D9's three-state ruling, live).** The dry-run
   environment is past onboarding, so drive the probe rather than the org: stub
   `GET /api/v1/onboarding/*` to answer `needs-org`, reload, and assert the bar **is visible** while
   the sidebar is **not**: the same pair V5a-onboarding asserts in jsdom, now against the real
   shell at 1440×900 and at 390×844. If the harness cannot stub that probe, say so in the run notes
   and leave this to V5a-onboarding rather than reporting it as covered: a skipped browser case that
   nobody names is how "every screen" becomes untrue again.
2. Click **Claude**; poll `GET /api/v1/workspace/config` until `runnerLock === 'claude'` (the
   server's truth, not the query cache).
3. **Reload** ⇒ the bar renders Claude from a cold load.
4. **Across sessions, WITHOUT restarting the shared server.** Assert the value reached **disk** in
   the e2e workspace home: `.ai/qa/cez-home/config.json` (the `CEZ_HOME` that `.ai/scripts/
   test-env-up.sh` sets, mirrored at `packages/web/e2e/workspace-registry.ts:29`) contains
   `"runnerLock": "claude"`. A value on disk in the workspace config plus the cold-reload of step 3
   is what "survives a session" means here, and it is provable without touching the server.

   **Do not tear the environment down inside a spec.** `packages/web/e2e/vitest.config.ts` sets
   `fileParallelism: false` ("One browser session, one server: parallel specs would fight over
   both"), `e2e.sh` boots the env **once** before `vitest run`, and no existing spec restarts it:
   `project-groups.e2e.ts` calls out "no server restart" as its design and reseeds the shared home
   instead. A `test-env-down.sh` mid-suite kills the server for every later spec, and a failed
   re-`up` turns the whole gate red for reasons unrelated to this feature. Use the same
   save-in-`beforeAll` / restore-byte-for-byte-in-`afterAll` discipline `settings-agents.e2e.ts`
   applies to `.ai/cezar/config.json`, against `cez-home/config.json` here.

   A genuine process-restart proof is still worth having; it moves to **V8** as a manual step
   outside `npm run test:e2e` (restart the service, `GET /api/v1/workspace/config`, expect
   `'claude'`), where killing a server is the point rather than a side effect.
5. Click **Auto** ⇒ `runnerLock` is `null`.
6. **iPhone, 390×844** (matching `ios-sweep.e2e.ts`): the bar is visible, the control is operable,
   and `document.documentElement.scrollWidth <= window.innerWidth` on every route above.
7. Screenshots for both viewports into `.ai/qa/artifacts_e2e`.

```bash
npm run test:e2e
```

`e2e.sh` exits 0 with `TEST_E2E_STATUS=skipped` when the agent-browser cannot be provisioned.
**A skip is not a pass**, the script says so itself, and this spec's acceptance criterion 2 is
unmet until `TEST_E2E_STATUS=passed` appears.

**V7 (the complete gate, Phase 5, before the single commit, and therefore AFTER Phase 4's tracked
record edits, which are part of what it gates).** The five commands, in the documented
order (`AGENTS.md`), with the environment scrub, because an unscrubbed `CEZ_*`/`NODE_ENV`
environment makes the gates lie:

```bash
scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
        | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
tmp=/tmp/cez-gate-$$ && mkdir -p $tmp    # TMPDIR must be OUTSIDE any git repo
env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run typecheck
env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm test
env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run test:unit
env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run build
env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run test:package
```

**There is no `npm run lint` in this repo**, `package.json` has no such script; the gate is these
five. Any pre-existing red must be reproduced on a clean `origin/main` checkout and named as baseline
before it is dismissed.

**And there is no known baseline red to lean on here: an earlier draft of this paragraph said there
was, quoting the superseded half of the record.** It cited `AGENTS.md` as recording
`npm run test:package` "failing 1/15 under the run broker". That text is still in the file, but under
a **`CORRECTED A THIRD TIME 2026-08-24`** lead-in (`AGENTS.md:380-383`, spec
`.ai/specs/2026-08-24-codex-dry-run-mock.md`, commit `03a16af3`) which states that the case "and the
whole trap, is now PAST TENSE" and that `test:package` is green at **25/25**. The 1/15 line survives
below it only as the correction record, exactly as the house rule requires. Citing it as current
would pre-authorize waving through a genuine `test:package` regression as a known baseline, which is
the one thing a baseline claim must never do. **A red `test:package` is a real failure until a clean
`origin/main` run says otherwise.**

**V8 (live run, Phase 7: acceptance criterion 3, and the only thing that closes it).**
Needs explicit owner approval before it runs: it starts real runs and spends real quota.

*Precondition, measured not assumed* (P2 flagged this):

```bash
jq '.defaults' ~/.cezar/agent-accounts.json     # expect {"claude":"pool:*","codex":"pool:*"}
jq '.defaultRunner' <project>/.ai/cezar/config.json
```

Pick a project whose `defaultRunner` is `codex`, or set it to `codex`, so that **both** the project
setting and the wildcard pool would otherwise choose codex.

**Snapshot everything V8 mutates, FIRST, and restore it unconditionally.** V8 runs on
`prod-host` against a **shared workspace**: it writes a machine-wide `runnerLock` that governs
every project and every user of that box, and it may rewrite the chosen project's `defaultRunner`
and its pool selection to establish the baseline. An earlier draft of this section restored none of
it, so a V8 that failed halfway, or passed and simply ended, left the owner's workspace locked to
whatever the last direction set, silently, on a control that governs all their work.

```bash
SNAP=$(mktemp -d)
curl -s "localhost:$PORT/api/v1/workspace/config" > "$SNAP/workspace-config.json"
cp ~/.cezar/agent-accounts.json                    "$SNAP/agent-accounts.json"
cp <projectRoot>/.ai/cezar/config.json             "$SNAP/project-config.json"
jq -r '.runnerLock // "null"' "$SNAP/workspace-config.json"   # record the ENTRY value, usually null
```

**Restore in a guaranteed cleanup step, not at the end of the happy path.** Arm it before the first
mutation so an assertion that exits early still unwinds:

```bash
restore() {
  lock=$(jq -c '.runnerLock' "$SNAP/workspace-config.json")
  curl -s -X PUT "localhost:$PORT/api/v1/workspace/config" \
    -H 'content-type: application/json' -d "{\"runnerLock\": $lock}" >/dev/null
  cp "$SNAP/agent-accounts.json"  ~/.cezar/agent-accounts.json
  cp "$SNAP/project-config.json"  <projectRoot>/.ai/cezar/config.json
  # verify BOTH planes: the API's answer and the file on disk
  curl -s "localhost:$PORT/api/v1/workspace/config" | jq -c '.runnerLock'   # == $lock
  jq -c '.runnerLock // null' ~/.cezar/config.json                          # == $lock
  jq -r '.defaultRunner' <projectRoot>/.ai/cezar/config.json                # == the snapshot's
}
trap restore EXIT
```

Verifying both planes is not belt-and-braces: D7 established that `GET /workspace/config` reads the
**file** while the run loop reads an **in-memory snapshot**, so an API answer alone cannot tell you
the restore actually landed. **Record the restoration alongside the three run ids** in the status
log: a V8 whose cleanup is unrecorded is a V8 nobody can prove ran clean.

**Fix that project's id and scope every URL below to it.** Run records are per project, so the
boot-project spelling `/api/v1/runs/<id>` only answers for runs in the boot folder, pointing it at a
run started in another registered project returns `404 not found` (`server.ts:5364` for `GET /runs/:id`, `:5374` for `/runs/:id/history`), which is easy
to misread as "the run has no steps yet" while V8 is in progress. Export both values once and use
them throughout:

```bash
PROJ=<projectId>            # the registered project chosen above
PORT=<port>
API="localhost:$PORT/api/v1/p/$PROJ"
```

Every command below uses `$API`. `/api/v1/p/<projectId>/…` is mounted for the whole scoped surface
(`server.ts:2299`, and the alias-parity suite at `:765-767` asserts
`/api/v1/<path>` ≡ `/api/v1/p/<boot>/<path>`), so this spelling is correct for the boot project too
and needs no special case. The two `workspace/config` calls at the end are the deliberate exception:
that route is workspace-level and takes no project scope.

**Run 0, the baseline, and it runs FIRST.** The negative control cannot come last: run after a
Codex-locked direction, on a project that naturally prefers codex, "Auto landed on codex" proves
nothing at all: it is the same answer the lock would have given, and a workspace with only one
healthy provider passes every direction for the wrong reason. So the unlocked outcome is **measured
before any lock is set**, and it is what the locked runs are measured against.

With the lock at **Auto**, start one `spec-to-deploy` run and let it complete. Record its per-step
backends with the command below. The precondition for the rest of V8 is that this baseline is
**codex** on at least the unpinned steps; if it is not (the pool happened to pick claude), reseed the
pool selection or the project's `defaultRunner` until the known unlocked answer *is* codex, and
record what was changed. **Write the baseline run id and its step/backend table into the status log
before setting a lock**, a baseline recorded afterwards is not a baseline.

*Claude direction.* Set the lock to Claude **from the bar** (not by editing the file, the surface is
under test too), start a `spec-to-deploy` run, and **let it run to completion through every agent
stage.** A run stopped at `spec` has seven steps in `pending`, and a `pending` step has no `backend`
because nothing dispatched it: reading such a run as "every step on claude" is reading absence as
evidence. The earlier draft of this section said "let it reach at least the `spec` step" and then
claimed every step; that is the defect being fixed here.

The chain's **ten** agent steps, which the assertion enumerates rather than counts (read from
`SPEC_TO_DEPLOY_WORKFLOW` at `95b93175`, per P3, and re-read at implementation time in case the chain
has changed again): `context`, `spec`, **`review-spec-local`**, `review-spec`, `implement`,
`run-tests`, `commit-push`, `merge`, `document`, `deploy`.

`review-spec-local` is the one an earlier draft of this section omitted, which made its `n: 9` gate
both wrong and permissive: a run missing a stage would have satisfied it.

```bash
# every agent step, its status, and the backend it actually ran on
curl -s "$API/runs/<id>" | jq -r '.steps[] | "\(.id)\t\(.status)\t\(.backend)"'
# the gate: ten agent steps, none pending, every backend claude
curl -s "$API/runs/<id>" \
  | jq '[.steps[] | select(.backend != null)] | {n: length, providers: (map(.backend) | unique)}'
#   want: {"n": 10, "providers": ["claude"]}
curl -s "$API/runs/<id>" | jq '[.steps[] | select(.status == "pending")] | length'   # 0
# and by NAME, so a renamed or dropped stage fails loudly instead of silently changing the count
curl -s "$API/runs/<id>" \
  | jq -e '[.steps[] | select(.backend != null) | .id] | sort ==
      ["commit-push","context","deploy","document","implement","merge","review-spec","review-spec-local","run-tests","spec"]'
```

`deploy` parks by design on cezar (`.ai/deploy-targets.json` is `"manual": true`, AGENTS.md), so
"completed every agent stage" means it reached and dispatched `deploy`, not that the run's terminal
status is `done`. A parked `deploy` with `backend: "claude"` satisfies this; a `pending` one does not.

Then assert the routing was routing and not fallback, and that the lock is what did it:

**Not from `/runs/:id/events`.** That route is an open **SSE stream**
(`streamSSENoBuffer`, `server.ts:6507`), not a JSON array: `curl | jq '[.[]|…]'` against it hangs
waiting for a stream that never ends, and what it does emit is `event:`/`data:` framing that `jq`
cannot parse. Two spellings work, both finite.

The transcript on disk is the simplest, and it is the same file the route reads
(`server.ts:6493`, `join(dataDir, 'runs', '<id>.ndjson')`):

```bash
NDJSON=<projectRoot>/.ai/cezar/runs/<id>.ndjson
jq -s '[.[]|select(.name=="run.step.runner_downgraded")]|length' "$NDJSON"   # 0
jq -s '[.[]|select(.name=="run.runner_locked")]|length'          "$NDJSON"   # > 0
```

Off-box, or when the transcript is not reachable, page the finite history route until it says there
is no more (`hasOlder`, `packages/contract/src/events.ts:77`).

**The two names differ, and getting it wrong fails silently.** The query parameter is `cursor`
(`server.ts:5377`, `readRunHistoryPage(…, c.req.valid('query').cursor)`), but the field carrying the
backward cursor in the response is **`olderCursor`** (`runHistoryPageSchema`,
`packages/contract/src/events.ts:70-78`; emitted at `runs/event-history.ts:451`, asserted in
`runs/event-history.test.ts:88-90`). There is no `.cursor` field on the page. Reading `.cursor`
yields the string `null`, the next request sends `?cursor=null`, that 400s as a `HistoryCursorError`
with no `.events`, and the loop exits having counted **only the newest window**: the exact failure
the loop exists to prevent, reported as a confident "zero downgrades".

```bash
# collect every page, then count, a single un-paged call sees only the newest window
cursor=''; : > /tmp/hist.json
while :; do
  page=$(curl -s "$API/runs/<id>/history${cursor:+?cursor=$cursor}")
  echo "$page" | jq -c '.events[]' >> /tmp/hist.json
  [ "$(echo "$page" | jq -r .hasOlder)" = true ] || break
  # `olderCursor`, NOT `.cursor`: see above; `// empty` so a missing field ends the loop
  # rather than sending the literal string "null" on the next request
  cursor=$(echo "$page" | jq -r '.olderCursor // empty')
  [ -n "$cursor" ] || break
done
jq -s '[.[]|select(.name=="run.step.runner_downgraded")]|length' /tmp/hist.json   # 0
jq -s '[.[]|select(.name=="run.runner_locked")]|length'          /tmp/hist.json   # > 0
```

A non-zero downgrade count invalidates this direction rather than failing it: it means the claude
accounts were not healthy and the run proves D3, not the lock. Re-run when they are. **Zero
`run.runner_locked` events also invalidates it**, that would mean the lock never changed an outcome,
so the run agreed with the default by luck rather than by the feature.

*Codex direction (the symmetric check the acceptance criteria require).* Set the lock to Codex, start
another run **on the base `spec-to-deploy` workflow, not the codex sibling**, and hold it to the
**same completion bar and the same enumerated step list**: ten agent steps, none pending,
`{"providers": ["codex"]}`, zero downgrades.

What this direction proves is that the lock overrides **both** Claude-pinned stages of the base mixed
chain (`spec` and `review-spec-local`, per P3) on a workflow the user did not have to choose. An
earlier draft justified it as reaching "the step no codex run could previously reach", which is
**false**: `spec-to-deploy-codex` has run `spec` on codex since
`.ai/specs/2026-08-24-codex-only-default-workflow.md` shipped. The claim that is actually new, and
the one to check, is that the **default** chain obeys a platform switch without the user selecting a
variant at all.

*What the three runs prove together.* Run 0 establishes that this project, this pool and this
`defaultRunner` choose **codex** when nothing forces them. The Claude-locked run then lands every
step on **claude**: a changed outcome against a known baseline, which is the acceptance criterion.
The Codex-locked run lands every step on codex including the claude-pinned `spec`, which the baseline
did not, so it is not merely agreeing with the default.

*Process-restart persistence, moved here from V6 step 4* (a spec must not tear down the shared e2e
server; see V6). Set the lock, restart the service, and confirm it survived a real process boundary
rather than a page reload:

**Set the lock explicitly first.** The immediately preceding direction leaves it on **Codex**, so a
block that opens by reading `"claude"` would fail on correct code: a scripted V8 would report a
persistence bug that is really just a missing setup line:

```bash
# workspace-level, so NOT under /p/<projectId>, the one deliberate exception to the $API rule above
curl -s -X PUT "localhost:$PORT/api/v1/workspace/config" \
  -H 'content-type: application/json' -d '{"runnerLock":"claude"}' >/dev/null
curl -s "localhost:$PORT/api/v1/workspace/config" | jq -r .runnerLock   # "claude"
systemctl restart cezar.service                                        # or the blue-green path, per AGENTS.md
curl -s "localhost:$PORT/api/v1/workspace/config" | jq -r .runnerLock   # still "claude"
```

Putting it back is the `trap restore EXIT` above's job, and only its job: one owner for the restore,
so a step that exits early cannot leave the workspace half-unwound.

Record **all three run ids** (baseline, claude-locked, codex-locked), each one's full step/backend
table, and any reseeding done to establish the baseline, in the spec's status log and in the handoff.
The baseline's table is the control the other two are read against, so a status log carrying only the
two locked runs does not close acceptance criterion 3. **Record the restoration too**: the entry
value of `runnerLock`, and the verified-restored values from both planes, because on a shared box
the question "what state did V8 leave the workspace in" is asked by whoever is surprised by it next,
and the answer has to already be written down.

## What this spec could not establish

- **Whether `pool:*` is actually the current production default on `prod-host`.** Cited from
  the task framing and corroborated by KB `notion-4dee7a4df2f1` and `domains/cezar.md:39`;
  `~/.cezar/agent-accounts.json` on that box was **not** read in this pass. V8 makes it a measured
  precondition rather than an assumption.
- **Whether a spoke should surface the hub's lock in its own cockpit.** Phase 2a settles routing:
  dispatched work follows the hub, spoke-authored work follows the spoke. It does **not** settle
  what the *bar on the spoke's own screen* should read. Showing the spoke's own value is truthful
  about what that operator controls and silent about why a dispatched run went elsewhere; showing
  the hub's is the reverse. Both are defensible, neither is required by the owner's ask (which is
  about the hub operator's control), and inventing a two-value display is a design decision this
  spec should not make alone. The bar therefore renders the **local** value on every node, and this
  is flagged rather than hidden.

  (An earlier draft's bullet here said the cluster spec *"was not read"* and that propagation was a
  non-goal. Both are now false (it was read, and Phase 2a specifies propagation), so that bullet is
  removed rather than left contradicting the phase two sections above it.)
- **Whether the owner would prefer a strict, never-downgrade lock.** D3 rules against it with reasons.
  That is a ruling this spec makes, not a fact it discovered, and it is the one decision here most
  worth an owner's explicit yes or no before Phase 2 is built.
