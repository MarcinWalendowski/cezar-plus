# A task is never blocked: exhausted quota falls through to the next provider

**Status:** Implemented (QA needed — the runtime E2E on `prod-host` is the owner-visible half).
**Date:** 2026-08-23
**Owner decision, verbatim:** *"Task should never be blocked. if model is unavailable or limit is
hit it should always automatically proceed on next available provider & model."*

**Decides** todo `81ab4ebd` — and in a direction neither of its acceptance criteria anticipated.
That todo asked for one of two things: constrain a wildcard pool to the task's provider, or document
the picker as advisory. The owner chose a third: **availability outranks the pick.** An engine
choice is a preference, and a preference never stops work.

**Extends** `2026-08-23-step-runner-account-resolution.md` (a step resolves its own account),
`2026-08-23-retarget-task-to-another-engine.md` (the limit is written down, and the out-of-quota
setting), `2026-08-16-agent-account-usage-routing.md` (the pool).

## TLDR

Three things stop a task today. All three become fall-through.

1. **The out-of-quota fallback is off by default.** `rerouteExplicitAccountIfLimited` already
   crosses providers — it just never fires. Default flips to **on**.
2. **The spawn gate parks a run whose reroute already succeeded.** `heldAccountFor` (admission)
   learned the setting; `requeueWhileHeld` (spawn) did not, and it rebuilds the hold key from the
   *record*, which the reroute never stamps. A run rerouted `claude:default` → `claude:secondary`
   is parked on the key it just moved off. (The fix is to tell the gate what dispatch resolved —
   **not** to switch the gate off; see rung 4 below.)
3. **A step-level runner pin cannot cross providers.** Today's `resolvePoolForProvider` confines
   candidates to the pinned provider *by design*. When every account of that provider is exhausted
   there is nowhere to go and the step dies.

## The decision that governs #3, because it overrides an earlier one

`spec-to-deploy` pins `runner: claude` + `opus` on `spec` and `review-spec`, from the owner's
2026-08-22 instruction: *"writing spec + spec review should be by opus always"*. That pin exists
precisely so a codex run still writes its spec on opus.

**"Never blocked" and "always opus" collide when every Claude account is exhausted**, which was the
live production state when this was filed. Asked directly, the owner chose: **proceed anyway.** The
step runs on the next available provider and the transcript says loudly that it downgraded.

So the quality pin is now a *preference with a fallback*, not a guarantee. That is a real reduction
in what `spec-to-deploy` promises and it is written here so the next reader does not discover it by
finding a spec written on the wrong model. The mitigation is announcement, not prevention: every
downgrade names what was planned, what it ran on, and why.

## Solution

**A ladder, applied wherever an account is chosen. It only ever descends, and it never stops.**

1. the account the task named, if it is not limited;
2. another account of the **same** provider, ranked by the existing `selectPoolAccount` signals;
3. an account of **another** provider — a downgrade, always announced;
4. nothing is available anywhere → the existing account hold stands, and the task waits on a
   visible appointment at the provider's real reset.

**Rung 4 changed during implementation, and the change is the important part of this spec.** It
first read "proceed on the named account and let it fail honestly", implemented by making the spawn
gate skip the hold whenever the setting is on. That reddened 23 tests in `auto-resume.test.ts` and
every one of them was right: it disabled the hold outright on a default host, including the herd
control that stops a dozen queued runs all walking into one closed window — which the ruling never
asked for. The ruling is *next **available** provider*; with none available the word has no
referent, and an appointment costs no quota, shows in the cockpit as `held until <time>`, and
recovers by itself. **Never-blocked is not never-waits.** What it rules out is waiting behind a
limit on a provider the task was not going to use — the failure that was actually reported.

Concretely:

- **`resources.fallbackAcrossAccountsWhenLimited` defaults to `true`** (config, semaphore, and the
  two snapshot suites). Kept as a setting, per the owner: off restores today's parking behaviour.
- **`requeueWhileHeld` is told which account dispatch resolved**, instead of rebuilding the key
  from the record the reroute never stamps. It still parks when that account is held — the gate is
  setting-independent, and asks only "is the account this run will actually use held?".
- **`runAgentStep` downgrades a pinned provider that is wholly exhausted.** Before stamping
  `backend`, if the step pins a runner, the setting is on, and every account of that provider is
  limited, pick the best available account anywhere and stamp that instead — with a note naming the
  planned model and provider and the reason.

- **The engine picker says it is a preference.** Todo `81ab4ebd`'s second branch — the one this
  decision takes — is *"the per-task picker is documented as advisory … **and the UI says so**"*.
  Recording the decision in the corpus satisfies half of that criterion; the picker itself has to
  carry it, or the next person picks codex to dodge a Claude limit and believes it took. Keyed on
  the **setting**, not on whether a wildcard pool happens to be configured: under this decision the
  override comes from availability, which is true whatever shape the routes are in.

  This is the criterion the cancelled task `da0119ec` existed to satisfy, and it is the part that
  would have been lost by treating "the owner decided" as the whole job. The decision closes the
  question; the disclosure is the deliverable.

## Risks

- **R1 — a spec written on a weaker model, silently.** Mitigated by announcement only; that is the
  owner's explicit trade. The note is therefore load-bearing, not decoration, and it is asserted.
- **R2 — burning turns into a closed window.** Step 4 is a deliberate reversal of what the hold was
  for. Bounded by the existing auto-resume cap, which is untouched.
- **R3 — the downgrade fires when it should not.** Keyed on *every* account of the provider being
  limited, never on one. A test pins the "one limited, one healthy" case to same-provider.

## Verification — executed

Every case below was confirmed to fail before the change it covers; the mutations are recorded
because a green test that cannot go red is the failure mode this section exists to rule out.

**Default flip** — `config.test.ts` ×2 and `workspace-api.test.ts` ×4 went red on the flip itself
(that IS the confirmation) and were updated. `account-fallback.test.ts`'s two default assertions
were inverted rather than deleted: nobody writes this key, so what they assert is what every host
does. `workspace-api.test.ts`'s round-trip was rewritten to write **`false`**, which is now the
non-default direction and the one a falsy-swallowing merge would drop.

**`requeueWhileHeld`** — `account-fallback.test.ts`, three cases called directly rather than
through a live run, so they differ in exactly one argument. Fixture: a `failed` record with a live
`autoResumeAt` (which is what `accountHolds()` reads), and a run forced to `running` first so that
being parked is *visible* — `createRun` mints a record already `queued`, and asserting "it is
queued" on one born queued passes with the gate deleted. Resolved to an open account → no park;
resolved nothing → parks; **resolved back onto the held account → parks**, which is the case a
"was anything resolved?" implementation gets wrong.
*Mutation:* ignore `resolved` and rebuild from the record → the first case fails. The blunt version
(skip the gate outright when the setting is on) fails `auto-resume.test.ts`'s "still parks when
there is nowhere else to go".

**The default host had no coverage at all, and nearly shipped that way.** `auto-resume.test.ts`'s
two describes now pin `fallbackAcrossAccountsWhenLimited: false` through a `heldManager()` helper,
because the hold is the mechanism they test and the fallback now answers first — legitimate, and
also exactly how a shipped default ends up unasserted: every test opts out for a good local reason
and nobody covers what a real host does. A third describe pins the default host directly, driven by
a real `mock:limit`: the next task starts on `codex:default` with the note naming both accounts,
and with every candidate limited it parks. (The codex limit in that second case is hand-written —
the bundled codex mock answers `mock:limit` with a revoked-token error, not a usage-limit envelope,
so driving it would assert a parse that never happened. Measured: the first version did, and failed
with `['claude:default']`.)

**Step downgrade** — `step-runner-account.test.ts`. Every claude account limited → the pinned step
runs on codex and the note names both ends. One claude account open → it stays on claude.
*Mutation 1:* `downgradePinnedRunner` returns `undefined` unconditionally → the downgrade case
fails. *Mutation 2:* delete the `open.some(provider === pinned)` guard → **initially still green**,
because `selectPoolAccount` ranked `claude:secondary` above `codex:default` anyway and the later
`choice.provider === pinned` guard caught it. The control was sharpened with a fresh dispatch on
`claude:secondary` (pushing it to the back of least-recently-dispatched) so the two guards are
observably different; the mutation then fails. Recorded because the first version of that control
was passing for a reason unrelated to the guard it was written for.

**The picker disclosure** — two levels, because `advisory` is an *optional* prop defaulting to
`false`, so a call site that forgets it is silently wrong while the component's own tests stay
green. `agent-pool-rows.test.tsx` pins the component (on / off / and that the note is a disabled
footer rather than a selectable row that would `onPick` its own text). `follow-up-engine.test.tsx`
pins the **wiring** at a real surface, from the served workspace config through `useEngineAdvisory`
to the menu. *Mutation:* drop `advisory={advisory}` at the call site → the wiring test fails while
every component test stays green, which is the point of having both.
`resources-section.test.tsx` pins the settings pane's reading of an **absent** key as On, with an
explicit-`false` control; *mutation:* `?? true` → `?? false` → the absent case fails.

That file also gained `afterEach(cleanup)`: this package runs vitest without `globals`, so
`@testing-library/react` never registers its auto-cleanup and every `render` accumulated in one
`document`. It had gone unnoticed because no earlier test in that file queried document-wide for an
element a second render also produced.

**Three defects the full box gate caught that no targeted run could, and a fourth that only a
measurement found.** Each is recorded because each is a class of mistake, not a typo.

1. **The record said codex; the process still spawned claude.** `runAgentStep` evaluated
   `step.runner ?? taskBackend` **twice** — once at the top, stamped on the record, and again ~140
   lines down as `stepBackend`, which is what feeds `modelForBackend`,
   `normalizeModelForBackend`, `agentEnvForStep`, `brokerFor` and `createRunner`. The two
   expressions were identical until `downgradePinnedRunner` made them able to disagree, so the
   downgrade recorded a lie and changed nothing. **The first version of the test asserted
   `step.backend`, which is exactly the half a record-only bug agrees with**, and it was green.
   Fixed by binding `stepBackend = backend`; the test now asserts the transcript's `model:` line
   instead, and the fixture pins `model: 'opus'` on the claude step (mirroring `spec-to-deploy`) so
   that a codex step must drop the Claude alias — `model: auto` vs `model: anthropic/opus` is the
   only observable difference between "the record says codex" and "codex is what ran".
   *Mutation:* restore `step.runner ?? taskBackend` → the downgrade test fails with
   `expected 'model: anthropic/opus' to be 'model: auto'`.

2. **`useEngineAdvisory` threw through the whole React tree.** It read
   `config.data?.resources.fallbackAcrossAccountsWhenLimited` — the `?.` guards `data`, not
   `resources`, which is required by the response *type* and optional in *fact*: an older server,
   an error-shaped 200, or any test stubbing `/api/v1/workspace/config` with `{}` gives a defined
   `data` with no `resources`. **125 tests across 7 files**, none of them about this setting and
   none reachable by running the suites the change touched. Fixed with the second `?.`, with a
   regression test that serves a workspace config carrying no `resources` at all.

4. **The queue ran hot, and the only symptom was the transcript.** `heldAccountFor` returning
   `undefined` under the setting threw away the **spawn memo** as well as the record's hold — and
   `noteHeldRuns` reads that same predicate to decide whether the thread has already spoken, so an
   `undefined` answer *deleted the dedupe memo on every sweep*. A genuinely stuck run then looped
   dequeue → resolve → park → release → pump, re-noting each time: **37 identical "held in the
   queue" notes in 1.5 seconds**, the same shape as the 2626-note write storm rolled back earlier
   the same day. From the outside it is indistinguishable from a correctly parked run — status
   `queued`, no `startedAt` — which is why no assertion caught it and a `console` dump of the
   events did. Fixed by exempting the memo from the bypass: the record's key is a guess about where
   the work goes, the memo is what dispatch **actually refused after the full resolve**, so
   honouring it is safe and is the brake. The test now asserts the queue is *quiet* — exactly one
   `held in the queue` note — not merely that the run is parked. *Mutation:* restore the blanket
   `return undefined` → `expected … to have a length of 1 but got 37`.

A fifth finding, about the gate itself: the first background poll greped for `^ FAIL` and
`^ *(Test Files|Tests) ` against **ANSI-coloured** vitest output, matched neither, and reported
"0 failures" for the whole 507 s of a run with 125. Silence on an unproven channel read as health.
The poll now strips ANSI before grepping.

And one about waiting, twice over: both new engine tests first waited for a run to reach a
terminal status, and both timed out on work that had **already done everything they assert** — the
step was dispatched on codex, with the reroute note written, at 30 s. A timeout is a fact about the
waiter. Both now wait for the step to be dispatched, and the harness prints the run's real state on
timeout so the next failure names the run rather than the clock.

**Gates** — `npm run typecheck` EXIT=0 on the Mac and on the box. Full `npm test` on the box (not
the Mac, whose load reddens the `fs.watch` suites); the whole `web` project also run on the Mac at
183 files / 4006 tests green after fix 2.

**Runtime E2E on `prod-host`** — still owed, and it is the reason this ships as QA Needed:
deploy, then confirm on a task pinned to a provider that is out of quota that it starts rather than
parks, that the transcript carries the downgrade note, and that the queue is quiet 60s later
(`grep -c` on the run's `.ndjson` twice, which is what caught the 2626-note write storm).
