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
  deployTargetsSchema,
  evaluatePostcondition,
  everythingCommitted,
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

  function declare(targets: Array<{ name: string; probe: string }>): void {
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
