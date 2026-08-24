import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { codexApprovalNote, codexApprovalReply } from './codex-approvals.ts';

const cleanEnv: NodeJS.ProcessEnv = {};

describe('codexApprovalReply', () => {
  it('prefers a session-scoped command approval when codex offers it', () => {
    expect(codexApprovalReply(
      'item/commandExecution/requestApproval',
      { availableDecisions: ['accept', 'acceptForSession', 'decline'] },
      cleanEnv,
    )).toEqual({ result: { decision: 'acceptForSession' } });
  });

  it('uses a session-scoped command approval when no decisions are offered', () => {
    expect(codexApprovalReply('item/commandExecution/requestApproval', { availableDecisions: null }, cleanEnv))
      .toEqual({ result: { decision: 'acceptForSession' } });
    expect(codexApprovalReply('item/commandExecution/requestApproval', {}, cleanEnv))
      .toEqual({ result: { decision: 'acceptForSession' } });
  });

  it('falls back to accept when only the turn-scoped decision is offered', () => {
    expect(codexApprovalReply(
      'item/commandExecution/requestApproval',
      { availableDecisions: ['accept'] },
      cleanEnv,
    )).toEqual({ result: { decision: 'accept' } });
  });

  it('answers a hostile decision list permissively and names the list in its note', () => {
    const params = { availableDecisions: ['decline', 'cancel'] };
    const reply = codexApprovalReply('item/commandExecution/requestApproval', params, cleanEnv);
    expect(reply).toEqual({ result: { decision: 'accept' } });
    expect(codexApprovalNote('item/commandExecution/requestApproval', params, reply!, cleanEnv))
      .toContain('offered decisions: ["decline","cancel"]');
  });

  it('answers file changes with the v2 session decision', () => {
    expect(codexApprovalReply('item/fileChange/requestApproval', {}, cleanEnv))
      .toEqual({ result: { decision: 'acceptForSession' } });
  });

  it('echoes the requested permission profile and grants it for the session', () => {
    const permissions = { fileSystem: { root: '/outside' }, network: { enabled: true } };
    expect(codexApprovalReply('item/permissions/requestApproval', { permissions }, cleanEnv))
      .toEqual({ result: { permissions, scope: 'session' } });
  });

  it('strips only network permission when the explicit network restriction is enabled', () => {
    const permissions = { fileSystem: { root: '/outside' }, network: { enabled: true } };
    const reply = codexApprovalReply('item/permissions/requestApproval', { permissions }, {
      CEZ_CODEX_NETWORK: '0',
    });
    expect(reply).toEqual({ result: { permissions: { fileSystem: { root: '/outside' } }, scope: 'session' } });
    expect(permissions).toEqual({ fileSystem: { root: '/outside' }, network: { enabled: true } });
  });

  it.each(['execCommandApproval', 'applyPatchApproval'])('answers the v1 %s request', (method) => {
    expect(codexApprovalReply(method, {}, cleanEnv))
      .toEqual({ result: { decision: 'approved_for_session' } });
  });

  it('answers an unknown approval sibling instead of leaving it pending', () => {
    expect(codexApprovalReply('item/futureThing/requestApproval', {}, cleanEnv))
      .toEqual({ result: { decision: 'acceptForSession' } });
  });

  it('does not classify non-approval requests as approvals', () => {
    expect(codexApprovalReply('mcpServer/elicitation/request', {}, cleanEnv)).toBeUndefined();
    expect(codexApprovalReply('item/tool/call', {}, cleanEnv)).toBeUndefined();
  });

  it('documents the network restriction in the permission note', () => {
    const params = { permissions: { network: { enabled: true } } };
    const reply = codexApprovalReply('item/permissions/requestApproval', params, { CEZ_CODEX_NETWORK: '0' });
    expect(codexApprovalNote('item/permissions/requestApproval', params, reply!, { CEZ_CODEX_NETWORK: '0' }))
      .toContain('network permission withheld because CEZ_CODEX_NETWORK=0');
  });
});

describe('Codex approval documentation', () => {
  it('does not advertise the removed Claude approval gate', () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
    const removedGateName = ['CEZ_APPROVAL', 'GATE'].join('_');
    expect(readFileSync(join(repoRoot, '.env.example'), 'utf8')).not.toContain(removedGateName);
  });
});

