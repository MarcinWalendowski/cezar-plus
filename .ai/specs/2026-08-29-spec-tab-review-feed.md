# Spec tab review feed

- **Status:** Implemented, QA Needed. Phase 1 (P1 persistence + P2 contract/route + P3 tab)
  landed in one commit, `2a16bb72` ("feat: implement spec tab review feed
  (2026-08-29-spec-tab-review-feed)"), merged to `main` via PR #14 (merge commit `9665fbac`).
  Repository gates re-run on the fully merged tree (step 7 of this run): `npm run typecheck`
  green across all four workspaces; `npm test` — 642 passed / 2 skipped test files, 12142
  passed / 4 skipped tests, exit 0. The five pre-existing failures this run's earlier gate runs
  saw (`workflows/step-runner-account.test.ts`, `workspace/account-viability.test.ts`,
  `workspace/agent-route-step-provider.test.ts`) are unrelated account/quota-routing tests this
  branch never touched (confirmed by empty `git diff --stat` on those files) and are tracked
  separately as todo `8cc9e7b3-36c6-479d-b981-3bd2def07dac`. **Not yet run: the Runtime E2E**
  below (line ~1133), which requires the owner's explicit approval to boot the cockpit and
  drive real `spec`/`review-spec` agent runs through the approval gate twice — until that
  passes and is quoted here, this is QA Needed, not Done. Written 2026-08-29 by step 2 of run
  `44ac315d-737f-484c-a405-9e1939e7fa3d`.
- **Date:** 2026-08-29
- **Owner instruction, verbatim:** "When 'write spec' is ready, show a tab with written spec to
  preview, if review was passed, don't show, but if spec needs to be review, in Spec tab show
  initial spec, then what review requsted to change, and then again new spec if was written etc -
  in the shape of feed spec -> review -> spec ->review ->spec until review pass"
- **Brief — NOT AVAILABLE FROM THIS BRANCH.** Step 1 of this run wrote its brief to
  `/var/lib/cezar/loki-labs/cezar/.ai/specs/briefs/2026-08-29-spec-tab-review-feed.md`, which is
  in the **main checkout, not in this worktree**. The repo-relative path
  `.ai/specs/briefs/2026-08-29-spec-tab-review-feed.md` does **not** resolve on this branch
  (`.ai/specs/briefs/` here holds 2026-08-07 through 2026-08-27 only), so a reviewer or
  implementer working from the branch alone cannot open it. Treat it as unavailable.
  Accordingly, nothing below rests on the brief as its only source: the cezar knowledge base
  (`cez kb search`), the workspace domain record, each cited spec file, and every cited line of
  source in `packages/cezar`, `packages/contract` and `packages/web` were re-read directly in
  this checkout, and the citations below are to those reads.
- **Extends** `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`
  (KB `specs-9a01e3bf2eeb`): the spec that introduced the `review-spec` step, the
  `CEZ:REVIEW=pass|revise` verdict and the `onFail: { retry: 'spec', max: 2 }` loop-back this
  feed renders. Nothing in it is superseded; this is purely additive on top.
- **Extends** `.ai/specs/2026-08-21-structured-review-targeted-spec-edits.md`
  (KB `specs-7883b8820d4f`), shipped `ea0c8374` ("feat: implement
  spec-2026-08-21-structured-review-targeted-spec-edits", 2026-08-22, confirmed an ancestor of
  this branch's HEAD with `git merge-base --is-ancestor`). That commit is what makes a `revise`
  report a structured FILE / SECTION / CHANGE list, which is the thing this feed is worth
  rendering. Its outstanding Phase 4 is a runtime measurement of that fix and is untouched here.
- **NAMING COLLISION: read before reusing the word "review".**
  `.ai/specs/2026-07-18-optional-review-gate.md` (KB `specs-c7ed3a587da3`) already owns the term
  "review gate": that is the human accept / send-back / draft-PR gate on a **finished run's
  diff**, config `reviewGate` / `CEZ_REVIEW_GATE`, default off, rendered by `ReviewPanel`
  (`packages/web/src/routes/task-thread/review-panel.tsx`). It has nothing to do with the
  `review-spec` workflow step. There is a third `review`-adjacent concept, the human approval
  gate (`pendingApproval`, `packages/contract/src/runs.ts:210`). **Everything this spec adds is
  namespaced `specReview`**: `specReview` on the record, `SpecReviewEntry` /
  `SpecReviewFeedResponse` in the contract, `GET /api/v1/runs/:id/spec`, `task-spec/` in the web
  package. No identifier introduced here may be spelled `reviewGate`, `ReviewPanel`, `review`, or
  `approval`.
- **Related precedent for the mechanics, not the content:**
  `.ai/specs/2026-08-26-filed-task-detail-page.md` is the most recent spec in this repo that adds
  one route + one contract schema + one web view, and its Phase-4 correction is the cautionary
  tale for this one: it shipped the backend half and none of the feature. The phases below are
  ordered so that a partial landing is still honest (see Phase gating in **Phases**).

## TLDR

Give a task a **Spec** tab. It renders the spec the `spec` step wrote, and (when the reviewer
sent it back) the whole argument in order: **spec v1 → review 1 → spec v2 → review 2 → … →
final verdict**, one markdown card per turn of the loop.

Making this possible is a persistence change, not just a UI change. Today the reviewer's verdict
and report live only in memory on `ActiveRun` (`run.ts:337`/`339`) and are explicitly cleared
after one use (`run.ts:5977-5978`), and the `spec` step overwrites the same file on every retry
with no commit in between, so **revision 1's text is already gone from disk by the time
revision 2 exists**. This spec adds one append-only per-run file,
`<dataDir>/runs/<runId>.spec-review.ndjson`, written at the two moments the information exists
and nowhere else; one small counter on `RunRecord` so the tab knows whether to exist; one
additive read route; and one tab.

Blobs go to a side file rather than onto `RunRecord` deliberately: `RunRecord` is serialised
wholesale into `runs.json` (`store.ts:1486`, `JSON.stringify(this.listRuns(), null, 2)`), so
three 30 KB markdown documents per run would multiply the index by the number of runs kept.

## Problem

### 1. The loop is invisible

`spec-to-deploy` (`packages/cezar/src/workflows/types.ts:1133`) runs **nine** steps:
`context → spec → review-spec → implement → run-tests → commit-push → merge → document → deploy`.
(Re-counted in this checkout on 2026-08-29 by enumerating the `id:` keys of
`SPEC_TO_DEPLOY_WORKFLOW.steps` at `types.ts:1139/1204/1250/1317/1348/1423/1460/1488/1573`. An
earlier draft of this spec repeated an eight-step sequence that omitted `merge`; that sequence was
inherited from the brief and is wrong.) The
`spec` step (`types.ts:1204`) declares `CEZ:SPEC_PATH=<path>` (`types.ts:1246`); `review-spec`
(`types.ts:1250`) is read-only by construction (no `Write`, no `Edit`) and ends with
`CEZ:REVIEW=pass` or `CEZ:REVIEW=revise` (`REVIEW_VERDICT_RE`, `types.ts:819`;
`parseReviewVerdict`, `types.ts:824`). A `revise` verdict loops the chain back to `spec`, bounded
at `onFail: { retry: 'spec', max: 2 }` (`types.ts:1267`), carrying the reviewer's report as the
next attempt's instructions (`specRevisionFeedback`, `run.ts:897`; call sites `run.ts:5991` and
`run.ts:6023`).

None of that reaches the cockpit. `RunTab` is exactly
`'session' | 'changes' | 'commits' | 'files'` (`run-header.tsx:130`, rendered `209-220`). The
only place a spec is mentioned in the UI at all is a bare path string,
`<code>{pending.specPath}</code>` in `ApprovalCard` (`approval-card.tsx:85-88`), visible only
while `run.pendingApproval` is set. A user who wants to read the spec must open the Files tab and
find it by hand, and what they find is the *latest* text, never the drafts and objections that
produced it.

### 2. The evidence is destroyed as the run proceeds

- `state.reviewVerdict` / `state.reviewReport` are in-memory fields on `ActiveRun`
  (`run.ts:337`, `run.ts:339`). The report is the turn-text tail,
  `turnText.trimEnd().slice(-CHECK_OUTPUT_CAP)` with `CHECK_OUTPUT_CAP = 20_000`
  (`run.ts:151`, capture at `run.ts:6957-6963`).
- Both are read and **cleared** in the step loop before the loop-back is built
  (`run.ts:5975-5978`), with a comment explaining why the clear is deliberate. A process restart
  loses them entirely.
- The only thing that reaches the durable store is one overwritten string,
  `RunRecord.declaredSpecPath` (`packages/contract/src/runs.ts:353`, written at `run.ts:7662`
  from `applyTurnMarkers`, `run.ts:7630`, itself called from `recordTurnEnd`, `run.ts:7595`).
- The `spec` step edits the same file in place on retry, and `commit-push` is three steps later,
  so git holds no intermediate revision either.

Grepping `packages/contract`, `packages/cezar` and `packages/web` for `revision`, `verdict`,
`reviewHistory`, `specHistory` and `targetedEdit` finds no existing multi-version structure.
Confirmed by the brief and re-confirmed here. Nothing to extend; this is new state.

### 3. Mining the transcript afterwards is not a workable substitute

The brief left this open ("did not verify whether `review-spec`'s own agent session transcript
could be mined after the fact"). It was checked in this step, and the answer is no:

- The run's NDJSON does hold the reviewer's `text` events, so the *report* is arguably
  recoverable, but only by re-deriving which events belong to which attempt of which step, and
  only until retention prunes the file (`store.ts:1455-1470`).
- The **spec text itself is never in the transcript at all.** The `spec` step writes it with
  `Edit`/`Write` tool calls; a targeted `Edit` records only the changed hunk, by design
  (`specRevisionFeedback`, `run.ts:897`, instructs exactly that). Reconstructing revision 1 from a
  sequence of partial edits is not something a display route should attempt.

So the snapshot must be taken **at the moment each attempt finishes**, which is what this spec
does.

## Solution

### The three moments that get recorded

1. **A step finished having declared a spec path.** Read the file from the run's working
   directory and append a `kind: 'spec'` entry.
2. **The `review-spec` step produced a verdict**, `pass` *or* `revise`. Append a
   `kind: 'review'` entry with `actor: 'agent'`, the verdict and the report.
3. **A human requested changes at the approval gate.** Append a `kind: 'review'` entry with
   `actor: 'human'`, `verdict: 'revise'` and their note.

Because the chain physically re-runs `spec` after a `revise`, appending in event order is always
chronological and needs no sorting. **It does not, however, always alternate**: the agent verdict
block and the human approval gate can both fire on one revision, so a clean `pass` may be
immediately followed by a human `revise`. Both are recorded; the alternating *shape* the owner
asked for is produced at display time by two small rules, set out in "The raw log does not
alternate" below.

Recording `pass` as well as `revise` is what lets the feed end honestly: the last card says the
reviewer accepted it, rather than the feed simply stopping.

### What "if review was passed, don't show" means, precisely

The brief flagged this as ambiguous. Decision: **the tab is always present once a spec exists;
the *feed* is what a clean pass hides.**

- **0 reviews recorded** (mid-run, or a workflow with no `review-spec` step): the tab renders the
  spec alone.
- **1 spec + 1 `pass`**: the tab renders the spec, with a single-line accepted-by-review note
  above it. No feed, no cards, nothing to scroll past. This is the "don't show" case.
- **≥1 `revise`**: the tab renders the full feed, newest last, with the final spec at the bottom.

Reading: the instruction opens with "show a tab with written spec to preview", so the base case
it asks for is the spec; "don't show" attaches to the spec→review→spec *feed*, which is what the
rest of the sentence is about. Hiding the tab entirely on a pass would make the common, healthy
outcome the one you cannot read the spec in, which contradicts the first clause.

#### The raw log does not alternate, and the display must not assume it does

An earlier draft of this spec claimed the write order yields `spec → review → spec → review …`
"with no ordering logic anywhere". **That is false whenever the human approval gate is what sends
the spec back**, which is the common configured case and the one the runtime E2E below uses. The
step loop runs the two gates in a fixed order (`packages/cezar/src/workflows/run.ts`):

1. the agent verdict block, `const reviewVerdict = state.reviewVerdict` at `run.ts:5975`, which
   this spec appends a `review` entry from — for `pass` as well as `revise`;
2. **then** the human gate, `if (step.requiresApproval) { const outcome = await
   this.awaitApproval(...) }` at `run.ts:6013-6021`, whose `outcome.kind === 'changes'` branch is
   the second `review` write.

So when `review-spec` is happy but a person is not, the writers record, in this order:

```
spec (rev 1) · review{actor:'agent', verdict:'pass'} · review{actor:'human', verdict:'revise'} · spec (rev 2) · review{actor:'agent', verdict:'pass'}
```

Two reviews back to back, and an accepted-looking `pass` sitting immediately before the
send-back. Rendered literally that reads as "the reviewer approved it, then it was revised
anyway", which is the opposite of what happened.

**Both raw records are kept** — the agent did pass, and throwing that away would make the log a
lie in the other direction. The fix is at display time, in the route's/component's derivation of
the feed, and it is two rules:

- **Group by `revision`.** Display entries are bucketed into revisions: the `spec` entry for
  revision *n* followed by every review associated with revision *n*, in `seq` order. This is
  what makes the feed's shape independent of how many gates ran per revision.
- **Suppress a provisional agent `pass`.** Within a revision, if an `actor: 'agent'`,
  `verdict: 'pass'` entry is followed by any `verdict: 'revise'` entry for the **same** revision,
  the `pass` card is not rendered. Its verdict was provisional — the chain looped back after it,
  so it was never the outcome for that draft. It stays in the NDJSON and is reachable by `cat`;
  it just does not get a card. A `pass` in the **last** revision is not suppressed by this rule:
  no later `revise` exists for it. Whether it is *final* is decided by the third rule.
- **A pass is not final while the human gate is still open.** Suppression alone is not enough,
  because it is retrospective: it needs a later `revise` to already exist. In the window between
  the agent verdict block (`run.ts:5975`) and the human's answer to the approval gate
  (`run.ts:6013`), the last entry in the log is an agent `pass` with nothing after it, and the
  naive derivation renders it as the final accepted verdict — then flips to "requested changes"
  a moment later if the person clicks that. The derivation therefore consumes
  `run.pendingApproval` (`packages/contract/src/runs.ts:356`, `pendingApprovalSchema` at
  `runs.ts:210`; the store's own copy at `packages/cezar/src/runs/store.ts:331`) alongside the
  log. While `run.pendingApproval` is set **and** the pending step is `review-spec`, a trailing
  agent `pass` renders as the neutral, non-terminal line **"agent review passed, awaiting human
  approval"** — not the accepted note, not a final-verdict card, and the feed is not marked
  complete. Only once `pendingApproval` clears with no later `revise` does that entry become the
  final verdict card. This holds at *every* gate, not only the first: after revision 2's agent
  `pass` the run stops at the same gate again, and revision 2 must show the same awaiting-approval
  state until it is approved.

Applied to the sequence above, the visible feed passes through:

```
(at the first gate)     spec v1  →  agent review passed, awaiting human approval
(after request-changes) spec v1  →  requested changes (human)  →  spec v2  →  agent review passed, awaiting human approval
(after approval)        spec v1  →  requested changes (human)  →  spec v2  →  final verdict (agent pass)
```

which is exactly the shape the owner asked for, without ever showing a verdict as settled while
a person is still being asked about it. Asserted as fixture tests in **Verification** (P3 tests
18b, 18c and 18d — grouping, the first gate, and the revision-2 gate) rather than left as prose,
because these are the derivations in this feature that a straightforward implementation gets
wrong.

### Where the data lives

One append-only NDJSON file per run:
`<dataDir>/runs/<runId>.spec-review.ndjson`.

This mirrors the existing per-run side files: `runs/<runId>.ndjson` (`store.ts:1434`),
`runs/<runId>.handoff.md` (`store.ts:1441`), `runs/<runId>-images/` (`store.ts:1446`), and keeps
the README's promise of "plain JSON, NDJSON and Markdown you can `cat` and fix by hand"
(BACKWARD_COMPATIBILITY.md preamble).

**Why not the existing event log.** It was considered and rejected on one specific ground: the
event NDJSON is replayed to the browser in full on every SSE (re)connect (`run-events.ts`
docstring: "the server replays the whole NDJSON file on every (re)connect"). Putting three 30 KB
markdown documents on that wire would make every reconnect of every task carry them. The
*vocabulary* would have been fine: `runEventSchema` is a `looseObject` with `type: z.string()`
and is documented as an append-only format where unknown types must pass through
(`packages/contract/src/events.ts:22`), and unknown types are ignored by the transcript because
`canonicalSessionItems` only promotes members of the `STANDALONE_TYPES` allowlist
(`event-history.ts:101-111`, `:124`). A small **metadata-only** event is still emitted, for live
refresh; see "Live updates" below.

**Why not `RunRecord`.** `store.ts:1486` writes `JSON.stringify(this.listRuns())` into
`runs.json` on every debounced save. Blobs there are paid for on every save, for every retained
run.

### Redaction

Entries are scrubbed with `redactSecrets(text, collectSecretValues())`
(`packages/cezar/src/core/secret-redaction.ts:88`, `:105`) before the line is written, honouring
`CEZ_REDACT_SECRETS=0` the same way `RunStore#redactText` (`store.ts:1330`) does. The store
already scrubs everything bound for disk or the wire (`store.ts:1323`); a new file that skips it
would be a hole, since a review report is raw agent turn text.

### The fallback for runs that predate this

Every run already in anyone's `.ai/cezar/` has no `.spec-review.ndjson`. For those, if
`RunRecord.declaredSpecPath` is set and resolves inside the run's working directory, the read
route synthesises a single `kind: 'spec'` entry with `source: 'worktree'` from the live file.
This gives existing runs a working Spec tab with no migration and no backfill, and it is honest:
the entry says where it came from, and the UI labels it "current file on disk", not "revision 1".

The same fallback covers a live run whose `spec` step is still in progress.

## Architecture

```
 workflows/run.ts  (the two write moments)
 ─────────────────────────────────────────────────────────────────────
 turn-end handler (~run.ts:6946-6963)
   parseReviewVerdict(turnText)  ──► state.reviewVerdict / reviewReport   [existing]
   parseTaskMarkers(turnText).specPath ──► state.stepSpecPath             [NEW, in-memory]

 step loop (~run.ts:5960-6010)
   after verdict.ok, before the review block:
     if (state.stepSpecPath) recordSpecRevision(...)   [NEW]  ─┐
   inside the review block, before the `revise` branch:        │
     recordSpecReview(verdict, report, 'agent')        [NEW]  ─┤
   inside the approval "changes" branches (5993-6030, 6772):   │
     recordSpecReview('revise', notes, 'human')        [NEW]  ─┤
                                                               ▼
 runs/spec-review-log.ts   [NEW module]
   appendSpecReviewEntry()  → <dataDir>/runs/<runId>.spec-review.ndjson
   readSpecReviewEntries()  ← same file
   summarise()              → store.updateRun(runId, { specReview: {...} })
                                                               │
                              ┌────────────────────────────────┘
                              ▼
 server/server.ts   GET /api/v1/runs/:id/spec    [NEW route]
   entries.length ? recorded : worktree fallback via declaredSpecPath
                              │
                              ▼
 packages/contract/src/runs.ts
   specReviewEntrySchema, specReviewFeedResponseSchema, specReviewSummarySchema  [NEW]
   RunRecordSchema.specReview?: SpecReviewSummary                                [NEW, optional]
                              │
                              ▼
 packages/web
   api/client.ts getRunSpec + queries.ts useRunSpec + queryKeys.runs.spec
   routes.tsx  tasks/:id/spec  →  routes/task-spec/task-spec.tsx
   run-header.tsx  RunTab | 'spec', tab rendered when run.specReview || run.declaredSpecPath
```

### Which step gets snapshotted, and how it is decided

**By declaration, not by step id.** Any agent step that emits `CEZ:SPEC_PATH=` gets its file
snapshotted when it completes. Keying on `step.id === 'spec'` would silently exclude the
`spec-to-deploy-codex` sibling (`SPEC_TO_DEPLOY_CODEX_NAME`, `types.ts:1671`), any user-defined
workflow, and the `note-to-spec` flow that `declaredSpecPath` was originally added for
(`runs.ts:353` doc comment). Declaration-keyed is also self-documenting: the marker already means
"I wrote a spec here".

The marker is parsed into a new in-memory `ActiveRun.stepSpecPath` in the turn-end handler,
beside `parseReviewVerdict`, rather than read back from `RunRecord.declaredSpecPath`. Reason,
and it matters: `specRevisionFeedback`'s own doc comment (`run.ts:892-895`) records that
`declaredSpecPath` "is NOT guaranteed to be set", and notes that it was measured absent on that
spec's own run. The persistence path runs through `void this.recordTurnEnd(...)` (`run.ts:6950`), a fire-and-forget
async call inside a `try {} catch {}`, so it is best-effort by construction. The verdict capture
next to it is synchronous and is not gated on `interactive` (`run.ts:6952-6956` comment), which
is exactly the property the spec-path parse needs. `declaredSpecPath` remains the fallback for
the read route, and is still written as it is today; nothing about it changes.

## Phases

**Two phases.** An earlier draft called each of the four steps below "independently shippable"
while also requiring three of them to land together, which is a contradiction: a backend-only
increment that this spec forbids shipping is not shippable. It is resolved by collapsing them.

- **Phase 1 — the vertical slice.** Persistence, contract + read route, and the tab, landing in
  **one commit**. Its three parts (P1, P2, P3) are **work packages**: an order of construction
  and a unit of review, each with its own automated tests that can run and pass on their own.
  None of them is a release boundary, and none may be merged to `main` alone. The reason is in
  the gating note after P3.
- **Phase 2 — record and QA.** Corpus synchronisation, documentation surfaces and the runtime
  E2E. Shippable and verifiable on its own, after Phase 1 has landed.

### Phase 1 · work package P1. Persist the spec/review record

New module `packages/cezar/src/runs/spec-review-log.ts`:

- `appendSpecReviewEntry(dataDir, runId, entry): SpecReviewEntry`: assigns `seq` and `at`,
  redacts, caps text, appends one JSON line.
- `readSpecReviewEntries(dataDir, runId): SpecReviewEntry[]`: tolerant line-by-line parse,
  malformed lines skipped, missing file → `[]` (same stance as `RunStore#readEvents`,
  `store.ts:1340-1356`).
- `summariseSpecReview(entries): SpecReviewSummary`.
- `specReviewLogPath(dataDir, runId)`, exported so `RunStore` can delete it.

`RunStore` changes:

- add `rmSync(this.specReviewPath(id), { force: true })` to **both** cleanup sites:
  `deleteRun` (`store.ts:1384-1397`) and the retention prune (`store.ts:1455-1470`). A per-run
  side file that outlives its run is a leak; the two existing side files are removed in both
  places and this one must be too.
- **reconcile a missing summary on load.** In the same load that safe-parses `runs.json`
  (`store.ts:796`), before the run list is exposed to any caller, recompute `specReview` from the
  side log for every record that has a log and no summary. `runs.json` is saved on a debounce
  (`store.ts:1472-1475`) while the append is immediate, so this state is reachable after a crash
  and does not self-heal. Full rationale in **Data models → "The summary on `RunRecord`"**, point
  3; asserted by P1 test 7c.
- expose the data dir to the new module the way `store.ts:1363-1372` already established (that
  comment records a caller recovering `dataDir` through the `private` modifier and says to hand
  out the specific path rather than a `dataDir` getter), so add
  `specReviewLogPath(runId): string` as a public method, not a `dataDir` accessor.
- **add `specReview` to the store's OWN record schema as well.** `RunStore` does not reuse the
  contract's schema: `packages/cezar/src/runs/store.ts:142` declares a second, independent
  `export const runRecordSchema = z.object({ … })` with its own `declaredSpecPath`
  (`store.ts:328`), and `RunRecord` in the store is `z.infer` of *that* one (`store.ts:595`).
  `updateRun(id, patch: Partial<Omit<RunRecord, 'id' | 'steps'>>)` (`store.ts:893`) is typed off
  it, and the loader safe-parses `runs.json` through `z.array(runRecordSchema)` (`store.ts:796`).
  So `updateRun(runId, { specReview })` **will not typecheck, and would not survive a reload
  even if it did**, unless the same optional `specReview: specReviewSummarySchema.optional()`
  field is added at `store.ts:328` beside `declaredSpecPath`. Adding it in only one of the two
  places is the specific way this phase fails silently: the value is written to the in-memory
  record and stripped on the next load.

`workflows/run.ts` changes:

- `ActiveRun.stepSpecPath?: string` (beside `reviewVerdict`/`reviewReport`, `run.ts:337-339`).
- Turn-end handler (`~run.ts:6957`): after the existing `parseReviewVerdict` block, set
  `state.stepSpecPath` from `parseTaskMarkers(turnText).specPath` when present.
- Step loop, after `verdict.ok` and **before** the review block at `run.ts:5972`: if
  `state.stepSpecPath` is set, read that path **through the containment-safe reader described
  next**, append a `spec` entry, clear the field. A path that does not resolve, or that the
  reader rejects, appends an entry with `missing: true` (and, when rejected, `rejected: true`
  plus the reader's `error` string) and **no `text`**, rather than skipping silently: "the step
  said it wrote a spec and there is no file there" — or "and the path it named is not inside the
  worktree" — is a fact worth surfacing.

**The snapshot read is untrusted input and must be bounded and containment-checked.** The path in
`CEZ:SPEC_PATH=` is written by an agent, into a transcript, and this writer runs unattended with
the server's own privileges; nothing between the marker and the read has validated it. It is the
more dangerous of the two readers in this spec — P2's fallback merely *serves* a file to a
signed-in operator, while this one copies file bytes into a durable, redacted-but-persisted log
that is then served over the API. So it does **not** get an ad-hoc `readFile(join(cwd, p))`. It
reuses `readWorktreePath(root, relPath, contentCap)` from
`packages/cezar/src/server/git-changes.ts:537`, the same function the Files tab uses, called with
`root = workingDirectoryOf(run, repoRoot)` and `contentCap = SPEC_TEXT_CAP`. That function already
enforces, in this order, every check this write needs (verified by reading it in this checkout):

- NUL bytes in the path → `{ kind: 'invalid' }` (`git-changes.ts:545`);
- **absolute paths and dot-segment escapes** → `resolve(rootAbs, relPath)` must equal `rootAbs` or
  start with `rootAbs + sep`, else `path escapes the worktree` (`git-changes.ts:546-550`). An
  absolute `/etc/shadow` is caught by the same check, because `resolve` discards the root for an
  absolute second argument and the result is outside;
- **`.git` internals** → refused (`git-changes.ts:551-554`);
- **a symlinked final component** → `lstat` + `isSymbolicLink()` → refused (`git-changes.ts:563`);
- **an intermediate symlinked directory** → `realpath` of both target and root, re-checked for
  containment (`git-changes.ts:565-583`, the `#blocker-symlink-traversal` comment);
- not a regular file → refused; binary (NUL in the first 8 KB) or over `contentCap` → returned as
  metadata with **no `content`**, which this writer records as `missing: true` with a reason.

Only `kind: 'file'` with a `content` string produces a `text` field. Every other result produces a
`missing` entry. **Do not re-implement these checks**: the intermediate-symlink case was a
blocker found in review on the Files tab and is exactly the one a hand-rolled `startsWith` misses.

**Every write in this work package is fail-open.** This is a display feature bolted onto the step
loop of a workflow that ships code; it must not be able to fail a run. Concretely: the snapshot
read, the NDJSON append, and the `updateRun` summary write are each wrapped so that *any* thrown
error or rejected promise — a read error, an append failure, `ENOSPC` on a full disk, `EACCES`, a
summary-update failure, a serialisation error — is caught at the call site and results in:

1. one redacted note appended to the run's thread via the existing note path, of the shape
   `spec-review log unavailable (<code>)` where `<code>` is the errno or error name **only** —
   never the message, never the path, since both can carry the file text or the host layout;
2. the attempt-local marker state cleared (`state.stepSpecPath = undefined`), so a failed attempt
   cannot make the *next* attempt re-snapshot a stale path;
3. **the workflow continuing unchanged.** The step's own verdict, the retry decision, and the
   loop-back are computed from `state.reviewVerdict` exactly as they are today. In particular a
   human's **request-changes action is never rejected** because the log write failed: the
   approval outcome is applied first and the append is best-effort after it. This matches the
   surrounding code's existing stance — persistence already runs through the fire-and-forget
   `void this.recordTurnEnd(...)` inside a `try {} catch {}` (`run.ts:6950`).

Failure injection is a required test, not an aspiration: **P1 tests 10b, 10c and 10d** inject a
throwing writer for the `spec` snapshot, the agent-review append and the human-review append
respectively, and assert in each case that the run completes with the same verdict and the same
retry behaviour as the uninjected control.
- Review block (`run.ts:5975-5990`): append a `review` entry with `actor: 'agent'` for **both**
  verdicts, before the existing `if (reviewVerdict === 'revise')`.
- Human "changes requested" branches (`run.ts:6015-6030` and `run.ts:6772`): append a `review`
  entry with `actor: 'human'`, `verdict: 'revise'`, `report: outcome.notes`.
- After each append, `store.updateRun(runId, { specReview: summarise(...) })`.

Internal checkpoint (not a release boundary): the file is written, prunes correctly, and its own
tests pass; nothing reads it yet, so it goes to `main` only as part of the Phase 1 commit.

### Phase 1 · work package P2. Contract + read route

- `packages/contract/src/runs.ts`: `specReviewEntrySchema`, `specReviewSummarySchema`,
  `specReviewFeedResponseSchema`; `specReview` added as an **optional** field on
  `RunRecordSchema` beside `declaredSpecPath` (`runs.ts:353`).
- `packages/cezar/src/server/server.ts`: `GET /runs/:id/spec` in the runs family, next to
  `/runs/:id/files` (`server.ts:5997`), using the same `workingDirectoryOf(run, repoRoot)`
  (`server.ts:6290`) and `readWorktreePath` for the fallback read.
- `BACKWARD_COMPATIBILITY.md` §2 inventory gains the new path **in the same commit**, otherwise
  `packages/cezar/src/server/bc-route-inventory.test.ts` fails the build, which is that guard
  working as designed.
- `packages/api-client` needs no hand-written addition: types are inferred from the server's own
  handlers (`packages/api-client/src/index.ts` docstring), and `contract-parity.*.test.ts` checks
  the new schema against the route in both directions.

Internal checkpoint (not a release boundary): `curl localhost:4321/api/v1/runs/<id>/spec` answers
and its route tests pass; no UI change, so it goes to `main` only as part of the Phase 1 commit.

### Phase 1 · work package P3. The Spec tab

- `packages/web/src/api/client.ts`: `getRunSpec(id, opts)` modelled on `getRunCommits`
  (`client.ts:917`).
- `packages/web/src/api/queries.ts`: `queryKeys.runs.spec(id)` in the `runs` block
  (`queries.ts:182-194`), and `useRunSpec(id, live)` modelled on `useRunCommits`
  (`queries.ts:1278`), with `refetchInterval: live ? 5000 : false`, `retry: false`.
- `packages/web/src/routes/task-spec/task-spec.tsx`: `TaskSpecRoute`, structured like
  `TaskFilesRoute` (`routes/task-git/task-files.tsx`): `useRun` guard, `RunHeader` with
  `tab="spec"`, then the feed. The response's `entries` are **derived into display cards**, not
  rendered one-to-one: group by `revision`, suppress a provisional agent `pass`, and render an
  unmatched review unlabelled — the three rules fixed in **Solution → "The raw log does not
  alternate"** and **Data models → "Revision assignment"**. Keep that derivation in a pure
  exported function (`toFeedCards(entries)`) so it is testable without mounting the route.
- `run-header.tsx`: `RunTab` (`:130`) gains `'spec'`; a `<TabLink to={…/spec}>Spec</TabLink>`
  rendered **between Session and Changes** (the spec precedes the code), and rendered **only**
  when `run.specReview !== undefined || run.declaredSpecPath !== undefined`.
- `routes.tsx`: `<Route path="tasks/:id/spec" …>` beside the sibling tabs (`routes.tsx:507-545`).
  Nothing else is needed for URLs: `LegacyPathRedirect` (`routes.tsx:301-308`) forwards legacy
  flat `/tasks/:id/spec` byte-for-byte, and `pageTitleContext` already matches `/tasks/:id/*`
  (`routes.tsx:477`).
- `approval-card.tsx:85-88`: the bare `<code>{pending.specPath}</code>` becomes a link to the Spec
  tab. The card stays (it is the thing that collects the decision); it just stops being the only
  way to learn a spec exists. (This settles the brief's open question 6: not subsumed, linked.)

**Analytics — shipped with the feature, not after it.** The workspace rule is that every feature
ships with events named at design time. The sink already exists and needs no server work:
`POST /api/v1/workspace/analytics/events`
(`packages/cezar/src/server/workspace-analytics-routes.ts`), workspace-level and single-mount,
answering **202** and swallowing sink failures by construction, appending to
`<CEZ_HOME>/analytics/events.ndjson`. The event body is `analyticsEventSchema`
(`packages/contract/src/analytics.ts:16-28`): `name` matching
`/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/`, and `props` as a **flat, scalar-only** record of at
most 16 keys with string values capped at 200 characters.

- **The transport goes in `packages/web/src/api/client.ts`, with every other call.** Grepped:
  there is no analytics client anywhere under `packages/web/src` — the route was added by
  `.ai/specs/2026-08-26-filed-task-detail-page.md` and its browser half is one of the things that
  spec's status correction records as not shipped. So `todo.detail_opened` has no emitter either.
  Add `postAnalyticsEvents(events: AnalyticsEvent[]): Promise<AnalyticsEventsResponse>` to
  `client.ts`, written the way every sibling in that file is written: through the **typed Hono
  client** and the module's shared request path, so it inherits `credentials: 'include'`
  (`client.ts:440`), `NO_REDIRECT` / `redirect: 'manual'` (`client.ts:463`) and the
  `throwIfIdentityGate` bounce handling (`client.ts:481`). This is the still-current client design
  recorded in `.ai/specs/2026-08-26-filed-task-detail-page.md` and in the domain record's
  *"the cockpit is gated on being signed in, not only on onboarding"* decision (2026-08-19): a
  raw `fetch` behind Cloudflare Access does not get an `ApiError.identityGate`, it gets an opaque
  redirect that reads as "cannot reach the server", and a second transport is a second place for
  that to be got wrong.
- **`packages/web/src/api/analytics.ts` may exist, as a wrapper only.** It holds
  `trackEvent(name: string, props: Record<string, string | number | boolean>): void`, which
  builds `{ events: [{ name, props }] }`, calls `postAnalyticsEvents`, and **fails open** — no
  `await` at the call site, no throw, no retry, the promise's rejection swallowed. It must
  **not** implement its own `fetch`; asserted by P3 test 21b, which greps the module for `fetch(`
  and expects zero hits. An analytics call must never be able to break a tab.
- **One event: `spec.feed_opened`.** Props, all bounded scalars, no free text and never any spec
  or report content:

  | prop | type | values |
  | --- | --- | --- |
  | `project` | string | the project id from the route |
  | `mode` | string | `clean` · `revised` · `draft` · `empty` · `unmatched` — see below |
  | `approvalPending` | boolean | `true` when the tab was opened while `run.pendingApproval` is set on the `review-spec` step |
  | `revisions` | number | `summary.revisions` |
  | `reviews` | number | `summary.reviews` |
  | `source` | string | `recorded` · `worktree` (fallback) · `none` (empty state) |

  **`mode` must be exhaustive over every successful response**, because a classification with a
  hole silently becomes a classification that lies: the two states an earlier draft omitted are
  states this spec explicitly creates, so they would have been bucketed as `clean` and inflated
  the "the loop never engaged" number, which is the number the whole event exists to measure.
  The five values partition the successful responses:

  | value | condition |
  | --- | --- |
  | `draft` | ≥1 `spec` entry, **zero** `review` entries — the snapshot exists but no verdict has been recorded yet |
  | `clean` | ≥1 `spec` entry, ≥1 review, **no** `revise` anywhere — first draft accepted |
  | `revised` | ≥1 `revise` entry — the loop engaged; the feed is the point |
  | `unmatched` | ≥1 review entry but **zero** `spec` entries — reviews exist with no draft to attach them to |
  | `empty` | zero entries in a successful response — the fallback served worktree text, or served nothing |

  `approvalPending` is carried separately rather than folded into `mode` so a human-gated pass is
  never recorded as `clean`. At the moment the tab is opened during a gate the agent has passed
  and no `revise` exists, so the `mode` rules alone would classify a run that is *about* to be
  sent back as a clean first-pass acceptance. Two bounded fields keep both facts.
  `mode` is the whole point of measuring this: it is the number that says how often the review
  loop actually engages, which is what tells us whether the feed was worth building. Every one of
  the five values is asserted by a fixture in P3 test 21c.
- **Emitted once per route mount, after the first successful feed load.** Guarded by a `useRef`
  latch set in the same effect that fires, so neither the 5 s `refetchInterval` nor React's
  double-invoked effects in StrictMode can send it twice. Not emitted on error, not emitted while
  loading. Asserted in P3 test 22.

**Gating — why Phase 1 is one commit.** P1 and P2 produce no user-visible behaviour on their own.
Landing them without P3 reproduces exactly the failure recorded in
`.ai/specs/2026-08-26-filed-task-detail-page.md`'s status correction: backend shipped, feature
absent, spec status rounded up. If the work has to stop early, stop **before** P1 and record why,
rather than after P2.

### Phase 2. Record and verify

- `CHANGELOG.md` entry (Added).
- Update this spec's Status line with what actually shipped.
- The runtime E2E in **Verification** actually executed, and its result quoted.
- **Documentation surfaces for `CEZ_ANALYTICS`** (three files). This feature adds no `CEZ_*`
  variable of its own and no config key — the tab is always-on and zero-config, like the tabs
  beside it. But it becomes the **first shipped emitter** of the analytics sink, and that sink's
  own opt-out is undocumented: grepped in this checkout on 2026-08-29, `CEZ_ANALYTICS` appears in
  **zero** of `.env.example`, `README.md` and `BACKWARD_COMPATIBILITY.md`.
  `.ai/specs/2026-08-26-filed-task-detail-page.md:15-17` records those three missing surfaces as
  an open defect of the phase that shipped the sink, and says explicitly not to treat it as
  closed. Shipping a second consumer of an undocumented switch is what makes it permanent, so
  this phase closes it:
  1. `.env.example` — a `CEZ_ANALYTICS` entry, per `AGENTS.md:31` ("any new `CEZ_*` env var MUST
     update `.env.example` in the same commit"), documenting that the sink is **on by default**
     and that the value `0`, exactly, disables it;
  2. the README env table — the same row, with the `<CEZ_HOME>/analytics/events.ndjson` path;
  3. `BACKWARD_COMPATIBILITY.md` **§1** (the env-var inventory) — `CEZ_ANALYTICS` listed as a
     supported variable, so removing or re-defaulting it is a documented break rather than a
     silent one. (The new route already lands in §2 in P2's commit.)
- **Record synchronisation, named and verified — not "write something to the corpus".** The
  workspace rule is that a corpus write only counts once `cez kb search` finds it, and that a
  proposal is reviewed and applied later rather than automatically. So this phase produces three
  named records, appended as NDJSON `upsert` lines to `$CEZ_KB_WRITE_FILE` (each with its own
  incrementing `seq`, `runId` = this task id, and an ISO-8601 `createdAt`):
  1. **decision**, scope `project`, title **"The spec/review feed is a side log, not run state"**
     — why the drafts and reports go to `<runId>.spec-review.ndjson` rather than onto
     `RunRecord` (the `runs.json` whole-index serialisation at `store.ts:1486`), and why both
     raw gates are kept while the *display* suppresses a provisional pass;
  2. **status**, scope `project`, title **"Spec tab review feed — <status> <date>"**, carrying
     the honest state (Implemented / QA Needed until the runtime E2E has actually run);
  3. **changelog**, scope `project`, domain `cezar`, title **"Added: Spec tab with the
     spec → review → spec feed"**, pointing at this spec path and the commit sha.
- **Verification of the sync is an exact-title search, and a proposal is not a record.** Run
  `cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex`, then
  `cez kb search "The spec/review feed is a side log"` and
  `cez kb search "Spec tab with the spec → review → spec feed"`, and require each to return the
  new document. A reindex proves nothing on its own: these are **proposals**, and until the
  cockpit or `cez kb proposals` applies them they are not in the corpus and those searches will
  return nothing. If they are still unapplied when this task finishes, the final status line must
  say **"corpus synchronisation pending"** and name the proposal file (`$CEZ_KB_WRITE_FILE`,
  printed as an absolute path), rather than claiming the record is in sync.

## Data models

### One line of `<runId>.spec-review.ndjson`

```ts
/** Shared envelope. `seq` is per-run and monotonic. `revision` is deliberately NOT here — it is
 *  required on a spec entry (a spec entry IS a revision) and optional on a review entry (a
 *  verdict can arrive with no captured draft to attach it to). See "Revision assignment" below.
 */
const specReviewBaseFields = {
  seq: z.number().int().nonnegative(),
  at: z.string(),
  /** Workflow step that produced it: `spec` / `review-spec` on the built-in chain, but never
   *  assumed to be either: the writer keys on the CEZ:SPEC_PATH declaration, not on the id. */
  stepId: z.string(),
};

export const specReviewSpecEntrySchema = z.looseObject({
  ...specReviewBaseFields,
  kind: z.literal('spec'),
  /** REQUIRED. Counts spec attempts from 1, in capture order. */
  revision: z.number().int().min(1),
  /** As declared by `CEZ:SPEC_PATH=`, capped like `declaredSpecPath`. */
  specPath: z.string().max(500),
  /** `recorded` = snapshotted when that attempt finished. `worktree` = synthesised by the read
   *  route from the live file, for a run written before this feature or still mid-spec. */
  source: z.enum(['recorded', 'worktree']),
  text: z.string().optional(),
  /** Text exceeded SPEC_SNAPSHOT_CAP and was cut at the head. */
  truncated: z.literal(true).optional(),
  /** The step declared a path that did not resolve. `text` is absent. */
  missing: z.literal(true).optional(),
});

export const specReviewReviewEntrySchema = z.looseObject({
  ...specReviewBaseFields,
  kind: z.literal('review'),
  /** OPTIONAL, and absent means something specific: this verdict arrived with no captured spec
   *  to attach it to (see "Revision assignment"). An unmatched review is NOT revision 1. */
  revision: z.number().int().min(1).optional(),
  /** `agent` = the `review-spec` step's CEZ:REVIEW verdict. `human` = a person requesting
   *  changes at the approval gate. Never conflated: they carry different authority. */
  actor: z.enum(['agent', 'human']),
  verdict: z.enum(['pass', 'revise']),
  report: z.string(),
  truncated: z.literal(true).optional(),
});

export const specReviewEntrySchema = z.discriminatedUnion('kind', [
  specReviewSpecEntrySchema,
  specReviewReviewEntrySchema,
]);
export type SpecReviewEntry = z.infer<typeof specReviewEntrySchema>;
```

`looseObject` on each member for the same reason `runEventSchema` uses it
(`packages/contract/src/events.ts:22`): this is an on-disk append-only format, and a file written
by a newer cezar must stay readable by an older one. `z.string()` on `at` rather than
`z.iso.datetime()` matches every other timestamp in `runs.ts`.

### Revision assignment

`revision` is assigned by `appendSpecReviewEntry`, never by its caller, so the invariant lives in
one place:

- **A `spec` entry** gets `revision = (max revision over existing spec entries in the log) + 1`,
  i.e. `1` for the first. Derived from the log's own contents at append time, not from a counter
  in `ActiveRun`, so a process restart mid-run cannot restart the numbering.
- **`seq` is `(max valid `seq` already in the log) + 1`, not `entries.length`.** These differ,
  and the difference is a correctness bug rather than a style preference: `readSpecReviewEntries`
  **deliberately skips malformed lines** (P1's tolerant parse, mirroring `RunStore#readEvents` at
  `store.ts:1340-1356`), so `entries.length` counts only the lines that *parsed*. One corrupted
  line — a torn append after a crash, a hand-edit during triage — makes the next append reuse a
  `seq` that already exists on disk. Since `seq` is what the feed sorts by and what test
  assertions key on, a duplicate produces a stable but wrong order that nothing detects. Taking
  the max also keeps the sequence **monotonic across gaps**, which is the property that actually
  matters: it does not need to be dense, it needs to never go backwards. An empty log (or one
  whose every line is malformed) starts at `0`. `revision` above uses the same max-based rule for
  the same reason. Asserted in P1 test 3b, which seeds a log holding valid `seq` `0` and `4` plus
  one malformed line between them, appends, and requires the new entry to be `seq: 5` — where
  `entries.length` would have produced `2`.
- **A `review` entry** is associated with the **latest spec entry already in the log**, taking
  its `revision`. This is correct by construction on the built-in chain: the loop snapshots the
  finished `spec` step before either gate runs (P1's write order), so the draft always precedes
  the verdict on it.
- **A `review` entry appended when the log holds no spec entry at all** is written with
  `revision` **absent**. It must not be labelled revision 1: no revision 1 was captured, and
  claiming one would invent a draft that does not exist. This is reachable — a `spec` step that
  never emits `CEZ:SPEC_PATH=` produces no snapshot while `review-spec` still emits a verdict
  (see Risk 3), as does any user-defined workflow whose reviewer step runs first.

**Display of an unmatched review.** The feed renders it as a review card in `seq` order with no
revision label and a one-line "no draft was captured for this verdict" note. It is not dropped:
the fact that a reviewer objected is the most useful thing on the page when the snapshot is the
part that failed. Asserted in P1 test 5b and P3 test 20b.

Caps, as constants in the new module:

- **`SPEC_SNAPSHOT_CAP = 1_000_000` characters** per `spec` entry.
  **Corrected: the earlier `200_000` rested on a false premise.** This draft claimed "a spec in
  this repo runs ~10-45 KB; the cap is ~5× the largest". Measured on this checkout
  (`find .ai/specs -maxdepth 1 -name '*.md' -printf '%s\n'`): **204 top-level specs, mean 36,838
  bytes, and the largest is 618,607 bytes** — with **three** already over 200,000. A 200 K cap
  would silently truncate real, existing specs, and truncating the artifact under review is the
  one thing this feature must not do. 1,000,000 is ~1.6× the largest observed and remains a
  bound, not a policy.
- Review reports arrive already capped at `CHECK_OUTPUT_CAP = 20_000` (`run.ts:151`); the writer
  re-applies its own cap rather than trusting the caller.

**Storage against the real retention window.** Retention keeps `MAX_RUNS_KEPT = 300` active plus
`MAX_ARCHIVED_KEPT = 500` archived runs (`store.ts:606-607`, applied `store.ts:1457-1458`), so
800 runs is the ceiling of retained logs.

| per run | log size | × 800 retained |
| --- | --- | --- |
| measured mean (3 revisions × 36,838 B + 3 reports × 20 KB) | ~168 KB | **~131 MB** |
| largest spec observed (3 × 618,607 B + 60 KB) | ~1.8 MB | ~1.4 GB |
| absolute cap (3 × 1,000,000 + 60 KB) | ~2.9 MB | ~2.3 GB |

The mean row is the expectation and is acceptable. The two lower rows are ceilings that require
*every one of 800 retained runs* to have gone three full revisions on a near-largest spec; no run
in this repo's history has done so. They are stated rather than hidden because the cap was raised
5× and that is the cost of the raise. Mitigation is unchanged and is in Risk 1: the file is
pruned in both `deleteRun` and the retention sweep, and nothing else writes to it.

### The summary on `RunRecord`

```ts
/** Enough for the header to decide whether the Spec tab exists and whether the feed is worth
 *  rendering, without a second fetch. Deliberately three small numbers: `RunRecord` is
 *  serialised wholesale into `runs.json` on every save (`store.ts:1486`), so nothing large may
 *  live here; the documents themselves are in `<runId>.spec-review.ndjson`. */
export const specReviewSummarySchema = z.object({
  revisions: z.number().int().min(0),
  reviews: z.number().int().min(0),
  latestVerdict: z.enum(['pass', 'revise']).optional(),
});
export type SpecReviewSummary = z.infer<typeof specReviewSummarySchema>;

// added in BOTH record schemas, beside declaredSpecPath:
//   packages/contract/src/runs.ts:353   (the wire record)
//   packages/cezar/src/runs/store.ts:328 (the store's own, independent schema — see P1)
specReview: specReviewSummarySchema.optional(),
```

**What the optionality does and does not buy — corrected against the actual schemas.** It is
tempting to say an older build "round-trips the new field untouched". It does not. Both record
schemas are `z.object` (`packages/contract/src/runs.ts:268`, `store.ts:142`), not
`looseObject`/`passthrough`, and the store loads `runs.json` through
`z.array(runRecordSchema).safeParse(raw)` (`store.ts:796`). A build whose schema predates this
field therefore **strips `specReview` on parse and drops it on the next debounced save**
(`store.ts:1486`). Downgrading loses the summary permanently.

The guarantee that actually holds, and that the design leans on:

1. **The wire addition is optional**, so a record written *before* this feature simply has no
   key and parses clean in both directions; no migration and no backfill.
2. **The side log is authoritative.** `<runId>.spec-review.ndjson` is the record of what
   happened; `specReview` on `RunRecord` is a derived cache whose only job is to let the header
   decide the tab exists without a second fetch. Losing it never loses data.
3. **A summary lost to a crash must be reconciled on load, not waited out.** An earlier draft
   said losing the summary costs "a tab that appears one poll late". **That is false, and the
   reason is the debounce.** `runs.json` is saved on a debounced timer
   (`store.ts:1472-1475`, "Debounced so token-usage updates don't rewrite the index per event"),
   while the NDJSON append is immediate. So the window where the side log exists and the
   `runs.json` summary does not is a real, reachable state after a kill or a power loss — and in
   that state the run record has **neither** `specReview` **nor**, if the crash also predated the
   `declaredSpecPath` save, `declaredSpecPath`. The header's render condition is exactly
   `run.specReview !== undefined || run.declaredSpecPath !== undefined` (P3), so **the tab is
   never shown, the route is therefore never polled, and nothing ever recomputes the summary.**
   It is not one poll late; it is permanently invisible for that run. Nothing self-heals, because
   the only writer of `specReview` is the step loop of a run that has already ended.

   **Reconciliation, in `RunStore`'s load path.** After `runs.json` is parsed and before the run
   list is exposed to any caller (i.e. inside the same load that `store.ts:796` performs), for
   each record with `specReview === undefined`, `statSync` its `specReviewLogPath(id)`. If the
   file exists and is non-empty, read it with `readSpecReviewEntries`, recompute
   `summariseSpecReview(entries)`, and set it on the record. Bounded and cheap by construction:
   it is one `stat` per run, and it only reads a file for the runs that have a log and no
   summary, which after a clean shutdown is none. It is also **fail-open** like every other write
   in P1 — a read error leaves the record as it was and never blocks the load. Asserted in P1
   test 7c: write a store where `<runId>.spec-review.ndjson` holds a full spec/review sequence
   and `runs.json` carries the run with **no** `specReview` key at all, reopen the store, and
   require `listRuns()` to report the recomputed summary (and therefore the header condition to
   be true) on the first read, with no route call in between.
4. **The read route never trusts it.** `GET /runs/:id/spec` computes the `summary` in its
   response by calling `summariseSpecReview(entries)` on the log it just read, not by echoing
   `run.specReview` — so a record summary that is absent (old run, downgraded build) or stale
   (crash between the append and the save) cannot produce a wrong feed. The two are allowed to
   disagree, and the log wins.

## API contracts

### `GET /api/v1/runs/:id/spec` (new, additive)

Also answers at the project-scoped `/api/v1/p/<projectId>/runs/:id/spec`, like every run route.

**200**

```ts
export const specReviewFeedResponseSchema = z.object({
  /** The path the newest spec entry names, when there is one. */
  specPath: z.string().max(500).optional(),
  /** Chronological: spec, review, spec, review… Empty when nothing was recorded and no
   *  fallback file could be read. */
  entries: z.array(specReviewEntrySchema),
  summary: specReviewSummarySchema,
});
export type SpecReviewFeedResponse = z.infer<typeof specReviewFeedResponseSchema>;
```

**404** `{ error: 'not found' }`, for an unknown run id. Same shape as `/runs/:id/files`
(`server.ts:6006`).

**No 409.** This deliberately differs from `/runs/:id/files` and `/runs/:id/changes`, which
answer 409 `NO_WORKTREE` (`server.ts:6008`) because without a worktree they have literally
nothing to say. This route can still serve every recorded entry from the run's own data dir after
the worktree is gone, which is the main case where the feed is valuable, since a finished run's
worktree is reclaimed. A run with no recorded entries **and** no readable fallback answers
`200 { entries: [], summary: { revisions: 0, reviews: 0 } }` and the tab shows an empty state.

### Resolution order in the handler

1. `readSpecReviewEntries(dataDir, runId)`. If non-empty → `source: 'recorded'` entries, return.
2. Else if `run.declaredSpecPath` is set and `workingDirectoryOf(run, repoRoot)`
   (`server.ts:6290`) resolves: `readWorktreePath(workingDirectory, run.declaredSpecPath)`. On a
   `kind: 'file'` result with content, return one synthetic entry, `source: 'worktree'`,
   `revision: 1`, `stepId: ''`. Traversal safety comes free: `readWorktreePath` already rejects
   anything escaping the worktree, which is why the route reuses it instead of reading the path
   itself.
3. Else return the empty answer.

### Live updates

The route is not on the SSE stream. Two mechanisms, both cheap:

- The web query polls at 5 s while the run is active, exactly as the Commits tab does
  (`task-commits.tsx:38`, `useRunCommits(run.id, isRunActive(run.status))`).
- `run.specReview` rides the existing record fan-out (`store.updateRun` → `touch` → SSE), so the
  **tab itself** appears the moment the first spec is recorded, with no poll and no new event
  type. This is why the summary lives on the record.

A dedicated metadata-only event was considered and dropped: the record fan-out already carries
the only fact the header needs, and one more event type is one more thing to keep out of
`STANDALONE_TYPES`.

### Unchanged surfaces

`POST /runs/:id/approve` (`server.ts:5453`) and `POST /runs/:id/request-changes`
(`server.ts:5462`) are untouched. `pendingApproval` (`runs.ts:210-232`) is untouched.
`declaredSpecPath` keeps its exact current meaning and writer.

## Risks

1. **Disk growth per run.** Worst case on the built-in chain is 3 spec entries + 3 review
   entries. At the corrected `SPEC_SNAPSHOT_CAP = 1_000_000` that is a ~2.9 MB ceiling per run
   and ~2.3 GB across the full 800-run retention window; **at the measured mean it is ~168 KB per
   run and ~131 MB retained**. Full arithmetic and the measurement behind it are in
   **Data models → Caps**. Mitigations: the per-entry cap; the file is pruned in both `deleteRun`
   and the retention sweep (P1); nothing else writes to it. **Verify the prune**: a side file
   that survives its run is the failure mode here, and it is silent.
2. **A secret in a review report or a spec.** Mitigated by running `redactSecrets` over every
   entry before the line is written, with the `CEZ_REDACT_SECRETS=0` opt-out honoured, matching
   `store.ts:1330`. Untested redaction is the same as none, so P1's verification asserts it
   directly.
3. **The spec-path marker not firing.** If a `spec` step never emits `CEZ:SPEC_PATH=`, nothing is
   snapshotted and the feed falls back to whatever `declaredSpecPath` holds, possibly nothing.
   The tab then does not render, which is honest but invisible. Accepted: the built-in prompt
   makes the declaration mandatory (`types.ts:1246`) and the chain's later steps already depend on
   it. Not accepted silently, in two ways: the `missing: true` entry covers the adjacent case
   where a path is declared but does not resolve; and a verdict that arrives with **no** captured
   spec is written as a review entry with `revision` **absent** rather than being force-labelled
   revision 1 (**Data models → Revision assignment**), so the log never invents a draft. The feed
   renders that unmatched review, unlabelled — the reviewer's objection is exactly the thing worth
   showing when the snapshot is the part that failed. Asserted by P1 test 5b and P3 test 20b.
4. **Reading a large file synchronously inside the step loop.** The snapshot read happens once per
   spec attempt, on a file of tens of KB, at a point where the loop has just finished awaiting an
   agent step. Negligible, but it must not throw: wrap it, and on failure emit a `note` and
   continue. **A snapshot failure may never fail a run**; this is a display feature.
5. **Feed length in the browser.** Up to 6 markdown documents rendered at once through
   `Streamdown` (`routes/task-thread/markdown.tsx`) — and with the cap now at 1,000,000
   characters, a single one of them can be far larger than the 200 K this risk was originally
   sized against. Mitigation: review cards render expanded (they are short and are the point),
   spec cards after the first render **collapsed** with a one-line header
   (`Spec, revision 2 · 41 KB`), expandable. Only the newest spec is expanded by default.
   **A collapsed revision must not mount `Streamdown` at all** — render the one-line header only,
   and mount the markdown renderer on expand. Collapsing a card that has already parsed and laid
   out a megabyte of markdown saves nothing; the cost is in the parse and the DOM, not the
   scrollback. This is a requirement of the phase, not an optimization to consider later.
6. **Contract drift.** Adding a route without the `BACKWARD_COMPATIBILITY.md` §2 entry breaks
   `bc-route-inventory.test.ts`, and adding a schema that does not match the handler breaks
   `contract-parity.*.test.ts`. Both are guards, not obstacles, but they mean P2 is one commit,
   not two.
7. **Name collision with the three existing `review` concepts.** Mitigated by the `specReview`
   namespace decided in the header, and checked mechanically: `grep -rn "reviewGate\|ReviewPanel"`
   must show no new hits from this change.

## Verification

Gates green is necessary, not sufficient. Every step below is executable as written from the repo
root.

### Repository gates

**Corrected: there is no `npm run lint` in this repository.** An earlier draft listed it. Grepped
every `package.json` in the workspace (root and `packages/*`): **no workspace defines a `lint`
script**, so `npm run lint` exits non-zero on a missing script and cannot be a gate. The gates
that actually exist, from the root `package.json`:

```bash
npm run typecheck     # contract → api-client → server → web (pretypecheck builds the server first)
npm test              # vitest run, whole workspace
npm run test:unit     # -w @loki-labs/cezar-plus — a SEPARATE Node test suite, not part of npm test
npm run build         # build:server + build:web + check:pack + build:stamp
npm run test:package  # -w @loki-labs/cezar-plus
```

All **five** must be green. This is the repository's own five-command gate as recorded in the
domain record (`notion-export/domains/cezar.md`: *"Five-command gate: `npm run typecheck`,
`npm test`, `npm run test:unit`, `npm run build`, `npm run test:package` — cezar has no lint or
format step"*), and all five exist in the root `package.json` (`test:unit` at `package.json:33`).
An earlier draft of this section dropped `test:unit` and said "all four": `npm test` is
`vitest run` and **does not** include it — it is a distinct suite run through the `@loki-labs/cezar-plus`
workspace — so a four-command gate leaves a suite unrun while reporting green.
`npm test` includes `bc-route-inventory.test.ts`,
`contract-parity.*.test.ts`, `versioned-surface.test.ts` and `routes.test.tsx`, which are the
guards P2 and P3 are most likely to trip. `npm run build` matters here beyond typecheck because
P3 adds a route module and `check:pack` is what catches a file that never made it into the
published surface.

**These commands are not run by the spec step.** The workspace default is that nothing gets
built or run without asking, so executing them requires the owner's approval; the implementing
step must obtain it and then quote the real output. A gate reported without its output is not a
gate.

### P1 automated (`packages/cezar/src/runs/spec-review-log.test.ts`, new)

1. **Append and read back.** Append `spec` → `review(revise)` → `spec` → `review(pass)` into a
   `mkdtempSync` data dir; `readSpecReviewEntries` returns four entries in that order, with `seq`
   `0..3` and `revision` `1,1,2,2`.
2. **Summary.** `summariseSpecReview` on that fixture returns
   `{ revisions: 2, reviews: 2, latestVerdict: 'pass' }`.
3. **Truncation.** Appending a spec entry of `SPEC_SNAPSHOT_CAP + 1` characters yields
   `truncated: true` and `text.length === SPEC_SNAPSHOT_CAP`.
3b. **`seq` is max-plus-one over VALID entries, across a gap and past corruption.** Hand-write a
   log holding a valid entry with `seq: 0`, then a raw `{ not json\n` line, then a valid entry
   with `seq: 4`. `readSpecReviewEntries` returns **two** entries (the malformed line is
   skipped). Append a third: it must be **`seq: 5`**. `entries.length` would have produced `2`,
   colliding with nothing visible but duplicating a `seq` that exists on disk, so assert `5`
   explicitly and assert the three raw `seq` values on disk are strictly increasing. Repeat with
   a log whose every line is malformed → the first successful append is `seq: 0`.
4. **Redaction.** With a known secret in the environment such that `collectSecretValues()` returns
   it, appending a review report containing it verbatim writes a line whose raw bytes do **not**
   contain it. Repeat with `CEZ_REDACT_SECRETS=0` and assert the opt-out is honoured.
5. **Malformed line tolerance.** Append a raw `not json\n` into the file by hand;
   `readSpecReviewEntries` still returns the valid entries and does not throw.
5b. **Unmatched review — the no-spec case.** Append a `review` entry into an **empty** log. The
   written entry has **no `revision` key** (asserted on the raw JSON, not just the parsed object,
   so an `undefined`-vs-absent slip is caught), and is not labelled revision 1. Then append a
   `spec` entry and assert it takes `revision: 1` — the unmatched review does **not** consume a
   revision number.
5c. **Revision assignment is derived from the log, not from a counter.** Append
   `spec, review, spec`, then construct a *fresh* module instance / fresh process view over the
   same data dir and append another `spec`: it must be `revision: 3`, proving the max-plus-one
   rule reads the file and survives a restart mid-run. Assert reviews inherit the latest spec's
   revision (`1, 2`), never their own sequence number.
6. **Missing file.** `readSpecReviewEntries` on a run with no file returns `[]`.

### P1 automated (`packages/cezar/src/runs/store.test.ts`, extended)

7. **Prune, both paths.** Create a run, write its spec-review log, `deleteRun` it, assert
   `existsSync(specReviewLogPath) === false`. Repeat by driving the retention sweep past
   `MAX_RUNS_KEPT` and assert the same for a pruned run. (This is risk 1; it is the assertion most
   likely to be skipped and most likely to matter.)
7b. **The summary survives a reload of `runs.json`.** `updateRun(id, { specReview: { revisions:
   2, reviews: 2, latestVerdict: 'pass' } })`, force the debounced save, then construct a **new
   `RunStore` over the same data dir** and assert `getRun(id)?.specReview` still deep-equals what
   was written. This is the test that fails if `specReview` was added only to the contract's
   `runRecordSchema` and not to the store's own at `store.ts:328`: the field is stripped by
   `z.array(runRecordSchema).safeParse` on load (`store.ts:796`) and the assertion reads
   `undefined`. Without this test that mistake ships as an intermittently-missing tab.
7c. **Crash recovery: a side log whose summary was never saved.** Construct a data dir by hand in
   which `<runId>.spec-review.ndjson` holds a full `spec → review(revise) → spec → review(pass)`
   sequence while the run's entry in `runs.json` has **no `specReview` key and no
   `declaredSpecPath`** — the exact state the debounced save (`store.ts:1472-1475`) leaves after
   a kill. Open a **new `RunStore`** over that dir and assert, on the **first** `listRuns()` /
   `getRun(id)` and with no HTTP call in between, that `specReview` deep-equals
   `{ revisions: 2, reviews: 2, latestVerdict: 'pass' }`. Without the load-path reconcile the
   header condition stays false forever and the tab is never shown for that run — not "one poll
   late", never. Second case: the same fixture with the log file made unreadable (`chmod 000`, or
   a stubbed reader that throws) must still open the store, return the run with `specReview`
   absent, and **not** throw.

### P1 automated (`packages/cezar/src/workflows/run.*.test.ts`)

8. **The loop is recorded end to end**, on the existing dry-run/mock harness the workflow tests
   already use: a `spec` step that declares `CEZ:SPEC_PATH=.ai/specs/x.md` and writes that file,
   a `review-spec` step that emits `CEZ:REVIEW=revise` with a FILE/SECTION/CHANGE report, a second
   `spec` attempt that rewrites the file, and a `CEZ:REVIEW=pass`. Assert the log holds exactly
   `spec(v1 text) → review(revise, report) → spec(v2 text) → review(pass)`. In particular, **entry 1 still holds v1's text after the file was overwritten**, which is the whole point of
   the feature.
9. **`pass` first time.** Same harness, single `CEZ:REVIEW=pass`: log holds `spec → review(pass)`,
   `run.specReview.revisions === 1`, `latestVerdict === 'pass'`.
10. **Declared path that does not exist** → one entry with `missing: true`, no `text`, and the run
    still reaches `done`. This is risk 4's assertion: snapshotting must never fail a run.
10b. **A hostile `CEZ:SPEC_PATH` persists no host-file content.** Table-driven over declared
    paths that must all be refused by `readWorktreePath`: `../../etc/passwd`; an absolute
    `/etc/passwd`; `.git/config`; a **final component that is a symlink** to a file outside the
    worktree; and a path **through an intermediate symlinked directory** (`link/secret.txt` with
    `link -> /etc`). For each: the run reaches `done`, exactly one entry is written, it carries
    `missing: true` / `rejected: true` and **no `text`**, and — asserted on the file's raw bytes,
    not the parsed object — the log does not contain any byte of the target file's contents. The
    two symlink cases are the ones a hand-rolled `startsWith` check passes and this code must
    not: they exist because the same hole was a blocker on the Files tab
    (`git-changes.ts:565-583`).
10c. **Fail-open: the spec snapshot writer throws.** Inject a writer that throws `ENOSPC` on the
    `spec` append. The run must finish with the **same** verdict, the same number of `spec`
    attempts and the same retry decision as an uninjected control run of the identical fixture
    (assert against the control, not against a hard-coded expectation). A redacted
    `spec-review log unavailable (ENOSPC)` note is on the thread, carrying **no path and no
    message text**, and `state.stepSpecPath` is cleared so the next attempt does not re-snapshot
    a stale path.
10d. **Fail-open: the agent-review append throws.** Same control comparison; the `revise` verdict
    must still loop the chain back to `spec` and `onFail.max` must still bound it.
10e. **Fail-open: the human-review append throws, and the human's action is still honoured.**
    Drive the approval gate to **Request changes** with a throwing writer. Assert the request is
    **accepted** (the approval outcome is applied, the run loops back to `spec`), not rejected or
    surfaced as an error to the caller — the approval path must never be gated on a display
    feature's log write. Also assert `updateRun` failing on the summary write has the same
    outcome.

### P2 automated (`packages/cezar/src/server/*.test.ts`)

11. `GET /api/v1/runs/:id/spec` on a run with a recorded log returns the entries in order, with
    `source: 'recorded'` and a `summary` matching the record.
12. Unknown run id → 404 `{ error: 'not found' }`.
13. **Fallback.** A run with no log, `declaredSpecPath` set, and the file present in a temp
    worktree → one entry, `source: 'worktree'`, `revision: 1`, content matching the file.
14. **Empty.** A run with no log and no `declaredSpecPath` → `200 { entries: [], summary: {
    revisions: 0, reviews: 0 } }`. Explicitly **not** a 409.
15. **Traversal.** `declaredSpecPath` of `../../etc/passwd` → the fallback read is refused by
    `readWorktreePath` and the route answers the empty 200, never file content.

### P3 automated (`packages/web/src/routes/task-spec/task-spec.test.tsx`, new;
`run-header.test.tsx` and `routes.test.tsx` extended)

16. **Tab visibility.** `RunHeader` with a run carrying neither `specReview` nor
    `declaredSpecPath` renders **no** Spec tab; with either present, it does, positioned between
    Session and Changes.
17. **Clean pass renders no feed.** A feed of `spec → review(pass)` renders the spec body and the
    accepted-by-review line, and **no** review card and no revision-2 heading. This is the
    owner's "if review was passed, don't show", asserted directly.
18. **Revised run renders the feed in order.** A feed of `spec → review(revise) → spec →
    review(pass)` renders four cards in document order, the review card showing the reviewer's
    FILE/SECTION/CHANGE text, the final spec expanded and the earlier spec collapsed.
18b. **The human-gate sequence, which is the one that does not alternate.** Fixture, in raw log
    order exactly as the writers produce it (**Solution → "The raw log does not alternate"**):

    ```
    spec(rev 1) · review{agent, pass, rev 1} · review{human, revise, rev 1} · spec(rev 2) · review{agent, pass, rev 2}
    ```

    Five raw entries. `toFeedCards` must return **four** cards, and the rendered feed must read
    `spec v1 → requested changes (human) → spec v2 → final verdict (agent pass)`. Assert
    specifically that the **revision-1 agent `pass` renders no card** (it was provisional — the
    run looped back after it) while the **revision-2 agent `pass` does** (it is the final
    verdict). Without this test the obvious implementation renders five cards reading "approved,
    then revised anyway", and the Runtime E2E's revised-feed step cannot pass.
18c. **The FIRST human gate: a pass is not final while approval is pending.** Fixture
    `spec(rev 1) · review{agent, pass, rev 1}` — nothing after it — mounted with a run whose
    `run.pendingApproval` is set on the `review-spec` step. The feed must render the neutral,
    non-terminal line **"agent review passed, awaiting human approval"**, and must render
    **neither** the accepted-by-review note (test 17's clean-pass rendering) **nor** a
    final-verdict card, and must not mark the feed complete. Then clear `pendingApproval` on the
    same fixture and assert it becomes the final verdict card. Without this the tab shows
    "accepted" to the very person who is at that moment being asked whether to accept it.
18d. **The SECOND gate, after a revision.** Same assertion one revision later: fixture
    `spec(1) · review{agent,pass,1} · review{human,revise,1} · spec(2) · review{agent,pass,2}`
    **with `pendingApproval` set again** must render `spec v1 → requested changes (human) →
    spec v2 → awaiting human approval`. The awaiting state is not a first-gate special case; it
    recurs at every gate, and an implementation that latches it on `revisions === 1` passes 18c
    and fails here.
19. **Human review card** renders distinguishably from an agent one (`actor: 'human'`).
20. **Empty state.** `entries: []` renders an honest "no spec recorded for this task" state, not a
    spinner and not an error.
20b. **Unmatched review.** A feed of a single `review{agent, revise}` with **no** `revision` and
    no spec entry renders one review card, carrying no revision label and showing the
    "no draft was captured for this verdict" note. Assert it is neither dropped nor labelled
    "revision 1".
21. **Route.** `routes.test.tsx` asserts `/p/:projectId/tasks/:id/spec` resolves to
    `TaskSpecRoute`, and that the legacy flat `/tasks/:id/spec` redirects to the scoped twin
    preserving query and hash (the existing legacy-redirect assertions extended by one path).
21b. **The analytics wrapper owns no transport.** Assert `packages/web/src/api/analytics.ts`
    contains **zero** occurrences of `fetch(` (read the module source in the test and grep it),
    and that `trackEvent` calls `postAnalyticsEvents` from `packages/web/src/api/client.ts` —
    spied, asserted called once. This is the guard against a second, un-gated transport that
    would miss `credentials: 'include'`, `redirect: 'manual'` and `throwIfIdentityGate`, and
    would therefore report a Cloudflare Access bounce as a network failure.
21c. **`mode` is exhaustive.** Five fixtures, one per value, each asserting the exact `mode` on
    the emitted event: `draft` (one spec, zero reviews) · `clean` (spec + pass, no revise) ·
    `revised` (any revise present) · `unmatched` (a review with no spec entry) · `empty` (a
    successful response with `entries: []`). Plus two `approvalPending` cases: the 18c fixture
    must emit `approvalPending: true` with `mode: 'clean'`, and the same fixture with
    `pendingApproval` cleared must emit `approvalPending: false`. A sixth assertion pins the
    union: the classifier's return type is a closed union of exactly those five strings, so
    adding a state without classifying it fails typecheck rather than defaulting to `clean`.
22. **Analytics fires exactly once.** With the client's transport stubbed, mount `TaskSpecRoute`
    on a `revised` fixture and assert one `POST /api/v1/workspace/analytics/events` carrying
    `{ name: 'spec.feed_opened', props: { project, mode: 'revised', approvalPending, revisions, reviews, source } }`
    — every prop a scalar, no spec or report text anywhere in the body. Then, in the same test:
    (a) advance timers past the 5 s `refetchInterval` and let the query refetch — **still one**
    POST; (b) re-run the effect the way StrictMode double-invocation does — **still one**;
    (c) render the loading and error states — **zero** POSTs. Also assert the route renders
    normally when the analytics `fetch` rejects (fail open), since that is the whole point of the
    helper's contract.

### Runtime E2E (required before this is called Done)

Automated coverage above proves the plumbing. It does not prove a person can read the argument,
so this must actually be executed, produce retained artifacts, and have its result quoted.

**Approval first.** This pass boots a server and drives **real agent runs**, which the workspace
default forbids doing unattended. Obtain the owner's explicit approval for *both* — starting the
cockpit process and letting real `spec` / `review-spec` agents run — before step 0, and record
that approval in `notes.md`. Nothing below may be started on the implementer's own initiative.

**Isolation — `CEZ_HOME` alone does NOT isolate this, and an earlier draft's sequence was not
executable.** Two corrections, both verified in this checkout:

- **`CEZ_HOME` scopes workspace-global state only** — the project registry, `analytics/`,
  agent accounts, cluster state (`.env.example:147-149`: "servers started with different
  `CEZ_HOME` values serve disjoint sets of projects"). A **run's own state still persists under
  the selected project's `.ai/cezar`**: `RunStore` writes `<dataDir>/runs/<runId>.ndjson`
  (`store.ts:1435`), and `dataDir` is the project's `.ai/cezar`. So setting `CEZ_HOME` and then
  driving a run against *this* checkout would write run state, side logs and worktrees into the
  repo the spec is being written in. The isolation boundary must be a **fixture repo**, not just
  a temp home.
- **`npm run dev` always boots this source checkout.** `scripts/dev.mjs` pins
  `repoRoot = <this checkout>` and spawns `dev:server` with `cwd: repoRoot` and only
  `--port`/`--no-open` — it forwards no `--repo`. There is no way to point `npm run dev` at
  another repo. Use `dev:server` directly, which does take `--repo` (`src/index.ts:145`),
  `-p/--port` (`:322`) and `--no-open` (`:326`).

```bash
# 0. approval obtained and recorded. Then, from the repo root:
export E2E_ROOT="$(mktemp -d /tmp/cezar-e2e-specfeed.XXXXXX)"
export CEZ_HOME="$E2E_ROOT/home"                 # workspace-global state only (.env.example:149)
export FIXTURE_REPO="$E2E_ROOT/fixture-repo"
export CEZ_ANALYTICS=1                           # see below — never inherit the opt-out
export E2E_PORT=4399                             # not 4321; must not collide with a live cockpit
mkdir -p "$CEZ_HOME" "$FIXTURE_REPO/.ai/cezar" .ai/qa/artifacts_e2e/spec-review-feed

# a real git repo, because the workflow branches, commits and merges
git -C "$FIXTURE_REPO" init -q
printf '# fixture\n' > "$FIXTURE_REPO/README.md"
git -C "$FIXTURE_REPO" add -A
git -C "$FIXTURE_REPO" -c user.email=e2e@local -c user.name=e2e commit -qm 'init'

# the human approval gate is what this pass depends on: minApprovers >= 1 makes
# `review-spec`'s requiresApproval (types.ts:1270) actually park the run.
cat > "$FIXTURE_REPO/.ai/cezar/config.json" <<'JSON'
{ "approvals": { "minApprovers": 1 } }
JSON

npm run build:web        # dev:server serves packages/web/dist; without it every shell route
                         # renders the build-hint page (static-ui.ts:16, :67)
npm run dev:server -- --repo "$FIXTURE_REPO" -p "$E2E_PORT" --no-open
```

**`CEZ_ANALYTICS=1` is exported deliberately.** The sink honours the **exact** string `'0'` and
nothing else (`packages/cezar/src/workspace/analytics-log.ts:58-62`), and this box's environment
may already carry it. An inherited `CEZ_ANALYTICS=0` would make the analytics assertion below
fail while the feature is working perfectly — a false failure that reads as a real one. Setting
it explicitly removes the ambiguity in both directions. The same applies to the automated
analytics tests, which set it in their own env rather than relying on the ambient value.

Run state, side logs and worktrees all land under **`$FIXTURE_REPO/.ai/cezar/`**; the analytics
sink lands under **`$CEZ_HOME/analytics/events.ndjson`**. The real project config and this
checkout's `.ai/cezar` are **not touched**. Nothing outside `$E2E_ROOT` and
`.ai/qa/artifacts_e2e/spec-review-feed/` is written.

**Artifacts are part of the pass, not a nicety.** Every numbered step below captures
`NN-<name>.png` into `.ai/qa/artifacts_e2e/spec-review-feed/` (the directory the existing e2e
specs already use, e.g. `packages/web/e2e/backlog-composer.e2e.ts:10`), numbered so the sequence
reads as a filmstrip, plus either a screen recording of the whole pass
(`00-pass.webm`/`.mp4`) or, if the provider cannot record, the numbered stills assembled into a
clearly labelled filmstrip video. `notes.md` in the same directory records the two run ids, the
observed feed order, and any deviation.

The order below is the order the artifacts must be captured in. It differs from an earlier draft,
which captured "no tab yet" *after* requesting changes — by which time the tab necessarily exists,
so the shot could never show what it claimed to.

1. Cockpit booted against the fixture: open `http://localhost:$E2E_PORT`, confirm the project
   shown is `$FIXTURE_REPO` and not this checkout. → `01-cockpit-booted.png`
2. Start a `spec-to-deploy` task in the fixture project. **Record its id** — `$REVISED_RUN`.
3. **While the first `spec` step is still running**, open the task: **the Spec tab must not be
   present yet.** This is the first thing captured after the start, before any gate.
   → `02-no-spec-tab-yet.png`
4. When that step finishes, the tab appears **without a page reload** (record fan-out, not a
   poll). → `03-spec-tab-appears.png`
5. The run parks at `review-spec`'s approval gate. Open **Spec** here: with `pendingApproval` set
   and the agent's `pass` already in the log, the feed must show **"agent review passed, awaiting
   human approval"** — **not** the accepted note and **not** a final-verdict card (the runtime
   twin of P3 test 18c). → `04-awaiting-approval.png`
6. Click **Request changes** with a concrete note. This is the deterministic way to force a
   loop-back without waiting on a real agent `revise`, and it exercises the `actor: 'human'`
   write path at `run.ts:6772`, producing a real second `spec` attempt.
   → `05-request-changes.png`
7. When the second `spec` attempt and its `review-spec` finish, the run parks at the **same gate
   again** (revision 2). Confirm the awaiting-approval line is shown again, one revision later
   (the runtime twin of P3 test 18d). → `06-awaiting-approval-rev2.png`
8. **Approve it.** The final `pass` is only final once the human gate clears — asserting a final
   verdict while `pendingApproval` is still set would be asserting the state this spec exists to
   stop showing. After approval, open **Spec**: the visible feed must read
   **spec v1 → the requested changes → spec v2 → the final verdict**, in that order, with v1's
   text visibly different from v2's — and with **no card for the revision-1 agent `pass`**, which
   is in the raw log but is provisional (**Solution → "The raw log does not alternate"**; P3 test
   18b is its unit-level twin). → `07-revised-feed.png`
9. **Cancel the run immediately after that screenshot.** Approval releases the gate and the
   workflow continues into `implement`, `run-tests`, `commit-push`, `merge`, `document` and
   `deploy` — six further steps that would spend agent budget and push a fixture branch. Nothing
   past `review-spec` is under test here. Confirm the run shows `cancelled`.
   → `08-cancelled.png`
10. Count the raw entries — `head -c 400` truncates and cannot count, so use `wc -l`:

    ```bash
    LOG="$FIXTURE_REPO/.ai/cezar/runs/$REVISED_RUN.spec-review.ndjson"
    wc -l < "$LOG"        # MUST print 5
    head -n 2 "$LOG"      # hand-readable NDJSON per the README promise
    ```

    **Five** raw entries against **four** rendered cards is the assertion: it is the file-level
    proof that the provisional `pass` was suppressed at display time and not discarded at write
    time. Paste both outputs into `notes.md`.
11. Start a second task and **approve at its first gate** so it passes review first time.
    **Record its id** — `$CLEAN_RUN`. Its Spec tab shows the spec with the accepted-by-review
    note and **no** feed cards. Cancel it immediately afterwards, for the same reason as step 9.
    → `09-clean-pass.png`
12. Confirm the analytics events landed, once per tab open and never with a body carrying spec
    text: `grep spec.feed_opened "$CEZ_HOME/analytics/events.ndjson"`. Expect
    `mode` values including `revised` and `clean`, one line per tab open, and — grep for it —
    **no** spec or report text in any line. If the file does not exist at all, check
    `CEZ_ANALYTICS` before concluding the emitter is broken. → `10-analytics.png` (or paste the
    lines into `notes.md`; a terminal shot is fine).
13. **Delete both runs** from the cockpit and confirm **both** side files are pruned — one run
    proves `deleteRun` only for the path that ran, and the clean run exercises the summary-only
    shape:

    ```bash
    test ! -e "$FIXTURE_REPO/.ai/cezar/runs/$REVISED_RUN.spec-review.ndjson" && echo pruned-revised
    test ! -e "$FIXTURE_REPO/.ai/cezar/runs/$CLEAN_RUN.spec-review.ndjson"   && echo pruned-clean
    ```

    Both lines must print (risk 1). → `11-deleted.png`
14. **Ownership, per the workspace rule** — run from anywhere on the box after the pass:

    ```bash
    find /var/lib/cezar -not -user cezar | wc -l    # MUST print 0
    ```

    Quote the output. A non-zero count means something in this pass wrote as `root` and must be
    fixed before Done, not chowned after the fact.
15. Stop the server, then clean up **the whole fixture**, once the artifacts are copied out of
    `$E2E_ROOT`: `rm -rf "$E2E_ROOT"` (which removes `$CEZ_HOME` and `$FIXTURE_REPO` together).
    Confirm with `test ! -e "$E2E_ROOT" && echo clean`.

Record `$REVISED_RUN` and `$CLEAN_RUN`, the observed feed order, the five-entries-four-cards
counts, and the artifact directory path into this spec's Status line. Until steps 0-15 have
actually been run and their artifacts exist, this ships as **QA Needed**, not Done.

## Out of scope (recorded, not forgotten)

- **Diffing revisions.** A "what changed between v1 and v2" view is the obvious next ask, and the
  data model supports it (both texts are stored). Deliberately not in this spec: the owner asked
  for a feed, and a diff view is a second design with its own decisions about intra-line
  rendering.
- **Editing the spec from the tab.** Read-only, matching every other run tab.
- **Backfilling old runs.** Impossible: the text no longer exists. The `source: 'worktree'`
  fallback is the honest best available and is labelled as such.
- **Making `review-spec` skippable.** The brief's open question 4 asked whether it ever does not
  run. Re-checked here: nothing in `types.ts` or `run.ts` makes the step conditional, and unlike
  the diff-review gate it has no `CEZ_*` switch. The tab's visibility rule
  (`specReview || declaredSpecPath`) is written so that it does not care either way, which is the
  robust answer regardless.
- **Phase 4 of `.ai/specs/2026-08-21-structured-review-targeted-spec-edits.md`**, the outstanding
  runtime measurement of the targeted-edit fix. Unrelated to this feature; not touched.
