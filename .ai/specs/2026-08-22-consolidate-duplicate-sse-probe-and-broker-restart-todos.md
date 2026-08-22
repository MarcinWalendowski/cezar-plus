# Consolidate the duplicate "deploy probe can't measure SSE" todos, and judge the broker-restart pair

**Status:** Draft — spec only, no code or todo mutation done in this step.
**Date:** 2026-08-22
**Parent spec:** `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (KB `specs-594acc539b36`)
— cites four of this spec's seven todos by id in its own evolving narrative (see "What the record
already decided", below). This spec does not edit that file; a later step may want to, but nothing
here requires it (see Risks).
**Todos in scope:** `06a170b8`, `6f4a9f62`, `e36b79c0`, `58e5954c`, `8dc8bf3a` (cluster A — the SSE
probe gap), `45813876`, `7f92bd31` (cluster B — the broker-restart pair), and `ae96d775` — this
task's own tracking todo (`startedTaskId` matches this run's id) — archived by Phase 2 once the
consolidation runs, since its two acceptance criteria are exactly what this spec satisfies. Eight
todos modified in total. A ninth, `6c89af7c`, is read but **never modified** — see "Problem" (cluster
A) and Phase 2 for why cluster A's consolidation must not duplicate it. All nine read from
`.ai/cezar/todos.json` directly, 2026-08-22 (see "Sources read").
**Brief:** `.ai/specs/briefs/2026-08-22-consolidate-duplicate-sse-probe-todos.md` — read in full
before writing this spec; every factual claim below was re-verified against the code and
`todos.json`, not taken on the brief's word, and this spec **reverses one of the brief's two
judgment calls** (cluster B — see "Cluster B: same defect, reversing the brief's read", below).

## TLDR

Housekeeping filed the same defect five separate times — `deploy-e2e-probe.mjs` gets 401 on
`/api/v1/runs/${RUN_ID}/events` because the hosted box is OIDC-gated and the probe sends no
credential, so its SSE seq-continuity assertions (`gaps.length === 0`, `duplicates.length === 0` at
`deploy-e2e-probe.mjs:204-205`) pass **vacuously** over zero observations, and `passed: true` is
reported anyway. Confirmed unchanged in the file today: last touched by `954c6a55` (2026-08-21
14:41), before any of the five todos were filed. Separately, two todos about a brokered run not
surviving a deploy — `45813876` ("re-launched, not re-attached, across blue-green") and `7f92bd31`
("survives `restart` but not a full `stop` — isolation is `delegated`, not `scope`") — need an
explicit same-or-different call.

**Cluster A (five todos, one defect, unresolved):** `06a170b8`, `6f4a9f62`, `e36b79c0`, `58e5954c`
all get archived; `8dc8bf3a` survives as the single open todo for this gap. It was filed last
(19:06:44 UTC, the other four between 19:03:38 and 19:04:37), and its own acceptance criteria are
already the most complete of the five (per-assertion sample counts, hard-fail on non-200, and the
`maxLatencyMs` check the other four don't ask for). Two things worth keeping from the others do not
survive in `8dc8bf3a`'s own text as written, so they are folded in explicitly: `e36b79c0`'s ask that
the parent spec's own Verification section be updated once this is fixed, and `6f4a9f62`'s own
fourth acceptance criterion — that the parent spec's Status line drop its "SSE continuity remains
unmeasured" qualifier once the assertion runs green. `6f4a9f62`'s *other* distinguishing note — "one
connect error in 1185 requests" — is **not** folded forward: open todo `6c89af7c` (filed 18:42,
before all five) already owns that exact finding with a larger sample (3 errors in 4864 requests
over 5 restarts) and its own acceptance criterion for it; folding it onto `8dc8bf3a` too would
recreate the duplicate this spec exists to remove. `ae96d775` — this task's own tracking todo — is
archived in Phase 2 once the consolidation runs, since its two acceptance criteria are exactly what
this spec satisfies.

**Cluster B (two todos, one defect, mostly resolved already):** the brief judged these **different**
defects, reasoning that blue-green's only systemd action is `systemctl restart` (confirmed again
here: `deploy-strategy.ts` → `release-deploy.ts:170-173`, no `stop` call anywhere), which doesn't
match `7f92bd31`'s claim that delegated isolation survives `restart` but dies on `stop`. **This spec
reverses that call.** Read past the restart/stop framing, both todos' own root-cause text converges
on the identical mechanism: `probeUserScope()` (`core/broker-isolation.ts`) misclassified the box as
`delegated` isolation because `XDG_RUNTIME_DIR` is unset inside `cezar.service` — `45813876` lists
this as its own suspect 3 ("isolation is `delegated`, not `scope`"); `7f92bd31` is the investigation
that confirmed it, verified the working fix, and names the exact same two commits
(`fde2dae8`, `cf334d89`) that landed the same day. `45813876` survives (the parent spec already
cites it by name); `7f92bd31`'s root-cause diagnosis and its sharper, verification-oriented
acceptance criteria are folded in. One residual tension is recorded rather than argued away: the
restart-vs-stop question the brief raised is real and unresolved by this spec — it becomes a note on
the surviving todo, not a reason to keep two open.

No source code changes are required to run the fix these todos describe — this spec is entirely
about the todos themselves. One small, tightly-scoped code change is proposed anyway (Phase 1):
`updateTodo()`'s patch type currently has no field to edit `context`/`acceptanceCriteria` on an
existing row, which is what "close it, pointing at the survivor, carrying its content forward"
actually requires done safely (a live `cezar serve` process, `pid 1992290` on this box, holds this
exact project's `todos.json` lease-protected against concurrent writers — a raw hand-edit of the
file bypasses that). Phase 2 uses it to perform the consolidation.

## Problem

### Cluster A, restated precisely

`packages/cezar/scripts/deploy-e2e-probe.mjs` runs two independent measurements across a cutover:
a 10 rps poller against `/api/v1/ready` (works — `poll.ok`/`poll.nonOk` are real counts), and an SSE
subscriber against `/api/v1/runs/${RUN_ID}/events` (`:103` — not the shorter `/api/v1/events` the
todos themselves use as shorthand) meant to prove `seq` continuity across a reconnect. `subscribe()`
returns early with no observation at all when `--run` is not passed (`:99`, `if (!RUN_ID) return;`)
— a second, distinct way the vacuous-PASS reports below can fire, beyond the 401. On
`prod-host` (`CEZ_AUTH=oidc`, confirmed live) every SSE attempt gets 401; the probe pushes the
401 into `sse.errors` and retries until the deadline (`:106`, `:129-132`) — never a hard failure.
`sse.seqs` therefore stays `[]`, and:

```js
// deploy-e2e-probe.mjs:199-211
'c: no seq gaps': gaps.length === 0,        // true on an empty array
'c: no seq duplicates': duplicates.length === 0,  // true on an empty array
```

compute **TRUE** over zero events, `passed: Object.values(assertions).every(Boolean)` reports
`true`, and nothing in the report shape (`poll`/`sse`/`run`/`assertions`/`passed` — `:213-238`)
distinguishes "measured and passed" from "never observed." Five sessions independently found this
same defect within a three-minute window on 2026-08-21 (19:03:38–19:06:44 UTC, all `origin: agent`
per `todos.json`), each filing its own todo:

| id | filed (UTC) | distinguishing content |
| --- | --- | --- |
| `06a170b8` | 19:03:38 | first filing; general framing |
| `6f4a9f62` | 19:04:14 | rare-failure note (superseded by `6c89af7c`, filed earlier with a larger sample — see below) plus a fourth AC on the parent spec's Status line |
| `e36b79c0` | 19:04:35 | **the spec-hygiene ask**: parent spec's Verification section should state which half of criterion 2 each artifact proves |
| `58e5954c` | 19:04:37 | ties the vacuous PASS to direct corroborating evidence (broker pid gone / spool rewritten — actually cluster B's evidence, cited here only as "the PASS was contradicted") |
| `8dc8bf3a` | 19:06:44 | **most complete**: per-assertion sample counts, hard-fail on non-200 (not accumulate-and-ignore), and the only one of the five that also checks `maxLatencyMs` |

The parent spec's own narrative cites four of these five by id, at four different points as its
investigation evolved: `06a170b8` (line 1009), `e36b79c0` (line 1060), `58e5954c` (line 1117),
`8dc8bf3a` (line 1190) — only `6f4a9f62` is never named in the parent spec's text. This matters for
picking a survivor: **archiving preserves an id and its row**, so any of the four spec-cited ids
remains a resolvable link after consolidation — "keep the spec-cited id stable" does not, on its
own, pick a single winner among four.

`8dc8bf3a`'s fourth acceptance criterion — "`maxLatencyMs` is populated... rather than null" — and
its own context text ("`maxLatencyMs` came back null in all five artifacts") are both half-right,
and reconciling them matters for who owns this: the probe's report has no field literally named
`maxLatencyMs` (confirmed: `poll.maxLatencyMs`, `:65`, is an internal accumulator, reported to the
artifact only as `poll.gapMs`, `:223`) — so a check for the literal field name would indeed find it
absent, but the underlying measurement is not null; all five artifacts carry real numbers under
`gapMs` (62 / 986 / 1127 / 1129 / 1136 ms). That is the same measurement open todo `6c89af7c`'s
second acceptance criterion already asks for ("worst-case cutover latency is measured and recorded
in the spec, or reduced") — so, read as a request for that number to exist, `8dc8bf3a`'s AC4 is
already satisfied and substantively owned by `6c89af7c`. It stays on `8dc8bf3a` as written, not
folded into `6c89af7c` and not deleted: read narrowly it is a probe-report naming-consistency ask
(call the field what the spec's own vocabulary calls it) rather than a duplicate measurement
request, and this consolidation does not extend to rewriting `8dc8bf3a`'s own acceptance criteria
beyond what's needed to remove the cross-todo duplication addressed above.

### Cluster B, restated precisely, and why the brief's "different defects" call doesn't survive a closer read

Both todos are about the parent spec's criterion 1 ("a deploy mid-run leaves the run alive and
streaming"), reopened 2026-08-21 19:05 UTC after a controlled measurement (parent spec, "Criterion 1
was reopened by a controlled re-measurement") found a run's broker pid gone and its spool rewritten
from byte zero across a blue-green cutover — `RunManager.recover()` took the interrupted branch, not
the re-attach branch.

`45813876` (filed 19:04:38) names three suspects, in order, and asks that the correct one be
determined:
1. `consumedOffset`/`spoolDir` never persisted onto the run record.
2. The release flip changes the resolved `dataDir`/runs path.
3. **"the broker is killed as part of the deploy's restart because it is in the service cgroup
   (`runBrokerIsolation` reports `delegated`, not `scope`) — `KillMode=process` protects it from a
   plain restart but the deploy may stop the unit differently."**

`7f92bd31` (filed 19:08:15, ~3.5 minutes later) is the investigation of exactly that suspect 3,
confirmed rather than merely proposed: `probeUserScope()` (`core/broker-isolation.ts`) requires
`env.XDG_RUNTIME_DIR`, which is unset inside `cezar.service`, so the probe silently concludes
`scope` isolation is unavailable and `chooseIsolation()` falls back to `delegated` — the broker
shares `cezar.service`'s own cgroup, protected only by `KillMode=process`. The todo names its own
fix as **already landed in the same session**: `probeUserScope` now derives `/run/user/<uid>` when
the env var is absent, and the broker spawn merges `userScopeEnv()` into the child's env in `scope`
mode (the allowlist in `buildChildEnv()`, `core/claude-cli-runner.ts`, was dropping the variable
otherwise). Both of those are real, present-tense code facts, not aspirational — and this spec found
the same two commits (`fde2dae8`, `cf334d89`) independently confirmed, live, by a second,
contemporaneous investigation: an **uncommitted, untracked** draft spec written by a different,
concurrent task, found on disk at
`.ai/specs/2026-08-22-brokered-run-survive-bluegreen-cutover.md` (`git status --short` shows `??`;
not part of this or any branch — cited here as corroborating evidence found in the shared
filesystem, not as an authoritative merged document, since it may be rewritten or discarded by its
own task). That draft independently ruled out `45813876`'s suspects 1 and 2 by reading
`spoolDirOf()`/`spoolDirFor()` (`workflows/run.ts:1731`, `core/run-spool.ts:128` — neither is
release-path-sensitive), confirmed suspect 3 by the same `probeUserScope()`/`XDG_RUNTIME_DIR`
mechanism, and measured it live and fixed: `GET /api/v1/health` on the current release reports
`runtime.runBrokerIsolation: "scope"`, real per-run `cezar-run-*.scope` units exist under
`user@999.service`, and five runs — including that task's own — logged the re-attach line
(`"cezar restarted — this run kept going"`) across the 2026-08-22 04:18:35Z cutover.

**So `45813876` and `7f92bd31` are the same defect**: `7f92bd31` is the root-cause diagnosis of
`45813876`'s own suspect 3, and independent evidence (a second investigation, unrelated to either
todo, reading different code) confirms it is the *only* one of the three suspects that fits — not
one plausible angle among several left open.

**The residual tension, recorded rather than resolved:** the brief's objection is a genuine, still
partly-open loose end, not a misreading. `45813876`'s 19:02:41 measurement happened during a real
blue-green cutover, and this spec re-confirmed the code path for that cutover calls
`systemctl restart <unit>` only — `packages/cezar/src/server-install/deploy-strategy.ts:118,153`
and `release-deploy.ts:170-173` (`restart(unit) { run('systemctl', ['restart', unit]); }`), no
`systemctl stop` anywhere in either file. `7f92bd31`'s own mechanism, as stated in its text, predicts
survival under a plain `restart` (`KillMode=process` signals only `MainPID`) and death only under a
full `stop` (which empties the cgroup) — which is the *opposite* of what `45813876` measured on the
cutover. Two ways this could resolve, neither chased down by this spec (out of scope — this is a
consolidation spec, not a fix-verification one): either `systemctl restart`'s stop-phase behaves
differently from a plain `stop` for a non-empty delegated cgroup in a way neither todo's author
tested directly, or the 19:02:41 incident's actual trigger was something adjacent (a manual
stop/start in the same window, a daemon-reload, a rollback path) that isn't captured in either
todo's transcript excerpt. This does not change the same-defect judgment — both todos' root-cause
investigations name the identical code mechanism and the identical fix commits — but it is real
enough to carry forward explicitly rather than silently drop, per the parent brief's own instinct
not to let a real defect go unrecorded. It becomes a note on the surviving todo (Phase 2, below), not
a blocker to consolidating.

### The operational gap: nothing in the todo API can write what "closed, pointing at it" needs

`cezar todo` exposes only `add`/`list` (`packages/cezar/src/todo-cli.ts:44`, dispatch table).
`updateTodo()` (`packages/cezar/src/todos.ts:293-304`) is the only write path that can touch an
*existing* row, and its `UpdateTodoPatch` type (`:275-279`) accepts exactly three keys —
`status`, `priority`, `archived` — no field to edit `summary`/`context`/`acceptanceCriteria`. There
is no `duplicate`/`closed` value in the `status` enum (`todo`/`in-progress`/`blocked`/`done` only,
`todos.ts:55`) — `archived: true` (which stamps `archivedAt`, `:300`, and "leaves the Active board"
per the comment at `:58`) is the closest existing primitive to "closed," and it preserves the row's
id and content rather than deleting it, which is what makes an archived duplicate still a resolvable
link for anyone who has the old id memorized or linked from elsewhere (the parent spec, for four of
these seven).

A raw hand-edit of `.ai/cezar/todos.json` — the brief's fallback option — is riskier here than in
the general case the brief described ("acceptable... outside a running server"): a live
`cezar serve` process is running on this exact box (`pid 1992290`,
`/opt/cezar/packages/cezar/dist/index.js serve --bind-host 127.0.0.1 --port 4321`), and per the
`ProjectContexts.build()` lazy-open pattern this box's own boot project uses, it can open this
non-boot project's `RunStore`/todos access on demand — e.g. anyone loading this project's Filed
board, or another running task filing a todo here concurrently. `withTodosLease()`
(`todos.ts:169-176`) is the one thing every writer in this codebase goes through to avoid exactly
that race; a script that writes `todos.json` directly, bypassing it, could silently lose a
concurrent write.

## Solution

Extend `updateTodo()`'s patch type with two more optional, additive fields —
`context`/`acceptanceCriteria` — so a one-off maintenance script can perform the whole consolidation
through the existing, already-exported, lease-protected write path, instead of either hand-editing
the file or inventing a new CLI verb / HTTP surface (out of scope — see "What this is not").

### What this is not

- **Not a new CLI verb.** `cezar todo close`/`cezar todo patch` is not added. The two new
  `UpdateTodoPatch` fields are used by the one-off script this spec's Phase 2 runs once; nothing
  about the CLI's `add`/`list` surface changes.
- **Not a new wire/HTTP capability.** `contract/src/skills.ts`'s `updateTodoInputSchema` (the
  `PATCH /:projectId/todos/:id` body validator) is **not** touched — the composer UI's Archive/
  Restore/status/priority editing is unaffected, and the two new fields are reachable only by code
  that imports `updateTodo` directly (the maintenance script), not over HTTP. If a future task wants
  the composer UI to support editing a todo's content, that is a real, separate feature with its own
  spec — this one deliberately does not smuggle it in.
- **Not a fix to `deploy-e2e-probe.mjs` or `core/broker-isolation.ts`.** Both defects stay exactly
  as filed (cluster B's fix already landed in code, per `7f92bd31`'s own text and the corroborating
  draft spec — this spec doesn't re-verify or re-land it); this spec only touches the todo records
  that track them.
- **Not an edit to the parent spec.** Its "filed as `X`" mentions are historical narration, true at
  the time they were written; an archived todo keeps its id and content, so those citations still
  resolve to something real and dated after this consolidation. Nothing forces an edit there, though
  a later step is free to add a pointer to this spec if it wants one.

## Architecture

No architectural change. `.ai/cezar/todos.json` remains a single JSON array per project, gitignored
(`.gitignore:11`), guarded by the existing `O_EXCL` lock-file lease (`todos.lock`, created and
released inside `withTodosLease`). This spec adds two optional keys to the in-process patch type
`updateTodo()` already accepts; the on-disk schema (`todoSchema`, `todos.ts:37-79`) already has both
fields (`context: z.string().max(20_000).optional()`, `acceptanceCriteria: z.array(...).max(20)`) —
they're settable on create but not on update today, so this is a capability gap closed, not a new
field.

## Data models

`UpdateTodoPatch` (`packages/cezar/src/todos.ts:275-279`), before:

```ts
export type UpdateTodoPatch = {
  status?: TodoItem['status'];
  priority?: TodoItem['priority'];
  archived?: boolean;
};
```

After (two additive, optional keys — every existing caller, including the HTTP route, is
unaffected since neither is ever populated from the wire schema; the type's own doc comment is
amended in the same edit, since "field-for-field" is no longer true once these land):

```ts
/** `PATCH /:projectId/todos/:id`'s body, server-side — mirrors the wire twin's
 *  `updateTodoInputSchema` (`contract/src/skills.ts`) field-for-field, EXCEPT `context` and
 *  `acceptanceCriteria` below, which are maintenance-only additions with no wire-schema
 *  counterpart (added 2026-08-22 for one-off todo-consolidation scripts; never populated from
 *  an HTTP body). */
export type UpdateTodoPatch = {
  status?: TodoItem['status'];
  priority?: TodoItem['priority'];
  archived?: boolean;
  /** Maintenance-only: not settable via the wire schema / composer UI. */
  context?: TodoItem['context'];
  /** Maintenance-only: not settable via the wire schema / composer UI. */
  acceptanceCriteria?: TodoItem['acceptanceCriteria'];
};
```

`updateTodo()` body (`:293-304`), the two lines added after the existing `archived` branch:

```ts
if (patch.context !== undefined) item.context = patch.context;
if (patch.acceptanceCriteria !== undefined) item.acceptanceCriteria = patch.acceptanceCriteria;
```

Both stay inside `todoSchema`'s existing bounds (`context` ≤ 20,000 chars, `acceptanceCriteria` ≤ 20
entries) — the merged content computed in Phase 2 must be checked against those caps before the
script runs (see Verification).

## API / interface contracts

No wire contract changes. `contract/src/skills.ts`'s `updateTodoInputSchema` and the
`PATCH /:projectId/todos/:id` route are untouched — the two new `UpdateTodoPatch` keys are reachable
only by code calling `updateTodo()` directly from within the `packages/cezar` process (the
maintenance script), never from an HTTP body. `readTodos()`'s contract (already lease-free for
reads, per its own doc comment) is unchanged.

## Phases

### Phase 1 — extend `UpdateTodoPatch` (small, additive, no wire/UI surface)

- Edit `packages/cezar/src/todos.ts`: add `context`/`acceptanceCriteria` to `UpdateTodoPatch`
  (`:275-279`) and the two corresponding assignment lines in `updateTodo()` (after `:301`).
- Amend `UpdateTodoPatch`'s own doc comment (`:273-274`, currently *"mirrors the wire twin's
  `updateTodoInputSchema` (`contract/src/skills.ts`) field-for-field"*) to record the deliberate
  divergence this phase introduces: the two new fields exist only in this in-process type and are
  never present in the wire schema, so "field-for-field" stops being true the moment they land, and
  the comment must say so rather than leave the next reader to discover it by diffing the two types.
- No other file changes. `contract/src/skills.ts`, `todo-cli.ts`, and every HTTP route stay as-is.
- Independently shippable and independently valuable even if Phase 2 is deferred — it closes the
  operational gap the brief flagged for *any* future todo-consolidation, not just this one.

### Phase 2 — run the consolidation (data operation, no further source changes)

A short one-off script (e.g. `tsx` invoked directly against `packages/cezar/src/todos.ts`'s
`readTodos`/`updateTodo`, not committed as a permanent CLI feature — same throwaway-but-auditable
spirit as the existing `.ai/scripts/e2e.sh`) performs, under the dataDir
`/var/lib/cezar/loki-labs/cezar/.ai/cezar`:

**Full ids.** `updateTodo()` matches `t.id === id` **exactly** (`todos.ts:296`,
`items.find((t) => t.id === id)`) — there is no prefix resolution anywhere in `todos.ts` or
`todo-cli.ts`. Every call below is written with the 8-char shorthand used throughout this spec for
readability, but the script itself must use the full id, or it silently no-ops: `updateTodo` returns
`undefined` on a miss, with no throw and no log, so a call written against an 8-char prefix would
exit clean having done nothing.

| shorthand | full id |
| --- | --- |
| `06a170b8` | `06a170b8-5118-46ec-81b9-97c9794f41e5` |
| `6f4a9f62` | `6f4a9f62-956b-4bf5-b849-df41d83dfd94` |
| `e36b79c0` | `e36b79c0-d848-4a6b-8263-a5b25b9d601c` |
| `58e5954c` | `58e5954c-5e51-443e-a2c9-fa875dabb0c1` |
| `8dc8bf3a` | `8dc8bf3a-4484-468c-a6fd-c1afcbc630d3` |
| `45813876` | `45813876-8a6b-49d4-ae2c-dfb502e83263` |
| `7f92bd31` | `7f92bd31-cbfc-4ab0-99fd-0c70a061d5e4` |
| `ae96d775` | `ae96d775-bdfe-4fd7-8c9a-749cc86b16c2` |

**Cluster A**
- `updateTodo(dataDir, '8dc8bf3a-4484-468c-a6fd-c1afcbc630d3', { context: <8dc8bf3a.context> + '\n\n' + CONSOLIDATION_NOTE_A, acceptanceCriteria: [...8dc8bf3a.acceptanceCriteria, <2 folded-in criteria>] })`
  where `CONSOLIDATION_NOTE_A` states: consolidated 2026-08-22, independently filed 5× within a
  3-minute window (06a170b8 19:03:38, 6f4a9f62 19:04:14, e36b79c0 19:04:35, 58e5954c 19:04:37, this
  one 19:06:44 UTC), the other four archived pointing here; folds forward `e36b79c0`'s
  parent-spec-Verification ask and `6f4a9f62`'s fourth acceptance criterion (both spelled out below,
  not just referenced by id, so the content survives even if the archived rows are later purged);
  and records that `6f4a9f62`'s *other* distinguishing content — the "1 connect error in 1185
  requests" note — is **not** folded here, because open todo `6c89af7c` already owns it with a
  larger sample (3 in 4864 over 5 restarts) and its own acceptance criterion, and that this todo's
  own fourth criterion (`maxLatencyMs`) is the same underlying measurement `6c89af7c`'s second
  criterion already asks for — see "Problem", above, for the full reconciliation of both.
  Folded-in acceptance criteria (verbatim from the archived todos, since `8dc8bf3a`'s own four don't
  cover them):
  - "The parent spec's Verification section states which half of criterion 2 each artifact actually
    proves (originally `e36b79c0`)"
  - "The parent spec's Status line drops the 'SSE continuity remains unmeasured' qualifier once the
    SSE assertion actually runs green (originally `6f4a9f62`, its fourth acceptance criterion)"
- For each of `06a170b8`, `6f4a9f62`, `e36b79c0`, `58e5954c` (full ids from the table above):
  `updateTodo(dataDir, <full id>, { archived: true, context: <original.context> + '\n\nCLOSED 2026-08-22 — duplicate of a defect independently filed 5× within a 3-minute window; consolidated into 8dc8bf3a, which carries this entry's distinguishing content forward (except the connect-error note, which 6c89af7c already owns with a larger sample — see there). See .ai/specs/2026-08-22-consolidate-duplicate-sse-probe-and-broker-restart-todos.md.' })`

**Cluster B**
- `updateTodo(dataDir, '45813876-8a6b-49d4-ae2c-dfb502e83263', { context: <45813876.context> + '\n\n' + CONSOLIDATION_NOTE_B, acceptanceCriteria: [...45813876.acceptanceCriteria, ...7f92bd31.acceptanceCriteria] })`
  where `CONSOLIDATION_NOTE_B` states the same-defect judgment and its basis (7f92bd31 is the
  root-cause diagnosis of this todo's own suspect 3; suspects 1/2 ruled out by an independent,
  contemporaneous investigation; fix already landed same day, commits `fde2dae8`/`cf334d89`; and the
  unresolved restart-vs-stop timing tension from "Problem", above, stated plainly rather than
  dropped). Combined acceptance criteria: 4 (original, spool/meta-level evidence) + 4 (from
  `7f92bd31`, cgroup/health-endpoint evidence) = 8, under the 20-item cap.
- `updateTodo(dataDir, '7f92bd31-cbfc-4ab0-99fd-0c70a061d5e4', { archived: true, context: <original.context> + '\n\nCLOSED 2026-08-22 — same defect as 45813876 (broker isolation delegated-vs-scope misclassification in core/broker-isolation.ts); this entry's root-cause diagnosis and acceptance criteria were merged into 45813876, the id the parent spec (.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md) already cites by name. See .ai/specs/2026-08-22-consolidate-duplicate-sse-probe-and-broker-restart-todos.md.' })`

**Cluster C — this task's own tracking todo**
`ae96d775` (`startedTaskId: 810b95ed-d652-40d4-955c-a51cf1f31de6`, this run) never got an explicit
disposition in the earlier draft of this spec. Nothing in `packages/cezar/src` archives a todo
automatically when its `startedTaskId` task finishes (`startedTaskId` is read only by `markStarted`,
autostart, and the CLI's "started" flag — never by an archival path), so left alone it stays on the
board describing already-finished work, and the next session sweeping for probe/SSE todos would find
it and re-run this consolidation. It is archived explicitly:
- `updateTodo(dataDir, 'ae96d775-bdfe-4fd7-8c9a-749cc86b16c2', { archived: true, context: <original.context> + '\n\nCLOSED 2026-08-22 — this task's own tracking todo; both acceptance criteria satisfied by this consolidation. Cluster A survivor: 8dc8bf3a. Cluster B survivor: 45813876. See .ai/specs/2026-08-22-consolidate-duplicate-sse-probe-and-broker-restart-todos.md.' })`

Script must be idempotent (skip an id that already has today's `CLOSED`/`CONSOLIDATED` marker in its
`context`, so a re-run after a partial failure doesn't double-append) and must run
`readTodos(dataDir)` immediately before writing to confirm all 8 ids in the table above are still
present, each resolves to exactly one entry, and none is already archived (fail loudly, change
nothing, if the on-disk state has moved since this spec was read — e.g. someone else already touched
one of these eight). After every `updateTodo()` call, the script must also assert the return value
is a defined `TodoItem`, not `undefined` — a defined-but-unexpected result would still mean the
write landed somewhere real and is worth inspecting, but an `undefined` return means the write
silently no-op'd (wrong id, already-archived guard, or a lease failure swallowed upstream) and must
abort the run rather than continue to the next id.

### Phase 3 — out of scope, named so it isn't silently assumed

- Actually re-verifying cluster B's fix across a real, non-self-referential blue-green cutover (the
  paired before/after pid/hash capture `7f92bd31`'s acceptance criteria ask for) is real work, not a
  todo-filing exercise — it stays open on `45813876` precisely because it hasn't been done yet by
  *this* task. The uncommitted draft spec found on disk proposes exactly this as its own Phase 2;
  whether that draft survives its own task is not this spec's call.
- Fixing `deploy-e2e-probe.mjs` itself (give it a credential, add an "unmeasured" report state,
  hard-fail on non-200) stays open on `8dc8bf3a` for the same reason.
- The connect-error/latency investigation stays open on `6c89af7c`, untouched by this spec — its own
  acceptance criteria (a keep-alive client sees zero connect errors across 10 consecutive cutovers;
  worst-case cutover latency is measured and recorded, or reduced) are real fix-verification work,
  not a todo-filing exercise, and this spec does not merge it into cluster A (see "Problem").
- Editing the parent spec to point at this consolidation is optional and not performed here (see
  "What this is not").

## Risks

- **Concurrency.** A live `cezar serve` process (pid `1992290`) manages this project's
  `todos.json`. Phase 1's lease-protected `updateTodo()` path is what makes Phase 2 safe against it;
  running Phase 2 through any other mechanism (hand-editing the JSON, a script that reimplements the
  lease incorrectly) reintroduces the exact race this spec exists to avoid. Verification (below)
  must include a lease-collision check, not just a before/after content diff.
- **`context` cap.** `todoSchema` caps `context` at 20,000 chars. `8dc8bf3a`'s and `45813876`'s
  originals plus their consolidation notes are each well under this (checked by eye against the
  quoted text above; the implementer must still measure, not assume, since the exact final string
  depends on formatting choices made when writing the script).
- **The restart-vs-stop tension is not actually resolved**, only recorded (see "Problem"). If a
  future measurement contradicts the same-defect judgment — e.g., a clean blue-green cutover in
  confirmed `scope` mode still loses a run, with no `XDG_RUNTIME_DIR`/isolation angle available as an
  explanation — that is new evidence against this spec's Phase 2 merge, not a reason the merge was
  unreasonable given what was known 2026-08-22.
- **The corroborating draft spec is not this task's own artifact.** It is cited as evidence found on
  disk, uncommitted, written by a different concurrent task. If it is never committed, or is
  rewritten with different conclusions, this spec's cluster-B judgment still stands on the two
  todos' own text (`45813876`'s suspect 3, `7f92bd31`'s confirmation of it) — the draft is
  corroboration, not the sole basis.
- **Losing content on a botched merge.** Archiving is non-destructive (the row and its original
  `context` survive, only `archivedAt` is added and a note appended) — but the *survivor's* `context`
  write is a full replacement of that field, so a script bug there could genuinely lose the
  original text. Verification must diff the survivor's original `context` as a strict prefix of the
  new one, not just check the new one is non-empty.
- **This spec's own file lives outside every worktree.** It was written into the main checkout at
  `/var/lib/cezar/loki-labs/cezar/.ai/specs/`, on `main`, untracked as of this writing — not into
  this task's own branch worktree (`$W/.ai/specs/` has no such file, matching the pattern the step-1
  brief already used). `.ai/specs/` is a tracked directory, not gitignored, so the path this spec's
  own `CLOSED`/`CONSOLIDATED` notes cite (see Phase 2) will be a dangling reference for anyone
  reading only the worktree's branch, unless a later step copies or commits this file into the
  branch before the todo writes land.

## Verification

Concrete, executable steps for the implementer (none of this is run in this spec-writing step):

1. **Gates**, from `/var/lib/cezar/loki-labs/cezar` (repo root, not this worktree, since
   `todos.json` and the live server are both rooted there — confirm the implementer runs Phase 2
   against the correct dataDir):
   `npm run typecheck` (must stay green after the `UpdateTodoPatch` edit — a two-field additive type
   change should not affect any existing caller) and `npm run test:unit`.
2. **Before/after count.** `cezar todo list --json | jq '.todos | length'` (or equivalent
   `readTodos` call) before and after Phase 2 — must be identical (archiving never removes a row).
3. **Archived count.** After Phase 2, exactly 6 of the 8 ids in scope (`06a170b8`, `6f4a9f62`,
   `e36b79c0`, `58e5954c`, `7f92bd31`, `ae96d775`) carry a truthy `archivedAt`; the other 2
   (`8dc8bf3a`, `45813876`) do not. `6c89af7c` is untouched — confirm its `archivedAt` is still
   absent and its `context`/`acceptanceCriteria` are byte-identical to the pre-Phase-2 read.
4. **Content-preservation check.** For each of the 6 archived ids, the pre-Phase-2 `context` string
   is a strict prefix of the post-Phase-2 `context` string (proves the append, not a destructive
   overwrite). For the 2 survivors, same check — original `context` is a strict prefix of the merged
   one.
5. **Schema validity.** `readTodos(dataDir)` (or `cezar todo list`) must not warn/drop any of these
   8 entries as malformed — proves the merged `context` stayed under 20,000 chars and merged
   `acceptanceCriteria` stayed at ≤20 entries (zod bounds, `todos.ts:63-64`).
6. **No collateral damage.** `todos.json` has ~many more entries beyond these 8 (268 KB file as of
   2026-08-22 03:03) — diff the full before/after JSON and confirm every entry outside the 8 in
   scope, including `6c89af7c`, is byte-identical.
7. **Lease respected, not bypassed.** Confirm the script's writes went through `updateTodo()`
   (code review of the script is sufficient — it should import and call the exported function, never
   read/write `todos.json` itself), and that `todos.lock` does not exist and is not left behind after
   the script exits (a leaked lock file would wedge every other writer).
8. **Every write actually landed.** For each of the 8 `updateTodo()` calls in Phase 2, confirm the
   script's own log (or a re-run against the id table) shows a defined `TodoItem` returned, not
   `undefined` — this is what catches a call accidentally written against an 8-char prefix instead of
   the full id (see Phase 2, "Full ids"); an `undefined` return anywhere means that write silently
   did nothing and the corresponding entry in steps 2–6 above would be wrong.
9. **Manual read.** Read back the final `context`/`acceptanceCriteria` for `8dc8bf3a` and `45813876`
   and eyeball that both consolidation notes are present, correctly worded, and that all 6 archived
   entries' pointer notes name the correct survivor id.
10. **Acceptance criteria mapping**, explicit, since this is what the task itself will be graded on:
    - AC1 ("one open todo covers the probe's SSE/401 gap; duplicates closed with a pointer to it") —
      verified by steps 2, 3, 8, 9 for cluster A; `6c89af7c` staying open and unmerged is intentional
      (see "Problem"), not a gap in this criterion.
    - AC2 ("45813876 and 7f92bd31 explicitly judged same or different, whichever is redundant is
      closed") — verified by this spec's "Problem" section text itself (the explicit judgment, with
      citations) plus steps 2, 3, 9 for cluster B.

## Sources read

- `.ai/specs/briefs/2026-08-22-consolidate-duplicate-sse-probe-todos.md` (this step's input brief).
- `.ai/cezar/todos.json` — all 9 in-scope entries read directly (`summary`, `context`,
  `acceptanceCriteria`, `ts`, `origin`, `startedTaskId`), not summarized secondhand — the original
  7, plus `6c89af7c` (read-only, cited in "Problem" to avoid re-duplicating its connect-error/latency
  finding) and `ae96d775` (this task's own tracking todo, confirmed by `startedTaskId` matching this
  run).
- `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` — grepped for all 7 ids; read the
  surrounding sections at lines ~1000-1130 and ~1180-1225 in full.
- `.ai/specs/2026-08-22-brokered-run-survive-bluegreen-cutover.md` — uncommitted/untracked, found on
  disk, read in full; treated as corroborating evidence only (see Risks).
- `packages/cezar/scripts/deploy-e2e-probe.mjs` — read in full (headers/auth handling, assertion
  computation, report shape).
- `packages/cezar/src/server-install/deploy-strategy.ts`, `release-deploy.ts` — grepped and read for
  the `restart`/`stop` question (confirmed: `restart` only, both strategies).
- `packages/cezar/src/todos.ts` — read in full (schema, lease, `readTodos`/`createTodo`/
  `removeTodo`/`updateTodo`).
- `packages/cezar/src/todo-cli.ts` — read for the `add`/`list`-only CLI surface.
- `git status`, `git log`, `git check-ignore`, `ps aux` — confirmed `todos.json` is gitignored, the
  draft spec is untracked, and a live `cezar serve` process (pid `1992290`) is running on this box.
