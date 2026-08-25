// One-off closeout script for .ai/specs/2026-08-25-workspace-revision-attestation.md, whose
// spec text (see .ai/specs/2026-08-25-ship-workspace-revision-attestation.md, ~line 292) says
// this todo is moot rather than fixed: origin/main commit 7932cf4d deleted
// packages/cezar/test/unit/deploy-e2e-probe.test.ts outright, so the failing suite it tracked
// no longer exists to fix. Run once, from the repo root:
//   node --experimental-strip-types .ai/scripts/close-deploy-e2e-probe-todo-2026-08-25.ts
//
// Writes go exclusively through updateTodo() (lease-protected via withTodosLease), never a
// direct read/write of todos.json, so a concurrently running `cezar serve` cannot lose this
// write or vice versa.

import { readTodos, updateTodo, type TodoItem } from '../../packages/cezar/src/todos.ts';

const dataDir = '/var/lib/cezar/loki-labs/cezar/.ai/cezar';

const ID = '1d8922bb-339e-49d1-b8ee-359a1dfd1db7';
const TODAY = '2026-08-25';
const MARKER = `MOOT ${TODAY}`;

function alreadyClosed(item: TodoItem): boolean {
  return item.status === 'done' && (item.context ?? '').includes(MARKER);
}

async function main() {
  const items = await readTodos(dataDir);
  const matches = items.filter((t) => t.id === ID);
  if (matches.length !== 1) {
    throw new Error(`Preflight failed: expected exactly one entry with id ${ID}, found ${matches.length}. Aborting — nothing written.`);
  }
  const item = matches[0];
  if (item.summary !== 'Fix broken test:unit suite: deploy-e2e-probe.test.ts (8/9 failing)') {
    throw new Error(`Preflight failed: ${ID}'s summary does not match the expected text ("${item.summary}"). Aborting — nothing written.`);
  }
  if (alreadyClosed(item)) {
    console.log('Already closed — nothing to do.');
    return;
  }

  const note = `\n\n${MARKER} — origin/main commit \`7932cf4d\` ("feat: bulk start filed tasks") deleted \`packages/cezar/test/unit/deploy-e2e-probe.test.ts\` outright; \`git ls-tree origin/main -- packages/cezar/test/unit/deploy-e2e-probe.test.ts\` returns nothing. The failing suite this todo tracked no longer exists, so there is nothing left to fix. Closed as moot, not as fixed. Recorded in \`.ai/specs/2026-08-25-workspace-revision-attestation.md\`'s status correction and \`.ai/specs/2026-08-25-ship-workspace-revision-attestation.md\` line ~85/292.`;

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
