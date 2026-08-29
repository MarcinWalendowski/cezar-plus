# e2e fixtures

`thread-run.ndjson` is a REAL transcript with one documented synthetic extension (see the
last section): the base is the verbatim NDJSON a
CEZ_DRY_RUN=1 cezar (this branch, R2 protocol emitters active) persisted for a quick-task run
that received one follow-up message and was then finished. It is the documented mixed-file
state — v1 lines (`lifecycle`, `note`, `text`, `tool-call`, `user-message`, …) and protocol-v2
events (`item.*`, `turn.*`, `session.*`) interleaved on one `seq` clock, including the v1
twins that follow their v2 items (the thread reducer's dedup case).

The initial task deliberately carries NO `mock:` marker, so the mock's scripted first turn
emits real tool items (a `Bash` execute card with output, a `Screenshot` card with a persisted
image — Step 1.2's material); the follow-up message carries `mock:md`, so the second turn is
the markdown-rich reply the Streamdown/Shiki assertions pin.

Alongside the transcript:

- `thread-run.record.json` — the run's verbatim `runs.json` entry from the same dry run (the
  store's zod-checked shape). The spec loads it as-is, overriding only `titleSummary` (a
  legitimate user PATCH).
- `thread-run-images/` — the `<id>-images/` directory the run persisted; the transcript's
  `image` line points into it via `/api/v1/runs/<id>/images/…`.

To regenerate: build, boot `CEZ_DRY_RUN=1 node dist/index.js serve --repo <tmp-git-repo>`,
POST a run whose task has no `mock:` marker, POST one `/messages` reply containing `mock:md`
once it waits, POST `/finish` (twice: the mock's turn 1 touches `notes.md`, so the run parks
at `review` first — the second finish accepts it), then copy `<tmp>/.ai/cezar/runs/<id>.ndjson`,
`<id>-images/` and the `runs.json` entry here. Then re-apply the synthetic extension below.

## Synthetic extension (R3 Step 1.3 — plan dock, step rail, check-step cards)

The mock claude (`scripts/mock-claude.mjs`) emits no `TodoWrite`, and `quick-task` has no
check step, so the dry run cannot record those surfaces. The transcript therefore carries
HAND-APPENDED lines (seqs renumbered), each faithful to a documented wire shape rather than
invented:

- Two `TodoWrite` sequences (`item.started` → `plan.updated` → v1 `tool-call` twin →
  `item.completed` → v1 `tool-result` twin), one per turn, shaped exactly like the golden
  `src/core/__fixtures__/claude/thinking-edit-write-todo.*` pair (the R2 mapper's pinned
  output, including the mapper's item-then-plan emission order). The second snapshot
  supersedes the first — the latest-plan-wins path the dock asserts.
- A `verify` check step after the agent step: `step-start` (kind `check`) → the `$ npm test`
  note → `check-output` → `step-end`, the exact emission sequence of
  `src/workflows/run.ts` `runCheckStep()`. `thread-run.record.json` carries the matching
  `verify` entry in `steps` and `workflowDef` (which therefore no longer equals the stock
  built-in `quick-task` definition).

## Synthetic LARGE transcript (R3 Step 2.4 — virtualization)

`make-large-thread.ts` generates (at test runtime, never checked in) the 250-turn /
2,506-event / 1,003-row NDJSON that `thread-scroll.e2e.ts` uses to push the thread past the
~300-row virtualization threshold. It is a legitimate synthetic LOAD, not fake product data:
every line reuses the verbatim wire shapes of `thread-run.ndjson` above (v2 `turn.*`/`item.*`
events with their v1 twins on one `seq` clock), repeated. The run record is
`thread-run.record.json` re-ided with only the fields the scenario needs overridden.

## Sub-agent fan-out transcript (#474 — Agents dock, drill-down sheet)

`subagents-run.ndjson` is a REAL transcript with NO synthetic extension: the verbatim NDJSON a
`CEZ_DRY_RUN=1` cezar persisted for a quick-task run whose task was `mock:subagents`. That
trigger (`scripts/mock-claude.mjs`) replays a parallel fan-out — two `Task` spawns, then their
children interleaved with `parent_tool_use_id`, then the tool_results — which is exactly the
shape the Agents dock groups. The only edit is timestamp normalization (`ts` values rewritten
to a fixed 2026-07-21 sequence) so the fixture is stable; `seq` order and every payload are
untouched.

- `subagents-run.record.json` — the `runs.json` entry, derived from `thread-run.record.json`
  with the id, title/task, branch and worktree path swapped for this run. Status `done`, so the
  store's `recover()` leaves it alone.

To regenerate: build, boot `CEZ_DRY_RUN=1 node dist/index.js serve --repo <tmp-git-repo>`,
start a task whose text is `mock:subagents`, wait for it to settle, then copy
`<tmp>/.ai/cezar/runs/<id>.ndjson` here and normalize the timestamps.

## Retry attempt timing (spec 2026-08-29-per-retry-step-timing, §Verification V5b)

`retry-timing-run.record.json` is the `gate`/`work` run V5 step 1 produces — no transcript, only
a `runs.json` entry, since `retry-step-timing.e2e.ts` asserts the step rail's tree and its
aggregate clock, not a transcript. `gate` has `onFail: { retry: 'work', max: 2 }` and takes
1s/2s/3s on its three attempts (told apart on sight); `work` sleeps a flat 2s on each of its
three. Lifted out of that run's real `runs.json` with exactly two documented edits, the same
discipline `thread-run.record.json` follows for its own two: a terminal `done` run status (the
captured run really does finish this way; named here only because every fixture in this
directory states its status edits explicitly), and the `attempts` stamps normalized to exact
millisecond intervals — 1000/2000/3000ms on `gate`, 2000ms on each `work` attempt — so the
rendered strings (`0:01`, `0:02`, `0:03`, and a `gate` total of `0:06`) are pinned by arithmetic
instead of by how loaded the box was when the fixture run executed. Capturing rather than
hand-writing the shape is the point: a hand-written record proves the renderer reads a shape
someone imagined, while a captured one proves `RunStore.updateStep`'s attempt tracking really
writes it.

To regenerate: run the two `cezar run` fixture invocations in spec
`2026-08-29-per-retry-step-timing.md` §Verification V5 step 1 (`retry-timing-fixture` workflow,
a real git repo with one empty commit, `CEZ_DRY_RUN=1`), then copy the `retry-timing-fixture` run's
entry out of `<repo>/.ai/cezar/runs.json` here and normalize its `attempts` timestamps to the
millisecond intervals above.
