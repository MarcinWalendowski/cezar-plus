import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
 * exemption list was enough. It now has a third: the structured spec fields the COMPOSER's
 * fan-out writes (`server/task-fanout-routes.ts`). They are not agent-written, so demanding they
 * appear in the agent's prompt would be demanding prose for a writer that does not exist; and
 * they are not server-assigned either, so calling them that would be false.
 *
 * An exemption list is exactly how a gate goes quiet, so the third set carries its own floor
 * below: every field exempted as composer-written must actually be written by the composer path.
 * A field that is in neither prompt nor route is the `runnable` failure again, and still fails.
 */
describe('HANDOFF_INSTRUCTIONS', () => {
  /** The server assigns these on read/start — an agent never writes them. */
  const SERVER_MANAGED = new Set(['id', 'startedTaskId']);

  /**
   * Written by the composer's fan-out, never by an agent's append (D2/D4). Documenting them in
   * FOLLOWUP_INSTRUCTIONS is a live option — an agent could file a fully-specified follow-up the
   * same way the composer does — but it is a deliberate NON-decision today: five optional fields
   * would lengthen a system prompt appended to every agent step, for a writer we have not asked
   * for it. If that changes, move the field out of this set rather than widening the set.
   */
  const COMPOSER_WRITTEN = new Set([
    'context',
    'whatToDo',
    'acceptanceCriteria',
    'knowledgeRefs',
    'origin',
  ]);

  it('documents every agent-writable field of todoSchema', () => {
    const undocumented = Object.keys(todoSchema.shape)
      .filter((field) => !SERVER_MANAGED.has(field) && !COMPOSER_WRITTEN.has(field))
      .filter((field) => !HANDOFF_INSTRUCTIONS.includes(`"${field}"`));

    expect(undocumented).toEqual([]);
  });

  /**
   * The floor under the exemption above. Without it, "composer-written" becomes the place a field
   * goes to be forgotten: nothing would notice a field that no writer anywhere produces, which is
   * the exact defect this file exists to catch.
   */
  it('every composer-written field is actually written by the composer path', () => {
    const route = readFileSync(join(import.meta.dirname, 'server/task-fanout-routes.ts'), 'utf8');
    const unwritten = [...COMPOSER_WRITTEN].filter((field) => !route.includes(field));
    expect(unwritten).toEqual([]);
    // And the set is not empty — an emptied set would make the filter above a no-op and this
    // assertion vacuously true at the same time.
    expect(COMPOSER_WRITTEN.size).toBeGreaterThan(0);
  });

  it('tells the agent which way to set runnable, so notes are acknowledged and not run', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": false');
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": true');
    expect(HANDOFF_INSTRUCTIONS).toContain('Acknowledge');
  });
});
