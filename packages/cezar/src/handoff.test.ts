import { describe, expect, it } from 'vitest';

import { createTodoInputSchema } from '@loki-labs/better-cezar-contract';
import { HANDOFF_INSTRUCTIONS } from './handoff.ts';
import { todoSchema } from './todos.ts';

/**
 * HANDOFF_INSTRUCTIONS is the only thing that tells an agent what to append to todos.json,
 * so a field can be added to todoSchema and still never be written by anyone. `runnable`
 * shipped exactly that way. This pins the contract instead of the prose: every agent-writable
 * schema field has to appear in the instructions.
 *
 * **AMENDED 2026-08-15** (`.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`, D2). The
 * schema used to have exactly two kinds of field — server-assigned and agent-written — so one
 * exemption list was enough. It now has a third: the structured spec fields written by an API
 * CLIENT rather than by an agent's append. They are not agent-written, so demanding they appear
 * in the agent's prompt would be demanding prose for a writer that does not exist; and they are
 * not server-assigned either, so calling them that would be false.
 *
 * An exemption list is exactly how a gate goes quiet, so the third set carries its own floor
 * below: every exempted field must actually be writable through a real API. A field that is in
 * neither the prompt nor that API is the `runnable` failure again, and still fails.
 *
 * **AMENDED 2026-08-16** (`.ai/specs/2026-08-15-cross-project-workspace-run.md`). The floor used
 * to read `server/task-fanout-routes.ts` and string-match each field name in its source. That
 * route is deleted with the fan-out — the composer starts one cross-project run and files no
 * todos at all — so the check had to move rather than be dropped: the HAZARD it guards (a
 * `todoSchema` field no writer anywhere produces, which is exactly how `runnable` shipped) is
 * untouched by the redesign. It now asserts against `createTodoInputSchema`, the wire twin behind
 * `POST /todos`, which is the writer that survived. Structurally stronger than what it replaced,
 * too: a field name appearing anywhere in a source file — a comment, an unrelated identifier —
 * used to satisfy the old check, where a schema key cannot be faked.
 */
describe('HANDOFF_INSTRUCTIONS', () => {
  /** The server assigns these on read/start — an agent never writes them. */
  const SERVER_MANAGED = new Set(['id', 'startedTaskId']);

  /**
   * Written through `POST /todos` by an API client, never by an agent's append (D2/D4).
   * Documenting them in FOLLOWUP_INSTRUCTIONS is a live option — an agent could file a
   * fully-specified follow-up the same way a client does — but it is a deliberate NON-decision
   * today: five optional fields would lengthen a system prompt appended to every agent step, for
   * a writer we have not asked for it. If that changes, move the field out of this set rather
   * than widening the set.
   */
  const CLIENT_WRITTEN = new Set([
    'context',
    'whatToDo',
    'acceptanceCriteria',
    'knowledgeRefs',
    'origin',
  ]);

  it('documents every agent-writable field of todoSchema', () => {
    const undocumented = Object.keys(todoSchema.shape)
      .filter((field) => !SERVER_MANAGED.has(field) && !CLIENT_WRITTEN.has(field))
      .filter((field) => !HANDOFF_INSTRUCTIONS.includes(`"${field}"`));

    expect(undocumented).toEqual([]);
  });

  /**
   * The floor under the exemption above. Without it, "client-written" becomes the place a field
   * goes to be forgotten: nothing would notice a field that no writer anywhere produces, which is
   * the exact defect this file exists to catch.
   */
  it('every client-written field is actually accepted by POST /todos', () => {
    const accepted = new Set(Object.keys(createTodoInputSchema.shape));
    const unwritable = [...CLIENT_WRITTEN].filter((field) => !accepted.has(field));
    expect(unwritable).toEqual([]);
    // And the set is not empty — an emptied set would make the filter above a no-op and this
    // assertion vacuously true at the same time.
    expect(CLIENT_WRITTEN.size).toBeGreaterThan(0);
  });

  it('tells the agent which way to set runnable, so notes are acknowledged and not run', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": false');
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": true');
    expect(HANDOFF_INSTRUCTIONS).toContain('Acknowledge');
  });
});
