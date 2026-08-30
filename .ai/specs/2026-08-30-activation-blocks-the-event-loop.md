# The activation launch blocks the event loop for the whole deploy

**Status:** Implemented (2026-08-30)
**Extends** `.ai/specs/2026-08-29-resolve-runs-the-deployment.md` (S3a, the synchronous launch this
corrects) and `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (the cutover budget it
blows).
**Owner report:** "seems like cezar deployments take really long now for some reason".

## TLDR

`registerUnit` runs `spawnSync('systemd-run', …)` on the `POST /handoff/resolve` request path, and
the argv it is handed carries `--property=Type=oneshot`. **A oneshot start job is not complete
until the command exits**, so `systemd-run` does not return until the whole activation is over —
measured at 6049 ms for a 6-second command. `spawnSync` therefore blocks node's event loop for the
entire ~62 s deploy. Thirty seconds in, the activation's own `server-deploy` runs
`systemctl restart cezar.service`; the main process cannot run its `SIGTERM` handler, so systemd
waits out `TimeoutStopSec=30s` and `SIGKILL`s it. Half of every deploy is that timeout, the
graceful drain never runs, and the run store is never flushed.

The fix is one property: **`Type=exec`**. It returns in 24 ms for the same 6-second command and
still fails loudly when the unit cannot start, which is the property S3a made this call synchronous
to get.

## Problem

Measured on `prod-host`, the 07:04 UTC deploy on 2026-08-30 (activation log timestamps,
`/opt/cezar-releases/deploy.json`, `journalctl -u cezar.service`):

| phase | time |
|---|---|
| fetch + reset | 0.5 s |
| `npm ci` | 6 s |
| `npm run build` | ~18 s |
| rsync stage + smoke boot | 4.8 s |
| **`systemctl restart` waiting for `SIGKILL`** | **30.1 s** |
| readiness confirm | ~3 s |

```
07:04:57.509  Stopping cezar.service...
07:05:27.601  cezar.service: State 'stop-sigterm' timed out. Killing.
07:05:27.601  Killing process 924355 (node) with signal SIGKILL
```

**It is the launch, not the load.** The box has 16 cores, 30 GB RAM, no swap and no OOM events in
the window. The discriminator is the launch path: **4 of 4** Resolve-driven restarts took 30 s;
**0 of 5** restarts from a plain ssh `cez server-deploy` did — those took 46–130 ms. Every stop
between Aug 24 and Aug 29 17:01 was clean; the first 30 s timeout is Aug 29 17:25, the first press
after `a04cda25` shipped.

**The docblock encodes the bug.** `release-deploy.ts`'s `spawnDetached` says *"`systemd-run`
returns as soon as the unit is REGISTERED — it does not wait for the command — so this can be
synchronous and still hand control straight back"*, and `manual-activation.ts`'s `registerUnit`
reuses that reasoning. It is true for `Type=simple`, and false for the `Type=oneshot` unit
`buildSystemdRunArgv` actually builds. Nothing pinned the type, so nothing caught it.

### Three consequences, all measured

1. **The cutover budget is blown 30x.** `deploy.cutover` reports `gapMs` of 30164 / 30288 / 30090 /
   30133 against the 148 ms this design was built for. `cezar.socket` still holds
   `127.0.0.1:4321` (systemd pid 1 fd 218, node inherits it as fd 3, `LISTEN_FDS=1`), so **no
   connection is refused** — they queue in the 1024-deep backlog and nothing answers for 30 s. The
   "zero refused" criterion of `2026-08-19-non-disruptive-cezar-self-deploy.md` survives; the
   latency one does not.
2. **The drain and the flush never run.** No JS executes between `SIGTERM` and `SIGKILL`, so the
   bounded `CEZ_DRAIN_MS` window is irrelevant: no SSE `reload` frame, no WebSocket 1012, and
   `store.flush()` never happens. `runs.json` mtime stayed at the last *clean* restart (05:34)
   while the process that owned it was killed 90 minutes later at 07:05. **Run state is lost on
   every Resolve deploy, silently.**
3. **The idempotence check is dead.** `activate-main.sh` opens by curling the live
   `/api/v1/ready` for the running sha and logs `could not read a live sha` every time — because
   the server it is asking is the one blocked waiting for it. So `nothing to do: the live sha
   already contains origin/main` can never fire, and every press pays the full install + build +
   flip even when the box is already serving `main`.

## Solution

**S1 — `Type=exec`, not `Type=oneshot`.** For `Type=exec` the start job completes once the binary
has been successfully `exec`ed, so `systemd-run` returns immediately *and* still reports a unit
that could not start. Measured on `prod-host`, one `/bin/sleep 6`, four variants:

| variant | returns after | reports an unwritable `append:` target |
|---|---|---|
| `Type=exec` | **24 ms** | **yes (rc=1)** |
| `Type=oneshot` + `--no-block` | 10 ms | **no (rc=0, silent)** |
| `Type=oneshot` (today) | **6049 ms** | yes (rc=1) |
| `Type=simple` | 19 ms | (not probed; `exec` is strictly stronger) |

**`--no-block` is the wrong fix and is deliberately not used.** It returns fast by not waiting for
the start job at all, which reintroduces exactly the silent-failure mode `a04cda25` was written to
close: the `append:`-target failure that made the first production press fail invisibly. `exec`
keeps the verification and drops the wait.

**S2 — the same correction at the other call site.** `buildSystemdRunArgv` is shared with
`server-deploy`'s own cgroup escape (`release-deploy.ts` `spawnDetached`), which carries the same
false comment and the same latent block. One property fixes both; both docblocks are corrected in
place rather than appended to, per the workspace correction rule.

**S3 — the type is pinned by a test, with its reason.** The defect survived because no test
asserted the unit type. `self-safe-deploy.test.ts` and `manual-activation.test.ts` now both assert
`Type=exec` and assert the absence of `Type=oneshot`, citing the measurement.

## Architecture

Unchanged. The escape is still a `--user` transient unit outside `cezar.service`'s cgroup, still
`--collect`, still `KillMode=process`, still `RemainAfterExit=no`, still logging to the project's
own data dir. Only the moment at which systemd calls the start job complete changes, and with it
whether `spawnSync` returns before or after the deploy.

## Phases

Single phase — one property, two docblock corrections, two tests.

## Data models

None.

## API contracts

None. `registerUnit`'s signature and its `{ ok, error }` contract are unchanged; only its latency
changes, from "the duration of the deploy" to "the duration of an exec".

## Risks

- **A command that fails after exec is still not reported**, exactly as before: `exec` proves the
  binary started, not that it succeeded. That is the correct boundary — a click cannot learn the
  outcome of a deploy that restarts the process handling the click, which is why the
  post-restart park sweep is the mechanism (`2026-08-29-resolve-runs-the-deployment.md`, S3).
- **`Type=exec` requires systemd ≥ 240.** The box runs systemd 257; the no-systemd path is the
  existing `bash -lc` fallback and is untouched.
- **This does not make the deploy blue-green in the two-instance sense.** The smoke-booted
  candidate is still a throwaway on a scratch port that is `SIGKILL`ed before the flip, and the
  cutover is still an in-place `systemctl restart` over a socket-activated listener. Promoting the
  verified instance instead would need single-writer state under `.ai/cezar/` — `RunStore` is an
  in-memory map flushed wholesale, and a second live process pointed at the real state dir would
  overwrite everything the first wrote (`smokeBootRelease`'s own docblock). Out of scope; it buys
  ~1 s once this is fixed.
- The two open defects of `2026-08-19-non-disruptive-cezar-self-deploy.md` — intermittent
  keep-alive resets (`6c89af7c`) and 94 unexplained SSE sequence gaps (`8206c158`) — are unrelated
  to this and stay open.

## Verification

1. **Unit:** `buildSystemdRunArgv` emits `--property=Type=exec` and never `Type=oneshot`, asserted
   in `self-safe-deploy.test.ts` and through `activationArgv` in `manual-activation.test.ts`.
   Mutation check: restoring `Type=oneshot` must fail both.
2. **Gates:** `npm run typecheck`, `npm run lint`, `npm run test` green **on the box**, run twice —
   this repo has a load-sensitive flake pool and a Mac-only `fs.watch` failure.
3. **Runtime control, on the box (done before the change, recorded above):** four `systemd-run`
   variants against one `/bin/sleep 6`, timing the return and probing an unwritable `append:`
   target. This is the assertion that actually separates the fix from the bug; the unit test only
   pins the string that follows from it.
4. **Production E2E (owner, after deploy):** press Resolve on a parked run and check
   `journalctl -u cezar.service` for the absence of `State 'stop-sigterm' timed out`, a
   `deploy.cutover` `gapMs` back under ~1500 ms, and a `runs.json` mtime that advances across the
   restart. Until that press happens this ships as **QA Needed**, not Done.
