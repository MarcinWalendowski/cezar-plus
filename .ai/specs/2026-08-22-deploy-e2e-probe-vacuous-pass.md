# The deploy E2E probe must not report PASS on what it never observed

**Status:** **Implemented — QA Needed.** P1 (vacuous-pass guard), P2 (hard 401/403 failure) and P3's
documentation half shipped 2026-08-23 in commit `83ddbdd2`, pushed to `origin/main` (worktree
`29c070f0`; unrelated to this same-day commit's own subject line, which is an autosave message from
the implementing session). Gates green: `npm run typecheck` (0 errors), `npm run test:unit`
(53/53, including 9 new cases in `packages/cezar/test/unit/deploy-e2e-probe.test.ts`), `npm test`
(516/518, 2 pre-existing unrelated flakes in `src/knowledge/catalog.test.ts` and
`src/components/add-project-dialog.test.tsx`). **Not yet done:** P3's live half — this spec's own
Verification section, "The live, credentialed run on `prod-host`" — has not been executed in
this task's chain, so acceptance criterion 3 ("records real seq continuity across a cutover on the
hosted box") is unmet, and the parent spec's in-place correction (Verification step 6, below) is
correctly still deferred. Todo `8dc8bf3a` tracks the remainder.

**Date:** 2026-08-22
**Owner ask (task context):** "deploy-e2e-probe reports a false PASS when it observed nothing."
**Extends:** `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (KB `specs-594acc539b36`) —
this spec fixes the MEASUREMENT tool that spec's Verification section depends on. It does not
change the deploy design itself, and does not fix the run re-launch-vs-re-attach defect that tool
exposed (tracked inline there as todo `45813876` — see "Out of scope").

## TLDR

`packages/cezar/scripts/deploy-e2e-probe.mjs` computes six PASS/FAIL assertions, and on
`prod-host` (hosted, `CEZ_AUTH=oidc`) two of the three data sources it needs —
`GET /api/v1/runs/:id` and `GET /api/v1/runs/:id/events` — 401 for the unauthenticated client the
probe is today. The probe doesn't notice: it computes "no seq gaps", "no seq duplicates", "run
never left running" and "no interrupted event" directly over whatever it collected, and an empty
array/set satisfies all four vacuously (`[].every(...) === true`, `[].length === 0`). It printed
`passed: true` with all six assertions PASS on the exact cutover where independent process
evidence (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`, "Criterion 1 was reopened by
a controlled re-measurement") showed the opposite: the broker was re-launched, not re-attached.
The spec's own words for this, already on record: *"A harness that green-lights a criterion it
never observed is worse than none: it launders 'unmeasured' into 'passed'."*

The fix has three independently shippable parts, one per acceptance criterion:

- **P1** — an assertion computed over zero observations reports `NOT_MEASURED`, never `PASS`, and
  `passed` goes `false` whenever any assertion is `NOT_MEASURED` or `FAIL`.
- **P2** — a 401/403 from `/runs` or `/events` stops being a swallowed retry-loop entry and becomes
  a named, terminal probe failure — fail fast, don't spend the whole `--seconds` window retrying a
  policy decision that will not change.
- **P3** — document the one credential path that exists (`cez_session`, browser OIDC login) against
  the `--header` flag the script has carried unused since it was written, and use it to take a real,
  non-vacuous measurement on the hosted box.

No server-side change. `/api/v1/ready` (P5's readiness gate) stays exempt from auth and the probe's
`b:` assertions keep working with no credential — only `/runs` and `/events` gain the new
behavior.

## Problem

Read directly off `deploy-e2e-probe.mjs` (line numbers as of this spec):

- `:199-206` — the `assertions` object computes `'c: no seq gaps': gaps.length === 0` and
  `'c: no seq duplicates': duplicates.length === 0` from `continuity(sse.seqs)`
  (`:165-177`), unconditionally — not gated on whether `RUN_ID` was even supplied, let alone on
  whether the subscriber ever received a frame. An empty `sse.seqs` produces `gaps = []`,
  `duplicates = []`, and both assertions read `true`.
- `:207-210` — `'a: run never left running': [...runStatuses].every((s) => s === 'running')` and
  `'a: no interrupted event': !sawInterrupted`, gated on `RUN_ID` but not on whether `sampleRun()`
  ever got a 2xx back. `Array.prototype.every` on an empty array is `true` by definition, and
  `sawInterrupted` starts `false` and is only ever set by a frame that was never received.
- `:129-131` (`subscribe()`) — a non-2xx or thrown fetch on `/api/v1/runs/:id/events` becomes
  `sse.errors.push({ atMs, error: 'events answered 401' })`, then a 100ms sleep and another attempt,
  repeated until `deadline` (up to `--seconds`, default 120s → up to ~1200 attempts). `sse.errors`
  is written into the JSON report (`:235`) but **no assertion reads it**.
- `:79-89` (`sampleRun()`) — `if (!response.ok) return;` on `/api/v1/runs/:id`: the status code is
  discarded, nothing is recorded at all, not even into an error array. Silence is stronger here
  than in `subscribe()` — a reader of the report cannot even see that this endpoint was ever
  rejected.
- `:239` — `passed: Object.values(assertions).every(Boolean)`. With every assertion vacuously
  `true`, `passed: true`, exit code 0 (`:249`).

This already happened and was measured, not merely predicted. Per
`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`:

- **"Criterion 1 was reopened by a controlled re-measurement (2026-08-21 19:05 UTC)"**
  (lines 1081-1123 there): on one controlled cutover, broker pid `231420` and its `claude` child
  `231428` were confirmed alive before and confirmed **gone** after; the spool's same-length-prefix
  sha256 differed (rewritten from byte zero, not appended to); `meta.json` named a new broker
  process started *after* the deploy finished. The run was re-launched, not re-attached — the
  opposite of what criterion 1 requires. **`deploy-e2e-probe.mjs` printed `passed: true` with all
  six assertions PASS on this exact cutover.** Filed there as `58e5954c`.
- **"What was NOT measured, and why it matters"** (lines 1054-1061) and **"What was NOT measured,
  and must not be read as passing"** (lines 1180-1190): across five real cutovers, every
  `/api/v1/events` subscribe attempt answered 401 (20 per run), `sse.events` stayed 0 in every
  artifact, and the four assertions built on `sse.seqs`/`runStatuses` reported PASS on that basis
  in two of the runs. Filed as `e36b79c0` and `8dc8bf3a`, both stating the same requirement this
  spec implements: *"the probe must report UNMEASURED rather than PASS on an empty event list."*
- **`06a170b8`** (line 1009): *"An assertion that cannot fail is not an assertion."*

**Root cause.** `prod-host` runs `CEZ_REMOTE=1` + `CEZ_AUTH=oidc`. The single auth gate at
`packages/cezar/src/server/server.ts:1841-1916` runs `app.use('/api/*', ...)` before any handler,
exempts exactly `${V1_PREFIX}/health` (`:1842`) and `${V1_PREFIX}/ready` (`:1853`, added
specifically so a credential-less deploy step can poll it — comment there cites this same spec),
and for every other `/api/*` path returns `c.json({ error: 'unauthenticated' }, 401)` (`:1913`)
when `sessionResolver.resolveFromCookieHeader(...)` finds no valid `cez_session` cookie. The probe
sends `headers` built from `--header` (`:39-44`), which nothing currently populates, so every
`/runs` and `/events` call hits this gate and 401s before Hono ever dispatches to a handler — never
a partial or malformed body, always the same JSON shape, `grep -rn "WWW-Authenticate"` under
`packages/cezar` is empty so status code is the only machine-readable signal available.

## Solution

### P1 — Vacuous assertions become `NOT_MEASURED`, and `NOT_MEASURED` forces `passed: false`

Each assertion's boolean value is replaced by a three-state string: `'PASS' | 'FAIL' |
'NOT_MEASURED'`. An assertion is `NOT_MEASURED` when the data it is computed from was never
observed — not when the observed data satisfies the check trivially.

```
pollObserved = poll.total > 0
sseObserved  = sse.seqs.length > 0
runObserved  = runStatuses.size > 0

'b: zero failed HTTP requests'   → !pollObserved ? NOT_MEASURED : (poll.nonOk.length === 0        ? PASS : FAIL)
'b: zero refused connections'    → !pollObserved ? NOT_MEASURED : (poll.connectErrors.length === 0 ? PASS : FAIL)

# only when RUN_ID is set — see the RUN_ID gating fix below
'c: no seq gaps'                 → !sseObserved ? NOT_MEASURED : (gaps.length === 0        ? PASS : FAIL)
'c: no seq duplicates'           → !sseObserved ? NOT_MEASURED : (duplicates.length === 0  ? PASS : FAIL)
'a: run never left running'      → !runObserved ? NOT_MEASURED : ([...runStatuses].every(s => s === 'running') ? PASS : FAIL)
'a: no interrupted event'        → !runObserved ? NOT_MEASURED : (!sawInterrupted          ? PASS : FAIL)
```

**Included fix, same root cause: reject a non-finite/non-positive `--seconds` or `--hz` at
startup, before any request is made.** `SECONDS = Number(arg('seconds', '120'))` and `POLL_HZ =
Number(arg('hz', '10'))` (`:36,38`) feed `deadline = started + SECONDS * 1000` (`:47`)
unvalidated. `Number('2m')` (a plausible unit-suffix typo) and `Number(undefined)` (a bare
`--seconds` with no following value) both yield `NaN`, and `Date.now() < NaN` is `false` on the
very first check (`:101`, `:183`) — `pollLoop` never runs a single tick, `poll.total` stays `0`,
and both `b:` assertions would otherwise read the same vacuous `PASS` this spec exists to stop.
Measured directly against the current (unfixed) script, run against an unreachable host so no
real request could ever succeed:

```
$ node deploy-e2e-probe.mjs --base http://127.0.0.1:1 --run abc --seconds 2m
...  passed: true, EXIT=0   (all six assertions print PASS)
$ node deploy-e2e-probe.mjs --base http://127.0.0.1:1 --seconds
passed: true, EXIT=0
```

Both exit in single-digit milliseconds, having issued zero requests. Fix: immediately after
parsing (`:36,38`), before `started`/`deadline` are computed, validate `Number.isFinite(SECONDS)
&& SECONDS > 0` and `Number.isFinite(POLL_HZ) && POLL_HZ > 0`; on failure, print a one-line usage
error to stderr and `process.exit(1)` before any request is made. This is validation of operator
input, not a measurement, so it belongs beside the existing `arg()` parsing, not inside the
assertions — but it closes the same "empty observation set reads as PASS" hole the `pollObserved`
gating above closes at the assertion layer, for the one input shape that can zero out `poll.total`
outright.

**Included fix, same root cause: gate `c:` on `RUN_ID` like `a:` already is.** Today `'c: no seq
gaps'`/`'c: no seq duplicates'` are computed unconditionally (`:199-206`), even when no `--run` was
passed at all — a pure `b:`-only HTTP invocation still prints two vacuous `c:` PASS lines today.
`sse.seqs` can only ever be non-empty when `RUN_ID` is set (`subscribe()` returns immediately
otherwise, `:99`), so this is the same defect as the one the task names, just reachable without a
401. Moving `c:` inside the existing `if (RUN_ID)` block removes it, and is not a scope
expansion — it's the same "compute an assertion from data you never asked for" bug, three lines
away from the one filed.

`passed` becomes:

```js
report.passed = Object.values(assertions).every((v) => v === 'PASS');
```

(`NOT_MEASURED` and `FAIL` both fail the run — this single line change is what satisfies
"exits non-zero ... never PASS.")

Console output (`:248`) prints the state string directly instead of the `ok ? 'PASS' : 'FAIL'`
ternary:

```
NOT_MEASURED  c: no seq gaps
NOT_MEASURED  c: no seq duplicates
FAIL          a: run never left running
```

`b:` assertions are gated on `pollObserved` above rather than assumed always-populated. An
earlier draft of this spec claimed `poll.total` is "guaranteed `> 0`" once the poll loop runs, so
no `NOT_MEASURED` state was needed for `b:` — that is false, and is falsified by the measurement
in the `--seconds`/`--hz` validation fix above: `--seconds 2m` and a bare `--seconds` with no
value both drive `deadline` to `NaN`, `pollLoop`'s `while (Date.now() < deadline)` (`:183`) is
`false` on its first check, and `poll.total` never leaves `0`. The startup validation above closes
the direct cause (a malformed window), but the `pollObserved` gate is the assertion-layer
belt-and-suspenders already applied to `c:`/`a:` — it holds even if some future change zeroes
`poll.total` a different way, rather than relying on validation being the only line of defense.

### P2 — 401/403 on `/runs` or `/events` is a hard probe failure, not a swallowed retry

Two call sites change, plus one new report field.

**`subscribe()` (`:98-134`).** Today: on any thrown error (network failure, non-2xx, timeout), push
one line to `sse.errors`, sleep 100ms, loop again until `deadline`. Change: after the fetch
resolves (`:103-105`), check `response.status` **before** the current `if (!response.ok ||
!response.body) throw ...` (`:106`). If `response.status === 401 || response.status === 403`,
record it to a new `authErrors.events` (first occurrence only — see below) and `return` from
`subscribe()` immediately, without sleeping or reconnecting. Every other non-2xx or thrown error
keeps today's retry-until-deadline behavior unchanged — a dropped connection or a boot-window
refusal is exactly the transient condition the retry loop exists to ride out; a 401 is a
deterministic policy decision that retrying will not change, and burning the whole `--seconds`
window on the full retry loop (up to ~1200 attempts in a 120s run at the 100ms retry interval, per
the Problem section — the `20` visible in a report's `sse.errors` array is `errors.slice(0, 20)`
(`:235`), a display cap, not the attempt count) is waste that also obscures the real signal behind
noise.

**`sampleRun()` (`:79-89`).** Today: `if (!response.ok) return;` discards the status entirely, and
the bare `catch {}` records nothing. Change: check `response.status` the same way; on 401/403,
record to `authErrors.runs` (first occurrence only) and skip the fetch on every subsequent tick for
the rest of the run (a module-level guard, not a raised exception — `sampleRun()` is called once a
second from inside `pollLoop`, and letting it fire ~120 more times against a 401 that will not
change is the same waste `subscribe()`'s fix avoids). Any other non-2xx keeps returning silently,
as today — `sampleRun()` is explicitly "not the failure detector" for connectivity (`:87` comment,
kept) and P1 already turns its silence-on-zero-observations into `NOT_MEASURED`.

**New report field**, alongside `poll`/`sse`/`run`:

```jsonc
"auth": {
  "events": null | { "status": 401, "atMs": 1234, "path": "/api/v1/runs/<id>/events" },
  "runs":   null | { "status": 401, "atMs": 1234, "path": "/api/v1/runs/<id>" }
}
```

**New assertions**, only when `RUN_ID` is set (there is nothing to authenticate against otherwise):

```
'auth: /runs/:id reachable'         → auth.runs   ? FAIL : PASS
'auth: /runs/:id/events reachable'  → auth.events  ? FAIL : PASS
```

A `FAIL` here is printed with the concrete reason, not just the state — the console line for a
failed auth assertion is followed by a one-line explanation naming the requirement:

```
FAIL  auth: /runs/:id/events reachable
      → 401 unauthenticated at t=612ms. Supply credentials: --header 'cookie: cez_session=<value>'
        (see script usage comment / README "CEZ_AUTH=oidc" for how to obtain one)
```

This is the same shape `387ba439` ("fix: only one of the two deploy probes was taught to say why it
failed") established for `.ai/deploy-targets.json`'s bash health checks: every exit path echoes a
concrete reason, nothing fails silently. That fix is a different, unrelated probe mechanism
(consumed by `packages/cezar/src/workflows/postconditions.ts`'s `deploy` step gate, not by this
script) — cited here only as the precedent this change follows, not touched by this spec.

**403 is handled identically to 401, defensively, without a confirmed code path.** The auth gate at
`server.ts:1912-1913` only ever emits 401 (`unauthenticated`) for `/runs`/`/events` today — no code
path in `packages/cezar/src` was found that returns 403 specifically for those two routes (a 403
`forbidden: ...` shape exists elsewhere, e.g. `require-org-admin.ts:80`, for org-admin-gated
routes, which `/runs`/`/events` are not). The acceptance criteria name both status codes, and
treating them identically costs nothing and correctly future-proofs against an org-scoped 403 being
added to these routes later without anyone remembering to update this script.

### P3 — Document and exercise the `--header` credential path

**No new code path** — `--header` already parses arbitrary `key: value` pairs into the `headers`
object sent on every request (`:39-44`), unused for this purpose since the script's single commit
(`954c6a55`). Two changes:

1. **Documentation**, in the script's own top-of-file usage comment (`:19-24`) — the only place
   any reader of this script looks first. Add, immediately below the existing `--header` example:

   ```
   #   For a hosted box (CEZ_AUTH=oidc), --run's /runs and /events calls need a session credential:
   #   sign in at https://<host>/ in a browser, open devtools → Application/Storage → Cookies →
   #   <host>, copy the `cez_session` value, then pass:
   #     --header 'cookie: cez_session=<value>'
   #   The cookie is HttpOnly (packages/cezar/src/auth/session.ts) — browser JS (document.cookie)
   #   cannot read it, only the browser's own cookie inspector or a captured Set-Cookie response
   #   header can. That is a constraint on browser script, not on this script: an operator with
   #   disk access to CEZ_HOME on the same box (e.g. an agent task running on prod-host
   #   itself) can instead read an unexpired session id straight out of
   #   <CEZ_HOME>/identity/identity.json (IdentityStore keeps no in-memory cache, so a session
   #   written or read this way is honoured by the running server on its next lookup —
   #   packages/cezar/src/auth/identity-store.ts:169,300-301), or mint a dedicated short-TTL one
   #   via SessionService.createSession(userId, ttlMs) (session.ts:239) and destroy it afterward,
   #   which avoids borrowing a real user's session. There is still no bearer-token/service-account
   #   HTTP auth path — the only way a request authenticates is this one cookie.
   ```

   This is the full extent of "document" for this spec's general usage comment: there is no
   sanctioned bearer-token/service-account recipe to write, because none exists in the codebase
   (confirmed: the only login path over HTTP is browser OIDC Authorization Code + PKCE,
   `packages/cezar/src/auth/session.ts:75,185`, `README.md:576-586`, and `grep -n
   "Bearer\|authorization" packages/cezar/src/server/server.ts` is empty). A service-account/
   static-token path is explicitly not proposed here — see Risks. The on-box store-read/mint path
   above is a separate, narrower thing: an operational shortcut available only where shell/disk
   access to `CEZ_HOME` already exists, not a new auth mechanism, and it is what this spec's own
   Verification section uses to make criterion 3's live run executable rather than a manual step
   (see below).

2. **A real, credentialed run against `prod-host`**, driven from inside an agent task the
   same way the parent spec's prior measurements were, across a real `server-deploy
   --strategy=blue-green` cutover, with a `cez_session` cookie obtained per the recipe above passed
   via `--header`. This is a Verification step (below), not a code change, and it is the step that
   turns P1+P2 from "correctly reports NOT_MEASURED today" into "actually measures seq continuity
   on this box" — the SSE half of criterion 2 the parent spec still lists as unmeasured.

## Architecture

No component boundary changes — this is a single-file fix to the standalone probe script. The
request flow after the fix:

```
deploy-e2e-probe.mjs
  ├─ pollOnce()   ──► GET /api/v1/ready              (no auth needed — server.ts:1842-1853 exemption)
  ├─ sampleRun()  ──► GET /api/v1/runs/:id            ──401/403──► authErrors.runs, stop retrying this tick loop
  │                                                   ──2xx──────► runStatuses.add(status)
  └─ subscribe()  ──► GET /api/v1/runs/:id/events     ──401/403──► authErrors.events, return (no reconnect)
                      (SSE, text/event-stream)        ──2xx──────► sse.seqs.push(seq) per frame, reconnect on drop

assertions: computed from {poll, sse.seqs, runStatuses, authErrors} → PASS | FAIL | NOT_MEASURED
passed = every assertion === PASS
```

No server-side (`server.ts`) or auth (`session.ts`) code changes. `/api/v1/ready`'s exemption is
read, not modified.

## Data models

**`report` JSON shape** (breaking change to the script's own output format — see Risks for why
this is safe):

```jsonc
{
  "base": "...", "runId": "...", "durationMs": 0,
  "poll": { /* unchanged */ },
  "sse": { /* unchanged shape; errors[] still capped at 20, now excludes the 401/403 case which exits subscribe() before it would repeat */ },
  "run": { "statuses": [], "sawInterrupted": false, "sawKeptGoing": false },
  "auth": {                                    // NEW
    "events": null,                            // or { status, atMs, path }
    "runs": null                                // or { status, atMs, path }
  },
  "assertions": {
    "b: zero failed HTTP requests": "PASS",     // CHANGED: string enum, was boolean
    "b: zero refused connections": "PASS",
    "auth: /runs/:id reachable": "PASS",        // NEW, only when runId set
    "auth: /runs/:id/events reachable": "PASS", // NEW, only when runId set
    "c: no seq gaps": "NOT_MEASURED",           // CHANGED: string enum; NEW state
    "c: no seq duplicates": "NOT_MEASURED",
    "a: run never left running": "NOT_MEASURED",
    "a: no interrupted event": "NOT_MEASURED"
  },
  "passed": false
}
```

**Compatibility.** `grep -rln "deploy-e2e-probe" --include=*.ts --include=*.mjs --include=*.json`
across `packages/cezar/src`, `packages/cezar/scripts` and `.ai` returns only the script itself —
nothing in the codebase parses this JSON programmatically (`postconditions.ts`'s `deploy` gate
reads `.ai/deploy-targets.json`'s bash probes, a separate mechanism). The only consumers are humans
and agents reading the file or stdout directly, so changing `assertions` values from `boolean` to a
string enum is a safe breaking change with no migration needed.

## API / interface contracts

**CLI** (unchanged surface, extended behavior):

```
node deploy-e2e-probe.mjs --base <url> --run <runId> --seconds <n> [--out <path>]
     [--header 'cookie: cez_session=<value>'] [--header 'k: v' ...]
```

- Exit code: `0` iff every assertion is `PASS`. `1` if any assertion is `FAIL` or `NOT_MEASURED`
  (unchanged semantics: "0 = every assertion held" — `NOT_MEASURED` never held).
- stdout: full JSON report, then one `<STATE>  <name>` line per assertion, `STATE ∈ {PASS, FAIL,
  NOT_MEASURED}` — a fixed-width reader parsing the old two-state `PASS |FAIL ` prefix must be
  updated (none exists in this repo today, per the grep above).
- A `FAIL` on either new `auth:` assertion additionally prints a one-line remediation pointing at
  `--header` and the usage-comment recipe (P2, above).

No HTTP contract changes — `/api/v1/ready`, `/api/v1/runs/:id`, `/api/v1/runs/:id/events` are all
consumed exactly as documented in the parent spec's "API / interface contracts" section; this spec
only changes how the probe *reacts* to their existing 401 shape (`{"error":"unauthenticated"}`,
`server.ts:1913`).

## Phases

| # | Phase | Ships | Independently verifiable by |
| --- | --- | --- | --- |
| **P1** | Vacuous-pass guard | `assertions` values become `PASS/FAIL/NOT_MEASURED`; `b:` gated on `pollObserved`, `c:` gated on `RUN_ID`/`sseObserved`; `--seconds`/`--hz` validated at startup; `passed` false on any non-PASS | Run the probe locally against `CEZ_AUTH` unset (`c:`/`a:` real PASS with a live run); against a target that never returns a run (`--run` pointing at a nonexistent id → `NOT_MEASURED`, `passed: false`, exit 1); and with a malformed `--seconds` (`2m`, or the flag with no value) → immediate non-zero exit with a usage error, zero requests issued |
| **P2** | Hard 401/403 failure | `subscribe()`/`sampleRun()` stop retrying past the first 401/403; `report.auth`; two new `auth:` assertions; remediation line on FAIL | Run the probe against a `CEZ_AUTH=oidc` server with no `--header`: `auth:` assertions FAIL, remediation line printed, the fixture server received exactly one `/events` request (no retry loop) and `sse.errors` has at most 1 entry instead of ~1200. **Not** a process-exit-time claim — `main()` awaits `Promise.all([pollLoop, subscribe()])` (`:193`) and `pollLoop` runs to `deadline` regardless of `subscribe()` returning early (`:183`), so the process still exits at the full `--seconds` window; only the request volume and error-array size change. See Verification for the exact assertions. |
| **P3** | Documented + exercised `--header` credential path | Usage-comment recipe; one real credentialed run recorded against `prod-host` across a live cutover | The recorded run's `auth.events`/`auth.runs` are both `null`, `sse.events > 0`, `c:`/`a:` assertions are real `PASS`/`FAIL` (not `NOT_MEASURED`) |

**Ordering.** P2's new `auth:` assertions plug into P1's tri-state `assertions` map, so P2 depends
on P1 landing first (or in the same change — they touch the same ~15-line block and are cheap to
ship together). P3's documentation half is independent of both; P3's *verification* half (a
meaningful, non-vacuous hosted-box measurement) is only meaningful once P1+P2 are live, since
without them a bad cookie would still silently retry/vacuously-pass rather than failing with a
clear reason. Recommended: ship P1+P2 together as one commit (small, same file, same block), then
P3 as a follow-up verification pass using the shipped script — consistent with this repo's "one
commit per session/feature" convention (`CLAUDE.md`) rather than three separate commits for an
18-line script.

## Risks

- **Fail-fast on the first 401/403 could mask a token that expires mid-run.** A `cez_session`
  cookie is a 30-day session (`session.ts` `DEFAULT_TTL_MS`), not a short-lived token, so expiry
  mid-`--seconds`-window is not a realistic case this probe runs into; accepted as a trade-off
  rather than adding retry-with-backoff complexity for a scenario that does not occur in practice.
- **Fail-fast on the first 401 also hard-fails a transient 401 from infrastructure warming up
  mid-cutover** (a proxy or the freshly-swapped process itself briefly misrouting auth before it's
  fully up), not just an actually-invalid credential. Low likelihood — the probe only starts once
  the server is already live, and P2 fires on the *first* 401 seen at any point in the run, not
  specifically at the cutover instant — but unlike token expiry this is not ruled out by the
  cookie's 30-day TTL, so it is a distinct risk from the one above. Accepted for the same reason:
  a 401 is treated as a deterministic policy signal, and adding retry-with-backoff to
  distinguish "warming up" from "wrong credential" is complexity this spec does not take on.
- **Breaking the JSON report's `assertions` value type.** Confirmed safe (Data models,
  "Compatibility") — no other code parses this file. If that ever changes, the new consumer should
  match on the string enum, not `Boolean(...)`.
- **The `c:` RUN_ID-gating fix changes visible output for HTTP-only (`--run` omitted) invocations** —
  two `c:` lines that always vacuously printed `PASS` before now don't print at all. This is a
  strict improvement (removing an assertion that could never fail is more honest than keeping it),
  but anyone with a saved reference output from before this change will see a diff.
- **The `--header` cookie recipe is manual, not automatable**, and stays that way — there is no
  service-account/bearer-token auth path in this codebase (confirmed: `session.ts`'s only issuance
  path is the browser OIDC flow). Inventing a new static-token mechanism for this one script would
  contradict this repo's zero-config doctrine per `AGENTS.md` and the task's own fix description,
  which names `--header` (already built) as the intended mechanism — not a new one. Documenting a
  manual recipe is the correct scope, not a shortcut.
- **`403` handling is speculative** — no confirmed code path returns it for `/runs`/`/events` today
  (see P2). Treating it identically to 401 is defensive and cannot regress anything that currently
  works, but it is untested against a real 403 response because none can currently be produced.
- **`HttpOnly` is not "unreadable" — it constrains browser JavaScript, not an operator with disk
  access to the box the server runs on.** An earlier draft of this spec claimed P3's live-box run
  needs a human to extract a cookie from a browser session because the cookie is `HttpOnly`. That
  is false as a technical claim on `prod-host`: this spec's own implementation session runs
  as the `cezar` uid on that exact box, `/var/lib/cezar/.cezar/identity/identity.json` is readable
  at that uid (measured: `-rw-------` owned by `cezar`, currently holding several unexpired
  sessions), and `IdentityStore` keeps no in-memory cache — every read re-parses the file from
  disk (`identity-store.ts:169`; `getSession` at `:300-301` calls `readSnapshot()` every time), so
  a session read or minted this way is honoured by the running server on its very next lookup. The
  Verification section below therefore makes P3's live run an executable agent step — reading an
  existing session or minting a dedicated one via `SessionService.createSession` — not a deferred
  human gate. What remains true, and is kept: there is no bearer-token/service-account *HTTP* auth
  path (`grep -n "Bearer\|authorization" packages/cezar/src/server/server.ts` is empty) — the only
  way a request authenticates is the one cookie, and the only way to obtain one *without* disk
  access to the box is the browser OIDC flow. If a future session wants a human to supply a real
  end-user's own session specifically (as opposed to this spec's on-box operational path), that is
  a defensible policy choice about whose credential to use — but it is a choice, not a technical
  impossibility, and should be stated as one if made.

## Verification

**Automated (must be green before any deploy of this change), no test file exists yet for this
script — add one where a gate actually runs it.** `packages/cezar/vitest.config.ts` includes only
`src/**/*.test.ts` and `packages/cezar/tsconfig.test.json` includes only `src/**`, `test/**`,
`vitest.config.ts` — a file under `scripts/` is picked up by neither `npm test` (vitest) nor
`npm run typecheck`, and would sit untested and untyped forever, which is exactly the failure mode
this spec exists to eliminate. The repo's own precedent for testing a standalone `scripts/*.mjs`
(`install-as-command.test.ts`, `pack-check.test.ts`) extracts the pure decision into `src/` and
unit-tests that — unavailable here, since this script's design deliberately imports nothing from
the `cezar` package it measures (an E2E probe must not depend on the code path it's checking).

1. New `packages/cezar/test/unit/deploy-e2e-probe.test.ts` — a `node:test` suite (matching
   `test:unit`'s existing `node --import tsx --test test/unit/*.test.ts` pattern,
   `package.json:39`), spawning the script as a child process against a minimal local HTTP server
   built with `node:http`. Give each case its own short `--seconds`/`--hz` (e.g. `--seconds 1
   --hz 20`) rather than reusing production-sized windows — `pollLoop` always runs to the full
   `--seconds` deadline regardless of what `subscribe()` does (see the P2 Phases-table note above),
   so window length is a direct cost to every case, and AGENTS.md:237 requires `test:unit` to stay
   in the "fast unit gate: no server, no browser." Cover:
   - A malformed `--seconds` (`2m`, or the flag given with no following value) — same for `--hz` —
     exits non-zero immediately with a usage error, before any HTTP request is attempted (assert
     the fixture server received zero requests). Regression case for the `passed: true, exit 0,
     poll.total: 0` behavior measured against the current script (Solution, P1).
   - Zero SSE events + empty run statuses (server that always 200s but never streams a frame and
     always returns a run with no matched id) → all four `c:`/`a:` assertions report
     `NOT_MEASURED`, `passed: false`, exit code `1`.
   - A live run with real SSE frames and a live `/runs/:id` → all six original assertions compute
     real `PASS`/`FAIL` values (not `NOT_MEASURED`) exactly as before this change, for a fixture
     with no gaps/duplicates/interruption.
   - A server that 401s `/runs/:id/events` → the fixture received exactly one `/events` request
     (no retry loop), `sse.errors` has at most 1 entry, `report.auth.events` is populated,
     `'auth: /runs/:id/events reachable'` is `FAIL`, `passed: false`, and the console output
     contains the remediation line naming `--header`. (Not a process-exit-time assertion — the
     process still runs to the full `--seconds` window; see the P2 Phases-table note.)
   - A server that 401s `/runs/:id` (but not `/events`) → `report.auth.runs` populated, only that
     `auth:` assertion `FAIL`s, `sampleRun()` does not keep hitting the endpoint every tick for the
     rest of the run (assert call count is bounded, e.g. ≤ 2).
   - `--header 'cookie: cez_session=x'` is actually sent on every `/runs`/`/events` request (assert
     on the fixture server's received headers) — regression coverage for the flag itself, which had
     none before this change.
   - HTTP-only invocation (no `--run`) never includes `c:`/`a:`/`auth:` keys in `assertions` at all.
2. Gates: `npm run typecheck`, `npm run test:unit` (runs the new suite; also CI's dedicated step,
   `.github/workflows/ci.yml:48`), `npm run test`, `npm run lint` (this repo's existing suites)
   green — necessary, not sufficient, per this repo's Definition of Done.

**The live, credentialed run on `prod-host` (P3, criterion 3) — executed by the implementing
agent on that box itself, not deferred to a human.** This spec's own spec-writing session ran as
the `cezar` uid directly on `prod-host` (verified: `hostname` returns `prod-host`,
`/var/lib/cezar/.cezar/identity/identity.json` is readable at that uid); the implementation step
will have the same access, so the credential step below is a normal agent action, not a manual
browser step:

1. Obtain a `cez_session` value without a browser, using the on-box operational path documented in
   P3's usage-comment fix (Solution, above): either read an unexpired session id straight out of
   `/var/lib/cezar/.cezar/identity/identity.json`, or — preferred, since it avoids borrowing a real
   user's session — mint a dedicated short-TTL one via `SessionService.createSession(userId,
   ttlMs)` (`session.ts:239`) against the same on-disk store, and destroy it once step 5 completes.
2. Start a long-running agent task on the `claude` backend on that box; note its run id (same setup
   the parent spec's own Verification section already uses).
3. `node packages/cezar/scripts/deploy-e2e-probe.mjs --base https://cockpit.example.com --run
   <runId> --seconds 180 --header 'cookie: cez_session=<value>' --out
   .ai/cezar/artifacts/deploy-e2e-authed-$(date -u +%Y%m%dT%H%M%SZ).json`
4. From inside the cockpit, in another task: `cezar server-deploy --strategy=blue-green --follow`
   (the same trigger the parent spec's Verification names).
5. Assert on the resulting JSON: `auth.events` and `auth.runs` are both `null`; `sse.events > 0`;
   `c: no seq gaps` and `c: no seq duplicates` are real `PASS`/`FAIL` (not `NOT_MEASURED`); `a: run
   never left running` and `a: no interrupted event` are real `PASS`/`FAIL`. Note when reading the
   artifact: the max-latency field is named `poll.gapMs` in the report (`:223` — the field is a
   deliberate rename of `poll.maxLatencyMs` to match the spec's own vocabulary), not
   `maxLatencyMs`; the parent spec's "`maxLatencyMs` came back null in every artifact" confusion
   (line 1187 there) was exactly this naming mismatch, not a missing measurement.
6. Whatever this run actually finds about seq continuity — clean or not — becomes the new
   authoritative answer to the parent spec's still-open "SSE continuity remains unmeasured" line,
   and must be recorded there per this repo's correction convention (`CLAUDE.md` § "keep the record
   straight"): edit `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`'s status header and
   the "What was NOT measured" sections (lines 989-1061, 1180-1207) in place, marking what is now
   superseded, rather than appending a new section that leaves the old "unmeasured" language
   readable as current. **This edit is explicitly deferred to the implementation/deploy step of
   this task** — this spec step changes no file other than itself.

**Not in scope for this spec's verification:** proving or disproving whether the underlying broker
re-attach defect (`45813876`) is fixed. This spec only makes the probe capable of reporting that
defect truthfully instead of masking it; the defect itself is separate follow-up work already
tracked in the parent spec.

## Out of scope (decisions, not omissions)

- **Fixing the run re-launch-vs-re-attach defect** (`45813876` in the parent spec — three ordered
  suspects: `consumedOffset`/`spoolDir` never persisted onto the run record; the release flip
  moving the install path so the new process resolves a different runs dir; or the deploy stopping
  the unit in a way that reaches the broker). Fixing the probe should make this defect *visible*
  (probe FAILs instead of vacuously PASSing), not fix it.
- **A service-account / static-token auth path for probes.** See Risks — the existing `--header`
  passthrough plus documentation is the fit; inventing new credential infrastructure for one script
  is out of scope and contrary to this repo's zero-config doctrine.
- **Retrying 401s with a bounded backoff instead of failing on the first one.** Considered (brief's
  open question 3) and rejected — a 401 is a deterministic auth decision, not a flaky condition;
  see Risks for the one scenario (token expiry mid-run) this trade-off accepts.
- **Changing `/api/v1/ready`'s auth exemption.** Untouched, must stay untouched — it is what lets
  the `b:` assertions run with zero configuration, and the parent spec's P5 health gate depends on
  it staying that way.
