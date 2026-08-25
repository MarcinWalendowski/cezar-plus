# Workspace Revision Attestation

**Status:** **CORRECTED 2026-08-25:** the `npm run test:unit` baseline named below is obsolete —
`origin/main` commit `7932cf4d` deleted `packages/cezar/test/unit/deploy-e2e-probe.test.ts`, so
that suite is expected clean on the reconciled base, and the "four of five" count no longer
applies. This revision is gated on all five repository gates on the reconciled base; the gate
results and the pushed revision are recorded in the shipping run's own report, not here. Original
status line, describing the pre-reconciliation worktree, preserved below unchanged.
~~Implemented and backend runtime verified, 2026-08-25. Four of five repository gates are
green. `npm run test:unit` retains the eight pre-existing `deploy-e2e-probe.test.ts` failures
reproduced on clean `e38cb619` by this run's earlier gate step. This change does not touch that
probe. No deployment was attempted because Cezar's deployment targets are manual.~~
**Repo:** `cezar`
**Task:** `2914e8d5-492e-4754-942e-1680725aff0d`
**Extends:** `.ai/specs/2026-08-20-steps-green-only-when-verified.md` and
`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`.

## TLDR

`tested-revision-shipped` records and checks only the run cwd. That is correct for an ordinary
project run, but a workspace run's cwd is the shared scratch repo and its actual work lives in
`RunRecord.workspaceWorktrees`. Run `2914e8d5` therefore attested four untracked scratch control
files and later rejected the valid Cezar commit when those files were absent from scratch `HEAD`.
Workspace runs must attest every granted git worktree and verify each project against its own tree.
Ordinary run behavior and the published single-tree attestation fields remain supported.

## Problem

The incident is fully reproduced by the persisted record:

- the run is a workspace run with ten isolated project worktrees;
- `recordTestAttestation` calls `git add -A` and `git write-tree` only at `state.cwd`, which is
  `/var/lib/cezar/workspace` for this run;
- the scratch repo held `.cezar-control-path`, `.cezar-gate-path`,
  `cezar-control-171c8647.log`, and `cezar-gates-171c8647.log` as untracked runner bookkeeping;
- `commit-push` changed the Cezar project worktree at `ea40c7a1`, not scratch `HEAD` at `43fb22c`;
- the post-condition compared the scratch attested tree with scratch `HEAD` and reported those four
  paths as if they were feature source.

Ignoring those four names would treat one symptom and leave the guard pointed at the wrong repos.
Returning green for every workspace run would remove the safety property entirely. The scope must
be fixed at the attestation boundary.

## Solution

Add per-project entries to `TestAttestation`. For a workspace run, capture one entry for every
persisted, unreclaimed `workspaceWorktree` whose worktree path is a git repository. At shipping
verification, compare each attested tree to that worktree's current `HEAD` and aggregate every
failure with the project root. At the shipped-revision boundary, record each worktree's `HEAD`.

Keep `treeSha` and the existing optional `headSha` and `shippedSha` fields. Cezar is published, and
persisted older runs must continue to parse and resume. New workspace attestations add an optional
`projects` array and use the scratch tree only as the legacy top-level value, never as the workspace
verification target when `projects` exists.

## Architecture

### Data flow

1. `run-tests` finishes successfully.
2. `recordTestAttestation` snapshots either the ordinary run cwd or every workspace worktree.
3. The record persists the legacy top-level tree plus optional project entries.
4. `commit-push` runs `tested-revision-shipped`.
5. The post-condition checks the ordinary cwd for an ordinary attestation, or all project entries
   for a workspace attestation.
6. A source change in any project fails closed and names its project and paths. Record-only changes
   retain the existing allowlist.

### Failure semantics

- No project entries on an older workspace run: retain the legacy check, do not invent a green.
- A persisted project worktree is missing, reclaimed, not a git repo, or cannot resolve its tree:
  fail the attestation or post-condition with that project named.
- One project failure makes the aggregate post-condition red.
- Scratch control files are irrelevant once project entries exist.

### Analytics and observability

The existing `note` event records the count and tree identifiers captured. The existing
`check-output` event records the aggregate verdict. No new event family is needed, but workspace
messages must say `tests attested N project trees` and failures must name the project root.

## Phases

### Phase 1: contract

Add a `TestAttestationProject` schema containing `root`, `worktreePath`, `treeSha`, optional
`headSha`, and optional `shippedSha`. Add optional `projects` to `testAttestationSchema`.

### Phase 2: capture and ship

Refactor tree capture into one helper. For workspace runs, snapshot every active persisted
worktree, persist all project entries, and record all shipped SHAs after `commit-push`.

### Phase 3: verify

Extend the post-condition context with project attestations. Verify all project trees when present,
aggregate errors, and keep the existing ordinary and merge paths unchanged.

### Phase 4: record

Add a changelog entry, mark this spec with executed verification, and propose a durable knowledge
record describing the workspace-scoping invariant.

## Data Models

```ts
interface TestAttestationProject {
  root: string;
  worktreePath: string;
  treeSha: string;
  headSha?: string;
  shippedSha?: string;
}

interface TestAttestation {
  stepId: string;
  treeSha: string;
  headSha?: string;
  shippedSha?: string;
  projects?: TestAttestationProject[];
  at: string;
}
```

The project array is ordered by `root` before persistence so events and tests are deterministic.
No migration or dual-write subsystem is added. The existing top-level fields remain because they
are part of Cezar's released persisted-run contract.

## API Contracts

The run response gains only the optional `testAttestation.projects` array above. Existing clients
that read the top-level fields continue to receive them. No route, request, or command changes.

## Risks

- A workspace with many projects adds two short git operations per project at the two boundaries.
  This is linear in the already bounded granted-project list and has no network fan-out.
- Worktree removal between testing and shipping must be red, not silently omitted.
- Tree objects belong to different repositories and cannot be checked from scratch cwd. Every git
  operation must use the corresponding `worktreePath`.
- Comparing only committed `HEAD` would miss post-test uncommitted source. Capture keeps the scratch
  index technique so staged and unstaged work are included without mutating the real index.

## Verification

1. Contract test: an attestation with `projects` parses and an existing single-tree attestation
   still parses.
2. Runner test: a workspace run with two project worktrees records two trees, does not include an
   untracked scratch control file, and emits the project count.
3. Post-condition test: two unchanged project revisions pass even when scratch has the four incident
   artifact shapes.
4. Negative post-condition test: changing source after testing in either project fails and names
   that project and path.
5. Record-only control: a post-test spec or changelog change in a project remains green.
6. Missing-worktree control: a vanished project path is red and names the project.
7. Focused tests for contract, runner, and postconditions.
8. `npm run typecheck`.
9. Full repository gates from `.ai/agentic.config.json`: `npm run typecheck`, `npm test`,
   `npm run test:unit`, `npm run build`, and `npm run test:package`.
10. Runtime fixture: create a temporary scratch repo with two linked project worktrees, place the
    four incident artifact names only in scratch, invoke the real capture and verification path,
    and retain the command log. Then change source in one worktree and prove the same path turns
    red. This is backend E2E, so no screenshot or video is meaningful.
11. `find /var/lib/cezar -not -user cezar | wc -l` returns `0`.

### Executed 2026-08-25

- Contract and post-condition focus: 2 files, 34 tests passed.
- Runner capture focus: 1 passed, 111 skipped by the test-name filter.
- `npm run typecheck`: passed across contract, client, server, and web.
- `npm test`: 628 files passed, 2 skipped; 11,783 tests passed, 4 skipped.
- `npm run test:unit`: failed 8 of 53 in `deploy-e2e-probe.test.ts`. Representative unchanged
  failure: `expected b: zero failed HTTP requests to be PASS, got [object Object]`. The same eight
  failures were reproduced on clean `e38cb619` before this fix and are tracked by todo `1d8922bb`.
- `npm run build`: passed, including `check:pack` over 1,241 files.
- `npm run test:package`: 25 of 25 passed.
- Runtime fixture: the direct `RunManager` capture test used real git repositories, placed
  `.cezar-control-path` only in scratch, captured the project tree, and proved the artifact absent
  from that tree. The post-condition fixture then passed with all four incident scratch artifact
  names and turned red after committing `source.ts` in the project. No browser screenshot or video
  applies to this backend-only gate.
