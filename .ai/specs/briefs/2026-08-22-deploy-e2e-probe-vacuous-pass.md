\
# Brief — deploy-e2e-probe reports a false PASS when it observed nothing

**Gathered:** 2026-08-22
**Task id:** 29c070f0-f5f3-480c-939b-329fde6924e5 (step 1/8, "Gather the record")
**Status:** research only — no spec, no code written in this step

## Problem, in this repo's own terms

`packages/cezar/scripts/deploy-e2e-probe.mjs` is the standalone, dependency-free
continuous-client harness that measures the two acceptance criteria of
`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (KB entry
`specs-594acc539b36`, which *is* that spec file verbatim — no separate incident note
exists). On `prod-host` (hosted mode: `CEZ_REMOTE=1` + `CEZ_AUTH=oidc`), the probe
sends no credential, so every request to `GET /api/v1/runs/:id` and
`GET /api/v1/runs/:id/events` is rejected before it reaches a handler, by the single
`app.use('/api/*', …)` auth gate at `packages/cezar/src/server/server.ts:1841-1916`,
which returns `401 {"error":"unauthenticated"}` JSON (never a partial/malformed SSE
body — the gate runs before Hono dispatches to the SSE handler at
`server.ts:5893-5897`). `GET /api/v1/ready` is the one exempted path
(`server.ts:1842-1853`, exempted specifically so a credential-less deploy step can poll
it — see "prior decision" below), which is why the probe's `b:` assertions stay green
even on a fully-401'd run.

Because every `/runs` and `/events` call 401s, `sse.seqs` stays empty and
`runStatuses` stays empty. The probe's assertions are computed directly over those
sets with no "did we observe anything" check:

- `deploy-e2e-probe.mjs:204-205` — `'c: no seq gaps': gaps.length === 0` and
  `'c: no seq duplicates': duplicates.length === 0`, both true on an empty array.
- `deploy-e2e-probe.mjs:209-210` — `'a: run never left running': [...runStatuses].every(...)`,
  vacuously true on an empty set (`Array.prototype.every` on `[]` is `true`), and
  `'a: no interrupted event': !sawInterrupted`, true because nothing was ever parsed.
- The 401s themselves are swallowed into `sse.errors` (`deploy-e2e-probe.mjs:130`,
  `sse.errors.push({..., error: 'events answered 401'})`) — an array that is recorded
  in the JSON report (`:235`) but **never read by any assertion**, so it has no power
  to fail the run.
- `passed` (`:239`) is `Object.values(assertions).every(Boolean)` — with every
  assertion vacuously true, `passed: true`.

This is not a hypothetical: it already happened and was documented in detail. Per the
spec's "Criterion 1 was reopened by a controlled re-measurement (2026-08-21 19:05 UTC)"
section, the same cutover where the probe printed `passed: true` with all six
assertions PASS also showed, by direct process evidence, that broker pid `231420` and
its `claude` child `231428` were gone afterward and the spool's same-length prefix
sha256 differed (rewritten from byte zero, not appended to) — i.e. the run was
**re-launched, not re-attached**, which is the opposite of what criterion 1 requires.
The spec's own words: *"A harness that green-lights a criterion it never observed is
worse than none: it launders 'unmeasured' into 'passed'."* (filed inline as `58e5954c`
in the spec text — see "open questions" on whether that's a live todo).

## What the record already decided

- **The fix's shape is already specified, in the task's own Context/Fix paragraph** (this
  is a fix already scoped by the person who filed the task, not something this brief
  needs to invent): empty `sse.events`/`run.statuses` → report those assertions **NOT
  MEASURED**, `passed=false`; a 401/403 on `/events` or `/runs` → hard probe error, not
  a silently-ignored `sse.errors` entry; give the probe a documented way to authenticate
  via `--header` (which it already parses, `deploy-e2e-probe.mjs:39-44`) so SSE
  continuity can actually be measured on a hosted box.
- **`--header` already exists and is unused for this purpose.** Introduced in the same
  single commit that created the whole script, `954c6a55`
  ("feat: a run now outlives the cockpit that started it") — there is no later commit
  touching this file. Its only documentation is the top-of-file usage comment
  (`deploy-e2e-probe.mjs:21`, example `cf-access-token: …`, i.e. written with Cloudflare
  Access in mind). `grep -rn "\-\-header"` across the whole worktree hits nothing else —
  no README, no spec, no other script documents how to obtain a credential for this box.
- **There is a documented precedent for "say why it failed" on a deploy probe**, but it
  is a *different* probe: `.ai/deploy-targets.json`'s two inline bash health checks
  (consumed by `packages/cezar/src/workflows/postconditions.ts`, the automated
  `commit-push`/`deploy` step gate — an unrelated mechanism from
  `deploy-e2e-probe.mjs`, which is a manual/on-demand acceptance harness, not part of
  that gate). Commit `387ba439` ("fix: only one of the two deploy probes was taught to
  say why it failed") brought the UI probe up to what the backend probe already had
  (from `e9d77657`): no `set -e`, a bounded poll instead of one shot, and **every exit
  path echoes a concrete reason before `exit 1`** instead of failing silently. That's
  the precedent to follow for "hard probe error naming the auth requirement."
- **No service-account/bearer-token path exists for hosted auth.** The only login path
  is browser OIDC Authorization Code + PKCE, minting an `HttpOnly; Secure; SameSite=Lax`
  `cez_session` cookie (`packages/cezar/src/auth/session.ts:75,185`; `README.md:576-586`).
  So "document how to authenticate" in practice means: log in via browser, extract the
  `cez_session` cookie value, pass `--header 'cookie: cez_session=<value>'` — this is an
  inference from `session.ts`'s cookie mechanics, not a documented/sanctioned recipe
  anywhere today. The spec brief for step 2 (spec-writing) should decide whether the fix
  needs to *document* this recipe verbatim, or just make `--header` capable of carrying it
  (it already is, syntactically) and point at README's auth section.
- **`/api/v1/ready` is deliberately auth-exempt** (`server.ts:1843-1852`) specifically so
  a credential-less deploy step can poll it without 401 causing a false rollback. This
  is why the probe's `b:` assertions (poll of `/ready`) are legitimately meaningful
  today with no auth — only the `/runs` and `/events` paths need the new `--header`
  affordance. Any redesign must not require credentials for the `/ready` poll.
- **A related but distinct bug is already tracked and out of scope here**: the run
  re-launch-not-re-attach defect itself (why the broker doesn't survive a blue-green
  cutover) has three ordered suspects recorded under todo `45813876` in the spec — this
  task is about the *probe's* false-positive reporting, not about fixing the re-launch
  bug. Fixing the probe should make that bug *visible* (probe fails instead of passing),
  not fix it.

## Code actually involved

- `packages/cezar/scripts/deploy-e2e-probe.mjs` — the whole fix lives here:
  - `:39-44` — existing `--header` parsing (reusable, needs documentation only).
  - `:98-134` (`subscribe()`) — SSE loop; a `401`/`403` on the initial fetch currently
    becomes one `sse.errors` entry then retries after 100ms until `deadline` (`:106,
    129-131`); needs to become a hard/terminal failure that also stops the retry loop
    once auth is confirmed as the cause (retrying a 401 for the full `--seconds` window
    is itself wasteful and currently masks the real problem behind 20 identical retries).
  - `:79-89` (`sampleRun()`) — same silent-swallow shape for `/runs/:id` (`:86-88`,
    bare `catch {}`, does not even record the status like `subscribe` does).
  - `:199-211` (`assertions` object) — needs a NOT MEASURED / vacuous-pass guard before
    computing `c:`/`a:` assertions from `sse.seqs`/`runStatuses`.
  - `:239` (`passed`) — must go `false` when any assertion is NOT MEASURED, per
    acceptance criterion 1.
- `packages/cezar/src/server/server.ts:1841-1916` — the auth gate whose 401 shape
  (`{"error":"unauthenticated"}`, no `WWW-Authenticate` header, no other machine
  signal) the probe must special-case. Status code 401 is the only reliable
  discriminator available; there is no dedicated auth-failure header anywhere in the
  codebase (`grep -rn "WWW-Authenticate"` under `packages/cezar` is empty).
- `packages/cezar/src/server/server.ts:1842-1853` — the `/health`/`/ready` auth
  exemption and its rationale comment; do not disturb.
- `packages/cezar/src/auth/session.ts:75,185` — `cez_session` cookie name and
  attributes, relevant only if the spec decides to document the manual cookie-extraction
  recipe.
- `.ai/deploy-targets.json` + `packages/cezar/src/workflows/postconditions.ts` — the
  *other* probe mechanism (commit `387ba439`, `e9d77657`); not touched by this fix, but
  the precedent for "always echo why."
- `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (= KB `specs-594acc539b36`)
  — will need its own status-log correction once the probe fix ships and is re-run,
  per this repo's "a correction marks what it invalidates, in place" rule (workspace
  `CLAUDE.md`) — the spec's multiple "vacuous PASS" write-ups should point at the fix
  rather than just describing the defect.

## Prior decisions a spec must not contradict

- Standing authorization in this repo (`AGENTS.md`) is commit→push→deploy every change,
  gates green — this fix, once implemented, ships the same way; no extra sign-off step
  needed beyond the usual `spec-to-deploy` workflow gates.
- `/api/v1/ready` must stay exempt from auth (see above) — a fix must not make the
  probe's `b:` poll require `--header` too, or it silently breaks the zero-config
  acceptance-E2E path that doesn't care about SSE continuity.
- Cezar's own "zero config" doctrine (`AGENTS.md` § Zero config) argues against inventing
  a *new* auth mechanism (e.g. a static token) for the probe — the existing `--header`
  passthrough plus documentation is the fit, not a new credential system. The task's own
  fix description agrees ("give the probe a way to authenticate (accept a cookie/bearer
  via --header, which it already parses)").

## Open questions for the spec step

1. **Do the "filed as `06a170b8`" / `58e5954c` / `8dc8bf3a` / `e36b79c0` references in
   the spec correspond to real, resolvable todos?** `cezar todo list` (this repo's own
   CLI) currently shows **zero** todos and has no `show`/`get` subcommand — these
   8-hex-char ids do not resolve through the tracker available in this session. They may
   be informal ids assigned inline in prose rather than filed items, or filed in a
   different project/scope. Treat this task itself as the filed follow-through rather
   than assuming a separate open todo exists to close.
2. **Exact wording/shape for "NOT MEASURED".** The acceptance criteria say "reports
   those assertions as NOT MEASURED" — decide whether that's a third value alongside
   PASS/FAIL in the printed `PASS/FAIL <name>` lines (e.g. a `NOT_MEASURED` string) or
   a separate `measured: {..}` map alongside `assertions`, and whether NOT-MEASURED
   assertions still count toward `passed` (acceptance criterion 1 says they must force
   `passed=false`).
3. **Retry-vs-fail-fast on repeated 401s.** `subscribe()`'s reconnect loop
   (`:98-134`) would otherwise hammer the endpoint with 401s for the full `--seconds`
   window. Decide: fail hard on the *first* 401 (fastest, matches "hard probe error"),
   or after N consecutive 401s (tolerates one transient blip during a cutover but still
   distinguishes from real connectivity flakiness)? Same question applies to
   `sampleRun()`'s `/runs/:id` 401s.
4. **How literally to satisfy "document" for acceptance criterion 3.** No sanctioned
   recipe for obtaining a `cez_session` cookie value exists anywhere today (see "What
   the record already decided" above) — decide whether this fix's scope includes writing
   that recipe (e.g. in the script's usage comment, or in the spec file itself) or only
   wiring `--header` to actually get used/tested end-to-end, leaving the "how do I get a
   cookie" question to a separate follow-up.
5. **Does 403 need identical treatment to 401?** The task and acceptance criteria name
   both. The auth gate at `server.ts:1912-1913` only emits 401 (`unauthenticated`); a
   403 (`forbidden: ...`) shape exists elsewhere in the codebase (e.g.
   `require-org-admin.ts:80`) but the research agent did not confirm any code path that
   would return 403 specifically for `/runs` or `/events` — worth a quick check in the
   spec step, or just handle both defensively since the acceptance criteria name both.

## Path

`.ai/specs/briefs/2026-08-22-deploy-e2e-probe-vacuous-pass.md`

## The facts that most constrain the design

1. The bug is exactly three code spots in one file: `deploy-e2e-probe.mjs:199-211`
   (assertions computed over possibly-empty sets), `:130` / `:86-88` (401s swallowed
   into ignored error lists instead of failing), and `passed` at `:239` (no
   NOT-MEASURED-forces-false logic). No server-side change is required for criteria 1–2.
2. `/api/v1/ready` is intentionally the one unauthenticated endpoint — any fix must
   leave the `b:` assertions working with no `--header`, and only require
   `--header`/credentials for the `/runs` and `/events` paths.
3. `--header` is already fully wired for this (`:39-44`) and was built into the script
   from day one (single commit `954c6a55`) — this is a bug-fix + documentation task, not
   new plumbing, except for whatever documentation criterion 3 is judged to need.
4. This exact failure was already measured and written up in detail across the spec at
   `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (real pids, byte-diffed
   spools, the probe's actual six-line PASS/FAIL printout) — the spec step should update
   that document in place (per this repo's correction convention) rather than treat the
   false-PASS finding as new.
