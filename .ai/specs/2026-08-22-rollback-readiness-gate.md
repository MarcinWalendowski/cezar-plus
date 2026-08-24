# An explicit `--rollback` never probes readiness, so it reports success onto a dead release

**Status: IMPLEMENTED, QA Needed.** Implemented and gated green 2026-08-22 (commit `2f91de4b`,
merged to `origin/main` at `c31af208`) — `npm run typecheck`, `npm test` (server-install package,
389/389), `npm run build`, and `npm run test:unit` (44/44) all pass; the full-repo `npm test`'s 11
failures and `npm run test:package`'s e2e flake were independently confirmed pre-existing/host-load,
not caused by this diff. **What remains before this is Done, not QA Needed:** Verification §5, the
real `systemd --user` rollback-onto-a-dead-release E2E on a scratch install, has not been run yet —
gates green proves the unit behavior, not that a real rollback on `prod-host` now fails closed.
Written against `HEAD` of `cez/f28edef5`
(`2778fd52`). The defect is todo `6497f002`, filed by the 2026-08-21 acceptance run of
`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (that spec, lines 110-117 and
167-176) and now fixed in code (§5's runtime E2E still pending — see above). Step 1 of this run left
`.ai/specs/briefs/2026-08-22-rollback-readiness-gate.md`; every file and line it cites was
re-opened for this document, and where the brief and the code disagreed the code won (noted
inline).

### Where the fix actually landed (read this before trusting a line number below)

**Added 2026-08-22 by a retry run of this same task** (`f28edef5`, dispatched with "there is no
prior work to build on"; that instruction was written for the earlier codex/`sonnet`-alias HTTP-400
run described in `.ai/specs/2026-08-22-failed-turn-reads-as-done.md`, which produced zero commits,
and it is **not** true of this worktree). The retry re-read the code rather than the record and
confirms: this spec is implemented, at `HEAD` = `0b21e625`, with `2f91de4b` and `190cf588` both
verified ancestors (`git merge-base --is-ancestor` → exit 0).

**Every line citation in the sections below is anchored to the PRE-FIX tree (`2778fd52`) and is
correct only as a description of the defect.** The fix moved all of them. Anchors re-measured at
`0b21e625`:

| What | Pre-fix (`2778fd52`) | Landed (`0b21e625`) |
| --- | --- | --- |
| `runRollback` | `deploy-strategy.ts:203-218` (16 lines) | `deploy-strategy.ts:214-319` (106 lines) |
| `runGatedDeploy` | `:130-201` | `:126-211` (`deploy.drained` emit now `:209`) |
| `DeployEvent` | `:44-57` | `:46-63` (`operation` `:60`, `ready` `:62`); `ProbeResult` follows at `:65-68` |
| `DeployEffects` | `:65-84` | `:71-98` |
| `DeployOutcome` | `:94-102` | `:100-111` (`operation` `:108`, `serving` `:110`) |
| `ReleaseDeployHost.waitReady` (P1 step 1) | did not exist | `release-deploy.ts:121`, impl `:178` |
| rollback wiring | `release-deploy.ts:366-372` | `:388-394` (`probeReady: () => fx.waitReady(port, 30_000)` at `:391`) |
| CLI rollback branch | did not exist | `release-cli.ts:86-106`; success line `:122-123`; `Deploy complete.` now the `else` at `:125` |
| File lengths | 218 / 455 / 323 | 319 / 490 / 360 |

Tests landed as `deploy-strategy.test.ts:206` (`describe('explicit rollback readiness gate')`,
alongside the pre-existing `describe('explicit rollback')` at `:183`) and
`release-cli.test.ts:292` (`describe('releaseDeployCommand rollback')`). Note the landed describe
titles differ from the ones Verification §1 and §3 propose (`'explicit rollback — the readiness
gate'`, `'releaseDeployCommand — rollback'`); the coverage matches, the strings do not.

**P4 was not implemented**, as its phase recommends: `followDeploy`'s exit code is unchanged.
**Verification §5 and §6 have still not been run**, which is the whole of what stands between this
spec and Done; §4's gates were run and were green. Nothing in the retry's re-reading changed a
decision in this document, so no decision below is superseded.

---

## Status log — 2026-08-22: §7's record obligations closed; QA Needed is the true remaining state

§7 ("Record") asked for four things once the code landed. All four are now done:

1. **This spec's own status log** — this entry.
2. **The two stale-open notes in `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`**
   (its "Status log — 2026-08-21" section and the acceptance-run paragraph naming `6497f002`) were
   corrected in place with a `CORRECTED 2026-08-22` lead-in, original text kept below, citing
   `2f91de4b` / `c31af208` and this spec by path.
3. **`AGENTS.md:13`'s trailing trap sentence** was corrected the same way: the `--rollback=` argv
   trap (todo `f97ddd39`) is still true and unchanged; the "a rollback never probes readiness"
   half is marked `CORRECTED 2026-08-22` and points here.
4. **The durable decision was written to the corpus** via `CEZ_KB_WRITE_FILE` (project scope, path
   `cezar/rollback-readiness-gate`), citing `specs-594acc539b36` and superseding nothing — the
   `6497f002`-is-open notes it corrects are marked in place at their own locations (items 2–3
   above), not superseded wholesale.

Also done in this pass: the doc-only edits that anchored this spec's line citations to the LANDED
tree (commits `190cf588`, `73286864`) were pushed as `cez/f28edef5` and squash-merged to
`origin/main` as PR #2 (`331d5875`) — `origin/main` now carries both the code fix (`2f91de4b`, via
`c31af208`) and this document's landed-anchor table. Tracker: workspace todo `6497f002` (filed by
the 2026-08-21 acceptance run, `startedTaskId` = this task) is marked `status: done`, context
appended, in `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json` — the main checkout's store, not
this worktree's own (a git worktree resolves its own `.ai/cezar/todos.json` by git toplevel, which
is a different, task-scoped file; the tracker of record for a workspace todo is always the main
checkout's).

**What is still open, and why "QA Needed" — not "Done" — remains the accurate status:** Verification
§5 (a real `systemd --user` rollback-onto-a-dead-release E2E on a scratch install) and §6 (one real
rollback of the live service, success path) have not been run. Gates green proves the unit and
integration behavior; it does not prove a real rollback on `prod-host` now fails closed. That
runtime pass is separate work — record it as pending, do not round it up.

---

## TLDR

`runRollback` (`packages/cezar/src/server-install/deploy-strategy.ts:203-218`) flips the release
symlink, restarts the unit, emits `deploy.rollback`, and returns `{ ok: true }` **without ever
asking the restarted release whether it came up.** Its effects parameter deliberately omits
`probeReady` (`:205`), so it cannot. The CLI therefore prints `Deploy complete.` and exits 0 onto
a release that may be dead (`release-cli.ts:80-92`).

The normal deploy path has exactly the gate that is missing: probe `/api/v1/ready`, and on failure
mark the candidate unhealthy, flip back, restart, and return `ok:false` with detail
(`deploy-strategy.ts:162-190`). **The emergency path is the one path in the system with no health
gate** — which inverts the guarantee P5 was written to make ("recovering is not a more dangerous
operation than the thing that broke", `deploy-strategy.ts:113-115`).

This spec adds the gate to `runRollback`, makes the ledger tell the truth about what the probe
found, and makes the CLI say which of five things actually happened instead of one word. Three
independently shippable phases (P1 gate, P2 truthful reporting, P3 fail-closed restoration) plus
one optional phase (P4, the detached-mode exit code) that is beyond the acceptance criteria.

**Acceptance criteria this closes**

- **AC1** — `runRollback` probes `/api/v1/ready` after the restart and returns `ok:false` when the
  release does not come up. → **P1**.
- **AC2** — the failure is reported distinctly from a successful rollback. → **P2** (and P3 extends
  the distinct cases from two to five, the fifth being a restoration whose own restart failed).

---

## Problem

### What the code does today, read in execution order

`packages/cezar/src/server-install/deploy-strategy.ts:203-218`, verbatim structure:

```ts
export async function runRollback(
  request: { releasesDir: string; linkPath: string; to?: string },
  fx: Pick<DeployEffects, 'restart' | 'emit' | 'now'>,     // :205 — probeReady is NOT here
): Promise<DeployOutcome> {
  const ledger = loadLedger(request.releasesDir);
  const target = request.to ?? rollbackTarget(ledger);
  if (!target) { /* :209-211 the ONLY failure this function can report */ }
  flipSymlink(request.linkPath, releaseDir(request.releasesDir, target));   // :212
  const next = activate(ledger, target, fx.now());                          // :213
  saveLedger(request.releasesDir, next);                                    // :214
  await fx.restart();                                                       // :215
  fx.emit({ name: 'deploy.rollback', releaseId: target, strategy: 'blue-green', reason: 'manual rollback' });
  return { ok: true, releaseId: target, ledger: next, rolledBackTo: target };  // :217 — unconditional
}
```

Four consequences, each independently wrong:

1. **The verdict is fabricated.** `ok: true` at `:217` is not a measurement of anything; it is the
   absence of a thrown exception from `systemctl restart`.
2. **The ledger is fabricated too.** `healthy` is defined as "set by the post-flip readiness probe"
   (`2026-08-19-non-disruptive-cezar-self-deploy.md:560-580`). `runRollback` never calls
   `markHealthy` (`releases.ts:174-177`), so after a manual rollback the serving release carries
   whatever `healthy` it last had — possibly `true` from a deploy weeks ago, possibly nothing.
3. **The event is fabricated.** `deploy.rollback` is emitted at `:216` *before* anything is known,
   and `deploy.rollback` carries `failedAt` (`:56`) which is left unset — so a log reader cannot
   tell a rollback that worked from one that did not.
4. **The CLI's sentence can be false.** `release-cli.ts:82-83` prints
   `Rolled back to <id>; the previous release is serving.` whenever `outcome.rolledBackTo` is set.
   `runRollback` sets `rolledBackTo` unconditionally at `:217`. On the success path the CLI does not
   even get that far: `:89` prints `Deploy complete.` and returns 0.

### The gate that already exists, twelve lines up

`runGatedDeploy` (`deploy-strategy.ts:162-190`) does all of it:

```
const ready = await fx.probeReady();          // :163
if (!ready.ok) {
  ledger = markHealthy(ledger, id, false);    // :165 — the ledger records the verdict
  const target = previous && previous !== id ? previous : rollbackTarget(ledger);   // :166
  if (target) { flipSymlink; activate; saveLedger; await fx.restart(); }            // :167-171
  fx.emit({ name: 'deploy.rollback', failedAt: 'readiness', reason: ready.detail ?? … }); // :175-181
  return { ok: false, failedAt: 'readiness', rolledBackTo: target ?? undefined, detail: ready.detail };
}
```

and only then marks healthy, prunes, emits the terminal `deploy.drained`, and returns success
(`:192-199`). The capability is fully built and wired: `ReleaseDeployHost.probeReady(port)`
(`release-deploy.ts:120`) is implemented at `release-deploy.ts:258-274` as one five-second loopback
request to `/api/v1/ready` that preserves HTTP status, per-check body detail, and fetch-failure
detail. The deploy path injects it at `release-deploy.ts:394`. The rollback path, at
`release-deploy.ts:366-372`, passes only `restart`, `emit` and `now`.

So this is not a missing capability. It is one omitted argument, and a return value that asserts
what nobody measured.

### What was actually observed, stated precisely

The 2026-08-21 acceptance run on `prod-host` performed **five real cutovers, three of them
explicit `--rollback` flips** (`2026-08-19-non-disruptive-cezar-self-deploy.md:120-124`). All three
reported complete with no readiness check. **They happened to be healthy**, so the record proves the
missing check, not a dead-target outcome. Nobody has yet run a rollback onto a release that does not
come up; the Verification section below makes that the acceptance test.

Two traps from that same run, carried here so they are not re-derived:

- **`deploy.drained` is only a terminal event name** emitted at the end of a successful deploy
  (`deploy-strategy.ts:198`), **not** a drain step. `DeployEffects` (`:65-84`) has no drain effect.
  Do not read the rollback path's lack of a `deploy.drained` as a missing drain.
- **The rollback-skips-the-drain theory was refuted.** The first run's two connection refusals lined
  up with the two rollback restarts; a controlled re-run showed one rollback restart refused nothing
  and a plain restart refused nothing across 3790 fresh connections
  (`:142-166`). It is an intermittent client-side keep-alive race (todo `6c89af7c`), not a property
  of the rollback path. **This spec must not expand into drain mechanics.**

### An adjacent fail-closed defect found while reading (not in the brief)

`runRollback` flips the symlink at `:212` **before** `activate` at `:213`, and `activate` throws
`cannot activate unknown release <id>` for an id that is not in the ledger (`releases.ts:162-164`).
So `cezar server-deploy --rollback=<typo>` points `/opt/cezar` at a directory that does not exist
and *then* throws — leaving the install path dangling, which is the exact state P1 exists to make
impossible (`2026-08-19-non-disruptive-cezar-self-deploy.md:345-358`). P1 of this spec adds the
guard, because without it the new readiness probe would report "this release is not ready" for a
reason that has nothing to do with readiness.

---

## What the record already decided

Read before writing this, in the priority order the workspace rules require.

- **KB.** `cez kb search` over the corpus returns `specs-594acc539b36` —
  `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` — as the only entry that decides
  anything here. `/var/lib/cezar/loki-labs/notion-export/domains/cezar.md` carries production and
  shipping context but **no** separate rollback-readiness decision. Searches for `runRollback` and
  `6497f002` found the controlling spec and one unrelated brief. **There is no standalone corpus
  task or knowledge note for this defect**; the todo id in that spec is the whole record.
- **P1 decided that a rollback is an atomic symlink flip plus a restart, seconds, no rebuild**
  (`:345-358`). This spec does not change that.
- **P5 decided that a cutover is successful only after the real-port `/api/v1/ready` gate, and that
  a post-flip readiness failure fails closed** (`:502-518`, step 4 and step 5). It also decided that
  a rollback "is subject to exactly the same gapless machinery as the deploy". Adding the probe to
  `runRollback` **restores that decision rather than replacing it** — the current code is the
  deviation.
- **`/api/v1/ready` is the deep gate and is deliberately distinct from `/health`**: store loaded,
  project stores booted, workspace config readable, backends detected (`:627-635`). Probing
  `/health` instead would not answer the question.
- **Ledger `healthy` is defined as the readiness verdict** (`:560-580`). A manual rollback that
  reports success without a probe contradicts that definition.
- **Analytics for `deploy.rollback` already carry `reason` and `failedAt` (`smoke_boot` |
  `readiness`)** (`:786-795`, types at `deploy-strategy.ts:54-56`). The existing name and fields can
  express a failed manual rollback; what they cannot currently express is *which command* emitted
  the event and *whether the release now serving was proven*. P1 adds two additive fields for that.
- **Verification precedent.** The acceptance E2E ran a 10 rps `/api/v1/ready` poller across flip and
  auto-rollback (`:701-730`) using `packages/cezar/scripts/deploy-e2e-probe.mjs`, whose exit code is
  the verdict. Criterion (f) — "a build that boots and then fails readiness … the ledger's
  `previous` is restored" — is the deploy-path twin of the test this spec needs for rollback.
- **Git history.** `git log -- packages/cezar/src/server-install/deploy-strategy.ts` returns exactly
  one commit: `3f4e9c33` ("feat: the machinery for a deploy that does not kill what it is
  deploying"), which introduced `runGatedDeploy` and `runRollback` together. No later commit on this
  branch touched the rollback path. (The brief notes a `1343c7cd` that exists only on
  `cez/312fe333`, is not an ancestor of `HEAD`, and is therefore not precedent.)
- **Existing coverage, re-checked.** `deploy-strategy.test.ts:183-203` covers exactly two explicit
  rollback cases: a healthy flip/restart, and refusal when there is nothing to roll back to. Neither
  asserts a probe. `release-deploy.test.ts:181-196` pins healthy rollback, one restart, and no
  staging. **Correction to the brief:** `release-cli.test.ts` *does* exist (210 lines) but covers
  only `server-migrate-releases`, `socketUnitName` and `unexpectedEntries` — the brief's substantive
  point stands, there is **no test of `releaseDeployCommand`'s wording or exit codes at all**.

---

## Solution

Four decisions, each answering one of the brief's open questions.

### D1 — the gate itself: probe after the restart, and let the probe decide the return value

`runRollback` takes `probeReady` in its effects, calls it after `fx.restart()`, writes the verdict
into the ledger with `markHealthy`, and returns `ok:false` with `failedAt: 'readiness'` and the
probe's detail when it fails. This is a straight transplant of `deploy-strategy.ts:163-190`'s first
five lines, and closes **AC1**.

`rolledBackTo` is **redefined for this path as "a release proven to be serving"** and is set only
after a passing probe. That single change removes the CLI's ability to print
`the previous release is serving` about a release nobody probed (`release-cli.ts:82-83`).

### D2 — the probe waits, because a rollback has no smoke boot to have warmed it (brief Q6)

The deploy path's post-restart gate is **one** `probeReady` with a 5 s timeout
(`release-deploy.ts:262`, wired at `:394`), and that is correct *there*: the candidate already
proved it boots, because the smoke boot at `deploy-strategy.ts:131` gave it a 30 s
`waitForReady` window (`release-deploy.ts:245`) before anything was flipped. A rollback **has no
smoke-boot stage at all** — nothing has ever booted this release in this process's lifetime — so a
single 5 s window converts an ordinary slow boot into a reported failure, and (under D4) into a
second flip.

So the rollback gate uses a **bounded wait**: retry `probeReady` every 250 ms until ready, up to
30 s. That is the existing private `waitForReady` (`release-deploy.ts:276-285`), which is exported
and exposed on `ReleaseDeployHost` as `waitReady(port, timeoutMs)`. A healthy release answers the
first attempt, so the fast path is byte-for-byte the current behaviour; only the failure path costs
30 s, and 30 s to avoid a false emergency verdict is the right trade.

Measured support for the numbers: the acceptance run's worst-case client-visible latency across a
cutover was 1097 / 1106 / 1164 ms (p50 3 ms) with socket activation queueing connections in the
backlog (`2026-08-19-non-disruptive-cezar-self-deploy.md:142-166`). 30 s is ~25× the observed
worst case and matches the smoke boot's existing budget.

**The deploy path is deliberately left on its single probe.** Changing it is a behaviour change to
a path that is working and measured; it is filed as a deferred item below.

### D3 — the ledger records what the probe found (brief Q3)

On failure the target is marked `healthy: false`; on success, `true`. Same call, same meaning, same
place in the sequence as `deploy-strategy.ts:165` and `:192`. This is what makes the ledger's own
definition (`:560-580`) true for this path, and it is what lets an operator run `cezar server-deploy
--rollback=` twice without re-learning the same failure by hand.

`rollbackTarget` (`releases.ts:179-184`) is **not** changed to skip unhealthy releases — that helper
is shared with the deploy path's auto-rollback and changing its selection rule is a separate
decision. The residual is named in Risks.

### D4 — fail closed: one bounded restoration attempt, itself probed (brief Q1 and Q2)

The task's acceptance criteria require only `ok:false`. The architecture argues for more: every
other failure branch in this file puts the box back (`deploy-strategy.ts:142`, `:167-171`), and P5
calls post-flip readiness failure fail-closed (`:502-518`). But restoration here is not the same
move as in the deploy path, because **the release we would restore is the one the operator just
chose to leave.** So:

> On a failed rollback probe, restore the release that was `current` when the rollback started —
> **at most once**, and **only if** it is a different release and its ledger row is not already
> `healthy: false`. Probe the restored release too, and report which of the terminal states holds.

- Restoring is *valuable* when the operator rolled back pre-emptively off a working release and the
  older one turns out not to boot (a forward-migrated state file, a missing dependency): the box
  comes back.
- Restoring is *pointless but harmless* when the operator rolled back because the current release
  was already dead: both probes fail, the operator is told plainly that nothing is serving. One
  extra restart, no loop.
- Restoring is *refused* when the ledger already says the pre-rollback release is `healthy: false`
  — that is the case where we would knowingly flip back onto a proven-dead release.

**The restoration is probed** (brief Q2). Restoring and then reporting an unverified restoration
would recreate this exact defect one level down; the whole point of the spec is that this code stops
asserting states it did not measure. The three terminal states are distinct in the result and in the
CLI output.

**At most one restoration attempt, ever.** No loop, no retry across releases, no walking the ledger
looking for something that boots — that is a different feature and it belongs to an operator, not to
an emergency command.

### What is deliberately NOT changed

- No drain work of any kind (see the refutation above).
- No change to `rollbackTarget`'s selection rule.
- No change to the deploy path's own restore-then-don't-probe behaviour (deferred; see Out of scope).
- No new CLI flag. `--rollback[=<id>]` keeps its argv shape, including the pre-existing bare-flag
  defect `f97ddd39` (`index.ts:269` declares `rollback: { type: 'string' }`, so bare `--rollback`
  dies in `parseArgs`; use `--rollback=`). Fixing that is a separate todo.

---

## Architecture

The seam is unchanged: `runRollback` stays a pure state machine over injected effects, and every new
branch is reachable in a unit test without a box, a systemd, or a real restart
(`deploy-strategy.ts:25-28`).

```
cezar server-deploy --rollback[=<id>]
  │
  ├─ index.ts:352-360 ─────────► releaseDeployCommand (release-cli.ts:48)
  │                                   │
  │                                   ├─ runReleaseDeploy (release-deploy.ts:295)
  │                                   │     ├─ decideReExec ── detach into a transient unit? (:313-350)
  │                                   │     └─ rollback branch (:366-372)
  │                                   │           wires { restart, emit, now, probeReady }
  │                                   │                                    ▲ NEW: fx.waitReady(port, 30_000)
  │                                   │           └─► runRollback (deploy-strategy.ts:202)
  │                                   │                 1. resolve target ── guard: known + on disk   [NEW]
  │                                   │                 2. flipSymlink + activate + saveLedger
  │                                   │                 3. restart
  │                                   │                 4. probeReady  ◄── THE GATE                   [NEW]
  │                                   │                 5. markHealthy(target, ready.ok)              [NEW]
  │                                   │                 6. ready?  ── yes ─► emit(ready:true)  ok:true
  │                                   │                            └─ no ──► restore?              [NEW/P3]
  │                                   │                                        ├─ no  ─► ok:false, serving={target,false}
  │                                   │                                        └─ yes ─► flip+restart+probe
  │                                   │                                                  ok:false, serving={before,±}
  │                                   └─ prints one of FOUR outcomes, exit 0 only for the proven one  [NEW/P2]
```

Ordering is load-bearing and matches the deploy path exactly: **flip → restart → probe**, never
probe-then-flip. The probe must hit the release that is actually serving through the symlink.

---

## Data models and API contracts

No new files, no ledger schema version bump, no HTTP route change. Four additive type changes, all
in `packages/cezar/src/server-install/`.

### `DeployEvent` (`deploy-strategy.ts:44-57`) — two additive fields

```ts
export interface DeployEvent {
  // … unchanged …
  /** `deploy.rollback` only. */
  reason?: string;
  failedAt?: 'smoke_boot' | 'readiness';
  /** Which command produced this event: an operator's `--rollback`, or a deploy's own machinery. */
  operation?: 'deploy' | 'rollback';                                    // NEW
  /** `deploy.rollback` only — whether the release named here was PROVEN ready by a probe. */
  ready?: boolean;                                                      // NEW
}
```

`DeployEventName` (`:36-42`) is **not** widened: keeping the single `deploy.rollback` name means
every existing log-grep and dashboard still finds every rollback, and `operation` + `ready` split
the three cases apart. Emission contract for an explicit rollback:

| case | events emitted, in order |
| --- | --- |
| target ready | `deploy.rollback` `{releaseId: target, operation:'rollback', ready:true, reason:'manual rollback'}` |
| target not ready, no restoration | `deploy.rollback` `{releaseId: target, operation:'rollback', ready:false, failedAt:'readiness', reason:<probe detail>}` |
| target not ready, restoration attempted | the failed event above, **then** `deploy.rollback` `{releaseId: restored, operation:'rollback', ready:<probe result>, reason:'restored after a failed manual rollback'}` |

The event is emitted **after** the probe, not before it as today (`:216`) — an event emitted before
the measurement can only report what was attempted. `runGatedDeploy`'s emissions gain
`operation:'deploy'` and are otherwise untouched. `DeployEvent.strategy` stays **required** (`:49`)
and is omitted from the table above only for brevity: every emission in this spec keeps passing
`strategy: 'blue-green'`, exactly as `runRollback` does today (`:216`).

### `DeployOutcome` (`deploy-strategy.ts:94-102`) — two additive fields

```ts
export interface DeployOutcome {
  ok: boolean;
  releaseId: string;        // the release the operation was ABOUT (the rollback target)
  ledger: ReleaseLedger;
  failedAt?: 'smoke_boot' | 'readiness';
  /** Set ONLY for a release proven to be serving by a passing probe. */
  rolledBackTo?: string;                                                // MEANING NARROWED
  detail?: string;
  operation?: 'deploy' | 'rollback';                                    // NEW
  /**
   * What the symlink points at when this returned, and whether a probe PROVED it.
   * Populated by `runRollback` only. `undefined` means NOT ESTABLISHED — never read it as "fine".
   */
  serving?: { releaseId: string; ready: boolean; detail?: string };     // NEW (P3)
}
```

The terminal shapes of an explicit rollback — every one of them distinct, and every one reachable:

| terminal state | `ok` | `failedAt` | `rolledBackTo` | `serving` | exit |
| --- | --- | --- | --- | --- | --- |
| rolled back, proven ready | `true` | – | target | `{target, true}` | 0 |
| target not ready, nothing to restore (or restore refused) | `false` | `readiness` | – | `{target, false, detail}` | 1 |
| target not ready, pre-rollback release restored and ready | `false` | `readiness` | restored | `{restored, true}` | 1 |
| target not ready, restored release not ready either | `false` | `readiness` | – | `{restored, false, detail}` | 1 |
| target not ready, **the restoration's own restart threw** (P3 step 3a) | `false` | `readiness` | – | `{target, false, detail incl. the error}` | 1 |
| no rollback target at all (`:209-211`, unchanged) | `false` | – | – | – | 1 |
| requested release unknown / missing on disk (**new guard**) | `false` | – | – | – | 1 |

### `ReleaseDeployHost` (`release-deploy.ts:116-128`) — one additive method

```ts
export interface ReleaseDeployHost {
  // … unchanged …
  probeReady(port: number): Promise<ProbeResult>;
  /** Retry `probeReady` until it passes or `timeoutMs` elapses. Backs the rollback gate (D2). */
  waitReady(port: number, timeoutMs: number): Promise<ProbeResult>;     // NEW
}
```

Implemented in `defaultHost` by the existing `waitForReady` (`release-deploy.ts:276-285`), which is
exported rather than reimplemented. Every test recorder gains a default
(`release-deploy.test.ts:39-66` `recorder()`), so existing cases keep their behaviour.

### `runRollback`'s effects (`deploy-strategy.ts:205`)

```ts
fx: Pick<DeployEffects, 'restart' | 'emit' | 'now' | 'probeReady'>,
```

`DeployEffects` itself is unchanged; only the `Pick` widens. The existing test harness
(`deploy-strategy.test.ts:29-48`) already supplies `probeReady`, so no existing case needs editing
to compile.

### CLI contract (landed: rollback branch `release-cli.ts:86-106`, success `:122-123`)

`releaseDeployCommand` gains an **optional second parameter** `host?: ReleaseDeployHost`, passed
straight through to `runReleaseDeploy(options, host)`. Production never passes it; it is the test
seam this file currently has no equivalent of, matching the seams already used in this repo
(`unexpectedEntries`'s `read` at `release-cli.ts:254`, `runReleaseDeploy`'s `host` at
`release-deploy.ts:297`). Without it the CLI's wording is untestable, because `defaultHost` would
run a real `systemctl restart`.

Output contract (exact strings are the assertion; `<detail>` is the probe's own text):

```
success (exit 0)                                                   [release-cli.ts:123]
  Rolled back to <id>: /api/v1/ready passed.
  <describeReleases lines, as today>

failure, nothing restored (exit 1)                                 [:96-97]
  Rollback FAILED: <id> did not become ready: <detail>
  <linkPath> still points at <id>, and it is NOT serving.
  Pick another release: cezar server-deploy --rollback=<other-id>

failure, pre-rollback release restored and proven ready (exit 1)   [P3, :100]
  Rollback FAILED: <id> did not become ready: <detail>
  Restored <before>, which probed ready. The box is serving again, on the release you tried to leave.

failure, restored release not ready either (exit 1)                [P3, :102-103]
  Rollback FAILED: <id> did not become ready: <detail>
  Restored <before>; it is NOT ready either: <detail2>
  NOTHING is serving a proven release. Intervene by hand.

failure, the RESTORATION's own restart threw (exit 1)              [P3 step 3a, :94]
  Rollback FAILED: <id> did not become ready: <detail>
  Restored <before>, but the restart itself failed: <error>. NOTHING is serving a proven release.

failure, no rollback target / unknown release / missing on disk (exit 1)   [:108, generic path]
  Deploy failed: no previous release to roll back to
  Deploy failed: release <id> is not in the ledger
  Deploy failed: release <id> has no directory under <releasesDir>
  (no readiness sentence, because no flip and no probe ever happened)
```

The failure header at `:90` is shared by all four readiness cases; they differ only in the second
line. The last of them is a **real coupling between `runRollback`'s detail string and the CLI**: the
CLI recovers `<before>` and `<error>` by matching `/; restoring (.+) failed: (.+)$/` against
`serving.detail` (`release-cli.ts:92`), so `runRollback` must keep appending
`; restoring <before> failed: <error>` verbatim when the restoration's own restart throws. Change
one side and the operator silently gets the "still points at" wording for a box where the symlink
was in fact moved back.

`Deploy complete.` is never printed for a rollback, and `Deploy failed:` is never printed for a
*readiness* failure: those are the deploy path's words, and they are half of why this defect reads
as success. The landed branch is narrower than that, deliberately. `release-cli.ts:87` is entered
only when `failedAt === 'readiness'` **and** `outcome.serving` is set, so the two non-readiness
rollback failures the terminal-state table lists (no rollback target at all,
`deploy-strategy.ts:219-222`; unknown release or missing directory, the P1 guard at `:223-241`) fall
through to the generic `Deploy failed: <detail>` at `release-cli.ts:108` and exit 1 with no
readiness sentence. That is correct as shipped: nothing was flipped, nothing was restarted, and
there is no serving-state claim to make. If we later decide a rollback must never say the word
"Deploy" at all, that is a separate change to the generic branch, not a claim this contract may make
about the code as it stands. `Rolled back to <id>; the previous release is serving.` (`:110`) may
print only when `outcome.rolledBackTo` is set, which the readiness failure path no longer does.

---

## Phases

Each phase is independently shippable, is green on its own, and leaves the box better than it found
it. **P1+P2 are the acceptance criteria; P3 is the fail-closed decision; P4 is optional.**

### P1 — the readiness gate (closes AC1)

Files: `deploy-strategy.ts`, `release-deploy.ts`, `deploy-strategy.test.ts`,
`release-deploy.test.ts`.

1. Export `waitForReady` from `release-deploy.ts` and add `waitReady(port, timeoutMs)` to
   `ReleaseDeployHost` + `defaultHost` (D2).
2. Widen `runRollback`'s effects `Pick` to include `probeReady` (`:205`).
3. **Guard before the flip** (the adjacent defect): resolve the target, and return
   `{ ok:false, detail: 'release <id> is not in the ledger' }` — or `… has no directory under
   <releasesDir>` — *before* `flipSymlink`, so a typo cannot leave `/opt/cezar` dangling. Uses the
   ledger rows plus `existsSync(releaseDir(...))`.
4. After `await fx.restart()`: `const ready = await fx.probeReady()`, then
   `markHealthy(next, target, ready.ok)` + `saveLedger`.
5. Return `ok:false, operation:'rollback', failedAt:'readiness', detail: ready.detail` on failure,
   with `rolledBackTo` **unset**; return `ok:true, rolledBackTo: target` only on success. Add
   `operation` to `DeployOutcome`/`DeployEvent` and emit the event *after* the probe with
   `ready`/`failedAt`.
6. Wire it: `release-deploy.ts:366-372` passes `probeReady: () => fx.waitReady(port, 30_000)`.

Shipped alone, `cezar server-deploy --rollback=<dead>` exits **1** and prints
`Deploy failed: <detail>` (the existing generic wording, from `release-cli.ts:81` via
`release-deploy.ts:371`'s `error: outcome.detail`). The false
`the previous release is serving` line is already impossible, because `rolledBackTo` is no longer
set on failure.

### P2 — truthful, rollback-specific reporting (closes AC2)

Files: `release-cli.ts`, `release-cli.test.ts`.

1. Add the optional `host?: ReleaseDeployHost` parameter to `releaseDeployCommand` and thread it
   into `runReleaseDeploy`.
2. Branch the result printing on `result.outcome?.operation === 'rollback'` (falling back to
   `opts.rollback !== undefined`, so a P2-only deploy against a P1-less build still reads right) and
   print the success / no-restoration strings from the contract above. Exit 1 on any failure.
3. Keep `describeReleases` on the success path (`:90`).

### P3 — fail closed: bounded restoration, itself probed (D4)

Files: `deploy-strategy.ts`, `deploy-strategy.test.ts`, `release-deploy.test.ts`, `release-cli.ts`,
`release-cli.test.ts`.

1. Capture `const before = ledger.current` **before** the flip.
2. On a failed probe, choose `restore = before && before !== target && row(before) exists &&
   row(before).healthy !== false ? before : null`.
3. When `restore` is set: `flipSymlink` → `activate` → `saveLedger` → `restart` → probe again →
   `markHealthy(restore, back.ok)` → `saveLedger` → emit the second `deploy.rollback`.
3a. **Wrap that whole restoration in `try` / `catch`, because the restart itself can throw.**
   `defaultHost.restart` throws `restart failed: <systemctl output>` on any non-zero exit
   (`release-deploy.ts:170-173`) and `runRollback` has no `try` at all today, so an unhandled throw
   here collapses the terminal states promised above into a stack trace that tells the operator
   the restart broke and never tells them the rollback target is dead. This is reachable rather than
   hypothetical: a release that fails readiness under `Restart=on-failure` is crash-looping, so the
   **second** restart inside a single rollback can hit systemd's start rate limit and exit non-zero.
   On a throw, return `ok:false`, `failedAt:'readiness'`, `rolledBackTo` **unset**, and
   `serving: { releaseId: target, ready: false, detail: '<probe detail>; restoring <before> failed:
   <error message>' }` — `target` because that is what the symlink and the ledger still name from the
   caller's point of view, the restoration's own flip having possibly not completed.
4. Populate `serving` on every return path of `runRollback` (including P1's two).
5. CLI: the three restoration strings (restored-and-ready, restored-but-dead, restart-failed).

### P4 — optional, beyond the acceptance criteria: a detached deploy's exit code

`followDeploy` (`release-cli.ts:95-110`) returns **0** as soon as the transient unit stops, whatever
happened inside it (`:109`). That is not rollback-specific — a failed *deploy* followed with
`--follow` also exits 0 — and on `prod-host` a rollback driven from inside `cezar.service`'s
cgroup does detach (`decideReExec` runs at `release-deploy.ts:314`, before the rollback branch at
`:366`). The log the follower prints will now carry the truthful `[deploy.rollback] {…"ready":false…}`
line, so the *reporting* criterion holds in that mode; the *exit code* does not.

**That mode is rarer than it sounds**, which is why the recommendation below is to defer it: an
agent task on this box runs in `cezar-runs.slice`, **not** in `cezar.service`'s cgroup (verified
2026-08-22 from `/proc/self/cgroup`), so `decideReExec` returns `reExec:false` and a rollback issued
from a task runs **inline** — where P1's exit code is already the truthful one. The detached path is
reached by a rollback issued from inside the server process itself.

Fix, if the reviewer wants it in this change: derive the exit code from the log's last terminal
event line (the `emit` at `release-deploy.ts:362-364` writes `[<name>] <json>` per line) — exit 0
iff that event is `deploy.drained`, or a `deploy.rollback` with `ready: true`; otherwise exit 1.

**Recommendation: file it as its own todo instead**, since it changes the exit code of every
detached deploy, not just rollbacks. Named here so this spec cannot be read as claiming distinct
failure reporting in every mode.

---

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | **False negative:** a healthy release boots slower than the probe window, so the gate reports failure and (P3) flips again. | D2's 30 s bounded wait, ~25× the measured 1.16 s worst case (`2026-08-19-…:142-166`); a healthy release passes on attempt 1. |
| 2 | **P3 restores onto a release the operator deliberately left.** | Gated on `healthy !== false`, at most one attempt, always probed, and the CLI says exactly that ("on the release you tried to leave"). |
| 3 | **After a P3 restoration, `activate` sets `previous` to the dead target** (`releases.ts:162-172`), so a later bare `--rollback=` re-selects it. | Bounded and now *loud*: the new gate catches it in ≤30 s and reports it; each invocation does at most two flips. Changing `rollbackTarget` to skip unhealthy rows is deferred (it is shared with the deploy path). |
| 4 | **Rollback is now slower on the failure path** (up to 30 s, or ~60 s with a probed restoration). | Only the failure path pays. A wrong "Deploy complete" costs an operator far more than 30 s. `gapMs` semantics are unchanged. |
| 5 | **A restart that never returns** leaves the probe unreached — `fx.restart()` has no timeout today and this spec adds none. | Pre-existing and identical in the deploy path; out of scope, named rather than silently inherited. |
| 5b | **A restart that FAILS** is a different and reachable case: `defaultHost.restart` throws on any non-zero `systemctl` (`release-deploy.ts:170-173`), and the second restart inside one rollback can hit systemd's start rate limit on a crash-looping release. | **Handled, not inherited** — P3 step 3a wraps the restoration in `try`/`catch` and returns its own terminal state with a distinct CLI line, so a failed restart still reports that nothing is proven serving. Only the restoration's restart is wrapped; a throw from the *first* restart still propagates, exactly as it does on the deploy path today. |
| 6 | **Widening `runRollback`'s effects `Pick` breaks external callers.** | Only two call sites exist (`release-deploy.ts:367`, `deploy-strategy.test.ts:190,199`); the test harness already supplies `probeReady`. `runRollback` is not exported from the package entry. |
| 7 | **The runtime E2E deliberately boots a broken release.** | It runs against a **scratch** releases dir, link path, unit and port — never the live service — and reuses `smokeBootRelease`'s full isolation env (`release-deploy.ts:208-237`): throwaway `CEZ_HOME` **and** `HOME`, `CEZ_SINGLE_PROJECT=1` with a throwaway working directory, and `LISTEN_FDS`/`LISTEN_PID` cleared so it cannot adopt the live socket. **`CEZ_HOME` alone is not sufficient** — it redirects identity state only (`auth/identity-store.ts`, `auth/local-identity.ts`), not the project registry (`index.ts:324`) or any project's `.ai/cezar/`; without the project-dir half the scratch server reaches the real stores, and `RunStore` is flushed wholesale, so it overwrites the live state. That is precisely the hazard `deploy-strategy.ts:68-74` names, and it names both halves. |
| 8 | **`serving` is populated by `runRollback` only**, so a reader could take `undefined` on a deploy outcome as "fine". | Documented on the field and in the table above; the CLI reads it only inside the rollback branch. |

---

## Verification

Planned up front, per the workspace rule. **Gates green is necessary and not sufficient: this ships
as QA Needed until steps 5 and 6 have actually been executed and their artifacts kept.**

### 1. Unit — `deploy-strategy.test.ts`, new `describe('explicit rollback — the readiness gate')`

The existing harness (`:29-48`) already provides `probeReady: async () => ({ ok: true })`, so these
are additions, not rewrites. The two existing cases (`:183-203`) must stay green unchanged.

- **order** — with an `order: string[]` recorder (the pattern at `:55-82`), assert exactly
  `['flip', 'restart', 'probe']`; a probe before the restart is the bug in a different costume.
- **AC1** — `probeReady: async () => ({ ok:false, detail:'/api/v1/ready answered 500' })` ⇒
  `ok === false`, `failedAt === 'readiness'`, `detail` passed through verbatim,
  `rolledBackTo === undefined`.
- **ledger truth** — after a failed probe, `loadLedger(...).releases.find(r => r.id === target)
  ?.healthy === false`; after a passing probe, `true`.
- **event** — on failure the last event matches
  `{ name:'deploy.rollback', operation:'rollback', ready:false, failedAt:'readiness' }`; on success
  `{ ready:true }`. Assert the event is emitted **after** the probe (recorder order).
- **guard** — `runRollback({ to:'no-such-release' })` ⇒ `ok:false`, `restart` **not** called, and
  `currentTarget(linkPath)` unchanged (i.e. the symlink was never flipped).
- **P3 restoration** — seed `r1` then `r2`, roll back to `r1` with a probe that fails on `r1` and
  passes on `r2`. `DeployEffects.probeReady()` takes **no arguments**, so the fake cannot be keyed on
  a release id: discriminate by call order (`let n = 0; probeReady: async () => (++n === 1 ? {ok:false,
  detail:'…'} : {ok:true})`), which is exact here because the order is fixed — first call probes the
  target, second probes the restoration. ⇒ `restart` called **twice**, probe called **twice**, `currentTarget` is `r2`,
  `serving` is `{ releaseId:'r2', ready:true }`, `ok:false`, two `deploy.rollback` events.
- **P3 refusal** — same, but `r2` is already `healthy:false` in the ledger ⇒ **one** restart, one
  probe, `currentTarget` stays `r1`, `serving.ready === false`.
- **P3 both dead** — probe fails for both ⇒ `ok:false`, `serving === { releaseId:'r2', ready:false,
  detail:… }`, `rolledBackTo === undefined`, exactly two restarts (never a third).
- **P3 restoration restart throws** (step 3a) — `restart` resolves on its first call and **rejects**
  on its second (`throw new Error('restart failed: job failed')`, the shape `defaultHost` produces)
  ⇒ `runRollback` resolves rather than rejecting — `await expect(...).resolves` and no exception
  escapes — with `ok === false`, `failedAt === 'readiness'`, `serving.ready === false`,
  `serving.detail` containing both the probe detail and `restart failed: job failed`, and
  `rolledBackTo === undefined`.

### 2. Integration — `release-deploy.test.ts`

Extend `recorder()` (`:39-66`) with a `probes` counter and a `waitReady` default. The counter must
increment in **`waitReady`** (or in both `waitReady` and `probeReady`): under P1's wiring the
rollback path goes through `host.waitReady`, not `host.probeReady`, so a counter on `probeReady`
alone would stay 0 and the assertion below would pin nothing.

- The existing `rolls back to the previous release on request, with one restart` case (`:181-196`)
  gains `expect(rec.probes).toBe(1)` — today it would be 0, which is the regression this pins.
- New: a rollback whose `waitReady` returns `{ok:false, detail:'boom'}` ⇒ `result.ok === false`,
  `result.error === 'boom'`, `result.outcome.failedAt === 'readiness'`, and `rec.staged` is still
  `[]` (a rollback rebuilds nothing).
- New (P3): the same with a healthy pre-rollback release ⇒ `rec.restarts === 2`,
  `loadLedger(...).current` is the restored id.

### 3. CLI wording and exit codes — `release-cli.test.ts`, new `describe('releaseDeployCommand — rollback')`

Uses the P2 `host` seam and `vi.spyOn(console, 'log'/'error')`.

- Success ⇒ return value `0`, output contains `Rolled back to`, and does **not** contain
  `Deploy complete.`.
- Failure ⇒ return value `1`, output contains `Rollback FAILED` and the probe detail, and
  **asserts the absence** of the string `the previous release is serving` — that literal absence is
  the AC2 regression test.
- P3 restored-and-ready ⇒ `1`, output names both releases and says the restored one probed ready.

### 4. Gates

```bash
npm run typecheck && npm test && npm run test:unit
```

Run from the repo root; all three must be green before commit (`AGENTS.md`: gates first, fail
closed). These are the gates `AGENTS.md:229-237` actually names, in that order. **There is no
`lint` script in this repo** — verified 2026-08-22: neither the root `package.json` nor
`packages/cezar/package.json` defines one (`grep '"lint"' package.json packages/*/package.json`
returns nothing), so `npm run lint` exits with `Missing script: lint` and an `&&` chain containing
it dies before the tests ever run. `npm run test:package` is unaffected by these files but must not
regress; it needs a completed `npm run build` first, because it packs and installs the release
tarball (`AGENTS.md:237`).

### 5. Runtime E2E on `prod-host` — a real rollback onto a release that does not come up

The acceptance criteria's real test, and the thing the 2026-08-21 run could not produce because all
three of its rollbacks were healthy. Run against a **scratch install**, never the live service.

Three constraints make the obvious `cezar server-deploy --rollback=…` invocation impossible on this
box. All three were measured on `prod-host` on 2026-08-22, and the recipe below works around
each one explicitly rather than pretending it does not exist:

- **The restart cannot be issued.** `defaultHost.restart` runs plain `systemctl restart <unit>`
  against the **system** manager (`release-deploy.ts:170-173`), which cannot see a `--user`
  transient unit at all (measured: `systemctl show -p LoadState cez-rb-test.service` →
  `LoadState=not-found`), and would refuse a system one anyway — the polkit grant covers
  `cezar.service` / `cezar.socket` only (`AGENTS.md:13`), and a system `systemd-run` needs root,
  which the `cezar` user is correctly denied. So the E2E drives the rollback through the **P2
  `host` seam** and substitutes exactly one method, `restart`, with a `systemctl --user restart`
  (uid 999; `XDG_RUNTIME_DIR=/run/user/999` and the matching `DBUS_SESSION_BUS_ADDRESS` are already
  set inside an agent task on this box). Everything else stays real: the real `probeReady` /
  `waitReady` over real HTTP against a real server, the real symlink flip, the real ledger writes,
  and the real CLI wording and exit code.
- **`cezar` on `PATH` runs the wrong binary.** It is `/usr/local/bin/cezar`, a wrapper that `exec`s
  `/usr/bin/node /opt/cezar/packages/cezar/dist/index.js` — the **deployed** release. Invoking it
  would exercise the *unfixed* code no matter how many times this worktree is rebuilt. The driver
  below runs this worktree's freshly built `dist` instead.
- **The scratch releases have to be able to boot.** This worktree has neither `node_modules` nor
  `packages/cezar/dist` (verified 2026-08-22), so a release rsynced straight from it never answers
  `/api/v1/ready` and the "failure" would prove nothing. Seed from a tree that has both: run
  `npm ci && npm run build` here first (step 0), or rsync from the main checkout
  `/var/lib/cezar/loki-labs/cezar`, which already has both, after building the fix there.

If a future operator wants a literal `cezar server-deploy --rollback=…` E2E instead, it has to run
as **root** with a **system** transient unit, and every artifact must be chowned back afterwards so
`find /var/lib/cezar -not -user cezar | wc -l` stays `0`. That variant is not what this spec asks
for.

```bash
# 0. a tree that can actually boot — `stage` is an rsync, not a build (AGENTS.md), and a rollback
#    stages nothing at all, so the bytes under test are whatever is on disk already.
cd /var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/f28edef5-ab80-42b8-929e-c92182c8a5ce
npm ci && npm run build        # creates node_modules + packages/cezar/dist HERE
B=$PWD

# 1. scratch box: two releases, one deliberately not-ready
T=$(mktemp -d /tmp/cez-rb-XXXX); R=$T/releases; L=$T/cezar
mkdir -p "$R/good" "$R/bad"
rsync -a --exclude .git --exclude .ai "$B/" "$R/good/"   # node_modules INCLUDED — it must boot
rsync -a "$R/good/" "$R/bad/"
# The `bad` release must fail readiness WHILE STAYING ALIVE. An empty `index.js` exits 0, and a
# transient `--user` unit is garbage-collected on a CLEAN exit regardless of `--collect` (measured
# 2026-08-22: two seconds after `systemd-run --user --unit=… --collect -p Restart=on-failure node -e
# 'process.exit(0)'`, `systemctl --user show -p LoadState` reports `LoadState=not-found` and
# `systemctl --user restart` fails with exit 5, "Unit … not found"). P3's restoration restart would
# then ALWAYS throw, collapsing the restoration case into the step-3a failed-restart case, and
# assertions (d)/(e) could never pass — for a reason with nothing to do with the code under test.
printf 'setInterval(() => {}, 1 << 30);\n' > "$R/bad/packages/cezar/dist/index.js"   # boots, stays up, never listens on 4399
ln -s "$R/good" "$L"
cat > "$R/deploy.json" <<'JSON'
{"schema":1,"current":"good","previous":null,"keep":5,
 "releases":[{"id":"good","builtAt":"2026-08-22T00:00:00.000Z","healthy":true},
             {"id":"bad","builtAt":"2026-08-22T00:00:01.000Z"}]}
JSON

# 2. a disposable USER unit serving through the scratch symlink, on a scratch port, isolated with
#    `smokeBootRelease`'s OWN env block (release-deploy.ts:208-237): LISTEN_FDS/LISTEN_PID cleared so
#    the scratch server cannot adopt the live socket; the auth trio because `runAuthBootGate` refuses
#    to boot on a hosted box that inherits half its auth config (measured 2026-08-21, same file); and
#    CEZ_SINGLE_PROJECT=1 + a throwaway cwd because CEZ_HOME alone is NOT isolation — it governs
#    identity state only (`<CEZ_HOME>/identity/*.json`, auth/identity-store.ts, auth/local-identity.ts)
#    and redirects neither the project registry (index.ts:324) nor any project's `.ai/cezar/`, so a
#    scratch server without it reaches the real stores and `RunStore`'s wholesale flush overwrites
#    the LIVE state — the exact overwrite `deploy-strategy.ts:68-74` forbids, and it would corrupt
#    this run's own state.
mkdir -p "$T/home" "$T/project"      # a throwaway CEZ_HOME **and** a throwaway project dir
systemd-run --user --unit=cez-rb-test --collect \
  --working-directory="$T/project" -p Restart=on-failure \
  --setenv=CEZ_HOME=$T/home --setenv=HOME=$T/home --setenv=CEZ_SINGLE_PROJECT=1 \
  --setenv=LISTEN_FDS= --setenv=LISTEN_PID= \
  --setenv=CEZ_REMOTE= --setenv=CEZ_AUTH= --setenv=CEZ_ALLOW_UNAUTHENTICATED=1 \
  /usr/bin/node "$L/packages/cezar/dist/index.js" serve --no-open --bind-host 127.0.0.1 --port 4399
for i in $(seq 60); do curl -fsS http://127.0.0.1:4399/api/v1/ready >/dev/null && break; sleep 1; done
curl -fsS http://127.0.0.1:4399/api/v1/ready >/dev/null || { echo "scratch server never came up"; exit 1; }

# 3. the driver: the REAL CLI entry point, with ONLY the privileged restart substituted
cat > "$T/drive.mjs" <<'JS'
import { spawnSync } from 'node:child_process';
const B = process.env.B;
const { releaseDeployCommand } = await import(`${B}/packages/cezar/dist/server-install/release-cli.js`);
const { defaultHost } = await import(`${B}/packages/cezar/dist/server-install/release-deploy.js`);
const log = (line) => console.log(line);
const host = {
  ...defaultHost(log),
  async restart() {
    const r = spawnSync('systemctl', ['--user', 'restart', 'cez-rb-test.service'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`restart failed: ${r.stderr || r.stdout}`);
  },
};
process.exit(await releaseDeployCommand({
  strategy: 'blue-green',
  rollback: process.argv[2],          // the '=' trap is argv parsing (todo f97ddd39); this bypasses it
  source: B, linkPath: process.env.L, releasesDir: process.env.R, port: 4399,
}, host));                            // the second argument is P2's seam
JS

# 4. the FAILING rollback, then the recovery rollback
B=$B L=$L R=$R node "$T/drive.mjs" bad  > "$T/fail.log" 2>&1; echo "EXIT=$?"
B=$B L=$L R=$R node "$T/drive.mjs" good > "$T/ok.log"   2>&1; echo "EXIT=$?"
```

Assertions:

- **(a)** the `bad` run exits **1**; before the fix it exits 0. This single number is the defect.
  **The "it exits 0" baseline must be measured with the same driver against a pre-change build**,
  never against `/usr/local/bin/cezar`, which runs the deployed release and would make the
  comparison meaningless. **`HEAD` is no longer that build**: the fix landed in `2f91de4b` and
  `190cf588`, both ancestors of `0b21e625`, so the baseline must name the pre-fix commit
  explicitly, or it will exit 1 and prove nothing:
  `git worktree add /tmp/cez-prefix 2778fd52 && cd /tmp/cez-prefix && npm ci && npm run build`
  (verified 2026-08-22: `runRollback` at that commit takes
  `Pick<DeployEffects, 'restart' | 'emit' | 'now'>`, with no `probeReady`), then run `drive.mjs`
  with `B=/tmp/cez-prefix`. The baseline run also needs its **own** freshly seeded scratch `$T`:
  releases dir, `deploy.json`, symlink and a separate `cez-rb-test` unit. The first `drive.mjs` run
  mutates `deploy.json` (`bad` gains `"healthy": false`) and moves the symlink, so a second run
  against the same scratch box is not a clean comparison.
- **(b)** `fail.log` contains `Rollback FAILED: bad did not become ready` and the probe's detail, and
  contains neither `Deploy complete.` nor `the previous release is serving`.
- **(c)** `$R/deploy.json` shows `bad` with `"healthy": false`.
- **(d)** P3 only: `fail.log` says `good` was restored and probed ready; `readlink $L` is
  `$R/good`; `/api/v1/ready` on :4399 answers 200 **after** the `bad` run, with no `good` run needed.
- **(e)** the `good` run exits **0** and prints `Rolled back to good: /api/v1/ready passed.`
- **(f)** the whole scratch tree is removed afterwards (`systemctl --user stop cez-rb-test`,
  `rm -rf $T`), and `find /var/lib/cezar -not -user cezar | wc -l` is still `0`.

Artifacts (`fail.log`, `ok.log`, the final `deploy.json`) are copied to
`.ai/cezar/tmp/f28edef5-…/rollback-e2e/` and their key lines quoted in the commit and in the status
log appended to this spec.

### 6. One real rollback of the live service — the success path only

The live cutover the operator will actually run. **Do not break the live service deliberately**;
step 5 already proves the failure path. **This step runs AFTER the deploy step, never before it** —
`cezar` here is `/usr/local/bin/cezar`, which `exec`s `/opt/cezar/packages/cezar/dist/index.js`, so
until the fix is deployed this measures the old code and would "pass" by printing the old wording.

1. Start the continuous client harness while a real run is in flight:
   `node packages/cezar/scripts/deploy-e2e-probe.mjs --base http://127.0.0.1:4321 --run <runId>
   --seconds 120 --out .ai/cezar/tmp/f28edef5-…/rollback-live.json`
2. `cezar server-deploy --rollback=<previous-id>` then `--rollback=<newest-id>` to return.
3. Assert: the probe script exits **0** (zero non-2xx, zero connect errors, `seq` continuous), both
   commands exit 0, both print the new `Rolled back to <id>: /api/v1/ready passed.` line, and
   `/opt/cezar-releases/deploy.json` now carries `"healthy": true` on both — a field a manual
   rollback never used to write.

### 7. Record

Same session as the code change: append a dated status log to this spec (implemented / commit /
what was measured), correct the two places in
`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` that record `6497f002` as open
(`:110-117`, `:167-176`) **in place** with a `FIXED <date> by <this spec>` lead-in leaving the
original text below, and correct `AGENTS.md:13`'s trailing trap sentence ("a rollback never probes
readiness, use `--rollback=`") — the `--rollback=` half stays true, the readiness half does not.
Write the durable decision (a rollback is health-gated, and `rolledBackTo` means *proven serving*)
into the corpus via `CEZ_KB_WRITE_FILE`, superseding nothing but citing `specs-594acc539b36`.

---

## Out of scope (decisions, not omissions)

- **Drain mechanics.** `deploy.drained` is a terminal event name, not a step; the
  rollback-skips-the-drain theory was refuted by controlled re-measurement
  (`2026-08-19-…:142-166`). The residual keep-alive race is todo `6c89af7c`.
- **Bare `--rollback` argv parsing** — todo `f97ddd39`, `index.ts:269`. This spec works around it by
  always writing `--rollback=`.
- **`rollbackTarget` skipping unhealthy releases** (`releases.ts:179-184`) — shared with the deploy
  path's auto-rollback; a separate decision. Risk 3.
- **The deploy path's own restoration is still unprobed** (`deploy-strategy.ts:167-171` flips back
  and restarts, then reports `rolledBackTo` without probing the restored release). It is the same
  species of defect as this one, one branch over. Deliberately not fixed here because it changes a
  measured, working path; **file it as a todo** when this lands, and note that the `serving` field
  added by P3 is the shape its fix would use.
- **A restart timeout** (Risk 5) — pre-existing on both paths.
- **P4's detached exit code** — recommended as its own todo; see the phase.

---

## Sources read

**Code** (worktree `f28edef5-ab80-42b8-929e-c92182c8a5ce`, `HEAD` = `2778fd52`):
`packages/cezar/src/server-install/deploy-strategy.ts` (whole file, 218 lines),
`release-deploy.ts:55-82,109-128,240-300,340-429`, `release-cli.ts` (whole file, 323 lines),
`releases.ts:140-200`, `index.ts:88-93,255-290,340-375`,
`deploy-strategy.test.ts:1-60,120-204`, `release-deploy.test.ts:1-70,120-200`,
`release-cli.test.ts` (structure: `describe`s at `:20,131,138` only),
`packages/cezar/scripts/deploy-e2e-probe.mjs:1-40`, root `package.json` scripts.

**Re-read 2026-08-22 by the retry run, at `HEAD` = `0b21e625`** (for the anchor table near the top,
which is the only thing that run changed in this document): `deploy-strategy.ts:195-319` (the landed
`runRollback` in full) plus its type blocks `:38-111`; `release-deploy.ts:116-128,169-180,204-290,
388-394`; `release-cli.ts:84-128`; `deploy-strategy.test.ts`, `release-cli.test.ts` and
`release-deploy.test.ts` (`describe` structure only); `git diff --stat 2778fd52 HEAD` per file
(`releases.ts` and the tests' pre-existing blocks unchanged; the three source files changed by
+108/-7, +26/-9, +51/-14). The retry did **not** re-run the gates: `git status` was clean and the
code was unchanged since the run that measured them green, so re-running would have re-measured the
same tree.

**Specs / KB:** `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (KB id
`specs-594acc539b36`) — lines 110-117, 120-176, 184-200, 338-358, 495-525, 559-590, 608-640,
695-730, 780-800; `AGENTS.md:7-13` and `AGENTS.md:229-237` (the Validation gate list, which is what
Verification § 4 now names); `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` and
`.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md` (format precedent only).

**History:** `git log -- packages/cezar/src/server-install/deploy-strategy.ts` → one commit,
`3f4e9c33`.

**Measured on `prod-host`, 2026-08-22** (for Verification § 4, § 5 and § 6, after the first
review found the earlier recipe unrunnable): no `lint` script in the root or `packages/cezar`
manifests; `/usr/local/bin/cezar` is a wrapper that `exec`s
`/usr/bin/node /opt/cezar/packages/cezar/dist/index.js`; this worktree has neither `node_modules`
nor `packages/cezar/dist`, while the main checkout `/var/lib/cezar/loki-labs/cezar` has both; an
agent task runs as uid 999 in `cezar-runs.slice` (not `cezar.service`'s cgroup) with
`XDG_RUNTIME_DIR=/run/user/999` set; `systemctl show -p LoadState cez-rb-test.service` reports
`not-found` for a `--user` transient unit.

**Brief:** `.ai/specs/briefs/2026-08-22-rollback-readiness-gate.md` (step 1 of this run).

**Not found, stated rather than invented:** no corpus knowledge note and no tracker row for
`6497f002` beyond the controlling spec's own mention (`cezar todo list` returns no todos for this
project); no existing test of `releaseDeployCommand`; no prior decision on whether a failed manual
rollback should restore — D4 decides it here for the first time.
