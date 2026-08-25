# Manual Deploy Handoff

**Status:** Implemented 2026-08-25 in commit `ea40c7a1`, landed on the base branch. Automated verification is recorded as green for typecheck, build, package (25/25), and the full npm test suite (11,784 passed, 4 skipped). The unit gate retains 8 pre-existing `deploy-e2e-probe.test.ts` failures, and the fixture runtime E2E in Verification steps 6-13 was not run. QA Needed, awaiting that runtime proof and the expected human deployment.
**Repo:** `cezar` (implementation commit `ea40c7a1`; the spec was written against pre-implementation HEAD `e38cb619`).
**Brief:** `.ai/specs/briefs/2026-08-24-manual-deploy-handoff-not-a-bug.md` in the workspace scratch repo (KB `specs-315efafabb3e`), written by step 1 of this run. Every claim it makes was re-derived here from the files themselves; one of its line citations is corrected below.

**Completes, does not supersede:** `.ai/specs/2026-08-24-default-workflow-ten-stages.md` (Status: *Partial 2026-08-24*). Two items its own **Phases** section declared did not land, the last item of Phase 5 (the `deploy` prompt) and item 1 of Phase 6 (the `AGENTS.md` correction). This spec lands exactly those, plus the legibility defect their absence exposed. It does **not** touch `manual: true`, which is the owner decision at issue.

**Supersedes, in place, two published instructions, both in `AGENTS.md`, both stale for the same reason:**

- **`AGENTS.md:7`**, the standing-authorization paragraph: *"every change to cezar is always committed, pushed, and deployed, the full loop, no per-session ask […] so a task on cezar ships end to end by default."* The **commit** and **`origin` push** authorization it grants is untouched and stays in force; nothing in this spec narrows it. Only its **deploy** claim is corrected: since `c328ec06` a task on cezar does *not* ship end to end by default, because both targets in `.ai/deploy-targets.json` are `manual: true`, so an agent-run deploy of cezar parks and a person activates.
- **`AGENTS.md:12`**, the self-deploy bullet: *"Always self-deploy, including from inside a running cockpit session […] no handing the restart to a human"*, corrected for **agent-run workflow deployment of cezar only**.

Both supersessions were already decided by `.ai/specs/2026-08-24-default-workflow-ten-stages.md` §D6 and shipped in code as commit `c328ec06`; the prose edit is what never happened. Phase 4 performs it, in **both** locations, because a reader who only sees `:12` corrected is still told at `:7` that cezar ships end to end by default. *(The brief cites this text as `AGENTS.md:213-221`. It is not there: `grep -n` puts the "Shipping cezar itself" heading at `AGENTS.md:5`, the standing-authorization paragraph at `AGENTS.md:7` and the self-deploy bullet at `AGENTS.md:12`, exactly where the ten-stage spec cites it. Corrected here so an implementer does not edit the wrong region.)*

**On quotations in this spec:** house style forbids the em dash, so quoted passages are re-punctuated with commas, colons or ellipses. No quoted wording is otherwise altered; where a character was removed from a source line, the citation says so.

## TLDR

The task says "fix this error: manual deployment required for cezar service (backend)". **That error is not an error.** It is a `manual-deploy` handoff, working as designed, produced by an owner decision made the same day (`c328ec06`, `.ai/specs/2026-08-24-default-workflow-ten-stages.md` §P6/§D6) that marked both of cezar's deploy targets `"manual": true`. The probe's red is also accurate: live is `9c896e32`, HEAD is `e38cb619`, and `git merge-base --is-ancestor 9c896e32 e38cb619` is true, so six commits including a real feature (`48f9892c`, the Backlog composer) are genuinely un-activated in production. Flipping `manual` back to `false` would reverse an owner decision to make a truthful red go green. That is off the table.

What *is* broken is everything around the handoff:

1. **The gate fails open.** The `deploy` step prompt (`types.ts:1455-1469`) never mentions `.ai/deploy-targets.json` or `manual`. It tells the agent to discover and run the repo's own deploy mechanism, which on `prod-host` is `cezar server-deploy --strategy=blue-green`, build, stage, **flip, restart**. An agent that obeys the prompt activates the service, the probe then goes green, and the postcondition reports success. `manual: true` only changes what happens on failure; it cannot prevent the thing it exists to prevent. §D6 of the ten-stage spec declared this prompt change and Phase 5 shipped without it.
2. **The park is illegible.** The handoff `reason` is built from each target's *probe source*, then truncated at 2,000 characters, which is why this task's own title is a wall of shell that stops mid-word at `"bounded-polling rather t"`. The cockpit card renders that string verbatim (`handoff-card.tsx:56`). A human is shown a truncated bash script instead of the one command they must run.
3. **The record still says the opposite, in three places.** `AGENTS.md:7` promises "a task on cezar ships end to end by default", `AGENTS.md:12` commands "Always self-deploy… no handing the restart to a human", and `.ai/deploy-targets.json`'s `$comment` block, which carries three dated corrections and is where a reader learns *why* this file says what it says, never gained the fourth one §D6 promised. All three are why this landed as a "fix this error" task at all.

Four phases: guard the prompt, make the park legible, fix cezar's own target file, correct the two records in place. The unrelated `merge` doc debt that Phase 6 of the ten-stage spec also left behind is **not** part of this change; it is filed as a todo instead (see **Out of scope**).

**This spec does not make the current red green.** Six commits are unshipped and no release candidate for `e38cb619` exists. That clears when a human deploys, and only then.

## Problem

### P1. The manual gate is advisory, not enforced, and it fails open

`.ai/deploy-targets.json` marks both targets `"manual": true` with `"manualReason": "cezar service deployment requires a human to activate the service safely"`. `allServicesDeployed` (`packages/cezar/src/workflows/postconditions.ts:297-367`) honours that: a failing manual target returns `handoff: { kind: 'manual-deploy', … }` instead of a flat red (`:355-365`).

But that is a **verify**-time behaviour, and verify runs *after* the step. The step itself is `deploy` (`packages/cezar/src/workflows/types.ts:1438-1470`), whose prompt says, in full:

> "Now DEPLOY it using THIS repository's own existing deploy mechanism: do not invent a deploy process. […] If you find a clear deploy path, run it and verify it succeeded."

and whose `allowedTools` is `DEFAULT_ALLOWED_TOOLS` with **no `bashAllowlist`**, unrestricted Bash by fixed-grant owner decision (`types.ts:1448-1453`, asserted at `types.test.ts:527-532`). `grep -n "manual\|deploy-targets"` over the prompt body returns nothing but a code comment above it.

The repo's documented deploy path is `cezar server-deploy --strategy=blue-green` (`AGENTS.md:13`), and `runReleaseDeploy` has no stage-only mode: `runGatedDeploy` runs stage → smokeBoot → flip symlink → restart → probeReady as one sequence (`packages/cezar/src/server-install/release-deploy.ts:580-590`). So an agent following its instructions to the letter performs the exact activation the owner withdrew, the probe then passes, and `allServicesDeployed` returns `ok: true`. **The design intent is stated in §D6 verbatim, "The `deploy` step deploys every target where `manual` is falsy, exactly as today, and does not touch the manual ones", and nothing in the code or the prompt implements the second half.**

That this run's agent did not activate is a fact about that agent's judgement, not about the mechanism.

### P2. The handoff reason is a truncated shell script

`allServicesDeployed` accumulates one line per target (`postconditions.ts:344`). Each line is: the `OK  ` / `FAIL` prefix, the target name, a separator character, the target's **probe source** in backticks, and, on failure only, a newline plus `outcome.output`. **Every** target contributes a line, the passing ones included.

The manual branch (`postconditions.ts:354-365`) then builds one string from `manualFailed`'s names, those targets' `manualReason`s, and **all** of the accumulated lines (`:355-359`), and returns it as both `detail` and `handoff.reason` (`:362-363`). cezar's two probes are ~1,400 and ~1,100 characters of bash, and both land in the reason even when only one target is red. `awaitHandoff` then applies `handoff.reason.slice(0, 2_000)` (`run.ts:5814`, `:5822`), and `HandoffCard` renders `{pending.reason}` as a paragraph (`handoff-card.tsx:56`).

The result is this task's own text: the operative sentence ("manual deployment required for cezar service (backend)… requires a human to activate the service safely"), then the backend's probe script, then the **passing** UI target's probe script, cut off mid-token at `"bounded-polling rather t"`. The one thing a human needs, *what command do I run, and what do I click after*, appears nowhere.

### P3. `AGENTS.md` still commands the thing the code now refuses

**Two lines, not one.** Both were re-read at HEAD `e38cb619`:

- **`AGENTS.md:12`** reads: *"**Always self-deploy, including from inside a running cockpit session.** […] Every change ships the moment its gates are green: no quiet window, no handing the restart to a human."* (Re-punctuated per the note above; the source uses em dashes at both points.) It carries a nested `CORRECTED 2026-08-21` sub-bullet about blue-green mechanics, and a further `CORRECTED 2026-08-22` and `CORRECTED 2026-08-23` inside that one, but nothing about 2026-08-24.
- **`AGENTS.md:7`** reads: *"**Owner instruction 2026-08-19: every change to cezar is always committed, pushed, and deployed, the full loop, no per-session ask.** This is standing authorization to `git commit`, `git push` to `origin main`, and deploy (`cezar server-deploy`) […] so a task on cezar ships end to end by default."* Its commit and push half is current and stays. Its deploy half, and the "ships end to end by default" claim that closes the paragraph, are exactly what `c328ec06` withdrew for agent-run deploys, and it says nothing about it.

Phase 6 item 1 of the ten-stage spec declared this correction. `grep -n "CORRECTED 2026-08-24" AGENTS.md` returns nothing, so it never landed, in either location.

This is the load-bearing cause of the task. An agent, a session, or a person reading `AGENTS.md` top-to-bottom is told at `:7` that a cezar task ships end to end by default and at `:12` that handing the restart to a human is forbidden, so a run parked on exactly that reads as a defect to route around.

### P4. `.ai/deploy-targets.json` does not say why it is manual

§D6 states: *"The `$comment` block in that file, which already carries three dated corrections, gains a fourth saying so."* `grep -o "CORRECTED 2026-08-2[0-9]" .ai/deploy-targets.json` returns only `CORRECTED 2026-08-21`. The file declares `manual: true` on both targets with a one-line `manualReason` and no explanation of the two things a reader needs: that this is a 2026-08-24 owner supersession of `AGENTS.md:12`, and that **both** targets are manual because blue-green activation is one atomic flip that restarts the service, so they cannot be activated independently.

### P5. The parked handoff has nothing staged behind it (open question (b) of the brief, now answered)

The brief could not confirm whether a build+stage had run for HEAD. Measured directly:

- `/opt/cezar-releases/` holds seven release directories, newest `20260824T212504Z-9c896e32` (mtime 21:25).
- `/opt/cezar-releases/deploy.json` → `"current": "20260824T212504Z-9c896e32"`, `"previous": "20260824T211209Z-33ac3b20"`.
- `/opt/cezar` → symlink to `/opt/cezar-releases/20260824T212504Z-9c896e32`.
- `GET /api/v1/ready` → `{"deploy":{"releaseId":"20260824T212504Z-9c896e32","sha":"9c896e32…","activatedAt":"2026-08-24T21:25:09.801Z"}}`, `"ready":true`.

**No release candidate exists for `e38cb619` or for `48f9892c`.** So the handoff is not "staged, awaiting a flip": it is "nothing built." A human pressing **Resolve** triggers a re-probe (`run.ts:5846-5850`), which is still red, and the run stays parked (`:5852-5860`). The card's Resolve button cannot go green until a person has separately built, staged *and* activated. That is a fact this spec records rather than fixes: `server-deploy` has no stage-only mode, and adding one is a different change (see **Out of scope**).

## Solution

### D1. The `deploy` prompt reads the target file first and refuses manual targets

Add to the `deploy` step prompt, before "First DISCOVER how this repo deploys":

> Read `.ai/deploy-targets.json` first, if it exists. A target with `"manual": true` is one a **person** deploys, for the reason its `manualReason` gives. You must **not** deploy, activate, restart, flip or otherwise ship it, and you must not work around it. Deploy only the targets where `manual` is absent or false. If every target is manual, deploy nothing and say so in your report: the step will park for a human, and that parked state is the correct outcome, not a failure to route around.

Three properties this must have, and they are the point of writing it down:

- **It names the file, not cezar.** The engine learns nothing about which repo it is in. A repo whose target file has no `manual` key gets a prompt paragraph that is a no-op for it.
- **It forbids the workaround explicitly.** "Do not work around it" is there because the alternative reading, "the postcondition is red, so make it green", is exactly what an agent optimising for a green step does, and unrestricted Bash gives it every means to.
- **It says the park is correct.** Without that sentence the agent's own report frames the handoff as a failure, which is the framing that produced this task.

### D2. The handoff reason names the command, not the script

Split what the *verdict* carries from what the *card* carries. `allServicesDeployed`'s manual branch builds `handoff.reason` from the names in `manualFailed`, those targets' `manualReason`, and each failing probe's **output** (the diagnostic line every probe is written to echo, `deploy-targets.json`'s `$comment` says so in its own words: *"Every exit below names its reason"*). Two things are dropped from the handoff reason, and from it only: the probe **source**, and every target that **passed**. `detail` keeps the full per-target lines exactly as today, so the step record and the log lose nothing.

**This needs a new internal collection, and the spec says so explicitly because the obvious reading is wrong.** "Iterate `manualFailed`" does not work: `manualFailed` is declared `string[]` (`postconditions.ts:341`) and holds names only, while each probe's stdout lives in `outcome`, which is local to the `for` body (`postconditions.ts:342-346`), is folded into the source-carrying `lines` entry at `:344`, and is then discarded. The text the card needs is gone by the time the reason is built. So the loop must retain it:

```ts
type ManualFailure = { target: DeployTargets['targets'][number]; outcome: ProbeOutcome };
const manualFailed: ManualFailure[] = [];
// in the loop, replacing `postconditions.ts:345`:
if (!outcome.ok) {
  if (target.manual) manualFailed.push({ target, outcome });
  else failed.push(target.name);
}
```

`handoff.reason` is built by iterating that collection: each entry contributes `target.name`, `target.manualReason` and `outcome.output`. `handoff.targets` stays a `string[]` of names on the wire, unchanged (see **Data models**), so this is an internal shape only. `detail` is still built from `lines`, unchanged. `ProbeOutcome` (`postconditions.ts:251`) and `DeployTargets` (`postconditions.ts:232`) both already exist in this file; nothing new is exported.

**Do not look an outcome or a reason up by target name.** Today's build does exactly that (`postconditions.ts:355-359`: `parsed.targets.filter((target) => manualFailed.includes(target.name) && target.manualReason)`), and `deployTargetsSchema` (`postconditions.ts:222-231`) requires only `name: z.string().min(1)`, with no uniqueness constraint. Two targets sharing a name cross-render each other's reasons today, and would cross-render each other's probe output under a name-keyed version of D2. Carrying the target object through removes the lookup instead of preserving it.

On the verdict this task actually reported, the collection holds the **backend alone**: the UI target probed `OK`, and nothing about it belongs on a card telling a human what to deploy.

Target shape, for the verdict this run produced, comfortably inside the 2,000-character slice:

```
Manual deployment required: a person must deploy these, and this run will not.
  · cezar service (backend)
      why manual: a person activates cezar, not an agent (owner decision 2026-08-24,
                  .ai/specs/2026-08-24-default-workflow-ten-stages.md D6). On prod-host,
                  from THIS run's isolated worktree (never the shared checkout
                  /var/lib/cezar/loki-labs/cezar): npm ci && npm run build && node
                  /opt/cezar/packages/cezar/dist/index.js server-deploy
                  --strategy=blue-green --source="$PWD" --sha="$(git rev-parse HEAD)".
                  Activation is one atomic symlink flip that restarts the service.
                  Then check curl -fsS http://127.0.0.1:4321/api/v1/ready reports that
                  sha, and press Resolve.
      probe says: live=9c896e32 head=e38cb619, the running server is NOT serving this HEAD
Deploy them, then press Resolve: the probes re-run and the claim is checked, not trusted. Press Skip (with a note) to record the step as skipped and continue.
```

The `why manual` text is verbatim `manualReason`; D3 is what makes it the string shown above. The `probe says` text is the probe's own stdout, re-punctuated here only because this document may not carry an em dash; the runtime string is whatever the probe echoed, byte for byte.

The last line is not decoration: `awaitHandoff`'s two exits (`run.ts:5843-5860`) are the only ways out that are not cancel-or-restart, and the card shows the buttons without saying what they mean. **Resolve re-probes; Skip takes your word and records a skip.** A human who does not know that will press Resolve, watch nothing happen, and conclude the cockpit is broken.

The flat-red (non-manual) branch at `postconditions.ts:348-353` is left alone. Its consumer is a retrying agent, for which the probe source is genuinely the useful part, and widening this change to it is scope this task did not ask for.

**The regression fixture is backend-red plus UI-green**, because that is the shape that produced this task and it is the shape a naive implementation gets wrong (iterating `parsed.targets` looks correct and quietly re-admits the passing target). Against that fixture, on `handoff.reason`: the failing target's name, its `manualReason` and its probe stdout are present; the **passing** target's name is absent; **neither** probe's source appears; and `reason.length < 2000`. On `detail`: both targets' full lines, probe source included, are unchanged.

### D2b. `awaitHandoff` must narrow the red-Resolve re-persist too

`awaitHandoff` cannot stay unchanged. On a Resolve that comes back red it rebuilds the persisted card from `checked.detail.slice(0, 2_000)` (`run.ts:5853-5857`), and D2 deliberately keeps `detail` as the full probe-source report. Left alone, the card is legible until a human presses Resolve, then reverts to exactly the wall of truncated bash this task is named after, which is the worst possible moment for it to happen.

The re-persist reads `checked.handoff?.reason ?? checked.detail`, bounded to 2,000 characters as today:

```ts
reason: (checked.handoff?.reason ?? checked.detail).slice(0, 2_000),
```

The `?? checked.detail` fallback is load-bearing, not defensive padding: a recheck can come back red **without** a handoff. A manual target failing produces one; a non-manual target going red on the same recheck takes the flat-red branch at `postconditions.ts:348-353` and returns no `handoff` at all, and in that case `detail` is the only text there is to show. The rest of `awaitHandoff` is unchanged: same slice bound, same `kind`/`targets` spreads, same park semantics.

### D3. `manualReason` becomes an instruction, not a label

The card's legibility depends on data the card does not own. `manualReason` is free text and is rendered into the reason, so cezar's own file can carry the operator instruction with no code change at all. It must be a **complete, executable** instruction, not a sketch: `<checkout>` is not a command, and the placeholder is not a harmless one.

**Where the human runs it is load-bearing, and getting it wrong has already shipped wrong bytes to production once.** KB `notion-8d2aa351272c` (*"`cezar server-deploy --source=<dir> --sha=<sha>`: the sha is a label, not a checkout instruction"*, title re-punctuated because this document may not carry an em dash, 2026-08-22, `knowledge/sections/324-2026-08-22-blue-green-source-sha-is-a-label-not-a-checkout.md`) records the incident: `server-deploy` builds whatever `<dir>` currently has checked out and never materializes `<sha>` itself, `--sha` only *labels* the release in `deploy.json` and the `/api/v1/health` deploy field. A deploy run with `--source=/var/lib/cezar/loki-labs/cezar --sha=504ce87f` completed, reported `[deploy.cutover]`, and served `{"deploy":{"sha":"504ce87f"}}` while the **served code was the pre-`504ce87f` build**, because that shared checkout's local `main` was stuck on an older autosave commit. Every observable signal said success. That is precisely the failure mode a `--sha`-labelled instruction invites, so the reason string must name the isolated worktree and forbid the shared checkout by name:

```jsonc
"manualReason": "a person activates cezar, not an agent (owner decision 2026-08-24, .ai/specs/2026-08-24-default-workflow-ten-stages.md §D6). Deploy from THIS run's own isolated worktree (the path the run reports), NEVER from the shared checkout /var/lib/cezar/loki-labs/cezar: its local main lags and server-deploy builds whatever is checked out while --sha only labels the release (KB notion-8d2aa351272c). On prod-host: cd <this run's worktree> && npm ci && npm run build && node /opt/cezar/packages/cezar/dist/index.js server-deploy --strategy=blue-green --source=\"$PWD\" --sha=\"$(git rev-parse HEAD)\". Activation is one atomic symlink flip that restarts the service. Verify with curl -fsS http://127.0.0.1:4321/api/v1/ready and check deploy.sha is that HEAD, then press Resolve."
```

Every flag in it is real and was checked against the CLI, not assumed: `--strategy`, `--source`, `--sha`, `--rollback`, `--follow`, `--dry-run` are all parsed at `index.ts:430-458` and forwarded to `releaseDeployCommand`. `node /opt/cezar/packages/cezar/dist/index.js` rather than a bare `cezar` because the deployed entry point is the one guaranteed present on the box. The string is 1 of the 2,000 characters `deployTargetsSchema` allows (`manualReason: z.string().min(1).max(2_000)`, `postconditions.ts:228`), and comfortably inside it.

This is the highest-value-per-byte change in the spec and it is one JSON string. It ships in Phase 3 with the `$comment` correction, and it is independently useful even if D2 is cut.

### D4. Both records are corrected in place, not appended to (two documents, three locations)

Per the house correct-in-place rule, and per Phase 6's own wording ("each with a dated lead-in pointing at this spec and the original text left below it"):

- **`AGENTS.md:12`** gains a nested `**CORRECTED 2026-08-24**` sub-bullet, sibling in style to the existing `CORRECTED 2026-08-21` one, stating that agent-run workflow deployment of cezar is manual now; that both targets in `.ai/deploy-targets.json` are `manual: true` since `c328ec06`; that a headless `spec-to-deploy` run on cezar therefore **structurally cannot** finish its own `deploy` step and will park as "Awaiting manual deployment"; and that this parked state is the expected terminal state for such a run, not a defect. The original text stays below it unchanged. The bullet's heading ("Always self-deploy…") gains a `⚠` pointer, because a reader scanning bold lead-ins must not carry the falsehood away, the same device `AGENTS.md:12` already uses for its 2026-08-21 supersession.
- **`AGENTS.md:7`**, the standing-authorization paragraph, gains a `**CORRECTED 2026-08-24**` lead-in of its own, with the original text left below it unchanged. It must do two things at once, and getting only one of them is the failure mode: **preserve** the commit and `git push origin main` authorization, which is current and which nothing here narrows, and **correct** the agent-deploy claim, i.e. the "and deployed, the full loop" clause and the "so a task on cezar ships end to end by default" sentence that closes it. Replacement claim: an agent-run task on cezar commits and pushes end to end, and then **parks** at `deploy`, because both targets are `manual: true`; a person activates them and resolves the handoff. Correcting `:12` alone is not enough, because `:7` is the paragraph a reader hits first and it makes the same false promise in different words.
- **`.ai/deploy-targets.json`'s `$comment`** gains the fourth dated entry §D6 asked for: why both targets are manual, why marking only the backend would be a half-truth (one atomic flip restarts both), and that a red here is a **park**, not a failure.
- **The curated domain record, `/var/lib/cezar/loki-labs/notion-export/domains/cezar.md:43`** (KB id `notion-711b57ca383e`, *"Cezar"*, `type: reference`, the domain index every session reads first). Its line 43 currently reads (quoted exactly, except that the original's em dash is re-punctuated here as a comma, since this document may not carry one): *"**Standing push authorization since 2026-08-16**: commit/push/deploy without asking, **`origin` only** (`MarcinWalendowski/cezar`), **never `upstream`** (`open-mercato/cezar`), name the remote, never bare `git push`. Earlier "not pushed / local only" notes on cezar rows are historical: seven commits went to `origin/main` on 2026-08-16."* That is the third document making the corrected claim, and it is the one with the widest blast radius: `AGENTS.md` reaches a run in this repo, this reaches every session that searches the KB for cezar. **The `deploy` clause of that sentence is stale as of `c328ec06`; the commit and `origin`-push clauses are not.** The correction must therefore be surgical: keep "commit/push without asking, `origin` only, never `upstream`, name the remote" exactly as authorized, and correct only "deploy" to say that since 2026-08-24 both targets in cezar's `.ai/deploy-targets.json` are `manual: true`, so an agent does not activate cezar; an agent-run task commits and pushes and then **parks** at `deploy` for a human. Per the house rule the original wording stays below the dated lead-in, unchanged.

  **This one is a proposal, not an edit.** `domains/cezar.md` is on the read-only `notion` mount, shared with every run in flight, so it is corrected by a `supersede` op appended to `CEZ_KB_WRITE_FILE` targeting `notion-711b57ca383e`, which a human applies. It is not the record until it is applied and `cez kb search` returns it (see Phase 4).

Scope of the `AGENTS.md` edits, stated so a reviewer can hold it: they correct the *self-deploy* instruction and the *ships-end-to-end* claim for cezar's own agent-run deploys. They do not touch the commit/`origin`-push authorization, they do not touch the `never push to upstream` rule, and they do not touch what cezar does for the repos it runs tasks in.

## Architecture

Nothing new is introduced. The change is three code edits to existing seams plus prose:

```
deploy step (types.ts:1438-1470)          ← D1: prompt gains a manual-target paragraph
      │  agent runs, deploys non-manual targets only
      ▼
allServicesDeployed (postconditions.ts:297-367)
      │  probes every target; manual failures collect separately (:345)
      ├─ manual branch (:354-365)         ← D2: reason built from manualFailed names +
      │                                        manualReason + probe OUTPUT; no probe source,
      │                                        no passing targets; detail unchanged
      ▼
awaitHandoff (run.ts:5799-5870)           ← D2b: red-Resolve re-persist (:5853-5857) uses
      │                                        checked.handoff?.reason ?? checked.detail
      │  status:'waiting', waitingReason:'handoff', pendingHandoff persisted, slot released,
      │  reason.slice(0, 2_000)
      ▼
HandoffCard (handoff-card.tsx:14-80)      ← unchanged; renders pending.reason + targets + Resolve/Skip
```

The two writes into `pendingHandoff.reason` are a matched pair, which is the whole reason D2b exists as a named piece of work rather than a footnote: the first park (`run.ts:5814`, `:5822`) reads `handoff.reason`, and every subsequent red Resolve (`:5855`) reads `checked.detail`. Narrow one and not the other and the card silently regresses on the first button press.

The two data inputs that make cezar's card useful are both in `.ai/deploy-targets.json` (`manualReason`, `$comment`), D3/D4, no code.

Control-flow facts re-read and relied on:

- The handoff loop is `while (verdict.handoff)` in **both** the agent-step path (`run.ts:5566-5582`) and the check-step path (`:5675-5691`). `deploy` is an agent step, so the first applies.
- `awaitHandoff` parks with **no timeout** (§D5 of the ten-stage spec: *"A handoff waits indefinitely… nobody can auto-perform a deploy"*), gives the `maxParallel` slot back, and persists `pendingHandoff` so a cezar restart re-parks rather than un-parks.
- Resolve calls `recheck()` (`run.ts:5848`), a real re-run of `allServicesDeployed`. Green finishes the step; red re-persists the new verdict and stays parked, emitting `handoff recheck is still red: …` (`run.ts:5853-5860`). Skip requires a note in the UI (`handoff-card.tsx:73`) and finishes the step `skipped` (`run.ts:5576-5579`).
- The red-Resolve re-persist is the one place `awaitHandoff` composes card text itself rather than passing through what the postcondition produced, and it is the D2b edit. Everything else in the function, the park semantics, the slot release, the no-timeout wait, the `kind`/`targets` spreads and the 2,000-character bound, is untouched.

## Data models and API contracts

**No contract change. No schema change. No new route. No `BACKWARD_COMPATIBILITY.md` entry.**

Stated explicitly because it is the reason this spec is cheap:

- `deployTargetsSchema` (`postconditions.ts:198-205`) already carries `manual` and `manualReason`; `c328ec06` added them. D3 only changes the *value* of a string cezar's own file already sets.
- `PostconditionResult.handoff` (`{ kind, reason, targets }`) is unchanged. D2 changes the *content* of `reason`, which is free-form human text with no consumer that parses it, `awaitHandoff` slices it, the store persists it, the card renders it as a paragraph.
- `pendingHandoff`, `waitingReason: 'handoff'`, and `POST /runs/:id/handoff/{resolve,skip}` all shipped in Phase 4 of the ten-stage spec and are already listed in `BACKWARD_COMPATIBILITY.md:86`.
- The `deploy` step's `verify` stays `{ builtin: 'all-services-deployed', max: 1 }` (asserted at `types.test.ts:648`).

The one assertion that changes shape is `postconditions.test.ts:290`, `expect(result.handoff?.reason).toContain('activate it by hand')`, still true under D2, since `manualReason` is the thing the new reason is built from. It is named here so an implementer does not assume the test file is untouched.

### Analytics and observability: existing signals, reused, no new contract

The house rule is that a feature ships with its events named at design time. This change names three that already exist, reuses all three, and adds none. That is the decision, stated so it is a decision rather than an omission:

| Signal | Where | What it answers |
| --- | --- | --- |
| `lifecycle` event, message **`awaiting manual deployment`** | `run.ts:5829-5833`, emitted once as the step parks; already distinct from `awaiting manual merge` on the same emit | *Did a manual-deploy handoff happen at all, and when* |
| Persisted **`pendingHandoff`**: `kind: 'manual-deploy'`, `stepId`, `requestedAt`, `reason`, `targets` (the `manualFailed` names, capped at 50 by `run.ts:5817`/`:5825`) | the run's JSON record; survives a cezar restart, which is what makes it a measurement and not just a UI state | *Which targets parked, on which step, for how long* |
| `note` event, **`handoff recheck is still red: …`** | `run.ts:5860`, emitted on every Resolve that fails to clear | *How many Resolve attempts a park costs*, the direct measure of the P5 failure mode (a human pressing Resolve with nothing staged behind it) |

No new event, field or route is added, because those three already answer every question this change raises: how often runs park, on which targets, and how much operator thrash each park produces. `targets` is the structured half and `reason` the human half; D2 changes only the human half, so nothing that counts or groups these signals is affected. Verification step 11 captures all three from the parked fixture run, alongside the `deploy` step's tool log as the **negative** observable: no activation command was run.

## Phases

Each phase ships alone and leaves the chain working.

**Phase 1: the prompt guard (D1).** Edit the `deploy` step prompt in `packages/cezar/src/workflows/types.ts` (prompt array at `:1454-1469`). Add a `types.test.ts` case in the `SPEC_TO_DEPLOY_WORKFLOW pipeline shape` describe: the `deploy` prompt mentions `.ai/deploy-targets.json` and `"manual"` and contains the refusal. Assert on the data, in the style `types.test.ts:74` already sets. This is the phase that closes the fail-open and it depends on nothing.

**Phase 2: the legible park (D2 + D2b).** Two files, one behaviour, and they ship together because either alone leaves the card broken in one of its two states.

- `packages/cezar/src/workflows/postconditions.ts:341-346`: change `manualFailed` from `string[]` to the `{ target, outcome }[]` collection of D2, since the probe stdout the card needs is otherwise discarded with the loop-local `outcome`. Then `:354-365`: build `handoff.reason` by iterating that collection, from `target.name` + `target.manualReason` + `outcome.output`, and delete the name-keyed `parsed.targets.filter(…manualFailed.includes(target.name)…)` lookup at `:355-359` rather than porting it (names are not unique under `deployTargetsSchema`). `handoff.targets` keeps its `string[]` shape by mapping the collection to names at the return. Extract the per-target line renderer so the source-carrying form (`detail`) and the output-only form (`reason`) share one function rather than diverging.
- `packages/cezar/src/workflows/run.ts:5853-5857`: the red-Resolve re-persist reads `(checked.handoff?.reason ?? checked.detail).slice(0, 2_000)`.

Tests in `postconditions.test.ts` beside `:284`, all against the **backend-red plus UI-green** fixture:
- `handoff.reason` contains the failing target's name, its `manualReason` and the probe's stdout;
- `handoff.reason` does **not** contain the passing target's name, and does **not** contain **either** probe's source;
- `detail` still contains both targets' full lines, probe source included (the log loses nothing);
- with cezar's own two real probes as fixtures, `reason.length < 2000`, the regression test for the truncation that produced this task.

Plus one test for D2b, in `handoff-gate.test.ts` beside `:61`: park a manual-deploy handoff, resolve it while the recheck is **still red**, and assert the persisted `pendingHandoff.reason` is the concise handoff reason, contains no probe source (`set -u` is the cheap marker), and is under 2,000 characters. Without this test the D2b regression is invisible to every gate, since the first park looks correct.

**Phase 3: cezar's own target file (D3, D4-second-half).** `.ai/deploy-targets.json`: rewrite both `manualReason` strings to name the command and the Resolve step, and add the fourth dated `$comment` entry. Data only, no code, no test, but re-run `npm run test:unit -w @loki-labs/better-cezar` because `postconditions.ts` parses this file at runtime and a JSON typo is a red deploy step for every future run.

**Phase 4: the record (D4-first-half).** Four writes, and the phase is not done until all four exist:

1. **`AGENTS.md:12`** gains its `CORRECTED 2026-08-24` sub-bullet and the `⚠` pointer on the bold lead-in.
2. **`AGENTS.md:7`** gains its own `CORRECTED 2026-08-24` lead-in, preserving the commit/push authorization and correcting the "and deployed, the full loop" / "ships end to end by default" claim, per D4.
3. **`CHANGELOG.md`** entry, because `cezar` is a published npm package and this changes an operator-visible behaviour (what a parked deploy card says) even though it changes no API.
4. **Three proposals appended to `CEZ_KB_WRITE_FILE`**, each its own NDJSON line with its own `seq`:
   - a **changelog** entry for the corpus, recording that this shipped and on what date;
   - a **durable decision** entry recording that a `manual-deploy` handoff on cezar is a designed terminal state for an agent-run `spec-to-deploy` run, not a defect, and that `AGENTS.md:7` and `:12` are superseded for agent-run cezar deploys;
   - a **`supersede` op against `notion-711b57ca383e`** (`domains/cezar.md`, whose line 43 is the "commit/push/deploy without asking" standing-authorization bullet), `by` the durable-decision entry above, `date: "2026-08-24"`, with a `note` that corrects the **deploy** clause in place while stating that commit and `origin`-only push are unchanged and still authorized. `amendHeading: false`: the falsehood is one clause inside the bullet, not the bullet's lead-in, so the dated lead-in goes in the body with the original wording left below it. This is the verified target, named by id and line so the implementer does not have to guess which entry asserts cezar self-deploys; it is the one that does.

   **All three are proposals, not the record.** `CEZ_KB_WRITE_FILE` writes a *pending* proposal that a human applies through the cockpit or `cez kb proposals`, and the `supersede` op in particular cannot touch `domains/cezar.md` directly: that file is on the read-only `notion` mount shared with every concurrent run. Corpus synchronization for this change stays **pending** until all three are applied and `cez kb search "manual-deploy handoff"` finds them; the implementer reports it as pending rather than as synced, and this spec must not claim otherwise.

Also set `.ai/specs/2026-08-24-default-workflow-ten-stages.md`'s Status line to note that its Phase 5 prompt item and Phase 6 item 1 landed here.

## Risks

| Risk | Mitigation |
| --- | --- |
| **An implementer "fixes" this by flipping `manual` to false.** It is the one edit that makes the reported error disappear, and it reverses a same-day owner decision (`c328ec06`, §P6). | Stated in the TLDR, in **Out of scope**, and in the `$comment` this spec adds to the file itself, so the next reader hits it in the file they would edit. The reviewer of this spec should treat any diff touching `"manual"` as a red flag. |
| **Phase 1's prompt paragraph leaks into other repos.** `spec-to-deploy` is the default workflow for every repo cezar runs in (`index.ts:139`, `server.ts:2533`), and the prompt is shared. | The paragraph is conditional on the file declaring `manual`, which no other repo's file does. Worst case for a repo with no `.ai/deploy-targets.json` is one ignored paragraph, the same shape §D6 uses to justify the schema fields. |
| **Phase 2 drops information someone was relying on.** | `detail` keeps the full lines verbatim; only `handoff.reason` (the card) is narrowed, and the test asserts both halves. |
| **The prompt guard is still only a prompt.** An agent with unrestricted Bash can ignore it. | True, and stated rather than papered over. A hard block would mean the `deploy` step losing its fixed-grant unrestricted Bash, an owner decision from 2026-08-19 (`types.ts:1448-1453`) that this spec has no mandate to reverse. The prompt guard plus the handoff plus the corrected `AGENTS.md` remove every *honest* reason an agent had to deploy; a deliberate override remains possible and would be visible in the run's tool log. |
| **Someone reads this spec as making the current red green.** | It does not, and the TLDR and P5 both say so. Six commits are unshipped; that is an operator action. |

## Verification

Gates first, then the behaviours, then the record. Run from the repo root of the task worktree.

**The gates are the five this repo declares, in this order** (`.ai/agentic.config.json` → `validation.commands`; `AGENTS.md:232-240` describes what each one is for). All five, not a subset:

1. `npm run typecheck` (all four workspaces; note `pretypecheck` runs `build:server` first).
2. `npm test` (root `vitest run`).
3. `npm run test:unit` (`node --test`, `packages/cezar/test/unit/`).
4. `npm run build`.
5. `npm run test:package` (packs and installs the tarball; **requires** a completed `npm run build`, so it runs after gate 4, `AGENTS.md:237`).

**Run them under the documented environment scrub** (`AGENTS.md:264-278`), because an unscrubbed run produces plausible failures that are environment, not code:

```bash
scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
        | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
tmp=/tmp/cez-gate-$$ && mkdir -p $tmp   # TMPDIR must be OUTSIDE any git repo
env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm ci \
  && env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm test
```

The `server` vitest project self-scrubs since `2026-08-21-npm-test-gate-environment-scrub.md`, but `test:unit`, `test:package`, `npm ci` and the `web`/`api-client` projects do not, so apply the scrub to every gate rather than reasoning about which one needs it.

**While iterating, use `npm test -- <paths>`, never `npx vitest`.** `AGENTS.md:239-241` is explicit: vitest is a devDependency here, `npm test` uses the pinned binary, and `npx` will reach past it and fetch a different version. So:

```bash
npm test -- packages/cezar/src/workflows/postconditions.test.ts \
            packages/cezar/src/workflows/types.test.ts \
            packages/cezar/src/workflows/handoff-gate.test.ts
```

**On the baseline: measure it, do not quote a remembered one.** An earlier draft of this spec carried "9 failing files / 20 tests" from the ten-stage spec's worktree at `c328ec06`; current HEAD is `e38cb619`, which includes the C18 correction and later test fixes, so that number is stale and must not be used as an acceptance target. The requirement is: **all five gates green**. If any gate is red, run it once on a clean checkout of HEAD *before* this change to establish the current baseline, quote both outputs, and show that the failure set is identical. A failure that exists only after the change blocks the commit.

**New assertions, named so their absence is visible in review:**

- `types.test.ts`: the `deploy` prompt names `.ai/deploy-targets.json`, names `manual`, and forbids deploying a manual target.
- `postconditions.test.ts`, backend-red plus UI-green fixture: `handoff.reason` contains the failing name + its `manualReason` + probe stdout; does **not** contain the passing target's name; does **not** contain either probe's source; `detail` contains both full lines; `reason.length < 2000` with cezar's two real probes as fixtures.
- `handoff-gate.test.ts`: resolving a parked manual-deploy handoff while the recheck is still red leaves `pendingHandoff.reason` concise, probe-source-free (no `set -u`) and under 2,000 characters.

**Runtime / E2E (this is what makes it done rather than QA-needed):**

**Ask before running any of it.** Every step below builds, boots or probes something, and the standing house rule is that nothing is built or run without the owner's approval first. Get approval for this block as a whole before executing step 6, and stop and re-ask if it has to change shape. Keep artifacts per the e2e-records rule: a **screenshot** of the parked card and a **screen recording** of the Resolve interactions in steps 9 and 10, plus the captured stdout of every command, under this run's artifact directory.

**Why this runs against a fixture and not against cezar itself.** Two things make the obvious in-place test unsafe, and both were checked rather than assumed. First, production currently serves `9c896e32`, six commits behind HEAD `e38cb619`, so a run created by the live cockpit is created by the **old** code and freezes the old `deploy` prompt: it cannot exercise D1 at all, and a green result would be meaningless. Second, "confirm the guard fails a real deploy step" on cezar means putting a real `server-deploy` in front of an agent, i.e. risking the exact activation the guard exists to forbid, on the box this session is running on. So D1's negative is proved against an isolated fixture whose "deploy" is a sentinel file, and cezar's own targets get a strictly **read-only** check (step 13).

6. **Setup: an isolated cockpit, an isolated repo, an isolated port.** Every control used here was verified in the source, not assumed: `CEZ_HOME` overrides the state root entirely (`paths.ts:19`, `(env.CEZ_HOME || undefined) ?? join(homedir(), '.cezar')`), `-p/--port` sets the cockpit port and `CEZ_PORT_STRICT=1` makes a busy port a **refusal** instead of a silent drift onto a neighbouring port (`index.ts:384`, help at `index.ts:178`), and `--repo <dir>` points the cockpit at a repo other than the cwd.

   ```bash
   # 6a. build the tree under test, in this task's worktree
   npm run build
   wt=$PWD

   # 6b. one throwaway root holds everything this test creates
   export CEZ_E2E=/tmp/cez-e2e-$$ && mkdir -p "$CEZ_E2E"
   export CEZ_HOME="$CEZ_E2E/home"          # never ~/.cezar
   port=$(node -e 's=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')

   # 6c. the fixture repo: one manual target, red by construction; "deploying" writes a sentinel
   git init -q "$CEZ_E2E/fixture" && cd "$CEZ_E2E/fixture" && mkdir -p .ai
   cat > .ai/deploy-targets.json <<JSON
   {"targets":[{"name":"fixture service","manual":true,
     "manualReason":"a person deploys this fixture: run 'sh deploy.sh' in this repo, then press Resolve.",
     "probe":"test -f $CEZ_E2E/DEPLOYED || { echo 'fixture sentinel absent: nothing was deployed'; exit 1; }"}]}
   JSON
   printf 'touch %s/DEPLOYED\n' "$CEZ_E2E" > deploy.sh
   git add -A && git -c user.email=e2e@local -c user.name=e2e commit -qm 'fixture'

   # 6d. the cockpit under test
   CEZ_PORT_STRICT=1 CEZ_ALLOW_UNAUTHENTICATED=1 \
     node "$wt/packages/cezar/dist/index.js" --repo "$CEZ_E2E/fixture" -p "$port" --no-open
   ```

   **Teardown**, after step 11: stop that process (it is the only cezar the test started, so kill its pid; do **not** touch `cezar.service`), then `rm -rf "$CEZ_E2E"`. That single directory holds the state root, the fixture repo and the sentinel. Nothing outside it is written: not `~/.cezar`, not `/opt/cezar`, not the live port 4321, not the live unit.

7. **The guard holds, and the sentinel proves it.** File a trivial task into the fixture and let the chain reach `deploy`: `node "$wt/packages/cezar/dist/index.js" todo add "add a line to README" --project "$CEZ_E2E/fixture" --start`. Before that, dry-run the shape once (`CEZ_DRY_RUN=1`) to confirm it still parses and the step's post-condition short-circuits green as designed (`AGENTS.md:9` documents that carve-out since `2e421370`). Then the **negative** observable, which is the whole point: `test -e "$CEZ_E2E/DEPLOYED"` must **fail**. The fixture documents its own deploy command in `manualReason`, the agent could have run it in one line, and D1 is working exactly if it did not. Alongside it, the **positive**: the `deploy` step's agent report says it deployed nothing and names `fixture service` as manual. Report both; the report alone is an agent's self-description, and the sentinel is the thing that cannot lie.
8. **The park is legible.** With the run parked, print `pendingHandoff.reason` from the run record and open the card in the fixture cockpit. It must be under 2,000 characters, contain no `set -u` and no probe source, name `fixture service` and its `manualReason` instruction, and carry the probe's own stdout (`fixture sentinel absent: nothing was deployed`). Read it as a human would and screenshot it. To cover the passing-target half of D2, add a second, non-manual target to the fixture whose probe is `true` before the run and assert its name appears in `detail` and **not** in `handoff.reason`.
9. **Resolve checks rather than trusts, and the card survives a red recheck.** Press **Resolve** *without* running `deploy.sh`. Two assertions, the second being the D2b runtime proof: the run stays parked and emits `handoff recheck is still red: …`; **and** the re-rendered card still shows the concise reason, still under 2,000 characters, still with no probe source in it. This is `handoff-gate.test.ts:61`'s scenario exercised against a real running server, and it is the property that makes the whole gate worth having. Record the interaction.
10. **Resolve also clears, so the gate is not a dead end.** Now run `sh deploy.sh` in the fixture (the sentinel appears) and press **Resolve** again. The probe goes green, the handoff clears, and the step completes. Without this, step 9 is equally consistent with a gate that can never be satisfied.
11. **The signals are there.** From the parked run's record and event stream, capture all three of the signals named under **Analytics and observability**: the `lifecycle` message `awaiting manual deployment`, the persisted `pendingHandoff` (`kind: 'manual-deploy'` plus its `targets` array, which must be `["fixture service"]`, i.e. still a `string[]` of names after D2's internal reshape), and one `handoff recheck is still red: …` note produced by step 9. Alongside them, capture the `deploy` step's tool log and confirm the **negative** observable again from the other side: no `server-deploy`, no `systemctl`, no symlink flip, no `sh deploy.sh`. Paste all four into the step report; that quartet is what makes "it parked correctly" a measurement rather than an impression.
12. **The record reads straight, in both places.** `grep -n "CORRECTED 2026-08-24" AGENTS.md .ai/deploy-targets.json` returns a hit at `AGENTS.md:7`'s paragraph, a hit at `AGENTS.md:12`'s bullet, and a hit in the target file: **three** hits, not two. Read `AGENTS.md:5-14` top-to-bottom and confirm a reader cannot come away believing either that self-deploy of cezar is still mandatory or that a cezar task ships end to end by default, and can still come away believing commit and `origin` push are authorized.
13. **Read-only check against cezar's own probes, separately from the fixture.** The fixture proves the mechanism; this proves the string a human will actually be handed. In the task worktree, call `allServicesDeployed` against cezar's real `.ai/deploy-targets.json` and print `handoff.reason` and `detail`. `handoff.reason` must be under 2,000 characters, contain no `set -u`, name the `server-deploy` command with `--source="$PWD"` and the isolated-worktree warning from D3, and name **only** the targets that actually probed red: with the backend red and the UI green, `cezar UI (web)` must be absent from `handoff.reason` and present in `detail`. **This step activates nothing.** Both of cezar's probes are reads (`test -f`, `git rev-parse`, `curl -fsS http://127.0.0.1:4321/api/v1/ready`), so running them changes no state on the box, which is exactly why this half can safely touch production while step 7's half cannot.

**Not verification, but the honest closing state:** after all of the above, the six unshipped commits are still unshipped and the run is still parked. The correct report is "QA needed / awaiting manual deployment", never "deployed".

## What this spec could not establish

- **Who or what filed this task.** The task text is a verbatim paste of the postcondition `detail`, but nothing was found that converts a failed/parked step into a task automatically, and no search was run for one. Brief open question 2 ("should the dispatcher learn that a `manual-deploy` handoff is expected-parked, not error-shaped?") is therefore left open, unanswered, and out of scope, it may be a human paste, in which case Phases 2-4 are the whole answer.
- **Whether this run's `deploy` agent attempted an activation and failed, or correctly declined.** The step's tool log was not read. It does not change P1: the prompt gap is in the file either way.
- **Why Phase 5 of the ten-stage spec shipped its schema and file changes but not its prompt change.** `git log --oneline -- .ai/deploy-targets.json` shows `c328ec06` as the only commit ever to touch `manual`/`manualReason`; that spec's own Status line ("Partial… commit and push are blocked, and runtime QA has not run") is the most likely explanation but was not confirmed against the run record.
- **`tools/next-spec`.** The house rule says take a spec number from the repo's allocator. `cezar` has no `tools/` directory and its spec directory uses date-slug filenames with no numbers (`ls .ai/specs`), so there is no number to allocate and this file follows the existing convention.

## Out of scope

- **Flipping `manual` back to `false`, or any other change that makes the reported red go green without a human deploying.** That reverses `.ai/specs/2026-08-24-default-workflow-ten-stages.md` §P6 and commit `c328ec06`, both from 2026-08-24. If the owner wants it, that is a new owner decision, not an implementation detail of this one.
- **A stage-only / `--no-activate` mode for `server-deploy`.** Genuinely attractive, `manualReason` says a human must *activate*, and `runGatedDeploy` (`release-deploy.ts:580-590`) currently fuses stage, smoke-boot, flip and restart, so today "manual" costs the human the whole deploy rather than one flip. It is a new flag, a new gate ordering, and a rollback-interaction question, which is its own spec. Named here so the idea survives; not built here.
- **Anything that would widen `RunStatus`.** §D5 and `runs.ts:295-302` already settled that: `waiting` + `pendingHandoff`, no enum member, because cezar is a released npm package.
- **The flat-red (non-manual) verdict format** in `postconditions.ts:348-353`.
- **The `merge` doc debt.** `merge` is in the chain (`types.test.ts:100` asserts the nine-step `context → spec → review → implement → tests → push → merge → document → deploy` array, so Phase 3 of the ten-stage spec landed), but Phase 6 item 2 of that spec did not: `AGENTS.md:3` still says "(never auto-merges)", `AGENTS.md:9` "those still end at the review gate and never auto-merge", and `README.md:104` / `:192` / `:252` repeat it three more times. With `autoMerge` off by default those five lines are still *true*, which is why this is doc debt rather than a live falsehood. It is a different claim from the one this task is about, it shares no file with Phases 1 to 4 except `AGENTS.md`, and folding it into this feature's single commit would make that commit two changes wearing one message. **Cut from this spec and filed instead:**

  ```bash
  cezar todo add "amend the five never-auto-merges claims now that stage 8 merge has landed" --project cezar
  ```

  Named here rather than dropped, so the next reader finds the pointer instead of rediscovering the debt.
