# The out-of-quota reroute checks the account a run is actually pinned to run on

**Status:** Implemented (QA Needed — the production nudge on the owner's stuck task has not been
confirmed post-deploy).
**Date:** 2026-08-24
**Repo:** `cezar`
**Extends:** `.ai/specs/2026-08-23-retarget-task-to-another-engine.md` (Phase 4, the reroute this
fixes), `.ai/specs/2026-08-24-second-codex-account-balancing.md` (the pool it should have used).

## TLDR

The owner reported the cockpit still showing "You've hit your usage limit" on a codex task,
retrying at Aug 31, despite a second, healthy codex login (`second@example.com`, `pro`)
being registered and balancing new dispatches correctly (6 dispatches that day). The pool itself
works. This one task did not use it.

**Measured on `prod-host`:** run `15ff402b-c38e-461f-9bd2-a478cdbb1074`, created
2026-08-22T12:18:50Z — before the second codex account existed — carries `runner: codex,
agentProfile: "secondary"`. No codex account named `"secondary"` has ever existed (the discovered
second login was auto-named `second-example-com` from its `id_token`, per
`2026-08-24-second-codex-account-balancing.md` D3). `"secondary"` is `claude:secondary`'s id,
added the same session.

`rerouteExplicitAccountIfLimited` (`workflows/run.ts`) exists exactly for this shape of problem —
an explicit account pick that turns out to be limited should reroute rather than sit refused
forever (`2026-08-23-retarget-task-to-another-engine.md` Phase 4, `2026-08-23-never-block-a-task.md`
made it default-on). It did not fire, because it built its hold-check key from the run's raw,
dangling `agentProfile` string:

```ts
const current = accountUsageKey(provider, input.agentProfile); // "codex:secondary"
if (!isLimited(usageEntry(usage, current).limited)) return undefined; // no entry ⇒ "not limited"
```

`"codex:secondary"` has no usage entry — nothing has ever run under that key, because it names no
real account — so `isLimited` reads false and the function exits on its "cheap case" comment.
Meanwhile `selectProfile` (`workspace/agent-profiles.ts`), the function that actually resolves the
account to spawn on, silently falls back to the provider's literal DEFAULT login for any id it
cannot match (a documented, deliberate choice there — see its docblock). By execution time
`codex:default` was held until 2026-08-31T12:32Z, and every continue since has resolved to it,
failed on it, and never once asked whether `codex:default` — the account actually running — was
the account that was actually limited.

Same shape as the defect `2026-08-23-usage-limit-hold-account.md` fixed ("the hold named the wrong
account" — a run-level key vs. a step-level key): a check keyed on the WRONG identity of the
account, so it answers a question nobody is asking.

## Problem

Two independent things degrade an unmatched `agentProfile` to the provider default —
`selectProfile`, when actually resolving who runs, and (before this fix) nothing in
`rerouteExplicitAccountIfLimited`, which is supposed to notice a limited pick and move it. The
first is correct and documented as deliberate: an unknown id has to mean *something*, and refusing
to start is worse than the discovered default. The second was a gap: the reroute's OWN idea of
"the account this run is pinned to" diverged from what `selectProfile` would actually produce for
the same input, so the two functions disagreed about which account this run was on, and the one
that runs (`selectProfile`) never got checked for a hold.

## Solution

`rerouteExplicitAccountIfLimited` now resolves `input.agentProfile` the same way `selectProfile`
does before building the usage key: if the id is unset, `DEFAULT_AGENT_ACCOUNT_ID`, or does not
match any stored account for the run's provider, treat it as unset (`resolvedAgentProfile =
undefined`), which `accountUsageKey` turns into the provider's default key. Everything downstream —
candidate filtering, `selectPoolAccount`, the no-op check, the note text — already took `current` /
the resolved id as an input and needed no other change. The note now names the account actually
checked (`codex:default`, accurate) instead of the phantom one (`codex:secondary`, which never had
a usage entry and never will).

This does not touch `selectProfile` itself, the provider-partitioned band ranking from
`second-codex-account-balancing`, or the cross-provider candidate set `rerouteExplicitAccountIfLimited`
already searched — only which key gets checked for a hold.

## Architecture

```
run.agentProfile = "secondary" (dangling, provider=codex)
        │
        ├─ selectProfile()              → no match → codex DEFAULT       (unchanged, correct)
        │
        └─ rerouteExplicitAccountIfLimited()
              BEFORE: accountUsageKey('codex', 'secondary') → no entry → "not limited" → no reroute
              AFTER:  same resolution rule as selectProfile → accountUsageKey('codex', undefined)
                      = "codex:default" → IS limited → reroute via selectPoolAccount, same as
                      any other explicit-account hold
```

## Data Models

None changed. No new field, no new store.

## API Contracts

None changed. The out-of-quota note's text now names a different (correct) account string; no
consumer parses it structurally (`account-hold.ts` on the web side keys off the run record's
`runner`/`agentProfile` after the fact, not the note).

## Risks

- **R1 — a dangling id that resolves to an UNLIMITED default now silently keeps running on the
  default, exactly as before.** No behaviour change there: the cheap-exit case still exits, just on
  the right key. That is correct — nothing is out of quota, there is nothing to reroute.
- **R2 — the fix widens what counts as "unset"** (unknown id ⇒ unset). A profile id that is merely
  *stale* in a benign way (e.g. an account renamed since the run started) now also degrades to the
  default check rather than a permanently-wrong one. That is the intended effect, not a side one.

## Verification

**V1 (unit).** New case in `workflows/account-fallback.test.ts`: a run pinned to `runner: 'claude',
agentProfile: 'ghost-secondary'` (no such stored account) reroutes to `codex:default` (the only
unlimited candidate in the fixture, `claude:default` being limited by the file's own `beforeEach`)
and the note names `claude:default`, not the phantom id. Negative control: this repo's existing
"with it ON, moves the task…" case (the SAME `claude:default` hold, but named directly rather than
through a dangling id) already covers that a legitimate hold still reroutes — unchanged by this
fix, and left running as the regression guard that the resolution rule was not loosened for the
common case.

**V2 (gates).** `npm run typecheck`, `npm run build`, full vitest suite — on the box
(`prod-host`, `/var/lib/cezar/gate-codex2`), twice (this repo's own documented
load-sensitive flake pool — see `second-codex-account-balancing.md` V5).

**Result, measured 2026-08-24 (load average 4-7, not idle — this box runs agents continuously):**
`typecheck` exit 0 both runs; `build` exit 0 both runs; suite run twice.

| | files | tests |
|---|---|---|
| run 1 | 617 passed / 5 failed of 624 | 11694 passed / 14 failed of 11712 |
| run 2 | 617 passed / 5 failed of 624 | 11694 passed / 14 failed of 11712 |

**Identical failures both runs, none touching account routing** — `catalog.test.ts` C18 (the
standing host-budget red this repo's own doctrine already expects), `scheduler.test.ts`,
`pasted-attachments.test.ts`, `step-stopped.test.ts` (3), `system-prompt.test.ts` (9). Confirmed
pre-existing, not this change: `system-prompt.test.ts` and `step-stopped.test.ts` reproduce the
same 11 failures on the Mac against pristine `main` with this diff fully stashed out (mock-response
queue bleed between tests — a `CEZ_TODOS_FILE` assertion instead reads a task-classifier prompt,
i.e. test-order pollution unrelated to account resolution). `account-fallback.test.ts` (12 tests,
including the new case) passed clean both runs.

**V3 (production).** After deploy, the owner's stuck run (or its next auto-resume) should reroute
off `codex:default` — confirm via its event log (`… out of quota, so this task starts on codex:…
instead`) and `runner`/`agentProfile` updating on the record. Until confirmed this is QA Needed.
