import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  recordDispatch,
  recordLimited,
  type AgentAccountUsageStore,
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
    limitAccounts(accountUsageKey('claude'));
  }

  /** Called ON TOP of `limitClaudeDefault`, so that "every claude account" is literally true —
   *  the two stored logins on this fixture are `default` and `secondary`. */
  function limitClaudeSecondary(): void {
    limitAccounts(accountUsageKey('claude'), accountUsageKey('claude', 'secondary'));
  }

  /** Rewrites the whole file each time: `defaultAgentAccountUsageStore()` starts empty, so the
   *  second call must re-record the first key or it would silently un-limit it. */
  function limitAccounts(...keys: string[]): void {
    const usage = defaultAgentAccountUsageStore();
    for (const key of keys) {
      recordLimited(usage, key, { source: 'usage-limit', until: '2026-08-26T23:00:00.000Z' });
    }
    writeFileSync(agentAccountUsagePath(), JSON.stringify(usage), 'utf8');
  }

  /** Stamp a just-now dispatch on one account, MERGING into whatever is on disk — this runs after
   *  `limitAccounts`, so re-minting the store here would drop the limit it depends on. */
  function dispatchOn(key: string): void {
    const usage = JSON.parse(readFileSync(agentAccountUsagePath(), 'utf8')) as AgentAccountUsageStore;
    recordDispatch(usage, key);
    writeFileSync(agentAccountUsagePath(), JSON.stringify(usage), 'utf8');
  }

  /**
   * `pinned` overrides the provider; `plain` follows the run's own.
   *
   * `model: 'opus'` mirrors `spec-to-deploy`'s real `spec`/`review-spec` pins, and it is the only
   * OBSERVABLE difference between "the record says codex" and "codex is what ran". `opus` is a
   * Claude alias, so `modelConflictsWithRunner` drops it on a codex step and the transcript says
   * `model: auto`; a resolution that still thought the step was claude keeps it and normalises to
   * `model: anthropic/opus`. Everything downstream of the backend binding — `modelForBackend`,
   * `normalizeModelForBackend`, `agentEnvForStep`, `createRunner` — hangs off that one value.
   */
  const workflow: WorkflowDef = {
    name: 'mixed-runners',
    source: 'built-in',
    steps: [
      { id: 'pinned', name: 'Pinned', prompt: '{{task}}', runner: 'claude', model: 'opus' },
      { id: 'plain', name: 'Plain', prompt: 'go' },
    ],
  };

  /** The transcript's `model: <x>` line for the run, once it has been written. */
  async function modelNote(runId: string): Promise<string | undefined> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const note = store
        .readEvents(runId)
        .map((e) => String(e.message ?? ''))
        .find((m) => m.startsWith('model: '));
      if (note !== undefined) return note;
      if (Date.now() > deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

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

  /**
   * The pin has NOWHERE to go — never blocked (`.ai/specs/2026-08-23-never-block-a-task.md`).
   *
   * Distinct from every case above, and the distinction is the whole point: those move WITHIN the
   * pinned provider, which keeps the pin's promise. This one breaks it, on the owner's ruling that
   * availability outranks a quality pin — `spec-to-deploy` pins `claude` + `opus` on `spec` and
   * `review-spec` from "writing spec + spec review should be by opus always", and before this that
   * step simply died when Claude was out of quota.
   *
   * So the transcript note is asserted, not decorative. The mitigation for silently delivering a
   * lower-quality turn is that it is announced; a downgrade that happens quietly is the failure,
   * not the fallback.
   */
  it('downgrades the pinned provider when EVERY one of its accounts is out of quota', async () => {
    writeAccounts({ claude: 'pool:*' });
    limitClaudeDefault();
    limitClaudeSecondary();
    manager = new RunManager(store, repoRoot);

    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'ship it',
      runner: 'codex',
      worktree: false,
    });
    await dispatched(record.id, 'pinned');

    expect(stepOf(record.id, 'pinned')?.backend).toBe('codex');
    // The record is only half of it, and it is the half a record-only bug agrees with. `backend`
    // was stamped correctly here while `createRunner()` still spawned CLAUDE, because the backend
    // expression was evaluated a second time further down and the second copy had not learned
    // about the downgrade. This assertion reads the resolution that actually feeds the spawn:
    // `opus` is a Claude alias, so a codex step must drop it.
    expect(await modelNote(record.id)).toBe('model: auto');
    const note = store
      .readEvents(record.id)
      .map((e) => String(e.message ?? ''))
      .find((m) => m.includes('every claude account is out of quota'));
    // Both ends named — what was asked for and what it actually ran on. A note that says only
    // "downgraded" leaves the reader unable to check the decision, which is the same failure the
    // reroute note in `account-fallback.test.ts` guards against.
    expect(note).toContain('asks for opus on claude');
    expect(note).toContain('codex:default');
  }, 30_000);

  it('keeps the pin while ONE account of that provider is still open', async () => {
    // The negative control, and the one that separates this feature from "downgrade whenever the
    // named login is limited". `claude:default` is out of quota and `claude:secondary` is not, so
    // the correct answer is to stay on claude and move within it — throwing away a working Claude
    // account to satisfy a rule about availability would be the opposite of what the rule is for.
    //
    // It fails against the obvious wrong implementation (keying the downgrade on the account the
    // step would have used rather than on every account of the provider), which the test above
    // cannot distinguish.
    //
    // `claude:secondary` is given a fresh dispatch, and that is load-bearing rather than colour.
    // Without it, `selectPoolAccount` ranks `claude:secondary` above `codex:default` anyway, and
    // the LATER guard (`choice.provider === pinned`) keeps the pin — so deleting the guard this
    // test is about changed nothing and the control passed against the mutation. Measured, not
    // assumed. A recent dispatch pushes claude to the back of "least recently dispatched", which
    // makes codex the ranked winner and the two guards observably different.
    writeAccounts({ claude: 'pool:*' });
    limitClaudeDefault();
    dispatchOn(accountUsageKey('claude', 'secondary'));
    manager = new RunManager(store, repoRoot);

    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'ship it',
      runner: 'codex',
      worktree: false,
    });
    await dispatched(record.id, 'pinned');

    expect(stepOf(record.id, 'pinned')?.backend).toBe('claude');
    // And the model pin survives with it — the point of staying on claude. `model: auto` here
    // would mean the step had been moved off claude somewhere downstream of the record.
    expect(await modelNote(record.id)).toBe('model: anthropic/opus');
    expect(
      store.readEvents(record.id).map((e) => String(e.message ?? '')).some((m) => m.includes('out of quota')),
    ).toBe(false);
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
