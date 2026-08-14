import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { NOTE_TO_SPEC_WORKFLOW, type WorkflowDef } from '../workflows/types.ts';
import { NoteApprover, type NoteApproverProject } from './approve.ts';
import { NoteStore } from './store.ts';

/**
 * Approval — the only path from a note to a run (P2.3, spec
 * `.ai/specs/2026-08-14-note-to-spec-pipeline.md`).
 *
 * | Guard | Mutation that must turn it red |
 * |---|---|
 * | Double approve creates ONE run and reports the existing id | take the claim after `startRun` |
 * | A failed start releases the claim | drop the `releaseProposal` in the catch |
 * | One dead project does not stop the others | return early on the first rejection |
 * | The spec run does not implement | give the workflow an implement step |
 */

const PROJECTS: NoteApproverProject[] = [
  { id: 'api', root: '/tmp/none-api', status: 'ok' },
  { id: 'web', root: '/tmp/none-web', status: 'ok' },
  { id: 'gone', root: '/tmp/none-gone', status: 'missing' },
];

describe('NoteApprover', () => {
  let home: string;
  let store: NoteStore;

  const seed = async (): Promise<string> => {
    const note = await store.capture({ body: 'two things', source: 'cockpit' });
    await store.update(note.id, {
      pass: {
        id: 'pass_1',
        startedAt: '2026-08-14T10:00:00.000Z',
        runner: 'claude',
        summary: '',
        proposals: [
          { id: 'p1', projectId: 'api', title: 'Exporter', task: 'Spec the exporter.', rationale: '', issues: [], decision: 'pending' },
          { id: 'p2', projectId: 'web', title: 'Backoff', task: 'Spec the backoff.', rationale: '', issues: [], decision: 'pending' },
          { id: 'p3', projectId: 'gone', title: 'Ghost', task: 'Spec the ghost.', rationale: '', issues: [], decision: 'pending' },
        ],
        unassigned: [],
        fallback: false,
        truncated: false,
        consideredProjects: ['api', 'web', 'gone'],
        boardDigestSize: 0,
      },
    });
    return note.id;
  };

  interface Started {
    projectId: string;
    workflow: string;
    task: string;
  }

  const makeApprover = (options: { fail?: (projectId: string) => boolean } = {}) => {
    const started: Started[] = [];
    let counter = 0;
    const approver = new NoteApprover({
      store,
      listProjects: async () => PROJECTS,
      startRun: async (projectId: string, workflow: WorkflowDef, task: string) => {
        if (options.fail?.(projectId)) throw new Error(`cannot start in ${projectId}`);
        started.push({ projectId, workflow: workflow.name, task });
        return { id: `run_${++counter}` } as RunRecord;
      },
    });
    return { approver, started };
  };

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-approve-'));
    store = new NoteStore({ paths: { notes: join(home, 'notes.json'), log: join(home, 'notes-log.ndjson') } });
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('starts one spec run per approved proposal, in its own project', async () => {
    const noteId = await seed();
    const { approver, started } = makeApprover();

    const result = await approver.approve(noteId, {
      passId: 'pass_1',
      proposals: [{ id: 'p1' }, { id: 'p2' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.created.map((row) => [row.proposalId, row.projectId, row.runId])).toEqual([
      ['p1', 'api', 'run_1'],
      ['p2', 'web', 'run_2'],
    ]);
    // Every run is the INVESTIGATION workflow — approving a note never starts an implementation.
    expect(started.map((row) => row.workflow)).toEqual(['note-to-spec', 'note-to-spec']);
    expect(started[0]?.task).toBe('Spec the exporter.');

    const note = store.get(noteId);
    expect(note?.resultingTasks.map((row) => [row.kind, row.runId])).toEqual([
      ['spec', 'run_1'],
      ['spec', 'run_2'],
    ]);
  });

  /**
   * THE guard: both calls issued before either is awaited, which is what a double-click or two
   * tabs produce. Claiming after `startRun` would let both see an unclaimed proposal and start two
   * agent runs in the same repository from one approval.
   */
  it('creates one run for two concurrent approvals and names the existing one', async () => {
    const noteId = await seed();
    const { approver, started } = makeApprover();

    const [first, second] = await Promise.all([
      approver.approve(noteId, { passId: 'pass_1', proposals: [{ id: 'p1' }] }),
      approver.approve(noteId, { passId: 'pass_1', proposals: [{ id: 'p1' }] }),
    ]);

    expect(started).toHaveLength(1);
    const bodies = [first, second].map((r) => (r.ok ? r.body : undefined));
    const createdCount = bodies.reduce((total, body) => total + (body?.created.length ?? 0), 0);
    const rejectedCount = bodies.reduce((total, body) => total + (body?.rejected.length ?? 0), 0);
    expect([createdCount, rejectedCount]).toEqual([1, 1]);
    // The loser is told WHICH run exists, not merely that it failed — otherwise the only way to
    // find out is to look for it.
    const refusal = bodies.flatMap((body) => body?.rejected ?? [])[0];
    expect(refusal?.status).toBe(409);
    expect(refusal?.error).toMatch(/already started as run|could not be claimed/);
  });

  it('refuses a sequential re-approve too, naming the run that exists', async () => {
    const noteId = await seed();
    const { approver } = makeApprover();
    await approver.approve(noteId, { passId: 'pass_1', proposals: [{ id: 'p1' }] });

    const again = await approver.approve(noteId, { passId: 'pass_1', proposals: [{ id: 'p1' }] });

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.body.rejected[0]?.error).toBe('already started as run run_1');
  });

  it('starts what it can when one project is gone, and reports the rest', async () => {
    const noteId = await seed();
    const { approver, started } = makeApprover();

    const result = await approver.approve(noteId, {
      passId: 'pass_1',
      proposals: [{ id: 'p3' }, { id: 'p1' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Partial success in ONE 200 body. A 4xx here would make "one of two started" unreadable, and
    // re-approving to find out would start the one that worked a second time.
    expect(result.body.created.map((row) => row.proposalId)).toEqual(['p1']);
    expect(result.body.rejected[0]).toMatchObject({ proposalId: 'p3', status: 409 });
    expect(started).toHaveLength(1);
  });

  it('releases the claim when the run cannot start, so the row is retryable', async () => {
    const noteId = await seed();
    const failing = makeApprover({ fail: (projectId) => projectId === 'api' });

    const first = await failing.approver.approve(noteId, { passId: 'pass_1', proposals: [{ id: 'p1' }] });
    expect(first.ok && first.body.rejected).toHaveLength(1);
    // The claim must NOT survive a run that never started — otherwise the proposal is stuck
    // holding a placeholder for a run that does not exist, forever.
    expect(store.get(noteId)?.pass?.proposals[0]?.createdRunId).toBeUndefined();

    const working = makeApprover();
    const retry = await working.approver.approve(noteId, { passId: 'pass_1', proposals: [{ id: 'p1' }] });

    expect(retry.ok && retry.body.created).toHaveLength(1);
  });

  it('refuses the whole body when the pass has been replaced', async () => {
    const noteId = await seed();
    const { approver } = makeApprover();

    const result = await approver.approve(noteId, { passId: 'pass_stale', proposals: [{ id: 'p1' }] });

    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it('honours a per-row retarget from the review screen', async () => {
    const noteId = await seed();
    const { approver, started } = makeApprover();

    await approver.approve(noteId, {
      passId: 'pass_1',
      proposals: [{ id: 'p1', projectId: 'web', task: 'Spec it over here instead.' }],
    });

    expect(started[0]).toMatchObject({ projectId: 'web', task: 'Spec it over here instead.' });
  });

  it('404s an unknown note and an unknown proposal', async () => {
    const noteId = await seed();
    const { approver } = makeApprover();

    expect(await approver.approve('note_nope', { passId: 'pass_1', proposals: [{ id: 'p1' }] })).toMatchObject({
      ok: false,
      status: 404,
    });
    const result = await approver.approve(noteId, { passId: 'pass_1', proposals: [{ id: 'nope' }] });
    expect(result.ok && result.body.rejected[0]?.status).toBe(404);
  });
});

/**
 * The workflow itself. Approving a proposal must produce a spec to read, never a branch of
 * half-built code — a note typed on a phone is not consent to change a repository.
 */
describe('the note-to-spec workflow', () => {
  it('has exactly one step and tells it not to implement', () => {
    expect(NOTE_TO_SPEC_WORKFLOW.steps).toHaveLength(1);
    const prompt = NOTE_TO_SPEC_WORKFLOW.steps[0]?.prompt ?? '';
    expect(prompt).toMatch(/NOT implementing it/);
    expect(prompt).toMatch(/Change NO other file/);
    expect(prompt).toMatch(/no implementation, no migration, no test/);
  });

  it('reads history through a git allowlist rather than a general shell', () => {
    const step = NOTE_TO_SPEC_WORKFLOW.steps[0];
    // `Bash` is present but every command it may run is a read-only git query. An investigation
    // agent with a general shell can install dependencies and push branches unattended.
    expect(step?.allowedTools).toContain('Bash');
    expect(step?.bashAllowlist).toEqual(['git log', 'git show', 'git status']);
    expect(step?.allowedTools).not.toContain('Edit');
  });
});
