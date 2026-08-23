// One-off closeout script for .ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md, "document"
// step. Not a permanent CLI feature (same throwaway-but-auditable spirit as
// consolidate-sse-probe-todos-2026-08-22.ts and close-rollback-readiness-todo-2026-08-22.ts). Run
// once, from the repo root: node --experimental-strip-types
//   .ai/scripts/note-deploy-e2e-probe-p1p2-shipped-2026-08-23.ts
//
// Writes go exclusively through updateTodo() (lease-protected via withTodosLease), never a direct
// read/write of todos.json, so a concurrent `cezar serve` (or another task) reading or writing
// this project's todos.json cannot lose a write to this script or vice versa.
//
// Targets the MAIN checkout's .ai/cezar, not this worktree's own (same reasoning as the rollback
// closeout script: a worktree's own todos.json is a different, task-scoped file).
//
// This does NOT mark the todo done: acceptance criteria 3, 5 and 6 (a real credentialed run
// against a live cutover, and the parent spec's own Verification/Status edits once that run's
// result is known) are still open — only criteria 1 and 2 are met by what shipped in this task.

import { readTodos, updateTodo, type TodoItem } from '../../packages/cezar/src/todos.ts';

const dataDir = '/var/lib/cezar/loki-labs/cezar/.ai/cezar';

const ID = '8dc8bf3a-4484-468c-a6fd-c1afcbc630d3';
const TODAY = '2026-08-23';
const MARKER = `PROGRESS ${TODAY}`;

function alreadyNoted(item: TodoItem): boolean {
  return (item.context ?? '').includes(MARKER);
}

async function main() {
  const items = await readTodos(dataDir);
  const matches = items.filter((t) => t.id === ID);
  if (matches.length !== 1) {
    throw new Error(`Preflight failed: expected exactly one entry with id ${ID}, found ${matches.length}. Aborting — nothing written.`);
  }
  const item = matches[0];
  if (item.status !== 'todo') {
    throw new Error(`Preflight failed: ${ID}'s status is "${item.status}", expected "todo". Aborting — nothing written.`);
  }
  if (alreadyNoted(item)) {
    console.log('Already noted — nothing to do.');
    return;
  }

  const note = `\n\n${MARKER} — criteria 1 and 2 shipped in code (commit \`83ddbdd2\`, pushed to \`origin/main\`), per .ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md (status: Implemented — P1+P2+P3-doc; QA Needed on the live run). Criterion 1 ("cannot report PASS with a zero sample"): assertions are now a PASS/FAIL/NOT_MEASURED tri-state gated on pollObserved/sseObserved/runObserved, and \`passed\` is false on any non-PASS. Criterion 2 ("a 401 on /events fails the probe loudly"): subscribe()/sampleRun() stop retrying past the first 401/403, a new \`report.auth\` field and two \`auth:\` assertions record it, and a FAIL prints a remediation line naming --header. Gates green: npm run typecheck (0 errors), npm run test:unit (53/53 incl. 9 new cases in packages/cezar/test/unit/deploy-e2e-probe.test.ts), npm test (516/518, 2 pre-existing unrelated flakes). Still open on this todo: criterion 3 (a real credentialed run measuring non-zero SSE seq continuity across an actual cutover — P3's live-run half, deferred to this task's deploy step and not yet executed), and criteria 5/6 (the parent spec's Verification section and Status line edits, which this spec's own Verification explicitly defers until that live run's real result is known — editing them now would be guessing at an unmeasured result, which is the exact failure mode this whole fix exists to stop).`;

  const result = await updateTodo(dataDir, ID, {
    context: (item.context ?? '') + note,
  });
  if (!result) {
    throw new Error(`updateTodo(${ID}) returned undefined — the write silently no-op'd. Aborting.`);
  }
  console.log(`OK noted ${ID} -> status=${result.status} contextLen=${(result.context ?? '').length}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
