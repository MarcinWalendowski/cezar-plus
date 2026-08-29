import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkflows, WORKFLOWS_DIR } from './load.ts';
import { INPUT_TO_TASKS_NAME, SPEC_TO_DEPLOY_CODEX_NAME, SPEC_TO_DEPLOY_WORKFLOW } from './types.ts';

/**
 * `loadWorkflows` deriving `spec-to-deploy-codex` (`.ai/specs/2026-08-24-codex-only-default-
 * workflow.md`, D4, V3). The catalog case, distinct from `run-source-fallback.test.ts`'s
 * server-level cases — this file owns `loadWorkflows` directly so the derivation and its metadata
 * rule are asserted at the seam that actually produces them.
 */
describe('loadWorkflows derives spec-to-deploy-codex (V3)', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-load-workflows-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('(a) with no .ai/cezar/workflows, the catalog has five entries including spec-to-deploy-codex and input-to-tasks', async () => {
    // `input-to-tasks` added 2026-08-25 (`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md`).
    // This assertion is EXHAUSTIVE on purpose, so a new built-in has to be declared here rather
    // than appearing in the catalog unnoticed.
    const { workflows, issues } = await loadWorkflows(repoRoot);
    expect(issues).toEqual([]);
    expect(workflows.map((w) => w.name).sort()).toEqual([
      INPUT_TO_TASKS_NAME,
      'note-to-spec',
      'quick-task',
      'spec-to-deploy',
      SPEC_TO_DEPLOY_CODEX_NAME,
    ]);
  });

  it('(b) derives off the RESOLVED base: a project spec-to-deploy.yaml with two steps yields a codex sibling with those same two steps, both pinned', async () => {
    const dir = join(repoRoot, WORKFLOWS_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'spec-to-deploy.yaml'),
      [
        'name: spec-to-deploy',
        'description: project override',
        'steps:',
        '  - id: task',
        '    name: Do the task',
        '    prompt: "{{task}}"',
        '  - id: ship',
        '    name: Ship it',
        '    prompt: "{{task}}"',
        '',
      ].join('\n'),
      'utf8',
    );
    const { workflows } = await loadWorkflows(repoRoot);
    const codex = workflows.find((w) => w.name === SPEC_TO_DEPLOY_CODEX_NAME);
    expect(codex).toBeDefined();
    expect(codex!.steps.map((s) => s.id)).toEqual(['task', 'ship']);
    expect(codex!.steps.map((s) => s.runner)).toEqual(['codex', 'codex']);
  });

  it('(c) the metadata a naive spread would leak: derived entry is source built-in, no path, even though its base came from a file', async () => {
    const dir = join(repoRoot, WORKFLOWS_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'spec-to-deploy.yaml'),
      ['name: spec-to-deploy', 'steps:', '  - id: task', '    prompt: "{{task}}"', ''].join('\n'),
      'utf8',
    );
    const { workflows } = await loadWorkflows(repoRoot);
    const codex = workflows.find((w) => w.name === SPEC_TO_DEPLOY_CODEX_NAME);
    expect(codex?.source).toBe('built-in');
    expect(codex?.path).toBeUndefined();
  });

  it('(d) an explicit spec-to-deploy-codex.yaml wins by name and keeps ordinary file metadata', async () => {
    const dir = join(repoRoot, WORKFLOWS_DIR);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${SPEC_TO_DEPLOY_CODEX_NAME}.yaml`);
    writeFileSync(
      path,
      [
        `name: ${SPEC_TO_DEPLOY_CODEX_NAME}`,
        'description: project-authored codex chain',
        'steps:',
        '  - id: only-step',
        '    prompt: "{{task}}"',
        '',
      ].join('\n'),
      'utf8',
    );
    const { workflows } = await loadWorkflows(repoRoot);
    const matches = workflows.filter((w) => w.name === SPEC_TO_DEPLOY_CODEX_NAME);
    expect(matches).toHaveLength(1);
    const codex = matches[0]!;
    expect(codex.source).toBe('file');
    expect(codex.path).toBe(path);
    expect(codex.description).toBe('project-authored codex chain');
    expect(codex.steps.map((s) => s.id)).toEqual(['only-step']);
    // The FILE'S own step carries no runner pin — this is deliberately NOT derived, so it must
    // not have been silently pinned to codex the way the generated sibling would be.
    expect(codex.steps[0]?.runner).toBeUndefined();
  });

  it('does not mutate the built-in SPEC_TO_DEPLOY_WORKFLOW while deriving its sibling', async () => {
    await loadWorkflows(repoRoot);
    expect(SPEC_TO_DEPLOY_WORKFLOW.steps.find((s) => s.id === 'spec')?.runner).toBe('claude');
  });

  /** `input-to-tasks` (`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md`, Phase 2). */
  describe('input-to-tasks', () => {
    it('is in the catalog, with the three steps the spec names', async () => {
      const { workflows } = await loadWorkflows(repoRoot);
      const found = workflows.filter((w) => w.name === INPUT_TO_TASKS_NAME);
      expect(found).toHaveLength(1);
      expect(found[0]!.source).toBe('built-in');
      expect(found[0]!.steps.map((s) => s.id)).toEqual(['context', 'file', 'dispatch']);
    });

    it('gives no step a tool that can write a project file', async () => {
      // The grant hands this run a dozen REAL checkouts. The prompt tells it not to edit them;
      // this is what makes that true rather than aspirational, and it is the assertion that fails
      // if someone later "helpfully" adds Edit/Write to the file step.
      const { workflows } = await loadWorkflows(repoRoot);
      const wf = workflows.find((w) => w.name === INPUT_TO_TASKS_NAME)!;
      for (const step of wf.steps) {
        expect(step.allowedTools, `step ${step.id}`).toBeDefined();
        expect(step.allowedTools, `step ${step.id}`).not.toContain('Edit');
        expect(step.allowedTools, `step ${step.id}`).not.toContain('Write');
      }
    });

    it('files without --start, so starting stays a separate, optional act', async () => {
      const { workflows } = await loadWorkflows(repoRoot);
      const wf = workflows.find((w) => w.name === INPUT_TO_TASKS_NAME)!;
      const file = wf.steps.find((s) => s.id === 'file')!;
      expect(file.prompt).toContain('cez todo add');
      expect(file.prompt).toMatch(/Do NOT pass --start/i);
      // …and the dispatch step reads the frozen per-run flag. Without this token the step's own
      // prompt would render the literal `{{autoStart}}` and it could never tell.
      const dispatch = wf.steps.find((s) => s.id === 'dispatch')!;
      expect(dispatch.prompt).toContain('{{autoStart}}');
      expect(dispatch.prompt).toContain('cez todo start');
    });

    it('a repo can override it by shipping its own file, like every other built-in', async () => {
      const dir = join(repoRoot, WORKFLOWS_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'input-to-tasks.yaml'),
        ['name: input-to-tasks', 'steps:', '  - id: mine', '    prompt: "{{task}}"', ''].join('\n'),
        'utf8',
      );
      const { workflows } = await loadWorkflows(repoRoot);
      const found = workflows.filter((w) => w.name === INPUT_TO_TASKS_NAME);
      expect(found).toHaveLength(1);
      expect(found[0]!.source).toBe('file');
      expect(found[0]!.steps.map((s) => s.id)).toEqual(['mine']);
    });
  });
});
