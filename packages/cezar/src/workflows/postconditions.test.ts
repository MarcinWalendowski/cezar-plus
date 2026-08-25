import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEPLOY_TARGETS_FILE,
  allServicesDeployed,
  deriveBaseBranch,
  deployTargetsSchema,
  evaluatePostcondition,
  everythingCommitted,
  mergedIntoBase,
  testedRevisionShipped,
} from './postconditions.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * STEP POST-CONDITIONS (`.ai/specs/2026-08-20-steps-green-only-when-verified.md`).
 *
 * Real `mkdtemp` git repos and real `bash` probes throughout — no mocks. The whole point of these
 * built-ins is that they answer a question about the WORLD, so a test that stubs the world would
 * assert nothing. They are fast anyway: `git init` on tmpfs plus a `true`/`false` probe.
 *
 * | Guard | Mutation that must turn it red |
 * |---|---|
 * | A dirty tree fails `everything-committed` | make the `dirty.length > 0` branch return `ok: true` |
 * | The verdict NAMES the uncommitted files | drop `nameThem(dirty)` from the detail |
 * | An unpushed commit fails | delete the `rev-list --count @{u}..HEAD` branch |
 * | No upstream still passes | make a missing upstream red |
 * | A workspace run passes regardless | delete the `ctx.workspaceRun` early return |
 * | ALL probes must pass | change `failed.length > 0` to require every probe to fail |
 * | A missing targets file fails | make the `readFile` catch return `ok: true` |
 * | An empty target list passes | make `targets.length === 0` red |
 * | A dry run passes every built-in | delete the `ctx.dryRun` guard in `evaluatePostcondition` |
 * | A dry run still fails an unknown id | move that guard ABOVE the unknown-id check |
 */

async function git(cwd: string, args: string[]): Promise<void> {
  await run('git', [...GIT_ID, ...args], { cwd });
}

async function gitText(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await run('git', [...GIT_ID, ...args], { cwd, env });
  return result.stdout.trim();
}

describe('everything-committed', () => {
  let repo: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-postcond-commit-'));
    await git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'seed']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('is RED when the step left work uncommitted, and NAMES the files', async () => {
    // Run 23221162's exact shape, and the owner instruction that followed it ("everything must be
    // committed in the commit step"): 7 modified + 5 untracked, no commit. That run's `commit-push`
    // step reported `status=done`.
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(repo, `tracked-${i}.txt`), 'v1\n');
    }
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'tracked files']);
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(repo, `tracked-${i}.txt`), 'v2 — modified, never committed\n');
    }
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(repo, `untracked-${i}.txt`), 'new\n');
    }

    const result = await everythingCommitted({ cwd: repo });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('12 files still uncommitted');
    // The verdict has to be actionable on its own — it becomes the step's `error` and the text
    // appended to the retried prompt.
    expect(result.detail).toContain('tracked-0.txt');
    expect(result.detail).toContain('untracked-0.txt');
  });

  it('counts a staged-but-uncommitted file as uncommitted', async () => {
    // `git add` is not `git commit`. A step that staged everything and then ended is the near-miss
    // this must not wave through.
    writeFileSync(join(repo, 'staged.txt'), 'staged\n');
    await git(repo, ['add', 'staged.txt']);

    const result = await everythingCommitted({ cwd: repo });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('staged.txt');
  });

  it('ignores files the repo itself ignores', async () => {
    // `--porcelain` honours .gitignore, so build output must not fail a good commit step.
    writeFileSync(join(repo, '.gitignore'), 'junk/\n');
    await git(repo, ['add', '.gitignore']);
    await git(repo, ['commit', '-m', 'ignore junk']);
    mkdirSync(join(repo, 'junk'));
    writeFileSync(join(repo, 'junk', 'out.js'), 'built\n');

    await expect(everythingCommitted({ cwd: repo })).resolves.toMatchObject({ ok: true });
  });

  it('is GREEN on a clean tree with no upstream, and says the commits are local only', async () => {
    // The `commit-push` prompt explicitly permits this: "If pushing or merging is not possible or
    // not authorized here (no remote, protected branch, no credentials), commit locally and REPORT
    // that plainly". A task branch has no upstream, so failing this would fail every good run.
    const result = await everythingCommitted({ cwd: repo });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('no upstream');
  });

  it('is RED when the tree is clean but a commit was never pushed', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'cez-postcond-remote-'));
    try {
      await git(remote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', remote]);
      await git(repo, ['push', '-u', 'origin', 'main']);

      writeFileSync(join(repo, 'later.txt'), 'committed but never pushed\n');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'local only']);

      const result = await everythingCommitted({ cwd: repo });

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('not pushed');
      expect(result.detail).toContain('origin/main');
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('is GREEN once that commit is pushed', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'cez-postcond-remote-'));
    try {
      await git(remote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', remote]);
      await git(repo, ['push', '-u', 'origin', 'main']);

      const result = await everythingCommitted({ cwd: repo });

      expect(result.ok).toBe(true);
      expect(result.detail).toContain('in sync with origin/main');
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('is GREEN for a workspace run even with a filthy tree', async () => {
    // R3. A workspace run's worktrees are applied back UNSTAGED on purpose and its agents are told
    // not to commit, so asserting the opposite would fail every workspace run's commit step.
    writeFileSync(join(repo, 'wip.txt'), 'applied back unstaged by design\n');

    const result = await everythingCommitted({ cwd: repo, workspaceRun: true });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('workspace run');
  });

  it('is GREEN in a directory that is not a git repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-postcond-plain-'));
    try {
      await expect(everythingCommitted({ cwd: plain })).resolves.toMatchObject({ ok: true });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('all-services-deployed', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cez-postcond-deploy-'));
    mkdirSync(join(repo, '.ai'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function declare(targets: Array<{ name: string; probe: string; manual?: boolean; manualReason?: string }>): void {
    writeFileSync(join(repo, DEPLOY_TARGETS_FILE), JSON.stringify({ targets }));
  }

  it('is RED when the repo never declared what it deploys', async () => {
    // R2, the load-bearing judgement call: "nobody said what this deploys" is not evidence that it
    // deployed. The verdict has to tell the reader how to fix it.
    const result = await allServicesDeployed({ cwd: repo });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain(DEPLOY_TARGETS_FILE);
    expect(result.detail).toContain('{"targets": []}');
  });

  it('is GREEN when the repo declares explicitly that it does not deploy', async () => {
    declare([]);

    const result = await allServicesDeployed({ cwd: repo });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('does not deploy');
  });

  it('is GREEN only when EVERY declared service probes live', async () => {
    declare([
      { name: 'ui', probe: 'true' },
      { name: 'service', probe: 'true' },
    ]);

    const result = await allServicesDeployed({ cwd: repo });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('all 2 services deployed');
  });

  it('is RED when one of two services did not deploy, and names WHICH', async () => {
    // The whole ask, in one test: "deploy should be green if ALL services were deployed eg: cezar
    // UI and service". The UI shipped; the backend did not.
    declare([
      { name: 'cezar UI', probe: 'true' },
      { name: 'cezar service', probe: 'echo "old MainPID still resident" >&2; exit 1' },
    ]);

    const result = await allServicesDeployed({ cwd: repo });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('1 of 2 service(s) are NOT deployed: cezar service');
    expect(result.detail).not.toContain('NOT deployed: cezar UI');
    // The probe's own output is what makes the failure diagnosable.
    expect(result.detail).toContain('old MainPID still resident');
  });

  it('is RED when a probe hangs, rather than hanging the run', async () => {
    // R4. `PROBE_TIMEOUT_MS` is 60s in production; the timeout is passed through so the behaviour
    // is testable in milliseconds rather than by waiting a minute.
    writeFileSync(join(repo, DEPLOY_TARGETS_FILE), JSON.stringify({ targets: [{ name: 'hangs', probe: 'sleep 30' }] }));

    const started = Date.now();
    const result = await allServicesDeployed({ cwd: repo, probeTimeoutMs: 300 });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it('is GREEN for a workspace run, which commits nothing and so deploys nothing', async () => {
    // Same structural reason as the commit built-in's workspace case, and deliberately consistent
    // with it: a workspace run applies its worktrees back unstaged AFTER the run, so there is no
    // commit to deploy. Without this, every workspace run on spec-to-deploy fails its last step.
    const result = await allServicesDeployed({ cwd: repo, workspaceRun: true });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('workspace run');
  });

  it('is RED when the targets file is not readable as a target list', async () => {
    writeFileSync(join(repo, DEPLOY_TARGETS_FILE), '{ this is not json');

    await expect(allServicesDeployed({ cwd: repo })).resolves.toMatchObject({ ok: false });
  });

  it('runs the probe in the step cwd, so a repo-relative probe works', async () => {
    writeFileSync(join(repo, 'marker.txt'), 'here\n');
    declare([{ name: 'cwd', probe: 'test -f marker.txt' }]);

    await expect(allServicesDeployed({ cwd: repo })).resolves.toMatchObject({ ok: true });
  });

  it('returns a manual deployment handoff for a failed manual target', async () => {
    declare([{ name: 'cezar service', probe: 'false', manual: true, manualReason: 'activate it by hand' }]);
    const result = await allServicesDeployed({ cwd: repo });
    expect(result.ok).toBe(false);
    expect(result.handoff).toEqual({ kind: 'manual-deploy', reason: expect.any(String), targets: ['cezar service'] });
    expect(result.detail).toContain('manual deployment required');
    expect(result.handoff?.reason).toContain('activate it by hand');
  });

  /**
   * spec `.ai/specs/2026-08-24-manual-deploy-not-a-bug.md` D2: this is the exact shape that
   * produced the task the spec fixes, one manual target red and one target green, and it is the
   * shape a naive fix gets wrong (iterating `parsed.targets` quietly re-admits the passing one).
   * `handoff.reason` is the card's text; `detail` is the full log and must lose nothing.
   */
  it('the manual-deploy handoff.reason names only the failing manual target, not the probe source or a passing target', async () => {
    declare([
      {
        name: 'cezar service (backend)',
        probe: 'echo "live=9c896e32 head=e38cb619, the running server is NOT serving this HEAD"; exit 1',
        manual: true,
        manualReason: 'a person activates cezar, not an agent',
      },
      { name: 'cezar UI (web)', probe: 'true', manual: true, manualReason: 'a person activates cezar, not an agent' },
    ]);

    const result = await allServicesDeployed({ cwd: repo });

    expect(result.ok).toBe(false);
    expect(result.handoff?.targets).toEqual(['cezar service (backend)']);

    const reason = result.handoff?.reason ?? '';
    // The failing target's own name, its manualReason and its probe's stdout.
    expect(reason).toContain('cezar service (backend)');
    expect(reason).toContain('a person activates cezar, not an agent');
    expect(reason).toContain('live=9c896e32 head=e38cb619');
    // The passing target is absent, and neither probe's shell source leaks in.
    expect(reason).not.toContain('cezar UI (web)');
    expect(reason).not.toContain('echo "live=9c896e32');

    // `detail` is the full log: both targets, both probe sources, unchanged.
    expect(result.detail).toContain('cezar service (backend)');
    expect(result.detail).toContain('cezar UI (web)');
    expect(result.detail).toContain('echo "live=9c896e32');
  });

  // Regression test for the truncation that produced the task: cezar's own two real probes, run
  // through the same manual-deploy shape, must keep `handoff.reason` well under the 2,000-character
  // slice `awaitHandoff` applies.
  it('handoff.reason stays under 2000 characters with cezar-sized real probes', async () => {
    const bigProbe = (label: string) =>
      [
        'set -u',
        `# ${label} probe, sized like cezar's own ~1,400/~1,100 character bash probes.`,
        ...Array.from({ length: 20 }, (_, i) => `# padding line ${i} to simulate a realistic probe body`),
        'echo "diagnostic: the running server is NOT serving this HEAD"',
        'exit 1',
      ].join('\n');
    declare([
      { name: 'cezar service (backend)', probe: bigProbe('backend'), manual: true, manualReason: 'activate it by hand' },
      { name: 'cezar UI (web)', probe: bigProbe('ui').replace('exit 1', 'exit 0'), manual: true, manualReason: 'activate it by hand' },
    ]);

    const result = await allServicesDeployed({ cwd: repo });

    expect(result.handoff?.reason.length).toBeLessThan(2_000);
  });
});

describe('tested-revision-shipped', () => {
  let repo: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-postcond-attestation-'));
    await git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'seed']);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('allows record-only changes after the tested tree', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cez-attestation-index-'));
    try {
      const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index') };
      await gitText(repo, ['add', '-A'], env);
      const treeSha = await gitText(repo, ['write-tree'], env);
      mkdirSync(join(repo, '.ai', 'specs'), { recursive: true });
      writeFileSync(join(repo, '.ai', 'specs', 'record.md'), 'record\n');
      await expect(
        testedRevisionShipped({
          cwd: repo,
          stepId: 'commit-push',
          attestation: { stepId: 'run-tests', treeSha, at: new Date().toISOString() },
        }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('rejects a source change after the tested tree', async () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'change.ts'), 'export const changed = false;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'source']);
    const temp = mkdtempSync(join(tmpdir(), 'cez-attestation-index-'));
    try {
      const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index') };
      await gitText(repo, ['add', '-A'], env);
      const treeSha = await gitText(repo, ['write-tree'], env);
      writeFileSync(join(repo, 'src', 'change.ts'), 'export const changed = true;\n');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'changed source']);
      const result = await testedRevisionShipped({
        cwd: repo,
        stepId: 'commit-push',
        attestation: { stepId: 'run-tests', treeSha, at: new Date().toISOString() },
      });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('src/change.ts');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('fails when an attested tree cannot be resolved', async () => {
    await expect(
      testedRevisionShipped({
        cwd: repo,
        stepId: 'commit-push',
        attestation: { stepId: 'run-tests', treeSha: 'deadbeef', at: new Date().toISOString() },
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('checks workspace project trees instead of scratch runner artifacts, across two projects', async () => {
    const projectA = mkdtempSync(join(tmpdir(), 'cez-postcond-project-a-'));
    const projectB = mkdtempSync(join(tmpdir(), 'cez-postcond-project-b-'));
    try {
      await git(projectA, ['init', '-b', 'main']);
      writeFileSync(join(projectA, 'a.ts'), 'export const value = 1;\n');
      await git(projectA, ['add', '.']);
      await git(projectA, ['commit', '-m', 'project seed']);
      const seedA = await gitText(projectA, ['rev-parse', 'HEAD']);
      const treeA = await gitText(projectA, ['rev-parse', 'HEAD^{tree}']);

      await git(projectB, ['init', '-b', 'main']);
      writeFileSync(join(projectB, 'b.ts'), 'export const value = 1;\n');
      await git(projectB, ['add', '.']);
      await git(projectB, ['commit', '-m', 'project seed']);
      const seedB = await gitText(projectB, ['rev-parse', 'HEAD']);
      const treeB = await gitText(projectB, ['rev-parse', 'HEAD^{tree}']);

      // The four scratch-only incident artifacts live in the run cwd, never in either project —
      // this is what P3's original defect attested by mistake (Problem, run `2914e8d5`).
      for (const artifact of [
        '.cezar-control-path',
        '.cezar-gate-path',
        'cezar-control-171c8647.log',
        'cezar-gates-171c8647.log',
      ]) writeFileSync(join(repo, artifact), 'scratch only\n');

      const attestation = {
        stepId: 'run-tests',
        treeSha: '0'.repeat(40),
        at: new Date().toISOString(),
        projects: [
          { root: '/projects/a', worktreePath: projectA, treeSha: treeA },
          { root: '/projects/b', worktreePath: projectB, treeSha: treeB },
        ],
      };
      await expect(testedRevisionShipped({ cwd: repo, stepId: 'commit-push', attestation })).resolves.toMatchObject({
        ok: true,
        detail: expect.stringContaining('all 2 project HEADs'),
      });

      // Record-only edits in BOTH projects at once stay green (item 3, unchanged behaviour).
      mkdirSync(join(projectA, '.ai', 'specs'), { recursive: true });
      writeFileSync(join(projectA, '.ai', 'specs', 'record.md'), 'record\n');
      await git(projectA, ['add', '.']);
      await git(projectA, ['commit', '-m', 'record-only A']);
      mkdirSync(join(projectB, '.ai', 'specs'), { recursive: true });
      writeFileSync(join(projectB, '.ai', 'specs', 'record.md'), 'record\n');
      await git(projectB, ['add', '.']);
      await git(projectB, ['commit', '-m', 'record-only B']);
      await expect(testedRevisionShipped({ cwd: repo, stepId: 'commit-push', attestation })).resolves.toMatchObject({
        ok: true,
      });
      await git(projectA, ['reset', '--hard', seedA]);
      await git(projectB, ['reset', '--hard', seedB]);

      // A source change in project A ONLY fails, naming A's root and path and NOT B's (item 2).
      writeFileSync(join(projectA, 'a.ts'), 'export const value = 2;\n');
      await git(projectA, ['add', '.']);
      await git(projectA, ['commit', '-m', 'post-test source A']);
      const changedA = await testedRevisionShipped({ cwd: repo, stepId: 'commit-push', attestation });
      expect(changedA.ok).toBe(false);
      expect(changedA.detail).toContain('/projects/a: a.ts');
      expect(changedA.detail).not.toContain('/projects/b:');
      await git(projectA, ['reset', '--hard', seedA]);

      // Mirrored: a change in project B ONLY fails, naming B's root and path and NOT A's.
      writeFileSync(join(projectB, 'b.ts'), 'export const value = 2;\n');
      await git(projectB, ['add', '.']);
      await git(projectB, ['commit', '-m', 'post-test source B']);
      const changedB = await testedRevisionShipped({ cwd: repo, stepId: 'commit-push', attestation });
      expect(changedB.ok).toBe(false);
      expect(changedB.detail).toContain('/projects/b: b.ts');
      expect(changedB.detail).not.toContain('/projects/a:');
    } finally {
      rmSync(projectA, { recursive: true, force: true });
      rmSync(projectB, { recursive: true, force: true });
    }
  });

  it('fails closed when an attested workspace worktree is gone', async () => {
    const result = await testedRevisionShipped({
      cwd: repo,
      stepId: 'commit-push',
      attestation: {
        stepId: 'run-tests',
        treeSha: '0'.repeat(40),
        at: new Date().toISOString(),
        projects: [{ root: '/projects/gone', worktreePath: join(repo, 'gone'), treeSha: '1'.repeat(40) }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('/projects/gone');
  });
});

describe('merge postconditions', () => {
  it('defaults a missing remote default to main and strips origin prefixes and SHA refs', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-postcond-base-'));
    try {
      await git(repo, ['init', '-b', 'main']);
      expect(await deriveBaseBranch(repo, 'origin/develop')).toBe('develop');
      expect(await deriveBaseBranch(repo, '0123456789abcdef0123456789abcdef01234567', 'feature')).toBe('feature');
      expect(await deriveBaseBranch(repo)).toBe('main');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('treats automatic merge disabled as a green manual landing decision', async () => {
    const result = await mergedIntoBase({ cwd: process.cwd(), autoMerge: false });
    expect(result).toMatchObject({ ok: true });
    expect(result.detail).toContain('manual landing');
  });

  it('requests a manual merge when an opted-in merge did not reach the remote base', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-postcond-merge-handoff-'));
    const remote = mkdtempSync(join(tmpdir(), 'cez-postcond-merge-remote-'));
    try {
      await git(repo, ['init', '-b', 'main']);
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'seed']);
      await git(remote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', remote]);
      await git(repo, ['push', '-u', 'origin', 'main']);
      writeFileSync(join(repo, 'feature.txt'), 'feature\n');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'feature']);

      const result = await mergedIntoBase({ cwd: repo, autoMerge: true, baseBranch: 'main' });

      expect(result.ok).toBe(false);
      expect(result.handoff).toMatchObject({ kind: 'manual-merge' });
      expect(result.detail).toContain('manual merge required');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });
});

/**
 * cezar's OWN declaration, checked as data. A typo in this file would otherwise surface only at
 * deploy time, on the one step whose job is to catch exactly that class of mistake.
 */
describe('cezar declares its own deploy targets', () => {
  it('parses through the real schema and names both services', () => {
    // packages/cezar/src/workflows/ → repo root.
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const parsed = deployTargetsSchema.parse(
      JSON.parse(readFileSync(join(repoRoot, DEPLOY_TARGETS_FILE), 'utf8')),
    );

    // Two services, which is the whole point: shipping one alone used to end the step green.
    expect(parsed.targets).toHaveLength(2);
    expect(parsed.targets.map((t) => t.name).join(' ')).toMatch(/service/i);
    expect(parsed.targets.map((t) => t.name).join(' ')).toMatch(/UI/);
    for (const target of parsed.targets) expect(target.probe.trim().length).toBeGreaterThan(0);
  });
});

describe('evaluatePostcondition', () => {
  it('is RED for a post-condition it cannot evaluate', async () => {
    // Silently passing an unknown id would recreate the exact false green this module removes.
    const result = await evaluatePostcondition('no-such-check', { cwd: process.cwd() });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('unknown post-condition');
  });

  it('dispatches the built-ins by name', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-postcond-dispatch-'));
    try {
      // `dryRun: false` explicitly: an ambient CEZ_DRY_RUN=1 (every cockpit-launched test run has
      // one) would otherwise short-circuit both calls and this case would assert nothing.
      await expect(
        evaluatePostcondition('everything-committed', { cwd: plain, dryRun: false }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        evaluatePostcondition('all-services-deployed', { cwd: plain, dryRun: false }),
      ).resolves.toMatchObject({ ok: false });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('passes every built-in in a dry run, because the agent is a mock that does no real work', async () => {
    // The regression this guards: between 57fc8807 and the fix, `commit-push`'s post-condition
    // was evaluated against a repo the MOCK agent had dirtied and never committed, so every
    // CEZ_DRY_RUN=1 run — `npm run test:package`'s `run mock:done` and every `npm run test:e2e`
    // boot — died at step 4 and could never reach `done`.
    const dirty = mkdtempSync(join(tmpdir(), 'cez-postcond-dryrun-'));
    try {
      await git(dirty, ['init', '--initial-branch=main']);
      writeFileSync(join(dirty, 'notes.md'), 'mock notes\n');

      // The control: with the world actually observed, this repo is red.
      await expect(
        evaluatePostcondition('everything-committed', { cwd: dirty, dryRun: false }),
      ).resolves.toMatchObject({ ok: false });

      const committed = await evaluatePostcondition('everything-committed', { cwd: dirty, dryRun: true });
      expect(committed.ok).toBe(true);
      expect(committed.detail).toContain('dry run');

      const deployed = await evaluatePostcondition('all-services-deployed', { cwd: dirty, dryRun: true });
      expect(deployed.ok).toBe(true);
      expect(deployed.detail).toContain('dry run');
    } finally {
      rmSync(dirty, { recursive: true, force: true });
    }
  });

  it('still catches an unknown post-condition in a dry run', async () => {
    // A typo in a workflow is a fact about the WORKFLOW, not the world — and a dry run is the
    // cheapest way to exercise a workflow end to end, so it must not swallow one.
    const result = await evaluatePostcondition('no-such-check', { cwd: process.cwd(), dryRun: true });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('unknown post-condition');
  });
});
