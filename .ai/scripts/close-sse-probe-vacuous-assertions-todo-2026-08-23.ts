// One-off closeout script for .ai/specs/2026-08-22-deploy-e2e-probe-measured-assertions.md.
// Not a permanent CLI feature (same throwaway-but-auditable spirit as close-rollback-readiness-todo-2026-08-22.ts
// and consolidate-sse-probe-todos-2026-08-22.ts). Run once, from the repo root: node
//   --experimental-strip-types .ai/scripts/close-sse-probe-vacuous-assertions-todo-2026-08-23.ts
//
// Writes go exclusively through updateTodo() (lease-protected via withTodosLease), never a
// direct read/write of todos.json, so a concurrent `cezar serve` (or another task) reading or
// writing this project's todos.json cannot lose a write to this script or vice versa.
//
// Targets the MAIN checkout's .ai/cezar, not this worktree's own — see the rollback-readiness
// script's note on why (a git worktree resolves a different, task-scoped todos.json).

import { readTodos, updateTodo, type TodoItem } from '../../packages/cezar/src/todos.ts';

const dataDir = '/var/lib/cezar/loki-labs/cezar/.ai/cezar';

const ID = '8dc8bf3a-4484-468c-a6fd-c1afcbc630d3';
const TODAY = '2026-08-23';
const MARKER = `DONE ${TODAY}`;

function alreadyDone(item: TodoItem): boolean {
  return item.status === 'done' && (item.context ?? '').includes(MARKER);
}

async function main() {
  const items = await readTodos(dataDir);
  const matches = items.filter((t) => t.id === ID);
  if (matches.length !== 1) {
    throw new Error(`Preflight failed: expected exactly one entry with id ${ID}, found ${matches.length}. Aborting — nothing written.`);
  }
  const item = matches[0];
  if (item.summary !== 'deploy-e2e-probe reports PASS on zero observations — vacuous assertions hide an unmeasured criterion') {
    throw new Error(`Preflight failed: ${ID}'s summary does not match the expected text ("${item.summary}"). Aborting — nothing written.`);
  }
  if (alreadyDone(item)) {
    console.log('Already closed — nothing to do.');
    return;
  }

  const note = `\n\n${MARKER} — all four acceptance criteria met, on real data (commit \`fe158c70\`, spec \`.ai/specs/2026-08-22-deploy-e2e-probe-measured-assertions.md\`, task \`3ee1ebf0-0d78-4cda-b50d-af6dff78910b\`). (1) Every assertion now carries a sample count and reports passed/failed/not-measured — never a vacuous PASS. (2) A 401 on /api/v1/events is loud (stderr AUTH REQUIRED, once) and short-circuits that stream to not-measured instead of retrying silently. (3) A credentialed Phase 5 run crossed a real cezar server-deploy --strategy=blue-green cutover on prod-host (release 20260823T194110Z-9c65f9e9, artifact .ai/cezar/artifacts/deploy-e2e-20260823194023.json): sse.events=2164, sse.reconnects=1, run.sampleCount=55 — SSE continuity measured for the first time. (4) maxLatencyMs is populated (aliases the existing gapMs number, e.g. 1127ms in an earlier run) — the client-visible latency was never actually null, just unnamed.

Closing on the fix working, NOT on a clean pass: the credentialed run's overall verdict is FAILED — 'b: zero refused connections' failed (1 refusal in 544, matching the already-known ~1.1s boot-window cost in the parent spec's Criterion 2), and 'c: no seq gaps' failed (94 gaps in 2164 events). The seq-gap finding is new and its cause is NOT yet established — two same-session runs with zero reconnects showed a comparable raw gap rate (73/2116, 82/2147), so it's unresolved whether this is real event loss during cutover or a pre-existing seq-allocation artifact. Filed as a new, distinct follow-up: todo \`8206c158-508c-46e5-ac01-3bd70915072d\`. This todo's 6th acceptance criterion ("parent spec's Status line drops the 'SSE continuity remains unmeasured' qualifier once the SSE assertion actually runs green") is met in spirit, not literally — the line is corrected because the assertion now runs and means something, not because it turned green. Sibling defect \`6c89af7c\` (keep-alive reset / cutover latency) is unaffected and stays open, as does \`f97ddd39\` (bare --rollback argv trap, already tracked separately).`;

  const result = await updateTodo(dataDir, ID, {
    status: 'done',
    context: (item.context ?? '') + note,
  });
  if (!result) {
    throw new Error(`updateTodo(${ID}) returned undefined — the write silently no-op'd. Aborting.`);
  }
  console.log(`OK closed ${ID} -> status=${result.status} contextLen=${(result.context ?? '').length}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
