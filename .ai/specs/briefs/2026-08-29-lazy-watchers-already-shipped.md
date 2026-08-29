---
title: Brief — lazy-project-watcher fix is already implemented, tested and production-verified
task: abfcdb9c-e63b-4c0c-95c3-d331a86e39f7
step: 1 of 9, Gather the record
date: 2026-08-29
---

## The problem, as stated in this task

`cez todo start <id>` (and `cezar todo add --start`) only sets `autostart:true` on the
todo record; only the *running cockpit's* watcher on that project's `todos.json` turns
the flag into an actual run. `server.ts` wires `watchTodoAutostart` (~line 1737) and
`watchReopenRequests` (~line 1750) with an identical three-clause shape — boot context,
already-built contexts, `onContextBuilt` — and `ProjectContexts.context()` builds
**lazily**, on first API touch. So a registered project nobody has opened since the last
restart has no watcher on either `todos.json` or `reopen-requests.json`, and an
autostart/reopen flag set on it is never read. This was proved on production by
inotify against the server PID (predecessor todo `503195a8`): `workspace` and `cezar`
were watched, `chat` was not.

## Finding: this is not open work — it shipped and was verified on production the same day

This task id (`abfcdb9c-e63b-4c0c-95c3-d331a86e39f7`) **is not new**. Its own handoff
file (`$CEZ_HANDOFF_FILE`) shows a prior session already ran this task to completion
today, 2026-08-29, and left resume notes reading "COMPLETE." All three research
sub-agents independently confirmed this against the live record rather than trusting the
handoff's prose:

- **Root cause spec:** `specs-d1dfcc015a1f` / `.ai/specs/briefs/2026-08-25-lazy-project-watchers.md` — confirmed the defect at HEAD `2fd01a16`, one shared lazy-context problem behind two intent files (autostart + reopen), combining board todos `f09bf585` (autostart) and `503195a8` (reopen).
- **Fix spec:** `specs-4f72812590b9` / `.ai/specs/2026-08-25-lazy-project-watchers.md` — added `packages/cezar/src/server/lazy-project-intents.ts`, a passive, `watchFile`-based discovery service that polls pending-intent snapshots for non-resident registered projects and calls `contexts.context(id)` **only** when a pending flag is actually present. Landed in commit `809c8220` ("feat: implement lazy project watchers"), merged to `origin/main` as `e8a2b1d6`.
- **Verification spec:** `specs-1c4624683273` / `.ai/specs/2026-08-25-cold-watcher-production-verification.md` — status line: **"EXECUTED and VERIFIED 2026-08-29. Both production cold-project canaries passed against the live service (`deploy.sha = 17637629`, which contains the fix `809c8220`)."** Its own "Task" field names this same id, `abfcdb9c-e63b-4c0c-95c3-d331a86e39f7`, as the predecessor run.
- **KB corrections:** `notion-c01d2be9d47a` and `notion-4feaf1dc57d8` (originally "QA Needed") both now carry a `CORRECTED 2026-08-29` lead-in pointing at `notion-d8a8596f87f9` ("Cold project intent discovery is verified on production, and its runbook probe was inverted"), which records both board todos `f09bf585` and `503195a8` as `done`.
- **Board state, read directly:** `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json` has both `f09bf585-f4fa-416f-a979-5bbd0dac22ed` and `503195a8-1f77-4ff5-b9b7-7a6606a5d639` at `status: "done"`, citing `e8a2b1d6`.
- **Commit `7a769b94`** ("test: pin the cold-watcher wiring and verify both canaries on production", current HEAD of `cez/abfcdb9c`) is an ancestor of `origin/main` (`git merge-base --is-ancestor 7a769b94 origin/main` → true). Local `main` trails `origin/main` by two unrelated commits (step-retry UI), nothing to do with this bug.

## Code actually involved, read at current HEAD (not assumed from the ticket text)

`packages/cezar/src/server/server.ts`:
- Lines ~1945–1966: the original three-clause wiring for both watchers is **unchanged** — this is not a case where the old mechanism was ripped out.
- Line ~7778/7787: `startServer` additionally instantiates `createLazyProjectIntentDiscovery` (`packages/cezar/src/server/lazy-project-intents.ts`) and calls `lazyProjectIntentDiscovery.refresh()` **after** `createApp` has registered both `onContextBuilt` callbacks. Its own comment: "Cold-project intent discovery starts only after createApp has registered both live watcher callbacks. A discovered context therefore reaches autostart and reopen reconciliation in the same turn that it becomes resident."

`packages/cezar/src/server/lazy-project-intents.ts`:
- Polls every *registered* project with no live `ProjectContext` yet (`contexts.peek(id) === undefined`) via `watchFile` + passive JSON reads of `todos.json`/`reopen-requests.json` — never subscribes to a live domain watcher (which would `mkdirSync`).
- On a pending flag, calls `await deps.contexts.context(row.id)` (line ~296), which builds the real context and fires `onContextBuilt`, arming the resident watchers for that project from that point on.

`packages/cezar/src/server/project-context.ts:320` — `context()` is still lazy; nothing eagerly builds every registered project at boot.

`packages/cezar/src/reopen-requests.ts:327` — `startWatch` still does `mkdirSync(dataDir, {recursive:true})` on subscribe, but the lazy-intent poller never calls `startWatch` for cold projects; it reads snapshots that treat a missing file/dir as `absent` with no side effect (lines ~222–227).

Tests: `packages/cezar/src/todo-autostart.test.ts:230` and `packages/cezar/src/reopen-watch.test.ts:226` — twin `describe`/`it` blocks, "boots the real server path and wakes a non-resident project only after a pending todo/reopen", added/reworked by `7a769b94` specifically so they fail if either the resident self-arming callbacks or the lazy poller's `contexts.context()` call is cut.

## Acceptance criteria, checked against the record above

- [x] Non-resident autostart starts a run; non-resident reopen continues one — production-verified 2026-08-29 (mw-site autostart 4s, loki-labs reopen 6s), per `specs-1c4624683273` execution record.
- [x] No eager boot-time context build for every registered project — `lazy-project-intents.ts` only calls `contexts.context()` for a project with a confirmed pending flag; confirmed by direct code read, not just the spec's claim.
- [x] No `.ai/cezar` creation side effect for a project that doesn't have one — poller reads snapshots only, never calls `startWatch`; confirmed by direct code read of `reopen-requests.ts:222-227`.
- [x] Regression tests for both watchers (twins) — both exist and share the same real-server-boot pattern.
- [x] Verified on production against a genuinely non-resident project — done 2026-08-29, with a non-creation control run against 8 other untouched cold projects.

**All five acceptance criteria are already satisfied by work that landed before this
step ran.** There is no code change for a downstream spec/implement step to make.

## One discrepancy worth flagging before any step acts on the stale handoff text

The task's own handoff/resume-notes ("ONE ITEM FOR THE OWNER") describe run
`dc24830f-6045-4d69-871c-6da692fc5448` in project `mw-site` as "still `queued`, 9 steps
pending, no worktree taken." Reading `mw-site/.ai/cezar/runs.json` directly shows this is
now stale: the run **ran to completion and failed** (`status: "failed"`,
`finishedAt: 2026-08-29T13:28:35Z`, `stepsUsed: 10`), a worktree **was** taken
(`mw-site/.ai/cezar/worktrees/dc24830f-...`, still on disk), it passed `run-tests` and
died at `deploy` because `mw-site` has no `.ai/deploy-targets.json`. `diffStat` shows
zero file changes, so it mutated nothing. The other half of that note is still accurate
and still open: todo `c2231b8c-85af-4869-8439-eea9f6442fb1` (the disposable autostart
canary) is still `status: "todo"`, not tombstoned.

## What this means for the remaining 8 steps of this chain

There is no defect left to spec or implement. The honest brief for a downstream
spec-writing step is: **write a spec (or short verification note) that records "already
implemented and verified; no code change" and corrects the stale run-state detail above**,
rather than re-deriving a fix that already exists — re-implementing would risk touching
`lazy-project-intents.ts`/`server.ts` a second time and either duplicating the mechanism
or reintroducing the "eager boot build" / "`mkdirSync` on cold project" failure modes the
acceptance criteria explicitly forbid.

Nothing in this record contradicts any other prior decision. No in-flight duplicate work
was found: no other run handoff, worktree, or todo references
`watchTodoAutostart`/`lazy-project-intents` as active/open work.

## What I could not find / did not verify myself

- I did not re-run the production canaries myself in this step (read-only gathering
  only); the "verified" claim rests on `specs-1c4624683273`'s execution record and the
  sub-agent's direct read of `todos.json`, not a fresh probe run in this session.
- I did not inspect why `7a3a7879` ("chore: merge origin/main (lazy project watchers
  fix)") exists as a separate commit from `809c8220`/`e8a2b1d6` beyond the one-line
  commit message read by the sub-agent; if a downstream step needs the exact merge
  topology it should `git show --stat` those shas itself.
- I did not check whether the `cezar` CLI has since gained a headless run-cancel verb;
  `notion-d8a8596f87f9` recorded its absence as a "known gap" on 2026-08-29 and that gap
  is why todo `c2231b8c` can't be tombstoned by an agent — only by a human in the
  cockpit.
