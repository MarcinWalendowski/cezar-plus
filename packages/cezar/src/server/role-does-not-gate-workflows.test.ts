import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type Principal, type SessionResolver } from './server.ts';

/**
 * D12's OTHER half, pinned (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`): "role
 * gates org administration, and is NEVER used to restrict code execution." `auth-perimeter.test.ts`
 * already proves the FIRST half — `CEZ_AUTH` on with no session 401s `POST /api/v1/workflows`,
 * the exact shell-capable route the spec's Problem §3 is about — and that file's own baseline
 * `SESSION` principal is even `role: 'member'` throughout, which is informative but never
 * asserted on there. This file asserts the thing D12 actually decides: once a `member` IS
 * authenticated, role plays no further part on this route.
 *
 * **Why this is a standing negative control, not a one-time check.** D12's own reasoning: every
 * member of an org already shares one unix user, one `CEZ_HOME` and one set of `claude`/`codex`
 * credentials (D4 — "members of an organization can run code as one another. Invite
 * accordingly."). A role check in front of this route would not create a boundary; it would only
 * *look* like one, while the member reaches the identical shell through any other agent surface —
 * an isolation control that isn't one is worse than none, because it is what the next reader
 * trusts when deciding who to invite (D12's own words). A future session adding, with good
 * intentions, `if (principal.role === 'member') return c.json({error: 'forbidden'}, 403)` in
 * front of this route would ship exactly that false boundary; this test is what turns that red
 * instead of letting it merge quietly. Do NOT "fix" a red run of this file by scoping it down —
 * a red run means D12 was violated, not that the test is wrong.
 */
describe('POST /api/v1/workflows — a `member` is not gated by role (D12)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedAuth = process.env.CEZ_AUTH;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-role-workflows-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    process.env.CEZ_AUTH = 'oidc';
    manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) =>
        store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] }),
    } as unknown as RunManager;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedAuth === undefined) delete process.env.CEZ_AUTH;
    else process.env.CEZ_AUTH = savedAuth;
  });

  const MEMBER: Principal = { kind: 'session', userId: 'u1', orgId: 'o1', teamId: 't1', role: 'member' };

  function memberResolver(): SessionResolver {
    return { resolveFromCookieHeader: (cookie) => (cookie === 'cez_session=good' ? MEMBER : null) };
  }

  const makeApp = () =>
    createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
      sessionResolver: memberResolver(),
    });

  it('a `member` fully saves a workflow whose check step runs a raw shell command — the exact Problem §3 surface', async () => {
    // A `check` step's `command` is what `workflows/run.ts` later passes to
    // `spawn('bash', ['-lc', command], { env: process.env })` — the shell-capable write D12 says
    // role must never gate. Saving it end to end (201, not merely "not 403") is the strongest
    // available pin: it proves an authenticated `member` completes this write exactly as an
    // `owner` would, with nothing in between reading `principal.role`.
    const res = await apiRequest(makeApp(), '/api/v1/workflows', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4321', 'content-type': 'application/json', cookie: 'cez_session=good' },
      body: JSON.stringify({ name: 'member-shell-check', steps: [{ id: 's1', command: 'echo hi' }] }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as { name: string }).toMatchObject({ name: 'member-shell-check' });
  });

  it('a malformed body from an authenticated `member` 400s on validation, not 403 on role', async () => {
    // If a role check were ever added ahead of this route's `jsonZodValidator`, this exact request
    // — a `member` sending a body that fails `saveWorkflowSchema` — would answer 403 first
    // (invariant 3's own authorization-before-validation ordering). Answering 400 instead proves
    // the request reached the validator, i.e. nothing gated it on role along the way.
    const res = await apiRequest(makeApp(), '/api/v1/workflows', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4321', 'content-type': 'application/json', cookie: 'cez_session=good' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });
});
