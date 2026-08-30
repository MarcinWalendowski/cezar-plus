import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * `GET /api/v1/skills/importable` (P2 of
 * `.ai/specs/2026-08-30-close-open-mercato-residue.md`, finding 1 / Guards table row
 * "`/skills/importable` answers a configured repo's skills").
 *
 * Exercises the real route against a REAL local git fixture, never a stub team-skill list —
 * because the bug this guard exists for is exactly the kind a mock can't see: `gatedSkillsRepos`
 * answered the empty set on every one of its code paths for two weeks, and every test that
 * stubbed the gate (or the team-skill cache) kept passing straight through it. `safeRemoteFor` /
 * `ensureBareClone` accept a local path with `protocol.file.allow=user`, so the clone is
 * deterministic and needs no network.
 */
describe('GET /api/v1/skills/importable', () => {
  let repoRoot: string;
  let homeRoot: string;
  let fixtureParent: string;
  let fixture: string;
  const savedHome = process.env.HOME;
  const savedCezHome = process.env.CEZ_HOME;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-skillsapi-'));
    homeRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-skillsapi-home-'));
    // `bareDirFor` (skills-remote.ts) keys its clone cache off `homedir()`, not `CEZ_HOME` — an
    // isolated HOME is what keeps this test's clone out of the real `~/.cache/cez/skills`.
    process.env.HOME = homeRoot;
    process.env.CEZ_HOME = join(homeRoot, '.cezar');
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    mkdirSync(join(homeRoot, '.cezar'), { recursive: true });

    // A local git fixture team-skills repo — same shape as the spec's own Runtime E2E setup
    // rule: a `<dir>/SKILL.md` per skill, named after the parent directory.
    fixtureParent = mkdtempSync(join(realpathSync(tmpdir()), 'cez-skillsapi-fixture-'));
    fixture = join(fixtureParent, 'team-skills');
    mkdirSync(join(fixture, 'alpha'), { recursive: true });
    mkdirSync(join(fixture, 'beta'), { recursive: true });
    writeFileSync(
      join(fixture, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: fixture skill A\n---\nbody\n',
    );
    writeFileSync(
      join(fixture, 'beta', 'SKILL.md'),
      '---\nname: beta\ndescription: fixture skill B\n---\nbody\n',
    );
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixture });
    execFileSync('git', ['add', '-A'], { cwd: fixture });
    execFileSync(
      'git',
      ['-c', 'user.email=test@local', '-c', 'user.name=test', 'commit', '-qm', 'fixture'],
      { cwd: fixture },
    );

    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
    rmSync(fixtureParent, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedCezHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedCezHome;
  });

  const configure = (skillsRepos: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify({ skillsRepos }), 'utf8');

  // `wait=1` is not a convenience here: without it the first request answers from a cold,
  // empty cache regardless of the gate, which would make this assertion mean nothing.
  const importable = () => apiRequest(app, '/api/v1/skills/importable?wait=1');

  it('answers [] for a zero-config project — the control', async () => {
    const res = await importable();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("answers a configured repo's skills — the mutation this guard exists for is re-adding an always-empty gate", async () => {
    configure([{ repo: fixture, ref: 'main' }]);
    const res = await importable();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string; description?: string }>;
    expect(body.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
  });
});
