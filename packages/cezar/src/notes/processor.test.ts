import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRunResult, AgentRunSpec, AgentRunner } from '../core/agent-runner.ts';
import { WorkspaceRunIndex } from '../workspace/run-index.ts';
import { NoteCoordinator, type NoteCoordinatorProject } from './coordinator.ts';
import { NoteProcessor, sanitizeProposals } from './processor.ts';
import { buildNotePassPrompt } from './prompt.ts';
import { NoteStore } from './store.ts';

/**
 * The triage pass (P2.2, spec `.ai/specs/2026-08-14-note-to-spec-pipeline.md`).
 *
 * Four things carry weight here, and each is paired with the mutation that must turn it red:
 *
 * | Guard | Mutation |
 * |---|---|
 * | The pass never reaches the run machinery (TRANSITIVE import walk) | add the import, directly or one file deep |
 * | The board is in the prompt | drop the digest section from `buildNotePassPrompt` |
 * | A project the pass invented is FLAGGED, never retargeted | pick the nearest catalog id instead |
 * | A runner error is visible, never a silent empty pass | return `{proposals: []}` with no error |
 */

// ---- the structural guard --------------------------------------------------------------------

/**
 * Walk this module's transitive relative-import graph.
 *
 * TRANSITIVE, unlike `run-index.test.ts`'s single-file C2, and that is the point: `processor.ts`
 * importing a helper that imports `workflows/run.ts` resumes agent runs in every registered
 * repository just as surely as importing it directly, and a one-file grep sees none of it. One
 * layer of indirection is all it takes to silence a shallow gate.
 */
function transitiveImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const specifier = match[1] as string;
      queue.push(resolve(dirname(file), specifier));
    }
  }
  return seen;
}

describe('the triage pass never reaches the run machinery', () => {
  const graph = transitiveImports(new URL('./processor.ts', import.meta.url).pathname);

  it('imports neither project-context.ts nor workflows/run.ts, at any depth', () => {
    const offenders = [...graph].filter(
      (file) => /server\/project-context\.ts$/.test(file) || /workflows\/run\.ts$/.test(file),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * The walker itself, pinned. A `transitiveImports` that silently returned a one-element set —
   * a bad regex, a resolution change — would make the assertion above pass forever while proving
   * nothing. So: it must actually reach a file `processor.ts` does not import directly.
   */
  it('the walker really does follow imports more than one level deep', () => {
    expect(graph.size).toBeGreaterThan(5);
    // `planner.ts` is a direct import; `core/agent-runner.ts` is reached only THROUGH something.
    expect([...graph].some((file) => /core\/agent-runner\.ts$/.test(file))).toBe(true);
  });
});

// ---- the pass ---------------------------------------------------------------------------------

const CATALOG_PROJECTS: NoteCoordinatorProject[] = [
  { id: 'api', root: '/tmp/none-api', name: 'API', status: 'ok', tags: ['backend'], lastOpenedAt: '2026-08-14' },
  { id: 'web', root: '/tmp/none-web', name: 'Web', status: 'ok', tags: [], lastOpenedAt: '2026-08-13' },
]

/** Answers one scripted text per call, and records what it was asked. */
function scriptedRunner(answers: string[]): { runner: AgentRunner; prompts: string[] } {
  const prompts: string[] = [];
  let call = 0;
  const runner = {
    backend: 'claude',
    async run(spec: AgentRunSpec): Promise<AgentRunResult> {
      prompts.push(spec.userPrompt);
      const answer = answers[Math.min(call++, answers.length - 1)];
      if (answer === undefined) throw new Error('runner unavailable');
      if (answer.startsWith('THROW:')) throw new Error(answer.slice(6));
      return { text: answer } as AgentRunResult;
    },
    startSession() {
      throw new Error('not used by the pass');
    },
    async interrupt() {},
  } as unknown as AgentRunner;
  return { runner, prompts };
}

describe('NoteProcessor', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let bootRoot: string;
  let store: NoteStore;

  const makeProcessor = (answers: string[], projects = CATALOG_PROJECTS) => {
    const { runner, prompts } = scriptedRunner(answers);
    const processor = new NoteProcessor({
      store,
      coordinator: new NoteCoordinator({ listProjects: async () => projects }),
      runIndex: new WorkspaceRunIndex({
        listProjects: async () => projects.map((p) => ({ id: p.id, root: p.root, status: p.status, name: p.name })),
      }),
      bootRoot,
      runnerFactory: () => runner,
    });
    return { processor, prompts };
  };

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pass-home-'));
    bootRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pass-boot-'));
    process.env.CEZ_HOME = home;
    store = new NoteStore({ paths: { notes: join(home, 'notes.json'), log: join(home, 'notes-log.ndjson') } });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(bootRoot, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  it('splits one note into one proposal per project it implies', async () => {
    const note = await store.capture({
      body: 'Add the CSV exporter to the API, and fix the retry backoff in web',
      source: 'cockpit',
    });
    const { processor } = makeProcessor([
      JSON.stringify({
        summary: 'Two pieces of work.',
        proposals: [
          { projectId: 'api', title: 'CSV exporter', task: 'Spec the exporter.', rationale: 'new' },
          { projectId: 'web', title: 'Retry backoff', task: 'Spec the fix.', rationale: 'new' },
        ],
        unassigned: [],
      }),
    ]);

    await processor.runPass(note);

    const after = store.get(note.id);
    expect(after?.status).toBe('processed');
    expect(after?.pass?.proposals.map((row) => [row.id, row.projectId])).toEqual([
      ['p1', 'api'],
      ['p2', 'web'],
    ]);
    // Persisted so "why did it miss that repo?" stays answerable.
    expect(after?.pass?.consideredProjects).toEqual(['api', 'web']);
  });

  it('flags a project the pass invented instead of retargeting it', async () => {
    const note = await store.capture({ body: 'do a thing in the mobile app', source: 'cockpit' });
    const { processor } = makeProcessor([
      JSON.stringify({
        proposals: [{ projectId: 'mobile', title: 'A thing', task: 'Spec it.', rationale: '' }],
        unassigned: [],
      }),
    ]);

    await processor.runPass(note);

    const proposal = store.get(note.id)?.pass?.proposals[0];
    // The id is KEPT as written and flagged. Retargeting it at `api` or `web` would start an
    // agent run in a repository nobody chose — the one outcome this must never produce.
    expect(proposal?.projectId).toBe('mobile');
    expect(proposal?.issues).toContain('unknown-project');
  });

  it('drops an invented workflow name while keeping the proposal', async () => {
    const note = await store.capture({ body: 'ship it', source: 'cockpit' });
    const { processor } = makeProcessor([
      JSON.stringify({
        proposals: [
          { projectId: 'api', title: 'Ship', task: 'Spec it.', rationale: '', workflow: 'not-a-workflow' },
        ],
        unassigned: [],
      }),
    ]);

    await processor.runPass(note);

    const proposal = store.get(note.id)?.pass?.proposals[0];
    expect(proposal?.workflow).toBeUndefined();
    expect(proposal?.issues).toContain('unknown-workflow');
  });

  it('retries once on an unparseable answer, then succeeds', async () => {
    const note = await store.capture({ body: 'ship it', source: 'cockpit' });
    const { processor, prompts } = makeProcessor([
      'I am afraid I cannot do that.',
      JSON.stringify({ proposals: [{ projectId: 'api', title: 'Ship', task: 'Spec it.', rationale: '' }], unassigned: [] }),
    ]);

    await processor.runPass(note);

    expect(prompts).toHaveLength(2);
    expect(store.get(note.id)?.pass?.fallback).toBe(false);
  });

  /** A runner that is absent or unauthenticated must leave a VISIBLE failure. A silently empty
   *  pass reads as "there is nothing to do here", which is the opposite of what happened. */
  it('records a runner error on the note rather than an empty success', async () => {
    const note = await store.capture({ body: 'ship it', source: 'cockpit' });
    const { processor, prompts } = makeProcessor(['THROW:claude is not installed']);

    await processor.runPass(note);

    const after = store.get(note.id);
    expect(after?.status).toBe('failed');
    expect(after?.pass?.fallback).toBe(true);
    expect(after?.pass?.error).toContain('claude is not installed');
    // A runner error is not retried — a second identical call cannot install a missing CLI.
    expect(prompts).toHaveLength(1);
  });

  /**
   * With no hint there is NO target to fall back to, and the pass must not pick one. Choosing a
   * project is precisely the question it failed to answer, so guessing would be inventing the one
   * thing that matters.
   */
  it('proposes nothing on failure when the note named no project', async () => {
    const note = await store.capture({ body: 'ship it', source: 'cockpit' });
    const { processor } = makeProcessor(['THROW:down']);

    await processor.runPass(note);

    expect(store.get(note.id)?.pass?.proposals).toEqual([]);
  });

  it('falls back to the whole note in the project the person named', async () => {
    const note = await store.capture({ body: 'ship it', source: 'cockpit', projectHint: 'api' });
    const { processor } = makeProcessor(['THROW:down']);

    await processor.runPass(note);

    const proposals = store.get(note.id)?.pass?.proposals;
    expect(proposals).toHaveLength(1);
    expect(proposals?.[0]?.projectId).toBe('api');
    expect(proposals?.[0]?.task).toBe('ship it');
  });

  it('refuses a second pass while one is in flight', async () => {
    const note = await store.capture({ body: 'ship it', source: 'cockpit' });
    await store.update(note.id, { status: 'processing' });
    const { processor } = makeProcessor(['{}']);

    expect(await processor.process(note.id)).toEqual({
      ok: false,
      status: 409,
      error: 'this note is already being analysed',
    });
  });

  it('answers 404 for a note that is not there', async () => {
    const { processor } = makeProcessor(['{}']);

    expect((await processor.process('note_nope')).ok).toBe(false);
  });
});

// ---- identity-aware routing (cezar task #21) ---------------------------------------------------

/**
 * The runtime E2E's central defect (spec `.ai/specs/2026-08-14-note-to-spec-pipeline.md`,
 * "Runtime E2E — EXECUTED 2026-08-15", defect 2): a note naming a project by its README title
 * rather than its registered id put both of that note's proposals on a DIFFERENT, actually
 * registered project — a confident wrong answer, not a rejected one, because the wrong answer was
 * still a real id. Reproduced here with the exact shape of the fixture that found it: an id
 * (`cez-e2e-fixture`) that names nothing the note says, next to a folder/package/README that all
 * agree on `widget-service`, alongside a second, unrelated project (`aside`) whose id already
 * matches its own name.
 *
 * These tests use REAL directories on disk (not scripted `NoteCoordinatorProject` literals) so
 * `NoteCoordinator.catalog()`'s file reads are exercised for real, exactly as `coordinator.test.ts`
 * does — the point being to prove the enriched catalog actually reaches the prompt the pass
 * reasons over, not merely that a hand-built fixture object has the right shape.
 */
describe('identity-aware routing', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let bootRoot: string;
  let workspaceRoot: string;
  let fixtureRoot: string;
  let asideRoot: string;
  let store: NoteStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pass-home-'));
    bootRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pass-boot-'));
    workspaceRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pass-projects-'));
    process.env.CEZ_HOME = home;
    store = new NoteStore({ paths: { notes: join(home, 'notes.json'), log: join(home, 'notes-log.ndjson') } });

    // The fixture: registered as `cez-e2e-fixture`, but its folder, package.json and README all
    // call it `widget-service` — exactly the runtime E2E's shape.
    fixtureRoot = join(workspaceRoot, 'widget-service');
    mkdirSync(fixtureRoot);
    writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({ name: 'widget-service' }));
    writeFileSync(join(fixtureRoot, 'README.md'), '# widget-service\n\nLabel formatting helpers.\n');

    // A second, unrelated project whose id already IS its name — nothing to alias, and the wrong
    // target the runtime bug landed both proposals on.
    asideRoot = join(workspaceRoot, 'aside');
    mkdirSync(asideRoot);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(bootRoot, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const projectSources = (): NoteCoordinatorProject[] => [
    { id: 'cez-e2e-fixture', root: fixtureRoot, name: 'Fixture', status: 'ok' },
    { id: 'aside', root: asideRoot, name: 'Aside', status: 'ok' },
  ];

  const makeProcessor = (answers: string[]) => {
    const { runner, prompts } = scriptedRunner(answers);
    const projects = projectSources();
    const processor = new NoteProcessor({
      store,
      coordinator: new NoteCoordinator({ listProjects: async () => projects }),
      runIndex: new WorkspaceRunIndex({
        listProjects: async () => projects.map((p) => ({ id: p.id, root: p.root, status: p.status, name: p.name })),
      }),
      bootRoot,
      runnerFactory: () => runner,
    });
    return { processor, prompts };
  };

  /**
   * GUARD: the enriched identity signals actually reach the prompt, attached to the right catalog
   * row. Mutation that must turn this red: strip the enriched fields back to the bare id (revert
   * `NoteCoordinator.catalog()` to its pre-#21 shape, or `identityAliases` to always return `''`
   * in `prompt.ts`) — confirmed red below, then reverted.
   */
  it("puts the fixture's folder, package and README name in the prompt, next to its registered id", async () => {
    const note = await store.capture({
      body: 'the widget-service label code has no test file. separately, aside needs a data export.',
      source: 'cockpit',
    });
    const { processor, prompts } = makeProcessor([
      JSON.stringify({
        summary: 'Two pieces of work.',
        proposals: [
          { projectId: 'cez-e2e-fixture', title: 'Add a test file', task: 'Spec the missing test.', rationale: '' },
          { projectId: 'aside', title: 'Data export', task: 'Spec the export.', rationale: '' },
        ],
        unassigned: [],
      }),
    ]);

    await processor.runPass(note);

    const prompt = prompts[0]!;
    const fixtureLine = prompt.split('\n').find((line) => line.startsWith('- cez-e2e-fixture'));
    expect(fixtureLine).toBeDefined();
    expect(fixtureLine).toContain('widget-service');
    // `aside`'s id already IS its name, so it carries no alias bracket — asserting its absence
    // pins that `identityAliases` skips a signal that does not differ from the id, per its doc.
    const asideLine = prompt.split('\n').find((line) => line.startsWith('- aside'));
    expect(asideLine).toBeDefined();
    expect(asideLine).not.toContain('also called');
  });

  /**
   * GUARD: two proposals naming two DIFFERENT registered projects route to those two projects,
   * not one. Mutation that must turn this red: collapse `sanitizeProposals`'s per-row map onto a
   * single project (e.g. `kept.map(() => kept[0])`) — confirmed red below, then reverted.
   */
  it('routes two proposals naming two different projects to those two projects, not one', async () => {
    const note = await store.capture({
      body: 'the widget-service label code has no test file. separately, aside needs a data export.',
      source: 'cockpit',
    });
    const { processor } = makeProcessor([
      JSON.stringify({
        summary: 'Two pieces of work.',
        proposals: [
          { projectId: 'cez-e2e-fixture', title: 'Add a test file', task: 'Spec the missing test.', rationale: '' },
          { projectId: 'aside', title: 'Data export', task: 'Spec the export.', rationale: '' },
        ],
        unassigned: [],
      }),
    ]);

    await processor.runPass(note);

    const proposals = store.get(note.id)?.pass?.proposals;
    expect(proposals?.map((row) => row.projectId)).toEqual(['cez-e2e-fixture', 'aside']);
  });

  /**
   * GUARD: a project name the pass could not match to any catalog id is kept, flagged and left
   * `pending` — needs-review, never a confident wrong target and never zero proposals. Mutation
   * that must turn this red: fall back to the first catalog project when the id is unknown
   * (`byId.get(row.projectId) ?? catalog[0]`) — confirmed red below, then reverted.
   */
  it('keeps an unmatched project name as a pending, flagged proposal rather than defaulting it', async () => {
    const note = await store.capture({ body: 'do a thing in the mobile app', source: 'cockpit' });
    const { processor } = makeProcessor([
      JSON.stringify({
        proposals: [{ projectId: 'mobile', title: 'A thing', task: 'Spec it.', rationale: '' }],
        unassigned: [],
      }),
    ]);

    await processor.runPass(note);

    const proposals = store.get(note.id)?.pass?.proposals;
    expect(proposals).toHaveLength(1);
    const proposal = proposals?.[0];
    expect(proposal?.projectId).toBe('mobile');
    expect(proposal?.issues).toContain('unknown-project');
    expect(proposal?.decision).toBe('pending');
  });
});

// ---- the prompt ------------------------------------------------------------------------------

describe('buildNotePassPrompt', () => {
  const catalog = [
    { id: 'api', name: 'API', status: 'ok' as const, tags: ['backend'], workflows: ['quick-task'], dirName: 'api' },
    { id: 'web', name: 'Web', status: 'ok' as const, tags: [], workflows: [], dirName: 'web' },
  ];

  /**
   * THE dedupe guard. Dedupe is not code here — it is the board being in the prompt. Without it
   * the pass has nothing to compare a note against and produces one new task per note *by
   * construction*, which is exactly the failure the parent-keeps-the-dedupe-pass rule exists to
   * prevent.
   */
  it("puts every considered project's live runs in the prompt", () => {
    const prompt = buildNotePassPrompt({
      note: { title: 'Ship', body: 'ship the exporter' },
      catalog,
      digest: {
        api: { ok: true, entries: [{ id: 'run-9', title: 'Build the CSV exporter', status: 'running', createdAt: '2026-08-14T00:00:00.000Z' }] },
        web: { ok: true, entries: [] },
      },
    });

    expect(prompt).toContain('Build the CSV exporter');
    expect(prompt).toContain('run-9');
    // A project with an empty board says so, rather than being absent — absent would read as
    // "unknown", and the pass would have no reason to think it had seen that project's work.
    expect(prompt).toContain('web: nothing running');
  });

  it('names an unreadable board instead of omitting it', () => {
    const prompt = buildNotePassPrompt({
      note: { title: 'Ship', body: 'ship it' },
      catalog,
      digest: { api: { ok: false, reason: 'runs.json is not valid JSON', entries: [] }, web: { ok: true, entries: [] } },
    });

    // Silence here would read as "nothing is running in api", which is a claim nobody can make.
    expect(prompt).toContain('board unavailable (runs.json is not valid JSON)');
  });

  it('presents the project hint as advice, never as a target', () => {
    const prompt = buildNotePassPrompt({
      note: { title: 'Ship', body: 'ship it', projectHint: 'api' },
      catalog,
      digest: {},
    });

    expect(prompt).toContain('hint only');
    expect(prompt).toContain('overrule it');
  });
});

/**
 * D4c of `.ai/specs/2026-08-29-global-provider-toggle.md`. The triage pass is the fourth model
 * call that never touches `RunManager`, and the only one taking the lock as an ACCESSOR rather
 * than a value: this processor is constructed once at boot and asks repeatedly, so a value
 * captured at construction would pin every future pass to whatever the lock was when the server
 * started. The third case below is what makes that difference observable.
 */
describe('NoteProcessor under a workspace provider lock', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let bootRoot: string;
  let store: NoteStore;

  const makeProcessor = (runnerLock: () => 'claude' | 'codex' | undefined) => {
    const { runner } = scriptedRunner([
      JSON.stringify({
        summary: 'One piece of work.',
        proposals: [{ projectId: 'api', title: 'CSV exporter', task: 'Spec the exporter.', rationale: 'new' }],
        unassigned: [],
      }),
    ]);
    return new NoteProcessor({
      store,
      coordinator: new NoteCoordinator({ listProjects: async () => CATALOG_PROJECTS }),
      runIndex: new WorkspaceRunIndex({
        listProjects: async () =>
          CATALOG_PROJECTS.map((p) => ({ id: p.id, root: p.root, status: p.status, name: p.name })),
      }),
      bootRoot,
      runnerFactory: () => runner,
      runnerLock,
    });
  };

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pass-lock-home-'));
    bootRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pass-lock-boot-'));
    process.env.CEZ_HOME = home;
    store = new NoteStore({ paths: { notes: join(home, 'notes.json'), log: join(home, 'notes-log.ndjson') } });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(bootRoot, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  it('CONTROL: with no lock the pass runs on the boot project default', async () => {
    const note = await store.capture({ body: 'Add the CSV exporter to the API', source: 'cockpit' });
    await makeProcessor(() => undefined).runPass(note);
    expect(store.get(note.id)?.pass?.runner).toBe('claude');
  });

  it('runs the pass on the locked provider', async () => {
    const note = await store.capture({ body: 'Add the CSV exporter to the API', source: 'cockpit' });
    await makeProcessor(() => 'codex').runPass(note);
    expect(store.get(note.id)?.pass?.runner).toBe('codex');
  });

  it('re-reads the lock every pass, so a flip after boot reaches the next one', async () => {
    // The accessor's whole reason for being. A value captured in the constructor passes both
    // cases above and fails only this one.
    let lock: 'claude' | 'codex' | undefined;
    const processor = makeProcessor(() => lock);
    const first = await store.capture({ body: 'Add the CSV exporter to the API', source: 'cockpit' });
    await processor.runPass(first);
    expect(store.get(first.id)?.pass?.runner).toBe('claude');
    lock = 'codex';
    const second = await store.capture({ body: 'Add the CSV exporter to the API again', source: 'cockpit' });
    await processor.runPass(second);
    expect(store.get(second.id)?.pass?.runner).toBe('codex');
  });
});
