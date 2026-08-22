# Brief: Run spool exit crosstalk

**Task:** `f73115a0-f2d2-445d-9f23-559946796d97`  
**Step:** Gather the record only. This is a brief, not a spec. No code or tests were changed.

## Problem in this repository's terms

Cezar made the broker process and its output spool the durability boundary that lets an agent run
outlive the server which started it. That boundary is launch-scoped in reality, but the current
spool is run-scoped: `spoolDirFor(runsDir, runId)` returns `runs/<runId>.spool`. Every broker for
every step or failed reattachment of that run therefore shares `meta.json`, output, control socket,
and `exit.json`.

The terminal record has no owner. `spoolExitSchema` contains only `code`, `signal`, and `exitedAt`,
and `BrokeredSession.tick()` accepts any such record as the attached process's exit. A broker left
behind after a deploy reaches its 30-minute orphan watchdog, SIGTERMs Claude, and writes Claude's
handled exit code 143 into the shared directory. A live sibling reads that foreign exit within one
poll interval, the step and run fail, worktrees are discarded, and the live agent continues
working without a reader.

This is not hypothetical. The primary KB record cites runs `232ad6d4` and `bde0ec40`, with failure
times matching the abandoned brokers' 30-minute clocks, plus two live Claude sessions observed for
each of `49a5aea3` and `eb9f65aa` (KB `notion-04ca960e6408`).

## What the record already decided

- The curated Cezar domain marks this as an open, diagnosed, cleaned-up, but unimplemented defect
  (`/var/lib/cezar/loki-labs/notion-export/domains/cezar.md:17`). It points to primary KB record
  `notion-04ca960e6408`, proposed-spec commit `3a54d156`, and historical todo `1b21b153`.
- KB `notion-04ca960e6408`, *A shared spool and an exit record with no owner*, establishes the
  incident evidence, causal clock, duplicate-agent observations, and intended direction: owned
  exits, launch-specific spools, stale-exit removal, reaping on refused reattachment, and a deploy
  policy that does not abandon agents. It also establishes the runtime invariant: exactly one live
  agent per run id, reported beside `runtime.runBrokerIsolation`.
- KB `notion-d660e1080ec2`, *A per-run name for a per-step resource, and the timeout that lied about
  it*, is the direct precedent. Its correction explicitly says commit `8e20dfbf` fixed this identity
  error only for systemd scope names, not for spools. Its durable rule is to name a resource after
  its unit of lifetime while retaining the run id as an operator-visible grouping prefix.
- Commit `0883256b` refined the existing launch identity to a process-start stamp plus monotonic
  counter. The next step should reuse that established `instanceId`, not invent another identity.
- The proposed spec already exists in git object `3a54d156` and on `origin/main`. It decides:
  owned exits and legacy fallback (`git show 3a54d156:.ai/specs/2026-08-22-spool-exit-cross-talk.md`,
  lines 122-135), child instance directories and sweep changes (lines 137-145), stale-exit unlink
  (lines 147-151), reap plus lifecycle event (lines 153-158), protocol migration and liveness risks
  (lines 184-193), and regression/runtime verification (lines 195-215).
- The broker durability mechanism originated in `3f4e9c33`; `954c6a55` wired persisted spool paths,
  offsets, and recovery reattachment into real runs. No later commit implements spool isolation.

The proposed spec is absent from this worktree because `3a54d156` is not an ancestor of this HEAD,
although it is an ancestor of `origin/main`. This brief cites the git object rather than pretending
the checked-out spec file exists.

## Code actually involved

- `packages/cezar/src/core/run-spool.ts:29`: protocol is still 1. Meta includes the broker pid but no
  `instanceId` (`:33`). Exit has no owner (`:52`). `spoolDirFor` is flat per run (`:127`),
  `ensureSpoolDir` only creates the directory (`:132`), and `isSpoolLive` rejects any exit before
  checking broker liveness (`:236`).
- `packages/cezar/src/core/run-broker.ts:61`: orphan timeout is 30 minutes. Startup calls
  `ensureSpoolDir` and appends to existing output (`:93-101`). The watchdog interrupts after no
  control or output activity (`:230`), then the child-exit path writes an unowned exit after flushing
  tees (`:239-258`).
- `packages/cezar/src/core/brokered-session.ts:128`: each tick drains output, reads any exit, and
  finishes immediately without comparing the writer to attached `meta.pid`. The Claude wrapper
  maps that terminal result into a step failure at
  `packages/cezar/src/core/claude-cli-runner.ts:491`.
- `packages/cezar/src/workflows/run.ts:1743`: every step derives the same spool from `runId` and
  persists one `spoolDir` and one consumed offset. Recovery tries reattachment at `:1640`.
  `reattachBrokeredRun` validates the spool and chain at `:1806`, but every false return leaves a
  live `meta.pid` unreaped before chain restart. `sweepSpools` only understands top-level
  `<runId>.spool` directories (`:1863`).
- `packages/contract/src/runs.ts:422` persists only one active spool path and offset per run. This
  can still identify the active child directory, but the spec must say so explicitly.
- `packages/contract/src/health.ts:160` and `packages/cezar/src/server/runtime-info.ts:18` expose
  isolation mode, brokered backends, and availability. Neither exposes duplicate brokers or agents.
- Current tests pin the old layout and behavior: `core/run-spool.test.ts:53`,
  `core/brokered-session.test.ts:163`, `workflows/recover-brokered.test.ts:88`, and
  `core/run-broker.test.ts:159`. No current test launches two brokers for one run, rejects a foreign
  exit, reaps a refused reattachment, or checks a one-agent-per-run health invariant.

## Prior decisions and possible contradictions

The change extends rather than contradicts the non-disruptive deploy decision. The spool remains
the server-independent durability boundary; only its ownership scope changes. It must also retain
the existing idle liveness bound for brokers that die without writing an exit.

The proposed P4 is internally unsafe as written. It permits either signalling the broker pid or
stopping `cezar-run-<runId>-*`, while KB `notion-04ca960e6408` records that stopping a whole scope
can cause the abandoned broker to write the poisonous shared exit and can target the healthy
sibling. The spec must choose an exact target and ordering, not preserve this alternative.

The domain record names a high-priority todo, but `cezar todo list` currently reports no todos.
No duplicate or in-flight tracker work was found. GitHub issue 143 does not exist in this repo, so
the task title's `(143)` is treated as the observed exit code, not an issue reference.

## Open questions the spec must settle

1. Is `instanceId` mandatory on every new launch and new exit, with optionality limited strictly to
   protocol-1 reads? Making it optional in the new write path would preserve the flat collision.
2. Must a reader reject both mismatched `brokerPid` and mismatched `instanceId`, and which fact wins
   if those fields disagree? The acceptance criterion only defines pid comparison.
3. How is an anonymous protocol-1 exit accepted safely when pid reuse can make a dead broker's pid
   appear alive again?
4. What exact signal, wait, escalation, and lifecycle event safely reap only the broker refused by
   reattachment before a replacement launch begins?
5. How does nested spool sweeping prove each instance is dead before removal? The incident record
   shows live agents continuing to write after a run spool was unlinked.
6. What is the additive health response shape and collection method? It should be backend-neutral,
   define whether brief transition overlap is allowed, and avoid treating one broker per active
   step as one broker per historical run.
7. Is deploy drain/adopt behavior in this task? The proposed spec calls it P5 but out of scope,
   while the KB lists it as the fifth intended phase. The acceptance criteria stop at P4 plus the
   runtime invariant.

## What was not found

- No implementation of the proposed fix.
- No currently filed todo or GitHub issue for this work.
- No exact health contract, lifecycle event name, or safe broker-reap algorithm in the record.
- No existing two-broker regression test.

