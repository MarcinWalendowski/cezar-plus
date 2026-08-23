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
  /** The server assigns these on read/start/archive — an agent never writes them. `archivedAt`
   *  joined this set with the filed-tasks table (2026-08-17-filed-tasks-table-statuses.md):
   *  stamped by `updateTodo`'s `archived: true`, never client- or agent-supplied. */
  const SERVER_MANAGED = new Set([
    'id',
    'startedTaskId',
    'archivedAt',
    // ---- cluster (2026-08-22-multi-node-cezar-cluster.md) ------------------------------------
    // Sync bookkeeping. `pendingSince` is stamped by `todos.ts`'s own writers inside the `O_EXCL`
    // lease that guards the value it marks; `hubSeq` and `tombstone` arrive on the hub's replica
    // push. No agent append and no API client writes any of the three.
    'pendingSince',
    // `pendingFields` is the companion marker: WHICH keys are owed to the hub, unioned in by the
    // same writer inside the same lease. It exists because `pendingSince` is a scalar and a
    // derive-from-records outbox cannot narrow on it, which is how ops came to carry whole records
    // and clobber a second spoke's edit (D4, and the `pendingFields` amendment in Data Models).
    'pendingFields',
    'hubSeq',
    'tombstone',
    // `startedOn` belongs here for a stronger reason than the three above rather than a weaker
    // one: it is the single write D4 exempts from optimistic local application, so it is omitted
    // from `createTodoInputSchema` as well. A client that could supply it could assert a start the
    // hub never granted — in two places at once, which is the double-start the design exists to
    // prevent.
    'startedOn',
  ]);

  /**
   * Written through `POST /todos` or `PATCH /todos/:id` by an API client, never by an agent's
   * append (D2/D4). Documenting them in FOLLOWUP_INSTRUCTIONS is a live option — an agent could
   * file a fully-specified follow-up the same way a client does — but it is a deliberate
   * NON-decision today: seven optional fields would lengthen a system prompt appended to every
   * agent step, for a writer we have not asked for it. If that changes, move the field out of
   * this set rather than widening the set.
   *
   * `status`/`priority` joined this set with the filed-tasks table
   * (2026-08-17-filed-tasks-table-statuses.md): the Filed table's own edits and any future
   * client-created todo set them, never an agent's plain append.
   */
  const CLIENT_WRITTEN = new Set([
    // `placement` (2026-08-22-multi-node-cezar-cluster.md, D12): pinning a todo to a node, or
    // naming labels that narrow the candidates, is a person's decision made from the cockpit. Safe
    // to expose because placement is a REQUEST the scheduler honours, not a claim about what
    // happened — which is exactly what separates it from `startedOn` next door in SERVER_MANAGED,
    // the one write D4 exempts from optimistic application.
    // Set at `POST /todos` only for now: `updateTodoInputSchema` carries status/priority/archived
    // and does not derive this field, so there is no re-pin route yet. That is a gap recorded at
    // the field's own declaration in `contract/src/skills.ts`, not a reason to reclassify it —
    // this set's floor asks whether a client MAY write the field, and it may.
    'placement',
    'context',
    'whatToDo',
    'acceptanceCriteria',
    'knowledgeRefs',
    'origin',
    'status',
    'priority',
    // `autostart` (2026-08-19-file-tasks-from-a-running-task.md, Phase 2): set by `cezar todo add
    // --start` (a CLI client, `todo-cli.ts`), never by an agent's `CEZ_TODOS_FILE` append — the
    // "Filing a task" section documents the COMMAND, not this raw JSON field.
    'autostart',
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
