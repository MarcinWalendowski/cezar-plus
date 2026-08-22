# Brief — deploy-e2e-probe cannot measure the SSE half on an authenticated box (401)

Task id `3ee1ebf0-0d78-4cda-b50d-af6dff78910b`, step 1/8 ("Gather the record"). Gather-only:
no spec, no code changes here.

## The most important finding first: this exact work already has a reviewed, revised spec sitting uncommitted in a sibling worktree

**This task is a duplicate of task `e3851a57-b8ce-487e-b519-e0556d871799`**, which ran
`context → spec → review-spec → spec(revision)` against the identical defect and stopped
there (chain never reached implementation, nothing committed beyond the pre-existing
`4b629c13`/`a523c1ca`/`c73c8a2d` autosave commits already on `main`). Its artifacts, still on
disk and worth reading before writing a new spec:

- Brief: `.ai/cezar/worktrees/e3851a57-b8ce-487e-b519-e0556d871799/.ai/specs/briefs/2026-08-22-deploy-e2e-probe-vacuous-assertions.md`
- **Spec (reviewed once, revised once, status "SPEC ONLY"):**
  `.ai/cezar/worktrees/e3851a57-b8ce-487e-b519-e0556d871799/.ai/specs/2026-08-22-deploy-e2e-probe-measured-assertions.md`
  (33 899 bytes; uncommitted `git status` in that worktree shows only this file modified)
- Its handoff (`.ai/cezar/runs/e3851a57-b8ce-487e-b519-e0556d871799.handoff.md`) records the
  review verdict verbatim: **"revise: credential premise false … also verdict precedence must
  let 'failed' dominate 'not-measured'"**, followed by a revision pass that applied both fixes.

That spec already covers all four of this task's acceptance criteria (tri-state
`passed`/`failed`/`not-measured` assertions with per-assertion sample counts, loud-fail on
401/403 instead of silent accumulation into `sse.errors`, a `maxLatencyMs` alias for the
already-populated `gapMs` field, and a runbook fix for obtaining a credential) plus one thing
this task's own description gets wrong (see next section). **The open question for the next
step is whether to port/adopt that spec into this worktree (targeted edits, not a copy-paste,
since this worktree's `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` may have
diverged slightly — diff before adopting) rather than re-deriving it from scratch.**

## The task description's premise is half stale — a non-interactive credential already exists

This task's own text (and the parent spec, twice, at `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:9,73-74`)
says the SSE half is unmeasured because "the box holds no static token." **The sibling task's
spec disproves this with a live check on the box, 2026-08-22:** every minted session lands in
`<CEZ_HOME>/identity/identity.json` (`packages/cezar/src/auth/identity-store.ts:37`,
`SNAPSHOT_FILE`) under a `sessions` array, readable by the `cezar` unix uid — the same uid the
deploy and this probe already run as. On `prod-host` that file held 6 unexpired session
ids (`expiresAt` 2026-09-15…19); `curl -H "cookie: cez_session=$ID" http://127.0.0.1:4321/api/v1/events`
returned **200**, not 401. So fix option (2) in this task's description ("document obtaining a
session cookie / bootstrap token, or add a loopback-only probe token") **is already solved with
zero new server-side mechanism** — the probe's existing `--header` flag already accepts
`cookie: cez_session=<id>`; only the runbook needs to read the id and pass it. Option (1) (fail
non-vacuously) is the piece that is genuinely still unbuilt. Confirm this is still true on
`prod-host` before relying on it — it was a point-in-time check, not a permanent
guarantee, and a session can expire or be revoked.

## The problem, in this repo's own terms

`packages/cezar/scripts/deploy-e2e-probe.mjs` (253 lines, added whole in commit `954c6a55`
"feat: a run now outlives the cockpit that started it", 2026-08-21, never touched since) is the
acceptance-E2E harness named by `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` §
Verification. It measures assertions (a) run status / no-interrupted, (b) HTTP poll
failures/refusals, (c) SSE `seq` continuity. On `prod-host` (`CEZ_AUTH=oidc`, per
`.env.example:18`) every SSE/run-status request 401s because the probe sends no credential:

- `subscribe()` (`deploy-e2e-probe.mjs:98-134`): a non-2xx throws `events answered ${status}`
  (:106), caught (:129-131) into `sse.errors` and retried after 100 ms for the whole
  `--seconds` window — never distinguishes "never connected once" from "one transient blip."
- `sampleRun()` (:79-89) silently drops non-ok responses (`if (!response.ok) return;`, :83), so
  `runStatuses` (a `Set`) stays empty under 401 with no error recorded anywhere.
- `continuity(sse.seqs)` (:165-177) is correct in isolation but vacuous on empty input: an empty
  array has no gaps and no duplicates by construction.
- The assertions object (:199-211) computes `'c: no seq gaps': gaps.length === 0` (:204),
  `'c: no seq duplicates': duplicates.length === 0` (:205), `'a: run never left running':
  [...runStatuses].every(s => s === 'running')` (:209, vacuously `true` on `[]`), `'a: no
  interrupted event': !sawInterrupted` (:210, `sawInterrupted` only ever flips inside
  `handleFrame`, which never runs without a live SSE connection).
- `passed: Object.values(assertions).every(Boolean)` (:239) — no sample-size gate anywhere in
  the file (confirmed: no occurrence of `measured`/`sample`/`skip`/`minEvents`).
- `sse.errors` is truncated to 20 at report time (:235 area) with no uncapped counter, so a long
  `--seconds` run's true 401 count is invisible in the artifact.
- **`maxLatencyMs` is a naming gap, not a missing measurement.** The internal variable is
  `poll.maxLatencyMs` (declared :50, updated :65 from the `/api/v1/ready` poll's round-trip
  time), published under the key `gapMs` (:222-223). All five real artifacts have a real,
  non-null `gapMs` (1129, 1127, 62, 1136, 986 ms) — the task description's "`maxLatencyMs` came
  back null in every artifact" is true only in the sense that no field with that literal name
  exists to grep for.

**Consequence, measured across 5 real cutovers on `prod-host` (2026-08-21):** 3 of 5
artifacts (`deploy-e2e-agentdriven.json` included — the task description's "two of five"
undercounts by one) reported `passed: true` while `sse.events: 0`, `run.statuses: []`, and
20 (truncated) `"events answered 401"` entries sat in the same JSON.

## What the record already decided (citations)

- **Auth mechanism, confirmed by reading the server, not assumed** (per the sibling spec, which
  read the live code): `packages/cezar/src/server/server.ts:1841-1861` exempts exactly two
  routes from the principal middleware — `/api/v1/health` and `/api/v1/ready` (the latter's
  exemption comment cites this same parent spec by name: "probed from the BOX, over loopback, by
  a deploy that has no session"). Every other `/api/*` route — including `/api/v1/runs/:id` and
  `/api/v1/runs/:id/events` — requires a principal via
  `sessionResolver.resolveFromCookieHeader(c.req.header('cookie'), forwarded)` (`server.ts:1912`),
  i.e. a `cookie: cez_session=<id>` header (`SESSION_COOKIE_NAME`, `packages/cezar/src/auth/session.ts:75`)
  or the supervisor's HMAC-signed `x-cezar-principal`/`x-cezar-principal-sig` pair
  (`packages/cezar/src/supervisor/forwarded-principal.ts:46-47`, not constructible outside the
  supervisor). This is consistent with the real artifacts: assertion (b), which hits the
  exempt `/api/v1/ready`, always has real data; only (a) and (c), which hit non-exempt routes,
  read empty.
- Session cookies are normally minted through browser OIDC (`GET /auth/login` → IdP →
  `GET /auth/callback`, `packages/cezar/src/auth/routes.ts:164-173`) and last
  `DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000` (30 days, `session.ts:86`) once minted.
- **This exact failure is already recorded at length in the parent spec**, `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`,
  with four defect ids cited inline (none exist as tracked `cezar todo` items — `cezar todo
  list` returns nothing matching them in either worktree checked):
  - `e36b79c0` (spec line ~1060) — "whose first acceptance criterion is that the probe must
    report UNMEASURED rather than PASS on an empty event list" — **effectively identical to
    this task's own acceptance criterion #1**, filed the same day.
  - `58e5954c` (spec line ~1117) — "A harness that green-lights a criterion it never observed
    is worse than none: it launders 'unmeasured' into 'passed'."
  - `8dc8bf3a` (spec line ~1190) — "of the six assertions, two carry real data... four had
    nothing behind them."
  - `06a170b8` (spec line ~1009) — "An assertion that cannot fail is not an assertion."
  - The task description's own "Related filed defects from the earlier run: f97ddd39, 6497f002,
    6c89af7c" are a **different** trio — `f97ddd39` is the bare `--rollback` argv-parsing bug,
    `6497f002` is "`runRollback` never probes readiness," `6c89af7c` is the keep-alive-reset/
    latency race. None of the three are about the SSE-vacuous-pass defect; do not conflate them
    with `e36b79c0`/`58e5954c`/`8dc8bf3a`/`06a170b8` above, which are the ones this task
    actually closes.
- `.ai/deploy-targets.json` (the `spec-to-deploy` workflow's own deploy-postcondition probes) is
  unrelated — it never references `deploy-e2e-probe.mjs`.
- Parent spec status line (top of file) currently reads: **"Criterion 2 (cutover gap = 0) is MET
  at the listener... with two residual costs... SSE continuity remains unmeasured (the API is
  behind OIDC; no static token on the box)."** Per the credential finding above, "no static
  token on the box" needs correcting in place once this task ships a real SSE-measured artifact
  — the repo convention (`AGENTS.md` § "keep the record straight") requires marking what a
  correction invalidates in place, not appending around it.

## Code actually involved

- `packages/cezar/scripts/deploy-e2e-probe.mjs` — the whole fix surface. Deliberately
  dependency-free and outside cezar's own module graph ("it has to keep measuring while the
  cezar it is measuring is replaced," parent spec line ~757) — preserve that property; don't
  pull cezar's own auth/session code in as a runtime import.
- `packages/cezar/src/server/server.ts:1841-1861,1912` — read-only reference, the auth
  perimeter the probe must work against.
- `packages/cezar/src/auth/session.ts` (`SESSION_COOKIE_NAME`, `DEFAULT_TTL_MS`),
  `packages/cezar/src/auth/identity-store.ts:37` (`SNAPSHOT_FILE`), `packages/cezar/src/paths.ts:217-219`
  (`identityDir()`) — read-only reference for how the runbook obtains a credential.
- `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` — needs a status-log correction
  once this ships (per repo convention), since it's the spec whose own acceptance criterion
  this task closes. This task's own acceptance criterion #4 ("The spec's Verification section
  states which half of criterion 2 each artifact actually proves") targets this same file.
- No test file exists for the probe anywhere in `packages/cezar/test/` — confirmed by grep, so
  any test coverage is net-new, not an extension.
- Real artifacts for reference/regression: `/var/lib/cezar/e2e-artifacts/{final-cutover,
  deploy-e2e-measured-cutover,deploy-e2e-agentdriven,cutover-probe,rollback-probe}.json` — all
  five show `sse.events: 0`, `run.statuses: []`, `sawInterrupted: false`, `gapMs` populated with
  a real number.

## Prior decisions this would contradict

None found. This is a strict continuation of already-recorded intent (`e36b79c0` etc.) and of
the sibling task's already-reviewed spec. The only thing to actively avoid contradicting: the
probe's "standalone, dependency-free, no cezar imports" design constraint, stated explicitly in
the parent spec and re-affirmed by the sibling spec's Solution section.

## Independent confirmation (second read of the auth code, this session)

A separate read of `packages/cezar/src/server/server.ts` and related files confirms the sibling
spec's claims with no discrepancy, and adds: `packages/cezar/src/server/auth-perimeter.test.ts:107-125`
has a `PROTECTED` table that already asserts 401-without-a-session on an SSE stream and on a
forged cookie (`:149`) — so the perimeter behavior the fix must work against is itself under
test today, just never exercised end-to-end against the real probe. Also confirmed: **no CLI
command anywhere in this repo mints or prints a usable session credential** for scripting
(`createSession`/`sessionResolver` are internal server exports, `session.ts:349-358`, not wired
to any `cezar` subcommand) — so reading `identity.json` directly (as the sibling spec's Solution
does) is an operational workaround, not a supported mechanism, and the spec step should decide
whether that's acceptable long-term or whether a real scripting-credential command belongs in
scope. `CEZ_AUTH_BOOTSTRAP_TOKEN` (`auth/bootstrap-claim.ts:26-33`) was checked and ruled out —
it only gates first-owner org claiming during onboarding, not per-request API auth. Loopback
grants nothing once `CEZ_AUTH` names a real provider (`local-mode-boot.test.ts:115-125` tests
this explicitly), confirming the parent spec's "loopback is not exempt" claim in code, not just
by observation on the box.

## Open questions the next (spec) step must settle

1. **Port vs. re-derive.** Should the spec step read and adapt
   `.ai/cezar/worktrees/e3851a57-b8ce-487e-b519-e0556d871799/.ai/specs/2026-08-22-deploy-e2e-probe-measured-assertions.md`
   directly (it already passed one review round with corrections applied), or write fresh?
   Diff it against this worktree's copy of the parent spec first — the two worktrees forked
   from a shared history but the parent spec may have moved since e3851a57 branched.
2. **Verify the credential claim still holds** on the actual target box before committing the
   spec's Phase 5 (real on-box verification run) to it — session ids expire (30-day TTL) and the
   ones checked 2026-08-22 will not be the ones live whenever this task's Phase 5 actually runs.
3. **Tri-state verdict precedence**, already resolved once by the sibling's review round:
   `failed` must dominate `not-measured` at the top level, not the reverse.
4. **Does this task's spec explicitly close out `e36b79c0`/`58e5954c`/`8dc8bf3a`/`06a170b8`** as
   dead references, and add the parent spec's status-log correction, per "a correction marks
   what it invalidates, in place"?
