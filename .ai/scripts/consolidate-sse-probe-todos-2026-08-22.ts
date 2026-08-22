// One-off consolidation script for
// .ai/specs/2026-08-22-consolidate-duplicate-sse-probe-and-broker-restart-todos.md, Phase 2.
// Not a permanent CLI feature (same throwaway-but-auditable spirit as .ai/scripts/e2e.sh).
// Run once, from the repo root: node --experimental-strip-types
//   .ai/scripts/consolidate-sse-probe-todos-2026-08-22.ts
//
// Writes go exclusively through updateTodo() (lease-protected via withTodosLease), never a
// direct read/write of todos.json, so a concurrent `cezar serve` (or another task) reading or
// writing this project's todos.json cannot lose a write to this script or vice versa.

import { readTodos, updateTodo, type TodoItem } from '../../packages/cezar/src/todos.ts';

const dataDir = '/var/lib/cezar/loki-labs/cezar/.ai/cezar';

const SPEC_PATH =
  '.ai/specs/2026-08-22-consolidate-duplicate-sse-probe-and-broker-restart-todos.md';
const TODAY = '2026-08-22';
const MARKER = `CLOSED ${TODAY}`;
const CONSOLIDATED_MARKER = `CONSOLIDATED ${TODAY}`;

const IDS = {
  '06a170b8': '06a170b8-5118-46ec-81b9-97c9794f41e5',
  '6f4a9f62': '6f4a9f62-956b-4bf5-b849-df41d83dfd94',
  e36b79c0: 'e36b79c0-d848-4a6b-8263-a5b25b9d601c',
  '58e5954c': '58e5954c-5e51-443e-a2c9-fa875dabb0c1',
  '8dc8bf3a': '8dc8bf3a-4484-468c-a6fd-c1afcbc630d3',
  '45813876': '45813876-8a6b-49d4-ae2c-dfb502e83263',
  '7f92bd31': '7f92bd31-cbfc-4ab0-99fd-0c70a061d5e4',
  ae96d775: 'ae96d775-bdfe-4fd7-8c9a-749cc86b16c2',
} as const;

// 6c89af7c is read-only, for a final byte-identical sanity check — never written by this script.
const READ_ONLY_ID = '6c89af7c-f5d3-41dd-8c8b-85ee672d3181';

function alreadyDone(item: TodoItem): boolean {
  const ctx = item.context ?? '';
  return ctx.includes(MARKER) || ctx.includes(CONSOLIDATED_MARKER);
}

function requireOne(items: TodoItem[], id: string): TodoItem {
  const matches = items.filter((t) => t.id === id);
  if (matches.length !== 1) {
    throw new Error(
      `Preflight failed: expected exactly one entry with id ${id}, found ${matches.length}. Aborting — nothing written.`,
    );
  }
  const item = matches[0];
  // An id already archived by THIS script's own prior (possibly partial) run is expected and
  // fine — alreadyDone()/apply()'s own per-id skip below handles it. Only an unexpected
  // archival (someone else touched this id, with no CLOSED/CONSOLIDATED marker of ours) is a
  // preflight failure worth aborting for.
  if (item.archivedAt && !alreadyDone(item)) {
    throw new Error(
      `Preflight failed: ${id} is already archived (archivedAt=${item.archivedAt}) but carries no CLOSED/CONSOLIDATED marker of this script's own — on-disk state has moved unexpectedly. Aborting — nothing written.`,
    );
  }
  return item;
}

async function apply(id: string, patch: Parameters<typeof updateTodo>[2], label: string) {
  const result = await updateTodo(dataDir, id, patch);
  if (!result) {
    throw new Error(
      `updateTodo(${id}) [${label}] returned undefined — the write silently no-op'd (wrong id, or a lease failure swallowed upstream). Aborting.`,
    );
  }
  console.log(`OK  ${label} (${id}) -> archivedAt=${result.archivedAt ?? '(none)'} contextLen=${(result.context ?? '').length} acLen=${(result.acceptanceCriteria ?? []).length}`);
}

async function main() {
  const preflightItems = await readTodos(dataDir);
  const all = Object.values(IDS).map((id) => requireOne(preflightItems, id));
  requireOne(preflightItems, READ_ONLY_ID); // 6c89af7c must exist too, though never written.

  const byShort = Object.fromEntries(
    Object.entries(IDS).map(([short, id]) => [short, all.find((t) => t.id === id)!]),
  );

  if (all.every(alreadyDone)) {
    console.log('All in-scope entries already carry a CLOSED/CONSOLIDATED marker — nothing to do.');
    return;
  }

  // ---- Cluster A: 8dc8bf3a survives, the other four archive pointing at it ----------------

  const survivorA = byShort['8dc8bf3a'];
  if (!alreadyDone(survivorA)) {
    const CONSOLIDATION_NOTE_A = `\n\n${CONSOLIDATED_MARKER} — independently filed 5x within a 3-minute window (06a170b8 19:03:38, 6f4a9f62 19:04:14, e36b79c0 19:04:35, 58e5954c 19:04:37, this one 19:06:44 UTC, 2026-08-21), all describing the same defect: deploy-e2e-probe.mjs's SSE assertions pass vacuously over zero observations because /api/v1/runs/\${RUN_ID}/events returns 401 on this auth-gated box and the probe sends no credential. The other four are archived, pointing here. Two of their criteria are folded in verbatim below (folded acceptance criteria list). 6f4a9f62's other distinguishing note — "1 connect error in 1185 requests" — is NOT folded here: open todo 6c89af7c already owns that exact finding with a larger sample (3 in 4864 over 5 restarts) and its own acceptance criterion for it; folding it here too would recreate the duplicate this consolidation exists to remove. This todo's own fourth criterion (maxLatencyMs) is the same underlying measurement 6c89af7c's second criterion already asks for. See ${SPEC_PATH}.`;
    await apply(
      IDS['8dc8bf3a'],
      {
        context: (survivorA.context ?? '') + CONSOLIDATION_NOTE_A,
        acceptanceCriteria: [
          ...(survivorA.acceptanceCriteria ?? []),
          "The parent spec's Verification section states which half of criterion 2 each artifact actually proves (originally e36b79c0)",
          "The parent spec's Status line drops the 'SSE continuity remains unmeasured' qualifier once the SSE assertion actually runs green (originally 6f4a9f62, its fourth acceptance criterion)",
        ],
      },
      'cluster A survivor 8dc8bf3a',
    );
  } else {
    console.log('SKIP cluster A survivor 8dc8bf3a — already consolidated.');
  }

  for (const short of ['06a170b8', '6f4a9f62', 'e36b79c0', '58e5954c'] as const) {
    const item = byShort[short];
    if (alreadyDone(item)) {
      console.log(`SKIP ${short} — already closed.`);
      continue;
    }
    const note = `\n\n${MARKER} — duplicate of a defect independently filed 5x within a 3-minute window; consolidated into 8dc8bf3a, which carries this entry's distinguishing content forward (except the connect-error note, which 6c89af7c already owns with a larger sample — see there). See ${SPEC_PATH}.`;
    await apply(
      IDS[short],
      { archived: true, context: (item.context ?? '') + note },
      `cluster A duplicate ${short}`,
    );
  }

  // ---- Cluster B: 45813876 survives, 7f92bd31 archives pointing at it --------------------

  const survivorB = byShort['45813876'];
  if (!alreadyDone(survivorB)) {
    const sub = byShort['7f92bd31'];
    const CONSOLIDATION_NOTE_B = `\n\n${CONSOLIDATED_MARKER} — same defect as 7f92bd31, which is archived pointing here. Judgment: 7f92bd31 is the root-cause diagnosis of this todo's own suspect 3 ("the broker is killed as part of the deploy's restart because it is in the service cgroup... runBrokerIsolation reports 'delegated', not 'scope'"); suspects 1 and 2 were ruled out by an independent, contemporaneous investigation reading spoolDirOf()/spoolDirFor() (workflows/run.ts:1731, core/run-spool.ts:128 — neither is release-path-sensitive). The fix already landed the same day: probeUserScope() (core/broker-isolation.ts) now derives /run/user/<uid> when XDG_RUNTIME_DIR is absent, and the broker spawn merges userScopeEnv() into the child's env in scope mode — commits fde2dae8, cf334d89. Residual tension, recorded rather than resolved: the blue-green cutover this todo measured only calls "systemctl restart" (deploy-strategy.ts, release-deploy.ts:170-173 — no "systemctl stop" anywhere in either file), which per 7f92bd31's own mechanism (KillMode=process protects MainPID on a restart, not on a stop) should have survived — the opposite of what was measured. This does not change the same-defect judgment (both todos' root-cause investigations name the identical code mechanism and the identical fix commits) but is carried forward explicitly rather than dropped. Re-verifying the fix across a real, non-self-referential blue-green cutover remains open work on this todo (see 7f92bd31's own acceptance criteria, folded in below). See ${SPEC_PATH}.`;
    await apply(
      IDS['45813876'],
      {
        context: (survivorB.context ?? '') + CONSOLIDATION_NOTE_B,
        acceptanceCriteria: [...(survivorB.acceptanceCriteria ?? []), ...(sub.acceptanceCriteria ?? [])],
      },
      'cluster B survivor 45813876',
    );
  } else {
    console.log('SKIP cluster B survivor 45813876 — already consolidated.');
  }

  {
    const item = byShort['7f92bd31'];
    if (alreadyDone(item)) {
      console.log('SKIP 7f92bd31 — already closed.');
    } else {
      const note = `\n\n${MARKER} — same defect as 45813876 (broker isolation delegated-vs-scope misclassification in core/broker-isolation.ts); this entry's root-cause diagnosis and acceptance criteria were merged into 45813876, the id the parent spec (.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md) already cites by name. See ${SPEC_PATH}.`;
      await apply(
        IDS['7f92bd31'],
        { archived: true, context: (item.context ?? '') + note },
        'cluster B duplicate 7f92bd31',
      );
    }
  }

  // ---- Cluster C: this task's own tracking todo -------------------------------------------

  {
    const item = byShort['ae96d775'];
    if (alreadyDone(item)) {
      console.log('SKIP ae96d775 — already closed.');
    } else {
      const note = `\n\n${MARKER} — this task's own tracking todo; both acceptance criteria satisfied by this consolidation. Cluster A survivor: 8dc8bf3a. Cluster B survivor: 45813876. See ${SPEC_PATH}.`;
      await apply(
        IDS['ae96d775'],
        { archived: true, context: (item.context ?? '') + note },
        "cluster C this task's own tracking todo ae96d775",
      );
    }
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
