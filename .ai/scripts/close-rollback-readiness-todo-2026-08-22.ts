// One-off closeout script for .ai/specs/2026-08-22-rollback-readiness-gate.md, §7 "Record".
// Not a permanent CLI feature (same throwaway-but-auditable spirit as .ai/scripts/e2e.sh and
// consolidate-sse-probe-todos-2026-08-22.ts). Run once, from the repo root: node
//   --experimental-strip-types .ai/scripts/close-rollback-readiness-todo-2026-08-22.ts
//
// Writes go exclusively through updateTodo() (lease-protected via withTodosLease), never a
// direct read/write of todos.json, so a concurrent `cezar serve` (or another task) reading or
// writing this project's todos.json cannot lose a write to this script or vice versa.
//
// Targets the MAIN checkout's .ai/cezar, not this worktree's own — a git worktree resolves its
// own todos.json by git toplevel, which is a different, task-scoped file that never held this
// todo in the first place (confirmed: `cezar todo list --json` from inside the worktree returns
// only a todo filed from within this worktree during its own run-tests step).

import { readTodos, updateTodo, type TodoItem } from '../../packages/cezar/src/todos.ts';

const dataDir = '/var/lib/cezar/loki-labs/cezar/.ai/cezar';

const ID = '6497f002-c53c-4d2a-8a8a-9b1135a0b88f';
const TODAY = '2026-08-22';
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
  if (item.summary !== 'A rollback never probes readiness, so it reports success onto a dead release') {
    throw new Error(`Preflight failed: ${ID}'s summary does not match the expected text ("${item.summary}"). Aborting — nothing written.`);
  }
  if (alreadyDone(item)) {
    console.log('Already closed — nothing to do.');
    return;
  }

  const note = `\n\n${MARKER} — both acceptance criteria met in code (commit \`2f91de4b\`, merged to \`origin/main\` at \`c31af208\`): \`runRollback\` now probes \`/api/v1/ready\` after the restart and returns \`ok:false\` with a distinct \`Rollback FAILED\` report when it does not come up. Full design and gate results in \`.ai/specs/2026-08-22-rollback-readiness-gate.md\` (status IMPLEMENTED, QA Needed — that spec's own Verification §5/§6 runtime E2E on \`prod-host\` has not run yet, so this is marked done on the code fix, not on a live-box confirmation). Sibling flag trap \`f97ddd39\` (bare \`--rollback\` dies in argv parsing) is a separate defect and stays open.`;

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
