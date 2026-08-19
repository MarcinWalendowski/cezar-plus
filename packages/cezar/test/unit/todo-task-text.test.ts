import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { todoTaskText } from '../../src/todos.js';

/**
 * The contract for the ONE task-text builder: `POST /api/todos/:id/start` turns a filed entry
 * into `run.task` through `todoTaskText`, and these cases are what that is allowed to produce.
 *
 * **Corrected 2026-08-19** (`.ai/specs/2026-08-19-tasks-page-and-start-grounding.md`). This used
 * to describe a CROSS-PROCESS drift guard (#374): the cockpit was said to rebuild the same text
 * in `web/app/src/routes/inbox.tsx` to prefill `/new`, with `inbox.test.tsx` asserting the same
 * fixture from the other side, so "the drift always surfaces". That copy no longer exists —
 * `inbox.tsx` and the Filed table's Start button both POST to `/todos/:id/start` and build no
 * task text at all — so the second half of that guard has been asserting nothing. Nothing broke;
 * a claim in a comment simply outlived the thing it described.
 *
 * The first seven cases are the pre-2026-08-19 output and must stay byte-identical: they are the
 * proof that widening the builder to carry the whole filed spec (D2) did not move the legacy path.
 */
interface Fixture {
  cases: Array<{ name: string; todo: Parameters<typeof todoTaskText>[0]; expected: string }>;
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/todo-task-text.json', import.meta.url)), 'utf8'),
) as Fixture;

test('the shared fixture is the whole contract, not a token case', () => {
  assert.ok(fixture.cases.length >= 14);
});

for (const { name, todo, expected } of fixture.cases) {
  test(`todoTaskText: ${name}`, () => {
    assert.equal(todoTaskText(todo), expected);
  });
}
