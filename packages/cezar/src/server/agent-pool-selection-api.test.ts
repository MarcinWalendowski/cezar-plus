import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { loadAgentAccounts } from '../workspace/agent-accounts.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * `PUT …/agent-profiles/selection` with a POOL id
 * (`.ai/specs/2026-08-16-agent-account-usage-routing.md`, Phase C).
 *
 * The route's existing rule is that a profileId which names no account is a 400, and it is a good
 * rule: a person naming a dead account deserves to be told, unlike a run, which has no better
 * answer than the default. A pool is neither — it names a SET, not an account — so it has to be let
 * through, and letting it through must not open the door for anything else.
 *
 * Both halves are asserted here, because "accepts a pool" implemented as "stopped checking" would
 * pass the happy path and silently accept every typo as a routing instruction.
 */

describe('storing a pool as a project selection', () => {
  const saved = { home: process.env.CEZ_HOME, usage: process.env.CEZ_ACCOUNT_USAGE };
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pool-sel-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pool-sel-repo-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_ACCOUNT_USAGE = '1';
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [
      ['CEZ_HOME', saved.home],
      ['CEZ_ACCOUNT_USAGE', saved.usage],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const app = () =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });

  const put = async (profileId: string | null) => {
    const res = await apiRequest(app(), '/api/v1/workspace/agent-profiles/selection', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: null, provider: 'claude', profileId }),
    });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  };

  it('accepts a provider pool and stores it verbatim', async () => {
    expect((await put('pool:claude')).status).toBe(200);
    expect((await loadAgentAccounts()).defaults.claude).toBe('pool:claude');
  });

  it('accepts the everything pool', async () => {
    expect((await put('pool:*')).status).toBe(200);
    expect((await loadAgentAccounts()).defaults.claude).toBe('pool:*');
  });

  it('still refuses an account that does not exist', async () => {
    // The negative control. "Accepts a pool" must not have been implemented as "stopped checking":
    // a typo'd account id has to keep being a 400, or every dead reference silently becomes a
    // stored routing instruction that resolves to the default login forever.
    const { status, body } = await put('nope');
    expect(status).toBe(400);
    expect(body.error).toContain('unknown claude account');
  });

  it('still refuses a `pool:` value that names no real provider', async () => {
    // `pool:anthropic` parses as an ACCOUNT (see `parseAgentRoute`), so it must take the account
    // path and be refused — not be waved through because it starts with the right five characters.
    expect((await put('pool:anthropic')).status).toBe(400);
  });

  it('refuses a pool with the capability off, rather than storing a setting nothing acts on', async () => {
    // The signals a pool balances on (dispatch cursor, limit record, quota) are only maintained
    // while the flag is on. Storing one anyway would be a setting that reads as applied and is not
    // — the failure mode this whole feature is trying to avoid.
    delete process.env.CEZ_ACCOUNT_USAGE;
    const { status, body } = await put('pool:claude');
    expect(status).toBe(409);
    expect(body.error).toContain('CEZ_ACCOUNT_USAGE');
    expect((await loadAgentAccounts()).defaults.claude).toBeUndefined();
  });

  it('still clears back to the discovered account with null', async () => {
    await put('pool:claude');
    expect((await put(null)).status).toBe(200);
    expect((await loadAgentAccounts()).defaults.claude).toBeUndefined();
  });
});

/**
 * `POST /api/v1/runs` — the other route that validates an account id, and the one this feature
 * forgot. `guardRunStart` refused every pool with `400 unknown claude account`, so the composer's
 * own value bounced off its own create route: the pill offered "balance", and starting the task
 * failed. Found by the runtime E2E, not by the suite, because every existing test posted a real
 * account id.
 */
describe('starting a run with a pool route', () => {
  const saved = { home: process.env.CEZ_HOME, usage: process.env.CEZ_ACCOUNT_USAGE, dry: process.env.CEZ_DRY_RUN };
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let started: StartRunInput | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pool-run-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-pool-run-repo-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_ACCOUNT_USAGE = '1';
    process.env.CEZ_DRY_RUN = '1';
    started = undefined;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [
      ['CEZ_HOME', saved.home],
      ['CEZ_ACCOUNT_USAGE', saved.usage],
      ['CEZ_DRY_RUN', saved.dry],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const post = async (agentProfile: string) => {
    const manager = {
      startRun: (workflow: WorkflowDef, input: StartRunInput) => {
        started = input;
        return store.createRun({ title: 't', workflow: workflow.name, task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    const app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
    const res = await apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'do a thing', agentProfile }),
    });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  };

  it('accepts a pool and passes it through UNRESOLVED', async () => {
    // Unresolved on purpose: the login is chosen at dispatch, when the balancer can see the real
    // state of the workspace. Resolving at create time would route a queued run on ten-minute-old
    // in-flight counts.
    expect((await post('pool:claude')).status).toBe(201);
    expect(started?.agentProfile).toBe('pool:claude');
  });

  it('accepts the everything pool', async () => {
    expect((await post('pool:*')).status).toBe(201);
    expect(started?.agentProfile).toBe('pool:*');
  });

  it('still refuses an account that does not exist', async () => {
    // The negative control: "accepts a pool" must not have become "stopped checking".
    const { status, body } = await post('nope');
    expect(status).toBe(400);
    expect(body.error).toContain('unknown claude account');
  });

  it('refuses a pool with the capability off', async () => {
    delete process.env.CEZ_ACCOUNT_USAGE;
    const { status, body } = await post('pool:claude');
    expect(status).toBe(409);
    expect(body.error).toContain('CEZ_ACCOUNT_USAGE');
  });
});
