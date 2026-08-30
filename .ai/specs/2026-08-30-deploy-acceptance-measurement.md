# Deploy Acceptance Measurement

**Status:** spec only. No code written, no test run, no deploy driven in this step.
**Date:** 2026-08-30
**Todo:** `a025f99a` (this task). Parent: `d0386413`, and the parent spec
`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (KB `specs-594acc539b36`), status
**QA Needed, reopened 2026-08-21 19:05 UTC**.
**Brief:** `.ai/specs/briefs/2026-08-30-deploy-acceptance-measurement.md` (step 1 of this run), read
in full; every citation in it was opened and checked against the current checkout. The brief was
**re-gathered on 2026-08-30 after this spec's first draft**, and this revision was re-checked
against that refreshed copy: its three emphases — that ephemeral events deliberately consume
non-persisted sequence values, that the measured refusal stays a separate concern, and that
re-attachment has distinct open owners — are what Problems 1 to 3 are built on. Two of its open
questions are answered below by measurement rather than deferred, one of the four candidate
re-attach causes in its open question 2 is closed by reading the code, and the answers are recorded
as findings, not as fixes.

---

## TLDR

The parent acceptance is not blocked on hosts, credentials, or a missing harness. All three were
fixed. It is blocked because **three of its five assertions cannot currently return a truthful
pass**, each for a different and now-identified reason:

1. **`c: no seq gaps` is unsatisfiable by design.** `RunStore.emitEphemeral`
   (`packages/cezar/src/runs/store.ts:1434`) allocates a `seq` from the same counter as
   `appendEvent` and then deliberately never writes the event to the run's NDJSON. Replay is
   therefore full of holes by construction, and the probe's first connection replays the whole
   persisted transcript. Measured on this run's own live transcript on the production box while
   writing this spec: **510 persisted events carrying a `seq`, 53 gaps, highest seq 698**, so 188
   sequence numbers were allocated and never persisted. The 94 gaps the 2026-08-23 credentialed
   cutover reported are the same artifact, which is why the two zero-reconnect control runs showed
   a comparable rate. The assertion as written can never pass, on any box, cutover or not.
2. **`b: zero refused connections` conflates two different guarantees.** The listener guarantee
   that socket activation exists to provide was measured clean: 3790 fresh TCP connections across a
   restart, zero refused. The single refusal in the credentialed run is a Node `fetch` keep-alive
   pool race against a closing process, owned by `6c89af7c`. One number is being asked to answer
   two questions, and it answers neither cleanly.
3. **Criterion 1 has no positive assertion at all.** The probe already collects `sawKeptGoing` (the
   `this run kept going` marker that re-attachment emits) into its report at
   `deploy-e2e-probe.mjs:356` and **never asserts on it**. Absence of an `interrupted` event is not
   presence of a re-attach: a re-queued chain emits neither. And when the assertion does fail,
   "re-launched" on its own is not a finding anyone can act on: two different defects with two
   different owners produce it, and they are told apart by one observable — whether the broker was
   still alive to be adopted.

This spec changes **the measurement**, not the mechanisms under it. It makes each assertion test the
thing it is named for, adds an out-of-process witness that records re-attachment evidence the
replaced process cannot record about itself, then runs the production measurements that close
criteria 3, 4 and 5. It does **not** fix the re-attach defect (`4afa1b4b`, `45813876`), decide the
sequence protocol (`8206c158`), or fix the keep-alive race (`6c89af7c`). It produces the evidence
those three need and states plainly which of them the acceptance is then waiting on.

---

## Problem

### What is already met, and must not be re-done

Criteria 1 and 2 of the tracker task are met and re-measured (parent spec lines 58 to 143):
`/opt/cezar` is a symlink into `/opt/cezar-releases`, `cezar.socket` is active,
`systemctl show cezar.service` reports `KillMode=process` and `Delegate=yes`, health reports
`socketActivated: true` and `runBrokerIsolation: "scope"` since 2026-08-21T20:48Z (corrected from
`"delegated"` by `fde2dae8` / `cf334d89`), and `/api/v1/ready` returns 200. Deploys need no root: a
scoped polkit rule grants `manage-units` on `cezar.service` and `cezar.socket` only, proven by
negative control. **Do not repeat host provisioning.** The corpus record is
`cezar-prod-rootless-deploy-provisioning`; note that a lexical KB search did not return an id for
it during this step, so it is cited here by name exactly as the parent spec cites it.

### Problem 1: the sequence assertion measures the protocol, not the cutover

`appendEvent` (`store.ts:1265`) takes a seq from `nextSeq`, writes the line to
`<dataDir>/runs/<runId>.ndjson`, then emits it live. `emitEphemeral` (`store.ts:1434`) takes a seq
from the **same** counter and emits it live **without writing it**. Its own doc comment says so in
as many words: the seq never appears in a replay, and gaps are fine because dedup compares with
`>`. Its live call site is `run.ts:7834`, the coalesced `item.delta` flush.

The SSE route (`server/server.ts:6693` onward) replays `store.readEvents(id)`, which reads the
persisted file only, then flushes events buffered during the replay. A client connecting with no
`Last-Event-ID` and no `afterSeq` has `maxSeq = 0`, so **it replays the entire persisted
transcript**, holes included. That is the bulk of any 180 second probe sample against a run that has
been going for a while.

So the probe's `continuity()` (`deploy-e2e-probe.mjs:251`) counts every ephemeral hole as a gap. Two
independent measurements agree:

| Source | Sample | Gaps | Reconnect? |
| --- | --- | --- | --- |
| Credentialed cutover, `deploy-e2e-20260823194023.json` | 2164 events | 94 | yes, 1 |
| Control, `deploy-e2e-20260823193705.json` | 2116 events | 73 | no |
| Control, `deploy-e2e-20260823193836.json` | 2147 events | 82 | no |
| Untouched control run, measured by the scope spec's Phase 0.4 script | 5556 lines | 453 | no |
| **This run's own transcript, read on the box 2026-08-30** | **510 events with a seq** | **53** | n/a, file read |

The last row is the decisive one because it is read straight off disk with no SSE involved at all.
`8206c158` was filed as "cause unknown". The cause is `emitEphemeral`, and it is deliberate. What
`8206c158` still owns is the **decision**: whether the wire protocol should keep one shared counter
(and every consumer must tolerate replay holes) or split into a persisted axis and an ephemeral one.
This spec does not make that decision and must not be read as making it.

What acceptance actually needs is narrower and is answerable today: **did the cutover lose an event
that was persisted?** That is a different predicate, and it is decidable from the same data.

### Problem 2: one refusal number, two guarantees

The parent spec's criterion 2 is "the client is accepted, never refused" and the design that
delivers it is socket activation holding the listening fd. Measured (parent spec lines 166 to 190):

| Prober | Requests | Non-2xx | Connect errors |
| --- | --- | --- | --- |
| Fresh TCP connection per request | 3790 | 0 | **0** |
| Keep-alive `fetch`, 10 rps, 5 restarts | 4864 | 0 | **3** |

The probe uses Node `fetch`, so it is the keep-alive column. Its single refusal on 2026-08-23 is the
`6c89af7c` race, a client-side pool dispatching onto a connection to the old process at the instant
it closes. That is a real cost and is not being rounded away, but it is **not** the listener
guarantee, and letting it fail the same assertion means the acceptance can never distinguish "socket
activation broke" from "undici raced".

### Problem 3: re-attachment is asserted only by absence

`reattachBrokeredRun` (`run.ts:2924`) appends `cezar restarted — this run kept going` (`2958`) when
it adopts a surviving broker. When it declines, it returns false through one of **six** guard sites
(`2926`, `2938`, `2939`, `2941`, `2944`, `2949`; the seventh `return false` in that function, at
`2936`, is the shared `refuse()` tail rather than a guard, which is what an earlier draft of this
spec miscounted), and the
caller falls through to `reenterChain`, which logs `chain re-queued at step "..."`
(`run.ts:3205`). **Neither path emits an `interrupted` event** — and, as the assertion table
establishes, **no path anywhere does**: the canonical interruption string is only ever written into
`error` fields, so `a: no interrupted event` passes in every case, on every run. `a: run never left
running` can also pass across a re-queue if the status sampler does not happen to catch the
transitional moment. The 2026-08-23 credentialed run passed both while the underlying behaviour was
never established.

The record says re-attach is genuinely selective, not broken: on 2026-08-24 the box logged **64
`chain re-queued` events against 57 `this run kept going` events on the same day** (todo
`75fe00ab`). The controlled blue-green measurement at 19:02 saw a re-launch (broker pid gone, spool
rewritten from byte zero, `meta.json` naming a broker started one second after the deploy finished,
todo `45813876`), and the controlled full stop on 2026-08-24 under `scope` isolation saw the broker
**survive** and still not be adopted, leaving orphans holding live backend sessions against a
worktree the new session then owned (todo `4afa1b4b`, spec
`.ai/specs/2026-08-22-broker-scope-isolation-full-stop-survival.md`, Phase 1 result at line 662).

An acceptance measurement cannot tell those apart from inside the process being replaced, and the
probe cannot see spool state at all.

**One of the brief's four candidate causes is closed by reading the code, and closing it is worth
doing so the measurement does not go looking for it.** The brief's open question 2 lists
"release-flip path resolution" among the preconditions that might be what fails on the blue-green
path. It cannot be. `brokerFor` records `spoolDir: relative(this.dataDir, spoolDir)`
(`run.ts:2804`, with a comment saying exactly why), and `spoolDirOf` re-joins it onto the *current*
`dataDir` at read time (`run.ts:2781`). The path is relative to the project's `.ai/cezar`, which
lives in the project checkout and not in the release tree, so flipping `/opt/cezar` cannot
invalidate it. Three candidates remain, and **they separate on one observable: was the broker still
alive when the new process looked?**

| Guard site | What it means when it fires | Owner |
| --- | --- | --- |
| backend not brokered (`2926`) | n/a for a `claude` subject | — |
| `!isSpoolLive(spoolDir)` (`2938`) — dir missing, meta missing or corrupt, `protocol !== 2`, an exit file belonging to that meta, or **`isPidAlive(meta.pid)` false** (`run-spool.ts:266`, `189`) | the broker **did not survive** the cutover | `45813876` |
| `meta.runId` mismatch or no `stepId` (`2939`); step missing or terminal (`2941`); `reviveWorkflow` empty (`2944`); `resumeAt` disagrees with `meta.stepId` (`2949`) | the broker **survived and was declined**: the orphan class | `4afa1b4b` |

The 2026-08-21 blue-green measurement recorded the broker pid **gone** (parent spec line 1251), so
it is the first class. The 2026-08-24 controlled full stop under `scope` isolation recorded the
broker **alive** and still not adopted, which is the second. Those are different defects, and an
acceptance run that reports only "re-launched" tells neither owner which one it saw.

**A third marker is worth counting, but it does NOT separate the two classes, and reading it as if
it did would mis-address the finding.** When `refuse()` runs with a readable `meta` and `reapBroker`
succeeds, it appends `adopted-out agent stopped: broker <pid>` (`run.ts:2931` to `2934`). It is
tempting to read that as "the broker was there to be reaped", and that reading is **wrong**.
`reapAbandonedBroker` calls `kill(meta.pid, 'SIGKILL')` and its catch returns false **only** for a
non-`ESRCH` error; `ESRCH` — no such process — falls straight through to `return true`
(`core/reap-abandoned-broker.ts:20` to `38`). So on the dead-broker path, where `!isSpoolLive` fires
precisely *because* `isPidAlive(meta.pid)` is false, `refuse()` still reaps, still gets `true`, and
still appends the marker.

What it actually means is narrower and still useful: **restart recovery reached this run and
declined it, with a readable `meta.json`.** That separates "declined" from "recovery never reached
this run at all", which nothing else in the report distinguishes. Its frequency reflects whether
`readSpoolMeta` still found a spool dir — a cleaned spool returns null and no marker is written — and
nothing about broker liveness, which is why it appears in only **16** transcripts under
`.ai/cezar/runs/` against **48** carrying `chain re-queued` and **53** carrying
`this run kept going`, counted on the box during this step. So the probe counts it and **reports**
it, and it is never an input to a verdict. **The class is decided on broker liveness alone.**

### Problem 4: the boot-then-readiness-fail branch is structurally hard to reach

`runGatedDeploy` (`server-install/deploy-strategy.ts:126`) gates twice: `smokeBoot` before the
symlink flip, `probeReady` after it, with a flip back to `previous` on a post-flip failure. The
post-flip branch has never fired deliberately, and the parent spec's stated reason is right but
incomplete: `smokeBootRelease` (`server-install/release-deploy.ts:301`) boots the candidate and
calls `waitForReady` against **the candidate's own `/api/v1/ready`**. A candidate that fails
readiness unconditionally fails gate 1 and never reaches gate 2.

So reaching the branch needs a candidate whose readiness is **environment dependent**, passing in
the smoke boot's environment and failing in the live one. The smoke boot enumerates its own
differences from live in that same function: it clears `LISTEN_FDS` and `LISTEN_PID`, sets
`CEZ_SINGLE_PROJECT=1`, blanks `CEZ_REMOTE` and `CEZ_AUTH`, sets `CEZ_ALLOW_UNAUTHENTICATED=1`, uses
a throwaway `CEZ_HOME`, and binds a random high port on loopback. **Not all of them are usable, and
the most obvious one is not:** the server deletes `LISTEN_FDS` from its own environment during
startup, so an env-var check on it is falsy in both environments — see P5, where the working form of
that discriminator is worked out. This is constructible, but the construction is the design work,
not an accident.

### Problem 5: artifacts do not survive their run

Criterion 5 asks for artifacts kept per run. The 2026-08-23 artifact was written under a task
worktree, and task worktrees are reaped (todo `4929b86c` counts 107 of them at one cleanup).
`.ai/cezar/artifacts/` **does not exist** on the production checkout, checked during this step. The
2026-08-21 artifacts do survive, at `/var/lib/cezar/e2e-artifacts/`, outside every repo and
worktree. That is the location a deploy measurement has to use, for the same reason the probe is
dependency free: it must outlive the thing it measures.

---

## Solution

Five changes, in increasing order of how disruptive they are. The first three are ordinary code and
ship with the normal gates. The last two are production measurements.

1. **Classify each gap instead of counting it.** The probe reads the run's persisted transcript at
   the end of its window and, for every gap it observed on the wire, asks whether the missing seqs
   exist on disk. Missing from disk means an ephemeral hole, which is expected. Present on disk but
   never delivered means **durable loss**, which is the failure criterion 3 is actually about. The
   assertion becomes `c: no durable event loss`, and the raw gap array stays in the report verbatim
   as `8206c158`'s input.
2. **Split the refusal assertion by connection reuse.** The probe runs two pollers: the existing
   keep-alive one and a fresh-connection one that opens a new socket per request. The listener
   assertion binds to the fresh-connection poller. The keep-alive numbers stay in the report, named
   as the `6c89af7c` cost, and do not fail the listener assertion.
3. **Assert re-attachment positively, from two sides.** The probe asserts on the `sawKeptGoing`
   marker it already collects. Alongside it a small witness script, run detached so it outlives the
   cutover, samples the subject run's broker identity before and after: broker pid and liveness,
   `meta.json`, the spool's same-length prefix hash, and the run record's `consumedOffset` and
   `spoolDir`. Re-attach passes only when the broker pid is unchanged and alive, the spool prefix
   hash is unchanged, and exactly one `kept going` marker appeared with zero `chain re-queued`.
4. **Run the acceptance cutover** with all of the above, retaining artifacts outside any worktree.
5. **Reach the post-flip rollback branch on purpose**, with an environment-dependent readiness
   failure and a watchdog armed, while the probe records client outcomes across both the flip and
   the flip back.

### What this spec deliberately does not do

- It does not change `emitEphemeral`, the seq counter, or the SSE route. `8206c158` owns that call.
- It does not change `reattachBrokeredRun`'s guards. `4afa1b4b` owns the fix, `75fe00ab` owns the
  diagnosis of what selects between adopt and re-queue.
- It does not touch the drain or undici pooling. `6c89af7c` owns that.
- It adds no server-side test hook, flag, or backdoor that could weaken production readiness. The
  readiness failure in Phase 5 is a real release built from a real commit, not a switch.

---

## Architecture

Nothing in the server changes. Everything added lives outside the process being replaced, which is
the same constraint that produced the dependency-free probe in the first place.

```
  operator / detached transient unit
            │
            ├── (1) witness.mjs  ──────────► /var/lib/cezar/e2e-artifacts/<stamp>-witness.json
            │      samples spool meta, broker pid/liveness, spool prefix hash,
            │      run record consumedOffset + spoolDir, before and after
            │
            ├── (2) deploy-e2e-probe.mjs ─► /var/lib/cezar/e2e-artifacts/<stamp>-probe.json
            │      keep-alive poller ─┐
            │      fresh-conn poller ─┼─► /api/v1/ready
            │      SSE subscriber   ──┴─► /api/v1/p/cezar/runs/<id>/events   (Last-Event-ID)
            │      end of window: read runs/<id>.ndjson, classify every gap
            │
            └── (3) cezar server-deploy --strategy=blue-green
                       stage → smokeBoot → flip → restart → probeReady → [rollback]
```

The witness reads the same files the server reads, from a process the restart does not touch.
Neither script imports cezar.

**The acceptance configuration of the probe is on-box, deliberately, and this spec changes that
property.** Until now the probe spoke HTTP and nothing else, so it ran from anywhere. `--transcript`
gives it a local filesystem read, because classifying a gap requires the persisted NDJSON and there
is no HTTP route that serves it. So: the probe **without** `--transcript` stays remotely runnable
and keeps its old contract, while the P4/P5 configuration must run on the box. That is a real
narrowing, taken knowingly, and the alternative (a new route exposing raw transcripts) is a worse
trade for a measurement that already has to run beside the thing it measures.

**Why the witness is still a separate script.** Not for the location, which the two now share, but
for the semantics. The probe measures a client's view of an HTTP surface. The witness measures
broker identity and spool bytes, which are process and filesystem facts with their own failure
modes (a dead pid, an unparseable `meta.json`, a spool rewritten from byte zero). Folding those into
the probe would put two unrelated failure vocabularies behind one exit code, and would break the
remaining remote mode for the sake of it.

---

## Data models

### Probe report additions (`deploy-e2e-probe.mjs`)

The report is a human-and-script-read artifact, not a published API surface, so the shape changes in
place. Existing keys keep their meaning.

```jsonc
{
  "startedAt": "2026-08-30T18:20:01.004Z",  // NEW: absolute ISO bounds of the measurement window.
  "endedAt":   "2026-08-30T18:28:01.119Z",  // `durationMs` alone (the only time field today) cannot
                                            // be aligned against a deploy timeline after the fact.
  "availPath": "/api/v1/ready",     // NEW: which route both pollers hit. P5 must not use /ready.
  "poll":  { "...": "unchanged: total, ok, failed, connectErrors, gapMs, maxLatencyMs, p50, p99" },
  "pollFresh": {                    // NEW: one TCP connection per request
    "total": 0, "ok": 0, "failed": 0, "connectErrors": 0,
    "gapMs": 0, "maxLatencyMs": 0, "p50": 0, "p99": 0,
    "failures": [], "refusals": []
  },
  "sse": {
    "...": "unchanged: events, reconnects, reloadFrames, dataFrames, gaps, duplicates",
    "gapClassification": {          // NEW
      "checked": true,              // false when the transcript could not be read
      "transcriptPath": "/…/runs/<id>.ndjson",
      "ephemeralHoles": 0,          // missing seqs absent from the persisted file: expected
      "durableLoss": [              // missing seqs PRESENT on disk: the real failure
        { "seq": 0, "type": "", "ts": "" }
      ],
      "unreadable": 0               // seqs in a gap that could not be decided either way
    }
  },
  "run": {
    "...": "unchanged: statuses, sampleCount, sawKeptGoing. `sawInterrupted` is REMOVED",
    "interruption": {               // NEW: the ERROR FIELDS, because no such message is ever
                                    // written — see the assertion table. Needs a FLOOR, for the
                                    // same reason the markers do: these fields persist from
                                    // earlier steps and earlier restarts of a long-lived run.
      "baseline": {                 // taken at the FIRST successful run sample, before the deploy
        "sampledAt": "",
        "runError": "",
        "stepErrors": { "<stepId>": "" }  // step-id-KEYED, never positional: a later step must not
                                          // inherit an earlier one's error by index
      },
      "runErrorNow": "",
      "stepErrorsNow": { "<stepId>": "" },
      "newInterruptionErrors": [    // canonical string present NOW and absent at baseline, per key
        { "scope": "run | step", "stepId": "", "firstSeenAtMs": 0 }
      ],
      "baselineWasInterrupted": false   // canonical string in run.error AT BASELINE: the subject
                                        // was already dead before the cutover ⇒ not-measured
    },
    "markers": {                    // NEW: WHERE each marker was seen, not merely whether
      "reconnectSeqFloor": 0,       // maxSeq reached on the last connection before the reconnect
      "keptGoing":   [{ "seq": 0, "afterFloor": true }],
      "chainRequeued": [],          // run.ts:3205
      "continuationRequeued": [],   // run.ts:2498, the ONLY lifecycle message with "interrupted"
      "adoptedOut": [],             // run.ts:2933, "adopted-out agent stopped: broker <pid>"
      "newKeptGoing": 0,            // count with seq > reconnectSeqFloor
      "newChainRequeued": 0,
      "newContinuationRequeued": 0,
      "newAdoptedOut": 0            // > 0 ⇒ recovery REACHED this run and declined it, with a
                                    // readable meta.json. NOT a liveness signal: the reaper
                                    // returns true on ESRCH too (Problem 3). Reported only —
                                    // never an input to any verdict.
    }
  }
}
```

`gapClassification.checked` is what keeps the new assertion honest: if the transcript is unreadable,
the assertion is `not-measured`, never `passed`. That is the same rule `8dc8bf3a` established and it
is not being weakened.

**A transcript-wide boolean cannot carry the re-attach assertion, and this is the subtlest trap in
the whole spec.** `handleFrame` (`deploy-e2e-probe.mjs:243`) sets `sawKeptGoing` on *any* frame whose
message contains the marker, and the probe's first connection replays the **entire persisted
transcript**. A subject run that survived any earlier restart already carries a historical
`this run kept going` line — it appears in **53** transcripts on this box, counted during this step
(the scope spec's older observation of 36 is what an earlier draft quoted; the corpus moves, so the
current count is the one to use and Sources records when it was taken) — so the
boolean would read true from history alone and the assertion would pass without the cutover having
re-attached anything. The mirror-image error is just as bad: a historical `chain re-queued` would
fail a cutover that did re-attach.

So the assertion is anchored to a **floor**. `reconnectSeqFloor` is the highest seq the probe had
received when the connection it later resumed from was cut, which is the same value it sends as
`Last-Event-ID`. Only markers with `seq > reconnectSeqFloor` count as new, and they are the only
ones the verdict may read. Markers below the floor are retained in the arrays as context, never as
evidence. With no reconnect in the window there is no floor and the assertion is `not-measured`,
matching how the `c:` assertions are already gated (`deploy-e2e-probe.mjs:304`).

### Witness report (`scripts/deploy-reattach-witness.mjs`, new)

```jsonc
{
  "runId": "…", "stampedAt": "…", "phase": "before | after",
  "record": { "status": "", "error": "", "spoolDir": "", "consumedOffset": 0, "currentStepId": "" },
  "transcript": {                  // the CHECKPOINT `after`'s settle scans strictly beyond
    "path": "…/runs/<runId>.ndjson",
    "bytes": 0,                    // file length at `before`: where `after` starts reading
    "maxSeq": 0                    // highest persisted seq at `before`: what `after` must exceed
  },
  "spool": {
    "dir": "…", "metaPath": "…/meta.json",
    "meta": { "pid": 0, "runId": "", "stepId": "", "protocol": 2, "startedAt": "" },
    "brokerAlive": true,
    "outBytes": 0,
    "prefixBytes": 0,              // bytes actually hashed; = outBytes in `before`,
                                   // = before.spool.outBytes in `after`
    "prefixSha256": "",
    "exitFilePresent": false
  },
  "settle": {                      // `after` phase only: the neutral wait, see below
    "waitedMs": 0,
    "markerSeen": "",              // kept going | chain re-queued |
                                   // interrupted continuation re-queued |
                                   // resuming the interrupted task |
                                   // could not resume the interrupted task | ""
                                   // NOT record.error: it is cleared before it can be relied on.
    "timedOut": false
  },
  "comparison": {                  // `after` phase only, present when --before was supplied
    "beforeReport": "…/witness-before.json",
    "sameSpoolDir": true,
    "sameBrokerPid": true,
    "brokerStartedAtUnchanged": true,
    "prefixEqual": true,           // the append-only assertion
    "offsetNonRegressing": true,   // after.record.consumedOffset >= before's
    "truncated": false,            // after.outBytes < before.outBytes: a rewrite, not an append
    "brokerWasAliveBefore": true,  // before.spool.brokerAlive, carried so `after` can classify
    "brokerPidStillAlive": false,  // is before's pid alive NOW, whatever meta.json now names
    "verdict": "re-attached | re-launched-broker-died | re-launched-broker-orphaned | undecidable",
    "reason": ""
  },
  "server": { "mainPid": 0, "invocationId": "", "releaseId": "", "runBrokerIsolation": "scope" }
}
```

**The `after` invocation must be given the `before` report.** Two independent invocations cannot
otherwise hash the same prefix: `after` has no idea how long the file was when `before` ran, so an
ordinary append would produce two hashes over two different lengths and every comparison would read
as a re-launch. So `after` mode takes **`--before <witness-before.json>`**, checks that
`runId` and `spool.dir` match (refusing with `verdict: "undecidable"` if they do not, rather than
comparing unrelated files), and hashes exactly the first `before.spool.outBytes` bytes of the
current `out.ndjson`.

**And it must wait before it samples, or it measures the wrong instant.** `systemctl start` returns
as soon as the unit is up, which is *before* the server has decided what to do with a surviving
broker. A witness that samples immediately records the pre-decision state, and P4 then produces a
false `re-launched-…` verdict on exactly the cutover it exists to measure. The Risks section has
required this wait since the first draft, but it had **no interface anywhere in this spec** until
now, so an implementer following P2 would have built a witness that samples at once. So `after` mode
takes **`--settle-timeout <seconds>`, default 90**: after reading `--before`, it polls the run's
persisted transcript for the first outcome signal landing **strictly beyond the checkpoint the
`before` report recorded**, and only then takes the definitive `record` and `spool` sample.

**"After the before-report's position" needs an actual position, or it is not implementable.** So
the `before` report carries a `transcript` checkpoint: the NDJSON's byte length and the highest
persisted `seq` at the instant it was taken. `after` starts reading at `transcript.bytes` and
accepts only signals whose `seq` exceeds `transcript.maxSeq`. Both are recorded because either
alone misleads: a byte offset alone survives a rewritten file badly, and a seq alone does not tell
the scanner where to start reading.

**The signal set is what the code actually writes, which is not the obvious list.** All five are
lifecycle messages, and the settle wait therefore reads the transcript and nothing else:

| Signal | Site | Outcome it marks |
| --- | --- | --- |
| `cezar restarted — this run kept going` | `run.ts:2958` | adopted |
| `chain re-queued at step "…"` | `run.ts:3205` | chain re-entered |
| `… — interrupted continuation re-queued` | `run.ts:2498` | queued continuation re-queued |
| `cezar restarted — resuming the interrupted task from its last session` | `run.ts:2664` | continuation fall-through, resumed |
| `cezar restarted — could not resume the interrupted task (…)` | `run.ts:2665` | continuation fall-through, failed |

**`record.error` is deliberately NOT a settle signal, and an earlier draft of this spec had that
wrong in both directions.** The continuation fall-through does emit a message — the last two rows,
selected on `resumed.ok` (`run.ts:2662` to `2666`) — so nothing is missed by leaving the field out.
And the field is actively unreliable as a signal: continuation and requeue processing **clear** it
(`error: undefined`, `run.ts:3196` and `3151` among others) before the store's debounced `runs.json`
save is guaranteed to have preserved it, so a witness polling for it would be racing the clearing
and could return either answer on the same cutover. A signal that depends on winning a race is not
a signal.

There is still **no bare `interrupted` message marker** in this set, because no such persisted
message exists anywhere in the tree — see the assertion table, where the same discovery invalidates
an existing probe assertion. Note that neither continuation message contains the canonical
interruption string, so that finding stands unchanged by this correction. A bare `resuming`
substring stays excluded for its own reason: the four `resuming` messages at `run.ts:3292`, `3692`,
`5934` and `6118` are usage-limit and rework messages, unrelated to restart recovery. The
fourth-row signal is matched on its full text, never on that substring.

**The wait must be symmetric across all four signals.** Returning early on `kept going` while
continuing to wait through
`chain re-queued` is a wait that manufactures the verdict it was supposed to measure, and it would
do so in the direction that makes the acceptance look better. On timeout the witness writes
`settle.timedOut: true` and `verdict: "undecidable"` with a reason, **never** a re-launch: "the
server had not decided yet" and "the server re-launched the run" are different facts, and only one
of them was observed.

Three cases the comparison must separate, because they are three different findings:

| `after.outBytes` vs `before.outBytes` | prefix hash | Verdict |
| --- | --- | --- |
| greater or equal | equal | **re-attached**: appended to, never rewritten |
| greater or equal | differs | **re-launched**: rewritten from byte zero, the 2026-08-21 finding |
| **less** | n/a, cannot hash that many bytes | **re-launched** (`truncated: true`), reported distinctly rather than crashing on a short read |

**A re-launch is then classified, because "re-launched" alone tells neither owner what to fix**
(Problem 3). The discriminator is the broker's liveness as the restarted process would have seen
it, and it is the **only** input. `before.spool.brokerAlive` true with that same pid dead afterwards
means the broker did not survive the cutover: `re-launched-broker-died`, `45813876`'s defect. That
pid still alive afterwards **and still named by `meta.json`** means it survived and a later guard
declined it: `re-launched-broker-orphaned`, `4afa1b4b`'s. Pid liveness is a weak signal on its own,
since pids are reused, so a live pid that `meta.json` no longer names resolves to `undecidable` with
a `reason` rather than to either class.

**The probe's `newAdoptedOut` is deliberately not consulted here.** As Problem 3 shows, the reaper
returns `true` on `ESRCH` as well, so that marker is written on the dead-broker path too; using it
to corroborate the orphan class would address `45813876`'s defect to `4afa1b4b`, which is the exact
mis-addressing this classification exists to prevent. A wrong address is worse than an honest
"unknown", because it sends an owner to read code that was never involved.

That is the exact assertion the 2026-08-21 measurement used and the one that caught the re-launch:
a re-launched run rewrites the spool from byte zero, so the prefix hash changes while the file
merely looks bigger.

---

## API and interface contracts

No HTTP route, request shape, or response shape changes. `/api/v1/ready`, `/api/v1/health`,
`/api/v1/p/:project/runs/:id` and `/api/v1/p/:project/runs/:id/events` are all read as they are.

**cezar is a published package** (`@loki-labs/better-cezar`, version 0.10.0, read from
`packages/cezar/package.json`; the workspace doctrine's older `@open-mercato/cezar` name is stale),
so the workspace's no-backward-compatibility
default does not apply to it. Nothing here touches a documented surface: the probe and the witness are
repo scripts under `packages/cezar/scripts/`, not package exports, and no CLI command changes.

New probe flags. Every flag is opt-in and every one defaults to `not-measured` rather than to a
borrowed pass, but **the flags are not the whole change**: the `c:` gap assertion is replaced (see
the table below), so a probe run against an unchanged box does not necessarily reach the same
verdict it reached before. Claiming otherwise would be the kind of quiet rounding this spec exists
to stop.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--transcript <path>` | unset | Persisted NDJSON to classify gaps against. Unset means `gapClassification.checked: false` and the durable-loss assertion reads `not-measured`. |
| `--fresh-conn` | off | Also run the fresh-connection poller. Off means **both** fresh assertions read `not-measured`; neither ever borrows the keep-alive numbers. |
| `--avail-path <path>` | `/api/v1/ready` | The route both pollers hit. P5 **must** override this, see below. |
| `--witness <path>` | unset | The **after**-phase witness report. Read once, after the measurement window closes and before the verdict is computed. Unset means the re-attach assertion is `not-measured`. |

`--avail-path` exists because P5 deliberately breaks readiness. With the injected candidate live,
`/api/v1/ready` returns 503 **by design**, and `pollOnce` counts any non-`ok` response as a failure
(`deploy-e2e-probe.mjs:113`), so a P5 run pointed at `/ready` would record a wall of failures that
say nothing about availability. P5 points the pollers at `/api/v1/health`
(`server.ts:2590`), which stays 2xx while readiness is false, and leaves the deployer's own
independent `/ready` probe to establish the intentional failure. The two probes are asking different
questions and must not share a route.

Existing flags (`--base`, `--project`, `--run`, `--seconds`, `--header`, `--out`) are unchanged, and
so are the exit codes: `0` passed, `1` a real failure, `2` could not measure.

### Assertion table, before and after

| Today | After this spec | Why |
| --- | --- | --- |
| `b: zero failed HTTP requests` | unchanged (keep-alive poller) | Already correct and already passing. |
| (none) | **`b: zero failed HTTP requests (fresh)`** | Without it the fresh poller has no non-2xx verdict at all, so the probe could exit 0 while `pollFresh.failed` was nonzero and V1 failed only on a human's manual read. |
| `b: zero refused connections` | `b: zero refused connections (fresh)` | Binds to the listener, which is the guarantee. |
| (none) | `b: keep-alive refusals` reported, not asserted | The `6c89af7c` cost, recorded, not rounded away and not blocking. |
| `c: no seq gaps` | `c: no durable event loss` | A persisted event that never arrived. The old predicate is unsatisfiable, see Problem 1. |
| `c: no seq duplicates` | unchanged | Still meaningful and still passing. |
| `a: run never left running` | unchanged | |
| `a: no interrupted event` | **`a: no NEW interruption error`** | The old predicate is **vacuous — it can never fail**. The replacement is floored at a baseline sample, or it would be vacuous in the failing direction instead. See below. |
| (none) | `a: run was re-attached, not re-launched` | The compound assertion below. Gated on a reconnect, like the `c:` assertions. |

**`a: no interrupted event` is vacuous, and it is the third instance of the pattern this spec keeps
turning up.** `handleFrame` sets `sawInterrupted` when an SSE frame's `payload.message` contains
`interrupted — cezar process exited during the run` (`deploy-e2e-probe.mjs:243`). That exact string
is **never written as an event message**. It is written into `run.error` and into each open step's
`error` **field** (`run.ts:2644`, `2651`), and into `run.error` again by the store's own
crash-recovery path (`store.ts:794`). The only lifecycle message in the tree containing the word is
`… — interrupted continuation re-queued` (`run.ts:2498`), which does not contain the string being
matched. So `sawInterrupted` cannot become true on any run, on any box, cutover or not: the
assertion has been passing **by construction**, the exact mirror of `c: no seq gaps` failing by
construction. Two of the five original assertions were therefore decided before the probe ever ran.

The replacement reads the fields the code actually writes. `sampleRun` already fetches the whole run
record and keeps only `record.status` (`deploy-e2e-probe.mjs:147`); it now also keeps `record.error`
and `record.steps[].error`. `sawInterrupted` is removed rather than kept alongside: leaving a field
that is always `false` next to a real one invites the next reader to cite the wrong one.

**But "the canonical string at any sample" would be a new vacuity, in the failing direction, so the
assertion takes a floor.** Those error fields are durable and step-scoped: a long-lived subject run
that survived an unrelated restart three days ago still carries
`interrupted — cezar process exited during the run` on that old, terminal step, and the probe's
first sample would see it. Failing the cutover on it would be the exact mirror of the marker bug
fixture 6a exists to prevent — history read as though it were this window's evidence. So:

- **Baseline at the first successful sample**, before the deploy: record `record.error` and a
  **step-id-keyed** map of `steps[].error`. Keyed, not positional, so a later step cannot inherit an
  earlier one's error by index.
- **Assert only on new appearances.** `a: no NEW interruption error` fails when the
  canonical string appears at a key that did not hold it at baseline — the run itself, or any step.
  `newInterruptionErrors` records each one with the offset at which it was first seen.
- **A canonical `run.error` already present at baseline makes the run an invalid subject**, not a
  failure: `baselineWasInterrupted: true` and the assertion reads `not-measured`. A run that was
  already dead before the cutover cannot testify about the cutover, and P4 should pick another
  subject rather than record a verdict on this one.
- **Historical step errors stay in the report as context** and are never verdict-bearing.

That tests the guarantee the old name promised — a run interrupted *by this cutover* rather than
carried across it — and, unlike its predecessor, it can both pass and fail on real data.

Both fresh assertions read `not-measured` when `--fresh-conn` is omitted. Neither falls back to the
keep-alive poller's numbers, because that is exactly the borrowed-sample failure `8dc8bf3a` closed.

**`a: run was re-attached, not re-launched` passes only when all five hold**, and it is
`not-measured` if there was no reconnect or the witness comparison is absent:

1. `run.markers.newKeptGoing === 1`, counted **above `reconnectSeqFloor`** (not the transcript-wide
   boolean, see Data models);
2. `run.markers.newChainRequeued === 0` and `run.markers.newContinuationRequeued === 0`, same
   floor, **and** `run.interruption.newInterruptionErrors` empty against its own baseline floor,
   which is the field-based replacement for the vacuous `interrupted` marker;
3. witness `comparison.sameSpoolDir` and `sameBrokerPid`, with the broker still alive;
4. witness `comparison.prefixEqual` and `truncated: false`;
5. witness `comparison.offsetNonRegressing`.

**The join contract, because conditions 3 to 5 are not the probe's own observations.** Saying "the
pass table joins them" is not a contract: as written the probe would own an assertion it has no
input for, and could never return a truthful verdict on it. So the probe takes `--witness <path>`
and reads that file **once, after its measurement window closes and before it computes verdicts**.
That ordering is the whole point, and it forces a change to P4's sequence: the after-witness must be
written **before** the probe is waited on, not after it exits.

The probe copies what it read into its own report and derives the verdict from it:

```jsonc
"run": {
  "witness": {                     // NEW: echoed from --witness, never recomputed
    "path": "…/witness-after.json",
    "present": true,
    "runIdMatches": true,          // vs the probe's own --run
    "verdict": "re-attached | re-launched-broker-died | re-launched-broker-orphaned | undecidable"
  }
}
```

Four outcomes, each tested (see Verification 6c): witness says `re-attached` and the marker
conditions hold, so **passed**; witness says either `re-launched-…` variant, so **failed**
regardless of markers, with the variant carried into the report as the finding's address;
`--witness` absent or the file unreadable, so **not-measured**; witness present but its `runId` does
not match the probe's `--run`, so **not-measured** with a `witness-run-mismatch` reason, never a
pass borrowed from a different run's evidence.

---

## Phases

Independently shippable, in order. P1 to P3 are code with unit coverage and no production action.
P4 and P5 are the production measurements and each needs the operator.

### P1: classify gaps instead of counting them

Ships: `--transcript`, the `gapClassification` block, the `c: no durable event loss` assertion.
Touches `packages/cezar/scripts/deploy-e2e-probe.mjs` and
`packages/cezar/test/e2e/deploy-e2e-probe.test.ts`.

Verified by: a fixture transcript with a known hole (a seq the file never contains) plus a known
loss (a seq the file does contain that the synthetic stream withholds), asserting the first
classifies as `ephemeralHoles` and the second as `durableLoss` and fails the assertion; and a
missing transcript producing `not-measured`, not `passed`. Independently valuable even if nothing
else lands: it turns `8206c158`'s open question into a number the next probe run reports for free.

### P2: assert re-attachment, and witness it

Ships: the `run.markers` block with its `reconnectSeqFloor`, the `--witness` join and its
`run.witness` report block, the `a: run was re-attached, not re-launched` assertion,
`packages/cezar/scripts/deploy-reattach-witness.mjs`, that script's `settle` block with its
neutral wait, and the `run.interruption` block that replaces the vacuous `a: no interrupted event`
with `a: no NEW interruption error` — baseline at the first successful sample, step-id-keyed, so a
historical step error is context and only a new appearance fails.

The witness takes `--run`, `--data-dir`, `--phase before|after`, `--out`, plus **`--before
<witness-before.json>` and `--settle-timeout <seconds>` (default 90) in `after` mode**, and is
dependency free for
the same reason the probe is. It must not import from `packages/cezar/src`: it re-derives the spool
path from the run record's own `spoolDir` field joined onto the data dir, which is exactly what
`spoolDirOf` (`run.ts:2781`) does. That field is stored **relative** to `dataDir` (`run.ts:2804`),
so the witness must join and must never assume an absolute path — and, per Problem 3, that same
relativity is why a release flip cannot break the lookup. `consumedOffset` is worth asserting on
for a reason worth stating: `BrokeredSession` advances it inside `drain()` only after a **complete**
spool line has been handed to `onLine` (`brokered-session.ts:175`), so it is a delivered-bytes
watermark rather than a read position, and a value that goes backwards means a new session started
counting from zero, not that a slow consumer is lagging. One clause of that helper the witness does **not** reproduce: when
`run.spoolDir` is absent it falls back to `legacySpoolDirFor`. The witness treats an absent
`spoolDir` as a recorded error instead, which is right for a P4 subject (any run brokered under
protocol 2 carries the field) but means the witness is not a general-purpose spool locator and
should not be reused as one. The scope spec's Phase 0.4 script failed on every input for three
reasons, all recorded at that spec's line 30, and this one avoids each explicitly: read `runner`,
never `backend`; take the spool path verbatim from `spoolDir` rather than assuming
`runs/<id>.spool`; and make no strict-consecutiveness assumption about `seq`.

Verified by: a fixture data dir in which the append case (prefix hash equal at
`before.spool.outBytes`, pid unchanged), the rewrite case (prefix hash differs at that same length)
and the truncation case (`after.outBytes < before.outBytes`) are all three distinguished; the two
re-launch classes separated on broker liveness rather than on spool bytes (the same rewritten spool
reads `re-launched-broker-died` with the before-pid gone and `re-launched-broker-orphaned` with it
alive and still named in `meta.json`); plus
`after` invoked with a `--before` report naming a different run or spool dir, which must return
`undecidable` rather than compare unrelated files; plus the three settle fixtures of Verification
7c, which are what stop the wait from manufacturing its own verdict. Per that spec's own lesson, **this script is
exercised against fixtures before it is ever pointed at production**, and that step is a gate on P4,
not a nicety.

### P3: split the refusal measurement

Ships: `--fresh-conn`, the `pollFresh` block, the renamed listener assertion.

The fresh-connection poller must genuinely open a new socket per request. Node's `fetch` pools by
default, so this uses `http.request` with `agent: new http.Agent({ keepAlive: false })`, or an
`undici` dispatcher, whichever keeps the script dependency free. That is the same distinction the
2026-08-21 measurement drew by hand and it is what made the result interpretable.

Verified by: a local server that closes and rebinds mid-window, asserting the two pollers report
different refusal counts and that the assertion binds to `pollFresh`.

### P4: the acceptance cutover (production, drivable from an agent task)

Preconditions: P1 to P3 merged and deployed; a long-running brokered `claude` task in flight with a
`running` step; nothing else deploying concurrently. The 2026-08-21 run was polluted by two cutovers
landing inside one 120 second window, so **confirm no concurrent deploy** before starting.

Sequence, artifacts to `/var/lib/cezar/e2e-artifacts/<UTC stamp>/`:

1. `witness --phase before`.
2. Probe for 180 seconds with `--project cezar`, a session cookie, `--fresh-conn`, and
   `--transcript`, over loopback `http://127.0.0.1:4321`.
3. `cezar server-deploy --strategy=blue-green --follow --source=<a clean freshly-built clone of the
   project's HEAD> --sha=<that HEAD>`. **This may be driven from inside an agent task**, and on this box
   it runs **inline**, creating no transient unit at all. `runReleaseDeploy` calls `decideReExec`
   (`release-deploy.ts:507`) *before* the transient-unit branch at `537`, and that helper
   short-circuits on `KillMode=process` (`self-safe-deploy.ts:137` to `142`): if the unit already
   stops with `KillMode=process` a restart signals only its main process, this deployer is a child
   of it, so there is nothing to escape from and `reExec` is false. That is what production reports,
   and what the `be3aab61` cutover logged: `cezar.service stops with KillMode=process`, then a
   completed cutover with no transient unit requested. **Expect a different reason string in
   `deploy.log` when the deploy is driven from an agent task**, though: `decideReExec` tests
   `isInsideUnitCgroup` *before* the `KillMode` short-circuit (`self-safe-deploy.ts:134`), and an
   agent task's cgroup is `user@999.service/cezar.slice/…`, not `cezar.service`, so it returns false
   on the cgroup branch first and logs *that*. Same outcome, different reason — do not read the
   cgroup reason as evidence that the box is unmigrated. The `--user` transient unit is the
   **fallback** for a host that has not been migrated, taken only when `decision.reExec` is actually
   true. An operator session or a detached unit works equally well. **Not**
   `systemctl restart cezar.service`, which is the exact failure the parent spec removes.

   **`--source` is mandatory here and the bare command is wrong.** `index.ts:448` resolves
   `source: values.source ?? repoRoot`, and when this runs from inside an agent task `repoRoot` is
   the **task worktree**, which carries an unmerged branch and need not hold a current
   `packages/cezar/dist/.build-stamp.json`. Deploying that would ship the acceptance work itself
   into production mid-measurement and invalidate the run.

   **And the live checkout is not the answer either** — this is where an earlier draft was wrong.
   Measured on the box: it holds four untracked briefs and a build stamp for a different sha with
   `"dirty": true`, so it fails the clean-tree and stamp gates every time, and the only ways to make
   it pass are to delete other people's work or rebuild the live tree mid-measurement. So the deploy
   source is a **third** path: a fresh `--shared` clone of the project detached at its merged HEAD,
   `npm ci && npm run build`, stamp verified against that HEAD, passed through `--source`, removed
   afterwards. The live checkout keeps its own role as the project whose runs are measured, and is
   never modified (`readBuildStamp` at `release-deploy.ts:91`, `staleSource` at `107`, `gitRelation`
   at `125`).
4. `witness --phase after`.
5. Keep the **readable** restart evidence. Explicitly **not** `journalctl -u cezar.service`: the
   `cezar` user is in no group but `cezar` — not `adm`, not `systemd-journal` — so that command
   returns only this user's own messages and prints the "Users in groups 'adm', 'systemd-journal'
   can see all messages" hint instead of the unit's log. Measured on the box during this step. An
   artifact that is silently empty is worse than no artifact, because the next reader reads the
   emptiness as evidence that nothing happened. What is readable, and is kept instead:
   - `systemctl show cezar.service -p MainPID,ActiveEnterTimestamp,NExecutions,KillMode,Delegate`
     before and after, into `unit-before.txt` and `unit-after.txt` — the restart boundary and the
     proof the unit really was replaced.
   - The witness's `server.mainPid` and `server.invocationId`, which change across the restart and
     are recorded from outside the replaced process.
   - The witness's `spool.exitFilePresent`, which is how a broker that recorded its own exit is
     told from one that vanished — the distinction `45813876` needs, and the one the journal was
     being asked for.
   - `deploy.log`, which the deployer writes itself and which is readable by construction.
   If the operator variant of P4 is run instead, a root or `adm` session **can** add the journal;
   note it as an operator-only extra, never as a step the agent-driven path is expected to produce.
6. Record `gap_ms` from the probe's `pollFresh.gapMs` and `inflight_runs` from the `deploy.cutover`
   analytics event.

**The known trap, carried forward:** `gapMs` in the deploy log is the deployer's own restart window
and is not the client-visible gap. The client number is the probe's, and after P3 it is
specifically `pollFresh.gapMs`.

**The expected outcome is a fail, and that is not a reason to defer this phase.** On the record as
it stands, `a: run was re-attached, not re-launched` should fail, because the re-attach defect is
real and unfixed. That result is the acceptance evidence `4afa1b4b` and `45813876` need, taken on
the blue-green path with the witness evidence neither has, and it is worth more than a deferred
measurement. What P4 establishes on its own is the other four assertions, which should now all pass
truthfully for the first time.

### P5: the post-flip rollback branch (production, operator, watchdog armed)

Build a candidate release from a throwaway commit that adds **one** readiness check which fails only
in the live environment, keyed on a difference the smoke boot creates itself. The key is socket
activation — but it must be read as the **resolved listening descriptor**, `deps.listenFd !==
undefined`, and never as the environment variable.

**Why `process.env.LISTEN_FDS` is unusable, recorded here so a later session does not reinstate
it.** `smokeBootRelease` clears `LISTEN_FDS` and the live unit does set it, so the obvious check
looks right. But the live server **deletes it from its own environment during startup**:
`index.ts:627` calls `consumeSocketActivation(process.env, process.pid)`, which resolves the
activation and then `delete`s `LISTEN_PID`, `LISTEN_FDS` and `LISTEN_FDNAMES`
(`server/socket-activation.ts:78` to `84`) — deliberately, so the agent CLIs cezar spawns cannot
mistake their own fd 3 for a listener. By the time any readiness check runs, the variable is gone in
**both** environments. A candidate keyed on it would pass readiness live, the deploy would exit
**0**, `/opt/cezar` would stay flipped to an unmerged throwaway release, V8b would void the run, and
the box would be recovered only when the watchdog fired. That is the single worst outcome this
phase can produce, and it would look like a clean deploy while producing it.

`deps.listenFd` is the durable form of the same fact, is in scope at the injection anchor, and is
already what the live server reports as `runtime.socketActivated` (`server.ts:2426`): a number under
socket activation, `undefined` under the smoke boot, which binds a random loopback port instead.
`CEZ_SINGLE_PROJECT` (set by the smoke boot, unset live; read at `index.ts:403` and never deleted)
remains the fallback key.

Then, with the probe running across the fail-closed attempt, the flip and the flip back:

0. **The fail-closed re-run**, which is criterion 4's first half and is currently inherited rather
   than measured. Deploy a second candidate whose built `dist/index.js` is truncated, expecting exit
   1 with `failedAt: "smoke_boot"` and **no symlink movement at all**. It shares the probe window
   with the dangerous steps (runbook step 4b) but flips nothing, so it adds no risk of its own, and
   it is what closes V8c and V8d.
1. Build and verify the candidate first, **then** arm a restore watchdog immediately before staging,
   on the pattern the scope spec's Phase 0.4 script established. The watchdog is not optional: it is
   the only thing standing between a failed rollback and a box left serving a release that cannot
   become ready. Two properties matter and are easy to get wrong. Its countdown must not be spent on
   clone, install and build, which cannot endanger anything and could burn the whole window before
   the deploy starts. And it must **check before it acts**: read the live symlink and readiness
   first, no-op when the good release is already restored and ready, and only otherwise restore and
   restart, then re-verify readiness. A watchdog that restores unconditionally causes an outage on a
   deploy that had already recovered by itself.
2. Deploy the candidate with `--strategy=blue-green`, expecting **exit 1**: a successful rollback is
   a failed deploy, and treating a non-zero exit as an abort is how the evidence capture gets
   skipped.
3. Assert: `smokeBoot` passes, the symlink flips, `probeReady` fails, the ledger marks the candidate
   `healthy: false` with `failedAt: "readiness"`, the symlink is restored to `previous`, and the
   probe records zero fresh-connection failures **across both restarts** on `--avail-path
   /api/v1/health`. It must **not** poll `/api/v1/ready` in this phase: that route is the thing
   being deliberately broken, so polling it would make the assertion unsatisfiable by construction.
4. **Verify recovery, then disarm — in that order, never the reverse.** Assert the live symlink is
   the good release and `/api/v1/ready` answers 200, and only then stop the timer. If either check
   fails, leave the watchdog **armed** and exit nonzero: it is the only remaining mechanism that
   will restore the box, and the EXIT trap deliberately does not touch it. Then confirm it did not
   have to act; if it acted, the rollback branch failed and that is the finding.

The commit is never merged and never pushed. The `healthy: false` ledger entry is left as evidence,
exactly as `20260821T183255Z-deadbeef` was.

**The fail-closed branch was exercised once, but with no probe running, so half of acceptance
criterion 4 is currently inherited rather than measured — and the spec should not quietly inherit
it.** A truncated `dist/index.js` failed `smoke_boot`, nothing flipped, nothing restarted, and
`/api/v1/ready` stayed 200 (parent spec line 102). But the criterion asks for **both** halves "with
the probe recording zero client failures", and nothing was recording client outcomes that day. So
P5 re-runs it as **step 0**, with the probe already up. It is the cheapest and safest deploy in this
spec: nothing flips on that path, so it carries none of the danger of the steps below, and it costs
one file copy on top of a build that already happened. The branch that has genuinely never fired is
still the post-flip one, which is steps 1 onward.

### P6: update the record

1. Amend the parent spec's Status line **in place**, per the workspace correction rule, with the
   measured `gap_ms` and `inflight_runs` and the honest per-criterion verdict. If P4's re-attach
   assertion failed, the parent stays QA Needed and the Status line says so and names the owner the
   witness class points at: `45813876` for `re-launched-broker-died`, `4afa1b4b` for
   `re-launched-broker-orphaned`, and neither of them for `undecidable`.
   Rounding a measured failure up to Done is the specific thing this task exists to prevent.
2. Amend `8206c158` with the `emitEphemeral` cause and the classification numbers, so it stops being
   "cause unknown" and becomes the protocol decision it actually is.
3. Amend `45813876` and `4afa1b4b` with the witness class P4 measured, **and with the hypothesis
   this spec closed by reading rather than by measuring**: `spoolDir` is stored relative and
   re-joined onto the current data dir at read time (`run.ts:2804`, `2781`), so release-flip path
   resolution is not a candidate cause and neither task should spend a session on it.
4. Add the durable-loss and fresh-connection distinctions to the parent spec's Verification section.
5. Write the corpus note and reindex, because a corpus write is not a KB write until
   `cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex` has run.

---

## Risks

- **The classifier could launder a real loss into an expected hole.** If an event is persisted
  *after* the probe reads the transcript, a genuine loss reads as a hole. Mitigation: read the
  transcript strictly after the SSE window closes, and treat any gap whose neighbours bracket a
  persisted event as durable loss. The direction of the residual error is stated rather than
  hidden: the classifier is biased toward reporting loss, not toward reporting none.
- **P5 can leave the box on a release that cannot become ready.** This is the genuinely dangerous
  phase. Mitigations, in order: the watchdog is armed before the deploy and not after; the candidate
  differs from the good release by one readiness check and nothing else; the rollback target is the
  release currently serving; and the phase is operator-run with an explicit go-ahead, at a moment
  with no other tasks in flight.
- **P4 and P5 disrupt every task on the box, not just the subject.** The scope spec made this point
  and it holds here. Both phases need a go-ahead and a quiet window, and the subject run must be
  re-confirmed immediately before firing: a subject stops being valid the moment its step rolls
  over, which happened to the scope spec's first subject within 90 seconds. Note the split: P4 may
  be **driven** from an agent task once the window is agreed (see the bullet above), while P5 stays
  operator-run on danger grounds, not on any privilege grounds.
- **`systemctl start` returns before the server has decided what to do with a surviving broker.**
  Asserting on the transcript immediately produces a false FAIL. The witness's `after` phase must
  wait neutrally across all **five** lifecycle outcome messages — `kept going`, `chain re-queued`,
  `interrupted continuation re-queued`, and the continuation fall-through's two forms, `resuming
  the interrupted task` and `could not resume the interrupted task` (`run.ts:2662` to `2666`) — so
  the wait cannot manufacture either verdict. **Not** `record.error`, which requeue and continuation
  processing clear before the debounced save can be relied on, and **not** a bare `interrupted`
  message, which is never written. See the witness's settle contract; that second discovery also
  invalidated a probe assertion, in the assertion table.
- **The session cookie is a live user credential.** Pass it only through `--header` or the env var,
  never into a log line, this spec, a todo, or a knowledge entry.
- **Artifacts in a task worktree are lost.** Everything goes to `/var/lib/cezar/e2e-artifacts/`,
  never `.ai/cezar/artifacts/`, which does not exist on the box.
- **A deploy from inside an agent task works today, so P4 is not gated on human availability, and
  on this box it takes no transient unit at all.** `runReleaseDeploy` calls `decideReExec`
  (`release-deploy.ts:507`) before the re-exec branch at `537`. On a migrated host that helper
  returns `reExec: false` on the `KillMode=process` short-circuit (`self-safe-deploy.ts:137` to
  `142`), so **the deploy runs inline** and the branch is never entered. Only when
  `decision.reExec` is genuinely true does it build a transient unit, and only there does
  `asUser = (process.getuid?.() ?? 0) !== 0` select the `--user` variant with `userBusEnv()`
  supplying the bus coordinates. Do not describe the user unit as what production does; it is the
  unmigrated-host fallback. What stays denied, correctly, is a **system** transient unit, which runs
  as root; do not add a polkit grant for it. The parent spec withdrew the older "an agent cannot
  drive a deploy" claim on 2026-08-21 (lines 118 to 134), and carrying that forward is precisely
  what would keep this acceptance waiting on an operator for no reason.

---

## Verification

### Automated, green before anything is deployed

`npm run typecheck`, `npm run test`, **and `npm run test:package`**. There is no `npm run lint` in
this repo; the parent spec already corrected a line that named one.

**`npm run test` executes none of the coverage below, so a green run of it is not evidence these
assertions were exercised.** `packages/cezar/vitest.config.ts` sets `include: ['src/**/*.test.ts']`
and states in a comment that `test/` is deliberately excluded because those are the `node:test`
suites. All the new coverage lands in `packages/cezar/test/e2e/`, so the gate that actually runs it
is `npm run test:package` (`node --import tsx --test test/e2e/*.test.ts`). Naming only
`npm run test` would reproduce, in this spec's own verification, the exact failure the spec exists
to remove: a file that looks like coverage and executes nothing.

Note the standing gate hazard: `npm test` is recorded as red on this box independent of any change
(`c78140a8`, `a2763f27`, `eea376fe`). Compare the failing-file set against `origin/main` and report
it, rather than treating a pre-existing red as this work's failure or as a reason to skip the gate.

New coverage, in `packages/cezar/test/e2e/deploy-e2e-probe.test.ts` and a new
`deploy-reattach-witness.test.ts`. Both are **`node:test` suites**, matching the style of the
existing file, not vitest, and both run under `npm run test:package`:

1. Gap classification: a synthetic stream withholding a seq **absent** from the fixture transcript
   classifies as `ephemeralHoles` and the assertion passes.
2. Gap classification: withholding a seq **present** in the fixture transcript classifies as
   `durableLoss` and the assertion fails. This is the red-without-the-fix proof; without it the
   assertion could be vacuous in the other direction.
3. No `--transcript` produces `gapClassification.checked: false` and a `not-measured` verdict.
4. Fresh-connection poller: against a server that closes and rebinds, `pollFresh.connectErrors` and
   `poll.connectErrors` are reported separately and the listener assertion binds to the former.
5. `--fresh-conn` omitted produces `not-measured` for the listener assertion, never a borrowed pass.
6. Re-attach assertion: one `kept going` marker above `reconnectSeqFloor` with no chain-requeue or
   continuation-requeue marker above it passes; a requeue marker above the floor fails; no
   reconnect, or no marker either side, is `not-measured`.
5a. **The interruption-error fixtures, which stop the replacement assertion inheriting the vacuity
   of the one it replaces — in either direction.** Five cases, and the floor is what the last three
   are about:
   - A canonical `interrupted — cezar process exited during the run` appearing in `record.error`
     **during** the window, absent at baseline, makes `a: no NEW interruption error` **fail** and is
     listed in `newInterruptionErrors` with `scope: "run"`.
   - The same string appearing on a step key that was clean at baseline fails likewise, with
     `scope: "step"` and that `stepId`.
   - A record carrying the string in **no** field at any sample passes.
   - **The historical-error case, the mirror of 6a:** a terminal step that already carried the
     canonical string **at baseline** must **not** fail the assertion, at any later sample. It stays
     in `baseline.stepErrors` as context. Without this fixture the assertion fails every long-lived
     subject on sight, which is the failing-direction vacuity.
   - **The dead-subject case:** a canonical string in `record.error` **at baseline** yields
     `baselineWasInterrupted: true` and a `not-measured` verdict, never `failed` — a run that was
     already dead cannot testify about the cutover.
   Assert additionally that a transcript containing the `interrupted continuation re-queued`
   *message* with no error field does **not** trip this assertion: the two are different outcomes,
   and the old string-matching conflated them.
6a. **The historical-marker regression fixture, and it is the one test that must not be skipped.**
   A transcript carrying a `this run kept going` **and** a `chain re-queued` marker *below* the
   floor, with nothing above it, must read `not-measured` and never `passed`. Without this fixture
   the assertion silently reverts to the transcript-wide boolean it replaced, which passes on
   replayed history alone and is the exact false green this spec exists to remove. Its mirror also
   holds: historical requeue markers below the floor must not fail a cutover that did re-attach.
6b. Availability path: `--avail-path` is honoured, reported in `availPath`, and a run against a
   route returning 503 records those as `failed` (proving the P5 route choice is load-bearing).
6e. **Window bounds.** The report carries ISO `startedAt` and `endedAt`; assert `startedAt` is at or
   before the first sample, `endedAt` at or after the last, that both parse as ISO-8601 UTC, and
   that `endedAt - startedAt` agrees with `durationMs` to within a second. Then assert the interval
   check itself as a pure function, off a fixture rather than off a deploy: given a report's bounds
   and a list of event timestamps, it returns true only when **every** event falls inside, and false
   when any one falls outside on either side. That function is what V14a runs against the real
   `symlink-trace.txt`, and testing it here is what stops "the probe covered it" from being an
   assumption made after the fact.
6c. Witness join, all four outcomes: `--witness` naming a `re-attached` report with matching markers
   passes; a `re-launched` report fails **even when the markers look right**; `--witness` omitted, or
   naming a file that does not exist, is `not-measured`; and a witness whose `runId` differs from the
   probe's `--run` is `not-measured` with `witness-run-mismatch`, never a pass borrowed from another
   run. Also assert the read happens **after** the measurement window, so a witness written while
   the probe is still running is picked up rather than missed.
6d. The `adopted-out agent stopped: broker <pid>` marker (`run.ts:2933`) is counted into
   `run.markers.adoptedOut` and `newAdoptedOut` under the **same floor rule** as the others, so a
   historical one below the floor does not contribute. Assert that it is **reported only**: hold
   every other input fixed and flip `newAdoptedOut` between 0 and 1, and the verdict of
   `a: run was re-attached, not re-launched` must be byte-identical in both runs. It is evidence
   that recovery declined this run rather than never reaching it, and it is an input to no verdict.
7. Witness: an appended spool (prefix hash equal over `before.spool.outBytes`, pid unchanged) reads
   as `re-attached`; a spool rewritten from byte zero reads as a `re-launched-…` verdict; a spool
   **shorter** than before reads as `re-launched-…` with `truncated: true` rather than throwing on
   a short read.
7b. Witness: the two re-launch classes separate on broker liveness **alone** — not on spool bytes,
   and not on any probe marker. The same rewritten spool reads `re-launched-broker-died` when the
   before-pid is gone, and `re-launched-broker-orphaned` when that pid is alive and still named in
   `meta.json`. A live pid that `meta.json` no longer names reads `undecidable` with a reason: the
   pid-reuse case, which must not be allowed to invent an owner. The witness takes no probe input
   at all, so there is no `newAdoptedOut` branch to test here, and adding one would reintroduce the
   mis-addressing Problem 3 identifies.
7c. Witness settle: the `after` wait is **symmetric across all five** lifecycle signals. A fixture
   whose outcome signal is `chain re-queued` must return at the same point in the sequence as one
   whose signal is `this run kept going`, and neither may short-circuit ahead of the other; the same
   holds for `interrupted continuation re-queued` and for **both** continuation fall-through forms,
   `resuming the interrupted task` and `could not resume the interrupted task`. A fixture in which
   no signal ever appears must produce `settle.timedOut: true` with `verdict: "undecidable"`,
   **never** a re-launch verdict. Assert `settle.markerSeen` and `settle.waitedMs` are recorded in
   every case, and assert the negative: a fixture whose `record.error` holds the canonical string
   while no signal message has appeared must still time out, proving the field is not consulted.
7d. **Witness settle checkpoint, the fixture that proves the wait is not reading history.** A
   transcript carrying a `this run kept going` marker **before** the `before` report's
   `transcript.bytes`/`maxSeq` checkpoint, and any of the other four signals **after** it, must
   settle on the later one — the signal that actually belongs to this cutover — and must not return
   the historical one. Run it at least once with a continuation fall-through message as the later
   signal, since those two are the newest members of the set and the easiest to omit. Its mirror holds too: with only the historical marker and nothing beyond the
   checkpoint, the result is `settle.timedOut: true` and `undecidable`, never a pass. This is the
   settle-side counterpart of fixture 6a, and it fails the same way if skipped: the wait silently
   reverts to reading replayed history, which on a long-lived subject run is always non-empty.
7a. Witness: `after` given a `--before` report whose `runId` or `spool.dir` does not match returns
   `undecidable`, and `after` invoked with no `--before` at all refuses rather than hashing a
   length it had to guess.
8. Witness: run record with no `spoolDir`, unparseable `meta.json`, and a dead pid each produce a
   recorded reason rather than a crash. This is the defect class that killed the Phase 0.4 script.

### On-box, P4

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/var/lib/cezar/e2e-artifacts/$STAMP; mkdir -p "$OUT"

# session credential, read from what OIDC login already minted (never logged, never pasted)
SESSION_ID=$(node -e '
  const fs=require("fs");
  const p=(process.env.CEZ_HOME||require("os").homedir()+"/.cezar")+"/identity/identity.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  const live=(s.sessions||[]).filter(x=>new Date(x.expiresAt)>Date.now());
  if(!live.length){console.error("no unexpired session");process.exit(1)}
  live.sort((a,b)=>new Date(b.expiresAt)-new Date(a.expiresAt));console.log(live[0].id)')

RUN=<subject run id, re-confirmed running within the last 60s>
PROJECT=/var/lib/cezar/loki-labs/cezar      # the LIVE checkout: the data and the scripts
DATA=$PROJECT/.ai/cezar
DEPLOY_SRC=/var/lib/cezar/tmp/p4-deploy-src # a CLEAN build of the merged HEAD, made below

# --- V0 gate: FAIL CLOSED. These are assertions, not printouts. ------------------------------
# The live checkout is NOT deployable as it stands, and it must NOT be made deployable by tidying
# it. Measured on the box during this step: HEAD 63b6239d, four untracked briefs under
# .ai/specs/briefs/, and a build stamp for 5d59a16f carrying "dirty": true. So a
# `test -z "$(git status --porcelain)"` against it stops before the deploy every time, and the only
# ways to satisfy it in place are to delete or move other people's work, or to rebuild the live tree
# mid-measurement. Both are worse than the problem. The two roles are therefore split: PROJECT stays
# the project whose runs are being measured, and the deploy source is a clean checkout of its HEAD.
SHA=$(git -C "$PROJECT" rev-parse HEAD)     # the merged P1-P3 commit under test
rm -rf "$DEPLOY_SRC"
git clone --shared "$PROJECT" "$DEPLOY_SRC" || exit 1
git -C "$DEPLOY_SRC" checkout --detach "$SHA" || exit 1
test -z "$(git -C "$DEPLOY_SRC" status --porcelain)" \
  || { echo "V0: fresh clone is dirty — impossible, investigate"; exit 1; }
( cd "$DEPLOY_SRC" && npm ci && npm run build ) || { echo "V0: candidate build failed"; exit 1; }
node -e '
  const s = require(process.argv[1]), head = process.argv[2];
  if (s.dirty !== false) throw new Error("build stamp is dirty");
  if (!head.startsWith(s.sha)) throw new Error(`stamp sha ${s.sha} is not HEAD ${head}`);
' "$DEPLOY_SRC/packages/cezar/dist/.build-stamp.json" "$SHA"

# The command line is evidence too, and `tee` only captures a command's OUTPUT, never the command
# itself, so V0 reads this artifact, not deploy.log.
cat > "$OUT/invocation.json" <<JSON
{"project":"$PROJECT","deploySource":"$DEPLOY_SRC","sha":"$SHA","runId":"$RUN",
 "availPath":"/api/v1/ready",
 "command":"cezar server-deploy --strategy=blue-green --follow --source=$DEPLOY_SRC --sha=$SHA --refuse-dirty"}
JSON

systemctl show cezar.service -p MainPID,ActiveEnterTimestamp,NExecutions,KillMode,Delegate \
  > "$OUT/unit-before.txt"

# Scripts come from PROJECT, which needs no clean tree — only the DEPLOY SOURCE does.
node "$PROJECT/packages/cezar/scripts/deploy-reattach-witness.mjs" \
     --run "$RUN" --data-dir "$DATA" --phase before --out "$OUT/witness-before.json"

# --seconds covers the deploy AND the after-witness's settle window — see the timing note below.
node "$PROJECT/packages/cezar/scripts/deploy-e2e-probe.mjs" \
     --base http://127.0.0.1:4321 --project cezar --run "$RUN" --seconds 180 \
     --fresh-conn --transcript "$DATA/runs/$RUN.ndjson" \
     --witness "$OUT/witness-after.json" \
     --header "cookie: cez_session=$SESSION_ID" \
     --out "$OUT/probe.json" & PROBE=$!

cezar server-deploy --strategy=blue-green --follow \
     --source="$DEPLOY_SRC" --sha="$SHA" --refuse-dirty 2>&1 | tee "$OUT/deploy.log"
test "${PIPESTATUS[0]}" -eq 0 || { echo "V0: deploy failed"; kill $PROBE; exit 1; }

# The after-witness is written BEFORE the probe is waited on: the probe reads it at the end of its
# own window, so writing it after `wait` would guarantee it is always missing.
node "$PROJECT/packages/cezar/scripts/deploy-reattach-witness.mjs" \
     --run "$RUN" --data-dir "$DATA" --phase after --settle-timeout 90 \
     --before "$OUT/witness-before.json" --out "$OUT/witness-after.json"

wait $PROBE; PROBE_EXIT=$?
echo "probe exit=$PROBE_EXIT" | tee -a "$OUT/pre-state.txt"

# Sequence step 5, the readable form. NOT `journalctl -u cezar.service`: the cezar user is in no
# group but `cezar`, so that returns only this user's own messages plus the "Users in groups 'adm',
# systemd-journal' can see all messages" hint — an artifact that is silently empty, which the next
# reader mistakes for "nothing happened". These four cannot be reconstructed later either, and can
# actually be read.
systemctl show cezar.service -p MainPID,ActiveEnterTimestamp,NExecutions,KillMode,Delegate \
  > "$OUT/unit-after.txt"
#   plus, already captured above: witness-{before,after}.json carry server.mainPid,
#   server.invocationId and spool.exitFilePresent, and deploy.log is the deployer's own output.

rm -rf "$DEPLOY_SRC"          # only after the artifacts above are written
```

**Timing constraint this creates, and it is tighter than it looks:** the budget inside the probe's
`--seconds` window is the deploy duration **plus the after-witness's `--settle-timeout`**, not the
deploy duration alone. 180 s was comfortable for the cutover by itself, but a 90 s settle on top of
it leaves little room, so **re-check 180 s against a timed dry run rather than assuming it**, and
raise `--seconds` rather than letting the probe close first, which would make the re-attach
assertion `not-measured` for a purely procedural reason. Shrinking `--settle-timeout` to make it fit
is the wrong trade: a short settle turns a slow decision into a false `undecidable`.

Pass conditions, each read from a named field rather than from the exit code alone:

| # | Assertion | Read from |
| --- | --- | --- |
| V0 | the deployed tree is a **clean freshly-built checkout** of the project's merged HEAD | `invocation.json` → `project`, `deploySource`, `sha`, `command`. The gate exits non-zero if the fresh clone is dirty, the build fails, or the stamp is not this HEAD, so reaching the deploy at all is the assertion. `deploySource` must **not** equal `project`: the live checkout carries untracked work and a stale dirty stamp, and satisfying the gate by cleaning it would destroy other work. Not `deploy.log`, which holds output and never the command line. |
| V1 | zero non-2xx | `probe.json` → `pollFresh.failed` and `poll.failed`, both 0, **and** both asserted, not read by eye |
| V2 | zero refused, fresh connections | `pollFresh.connectErrors` = 0 |
| V3 | keep-alive refusals recorded, not asserted | `poll.connectErrors`, reported against `6c89af7c` |
| V4 | no durable event loss | `sse.gapClassification.durableLoss` empty, `checked: true` |
| V5 | ephemeral holes quantified | `sse.gapClassification.ephemeralHoles`, filed to `8206c158` |
| V6 | run never left `running`, and gained no NEW interruption error | `run.statuses`; `run.interruption.newInterruptionErrors` empty, **against** `run.interruption.baseline` — a historical `steps[].error` from an earlier restart is context, not a failure. `baselineWasInterrupted` must be false, or the subject was invalid and V6 reads not-measured. **Not** `sawInterrupted`, which is removed: no such message is ever written (assertion table). |
| V7 | re-attached, not re-launched | `probe.json` → `run.witness.present: true` with `runIdMatches: true`, and the assertion `a: run was re-attached, not re-launched` reads `passed`: `run.markers.newKeptGoing` = 1 with `newChainRequeued` = 0 and `newContinuationRequeued` = 0 above `reconnectSeqFloor`, plus `run.interruption.newInterruptionErrors` empty against its baseline, joined to `witness-after.json` → `comparison.verdict: "re-attached"` |
| V7a | **if V7 fails, which defect it is** | `witness-after.json` → `comparison.verdict`, on broker liveness alone: `re-launched-broker-died` addresses `45813876`, `re-launched-broker-orphaned` addresses `4afa1b4b`. `probe.json` → `run.markers.newAdoptedOut` is reported alongside as evidence that recovery declined this run rather than never running, and is **not** part of the classification. `undecidable` is a legitimate outcome and is reported as such, never rounded to whichever owner is nearer to hand. |
| V8 | `gap_ms` and `inflight_runs` captured | `pollFresh.gapMs`; `deploy.cutover` in `deploy.log` |

V7 is the one expected to fail on today's code. Record it as measured, name the owner V7a's class
points at, do not retry it until that is fixed, and do not let it suppress V1 to V6, which stand on
their own.

### On-box, P5

This is the one genuinely dangerous window in the spec, so it is written as a runbook rather than as
prose. An operator must not have to invent safety-critical mechanics while a deliberately broken
release is live.

```bash
# NOT `set -e`. Two commands in this runbook are SUPPOSED to exit non-zero: the deploy (it rolls
# back, exit 1) and the probe (no --run, so its run/SSE assertions are not-measured, exit 2).
# Under `set -e` the script would abort on its own intended outcomes, before capturing any evidence
# and before disarming the watchdog. Exit codes are therefore captured and asserted explicitly.
set -uo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/var/lib/cezar/e2e-artifacts/$STAMP-p5; mkdir -p "$OUT"
SRC=/var/lib/cezar/loki-labs/cezar
CAND=/var/lib/cezar/tmp/p5-candidate            # isolated checkout, never the live one
CAND_BROKEN=/var/lib/cezar/tmp/p5-candidate-failclosed
WD=cezar-restore-watchdog-p5

# Cleanup ALWAYS runs, including on an unexpected error, and it kills the TRACE PROCESS ONLY.
# It must NEVER disarm the watchdog. An unexpected exit — Ctrl-C, a shell error, a rollback that
# did not recover — is precisely the case where the watchdog is the only thing left that will
# restore the box, so a trap that stops it converts a recoverable incident into a broken release
# serving with its recovery mechanism switched off. Disarming happens in step 7, and only after
# recovery has been machine-verified. A watchdog that outlives this script on a healthy box is
# harmless: it checks before it acts and no-ops.
cleanup() {
  [ -n "${TRACE:-}" ] && kill "$TRACE" 2>/dev/null
}
trap cleanup EXIT

# --- 0. capture the good state FIRST; every rollback assertion is relative to this ------------
GOOD_LINK=$(readlink -f /opt/cezar)
cp /opt/cezar-releases/deploy.json "$OUT/ledger-before.json"
GOOD_CURRENT=$(node -e 'console.log(require(process.argv[1]).current)' "$OUT/ledger-before.json")
echo "good link=$GOOD_LINK current=$GOOD_CURRENT" | tee "$OUT/pre-state.txt"

# --- 1. build the candidate BEFORE arming anything ---------------------------------------------
# Clone, install and build take minutes. Arming the watchdog first would spend most of its 900 s
# countdown on work that cannot endanger the box, and could fire it before the deploy even starts.
# 900 s, raised from 600: the window now spans the fail-closed deploy (4b) as well as the real one.
git clone --shared "$SRC" "$CAND" || exit 1
cd "$CAND" || exit 1

# The patch is executable, not a comment. It inserts ONE readiness check beside the existing ones
# and asserts its anchor is unique, so it cannot silently apply in the wrong place or not at all.
# Key on the RESOLVED listening descriptor, NEVER on process.env.LISTEN_FDS: the server deletes
# LISTEN_* from its own environment at startup (index.ts:627 -> socket-activation.ts:78-84), so the
# env var is absent LIVE as well as under smoke boot and the check would never fire — the candidate
# would go live and stay live. `deps.listenFd` is in scope at this anchor and is what
# `runtime.socketActivated` already reads (server.ts:2426): a number under socket activation,
# undefined under the smoke boot's random loopback port. So the candidate is READY under smoke boot
# and NOT ready once live, which is the whole experiment.
cat > "$OUT/inject.mjs" <<'MJS'
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'packages/cezar/src/server/server.ts';
const src = readFileSync(path, 'utf8');
const anchor = "    record('draining', () => (deps.drain?.isDraining() ? 'server is draining' : undefined));";
const hits = src.split(anchor).length - 1;
if (hits !== 1) throw new Error(`anchor matched ${hits} times, expected exactly 1`);
const injected = "    record('p5-injected', () => (deps.listenFd !== undefined ? 'P5 injected readiness failure' : undefined));";
writeFileSync(path, src.replace(anchor, `${anchor}\n${injected}`));
MJS
node "$OUT/inject.mjs" || exit 1

# Exactly one file, exactly one inserted line, zero deletions. Anything else is not this experiment.
git diff --numstat | tee "$OUT/candidate-diff.txt"
test "$(git diff --numstat | wc -l)" -eq 1 || { echo "P5: patch touched more than one file"; exit 1; }
test "$(git diff --numstat | awk '{print $1"/"$2}')" = "1/0" || { echo "P5: not a single-line insert"; exit 1; }

git commit -am 'test: P5 injected readiness failure (never merged, never pushed)' || exit 1
CSHA=$(git rev-parse HEAD)
npm ci && npm run build || exit 1
node -e '
  const s = require(process.argv[1]);
  if (s.dirty !== false) throw new Error("candidate build stamp is dirty");
' "$CAND/packages/cezar/dist/.build-stamp.json" || exit 1

# --- 2. arm the restore watchdog, now, immediately before the dangerous part --------------------
# It CHECKS before it acts: if the box is already back on the good release and ready, it no-ops.
# Restoring unconditionally would itself cause an outage on a run that had already recovered.
cat > "$OUT/restore.sh" <<'SH'
#!/bin/bash
MARK="$MARK_PATH"
live=$(readlink -f /opt/cezar)
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4321/api/v1/ready)
if [ "$live" = "$GOOD_LINK" ] && [ "$code" = "200" ]; then
  echo "no-op $(date -u +%FT%TZ) live=$live ready=$code" > "$MARK"
  exit 0
fi
echo "acted $(date -u +%FT%TZ) live=$live ready=$code" > "$MARK"
ln -sfn "$GOOD_LINK" /opt/cezar.tmp && mv -Tf /opt/cezar.tmp /opt/cezar
systemctl restart cezar.service
sleep 15
echo "after-restore ready=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4321/api/v1/ready)" >> "$MARK"
SH
chmod +x "$OUT/restore.sh"
systemd-run --user --unit="$WD" --on-active=900 \
            --setenv=GOOD_LINK="$GOOD_LINK" --setenv=MARK_PATH="$OUT/watchdog-verdict.txt" \
            "$OUT/restore.sh"
systemctl --user list-timers "$WD" | tee "$OUT/watchdog-armed.txt"

# --- 3. observe the symlink continuously, so the flip and flip-back are both witnessed ---------
# FULL ISO stamps, not %H:%M:%S: V14a compares these against the probe's startedAt/endedAt, and a
# time-of-day with no date cannot be compared to an ISO instant.
( while :; do printf '%s %s\n' "$(date -u +%FT%T.%3NZ)" "$(readlink -f /opt/cezar)"; sleep 0.2; done ) \
  > "$OUT/symlink-trace.txt" & TRACE=$!

# --- 4. probe on an availability route that is NOT the one we are breaking --------------------
# 480 s, not 300: this window now has to cover BOTH deploys (4b and 5), not just the dangerous one.
node "$SRC/packages/cezar/scripts/deploy-e2e-probe.mjs" \
     --base http://127.0.0.1:4321 --avail-path /api/v1/health --fresh-conn --seconds 480 \
     --out "$OUT/probe.json" & PROBE=$!

# --- 4b. FAIL-CLOSED first: the half of criterion 4 that was never probed -----------------------
# Nothing flips on this path, so it carries none of the danger below — and this time the probe IS
# running, which is the only thing the 2026-08-21 exercise was missing. Built by copying the
# already-built candidate and truncating its entry point: the same defect that exercise used, and
# no second npm ci/build. The injected readiness check rides along harmlessly; it never boots.
cp -a "$CAND" "$CAND_BROKEN"
: > "$CAND_BROKEN/packages/cezar/dist/index.js"
FAILCLOSED_T0=$(date -u +%FT%T.%3NZ)
cezar server-deploy --strategy=blue-green --follow --source="$CAND_BROKEN" --sha="$CSHA" \
     2>&1 | tee "$OUT/deploy-failclosed.log"
FAILCLOSED_EXIT=${PIPESTATUS[0]}
FAILCLOSED_T1=$(date -u +%FT%T.%3NZ)
echo "fail-closed deploy exit=$FAILCLOSED_EXIT (expected 1, failedAt smoke_boot)" \
  | tee -a "$OUT/pre-state.txt"
# MUST still equal GOOD_LINK: a fail-closed deploy that flipped anything is the defect, not the test.
readlink -f /opt/cezar | tee "$OUT/link-after-failclosed.txt"

# --- 5. deploy the candidate; exit 1 is the EXPECTED result (it rolls itself back) --------------
DEPLOY_T0=$(date -u +%FT%T.%3NZ)
cezar server-deploy --strategy=blue-green --follow --source="$CAND" --sha="$CSHA" \
     2>&1 | tee "$OUT/deploy.log"
DEPLOY_EXIT=${PIPESTATUS[0]}
DEPLOY_T1=$(date -u +%FT%T.%3NZ)
echo "deploy exit=$DEPLOY_EXIT (expected 1)" | tee -a "$OUT/pre-state.txt"

# Both attempts' boundaries, in the same ISO form the probe now stamps its window with. V14a joins
# these to `probe.json`'s startedAt/endedAt; without them "the probe covered it" is only a belief.
printf '{"failClosed":{"t0":"%s","t1":"%s"},"candidate":{"t0":"%s","t1":"%s"}}\n' \
  "$FAILCLOSED_T0" "$FAILCLOSED_T1" "$DEPLOY_T0" "$DEPLOY_T1" > "$OUT/deploy-boundaries.json"

wait $PROBE; PROBE_EXIT=$?
echo "probe exit=$PROBE_EXIT (expected 2: no --run, so run/SSE read not-measured)" \
  | tee -a "$OUT/pre-state.txt"
kill $TRACE 2>/dev/null; TRACE=

# --- 6. capture the outcome ---------------------------------------------------------------------
cp /opt/cezar-releases/deploy.json "$OUT/ledger-after.json"
readlink -f /opt/cezar | tee "$OUT/post-link.txt"

# --- 7. VERIFY recovery, and only then disarm ---------------------------------------------------
# Disarming before proving the box is back is the one irreversible mistake available in this
# runbook. BOTH checks must pass. If either fails the watchdog STAYS ARMED, still counting down
# toward its restore, and this script exits nonzero so the operator sees why.
LIVE_NOW=$(readlink -f /opt/cezar)
READY_NOW=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4321/api/v1/ready)
echo "recovery check: live=$LIVE_NOW (want $GOOD_LINK) ready=$READY_NOW (want 200)" \
  | tee "$OUT/recovery-check.txt"
if [ "$LIVE_NOW" != "$GOOD_LINK" ] || [ "$READY_NOW" != "200" ]; then
  echo "ROLLBACK DID NOT RECOVER — watchdog left ARMED deliberately; do not disarm by hand" \
    | tee -a "$OUT/recovery-check.txt"
  exit 1
fi
systemctl --user stop "$WD.timer" "$WD.service" 2>/dev/null
cat "$OUT/watchdog-verdict.txt" 2>/dev/null || echo "never-fired" > "$OUT/watchdog-verdict.txt"

# --- 8. cleanup, conditional on a clean result ---------------------------------------------------
#   Only when V8c-V15 all pass: rm -rf "$CAND" "$CAND_BROKEN". If ANY failed, leave both in place
#   for diagnosis.
#   BOTH candidates' `healthy: false` ledger entries STAY as evidence, as 20260821T183255Z-deadbeef
#   did — the fail-closed one is now criterion 4's first half, not a discardable warm-up.
#   The commit is never merged and never pushed.
```

**Expected exit codes are part of the assertion, not noise.** `DEPLOY_EXIT` must be **1** with
`failedAt: "readiness"` in the log: a 0 means the injected failure did not fire and the run proves
nothing. `PROBE_EXIT` **2** is correct and acceptable here, because this P5 probe is given no
`--run`, so its run-status and SSE assertions are `not-measured` by the same rule that governs
everything else; V14 reads the HTTP fields directly rather than the exit code. A probe exit of **1**
means an HTTP assertion genuinely failed and V14 fails with it.

Then assert:

| # | Assertion | Read from |
| --- | --- | --- |
| V8a | the candidate is exactly the one-line injection | `candidate-diff.txt` = one file, `1/0` insert/delete; the gate exits non-zero otherwise |
| V8b | the deploy failed as intended | `DEPLOY_EXIT` = 1 in `pre-state.txt`; a 0 voids the run |
| V8c | **the fail-closed candidate never flipped the symlink** | `FAILCLOSED_EXIT` = 1 with `failedAt: "smoke_boot"` in `deploy-failclosed.log`; `link-after-failclosed.txt` equals `GOOD_LINK`; `symlink-trace.txt` shows **no** flip at all in that interval. Closes the half of criterion 4 that was previously inherited. |
| V8d | zero client failures across the fail-closed attempt | `probe.json` → `pollFresh.failed` and `pollFresh.connectErrors` both 0. The probe spans 4b and 5, so read this together with V14 rather than as a separate window. |
| V9 | smoke boot passed | `deploy.log`, `deploy.instance_ready` emitted |
| V10 | symlink flipped to the candidate | `symlink-trace.txt` shows the candidate release, timestamped |
| V11 | readiness failed after the flip | `deploy.rollback` with `failedAt: "readiness"` |
| V12 | ledger marks the candidate unhealthy | `ledger-after.json`, candidate `healthy: false` |
| V13 | symlink restored to `previous` | `post-link.txt` equals `GOOD_LINK`, **and** `ledger-after.json` `current` equals `GOOD_CURRENT` |
| V14 | zero client failures across **both** restarts, on the availability route | `probe.json` → `availPath` is `/api/v1/health`, `pollFresh.failed` = 0, `pollFresh.connectErrors` = 0. Read these fields, **not** `PROBE_EXIT`, which is legitimately 2 here. |
| V14a | **the probe's window actually covered what V8c/V8d/V14 claim it covered** | `probe.json` → `startedAt`/`endedAt` versus `deploy-boundaries.json`: both attempts' `t0`/`t1` must fall strictly inside. Then every flip in `symlink-trace.txt` — the flip to the candidate and the flip back — must carry a timestamp inside the same interval. If any boundary falls outside, V8d and V14 are **not-measured**, not passed: the probe did not observe the window they describe. |
| V15 | the watchdog did not have to act | `watchdog-verdict.txt` reads `never-fired` or `no-op`. **`acted` means the rollback branch failed and the watchdog saved the box**, which is a finding, not a pass. Read `recovery-check.txt` alongside it: the runbook disarms only after the live symlink equals `GOOD_LINK` and `/api/v1/ready` answers 200, so a run that exited 1 there left the watchdog armed on purpose. |

**V14 is why `--avail-path` exists.** Pointed at `/api/v1/ready` it would be **unsatisfiable by
construction**: P5 deliberately makes readiness fail, that route answers 503 by design while the
candidate is live, and `pollOnce` counts every non-`ok` response as a failure. The probe would
record a wall of failures that prove only that the injection worked. Availability and readiness are
different questions here, and only the deployer's own `/ready` probe should be asking the second
one. If `probe.json` reports `availPath: "/api/v1/ready"`, the P5 run is void, not failed.

**Do not verify V13 against `rolledBackTo`.** It is a field of `DeployOutcome`
(`deploy-strategy.ts:106`), which `runReleaseDeploy` returns and never logs, not of `DeployEvent`
(`deploy-strategy.ts:46` to `63`), and `emit` prints events only. No log line can contain it, so an
operator looking for one during the single dangerous window would find nothing and have no way to
tell that from a failed rollback. That `deploy.rollback` carries no `rolledBackTo` is a real nit
worth filing against `deploy-strategy.ts`; it is not something to verify against until it exists.

### Definition of done for this spec

P1 to P3 merged with gates green is **not** done. This work is done when P4 and P5 have actually run
on `prod-host`, their artifacts are under `/var/lib/cezar/e2e-artifacts/`, and the parent
spec's Status line records the per-criterion verdict with real numbers. If V7 fails as expected, the
parent stays QA Needed and this spec is done anyway: its job is to make the acceptance measurable and
measured, not to make it green.

---

## Analytics

No new events. The two the parent spec already commits to are what P4 reads:
`deploy.cutover` carries `gapMs` (the deployer's own window, explicitly not the acceptance number)
and `inflightRuns` (`deploy-strategy.ts:169`), and `deploy.rollback` carries `reason` and `failedAt`
of `smoke_boot` or `readiness`, which is what P5 asserts on.

---

## Out of scope

- **Deciding the seq protocol.** Whether `emitEphemeral` should keep sharing the counter is
  `8206c158`'s call. This spec identifies the cause and hands over the numbers.
- **Fixing re-attachment.** `4afa1b4b` owns the fix and the orphan reaping; `75fe00ab` owns
  measuring what selects between adopt and re-queue; `45813876` owns the blue-green variant.
- **Fixing the keep-alive reset and the ~1.1 s boot latency.** `6c89af7c`.
- **Host provisioning.** Done, 2026-08-21, and re-measured.
- **The half-live backend gap** (`27d6efd6`): a tree matching HEAD with health 200 does not prove
  the resident process loaded the new code. Related, separately owned, not folded in here.
- **A cross-process lock on `.ai/cezar/`.** The parent spec rules it out and nothing here needs it.

---

## Sources read

Everything below was opened in this step, in this checkout, at commit `63b6239d` on branch
`cez/e2593272`.

- `.ai/specs/briefs/2026-08-30-deploy-acceptance-measurement.md`, in full.
- `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (KB `specs-594acc539b36`): header and
  status corrections (lines 1 to 57), the 2026-08-21 provisioning log (58 to 143), the acceptance
  E2E log (144 to 211), both 2026-08-23 SSE logs (212 to 297), Phases and Risks (759 to 814),
  Verification (815 to 949), the reopened criterion 1 (1239 to 1288), the agent-driven pass
  (1289 to 1369), Out of scope (1370 to 1381). Note: the 2026-08-23 status log appears **twice**,
  at lines 212 and 252, near-identically. Not changed here, since this step edits no other file,
  but it is worth folding when the parent is next amended.
- `.ai/specs/2026-08-22-broker-scope-isolation-full-stop-survival.md`: status and the 2026-08-24
  Phase 1 correction (1 to 61), the non-goal boundary against the parent spec (240 to 258), and the
  Phase 1 result table with its three script defects (662 to 700).
- `packages/cezar/scripts/deploy-e2e-probe.mjs`, lines 88 to 383: pollers, `subscribe`,
  `handleFrame`, `continuity`, `assertion`, the assertion table and the report shape.
  `sawKeptGoing` is collected at line 356 and asserted nowhere; `sawInterrupted` is set at line 243
  from `payload.message` and can never be true (see the assertion table); `sampleRun` fetches the
  whole run record at 147 and keeps only `record.status`; and `durationMs` (328) is the report's
  only time field, with no absolute bounds.
- `packages/cezar/src/runs/store.ts`: `appendEvent` (1265), `emitEphemeral` (1434) and its doc
  comment, `nextSeq` (1571), `rehydrateSeq` (1578), and the crash-recovery path at `794` that
  writes `interrupted — cezar process exited during the run` into `run.error` as a **field**.
- The canonical interruption string, traced to every site that writes it: `run.ts:2644` (step
  `error`), `run.ts:2651` (run `error`), `store.ts:794` (run `error`). No site writes it as an
  event `message`. The only lifecycle message containing the word is
  `… — interrupted continuation re-queued` (`run.ts:2498`), and the four `resuming` messages
  (`run.ts:3292`, `3692`, `5934`, `6118`) are usage-limit and rework messages, not recovery
  outcomes.
- `packages/cezar/src/server/server.ts`: the run events SSE route (6693 to 6770), and `/api/v1/ready`
  (2593 to 2618).
- `packages/cezar/src/workflows/run.ts`: the `running` recovery branch (2619, calling
  `reattachBrokeredRun` at 2626), `spoolDirOf` (2781), the **relative** `spoolDir` write in
  `brokerFor` (2804), `persistConsumedOffset` (2889), `reattachBrokeredRun` (2924) and its **six**
  refusal sites (2926, 2938, 2939, 2941, 2944, 2949 — the seventh `return false`, at 2936, is
  `refuse()`'s own tail, not a guard; an earlier draft of this spec said "seven" and is corrected
  above), the `adopted-out agent stopped` append (2931 to 2934), the `this run kept going` append
  (2958), the `chain re-queued` message (3205), the `emitEphemeral` call site (7834).
- `packages/cezar/src/core/run-spool.ts`: `BROKER_PROTOCOL` (31), `spoolDirFor` (133),
  `legacySpoolDirFor` (138), `readSpoolMeta` (162), `isPidAlive` (189), and `isSpoolLive` (266)
  with its five separate refusal conditions.
- `packages/cezar/src/core/brokered-session.ts`: `consumedOffset` (175) and the `drain()` below it
  that advances the offset only over complete lines, which is what makes the witness's offset
  assertion mean "delivered" rather than "read".
- `packages/cezar/src/server-install/deploy-strategy.ts`: `runGatedDeploy`, both gates and the
  post-flip rollback (113 to 200).
- `packages/cezar/src/server-install/release-deploy.ts`: the host effects (193 to 289) and
  `smokeBootRelease` (defined at 301, called at 255) with its full environment block at 317 to 337,
  where `LISTEN_FDS` and `LISTEN_PID` are cleared and `CEZ_SINGLE_PROJECT` is set. Note what this
  bullet does **not** establish: the cleared env var is not itself a usable discriminator, because
  the live server deletes it too (see P5). The smoke boot's random loopback bind is what makes
  `deps.listenFd` differ, and that is the discriminator P5 uses.
- Live tracker `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json`, 208 entries: `d0386413`
  (in-progress), `a025f99a` (this task), `45813876`, `8206c158`, `6c89af7c`, `4afa1b4b`, `75fe00ab`,
  `27d6efd6` all `todo`; `8dc8bf3a` and `f97ddd39` `done`.
- Measured on the box during this step: `/var/lib/cezar/e2e-artifacts/` exists and holds the
  2026-08-21 artifacts; `.ai/cezar/artifacts/` does not exist; this run's own transcript
  `.ai/cezar/runs/e2593272-….ndjson` holds 510 events carrying a `seq`, 53 gaps, highest seq 698;
  and across `.ai/cezar/runs/*.ndjson`, `this run kept going` appears in **53** transcripts,
  `chain re-queued` in **48**, and `adopted-out agent stopped` in **16** — which is what makes the
  third marker worth counting rather than a theoretical one. (Re-counted this step: the
  `adopted-out` figure was 15 earlier in the session and the box has since written another.)
- `packages/cezar/src/core/reap-abandoned-broker.ts`, in full (39 lines): the `ESRCH` fall-through
  at `24` reaching `return true` at `38`, which is why the `adopted-out` marker is not a liveness
  signal.
- `packages/cezar/src/server/socket-activation.ts`: `consumeSocketActivation` (78) and its
  `delete` of `LISTEN_PID`/`LISTEN_FDS`/`LISTEN_FDNAMES` (80 to 82), with the call at
  `index.ts:627`; and `server.ts:2426`, where `deps.listenFd !== undefined` is already the live
  source of `runtime.socketActivated`.

**Not found.** A KB id for the corpus note `cezar-prod-rootless-deploy-provisioning` did not surface
from a lexical search, so it is cited by name as the parent spec cites it, and its content is taken
from the parent spec's summary rather than read directly. `cezar todo list` in this worktree returns
no filed todos; the tracker citations above come from the workspace `todos.json`.
