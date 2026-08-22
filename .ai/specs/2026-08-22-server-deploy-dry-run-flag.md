# `--dry-run` for `cezar server-deploy`

**Status:** draft

## TLDR

`cezar server-deploy --strategy=blue-green --dry-run` fails argv parsing today —
`--dry-run` isn't a registered option, so `parseArgs` rejects it as unknown. The only
existing preview path, `CEZ_DRY_RUN=1`, is wired into the `restart` strategy only
(`index.ts:1100` → `engine.ts`); the `blue-green`/`rollback` branch (`index.ts:347-375`
→ `releaseDeployCommand` → `runReleaseDeploy`) never reads it at all, even though
`runReleaseDeploy` already fully honours an `options.dryRun` it's never given
(`release-deploy.ts:326,353,399-401`). Worse: inside that same function, the rollback
branch (`:365-370`) runs unconditionally — it never checks `dryRun` — so a hypothetical
`--rollback --dry-run` would perform a **real** rollback (flip the symlink, restart the
unit) today, not preview one. This spec adds a real `--dry-run` boolean flag, ORs it
with `CEZ_DRY_RUN` (kept working unchanged, per `BACKWARD_COMPATIBILITY.md:14`), threads
it into `releaseDeployCommand`/`ReleaseDeployCliOptions` for the first time, closes the
rollback dry-run gap, documents the flag in `--help`, and fixes a second bug that
plumbing would otherwise introduce on its own: `releaseDeployCommand`'s success tail
falling through to `console.log('Deploy complete.')` on a dry run, once `dryRun` first
reaches it (round-2 review finding — see Solution).

## Problem

Two separate gaps, both on the code path the task's acceptance criteria exercise
(`--strategy=blue-green`):

1. **No CLI surface.** The shared `parseArgs` options block
   (`packages/cezar/src/index.ts:249-281`) has no `'dry-run'` entry, so
   `--dry-run` is rejected before dispatch ever runs. `--help` doesn't mention it
   either (`index.ts:89-95`).
2. **No plumbing on the blue-green/rollback path, at all — not even the env var.**
   `CEZ_DRY_RUN` is read in exactly one place, `index.ts:1100`, inside `runOpts`
   used only by `server-install`/`server-uninstall`/`server-deploy --strategy=restart`
   (via `serverCommand`). The blue-green dispatch branch
   (`index.ts:347-375`, calls `releaseDeployCommand`) never reads `process.env`
   at all. `ReleaseDeployCliOptions` (`release-cli.ts:31-44`) has no `dryRun`
   field, and `releaseDeployCommand` (`release-cli.ts:61-72`) never sets one on
   the object it passes to `runReleaseDeploy`. This means today, right now,
   `CEZ_DRY_RUN=1 cezar server-deploy --strategy=blue-green` does a real,
   unguarded deploy. The task's own framing ("reachable only via `CEZ_DRY_RUN=1`")
   is not true for the strategy the acceptance criteria test — confirmed by
   full-file read of `release-cli.ts` and `index.ts`, not previously recorded
   anywhere in the spec/KB record (see brief
   `.ai/specs/briefs/2026-08-22-server-deploy-dry-run-flag.md`).

A third gap, found while reading `release-deploy.ts` in full (not previously flagged in
the task or the brief's line-numbered inventory, only in its open questions):

3. **The rollback branch inside `runReleaseDeploy` ignores `dryRun` entirely.**
   `runReleaseDeploy` short-circuits on `options.dryRun` at two points — before the P2
   re-exec handoff (`:326`) and, for a forward deploy, right before staging
   (`:399-401`). But the rollback branch (`:365-370`) sits **between** those two
   checks and is reached whenever `rollback` is true, regardless of `options.dryRun`:

   ```ts
   if (rollback) {
     const outcome = await runRollback(
       { releasesDir, linkPath, ...(options.rollbackTo ? { to: options.rollbackTo } : {}) },
       { restart: () => fx.restart(unitName), emit, now: fx.now },
     );
     return { ok: outcome.ok, outcome, ...(outcome.ok ? {} : { error: outcome.detail }) };
   }
   ```

   `runRollback` (`deploy-strategy.ts:203-217`) unconditionally flips the symlink,
   saves the ledger, and calls `fx.restart()` — a real restart. So even after this
   spec ships the flag and the env-var OR, `cezar server-deploy --rollback --dry-run`
   would still perform a genuine rollback while claiming to preview one. That is a
   worse outcome than not having the flag: it *looks* safe and isn't. A deploy is
   already "the more dangerous operation" per the task description, and per this
   repo's own doctrine (`AGENTS.md`, and the global CLAUDE.md's "fail closed on any
   path that can lose money or data") a flag whose name promises safety has to
   deliver it on every branch it's reachable from, not just the one the acceptance
   criteria happen to test. **Decision: in scope for this fix** — add the same
   `options.dryRun` short-circuit to the rollback branch, printing an equivalent
   one-line plan instead of executing `runRollback`. See Solution and Phase 2.

## Solution

**CLI surface** (`index.ts`):
- Add `'dry-run': { type: 'boolean', default: false }` to the shared `parseArgs`
  options block, next to `follow`/`reinstall` (same style, same block,
  `index.ts:249-281`).
- Add one help line under `cezar server-deploy` in the `HELP` template
  (`index.ts:89-95`), matching the existing sub-flag indentation:
  `--dry-run               print the plan, change nothing (also: CEZ_DRY_RUN=1)`.

**Dispatch** (`index.ts`, `case 'server-deploy'`, `:347-375`): compute one
`dryRun` value and pass it into both branches so the flag and the env var mean
the same thing everywhere `server-deploy` can run, not just on blue-green:

```ts
const dryRun = Boolean(values['dry-run']) || process.env.CEZ_DRY_RUN === '1';
```

- blue-green/rollback branch: add `dryRun` to the `releaseDeployCommand({...})`
  call.
- `restart` branch: `serverCommand('deploy', ...)` needs a way to receive the flag, and
  `values` is **not** in scope where the env var is currently read — `serverCommand` is a
  top-level function (`index.ts:1013`), not code running inside `main()`'s `parseArgs`
  block, and `index.ts:1100` sits inside its body, several call frames from `values`.
  Thread it as a parameter instead:
  - Add `dryRun?: boolean` to `serverCommand`'s `flags` parameter type
    (`index.ts:1017-1027`, beside `yes`/`domain`).
  - At the `restart` call site inside `case 'server-deploy'` (`index.ts:370-373`), pass
    the same `dryRun` value already computed once at the top of the case and passed to
    `releaseDeployCommand`: `serverCommand('deploy', repoRoot, values.platform, { yes: Boolean(values.yes), domain: values.domain, dryRun })`.
  - At `index.ts:1100`, read `dryRun: process.env.CEZ_DRY_RUN === '1' || Boolean(flags.dryRun)`.
  - The `server-install`/`server-uninstall` call sites (`index.ts:336-344`, `:392-395`)
    are **not** changed to pass `dryRun` — they share `serverCommand`'s `flags` type and
    the same `runOpts` builder, but installing/uninstalling isn't named by this task's
    acceptance criteria, and an omitted `flags.dryRun` is `undefined` (falsy), so adding
    the optional field doesn't change their behavior.

  This makes `--dry-run` work for `restart` too, which is not named in the acceptance
  criteria but is the same flag on the same command; leaving it silently unwired on the
  default strategy would be the identical trap as gap 3 above, just one strategy over.

**`ReleaseDeployCliOptions` / `releaseDeployCommand`** (`release-cli.ts:31-44,61-72`):
add `dryRun?: boolean` to the interface, pass `...(opts.dryRun ? { dryRun: true } : {})`
into the `runReleaseDeploy({...})` call.

**Dry run short-circuits once, right after `decideReExec` logs its reason — not
scattered across three branches, and not ahead of `decideReExec` either**
(`release-deploy.ts`, inside `runReleaseDeploy`). A first draft of this spec
proposed adding a *second* guard, to the rollback branch only, alongside the
forward-deploy check that already exists at `:399-401`. Review of that draft found
a third case it missed: the P2 re-exec short-circuit (`:322-324` in the pre-spec
code) already has its own guard,
`if (options.dryRun) return { ok: true, detachedUnit: `dry-run:${releaseId}` }`,
and that one returns with **no plan printed at all**. `releaseDeployCommand`
(`release-cli.ts:74-79`) treats any `detachedUnit` result as a real detached
deploy — it prints "Deploy is running outside this process so a restart cannot
kill it" and points at `--follow --release-id dry-run:<id>`, a log path
(`deployLogPath`) a dry run never writes, so `followDeploy` would poll it for its
full 15-minute deadline. `decision.reExec` is true whenever the deploy runs inside
`cezar.service`'s own cgroup with `KillMode !== 'process'`
(`self-safe-deploy.ts:84-124`) — exactly what an agent-driven deploy hits on a
not-yet-migrated box, i.e. the population this spec family exists for. So `--dry-run`
run from inside a task could exit 0 and change nothing while never showing a plan,
and while handing back a follow instruction that hangs.

A second review round caught a placement bug in this spec's own first fix for that:
putting the short-circuit *ahead* of `decideReExec` (before it is even called) also
deletes `log(\`deploy: ${decision.reason}\`)` (`:324`) from the preview — the one
line that says whether the real deploy would hand itself to a transient unit, which
is exactly the surprising behavior an agent-driven dry run most needs to see.
`decideReExec` and the `fx.cgroup()`/`fx.killMode()` reads that feed it are
read-only, so computing the decision costs nothing and mutates nothing — there is no
reason to skip it. Short-circuit **after** `decideReExec` runs and logs its reason,
but **before** `decision.reExec` is acted on, so one check still covers the
forward-deploy, rollback, and would-have-re-exec'd cases together, and the preview
gains information instead of losing it — then delete the three checks it replaces:

```ts
const releaseId = rollback
  ? (options.rollbackTo || 'rollback')
  : makeReleaseId(fx.now(), options.sha);

// ---- P2: get out of the cgroup we are about to restart ---------------------------------------
const decision = decideReExec({ /* unchanged */ });
log(`deploy: ${decision.reason}`);

if (options.dryRun) {
  log(rollback
    ? `DRY RUN — would flip ${linkPath} to ${options.rollbackTo || 'the previous release'} and restart ${unitName}.`
    : `DRY RUN — would stage ${options.source} → ${releaseDir(releasesDir, releaseId)}, smoke-boot it, flip ${linkPath}, restart ${unitName}, probe :${port}/api/v1/ready.`);
  return { ok: true };
}

if (decision.reExec) {
  // the `if (options.dryRun) return { ok: true, detachedUnit: ... }` line that lived
  // here is deleted — dry run already returned above and never reaches this branch.
  /* unchanged below this point */
}

// ---- P1: the install path must already be a symlink ------------------------------------------
if (existsSync(linkPath) && !isMigrated(linkPath)) {
  // the `!options.dryRun &&` clause that lived here is deleted — redundant, dry run
  // never reaches this line.
  /* unchanged */
}

if (rollback) {
  const outcome = await runRollback(/* unchanged — dry run never reaches this line */);
  return { ok: outcome.ok, outcome, ...(outcome.ok ? {} : { error: outcome.detail }) };
}

const free = fx.freeBytes(releasesDir);
if (free < MIN_FREE_BYTES) { /* unchanged — dry run never reaches this line either */ }

/* the `if (options.dryRun) { log('DRY RUN — would stage...'); return { ok: true }; }`
   block that lived here, just before `runGatedDeploy`, is deleted — folded into the
   check above. */
const outcome = await runGatedDeploy({ releasesDir, linkPath, entry, strategy }, effects);
```

This closes the rollback gap and the re-exec gap with one change, keeps the
`deploy: <reason>` preview line intact (the first draft's ahead-of-`decideReExec`
placement lost it — caught in round-2 review), and also removes a third,
previously-unnoticed problem: the free-space check
(`fx.freeBytes(releasesDir) < MIN_FREE_BYTES`) ran *before* the forward-deploy
dry-run print, so `--dry-run` on a box under the floor would have exited 1 with
"refusing to stage a release" instead of printing a plan — acceptance criterion 1
says "exits 0." With the check moved here, dry run reaches `decideReExec` only far
enough to log its reason, never far enough to act on `decision.reExec`, and never
reaches the free-space check or the symlink guard at all, so that failure mode no
longer exists.

No change to `runRollback`/`deploy-strategy.ts` or to `decideReExec`/
`self-safe-deploy.ts` — both keep their existing signatures and behavior; the fix is
entirely about which branches `runReleaseDeploy` reaches before it can call into
them.

**`releaseDeployCommand`'s success tail must also branch on `dryRun` — a second,
independent bug this spec's own change would otherwise introduce** (`release-cli.ts`,
inside `releaseDeployCommand`, `:74-90`). Before this spec, `dryRun` never reached
`releaseDeployCommand` at all, so its `result.ok && !result.detachedUnit` tail —
`console.log('\n  Deploy complete.')` followed by `describeReleases(...)` — only ever
ran after a real deploy. Once Phase 1 threads `dryRun` through, `runReleaseDeploy`
returns `{ ok: true }` with no `detachedUnit` for a dry run too (per the
short-circuit above — true even before Phase 2 lands, since the pre-existing
forward-deploy dry-run check at `:399-401` already returns the same shape), so
control falls straight into that same tail: a dry run would print the "DRY RUN —
would stage…" plan line and then claim `Deploy complete.`, followed by a release
listing indistinguishable from a real post-deploy report. That satisfies acceptance
criterion 1's exit-code-0 letter while violating its point — caught in round-2
review, which found nothing in the original draft (not the phases, not the tests)
would have caught it. Fix, in `releaseDeployCommand`, right after the `!result.ok`
branch returns:

```ts
if (opts.dryRun) {
  console.log('\n  Dry run complete — nothing was staged, flipped or restarted.');
  for (const line of describeReleases(releasesDir, linkPath)) console.log(`  ${line}`);
  console.log('');
  return 0;
}
console.log('\n  Deploy complete.');
for (const line of describeReleases(releasesDir, linkPath)) console.log(`  ${line}`);
console.log('');
return 0;
```

The `describeReleases` listing keeps printing on a dry run too — it's the state a
real deploy would be layering on top of, which is useful context for a preview —
but under a header that cannot be mistaken for a completed deploy.

**Everything else already correct, left untouched:** every reader of `CEZ_DRY_RUN`
outside `server-deploy`'s call graph (`auto-name.ts:31`, `mock-claude.mjs`,
`test/e2e/package-cli.test.ts`, `packages/web/e2e/*.ts`,
`.ai/scripts/test-env-up.sh`) — none of those touch `server-deploy` and none of
this spec's changes reach them.

## Architecture

No new components. The flag and the env var become two inputs that fold into one
`dryRun: boolean` at the top of `case 'server-deploy'`, then travel the existing
call graph unchanged in shape:

```
--dry-run  ──┐
             ├─► dryRun (boolean, computed once in `case 'server-deploy'`)
CEZ_DRY_RUN ─┘        │
                       ├─► restart path:   serverCommand('deploy', …, { dryRun, … })
                       │                     → engine.ts (already dryRun-aware)
                       │
                       └─► blue-green/rollback path:
                             releaseDeployCommand({ …, dryRun })
                               → runReleaseDeploy({ …, dryRun })
                                   └─ ONE short-circuit, right after `decideReExec`
                                      logs its reason (NEW, this spec) — prints the
                                      plan (forward or rollback wording) and
                                      returns, having reached just far enough into
                                      `decideReExec` to log why a real deploy would
                                      or wouldn't hand off, but never far enough to
                                      act on it, reach the symlink guard, the
                                      rollback branch, the free-space check, or
                                      `runGatedDeploy`
                             ← result has no `detachedUnit`; releaseDeployCommand's
                               success tail (NEW, this spec) branches on
                               `opts.dryRun` so it prints "Dry run complete" instead
                               of "Deploy complete."
```

## Data models

None. No persisted schema changes. `ReleaseDeployCliOptions` gains one optional
field (`dryRun?: boolean`) — additive, every existing caller (including
`release-cli.test.ts`'s calls to `migrateReleasesCommand`, which is a different
function) keeps working unchanged.

## API / interface contracts

- New CLI flag: `--dry-run` (boolean, default `false`), accepted by every
  `server-deploy` invocation regardless of `--strategy`. Equivalent to
  `CEZ_DRY_RUN=1`; the two OR together, so either one alone is sufficient.
- `CEZ_DRY_RUN=1` keeps its existing meaning and existing (narrower-than-assumed)
  reach on the `restart` path, per `BACKWARD_COMPATIBILITY.md:14`. This spec
  *widens* what it also covers (blue-green forward deploy, rollback) without
  changing what it already did — no existing invocation's behavior changes.
- `ReleaseDeployCliOptions.dryRun?: boolean` — new optional field, additive.
- `RunReleaseDeployOptions.dryRun` already exists (it's what `:326/:353/:399-401`
  already read) — unchanged, just reached from a new caller.
- No change to `runRollback`'s or `runGatedDeploy`'s signatures.

## Phases

### Phase 1 — flag + env-var OR on the forward-deploy paths (independently shippable, satisfies acceptance criteria 1–3 for blue-green)
- `index.ts`: add `'dry-run'` to `parseArgs` options; compute `dryRun` in
  `case 'server-deploy'`; pass it into `releaseDeployCommand({...})`; add the
  `--help` line.
- `release-cli.ts`: add `dryRun?: boolean` to `ReleaseDeployCliOptions`; thread it
  into the `runReleaseDeploy({...})` call in `releaseDeployCommand`. Also add an
  optional `host?: ReleaseDeployHost` parameter to `releaseDeployCommand` itself,
  passed straight through to `runReleaseDeploy({...}, host)` (which already accepts
  one) — additive, every existing caller (which passes none) is unaffected. Without
  this, nothing outside a subprocess can inject a fake host, so Phase 4's
  `releaseDeployCommand` test has no seam to assert against.
- `release-cli.ts`, `releaseDeployCommand`'s success tail: branch on `opts.dryRun`
  right after the `!result.ok` guard, before the existing
  `console.log('\n  Deploy complete.')` block, printing "Dry run complete —
  nothing was staged, flipped or restarted." instead (see Solution). Without
  this, a dry run reaches Phase 1's own new code path and reports a completed
  deploy on the very first strategy this spec is meant to fix.
- `BACKWARD_COMPATIBILITY.md`: add `--dry-run` to the `Flags:` list (`:12`) and
  note on the `Env vars:` `CEZ_DRY_RUN` entry (`:14`) that its reach now also
  covers the blue-green/rollback path, not just `restart` (see Risks).
- This alone makes `cezar server-deploy --strategy=blue-green --dry-run` print
  the plan, print the dry-run success line (not "Deploy complete."), and exit
  0 — `runReleaseDeploy` already does the right thing once `dryRun` reaches it
  (proven by the existing unit test `release-deploy.test.ts:198-205`).

### Phase 2 — move the dry-run short-circuit to right after `decideReExec` logs its reason, closing the rollback gap and the re-exec gap without losing the preview's most informative line (independently shippable; not named by the acceptance criteria, but correctness bugs this task's own investigation surfaced on the same flag surface — see Solution)
- `release-deploy.ts`: delete the three scattered dry-run checks — the re-exec
  branch's `if (options.dryRun) return { ok: true, detachedUnit: ... }`, the
  `!options.dryRun &&` clause on the symlink guard, and the forward-deploy
  `if (options.dryRun) { log(...); return { ok: true }; }` block just before
  `runGatedDeploy` — and replace them with the single short-circuit shown in
  Solution, placed right after `decideReExec` runs and logs
  `deploy: ${decision.reason}`, but before `decision.reExec` is checked.
  **Not** ahead of `decideReExec` — this phase's own first draft placed it
  there, which silently drops the `deploy: <reason>` line from every dry-run
  preview; round-2 review caught it (see Solution).
- This closes two gaps at once: the rollback branch no longer performs a real
  rollback under `--dry-run` (the gap acceptance criterion 1 needs closed), and
  the re-exec branch no longer swallows the plan and points at a follow command
  that hangs (found during review of this spec's first draft) — while keeping
  the `deploy: <reason>` line in the preview, which the ahead-of-`decideReExec`
  placement would have lost. It also removes a third latent problem: dry run no
  longer trips the free-space floor before it gets a chance to print anything.
- Ship in the same commit as Phase 1 if convenient — both touch
  `runReleaseDeploy`'s options surface — but each is independently testable and
  reviewable, so listed separately.

### Phase 3 — extend the OR to the `restart` strategy (independently shippable; makes `--dry-run` mean the same thing on every strategy, not just blue-green)
- `index.ts`: add `dryRun?: boolean` to `serverCommand`'s `flags` parameter type
  (`:1017-1027`); pass `dryRun` at the `restart` call site inside
  `case 'server-deploy'` (`:370-373`); change `:1100` to
  `dryRun: process.env.CEZ_DRY_RUN === '1' || Boolean(flags.dryRun)`. `values` is
  **not** in scope at `:1100` — `serverCommand` is a top-level function (`:1013`),
  so the flag has to be threaded through its own parameter, not read off `values`
  directly (a first draft of this spec assumed `values` was reachable there; it
  is not — see Solution).
- `server-install`/`server-uninstall` do not pass `dryRun` at their call sites —
  out of scope for this task, and the new field being optional means they're
  unaffected either way.
- Without this, `--dry-run` (no `CEZ_DRY_RUN`) would work on `--strategy=blue-green`
  but silently do nothing on the default `--strategy=restart` (or no `--strategy`
  at all) — the same "flag looks safe, isn't" trap Phase 2 closes on rollback,
  one strategy over. Low risk: `runOpts.dryRun` already flows through
  `engine.ts`, tested territory.

### Phase 4 — CLI-level test coverage (new; none of this path has any today)
- `release-deploy.test.ts:198-205` only calls `runReleaseDeploy({ dryRun: true })`
  directly — it never exercises `releaseDeployCommand` or the CLI entry point, so
  none of Phases 1–3's wiring has a regression test today (confirmed in the
  brief). Add:
  - `release-cli.test.ts`: a `describe('server-deploy (releaseDeployCommand)', …)`
    block asserting `await releaseDeployCommand({ strategy: 'blue-green', dryRun: true, … }, fakeHost)`
    returns exit code `0` **and** that captured stdout contains
    `Dry run complete` and does **not** contain `Deploy complete.` — exit code
    alone would pass against the "Deploy complete." regression this spec's own
    change would otherwise introduce (see Solution), so the assertion has to be
    on the printed text, not just the return value. `releaseDeployCommand`
    returns `Promise<number>` (the process exit code), not `{ ok }` — assert on
    the number — against a fake host with zero staged releases / zero restarts.
    This needs Phase 1's new `host?: ReleaseDeployHost` parameter on
    `releaseDeployCommand`: without it the function always builds
    `defaultHost(console.log)` internally and there is no seam for a fake host,
    `env`, or `log`. `recorder()`/`migratedBox()` in `release-deploy.test.ts` are
    local, unexported helpers — either export them or write an equivalent
    minimal fixture local to `release-cli.test.ts`.
  - `release-cli.test.ts` or a new case in `release-deploy.test.ts`: rollback
    dry-run — assert `runReleaseDeploy({ ...box, rollbackTo: '<id>', dryRun: true }, rec.host)`
    (the field is `rollbackTo` per `ReleaseDeployOptions:65`, not `rollback`)
    returns `ok: true` with the ledger's `current` unchanged and `rec.restarts === 0`
    (this is the regression test for Phase 2's gap — write it to fail against
    today's code before Phase 2 lands, to prove it would have caught the bug).
  - A CLI-wiring test, following `runs-cli-wiring.test.ts`'s pattern (spawn the
    real `index.ts` entry via `execFile` in a temp `CEZ_HOME`, assert on
    stdout/stderr) asserting `cezar server-deploy --strategy=blue-green --dry-run`
    does **not** produce `Unknown option` and exits 0 — this is the only way to
    prove the `parseArgs` registration itself is correct, since a unit test on
    `releaseDeployCommand` never touches `parseArgs`.
  - A `--help` assertion (existing pattern) scoped to the `server-deploy` block
    specifically, not a bare substring check — `HELP` already contains
    `[--dry-run]` under `cezar runs reopen` (`index.ts:69`), so
    `expect(help).toContain('--dry-run')` passes against today's unmodified
    code and proves nothing. Slice `HELP` between the `cezar server-deploy`
    line and the next command block (`cezar server-migrate-releases`) and
    assert on that substring instead, so the test fails until Phase 1's
    help-text edit actually lands.

## Risks

- **Widening `CEZ_DRY_RUN`'s reach is a behavior change**, even though it's the
  correct fix: today `CEZ_DRY_RUN=1 cezar server-deploy --strategy=blue-green`
  silently does a real deploy; after this spec it previews one. Anyone who
  (incorrectly) relied on the env var being a no-op on that path — unlikely,
  since it would mean relying on a documented compatibility var doing nothing —
  sees different behavior. No known caller does this (brief's duplicate-work
  check found no e2e or harness setting `CEZ_DRY_RUN` against `server-deploy`
  at all, blue-green or restart). This is a **Phase 1 deliverable, not just a
  suggestion**: add `--dry-run` to the `Flags:` list
  (`BACKWARD_COMPATIBILITY.md:12`) and a note on the `Env vars:` `CEZ_DRY_RUN`
  entry (`:14`) that its reach now also covers the blue-green/rollback path —
  both additive per the doc's own general rule, so neither needs the
  deprecation path.
- **Phase 2 (the moved short-circuit) is new logic on a path with standing
  push/deploy authorization** (this repo's `AGENTS.md` — commit/push/deploy are
  pre-authorized). Three failure modes to watch for in review: (a) missing one
  of the three old guards when deleting them, leaving a dead
  `if (options.dryRun)` branch that can never be reached but also can't cause
  harm — a lint/dead-code smell, not a correctness bug; (b) placing the new
  check *after* `decision.reExec` is acted on instead of right after
  `decideReExec` logs its reason, which would silently reintroduce the
  rollback and re-exec gaps this phase exists to close; (c) placing it *ahead*
  of `decideReExec` entirely — this spec's own first draft made exactly this
  mistake — which drops the `deploy: <reason>` line from every dry-run preview
  without failing any test that only checks the exit code (see Solution).
  Mitigate with the explicit regression tests in Phase 4 (rollback dry-run,
  the faked-`reExec: true` case in Verification step 1, and an assertion that
  the `deploy: <reason>` line is present) that fail against today's code and
  would fail again if the check moved to the wrong side of `decideReExec`.
- **`--strategy=blue-green` printing a plan by default**, the task's own
  "consider whether" aside: explicitly out of scope. No record (brief's search
  of specs/KB/PRs/issues) prescribes it, it's a bigger behavior change to a
  live, standingly-authorized command than an opt-in flag, and the acceptance
  criteria don't ask for it. Not addressed by this spec.
- **`parseArgs` boolean-flag precedent is clean** — the brief notes
  `--rollback[=<id>]`'s bare-flag defect (`type: 'string'` with an optional
  value breaks under Node's `parseArgs`, workaround `--rollback=`, tracked as
  todo `f97ddd39`) as a cautionary precedent, but `--dry-run` is a plain
  `type: 'boolean'`, the same shape as `--follow`/`--reinstall`/`--yes`, which
  don't have that failure mode. No new defect expected here.
- **A bare `--dry-run` is accepted, and silently no-op'd, by every other
  command** once it's registered in the shared `parseArgs` options block —
  `cezar run "task" --dry-run` or `cezar serve --dry-run` parse fine and change
  nothing. `CEZ_DRY_RUN=1` already means something different and real for
  `cezar run` (it swaps in `scripts/mock-claude.mjs`), so a same-named flag
  that does nothing on that command is an easy thing to trip on — the same
  "flag looks meaningful, isn't" trap Phases 2 and 3 close, one command over.
  This matches the existing pattern for other command-scoped flags in the same
  shared block (`--follow`, `--strategy`, `--rollback` are all meaningful on
  some subcommands and silently ignored on others), so it's a deliberate,
  known tradeoff rather than an oversight — out of scope for this spec.

## Verification

1. `cezar server-deploy --strategy=blue-green --dry-run` against a migrated
   fixture box: prints the `deploy: <reason>` line, then the "DRY RUN — would
   stage…" plan line, then `Dry run complete — nothing was staged, flipped or
   restarted.` (not `Deploy complete.`), exits 0, stages nothing, flips
   nothing, restarts nothing — **both** when run normally and when run inside
   a cgroup that would otherwise trigger the P2 re-exec (the gap found in
   review): a unit test can fake `cgroup()`/`killMode()` to force
   `decideReExec`'s `reExec: true` branch and assert the `deploy: <reason>`
   line, the plan line, and the dry-run success line all still print, with no
   `detachedUnit` in the result. (Acceptance criterion 1 — covered by Phase 4's
   `releaseDeployCommand` test, and manually against a real box if one is
   available for a real-runtime pass.)
2. `cezar server-deploy --strategy=blue-green --rollback= --dry-run` (or
   `--rollback=<id> --dry-run`) — **not** the bare `--rollback --dry-run`
   spelling, which throws `Option '--rollback' argument is ambiguous` (and
   `--dry-run --rollback` throws `argument missing`), both measured against
   `parseArgs`'s current `{ type: 'string' }` registration for `--rollback`;
   see the pre-existing bare-flag defect (todo `f97ddd39`) noted above. Prints
   an equivalent rollback-plan line, then `Dry run complete` (not
   `Deploy complete.`), exits 0, symlink unchanged, zero restarts. (Regression
   test for gap 3 / Phase 2, and for the success-tail bug / Phase 1.)
3. `CEZ_DRY_RUN=1 cezar server-deploy --strategy=blue-green` (no `--dry-run`
   flag): same as (1) — proves the OR, and proves the env var now actually
   reaches this path, which it does not today. (Acceptance criterion 2.)
4. `cezar server-deploy --strategy=restart --dry-run` and
   `CEZ_DRY_RUN=1 cezar server-deploy` (default strategy): both preview only,
   via the existing `engine.ts` dry-run plumbing now also fed by the flag.
   (Phase 3 coverage; not named by the acceptance criteria but same flag,
   same command.)
5. `cezar --help` output contains a `--dry-run` line under the
   `cezar server-deploy` block. (Acceptance criterion 3 — covered by Phase 4's
   help-text assertion.)
6. `npm run test:package` (or the equivalent `./tools/test` target covering
   `packages/cezar`) green, including the new Phase 4 tests and the existing
   `release-deploy.test.ts:198-205` ("a dry run changes nothing") still passing
   unchanged.
7. Existing `CEZ_DRY_RUN` consumers unaffected: `test/e2e/package-cli.test.ts`
   (exercises `cezar run`, not `server-deploy` — unaffected by construction),
   `auto-name.ts`, `mock-claude.mjs` — none of these are touched by this spec's
   diff; a full-repo grep for `CEZ_DRY_RUN` after the change should show exactly
   the same call sites plus the two new/widened reads in `index.ts` (`:1100`
   widened, one new read in `case 'server-deploy'`).

## Sources read

- `.ai/specs/briefs/2026-08-22-server-deploy-dry-run-flag.md` — this step's input brief.
- `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` — introduced
  `--strategy=blue-green`/`--rollback`/`--follow`; CLI contract at `:624-625`;
  `--rollback` bare-flag defect at `:169-171,114-116`; status "QA Needed,
  reopened" 2026-08-21 for an unrelated criterion (cutover survival), not
  touched here.
- `packages/cezar/src/index.ts` — `parseArgs` options block (`:249-281`),
  `case 'server-deploy'` dispatch (`:347-375`), the `server-install`/`server-deploy`/
  `server-uninstall` call sites into `serverCommand` (`:336-344`, `:370-373`,
  `:392-395`), `serverCommand`'s own signature and `flags` parameter type
  (`:1013`, `:1017-1027`), `CEZ_DRY_RUN` read (`:1100`), `HELP` template
  (`:60-135`), early-dispatch guards for `run stats`/`runs`/`run-broker`
  (`:195-247`, confirms no collision with the new flag). Re-verified during
  revision that `values` is a local of `main()`, not reachable from inside
  `serverCommand` — a first draft of this spec assumed it was.
- `packages/cezar/src/server-install/release-cli.ts` — `ReleaseDeployCliOptions`
  (`:31-44`), `releaseDeployCommand` (`:46-90`), confirmed it calls
  `runReleaseDeploy(options)` with no host argument and returns `Promise<number>`
  (an exit code), not `{ ok }`.
- `packages/cezar/src/server-install/release-deploy.ts` — `runReleaseDeploy`,
  full read of the re-exec short-circuit, symlink guard, rollback branch, and
  forward-deploy dry-run print (`:295-405`); `ReleaseDeployOptions` (`:55-74`,
  confirms the rollback field is `rollbackTo`, not `rollback`).
- `packages/cezar/src/server-install/deploy-strategy.ts` — `runRollback`
  (`:203-217`), confirms it always restarts.
- `packages/cezar/src/server-install/self-safe-deploy.ts` — `decideReExec`
  (`:84-124`), read during revision to confirm what triggers the P2 re-exec
  branch (a cgroup match plus `KillMode !== 'process'`) and that a dry run
  reaching it today prints no plan.
- `packages/cezar/src/server-install/release-deploy.test.ts` — existing dry-run
  unit test (`:198-205`) and its fixtures (`migratedBox`, `recorder`).
- `packages/cezar/src/server-install/release-cli.test.ts` — confirms it only
  covers `migrateReleasesCommand`, not `releaseDeployCommand` (zero existing
  CLI-level dry-run coverage).
- `packages/cezar/src/runs-cli-wiring.test.ts` — pattern followed for the new
  Phase 4 subprocess-level CLI wiring test.
- `BACKWARD_COMPATIBILITY.md` — `Flags:` list (`:12`) and `CEZ_DRY_RUN` listed as
  a compatibility-locked env var (`:14`).
- KB `notion-41a043347b70` (2026-08-21, rootless deploy provisioning) — confirms
  `server-deploy --strategy=blue-green` runs unprivileged via a scoped polkit
  rule; not directly relevant to this flag beyond confirming the dry-run
  short-circuit already sits before the `systemd-run` re-exec branch.
