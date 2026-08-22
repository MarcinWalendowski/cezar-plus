# Brief — consolidate the duplicate "deploy probe can't measure SSE" todos, and judge the broker-restart pair

**For task 810b95ed. Gather-the-record step only — no spec, no code, no todo mutation done here.**

## The problem, in this repo's own terms

`.ai/cezar/todos.json` (7 UUIDs, all `status: "todo"`, filed 2026-08-21 19:03–19:08 UTC in a
single ~5-minute window by different sessions converging independently on the same E2E run) holds
two clusters that need a decision before anyone starts fixing them:

**Cluster A — five todos, one defect.** `packages/cezar/scripts/deploy-e2e-probe.mjs` subscribes
to `/api/v1/events` (SSE) with no credential; on the hosted box (`prod-host`, `CEZ_AUTH=oidc`)
every attempt gets 401, so `sse.events` stays 0. The probe then computes `'c: no seq gaps'` /
`'c: no seq duplicates'` (and, when `RUN_ID` is set, `'a: run never left running'` / `'a: no
interrupted event'`) as vacuously **TRUE** over an empty observation set, and reports
`passed: true`. Filed as: `06a170b8`, `6f4a9f62`, `e36b79c0`, `58e5954c`, `8dc8bf3a`.

**Cluster B — two todos, possibly-related-possibly-not defects**, both about a brokered run not
surviving some deploy/restart path: `45813876` ("RE-LAUNCHED, not re-attached, across a blue-green
cutover") and `7f92bd31` ("survives `systemctl restart` but not a full `stop` — isolation is
`delegated`, not `scope`").

## What the record already decided, with citations

- `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (KB `specs-594acc539b36`) is the
  parent spec for all seven todos. Its status line: **"QA Needed — REOPENED 2026-08-21 19:05
  UTC... criterion 1 does not hold on the blue-green cutover path... Criterion 2 stands."** The
  spec's own "Criterion 1 was reopened" section (~line 1081) already documents the re-attach
  failure byte-for-byte and **names `45813876`** as its filed todo; the same section documents the
  SSE-401 vacuous-pass finding and **names `58e5954c`** as its filed todo, with `8dc8bf3a`
  appearing later (~line 1190) covering what reads as the same vacuous-assertion finding a second
  time. The spec text itself is therefore evidence that `58e5954c` (not the other four) is the id
  the spec's own narrative already points to for cluster A — worth weighing in step 2, not a final
  call made here.
- Two spec-tracked, code-confirmed sibling fixes exist and are **not duplicates of either
  cluster**, confirmed by sub-agent code reading:
  - `specs-72b289500380` ("The one-shot `cezar run` CLI must not exit while its brokered run is
    still in flight") — **IMPLEMENTED, SHIPPED 2026-08-22**, commit `3e6d1b7e`. Fixes an unref'd
    keep-alive timer in `brokered-session.ts` for the **CLI** path (`cezar run`, not `cezar
    serve`). Unrelated to blue-green cutover or SSE auth.
  - `specs-7864d0810713` ("the run broker stalls a one-shot `cezar run` at its first agent step")
    — the discovery record for the same CLI-stall defect above. Also unrelated to clusters A/B.
- No other KB hits for `runBrokerIsolation`, `deploy-e2e-probe`, or `broker-isolation` beyond the
  above and a background provisioning note (`notion-41a043347b70`).

## Code actually involved (current HEAD, confirmed by direct reading — not the todos' 08-21 description)

**Cluster A**, `packages/cezar/scripts/deploy-e2e-probe.mjs` (last touched by `954c6a55`,
2026-08-21 14:41 — *before* any of the five todos were filed; nothing has changed since):
- `--header` credential support already exists and is wired into every fetch, including the SSE
  subscribe (`:39-44`, `:103-105`) — todos asking for "give it a credential" are asking to *use*
  an existing flag operationally (or fix a gap in it), not necessarily add new plumbing.
- The vacuous-assertion computation is exactly as described, unconditional, no sample-size guard:
  `:199-211` (`'c: no seq gaps': gaps.length === 0`, etc.; `[...runStatuses].every(...)` on a
  possibly-empty set).
- Only pass/fail exists (`:239`, `:248`) — no third "not measured" state anywhere in the code or
  output shape.
- A 401 is caught and pushed into `sse.errors`, then retried until deadline (`:106`, `:129-132`)
  — never a hard/early error.
- `maxLatencyMs` **is** populated (`poll.maxLatencyMs`, `:65`, reported as `gapMs` at `:223`) — it
  comes from the independent `/api/v1/ready` poller, not the SSE half, so `8dc8bf3a`'s acceptance
  criterion about it is already met and not part of the real gap.

**Cluster B**:
- Blue-green cutover's only systemd action is `systemctl restart <unit>`, once, for both
  `restart` and `blue-green` strategies — `packages/cezar/src/server-install/deploy-strategy.ts:149-153`
  → `release-deploy.ts:170-173` (`restart(unit) { run('systemctl', ['restart', unit]); }`). **No
  `systemctl stop` appears anywhere in either file.**
- `core/broker-isolation.ts:148-161` (`probeUserScope()`) is confirmed current and matches
  `7f92bd31`'s claim: delegated isolation (missing `XDG_RUNTIME_DIR` inside `cezar.service`)
  survives `systemctl restart` (`KillMode=process` only signals MainPID) but not a full `stop`
  (which empties the cgroup) — the file's own comment states this at `:152-154`.
- The spec's own re-measurement (`2026-08-19-non-disruptive-cezar-self-deploy.md:1104-1106`) found
  the **opposite** pairing empirically: a bare `systemctl stop → start` left the broker alive
  (reparented to PID 1); the blue-green cutover (a `restart`) killed it. This is inverted from
  what `7f92bd31`'s verified mechanism would predict for a `restart`.

## Judgment on Cluster B (fact-finding only; not a spec decision)

Based on the above, **45813876 and 7f92bd31 read as different defects**, not one seen from two
angles: `7f92bd31`'s root cause (delegated cgroup isolation, dies on `stop`, survives `restart`)
does not predict `45813876`'s trigger (blue-green's cutover is a plain `restart`, and a bare
`stop→start` survived in the same measurement session while the cutover `restart` did not). The
parent spec's own suspect list for `45813876` (`:1107-1110`) points at the symlink-flip/dataDir
resolution or spool-offset persistence, not at cgroup/isolation mode. Neither should be closed as
redundant of the other on current evidence — but this brief does not carry authority to close
anything; step 2 should make and record that call explicitly per the acceptance criteria.

## Operational gap step 2/3 will hit: the todo API can't write what "closed, pointing at it" needs

- `cezar todo` CLI exposes only `add` and `list` (`packages/cezar/src/todo-cli.ts:53-63` dispatch,
  confirmed by `--help` output — no `close`/`update`/`show` subcommand exists).
- The HTTP API does have `PATCH /api/v1/todos/:id` and `DELETE /api/v1/todos/:id`
  (`server.ts:5827`, `:5837`), backed by `updateTodo()`/`removeTodo()` in `todos.ts:250,293`. But
  `updateTodoInputSchema` (`contract/src/skills.ts:151-160`) accepts **only** `status` (enum
  `todo`/`in-progress`/`blocked`/`done` — no `duplicate`/`closed`/`dismissed` value exists),
  `priority`, and `archived`. **There is no field to edit `summary`/`context` on an existing
  todo.**
- Consequence: "close the duplicates with a pointer to it" and "note in the survivor which
  sessions observed it" cannot be done by patching the existing rows in place — there is no API
  surface to add that text. The realistic mechanisms are (a) delete the duplicates
  (`removeTodo`/DELETE) and fold their citations into one freshly-`cezar todo add`'d consolidated
  entry, or (b) hand-edit `.ai/cezar/todos.json` directly (bypassing the `O_EXCL` write-lease
  `withTodosLease` normally provides, `todos.ts:~90-` area — acceptable for a one-off local edit
  outside a running server, but worth being deliberate about). Step 2 needs to pick one; this
  wasn't visible from the todos' own text.

## Open questions a spec/consolidation step will have to settle

1. **Cluster A survivor.** Which of the five (`06a170b8`, `6f4a9f62`, `e36b79c0`, `58e5954c`,
   `8dc8bf3a`) becomes the one kept-open id? Candidates worth weighing: `58e5954c` (the id the
   parent spec's own narrative already cites), `8dc8bf3a` (most complete acceptance criteria: adds
   the "every assertion carries a sample count" framing and a `deploy-e2e-probe.mjs:204`
   line-citation), `e36b79c0` (only one that also requires the *spec's* Verification section be
   updated once the probe is fixed). All five are otherwise the same defect with overlapping but
   non-identical acceptance-criteria wording — the survivor's criteria should probably be a
   superset merge, not a single todo's text verbatim.
2. **Mechanism for closing.** Delete + recreate, or hand-edit `todos.json`, or is adding a
   `close`/`patch --note` CLI verb itself in scope for this task? (Probably not — the task is
   "consolidate," not "extend the todo tool," but worth an explicit call rather than a silent
   assumption.)
3. **Cluster B disposition.** This brief's read is "different defects, keep both open" — step 2
   should either ratify that explicitly (satisfies the acceptance criterion either way: "judged
   same or different") or find evidence this brief missed.
4. **The rare connect-error note in `6f4a9f62`** ("one connect error in 1185 requests... worth
   chasing") and **`8dc8bf3a`'s per-assertion sample-count ask** are real content, not boilerplate
   — whichever survivor is chosen must carry them forward, not just the shortest summary line.

## What I could not verify

- Whether `.ai/deploy-targets.json` or the E2E runbook has any existing convention for supplying
  the SSE probe a credential in CI/automation (vs. an operator manually passing `--header`) — not
  checked; relevant to whether cluster A's fix is "make the probe safe by default" or "also wire a
  credential source."
- Did not read `RunManager.recover()` itself for `45813876`'s three suspects (offset/spoolDir
  persistence, dataDir resolution after symlink flip) — out of scope for a todo-consolidation
  brief; would be step 2's job if `45813876` proceeds to a fix rather than just staying filed.

## Facts that most constrain the design

- The parent spec (`specs-594acc539b36`) **already cites `45813876` and `58e5954c` by id** in its
  own reopened-criteria narrative — any consolidation should keep those two ids stable rather than
  renumbering, or the spec's own cross-references break.
- The probe code is unchanged since before any of the five cluster-A todos were filed — this is
  pure inbox duplication, not five people looking at five different code states.
- Blue-green's only systemd action is `restart`, never `stop` — this rules out "same root cause as
  7f92bd31" as the explanation for `45813876`, contrary to what the task's framing suggested might
  be the case.
- **The todo API has no way to attach a "closed, see X" note to a row** — only
  `status`/`priority`/`archived` are patchable, and there's no CLI `close` verb. Step 2 must pick a
  concrete mechanism, not assume one.
