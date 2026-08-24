# deploy-e2e-probe: an assertion with zero samples must say so, never PASS

> **SUPERSEDED 2026-08-24 by the merge of this fix — the code below IS now on `origin/main`.**
> The correction immediately below (written earlier the same day) says this file was added as
> documentation only, that "the code itself remains on the unmerged branch", and that
> "`origin/main`'s `deploy-e2e-probe.mjs` has no `--project`/`PROJECT_ID` support". Both were true
> when written and are false now. The blocker it names — the `packages/web/src/api/client.ts`
> typecheck break, todo `96a25516` — is cleared upstream: `npm run typecheck` is green across all
> four workspace packages. Following that block's own instruction ("Whoever lands `96a25516` should
> rebase `cez/3ee1ebf0` on top and merge this fix — at that point this file's status should be
> corrected again, in place"), `cez/3ee1ebf0` was merged on 2026-08-24, carrying
> `packages/cezar/scripts/deploy-e2e-probe.mjs` (tri-state assertions **and** `--project`/
> `PROJECT_ID` scoping) and `packages/cezar/test/e2e/deploy-e2e-probe.test.ts` (7 scenarios, green).
> `fe158c70` stays unresolvable — repeated rebases rewrote it — so cite this merge by date, not by
> that SHA. The "Status" line below still overstates history: Phases 1–5 are complete, but
> "shipped" became true only with this merge.
>
> Earlier correction of 2026-08-24, left unchanged below:
>
> **CORRECTED 2026-08-24 — added to `origin/main` as a documentation-only file; the code below
> is NOT shipped.** The status line directly beneath this one reads *"Implemented, tested and
> shipped... commit `fe158c70` on `cez/3ee1ebf0`"*. That was never true of `origin/main` and is no
> longer even resolvable: `fe158c70` does not exist in this repository's history under any branch
> (`git log --oneline --all | grep fe158c70` finds nothing) — the branch was rebased onto
> `origin/main` at least twice after that commit was made (2026-08-23 and 2026-08-24), rewriting
> its SHAs each time. The branch's current tip is `cez/3ee1ebf0` at `cdfe465e`, and
> `git merge-base --is-ancestor cdfe465e origin/main` is **false**: none of this work is merged.
>
> What actually shipped to `origin/main` for this defect is a simpler, independent fix — commit
> `83ddbdd2` (P1 vacuous-pass guard, P2 hard 401/403 failure, P3 credential docs; see
> `.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md`, whose Status header carries the accurate
> main-branch record) — implemented by a sibling task/worktree, not this one. `83ddbdd2` is an
> ancestor of the current live production release. It does **not** include the `--project` fix
> described below: `origin/main`'s `deploy-e2e-probe.mjs` has no `--project`/`PROJECT_ID` support
> (verified `grep -n PROJECT_ID` on `origin/main`'s copy is empty), so on this box — which boots in
> workspace mode and serves runs at `/api/v1/p/<project>/runs/:id`, not the unscoped path — the
> *shipped* probe still cannot reach a real run's SSE stream with a credential. It correctly reports
> `NOT_MEASURED` rather than a vacuous `PASS` when that happens (so acceptance criteria 1 and 3 of
> the originating task hold in production today), but it cannot reproduce the non-vacuous
> `sse.events = 2164` measurement documented below (acceptance criterion 2) until the project-scoped
> fix in this file lands.
>
> **Why this file is being added to `origin/main` now anyway.** Two already-shipped `origin/main`
> specs (`2026-08-22-deploy-e2e-probe-vacuous-pass.md` and
> `2026-08-19-non-disruptive-cezar-self-deploy.md`) cite this exact path by name as the record of
> the credentialed live cutover — a dead link before this commit, since the file existed only in
> the unmerged worktree. It is added here as the historical design-and-validation record: the
> design is correct and the 2026-08-23 measurement below is real (the artifact
> `.ai/cezar/artifacts/deploy-e2e-20260823194023.json` was produced by a genuine `cezar
> server-deploy --strategy=blue-green` cutover against a version of this code deployed directly to
> `prod-host` for that one run), but the code itself remains on the unmerged branch, blocked
> since 2026-08-24 by an unrelated typecheck break in `packages/web/src/api/client.ts` discovered
> while rebasing onto current `origin/main` (todo `96a25516`, filed 2026-08-24, "Blocks task
> `3ee1ebf0`"). Whoever lands `96a25516` should rebase `cez/3ee1ebf0` on top and merge this fix —
> at that point this file's status (and the two specs that cite it) should be corrected again, in
> place, to say so.
>
> Original status text and design, as written by the implementing task, follow unchanged below.
>
> **Status — Implemented, tested and shipped. Phases 1–5 all complete, commit `fe158c70` on
> `cez/3ee1ebf0`.** Phases 1–4 (§ Phases) were implemented in the `implement` step of task
> `3ee1ebf0-0d78-4cda-b50d-af6dff78910b`: `packages/cezar/scripts/deploy-e2e-probe.mjs` now reports
> tri-state `{verdict, sample, reason?}` assertions, a loud `AUTH REQUIRED` stderr line plus
> stream-level `authFailed` short-circuiting on 401/403/3xx, the `maxLatencyMs` alias, and the
> runbook documents reading a session cookie off the box. `packages/cezar/test/e2e/deploy-e2e-probe.test.ts`
> (7 cases, § Verification step 1) and `npm run typecheck` are green.
> **Date:** 2026-08-22
>
> **Correction 2026-08-23 (Phase 5 prerequisite):** authenticated production preflight proved
> that this task exists at `/api/v1/p/cezar/runs/:id`, while the probe's hard-coded unscoped
> `/api/v1/runs/:id` returned 404 because the server boots in workspace mode. The probe therefore
> accepts `--project <id>` and scopes only run-record and SSE URLs through `/api/v1/p/<id>`;
> `/api/v1/ready` stays unscoped. Phase 5 uses `--project cezar`.
>
> **Correction 2026-08-23 (Phase 5 executed) — supersedes the "Phase 5 pending" line above and the
> two stale "no static token on the box" claims (§ Problem, `:9` and `:73-74` of the parent spec).**
> A credentialed probe ran across a real `cezar server-deploy --strategy=blue-green` cutover on
> `prod-host` (release `20260823T194110Z-9c65f9e9`, artifact
> `.ai/cezar/artifacts/deploy-e2e-20260823194023.json`). Every assertion this spec covers now
> reports a real `sample` count and a `passed`/`failed` verdict — **never `not-measured`** — for the
> first time: `sse.events = 2164`, `sse.reconnects = 1`, `run.sampleCount = 55`. Overall
> `verdict = failed exit = 1`, and correctly so — this is the fix working, not a regression:
>
> | assertion | verdict | sample |
> | --- | --- | --- |
> | `b: zero failed HTTP requests` | passed | 544 |
> | `b: zero refused connections` | **failed** | 544 (1 refusal, boot-window latency — matches the already-known cost in the parent spec's Criterion 2) |
> | `c: no seq gaps` | **failed** | 2164 (94 gaps across the one reconnect — **new**, never measured before this fix) |
> | `c: no seq duplicates` | passed | 2164 |
> | `a: run never left running` | passed | 55 |
> | `a: no interrupted event` | passed | 2174 |
>
> **The 94-gap finding needs a caveat the artifact alone doesn't show.** Two earlier same-session
> runs with **zero reconnects** (`deploy-e2e-20260823193705.json`, `deploy-e2e-20260823193836.json`)
> recorded comparable raw gap counts — 73 gaps in 2116 events and 82 in 2147 — even though their `c:`
> assertions correctly stayed `not-measured` (§ Solution 1's reconnect-gate, working as designed: no
> reconnect in the window, so no continuity claim is made). That means the ~3.5% raw gap rate is
> present with or without a cutover reconnect, so it is not yet established that the 94 gaps in the
> failing run are *caused* by the deploy — they may be a pre-existing property of how the server
> allocates `seq` (e.g. non-`data` event types consuming sequence numbers the probe doesn't parse) and
> not lost data at all. That question is unresolved and filed as a new, distinct follow-up — todo
> `8206c158` — rather than assumed either way here. What Phase 5 has proven, without caveat, is
> that the assertion now runs on real data and can fail — it no longer lies.
>
> **Provenance note.** This worktree's own `context` step left no task-specific brief under
> `.ai/specs/briefs/` (that directory holds unrelated doctrine briefs — heredoc writes, sleep
> waits, structured review — none about this probe). Instead, an earlier attempt at this
> identical task, `e3851a57-b8ce-487e-b519-e0556d871799`, is still sitting in a sibling worktree
> (`.ai/cezar/worktrees/e3851a57-b8ce-487e-b519-e0556d871799/`) with its own gather-only brief
> (`.ai/specs/briefs/2026-08-22-deploy-e2e-probe-vacuous-assertions.md` in that worktree) and a
> complete, uncommitted spec at `.ai/specs/2026-08-22-deploy-e2e-probe-measured-assertions.md`
> there. Rather than re-derive the same investigation from a cold start, every citation and
> claim below was independently re-verified against **this worktree's own current source** —
> `packages/cezar/scripts/deploy-e2e-probe.mjs` diffed byte-identical between the two worktrees;
> `server.ts`'s auth-exemption block, `session.ts`'s cookie name/TTL, `identity-store.ts`'s
> snapshot file, `paths.ts`'s home resolution, and the parent spec's cited line ranges were all
> re-read directly in this checkout (line numbers below are this worktree's own — one citation
> drifted by a single line, `server.ts:1912`→`1913`, noted where it occurs). Nothing here is
> taken on the earlier attempt's word alone.

## TLDR

`packages/cezar/scripts/deploy-e2e-probe.mjs` is the acceptance-E2E harness for
`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`. On `prod-host` (hosted mode,
`CEZ_AUTH=oidc`) every SSE/run-status request the probe makes 401s, because the probe carries no
credential and the runbook never told it to send one. `sse.seqs` stays `[]`, `run.statuses` stays
`[]`, and four of the probe's six assertions are computed over that empty data — `gaps.length ===
0` and `[...runStatuses].every(...)` are both vacuously `true` on nothing. Three of five real
cutovers on record reported `passed: true` on that basis. This spec makes every assertion refuse to
pass on a zero sample (reporting a distinct `not-measured` verdict instead), makes a 401 on the
auth-gated endpoints loud and terminal for that stream instead of silently retried into a capped
error array, adds the missing `maxLatencyMs` field name the acceptance criteria and prior citations
ask for (aliasing the already-correct `gapMs` value — that number was never `null`, only unnamed),
and documents how the runbook gets the probe a real credential — non-interactively, by reading an
unexpired session id the box already has on disk — so SSE continuity gets measured for the first
time.

## Problem

All defects are in `packages/cezar/scripts/deploy-e2e-probe.mjs` (252 lines, added whole in
`954c6a55`, 2026-08-21, never touched since — confirmed via `git log --oneline -- <file>` in this
worktree, one commit). Confirmed by direct read of this worktree's copy:

1. **`subscribe()` (lines 98–134) never distinguishes "never connected once" from "one transient
   blip."** A non-2xx response on `GET /api/v1/runs/:id/events` throws `events answered ${status}`
   (line 106); the `catch` (129–131) pushes the message into `sse.errors` and retries after 100 ms,
   for the whole `--seconds` window if the credential is permanently missing. `sampleRun()` (79–89)
   does the same silently: `if (!response.ok) return;` (83) with no error recorded anywhere.
2. **`continuity(sse.seqs)` (165–177) is correct in isolation and vacuous on empty input.** On an
   empty `sse.seqs` — the observed 401 case, since frames are only pushed in `handleFrame` (136),
   which never runs — it returns `{gaps: [], duplicates: []}`, and `'c: no seq gaps':
   gaps.length === 0` / `'c: no seq duplicates': duplicates.length === 0` (204–205) both read `true`.
3. **The run assertions vacuously pass the same way.** `assertions['a: run never left running'] =
   [...runStatuses].every(s => s === 'running')` (209) is `true` on an empty `Set`
   (`Array.prototype.every` passes on `[]`); `runStatuses` stays empty because `sampleRun`'s silent
   drop (above) never populates it under a 401. `assertions['a: no interrupted event'] =
   !sawInterrupted` (210) passes the same way — `sawInterrupted` starts `false` (line 55) and only
   flips inside `handleFrame`, which never runs without a working SSE connection.
4. **No sample-size gate exists anywhere.** `passed: Object.values(assertions).every(Boolean)`
   (239) is the entire verdict computation. Confirmed by full-file read: no occurrence of
   `measured`, `sample`, `skip`, or `minEvents` in the file — this is new plumbing, not extending
   something half-built.
5. **`sse.errors` is truncated at report time** (`sse.errors.slice(0, 20)`, line 235) with no
   uncapped counter alongside it, so the true attempt count during a long `--seconds` window is
   invisible in the artifact.
6. **`maxLatencyMs` is not a misfire — it is a naming gap.** The internal variable is
   `poll.maxLatencyMs` (declared line 50, updated line 65, the max round-trip time of the
   unauthenticated `/api/v1/ready` poll), but the report publishes it under the key `gapMs` (line
   223) — a field that **is** populated with real numbers in all five artifacts on record (1129,
   1127, 62, 1136, 986 ms). The task description's "`maxLatencyMs` came back `null` in every
   artifact" is true only in the sense that no field literally named `maxLatencyMs` exists to grep
   for; the number itself was never missing. `packages/cezar/scripts/deploy-e2e-probe.mjs:222-223`
   and the parent spec's own Verification/Analytics sections (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:772`,
   `:791`, both confirmed in this worktree) both call this number `gapMs`; that name is the spec's
   own contract and must not silently change under existing readers.

**Auth mechanism confirmed by reading the server, not assumed:**
`packages/cezar/src/server/server.ts:1841-1861` exempts exactly two routes from the principal
middleware — `/api/v1/health` (line 1842) and `/api/v1/ready` (line 1853) — with `/ready`'s
exemption citing this same parent spec by name ("probed from the BOX, over loopback, by a deploy
that has no session"). Every other `/api/*` route, including `/api/v1/runs/:id` and
`/api/v1/runs/:id/events`, requires a principal:
`sessionResolver.resolveFromCookieHeader(c.req.header('cookie'), forwarded)` (`server.ts:1912`),
and if that resolves to nothing, `c.json({ error: 'unauthenticated' }, 401)` (`server.ts:1913`) —
a standard `cookie:` request header carrying `cez_session=<id>` (`SESSION_COOKIE_NAME`,
`packages/cezar/src/auth/session.ts:75`), or the supervisor's HMAC-signed
`x-cezar-principal`/`x-cezar-principal-sig` pair
(`packages/cezar/src/supervisor/forwarded-principal.ts:46-47`, not constructible outside the
supervisor). This is exactly consistent with the five real artifacts: the poll assertions (b),
which hit `/api/v1/ready`, have real non-vacuous data in every run; only the run-status and SSE
assertions ((a) and (c)), which hit the two non-exempt routes, are the ones reading empty.

A session cookie is normally minted through the browser OIDC flow (`GET /auth/login` → IdP →
`GET /auth/callback`, `packages/cezar/src/auth/routes.ts:164-173`) and, once minted, is valid for
`DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000` — 30 days (`session.ts:86`, confirmed in this
worktree). **But a non-interactive path to a working credential already exists on the box, with no
new mechanism to build.** Every minted session is persisted in the identity snapshot at
`identityDir()` (`packages/cezar/src/paths.ts:217-219`, which joins `cezarHomeDir()` — `~/.cezar`
unless `CEZ_HOME` overrides it, `paths.ts:16-19`) — `<CEZ_HOME>/identity/identity.json`
(`SNAPSHOT_FILE`, `packages/cezar/src/auth/identity-store.ts:37`), under its `sessions` array
(`{id, userId, expiresAt, createdAt}`), readable by the `cezar` unix user — the same uid that runs
the deploy and would run this probe. Confirmed live on `prod-host` 2026-08-22 (per the
earlier attempt's brief, itself dated the same day): the file held 6 sessions, all unexpired
(`expiresAt` 2026-09-15 through 2026-09-19); taking one `id` and calling
`curl -H "cookie: cez_session=$ID" http://127.0.0.1:4321/api/v1/events` and `.../api/v1/runs` both
returned `200`, not `401` — no browser step, no IdP round trip, no waiting on a human. The probe
already merges arbitrary `--header 'Key: Value'` pairs into every fetch it makes (parsing at lines
39–44, applied uniformly in `pollOnce`, `sampleRun`, and `subscribe`), so mechanically,
`--header 'cookie: cez_session=<id>'` works against the code as it stands today — nothing in the
server or the probe needs to change for this; only the runbook needs to read the id and pass it.
The documented runbook (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:762-770`,
confirmed in this worktree) just never passes one, and its own usage docstring's
`--header 'cf-access-token: …'` example (`deploy-e2e-probe.mjs:21`) names a real mechanism at the
wrong layer, not a nonexistent one. **Correction to an earlier draft of this spec, which claimed
"this box does not use Cloudflare Access" — that is false and contradicts the record.** Cloudflare
Access genuinely fronts the public edge: the parent spec's own "Perimeter" line names it
(`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:299`, "Cloudflare Access in front"), its
unit `Description` names it (`:279`), and `.ai/specs/2026-08-19-signed-out-cockpit-reauth.md:65-71`
records every path at `cockpit.example.com` — including the CORS-open `/api/v1/health` — answering
`302` into an Access sign-in redirect. What's actually wrong with the docstring's example is scope,
not existence: every recorded probe run, and this spec's own Phase 5 (§ Solution 4, revised below),
talks to the app directly over loopback (`http://127.0.0.1:4321`), a path Access never sits in front
of — only the app's own OIDC session cookie applies there. So `cf-access-token` is the right header
for a client crossing the public edge, and the wrong one for the loopback path this probe actually
exercises; § Solution 4 corrects the docstring to document the loopback session-cookie mechanism as
primary, while naming Cloudflare Access explicitly as the separate edge perimeter a future
edge-targeted run would need instead (see § Solution 4 and Phase 5, both revised below).

**This corrects a stale premise the task's own description inherited.** The parent spec currently
states, twice, that SSE continuity "remains unmeasured (the API is behind OIDC; no static token on
the box)" (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:9`) and that it is "blocked
because the API sits behind `CEZ_AUTH`+OIDC and the box holds no static token" (`:73-74`). Both
predate this spec's live check above and are false as written — the box holds no *static,
purpose-built* scripting token, but it holds real, unexpired *session* ids in a file the deploy's
own uid can already read. § Solution 4 below is the fix for the runbook; the parent spec's two
claims are marked corrected in place, not appended around, once Phase 5 has produced a real
artifact backing the correction (see § Solution 4, last paragraph).

**Already-recorded intent this spec closes.** These are inline citations inside the parent spec's
running log, not tracked `cezar todo` items: `58e5954c` ("A harness that green-lights a criterion
it never observed is worse than none: it launders 'unmeasured' into 'passed'", spec line 1117),
`e36b79c0` ("the probe must report UNMEASURED rather than PASS on an empty event list" — the same
acceptance criterion as this task's #1, filed the same day, spec line 1060), `8dc8bf3a` ("of the
six assertions, two carry real data... four had nothing behind them", spec line 1190),
`06a170b8` ("An assertion that cannot fail is not an assertion", spec line 1009) — all four
confirmed present at those lines in this worktree's copy of the parent spec. This spec is the fix
those four notes were waiting on.

**Not found / confirmed absent, in this worktree:** no test file for this script anywhere in
`packages/cezar/test/`; no other code in this repo parses the probe's report JSON or its
`assertions` shape (`grep -rn "deploy-e2e-probe\|assertions\["` over `packages/cezar/src`,
`packages/cezar/scripts`, and `.ai/` returns only the script's own file and the two spec
documents) — the report's consumers are a human reading `--out` JSON and the console PASS/FAIL
lines, so changing the assertion value's shape (item below) has no other caller to break.
`.ai/deploy-targets.json` (the `spec-to-deploy` workflow's own postcondition probes) does not
reference this script at all.

## Solution

### 1 — Tri-state assertions with a sample count, so an empty sample cannot read PASS

Every assertion becomes an object, not a bare boolean:

```ts
type AssertionResult = {
  verdict: 'passed' | 'failed' | 'not-measured';
  sample: number; // count of observations this verdict is computed over
  reason?: 'no-run-id' | 'auth-failed'; // present only when verdict === 'not-measured'; diagnostic only, never read by the verdict computation itself
};
```

`verdict` is `'not-measured'` whenever `sample === 0`, full stop — computed before the assertion's
own pass/fail predicate ever runs, so no predicate can vacuously return `true` on nothing. When
`sample > 0`, `verdict` is the existing predicate's `'passed'`/`'failed'`. `reason` records *why* a
`not-measured` verdict has zero samples: `'no-run-id'` when `--run` was never supplied (`RUN_ID`
stays `null`, and `subscribe()` / `sampleRun()` return immediately without ever making a request —
existing early returns at `deploy-e2e-probe.mjs:99` and `:80`) versus `'auth-failed'` when a request
was attempted and rejected (§ Solution 2, below) — so an artifact reader can tell "nobody told the
probe which run to watch" from "the probe tried and was turned away" instead of both reading as an
identical, unexplained zero.

**This requires removing an existing guard, not just adding a case.** Today
`deploy-e2e-probe.mjs:207`'s `if (RUN_ID)` wraps the two `a:` assertions, so without `--run` they are
never assigned into `assertions` at all — the key is simply absent, not `false`. This spec removes
that guard: all six assertions in the table below are always present in the report, and when
`--run` was never supplied the two `a:` entries (and, via `RUN_ID`-gated `subscribe()`, the two `c:`
entries) read `verdict: 'not-measured'`, `reason: 'no-run-id'` instead of being missing keys. Per
assertion:

| assertion | sample = | unchanged predicate when sample > 0 |
| --- | --- | --- |
| `b: zero failed HTTP requests` | `poll.total` | `poll.nonOk.length === 0` |
| `b: zero refused connections` | `poll.total` | `poll.connectErrors.length === 0` |
| `c: no seq gaps` | `sse.reconnects > 0 ? sse.seqs.length : 0` (reconnect-gated, below) | `gaps.length === 0` |
| `c: no seq duplicates` | `sse.reconnects > 0 ? sse.seqs.length : 0` (reconnect-gated, below) | `duplicates.length === 0` |
| `a: run never left running` | `run.sampleCount` (new counter, below — every *successful* `sampleRun` fetch, not the deduped `Set` size) | `[...runStatuses].every(s => s === 'running')` |
| `a: no interrupted event` | `sse.dataFrames` (new counter, below) | `!sawInterrupted` |

`run.sampleCount` and `sse.dataFrames` are new counters, not reuses of existing dedup structures:
`runStatuses` is a `Set`, so its size undercounts (a run parked in `running` across 50 samples reads
as sample size 1, which understates how much was actually observed); `sse.seqs.length` is the wrong
sample base for the interrupted-event assertion specifically, because `sawInterrupted` is derived
from *any* parsed SSE data frame's `message` field (`handleFrame`, line 156), not only frames that
happen to carry a numeric `seq`. Both counters increment on every successful observation,
independent of the `Set`/array they also feed.

**The two `c:` assertions are additionally gated on having observed a reconnect, not just on having
observed frames.** Acceptance criterion #2 is "seq continuity **across the reconnect**" specifically
— a window that saw events but never had the process swapped underneath it (no cutover ran during
`--seconds`, or the operator started the probe with no deploy in flight) has not measured what the
criterion asks for, even though `sse.seqs.length > 0`. `sse.reconnects` already exists
(`deploy-e2e-probe.mjs:52`) but this spec moves where it increments. Today it fires at line 128, the
moment the SSE read loop's body ends, before the outer `while` re-checks the `--seconds` deadline —
so a stream that happens to end in the final moments of the window counts a "reconnect" that never
actually resumed, because the `while` exits instead of looping back to reconnect. Since
`sse.reconnects` is now the gate that makes the `c:` assertions non-vacuous, an over-count here would
let a run with zero real reconnects still show `sample > 0` — the same vacuity class this section
exists to close, one level down. The fix moves the increment to *after* the reconnecting fetch
actually returns a live stream carrying `Last-Event-ID`: `sse.reconnects` counts **resumed**
connections, not loop iterations that merely ended. So the sample base is `sse.reconnects > 0 ?
sse.seqs.length : 0` — zero reconnects forces `not-measured` regardless of how many events were
seen, while a real reconnect makes the sample the true event count, so the existing `gaps.length ===
0` / `duplicates.length === 0` predicates can still fail on real data (an assertion that cannot fail
is not an assertion — `06a170b8`, § Problem). **A baseline run with no cutover in its window is a
legitimate use** (smoke-testing the probe itself, or confirming HTTP health with no deploy in
flight) — it now correctly reports `c: no seq gaps` / `c: no seq duplicates` as `not-measured`, not
`passed`, because continuity across a reconnect was never actually exercised, which is the honest
answer for that run.

**A stream that authenticates, samples, and then loses its credential mid-run must not read
`passed` from its pre-failure samples.** § Solution 2 sets `sse.authFailed` / `run.authFailed` the
first time either stream hits a 401/403 and stops retrying that stream from that point on — a cookie
can expire mid-run, or a 401 can occur briefly during the cutover itself (§ Risks). Measurement that
stopped before the run finished is not the same as measurement that covered the whole window, so the
per-assertion verdict computation checks the relevant stream's `authFailed` flag *before* looking at
`sample`: `sse.authFailed === true` forces `'c: no seq gaps'`, `'c: no seq duplicates'`, and
`'a: no interrupted event'` to `'not-measured'` (`reason: 'auth-failed'`) regardless of how many
samples were collected before the failure; `run.authFailed === true` does the same for
`'a: run never left running'`. `sample` still reports the true pre-failure count, so an artifact
reader can see how much data *was* collected before the credential died, even though `verdict` reads
`'not-measured'`.

The top-level verdict:

```ts
report.verdict = assertions has any 'failed'        ? 'failed'
                : assertions has any 'not-measured'  ? 'not-measured'
                : 'passed';
```

`'failed'` outranks `'not-measured'` deliberately: a run with one real seq gap *and* one
credential-starved assertion must not report the softer `not-measured` — that would launder an
actual regression into "the probe never got a credential," which is exit code `2`, the signal this
spec teaches a reader to interpret as "rerun with a credential," not "investigate a regression."
Only when nothing failed does an unmeasured assertion get to determine the top-level verdict.

`report.passed` (boolean) is kept, `= report.verdict === 'passed'`, so nothing that still greps for
`"passed": true` in old artifacts silently misreads a new one — but it can no longer be `true` on a
`not-measured` verdict, which is the actual defect this closes. Process exit code: `0` for
`passed`, `1` for `failed`, `2` for `not-measured` — three distinct signals, so a caller (a runbook
step, a human) can tell "this is a real regression" (1) from "the probe never got a credential" (2)
without opening the JSON.

**The console summary printer changes too, not just the JSON — this is the part the task's own
framing names ("a reader glancing at five PASS lines").** Today's printer
(`deploy-e2e-probe.mjs:248`, `console.log(\`${ok ? 'PASS' : 'FAIL'} ${name}\`)` iterating
`Object.entries(assertions)`) reads truthiness. Once `assertions[name]` becomes the
`AssertionResult` object above, every entry is a non-null object and therefore truthy — so an
unmodified copy of that line prints `PASS` for a `not-measured` entry too, reintroducing on stdout
the exact vacuous-PASS defect this spec removes from the JSON, and none of the JSON-only assertions
elsewhere in this spec would catch that regression. The fix switches the printer on `verdict`, not
on truthiness, and adds a final summary line:

```
PASS        b: zero failed HTTP requests        (n=1185)
FAIL        b: zero refused connections         (n=1185)
UNMEASURED  c: no seq gaps                       (n=0)
UNMEASURED  c: no seq duplicates                 (n=0)
UNMEASURED  a: run never left running            (n=0)
UNMEASURED  a: no interrupted event              (n=0)
verdict=not-measured exit=2
```

One line per assertion — label is `PASS` / `FAIL` / `UNMEASURED`, sample count always shown as
`(n=<sample>)` — followed by one final `verdict=<passed|failed|not-measured> exit=<0|1|2>` line
after the per-assertion lines. This is what makes acceptance criterion #3 ("distinguishes 'measured
and passed' from 'could not measure' in both its stdout summary and its JSON artifact") true of the
human-readable output too, not only the JSON: a reader glancing at the lines — the exact failure
mode this task opened with — now sees `UNMEASURED`, not a sixth `PASS`.

### 2 — A 401 on the auth-gated endpoints is loud and stops burning that stream's retries

`subscribe()` and `sampleRun()` both classify a response status before deciding what to do with it:

- **401 or 403** → this is an authentication failure, not a transient blip. Print one `console.error`
  line **immediately, once per stream** (`sseAuthFailed` / `runAuthFailed` flags guard against
  spamming it every retry):
  ```
  [deploy-e2e-probe] AUTH REQUIRED: GET <url> answered <status> — pass a session cookie, e.g.
  --header 'cookie: cez_session=<id>' (see .ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md
  § Verification). This stream will not be measured.
  ```
  Then **stop retrying that stream** — `subscribe()` returns instead of looping for the rest of
  `--seconds`; `sampleRun()` short-circuits on subsequent calls. The independent, unauthenticated
  `/api/v1/ready` poll loop is **not** stopped — it is exempt from auth by design (`server.ts:1853`)
  and its data is real and worth keeping even when the other two streams can't run. A hard
  `process.exit` on first 401 would throw away HTTP-poll data that was never in question, for no
  benefit the loud stderr line plus `not-measured` verdict doesn't already give a reader. "Fail
  loudly" is satisfied by the immediate stderr line and the terminal `not-measured` verdict + exit
  code `2`, not by truncating a working measurement.
- **Any other non-2xx / connect error** → recorded exactly as today (into `sse.errors` /
  `poll.connectErrors`), with retry/backoff unchanged. Only 401/403 gets the new loud-and-stop
  treatment, because those are the one class of failure this task's artifacts show recurring
  deterministically for the entire run. This is a deliberate narrowing of acceptance criterion #2's
  "401 (or any non-200)": a persistent non-401/403 non-2xx (a 404, a 500) does **not** get the
  loud-and-stop treatment, but it also can no longer read as a silent `passed` — with zero
  successful samples it falls straight into § Solution 1's "`sample === 0` → `not-measured`" gate,
  exit code `2`, same as an auth failure. So the criterion's intent (a persistent failure must not
  read as passed) holds for every non-2xx, even though only 401/403 gets the *immediate* stderr
  line and early stream termination.
- `sse.errors` gains an uncapped sibling counter, `sse.errorCount`, alongside the still-`slice(0,
  20)`-truncated `sse.errors` display array — an honest "observed N attempts, M failed" needs the
  true count even when only 20 samples are kept for display. `sampleRun()` gets the same treatment
  for symmetry: today it drops every non-`ok` response silently (`if (!response.ok) return;`, line
  83) with nothing recorded, 401/403 included. It gains `run.errorCount` (uncapped) and
  `run.lastError` (the most recent non-ok status + a truncated body snippet, mirroring how
  `sse.errors` records SSE failures) — without this, a persistently-500ing `/api/v1/runs/:id` reads
  as `not-measured` with no clue in the artifact why, which is the same "silently unmeasured"
  failure mode this spec exists to close, just on the run-status stream instead of the SSE one.

**Redirects and non-SSE content are not silently accepted as success — the same vacuity class, one
endpoint over.** A base URL that answers with a `3xx` into an auth wall (Cloudflare Access at the
edge, § Problem, or any future proxy) currently reads as a *success* to this probe: `fetch`'s default
`redirect: 'follow'` chases the redirect, lands on a `200` HTML sign-in page, and `response.ok` is
`true` — so `pollOnce()` counts a healthy `/ready` poll, and `subscribe()` would parse a login page as
an SSE body, find zero frames, and never set `sse.authFailed`. That is a *non-zero* sample this
spec's own sample-count gate (§ Solution 1) cannot catch, because a sample did land — it just came
from the perimeter, not the endpoint. Two changes close it, applied to every fetch this script makes
(`pollOnce`, `sampleRun`, `subscribe`):

- Every fetch passes `redirect: 'manual'` instead of the implicit default. A `3xx` response is never
  `ok`: on the unauthenticated `/api/v1/ready` poll it is recorded into `poll.nonOk` exactly like any
  other non-2xx (so a probe accidentally pointed at a perimeter that gates even `/ready` reports a
  real failure instead of a phantom healthy poll); on `subscribe()`/`sampleRun()`, a `3xx` gets the
  same loud-and-stop treatment as a 401/403 above — a perimeter redirect is functionally an
  authentication rejection for this probe's purposes, not a transient blip worth retrying.
- `subscribe()` additionally requires the response's `content-type` header to start with
  `text/event-stream` before entering its frame-parsing loop. Any other content type — an HTML
  sign-in page served as a `200`, exactly what a *followed* Access redirect would have produced — is
  treated as a stream failure (recorded into `sse.errors`/`sse.errorCount`, and if persistent, falling
  into `not-measured` via § Solution 1's zero-sample gate) and is never handed to the frame parser.

Together these mean a run pointed at a base URL sitting behind a perimeter it cannot authenticate to
fails or reports `not-measured` honestly, instead of a redirect-and-200 round-trip silently reading as
a passing sample. This is exactly the failure mode that would have made an edge-targeted Phase 5 run
unsafe without first obtaining Access credentials — see § Solution 4 and Phase 5, both revised below
to run against loopback instead.

### 3 — `maxLatencyMs` as a named field, `gapMs` unchanged

Add `poll.maxLatencyMs` to the report as an exact alias of the existing `poll.gapMs` value (same
number, both keys present). `gapMs` is not renamed or removed: it is the name the parent spec's
Verification (`:772`) and Analytics (`:791`, which names the same number `gap_ms`, snake case)
sections already document and the name the five existing real artifacts already use. This is not
one of this task's own four acceptance criteria — it satisfies defect `8dc8bf3a`'s literal ask
("`maxLatencyMs` came back `null` in every artifact", parent spec `:1187`, filed at `:1190`) with
the least-surface-area change — one alias key, not a rename that would silently break every existing
reference to `gapMs` in the parent spec and its own runbook instructions.

### 4 — Runbook: how the probe gets a working credential

No new mechanism inside the probe (it already accepts `--header`, and the server already accepts a
plain `cookie:` header — confirmed above), and no new mechanism on the server either. What's
missing is documentation of one non-interactive read:

1. **Primary path — read an unexpired session id off the box, no human involved.** On the host
   running the cutover (`prod-host`, as the `cezar` unix user):
   ```bash
   SESSION_ID=$(node -e '
     const fs = require("fs");
     const path = (process.env.CEZ_HOME || require("os").homedir() + "/.cezar") + "/identity/identity.json";
     const store = JSON.parse(fs.readFileSync(path, "utf8"));
     const now = Date.now();
     const live = (store.sessions || []).filter(s => new Date(s.expiresAt).getTime() > now);
     if (!live.length) { console.error("no unexpired session in " + path); process.exit(1); }
     live.sort((a, b) => new Date(b.expiresAt) - new Date(a.expiresAt));
     console.log(live[0].id);
   ')
   export CEZ_E2E_SESSION_COOKIE="cez_session=$SESSION_ID"
   ```
   This reads `<CEZ_HOME>/identity/identity.json` (§ Problem, above) and picks the
   longest-lived unexpired session already sitting there from ordinary product use — it does not
   create a session, does not touch the server, and needs no new script shipped anywhere; it is a
   dozen lines the runbook itself inlines. `identityDir()`/`cezarHomeDir()` resolution is
   `packages/cezar/src/paths.ts:16-19,217-219` — the inline snippet mirrors that logic rather than
   importing it, keeping the probe's own dependency-free constraint (§ Architecture) intact; this
   snippet lives in the *runbook*, not in `deploy-e2e-probe.mjs` itself.
2. **Fallback path — browser OIDC, for a box where the identity store is unreadable or empty**
   (e.g. a fresh box with no sessions yet). Complete `GET /auth/login` → IdP → `/auth/callback`
   against `https://cockpit.example.com`, then read the `cez_session` cookie value from devtools,
   and export it the same way: `export CEZ_E2E_SESSION_COOKIE="cez_session=<value>"`.
3. Pass it to the probe: `--header "cookie: $CEZ_E2E_SESSION_COOKIE"`.
4. **The value is a live user's real session — treat it as a credential, not a log field.** It must
   reach the probe only via this env var and the `--header` flag; it must never be written into the
   report JSON, a log line, a spec, or a `cezar todo`/knowledge entry. The current report shape does
   not echo request headers, so no code change is needed to keep this true — but the constraint is
   binding on the runbook step and on whoever runs Phase 5, since a pasted `--header` value in a
   terminal transcript or CI log would leak it. A session read this way is valid until its own
   `expiresAt` (`DEFAULT_TTL_MS = 30` days from when it was originally minted, `session.ts:86`) —
   not 30 days from the read — so a run close to that boundary should re-read rather than assume
   freshness.

This updates `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`'s "How to run the acceptance
E2E" block (lines 762–770) to include the `--header` argument and the read-the-identity-store step
above, and its usage docstring's `--header 'cf-access-token: …'` example (`deploy-e2e-probe.mjs:21`)
is corrected — not deleted — to document the loopback session-cookie mechanism as the primary,
actually-used path, while keeping `cf-access-token` documented as the real header a future run
against the public edge (`https://cockpit.example.com`, behind Cloudflare Access — § Problem) would
need instead of, or in addition to, the cookie. Per this repo's "a correction marks what it
invalidates, in place" rule, this same edit also corrects, in place, the two stale "no static token
on the box" claims identified in § Problem (`:9` and `:73-74`) — amending the claim itself, with a
dated `CORRECTED` lead-in and the original text kept below unchanged, not appended as a new unrelated
note — and the parent spec's status-log entries that cite
`58e5954c`/`e36b79c0`/`8dc8bf3a`/`06a170b8` as open get a dated correction line pointing at this
spec. Both corrections land only once Phase 5 below has produced a real artifact — not before, since
the correction must be backed by a real measurement, not by code merely existing.

## Architecture

No architectural change. The probe stays exactly what the parent spec requires it to be: a
standalone, dependency-free process with no import from cezar's own module graph
(`deploy-e2e-probe.mjs:15-17`, "it has to keep measuring while the cezar it is measuring is
replaced"). Every change in this spec is internal to that one file, plus a documentation-only edit
to the parent spec. No new HTTP route, no new server-side auth path, no new CLI flag — `--header`
already exists and already does the job.

## Data models

The report JSON shape (`packages/cezar/scripts/deploy-e2e-probe.mjs`, `main()`, currently lines
213–240):

```ts
type Report = {
  base: string;
  runId: string | null;
  durationMs: number;
  poll: {
    total: number; ok: number; failed: number; connectErrors: number;
    gapMs: number;          // unchanged — max client-observed /ready latency
    maxLatencyMs: number;   // NEW — exact alias of gapMs
    p50: number; p99: number;
    failures: object[]; refusals: object[];
  };
  sse: {
    events: number; reconnects: number; reloadFrames: number;
    dataFrames: number;     // NEW — every parsed SSE data frame, seq or not
    gaps: object[]; duplicates: object[];
    errors: object[];       // unchanged, capped at 20
    errorCount: number;     // NEW — uncapped total
    authFailed: boolean;    // NEW — true once a 401/403 was seen on this stream
  };
  run: {
    statuses: string[]; sawInterrupted: boolean; sawKeptGoing: boolean;
    sampleCount: number;    // NEW — every successful sampleRun() fetch
    authFailed: boolean;    // NEW
    errorCount: number;     // NEW — uncapped count of non-ok sampleRun() responses, symmetric with sse.errorCount
    lastError: object | null; // NEW — most recent { status, bodySnippet }, or null if none seen
  };
  assertions: Record<string, { verdict: 'passed' | 'failed' | 'not-measured'; sample: number; reason?: 'no-run-id' | 'auth-failed' }>; // CHANGED from Record<string, boolean>
  verdict: 'passed' | 'failed' | 'not-measured'; // NEW
  passed: boolean;         // unchanged key, meaning narrowed: true only when verdict === 'passed'
};
```

## API / interface contracts

No HTTP API changes. The contract that changes is this script's own CLI/report surface:

- **CLI arguments**: unchanged (`--base`, `--run`, `--seconds`, `--out`, `--hz`, `--header` — no new
  flags). The runbook usage is documented to actually pass `--header 'cookie: cez_session=...'`
  going forward (§ Solution 4).
- **stdout**: the JSON report gains the fields in § Data models; existing fields keep their
  meaning and location. The per-assertion console printer switches from truthiness to `verdict`
  (`PASS` / `FAIL` / `UNMEASURED`, each followed by `(n=<sample>)`) and gains a final
  `verdict=<…> exit=<…>` summary line (§ Solution 1) — this is the stdout half of acceptance
  criterion #3.
- **stderr**: gains the one-line-per-stream `AUTH REQUIRED` message on a 401/403 (§ Solution 2).
- **Exit code**: was `0` (`passed`) / `1` (not passed). Becomes `0` (`passed`) / `1` (`failed`) /
  `2` (`not-measured`) — a caller that only checked "exit code nonzero = bad" still works
  unchanged; a caller that wants to distinguish "real regression" from "never got a credential" now
  can.

## Phases

Each phase is independently shippable and independently testable; later phases depend on earlier
ones landing but not on later ones existing yet.

**Phase 1 — Tri-state assertions, sample counts, reconnect gating, and the stdout printer.**
Implement `AssertionResult` (including `reason`), the new `run.sampleCount` / `sse.dataFrames`
counters, the `sse.reconnects > 0` gate on the two `c:` assertions' sample, the `verdict`/exit-code
computation, and the switch of the console printer from truthiness to `verdict` plus the final
`verdict=<…> exit=<…>` line — all from § Solution 1 and § Data models. `run.authFailed` /
`sse.authFailed` do not exist yet at this point in the sequence (Phase 2 introduces them), so the
authFailed-override rule in § Solution 1 has no effect yet; it activates once Phase 2 lands. This
phase alone fixes the core defect (a zero-sample assertion can no longer read `passed`, on stdout or
in the JSON) even before the credential/runbook work lands — run against the box today (still no
credential), the artifact and the stdout summary should show `c: no seq gaps` / `c: no seq
duplicates` / `a: run never left running` / `a: no interrupted event` all as `UNMEASURED` /
`not-measured`, and the overall `verdict` as `not-measured`, never `passed`.

**Phase 2 — Loud-fail on 401/403, uncapped error counters, and the authFailed override.** Implement
§ Solution 2: the stream classification, the immediate `console.error`, the stop-retrying behavior,
`sse.errorCount`, `sse.authFailed`, `run.authFailed`, and `run.lastError`. This is also where
Phase 1's authFailed-override rule becomes live, since it reads the flags this phase introduces — a
stream that samples data and then 401s partway through must downgrade to `not-measured` from this
phase on, not just at zero samples. Independently verifiable by re-running the probe against the box
with no credential: the stderr `AUTH REQUIRED` line must appear once (not 20 times) within the
first few seconds, and the process must not spend the full `--seconds` window retrying a dead
stream.

**Phase 3 — `maxLatencyMs` alias.** One field addition, § Solution 3. Independently verifiable by
inspecting a fresh artifact's `poll.maxLatencyMs === poll.gapMs`.

**Phase 4 — Runbook and parent-spec documentation.** Update
`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`'s "How to run the acceptance E2E" block
and usage docstring per § Solution 4. While already editing that file, this phase also corrects its
`:786` Gates line, which names `npm run lint` — a script that does not exist anywhere in this repo
(confirmed by checking both `package.json` files, § Verification step 3) — to name only the gates
that actually exist (`typecheck`, `test`, `test:package`). This phase produces no code change and can
land alongside Phase 1–3's commit or as a follow-up doc-only commit.

**Phase 5 — Real on-box verification.** Not a code phase — the actual E2E run named in this task's
acceptance criterion #3, and it needs no human step: read an unexpired `cez_session` id off the box
(§ Solution 4 step 1), run the probe with it across a real `cezar server-deploy --strategy=blue-green`
cutover on `prod-host`, and confirm the resulting artifact has `sse.events > 0`, `run.statuses`
non-empty, and every assertion's `verdict` is either `passed` or `failed` — never `not-measured` —
for the six assertions this spec covers. **Run against `--base http://127.0.0.1:4321`** (loopback),
matching all five prior artifacts on record and the exact address where the `cez_session` credential
was verified live (§ Problem: `curl -H "cookie: cez_session=$ID" http://127.0.0.1:4321/api/v1/events`
→ `200`). An earlier draft of this spec instead mandated the public edge
(`https://cockpit.example.com`), reasoning that loopback measures the process swap but not the
client-visible edge hop — that reasoning did not account for Cloudflare Access sitting in front of
the edge (§ Problem, corrected above): a live check from this box during review showed
`https://cockpit.example.com/api/v1/ready` answering `302` into an Access sign-in redirect, which
`fetch`'s default `redirect: 'follow'` would chase into a `200` HTML page — manufacturing a *new*
vacuous pass with a non-zero sample (`b: zero failed HTTP requests` / `b: zero refused connections`
both reading `passed` over ~1800 Cloudflare sign-in pages in a 180 s run), and the SSE stream would
read a `200` instead of `401`, so `sse.authFailed` would never fire and the loud `AUTH REQUIRED` line
would never print — silently defeating this spec's own headline fix at exactly the topology that
draft mandated. § Solution 2's redirect/content-type handling (added above) would now catch that
case rather than pass it, but Phase 5 still targets loopback deliberately: it is the address every
existing artifact and the one live credential check actually used, and it isolates "did the process
swap correctly" from "does this credential also clear the edge's separate Access perimeter" — the
latter needs its own `CF-Access-Client-Id`/`CF-Access-Client-Secret` credential (passable via the
existing `--header` flag) that this spec does not provision and treats as a distinct, out-of-scope
follow-up (§ Out of scope). Loopback proves the deploy's process swap did not interrupt the SSE
stream; it does not prove the public edge hop, and the Verification section below says so plainly
per this task's acceptance criterion #4. This run is what finally lets the parent spec's
`58e5954c`/`e36b79c0`/`8dc8bf3a`/`06a170b8` citations, and its two stale "no static token on the box"
claims (§ Problem), be marked resolved (§ Solution 4, last paragraph).

## Risks

- **Report shape change breaks a consumer.** Checked: no consumer other than the script's own
  console printer and human `--out` review exists in this repo (§ Problem, "Not found"). The
  `passed` boolean key is kept for exactly this reason even though `verdict` is now the more precise
  field.
- **Stopping retries on 401 could mask a transient auth blip that would have recovered** (e.g. a
  cookie that briefly 401s during a deploy cutover's own restart, then would have started working
  again). Mitigated by scoping the stop-and-report behavior to 401/403 specifically — a genuinely
  transient failure during a cutover is far more likely to be a connect error or a 5xx, both of
  which keep the existing retry-with-backoff path untouched (§ Solution 2, "Any other non-2xx").
  If this proves wrong in Phase 5's real run, the fix is a short grace-retry-count before declaring
  `authFailed`, not a redesign.
- **The 30-day cookie TTL means Phase 5's credential will eventually expire**, silently returning
  the probe to the pre-fix 401 state on some future cutover. Phase 1–2 make that failure mode loud
  and `not-measured` rather than a silent vacuous pass, which is the containment this spec commits
  to. Re-selecting a session is not manual — § Solution 4 step 1 re-reads the identity store and
  picks whichever unexpired session is newest at run time — but it depends on *some* session having
  been minted recently enough by ordinary product use; if the store ever holds zero unexpired
  sessions, Phase 5's automation falls back to the browser step (§ Solution 4 step 2, see Out of
  scope) and does need a human once.
- **Renaming `assertions` values from `boolean` to an object is a breaking shape change** for
  anything that does `Object.values(assertions).every(Boolean)`-style reads outside this file. None
  found (§ Problem, "Not found"), but this is called out explicitly since it's the one intentionally
  incompatible change in this spec.

## Out of scope (decisions, not omissions)

- **A new, purpose-built credential-issuance mechanism** (a `cezar auth login` CLI, a static
  scripting token minted server-side). This spec takes the simpler path (§ Solution 4: read an
  already-minted session id out of the existing identity store, browser login only as a fallback if
  the store is empty) because it needs zero new server-side surface and already satisfies
  acceptance criterion #3 without one. If the identity store ever holds no unexpired session on a
  cutover day, that is the trigger to revisit this, not a standing gap this spec leaves open.
- **Automated *minting* of a new session** (as opposed to reading an existing one). Out of scope per
  above — § Solution 4 reads, never creates.
- **A grace-retry count before declaring `authFailed`** (see Risks). Not implemented up front;
  revisit only if Phase 5's real run shows a false-positive auth-failure classification.
- **Measuring the public edge hop** (`https://cockpit.example.com`), as opposed to loopback. Phase 5
  runs against `http://127.0.0.1:4321` deliberately (§ Phases, Phase 5) — the edge sits behind
  Cloudflare Access, a separate perimeter from this probe's `cez_session` cookie (§ Problem), and
  measuring it would need its own `CF-Access-Client-Id`/`CF-Access-Client-Secret` service-token
  credential (passable via the existing `--header` flag, same mechanism, different header) that
  nothing in this spec provisions. Revisit only if a future task specifically needs client-visible
  edge latency, not as a standing gap in criterion 2 — loopback fully proves the process-swap
  continuity the criterion is about.

## Verification

Concrete, executable steps — Phases 1–3 need no live box, Phase 5 does. **What each artifact
actually proves, stated plainly (per this task's acceptance criterion #4):** the unit/integration
test in step 1 proves the *tri-state logic itself* is correct (a mock server, not a real deploy) —
it is proof the probe can no longer emit a vacuous PASS, on stdout or in the JSON, not proof any
real cutover was measured. Steps 2–3 (`typecheck` / `test:package` / `test` green) prove the change
compiles and doesn't regress anything else in the package — again no live box. **Only step 4,
Phase 5, on a real `prod-host` cutover over loopback (`http://127.0.0.1:4321`), proves
criterion 2 (SSE continuity across a cutover) end to end for the process swap** — and even then,
only the run that actually supplies a credential *and* crosses a real reconnect proves the SSE half;
a Phase 5 run without a credential, or one that never crosses a process swap, legitimately reports
`not-measured` and proves only that the probe now says so truthfully instead of lying `PASS`. What
Phase 5 does **not** prove, on loopback, is the public edge hop through Cloudflare Access
(`https://cockpit.example.com`) — that is explicitly out of scope (§ Out of scope) and would need its
own Access service-token credential. Put another way: Phases 1–4 prove the probe cannot lie anymore;
Phase 5 proves the process-swap half of the thing being measured, not the edge-hop half.

1. **New test file `packages/cezar/test/e2e/deploy-e2e-probe.test.ts`** (matches this package's
   existing `test/e2e/*.test.ts` subprocess-integration pattern, e.g. `inline-contract.test.ts`,
   which uses `node:test` + `execFile`/spawn — run via `npm run test:package`, since the probe is a
   standalone script and this repo's `test:package` is exactly where standalone-script CLI behavior
   is already covered). The file stays `.mjs` (§ Verification step 3 below); the mock server is a
   local `node:http` server (no new dependency) that simulates:
   - `GET /api/v1/ready` → always `200`, unauthenticated (matches production's exemption).
   - `GET /api/v1/runs/:id` and `GET /api/v1/runs/:id/events` → `401` unless the request carries a
     configured `cookie` header, in which case `/runs/:id` returns a JSON run record and
     `/runs/:id/events` streams SSE frames with monotonic `seq`. The events handler can, per
     scenario, end the response after a handful of frames (so the probe's `subscribe()` loop
     reconnects with `Last-Event-ID` and `sse.reconnects` increments — mirroring the real
     process-swap reconnect this criterion is about) and can flip from `200` to `401` mid-scenario
     to simulate a credential dying partway through the window.
   Then spawns `node packages/cezar/scripts/deploy-e2e-probe.mjs --base <local> --run test --seconds
   N [--header ...]` and asserts on parsed stdout — both the per-assertion `PASS`/`FAIL`/`UNMEASURED`
   lines and the final `verdict=… exit=…` line, § Solution 1 — the JSON report, and the exit code,
   across these scenarios:
   - **No `--header`**: exit code `2`; `verdict === 'not-measured'`; `assertions['c: no seq
     gaps'].verdict === 'not-measured'`, `.sample === 0`, `.reason === 'auth-failed'`; same for the
     other three previously-vacuous assertions; `sse.authFailed === true`; stderr contains exactly
     one `AUTH REQUIRED` line for the SSE stream (not one per retry); **stdout contains
     `UNMEASURED` (never `PASS`) for all four previously-vacuous assertion lines and a final
     `verdict=not-measured exit=2` line** — this is the direct proof of this task's acceptance
     criterion #1, on both artifacts, proven by the test harness, not by a live box.
   - **No `--run`** (the flag omitted entirely): exit code `2`; the four run/SSE assertions carry
     `reason: 'no-run-id'`, not `'auth-failed'` — distinguishing "the probe was never told which run
     to watch" from "it tried and was turned away"; the mock server records zero requests to
     `/runs/*` (`subscribe()`/`sampleRun()` return immediately on a `null` `RUN_ID`, existing lines
     99/80 — no `AUTH REQUIRED` line is expected here, since no request was ever attempted).
   - **Valid `--header 'cookie: …'`, mock server forces one reconnect mid-window** (ends the SSE
     response after a few frames, then resumes a clean, gap-free `seq` sequence on the reconnecting
     request): exit code `0`; `verdict === 'passed'`; every assertion's `sample > 0`;
     `sse.reconnects >= 1`; stdout shows `PASS` on all six assertion lines and a final
     `verdict=passed exit=0` line. This is what proves criterion #2's *logic*, including the
     reconnect requirement, against synthetic data — it does not by itself prove real SSE continuity
     on `prod-host`; that is step 4 below.
   - **Valid cookie, mock server never disconnects within the window (0 reconnects)**: exit code
     `2`; `assertions['c: no seq gaps'].verdict === 'not-measured'` and `.sample === 0` **even
     though `sse.seqs.length > 0`** — proves the reconnect-gate doesn't let a no-cutover baseline
     read as `passed` (§ Solution 1, "A baseline run with no cutover in its window").
   - **Valid cookie, mock server forces a reconnect as above but injects a gap** in the `seq`
     sequence across it: exit code `1`; `assertions['c: no seq gaps'].verdict === 'failed'`,
     `.sample > 0` — distinguishing a real failure from the not-measured case, the whole point of
     the fix.
   - **Valid cookie, mock server streams several frames across a reconnect, then answers every
     subsequent request `401` for the rest of the window**: exit code `2`; `verdict ===
     'not-measured'`; `sse.authFailed === true`; `assertions['c: no seq gaps'].verdict ===
     'not-measured'` and `.reason === 'auth-failed'` **despite `.sample > 0`** from the pre-failure
     frames — proves the mid-stream authFailed override (§ Solution 1): a stream that authenticates,
     samples, and then loses its credential must not read `passed` off what it saw before the
     credential died.
   - **Perimeter-redirect scenario (§ Solution 2, redirects/content-type).** Mock server 302s every
     request — `/api/v1/ready`, `/api/v1/runs/:id`, and `/api/v1/runs/:id/events` alike — to a `200`
     HTML page (simulating a client accidentally pointed at an Access-gated host that a followed
     redirect would otherwise turn into a phantom success): asserts `b: zero failed HTTP requests`
     and `b: zero refused connections` both read `verdict: 'failed'` (never `'passed'`) with
     `poll.nonOk.length > 0`; the SSE stream reports `sse.authFailed === true` with the same
     `AUTH REQUIRED` stderr line as the 401 case; `poll.total > 0` while `poll.ok === 0` — proving a
     redirect-to-200 never gets counted as a healthy sample by either the poll or the SSE stream.
   - `poll.maxLatencyMs === poll.gapMs` in every scenario.
2. `npm run test:package` green, including the new file, alongside the existing
   `package-cli.test.ts` / `inline-contract.test.ts` / etc. in that suite.
3. `npm run typecheck` green. **There is no `npm run lint` script in this repo** (root and
   `packages/cezar/package.json` both checked — neither defines one, and no ESLint/Biome/Prettier
   config exists anywhere in the tree), so lint is not a gate here; `npm run test` (the vitest suite)
   should also stay green, though vitest deliberately excludes `test/` so it won't itself run the
   new file. The probe stays `.mjs` — `packages/cezar/scripts/deploy-e2e-probe.mjs` is the path
   named in the parent spec's runbook (`:765`) and in all five existing artifacts, so this is not a
   decision left open to the implementing step; the § Data models types are JSDoc/documentation only,
   and since `tsconfig.test.json`'s `include` is `src/**/*.ts`, `test/**/*.ts`, `vitest.config.ts`,
   the script itself is not typechecked by `npm run typecheck` either way — only the new test file
   under `test/e2e/` is.
4. **Phase 5, on `prod-host`, matching the parent spec's existing "How to run the acceptance
   E2E" procedure** (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:762-770`, as amended
   by § Solution 4): read an unexpired `cez_session` id from `<CEZ_HOME>/identity/identity.json`
   (§ Solution 4 step 1 — no browser step needed unless the store is empty), start a long-running
   agent task, run the probe with `--base http://127.0.0.1:4321 --project cezar --header "cookie:
   $CEZ_E2E_SESSION_COOKIE"` (loopback — § Phases, Phase 5, and the "Out of scope" note on the edge
   hop; not the public edge, which sits behind Cloudflare Access and is not what this credential
   clears) across a real `cezar server-deploy --strategy=blue-green` cutover, and confirm the
   resulting artifact satisfies this task's four acceptance criteria directly:
   - every assertion carries `sample` and a `verdict` that is `passed` or `failed`, never
     `not-measured`, for a run where a credential was supplied — **this is the only step that
     proves the SSE half of criterion 2 on real data, over loopback; it does not prove the public
     edge hop (§ Out of scope)**;
   - `sse.reconnects >= 1` in the artifact — the cutover actually forced a reconnect during the
     probe's window, so the `c:` assertions' `passed`/`failed` verdict is backed by continuity
     genuinely measured *across* the process swap, not a single unbroken connection that never saw
     one (§ Solution 1's reconnect gate); if the blue-green drain path is expected to also emit a
     `reload` frame (`handleFrame`, `deploy-e2e-probe.mjs:143-146`), note `sse.reloadFrames` in the
     artifact too, though only `reconnects` is load-bearing for this criterion;
   - no 401 is silently absorbed — if one occurs, it produces the loud stderr line and an
     `authFailed: true` flag rather than a silent vacuous pass, and per § Solution 1 does not let a
     partial pre-failure sample read as `passed`;
   - `sse.events` (and `run.sampleCount`) are non-zero in the resulting artifact — SSE continuity
     measured for real, for the first time;
   - `poll.maxLatencyMs` is present and non-null in the artifact — this reconfirms the HTTP half,
     which prior runs already proved (1184/1185, 998/998, 722/722 requests OK) and this spec does
     not change the meaning of.
   This step needs a live box and cannot be executed from this worktree; it is the acceptance
   criterion the rest of this spec exists to make measurable, not something Phase 1–4 can simulate
   away.

   **Result (2026-08-23), executed on `prod-host`, release `20260823T194110Z-9c65f9e9`,
   artifact `.ai/cezar/artifacts/deploy-e2e-20260823194023.json`: all four bullets above hold.**
   `sse.events=2164`, `run.sampleCount=55`, `sse.reconnects=1`, `poll.maxLatencyMs` populated, and
   every one of the six assertions returned `passed` or `failed` — none returned `not-measured`.
   The overall verdict is `failed exit=1`: `b: zero refused connections` failed (1 refusal, the
   known boot-window cost) and `c: no seq gaps` failed (94 gaps in 2164 events — a new finding, not
   yet attributed to the cutover specifically, since two zero-reconnect runs in the same session
   showed a comparable raw gap rate; tracked separately as todo `8206c158`). **This proves the SSE
   half of criterion 2 for real, for the first time — it does not prove the SSE stream is gapless.**
   See the parent spec's "Status log — 2026-08-23" for the full comparison table and the caveat.
