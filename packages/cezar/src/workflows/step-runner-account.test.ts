import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentAccountUsagePath } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import { localCliAuthor } from '../runs/task-author.ts';
import {
  accountUsageKey,
  defaultAgentAccountUsageStore,
  recordLimited,
} from '../workspace/agent-account-usage.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * A step that pins its own runner resolves its own ACCOUNT
 * (`.ai/specs/2026-08-23-step-runner-account-resolution.md`).
 *
 * This is the wiring test, and it is the one that would have caught the production failure —
 * `agent-route-step-provider.test.ts` covers the resolver in isolation, and a resolver that is
 * never called passes every one of those. Run `da0119ec` failed on 2026-08-23 with exactly the
 * shape below: run on codex, `spec` step pinning `runner: claude`, `claude:default` out of quota,
 * `claude:secondary` healthy and never consulted.
 *
 * Every assertion names the ACCOUNT. `backend === 'claude'` was already true on the bug.
 */
describe('a step pinning its own runner', () => {
  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  /**
   * Two claude logins; `default` is out of quota, `secondary` is healthy.
   *
   * **Codex is deliberately NOT given a `pool:*` route here.** A wildcard pool picks the PROVIDER
   * as well as the login (open todo `81ab4ebd`), so `codex: 'pool:*'` routes the RUN itself onto a
   * claude account — measured while writing this file — and the run's own provider stops being
   * codex. That is a real bug, but it is a different one, and letting it into this fixture would
   * mean these tests silently exercise two mechanisms at once.
   */
  function writeAccounts(defaults: Record<string, string>): void {
    writeFileSync(
      join(home, 'agent-accounts.json'),
      JSON.stringify({
        version: 1,
        accounts: [
          { id: 'secondary', provider: 'claude', label: 'Secondary', configDir: join(home, 'claude-secondary') },
        ],
        selections: {},
        defaults,
      }),
      'utf8',
    );
  }

  function limitClaudeDefault(): void {
    const usage = defaultAgentAccountUsageStore();
    recordLimited(usage, accountUsageKey('claude'), {
      source: 'usage-limit',
      until: '2026-08-26T23:00:00.000Z',
    });
    writeFileSync(agentAccountUsagePath(), JSON.stringify(usage), 'utf8');
  }

  /** `pinned` overrides the provider; `plain` follows the run's own. */
  const workflow: WorkflowDef = {
    name: 'mixed-runners',
    source: 'built-in',
    steps: [
      { id: 'pinned', name: 'Pinned', prompt: '{{task}}', runner: 'claude' },
      { id: 'plain', name: 'Plain', prompt: 'go' },
    ],
  };

  const stepOf = (runId: string, id: string) => store.getRun(runId)?.steps.find((s) => s.id === id);

  /**
   * Wait for ONE step to be dispatched — not for the run to finish.
   *
   * Waiting on the run was wrong and the box proved it: the second step's agent raises
   * `ask.requested`, the run parks on `waiting`, which is not terminal, and the test timed out on
   * the box while passing on the Mac. Nothing about the account resolution differed — `pinned` was
   * already `done` on `claude/secondary` in the failing run. The wait was the bug.
   *
   * Keyed on `profileId`, NOT `backend` — they are stamped by two different `updateStep` calls and
   * `backend` lands first, so waiting on it returned a step whose account had not been resolved yet
   * and the assertion read `undefined`. "Not there" was "not arrived yet". `profileId` is the later
   * of the two, so it is the safe barrier for both facts.
   */
  async function dispatched(runId: string, stepId: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (stepOf(runId, stepId)?.profileId === undefined) {
      if (Date.now() > deadline) {
        const r = store.getRun(runId);
        const ev = store.readEvents(runId).slice(-8).map((e) => `${e.type}:${String(e.message ?? '').slice(0, 90)}`);
        throw new Error(
          `step ${stepId} never dispatched. status=${r?.status} ` +
            `steps=${JSON.stringify(r?.steps?.map((x) => [x.id, x.status, x.backend, x.profileId]))} events=${JSON.stringify(ev)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  beforeEach(async () => {
    process.env.CEZ_DRY_RUN = '1';
    home = mkdtempSync(join(tmpdir(), 'cez-step-home-'));
    vi.stubEnv('CEZ_HOME', home);
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-step-repo-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await exec('git', ['add', '-A'], { cwd: repoRoot });
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    vi.unstubAllEnvs();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('routes around the limited default and lands on the healthy sibling', async () => {
    writeAccounts({ claude: 'pool:*' });
    limitClaudeDefault();
    manager = new RunManager(store, repoRoot);

    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'ship it',
      runner: 'codex',
      worktree: false,
    });
    await dispatched(record.id, 'pinned');

    const pinned = stepOf(record.id, 'pinned');
    expect(pinned?.backend).toBe('claude');
    // The assertion the bug fails: pre-fix this is `default`, the account that is out of quota.
    expect(pinned?.profileId).toBe('secondary');
  }, 30_000);

  it('leaves a step on the run\'s own provider alone', async () => {
    // The negative control. A fix that simply pool-resolved EVERY step would pass the case above
    // and break this one — the run's own composer choice must keep winning on its own provider.
    writeAccounts({ claude: 'pool:*' });
    limitClaudeDefault();
    manager = new RunManager(store, repoRoot);

    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'ship it',
      runner: 'codex',
      worktree: false,
    });
    await dispatched(record.id, 'plain');

    expect(stepOf(record.id, 'plain')?.backend).toBe('codex');
  }, 30_000);

  it('does not reroute when the provider is not on a pool', async () => {
    // An explicitly stored account still wins — `selectProfile` owns that, and this change must
    // not become a second, invisible routing rule on top of it.
    writeAccounts({ claude: 'secondary' });
    limitClaudeDefault();
    manager = new RunManager(store, repoRoot);

    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'ship it',
      runner: 'codex',
      worktree: false,
    });
    await dispatched(record.id, 'pinned');

    expect(stepOf(record.id, 'pinned')?.profileId).toBe('secondary');
  }, 30_000);
});
