# Brief — E2E cluster probe: print the hostname and stop

**Task id:** d843bf5e-9455-42fe-9ada-193512c54110 · **Workflow:** spec-to-deploy (8 steps:
context/gather → spec → review-spec → implement → run-tests → commit-push → document → deploy)
· **Step:** 1 of 8 (Gather the record) · **Date:** 2026-08-24

## The problem, in this repo's own terms

This is **not a feature request** — it is a smoke/acceptance probe for the multi-node cezar
cluster's dispatch path, which shipped very recently on this same branch lineage:
`b446be29` (feat: multi-node cezar cluster — dispatch activation and the acceptsDispatch
writer), `6e9fd0f2`/`1c2c2d1a` (hub self-confirms its own local autostart claims under
`CEZ_CLUSTER=1`), `96668b03`/`715e3ee8` (a spoke can join an auth-enabled hub). The task's own
instructions are explicit and narrow: run `hostname -s` and `uname -a`, print the output, **do
NOT modify, create, or delete any file, do NOT commit, then stop.** The single acceptance
criterion is that the run's output contains the executing machine's hostname.

**This directly conflicts with the shape of the default `spec-to-deploy` workflow**, which
writes a spec, implements code, commits, and deploys (AGENTS.md: "every task on cezar ships
end to end by default"). The task text overrides that default for this run specifically — it
is a deliberate no-file-writes / no-commit probe, most plausibly to prove that a task
dispatched onto (or through) the cluster mechanism actually executes on the target node and
that its output round-trips back to the operator, rather than to ship any product change.

## What the record already decided (with citations)

- **Multi-node cluster spec**: `.ai/specs/2026-08-22-multi-node-cezar-cluster.md` — status Partial,
  implemented 2026-08-23, **not yet verified** per KB `notion-66eb47464d50` ("Added: the
  multi-node cezar cluster is implemented (flag-off), not yet verified") and
  `notion-4f4bfeb71577`. Behind `CEZ_CLUSTER=1`, off by default.
- **Dispatch activation** landed in `b446be29`: "the hub places work, a worker runs it" (commit
  subject on the earlier `acf4e3b8`, same lineage). `6e9fd0f2`/`1c2c2d1a` added hub self-confirm
  for local autostart claims; `96668b03`/`715e3ee8` fixed spoke join against an auth-enabled hub
  — i.e., the auth path for cross-node dispatch was only just closed out.
- **Doctrine directly relevant to how this probe must be graded**: KB `specs-846bf82b4c91`,
  "The deploy E2E probe must not report PASS on what it never observed" — vacuous assertions
  must not be reported as PASS; a probe's job is to show what it actually measured, not assert
  success. The same principle applies here: later steps must show the *actual* command output
  (hostname / uname) captured from a real execution, not claim success without it.
- **Node/scale doctrine**: KB `specs-d4f96afa9ac2` ("Eight tasks at once: bound the burst, then
  spread across nodes") — Partial, implemented 2026-08-23, not yet verified. Establishes that
  cross-node scheduling is a live, actively-being-hardened area, consistent with this task being
  a targeted verification probe rather than new work.
- No prior brief, spec, or todo matches "print hostname and stop" or an equivalent bare
  dispatch-probe task — searched `cez kb search` for "cluster dispatch probe", "cluster e2e",
  and "print hostname stop no file changes probe task" (this session); nothing on point beyond
  the general cluster/deploy-probe doctrine cited above.

## Code actually involved

None, by task design. No source file needs to change. The only "artifact" the task wants is the
printed output of two shell commands, captured in whichever step actually executes on the
target node.

## Duplicate / in-flight work check

- `cezar todo list` → **no todos filed** (empty backlog right now).
- `git status` → clean, nothing in flight in this worktree.
- No other spec or brief references this exact probe.

## Facts gathered this step that satisfy the acceptance criterion already

Executed directly in this worktree (this session, this step):

```
$ hostname -s
prod-host

$ uname -a
Linux prod-host 7.0.0-29-generic #29-Ubuntu SMP PREEMPT_DYNAMIC Fri Jul 17 20:52:35 UTC 2026 x86_64 GNU/Linux
```

This machine is `prod-host`. Whichever node actually ends up running the later steps of
*this specific task* should reprint these commands itself (per the vacuous-pass doctrine above)
rather than reuse this brief's numbers — the point of an E2E cluster probe is to prove where the
work executed, not merely that the string exists somewhere in the record.

## What downstream steps must NOT do

- **Do not write a design/architecture spec.** There is no design decision here — the task is a
  literal two-command probe. A "spec" step for this task should be a one-line acknowledgment
  that no spec is needed, not an invented architecture document.
- **Do not create, modify, or delete any file** other than this brief and whatever this task's
  own workflow scaffolding (handoff file) requires. The task text says so explicitly.
- **Do not commit.** `commit-push` (if reached) must recognize there is nothing to commit and
  end green with "nothing to commit" rather than manufacturing a diff to satisfy a postcondition
  that expects one.
- **Do not deploy.** No code changed; there is nothing to ship.

## Open questions the next step must settle

1. Does `spec-to-deploy`'s `commit-push` postcondition (`packages/cezar/src/workflows/postconditions.ts`,
   per AGENTS.md) tolerate a no-op run with nothing staged, or does it require *something*
   committed to go green? If the postcondition hard-requires a commit, that is a mismatch
   between this task's explicit "do NOT commit" instruction and the workflow's default gate —
   worth flagging rather than silently forcing a commit to pass the gate.
2. Whether "print the output" means the output must additionally land in the handoff file /
   task record, or whether reporting it in the step's own transcript (as done above) already
   satisfies "the run output contains the hostname."
3. Whether this probe is meant to validate dispatch *onto a different node* (i.e., the value is
   proving which of possibly several cluster nodes executed it) — if so, a later step should
   re-run `hostname -s` itself rather than trust this brief's captured value, since steps in a
   cluster could in principle be dispatched to different nodes.
