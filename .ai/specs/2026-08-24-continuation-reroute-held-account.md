# A resume pinned to a held account starts fresh on an unlimited one, instead of re-failing forever

**Status:** Implemented (QA Needed — the production nudge on the owner's stuck tasks has not been
confirmed post-deploy).
**Date:** 2026-08-24
**Repo:** `cezar`
**Extends:** `.ai/specs/2026-08-24-reroute-checks-dangling-account-key.md` (the sibling gap this one
completes — see that spec's corrected TLDR), `.ai/specs/2026-08-23-retarget-task-to-another-engine.md`
(Phase 4, the reroute mechanism itself), `.ai/specs/2026-08-24-second-codex-account-balancing.md`
(the pool it should have used).

## TLDR

`2026-08-24-reroute-checks-dangling-account-key.md` shipped and deployed the same day, and the
owner still saw "You've hit your usage limit" on the exact task that spec named
(`15ff402b-c38e-461f-9bd2-a478cdbb1074`), and again on a second task
(`22b6f7cd-c5ed-4b20-8d84-961a95f3656b`) after pressing "Run on another engine" in the UI. That
spec's fix was real and correctly verified — but it only touches `execute()`, the fresh-dispatch
path. **A manual "Continue" and every unattended auto-resume never go through `execute()` at
all** — they call `continueRun` → `runContinuation`, a wholly separate method that resolves the
account a resume is pinned to (`resumedProfileId ?? run.agentProfile`) and hands it straight to
`resolveProfileEnvForRoot`, with no hold check anywhere in between. `fireAutoResume` — the
unattended timer both stuck tasks were sitting behind — calls nothing but `continueRun`. So the
first fix closed the gap for a run that has never started; both of the owner's tasks had already
started, failed once, and were sitting on `autoResumeAt`, which is exactly the population the first
fix does not reach.

Confirmed by re-reading `15ff402b` after the first fix's deploy: `status: "failed"`,
`agentProfile` still `"secondary"` (the same dangling id the first spec diagnosed), same "continue
failed" usage-limit error, `autoResumeAt` unchanged. The reroute logic that spec added had never
been asked the question, because nothing on the resume path calls it.

## Problem

Two independent account-resolution paths exist in `workflows/run.ts`, and only one of them checks
a hold before spending a turn:

- `execute()` (fresh dispatch / chain re-entry) → `rerouteExplicitAccountIfLimited` → checked,
  fixed by the sibling spec.
- `continueRun()` → `runContinuation()` (manual Continue, and `fireAutoResume`'s unattended timer,
  which calls `continueRun` and nothing else) → `agentEnvForStep` → `resolveProfileEnvForRoot`
  directly. **Never checked.**

A resume is pinned to an account for a real reason — `--resume <sessionId>` reattaches to a
conversation that lives inside that account's own config dir, so a continuation cannot simply spend
a different login the way a fresh dispatch can. That pinning is correct when the account is fine.
It becomes a permanent trap the moment the account goes into a long usage-limit hold: every
`continueRun` — the manual button and the unattended timer alike — re-resolves the same pinned
account, fails again, and re-arms the next `autoResumeAt` days out. Two working, unlimited accounts
of the same provider do not help, because nothing on this path ever asks whether one is open.

## Solution

`runContinuation` now runs the account this continuation is about to use through
`rerouteExplicitAccountIfLimited` — the same function, reused rather than reimplemented, so the
hold-check and the candidate ranking cannot drift between the two call sites — before it resolves
anything else. Computed as early as possible in the method (right after the run record is fetched,
ahead of every other use of the backend), because the decision changes what several other pieces of
the method must do:

- **Which account to check.** `resumedProfileId ?? run.agentProfile`, the same identity
  `agentEnvForStep` would otherwise resolve — the two must agree on which account is under
  question, or this checks a hold nobody is about to run under (the exact defect the sibling spec
  fixed for `execute()`).
- **A rerouted continuation cannot reattach to the old session.** The transcript lives inside the
  OLD account's config dir. This reuses the exact fresh-session downgrade mechanism the method
  already has for a different reason (`resumeDowngraded`, spec
  `2026-08-22-resume-fresh-session-fallback`, triggered there by a missing transcript) — same
  effect, a new trigger: mint a fresh session id, `resume: false`, note it on the transcript.
- **The reroute can cross providers.** `rerouteExplicitAccountIfLimited`'s candidate pool spans
  every profile-capable provider, same as it already does for `execute()` — a claude hold can
  reroute a continuation onto codex. `continueBackend` (previously always equal to the raw
  `backend` parameter) now reads `rerouted?.provider ?? backend`, and every place downstream that
  used to close over the raw parameter — the step-start stamp, the `session` event handler, the
  missing-session-rejection check and its metric — now closes over `continueBackend` instead, or
  the step's record and the retry-classification logic would keep asserting the OLD provider while
  a DIFFERENT one actually ran.
- **A crossed-provider reroute can strand a model pin.** `continueRun`'s own `opts.runner` switch
  already guards this (`inheritedPinIsForeign`), but only when the CALLER named a runner — this
  reroute picks one automatically, so nothing upstream has looked at the pairing. Dropped, not
  substituted, same call and the same reason `modelForBackend` already makes for the per-step path:
  a pinned vendor id for the new provider goes stale, falling through to its own default does not.
  Checked against `continueBackend` at the point `continueRawModel` is computed (not only written
  back to the store) so it is correct even though `record` itself is never re-fetched after the
  reroute's `updateRun`.

Everything else in `runContinuation` — the worktree materialization, the temp-directory preflight,
the model-identity gate, the broker/session spawn — is unchanged; it now simply runs against
`continueBackend` and the (possibly rerouted) profile id instead of the raw inputs.

## Architecture

```
continueRun()  ──┐                              execute() (unchanged, sibling spec)
                  │                                     │
                  ▼                                     ▼
          runContinuation()                explicit input.agentProfile
                  │                                     │
     resumedProfileId = the session's                   │
     OWN recorded account, or run.agentProfile           │
     if no session exists yet                            │
                  │                                     │
                  ▼                                     ▼
     rerouteExplicitAccountIfLimited(runId,   rerouteExplicitAccountIfLimited(runId,
       {agentProfile: resumedProfileId          {agentProfile: input.agentProfile,
         ?? run.agentProfile, runner: backend},   runner: input.runner}, defaultRunner)
       backend)
                  │                                     │
        held? ────┼──── no → continueBackend = backend (unchanged path, untouched by this fix)
                  │
                 yes
                  │
                  ▼
     runner/agentProfile rewritten on the record (crosses providers if that's where the
     open account is) → continueBackend = rerouted.provider → fresh session minted,
     resume:false → step/event-handler/retry-check all read continueBackend, not backend
```

## Data Models

None changed. No new field, no new store. `rerouteExplicitAccountIfLimited`'s signature narrowed
from `ExecuteRunInput` to `Pick<ExecuteRunInput, 'agentProfile' | 'runner'>` — the two fields it
ever read — so `runContinuation` (which has no `ExecuteRunInput` at all) can call it with just those
two values; `execute()`'s existing call site is unaffected (excess-property rules don't apply to a
variable, only to an object literal).

## API Contracts

None changed. The out-of-quota note fires on a continuation now, in addition to a fresh dispatch —
same event shape (`type: 'note'`), same text template, already covered by `account-hold.ts`
treating notes as prose, not a parsed contract (see the sibling spec).

## Risks

- **R1 — the common case (account not held) is a single cheap `isLimited` check added to every
  continuation**, ahead of everything else the method already did. No behavioural change on that
  path: `rerouted` is `undefined`, `continueBackend` reduces to the original `backend`, and every
  place that switched from `backend` to `continueBackend` reads the identical value.
- **R2 — a rerouted continuation always starts a fresh session, discarding the old one's
  conversation context.** This is the FEATURE, not a side effect: a held account's session cannot
  be reattached to under a different login (`--resume` needs the account that created it), so the
  only alternative to a fresh start is what the owner was already stuck in — resuming the SAME
  account forever. A fresh session that actually runs beats a resumed one that never does.
- **R3 — the model-pin-drop reasoning (`foreignModelPin`) only fires on a crossed-provider reroute**,
  matching `modelForBackend`'s existing behavior for the per-step path; a same-provider reroute
  (two claude accounts, say) leaves the pin alone, which is correct — the pin is not foreign to the
  provider that is still running.

## Verification

**V1 (unit).** New `describe` in `workflows/account-fallback.test.ts` ("out-of-quota fallback — a
resume pinned to a now-held account"), a SEPARATE fixture from the sibling spec's suite because it
needs the opposite initial condition (the account must be OPEN when the run starts, so a real
session gets minted, and only become held partway through — the sibling suite's shared `beforeEach`
pre-limits `claude:default` before anything runs).

- `mock:limit` fails the first turn with the real "usage limit reached|&lt;epoch&gt;" envelope;
  `scheduleAutoResumeIfLimited` records the hold exactly as production does (nothing in the test
  writes the hold directly). `manager.continueRun(...)` — the same call both the Continue button and
  `fireAutoResume` make — reroutes: the note names both accounts, `runner`/`agentProfile` move to
  the open login (crossing providers in this fixture, same reach the sibling suite's cross-provider
  case exercises), and the continuation step carries a freshly minted session id, never the
  original. Needed `CEZ_CODEX_BIN` pointed at `__fixtures__/codex/mock-codex-app-server.mjs` (codex
  doesn't gate on `CEZ_DRY_RUN` — only `claude-cli-runner` does), and the settle assertion polls
  for the continuation step leaving `pending`/`running` rather than for `status: 'done'`, because
  that fixture plays one fixed scripted turn (parks at `waiting`) rather than reading `mock:done`
  the way the claude mock does — the fact under test is which account the reroute landed on, not
  how that fixture's own turn ends.
- Negative control: a resume pinned to an account that is NOT held completes normally, with no
  reroute note and no `agentProfile`/`runner` change — the untouched R1 path.

**V2 (gates).** `npm run typecheck`, `npm run build`, full vitest suite — on the box
(`prod-host`, `/var/lib/cezar/gate-codex2`), twice.

**Result, measured 2026-08-24 (load average 0.3 → 5.2, not idle):** `typecheck` exit 0 both runs;
`build` exit 0 both runs.

| | files | tests |
|---|---|---|
| run 1 | 617 passed / 5 failed of 624 | 11696 passed / 14 failed / 4 skipped of 11714 |
| run 2 | 617 passed / 5 failed of 624 | 11696 passed / 14 failed / 4 skipped of 11714 |

**Identical failures both runs, byte-for-byte the same set the sibling spec already documented as
pre-existing** — `catalog.test.ts` C18, `scheduler.test.ts` (D8a), `pasted-attachments.test.ts`,
`step-stopped.test.ts` (3), `system-prompt.test.ts` (8). None touch account routing or
`account-fallback.test.ts`, which passed clean (14 tests: the sibling suite's 12 plus this spec's 2
new ones) on both runs. A first attempt at this check, run locally and concurrently with other
work on the loaded Mac (not the box), surfaced three ADDITIONAL timeout-shaped failures
(`resume-missing-session.test.ts`, `run.test.ts`'s native-Codex-ask test, `workspace-parallel.test.ts`)
that did not reproduce on the box at all, in either run — the load-sensitive flake pool this repo's
own doctrine warns never to diagnose from a loaded Mac (see `second-codex-account-balancing.md` V5
and `2026-08-24-reroute-checks-dangling-account-key.md` V2).

**V3 (production).** After deploy, `15ff402b` and `22b6f7cd` (or their next auto-resume) should
reroute off the held account — confirm via each run's event log (the "out of quota, so this task
starts on … instead" note) and `runner`/`agentProfile` updating on the record. Until confirmed this
is QA Needed.
