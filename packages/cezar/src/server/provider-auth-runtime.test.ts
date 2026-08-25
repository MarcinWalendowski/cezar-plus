import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderAuthService,
  type ProviderId,
  type RunProviderCommand,
} from '../core/provider-auth.ts';
import { RunStore } from '../runs/store.ts';
import {
  ProviderRuntimeAuthObserver,
  recoverWithProviderRuntimeAuthObservation,
  watchProviderRuntimeAuthFailures,
} from './provider-auth-runtime.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const CONNECTED_OUTPUT: Record<ProviderId, string> = {
  claude: '{"loggedIn":true}',
  codex: 'Logged in using ChatGPT',
  opencode: [
    '┌  Credentials ~/.local/share/opencode/auth.json',
    '●  Anthropic oauth',
    '└  1 credential',
  ].join('\n'),
  pi: 'provider  model  context  max-out  thinking  images\nanthropic  claude  200K  64K  yes  yes',
};

const providerForExecutable = (executable: string): ProviderId => {
  if (executable === 'claude' || executable === 'codex' || executable === 'opencode' || executable === 'pi') return executable;
  throw new Error(`unexpected executable: ${executable}`);
};

describe('watchProviderRuntimeAuthFailures', () => {
  let root: string;
  let store: RunStore;
  let providerAuth: ProviderAuthService;
  const unwatchers: Array<() => void> = [];
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-provider-auth-runtime-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    delete process.env.CEZ_DRY_RUN;
    const runCommand = vi.fn<RunProviderCommand>(async (executable) => ({
      stdout: CONNECTED_OUTPUT[providerForExecutable(executable)],
      stderr: '',
      exitCode: 0,
    }));
    providerAuth = new ProviderAuthService({
      platform: 'linux',
      runCommand,
      createAuthFailureId: () => 'auth-incident-1',
    });
  });

  afterEach(() => {
    for (const unwatch of unwatchers.splice(0)) unwatch();
    store.flush();
    rmSync(root, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const watch = () => {
    const onInvalidated = vi.fn();
    unwatchers.push(watchProviderRuntimeAuthFailures(store, providerAuth, onInvalidated));
    return onInvalidated;
  };

  it('invalidates the step backend for an auth error in a mixed-provider run', () => {
    const onInvalidated = watch();
    const run = store.createRun({ author: localCliAuthor(),
      title: 'mixed',
      workflow: 'mixed',
      task: 'work',
      runner: 'claude',
      steps: [{ id: 'implement', name: 'Implement', kind: 'agent' }],
    });
    store.updateStep(run.id, 'implement', { backend: 'codex' });

    store.appendEvent(run.id, {
      type: 'error',
      stepId: 'implement',
      message: 'authentication failed with HTTP 401',
    });

    expect(onInvalidated).toHaveBeenCalledWith({
      provider: 'codex',
      status: 'disconnected',
      hint: expect.any(String),
      authFailureId: 'auth-incident-1',
    });
    expect(store.readEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'provider-auth-required',
        provider: 'codex',
        authFailureId: 'auth-incident-1',
        stepId: 'implement',
      }),
    ]));
  });

  it('falls back to the run backend when the event has no matching step', () => {
    const onInvalidated = watch();
    const run = store.createRun({ author: localCliAuthor(),
      title: 'fallback',
      workflow: 'quick-task',
      task: 'work',
      runner: 'opencode',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });

    store.appendEvent(run.id, {
      type: 'error',
      stepId: 'missing',
      message: 'unauthorized credential returned HTTP 401',
    });

    expect(onInvalidated).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      status: 'disconnected',
    }));
  });

  it('treats a legacy run with no backend as Claude', () => {
    const onInvalidated = watch();
    const run = store.createRun({ author: localCliAuthor(),
      title: 'legacy',
      workflow: 'quick-task',
      task: 'work',
      steps: [],
    });

    store.appendEvent(run.id, {
      type: 'error',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });

    expect(onInvalidated).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude',
      status: 'disconnected',
    }));
  });

  it.each(['error', 'session.error', 'note'])(
    'observes auth failures carried by %s events',
    (type) => {
      const onInvalidated = watch();
      const run = store.createRun({ author: localCliAuthor(),
        title: type,
        workflow: 'quick-task',
        task: 'work',
        runner: 'codex',
        steps: [],
      });

      store.appendEvent(run.id, {
        type,
        message: 'OAuth access token is invalid',
      });

      expect(onInvalidated).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'codex',
        status: 'disconnected',
      }));
    },
  );

  it('ignores unrelated errors and non-message events', () => {
    const onInvalidated = watch();
    const run = store.createRun({ author: localCliAuthor(),
      title: 'ignore',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    store.appendEvent(run.id, {
      type: 'error',
      message: 'the compiler rejected this TypeScript program',
    });
    store.appendEvent(run.id, {
      type: 'error',
      text: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });
    store.appendEvent(run.id, {
      type: 'tool.result',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });

    expect(onInvalidated).not.toHaveBeenCalled();
  });

  it('appends one safe task event when v1 and v2 report the same provider failure', () => {
    const onInvalidated = watch();
    const run = store.createRun({ author: localCliAuthor(),
      title: 'duplicate',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    store.appendEvent(run.id, {
      type: 'error',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });
    store.appendEvent(run.id, {
      type: 'session.error',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });

    expect(onInvalidated).toHaveBeenCalledTimes(1);
    const required = store.readEvents(run.id).filter(({ type }) => type === 'provider-auth-required');
    expect(required).toHaveLength(1);
    const { seq: _seq, ts: _ts, ...safe } = required[0]!;
    expect(safe).toEqual({
      type: 'provider-auth-required',
      provider: 'claude',
      authFailureId: 'auth-incident-1',
    });
  });

  it('records the current incident on each affected task but invalidates the workspace once', () => {
    const onInvalidated = watch();
    const first = store.createRun({ author: localCliAuthor(),
      title: 'first',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });
    const second = store.createRun({ author: localCliAuthor(),
      title: 'second',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    for (const run of [first, second]) {
      store.appendEvent(run.id, {
        type: 'error',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
    }

    expect(onInvalidated).toHaveBeenCalledTimes(1);
    for (const run of [first, second]) {
      expect(store.readEvents(run.id).filter(({ type }) => type === 'provider-auth-required'))
        .toEqual([expect.objectContaining({
          provider: 'claude',
          authFailureId: 'auth-incident-1',
        })]);
    }
  });

  it('unsubscribes cleanly', () => {
    const onInvalidated = vi.fn();
    const unwatch = watchProviderRuntimeAuthFailures(store, providerAuth, onInvalidated);
    const run = store.createRun({ author: localCliAuthor(),
      title: 'unsubscribed',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    unwatch();
    store.appendEvent(run.id, {
      type: 'error',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });

    expect(onInvalidated).not.toHaveBeenCalled();
  });

  it('deduplicates observation when startup and app construction watch the same store', () => {
    const onInvalidated = vi.fn();
    const observer = new ProviderRuntimeAuthObserver(providerAuth, onInvalidated);
    const run = store.createRun({ author: localCliAuthor(),
      title: 'deduplicated',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    observer.watch(store);
    observer.watch(store);
    store.appendEvent(run.id, {
      type: 'error',
      message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    });

    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  // V1, `.ai/specs/2026-08-25-logged-out-account-fallback.md`, Phase 1: the ACCOUNT a runtime
  // rejection is attributed to, mirroring the step-first-run-second precedence already applied to
  // the PROVIDER above. A step-less event is the routine case (only `error` with a `stepId` is the
  // well-trodden path; `session.error`/`note` never carry one), not a corner one.
  describe('per-account attribution', () => {
    it('a STEP-LESS failure rejects the RUN account (agentProfile), not the provider default', () => {
      watch();
      const run = store.createRun({ author: localCliAuthor(),
        title: 'secondary',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        agentProfile: 'secondary',
        steps: [],
      });

      store.appendEvent(run.id, {
        type: 'error',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });

      expect(providerAuth.isRuntimeRejected('claude', 'secondary')).toBe(true);
      expect(providerAuth.isRuntimeRejected('claude', undefined)).toBe(false);
    });

    it.each(['session.error', 'note'] as const)(
      'a step-less %s failure also attributes to the RUN account, not the default',
      (type) => {
        watch();
        const run = store.createRun({ author: localCliAuthor(),
          title: type,
          workflow: 'quick-task',
          task: 'work',
          runner: 'claude',
          agentProfile: 'secondary',
          steps: [],
        });

        store.appendEvent(run.id, { type, message: 'OAuth access token is invalid' });

        expect(providerAuth.isRuntimeRejected('claude', 'secondary')).toBe(true);
        expect(providerAuth.isRuntimeRejected('claude', undefined)).toBe(false);
      },
    );

    it('the positive control: a stepId naming a step whose profileId is default rejects the default, not the run account', () => {
      watch();
      const run = store.createRun({ author: localCliAuthor(),
        title: 'step-first',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        agentProfile: 'secondary',
        steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      });
      store.updateStep(run.id, 'work', { backend: 'claude', profileId: 'default' });

      store.appendEvent(run.id, {
        type: 'error',
        stepId: 'work',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });

      expect(providerAuth.isRuntimeRejected('claude', undefined)).toBe(true);
      expect(providerAuth.isRuntimeRejected('claude', 'secondary')).toBe(false);
    });
  });

  it('attaches boot-store observation before recovery can emit an auth failure', async () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: 'boot recovery',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });
    const observer = new ProviderRuntimeAuthObserver(providerAuth, vi.fn());

    await recoverWithProviderRuntimeAuthObservation(
      store,
      async () => {
        store.appendEvent(run.id, {
          type: 'error',
          message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
        });
      },
      observer,
    );

    await expect(providerAuth.status().then(({ providers }) => providers[0]))
      .resolves.toMatchObject({ provider: 'claude', status: 'disconnected' });
  });
});
