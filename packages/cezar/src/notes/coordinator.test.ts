import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoteCoordinator, type NoteCoordinatorProject } from './coordinator.ts';

/**
 * The catalog's identity signals (cezar task #21, `.ai/specs/2026-08-14-note-to-spec-pipeline.md`
 * §"Runtime E2E — EXECUTED 2026-08-15", defect 2).
 *
 * The runtime E2E found routing that mis-targets when a note names a project by anything other
 * than its registered id: a fixture registered as `cez-e2e-fixture` was titled `widget-service`
 * in its README, and a note naming "widget-service" landed on a DIFFERENT, actually-registered
 * project instead — a confident wrong answer, not a rejected one, because `sanitizeProposals`
 * only catches an id that matches NO catalog row. The fix is upstream: give the pass the same
 * names a human would recognise a project by. These tests are about `catalog()` gathering those
 * names correctly, from real files on real disk — never through a `ProjectContext`.
 */
describe('NoteCoordinator.catalog — identity signals', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-note-identity-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Reproduces the exact shape of the runtime defect: a registered id that names nothing the
   *  note would say, next to a folder, a package and a README that all agree on a DIFFERENT
   *  name. Mutation: delete the `dirName`/`packageName`/`readmeTitle` reads from `catalog()` —
   *  this must fail, because those three lines are what would go missing. */
  it("gathers a project's folder, package name and README title, distinct from its registered id", async () => {
    const projectDir = join(root, 'widget-service');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'widget-service' }));
    writeFileSync(join(projectDir, 'README.md'), '# widget-service\n\nDoes widget things.\n');

    const coordinator = new NoteCoordinator({
      listProjects: async () => [
        {
          id: 'cez-e2e-fixture',
          root: projectDir,
          name: 'Fixture',
          status: 'ok',
          repoUrl: 'https://github.com/acme/widget-service',
        } satisfies NoteCoordinatorProject,
      ],
    });

    const [entry] = await coordinator.catalog(await coordinator.considered());
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('cez-e2e-fixture');
    expect(entry!.dirName).toBe('widget-service');
    expect(entry!.packageName).toBe('widget-service');
    expect(entry!.readmeTitle).toBe('widget-service');
    expect(entry!.remoteSlug).toBe('acme/widget-service');
  });

  it('prefers the first heading over a badge-line opener, within the scan window', async () => {
    const projectDir = join(root, 'proj');
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, 'README.md'),
      ['![build](https://example.com/badge.svg)', '', '# Real Title', '', 'Body text.'].join('\n'),
    );

    const coordinator = new NoteCoordinator({ listProjects: async () => [source(projectDir)] });
    const [entry] = await coordinator.catalog(await coordinator.considered());
    expect(entry!.readmeTitle).toBe('Real Title');
  });

  it('falls back to the first non-empty line when no heading appears', async () => {
    const projectDir = join(root, 'proj');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'README'), '\n\nA project with no markdown heading.\nMore text.\n');

    const coordinator = new NoteCoordinator({ listProjects: async () => [source(projectDir)] });
    const [entry] = await coordinator.catalog(await coordinator.considered());
    expect(entry!.readmeTitle).toBe('A project with no markdown heading.');
  });

  it('finds a README regardless of casing or extension', async () => {
    const projectDir = join(root, 'proj');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'Readme.markdown'), '# Cased Readme\n');

    const coordinator = new NoteCoordinator({ listProjects: async () => [source(projectDir)] });
    const [entry] = await coordinator.catalog(await coordinator.considered());
    expect(entry!.readmeTitle).toBe('Cased Readme');
  });

  /** Absent, not thrown — a missing catalog line must not make the project invisible to the pass
   *  (the same doctrine `workflowNames` already follows). Mutation: let a missing file throw out
   *  of `catalog()` — this must fail, because the whole pass would then die on one bare repo. */
  it('degrades to undefined, never throws, when there is no package.json or README', async () => {
    const projectDir = join(root, 'bare');
    mkdirSync(projectDir);

    const coordinator = new NoteCoordinator({ listProjects: async () => [source(projectDir)] });
    const [entry] = await coordinator.catalog(await coordinator.considered());
    expect(entry!.packageName).toBeUndefined();
    expect(entry!.readmeTitle).toBeUndefined();
    expect(entry!.dirName).toBe('bare');
  });

  it('degrades to undefined on a malformed package.json rather than throwing', async () => {
    const projectDir = join(root, 'broken-pkg');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'package.json'), '{ not valid json');

    const coordinator = new NoteCoordinator({ listProjects: async () => [source(projectDir)] });
    const [entry] = await coordinator.catalog(await coordinator.considered());
    expect(entry!.packageName).toBeUndefined();
  });

  it('has no remoteSlug when the registry probed no repoUrl', async () => {
    const projectDir = join(root, 'local-only');
    mkdirSync(projectDir);

    const coordinator = new NoteCoordinator({ listProjects: async () => [source(projectDir)] });
    const [entry] = await coordinator.catalog(await coordinator.considered());
    expect(entry!.remoteSlug).toBeUndefined();
  });
});

function source(root: string): NoteCoordinatorProject {
  return { id: 'p1', root, name: 'P1', status: 'ok' };
}
