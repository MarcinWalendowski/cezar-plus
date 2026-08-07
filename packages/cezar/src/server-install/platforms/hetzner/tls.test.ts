import { describe, expect, it, vi } from 'vitest';
import {
  CERTBOT_INSTALL_COMMAND,
  RENEWAL_GUARD_HOOK_PATH,
  certbotIssueCommand,
  certbotRenewalDryRunCommand,
  createTlsStep,
  describePublicUrlDrift,
  publicUrlForDomain,
  renewalGuardHookScript,
  verifyTlsInstalled,
} from './tls.ts';
import { StepAborted, StepCancelled } from '../../steps.ts';
import { createAutoUi } from '../../ui.ts';
import { CANCEL, type InstallContext, type Runner, type Ui } from '../../types.ts';
import { AUTH_CALLBACK_PATH, resolveOidcConfig } from '../../../auth/oidc.ts';
import { logoutCookie } from '../../../auth/session.ts';

const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

function ctxWith(over: {
  ui?: Ui;
  runner?: Runner;
  dryRun?: boolean;
  state?: Partial<InstallContext['state']>;
}): InstallContext {
  return {
    state: { schema: 1, installed: false, primaryPort: 4321, steps: {}, ...over.state },
    ui: over.ui ?? createAutoUi(),
    instance: 'acme',
    runner: over.runner ?? okRunner,
    save: async () => {},
    dryRun: over.dryRun ?? false,
    assumeYes: true,
    reconfigure: new Set(),
    repoRoot: '/repo',
    now: '2026-08-07T00:00:00.000Z',
    prefs: {},
  };
}

const EMAIL_UI = { ...createAutoUi(), text: async () => 'ops@acme.example.com' } as Ui;

describe('publicUrlForDomain / describePublicUrlDrift', () => {
  it('is the single https:// computation, trimmed', () => {
    expect(publicUrlForDomain('acme.cezar.example.com')).toBe('https://acme.cezar.example.com');
    expect(publicUrlForDomain('  acme.cezar.example.com  ')).toBe('https://acme.cezar.example.com');
  });

  it('is null with nothing previously recorded (fresh provision)', () => {
    expect(describePublicUrlDrift(undefined, 'acme.cezar.example.com')).toBeNull();
  });

  it('is null when the domain has not actually changed', () => {
    expect(describePublicUrlDrift('https://acme.cezar.example.com', 'acme.cezar.example.com')).toBeNull();
  });

  it('names both values and the restart-required consequence when the origin changes', () => {
    const msg = describePublicUrlDrift('https://old.example.com', 'new.example.com');
    expect(msg).toContain('https://old.example.com');
    expect(msg).toContain('https://new.example.com');
    expect(msg).toContain('CEZ_PUBLIC_URL');
    expect(msg).toContain('restarted');
  });
});

describe('certbot command generators', () => {
  it('certbotIssueCommand matches the shape ubuntu-vps.ts uses, parameterized', () => {
    expect(certbotIssueCommand('acme.cezar.example.com', 'ops@acme.example.com')).toBe(
      "certbot --nginx -d 'acme.cezar.example.com' --non-interactive --agree-tos -m 'ops@acme.example.com' --redirect",
    );
  });

  it('shquotes an email or domain carrying shell metacharacters (defense in depth)', () => {
    const cmd = certbotIssueCommand('acme.cezar.example.com', "o'brien@acme.example.com");
    expect(cmd).toContain("'o'\\''brien@acme.example.com'");
  });

  it('certbotRenewalDryRunCommand never renews for real (--dry-run is always present)', () => {
    expect(certbotRenewalDryRunCommand('acme.cezar.example.com')).toBe(
      "certbot renew --cert-name 'acme.cezar.example.com' --dry-run",
    );
  });

  it('CERTBOT_INSTALL_COMMAND matches ubuntu-vps.ts sslStep\'s install line', () => {
    expect(CERTBOT_INSTALL_COMMAND).toBe('apt-get install -y certbot python3-certbot-nginx');
  });
});

describe('verifyTlsInstalled', () => {
  it('greps the vhost file, not /etc/letsencrypt/live (root-only permissions)', async () => {
    const seen: string[] = [];
    const runner: Runner = {
      capture: async (program, args) => {
        seen.push([program, ...args].join(' '));
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    const ctx = ctxWith({ runner });
    await verifyTlsInstalled(ctx, '/etc/nginx/sites-available/cezar-acme');
    expect(seen[0]).toContain('grep -qs ssl_certificate');
    expect(seen[0]).toContain('/etc/nginx/sites-available/cezar-acme');
    expect(seen.join(' ')).not.toContain('/etc/letsencrypt/live');
  });

  it('is false in dry-run — nothing is verifiably present', async () => {
    const ctx = ctxWith({ dryRun: true });
    await expect(verifyTlsInstalled(ctx, '/etc/nginx/sites-available/x')).resolves.toBe(false);
  });
});

describe('renewalGuardHookScript', () => {
  const script = renewalGuardHookScript('acme.cezar.example.com', '/etc/systemd/system/cezar-supervisor.service');

  it('filters on $RENEWED_DOMAINS so it is a no-op for every OTHER renewal on the host', () => {
    expect(script).toContain('case ",$RENEWED_DOMAINS," in');
    expect(script).toContain('*,acme.cezar.example.com,*)');
  });

  it('checks for the exact CEZ_PUBLIC_URL line the domain implies', () => {
    expect(script).toContain('CEZ_PUBLIC_URL=https://acme.cezar.example.com');
    expect(script).toContain('/etc/systemd/system/cezar-supervisor.service');
  });

  it('NEVER fails the renewal — every path ends in exit 0', () => {
    const lines = script.trim().split('\n');
    expect(lines[lines.length - 1]).toBe('exit 0');
    // the mismatch branch only logs, it never exits non-zero
    expect(script).not.toMatch(/exit [1-9]/);
  });

  it('only warns (via logger, i.e. syslog/journalctl), never edits the config file', () => {
    expect(script).toContain('logger -t cezar-tls');
    expect(script).not.toMatch(/>\s*\/etc\/systemd/); // no redirect that would write into it
  });
});

describe('createTlsStep', () => {
  it('is required, not optional — the session cookie is unconditionally Secure (D6)', () => {
    const step = createTlsStep({ domain: 'acme.cezar.example.com', vhostPath: '/v', role: 'org' });
    expect(step.optional).toBeFalsy();
    // Ground the claim in the real mechanism rather than trusting the docblock's paraphrase of
    // it: logoutCookie() (auth/session.ts) always carries Secure, never gated on request scheme.
    expect(logoutCookie()).toContain('Secure');
  });

  it('check() is idempotent: true once the vhost already shows the TLS edit', async () => {
    const runner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };
    const step = createTlsStep({ domain: 'acme.cezar.example.com', vhostPath: '/v', role: 'org' });
    await expect(step.check(ctxWith({ runner }))).resolves.toBe(true);
  });

  it('check() is false when the vhost has no TLS edit yet', async () => {
    const runner: Runner = { capture: async () => ({ code: 1, stdout: '', stderr: '' }), interactive: async () => 0 };
    const step = createTlsStep({ domain: 'acme.cezar.example.com', vhostPath: '/v', role: 'org' });
    await expect(step.check(ctxWith({ runner }))).resolves.toBe(false);
  });

  it('rejects an invalid hostname before running anything', async () => {
    const step = createTlsStep({ domain: 'not a host!!', email: 'a@b.com', vhostPath: '/v', role: 'org' });
    await expect(step.run(ctxWith({}))).rejects.toBeInstanceOf(StepAborted);
  });

  it('rejects an invalid email before running anything', async () => {
    const step = createTlsStep({ domain: 'acme.cezar.example.com', email: 'not-an-email', vhostPath: '/v', role: 'org' });
    await expect(step.run(ctxWith({}))).rejects.toBeInstanceOf(StepAborted);
  });

  it('prompts for an email when none is supplied, honoring CANCEL', async () => {
    const trueCancelUi = { ...createAutoUi(), text: async () => CANCEL } as Ui;
    const step = createTlsStep({ domain: 'acme.cezar.example.com', vhostPath: '/v', role: 'org' });
    await expect(step.run(ctxWith({ ui: trueCancelUi }))).rejects.toBeInstanceOf(StepCancelled);
  });

  it('prompts for an email when none is supplied and proceeds once one is given', async () => {
    const seen: string[] = [];
    const runner: Runner = {
      capture: async (program, args) => {
        seen.push([program, ...args].join(' '));
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    const step = createTlsStep({ domain: 'acme.cezar.example.com', vhostPath: '/v', role: 'org' });
    await step.run(ctxWith({ runner, ui: EMAIL_UI }));
    expect(seen.some((s) => s.includes('acme.cezar.example.com'))).toBe(true);
  });

  it('issues in order: install certbot -> obtain cert -> renewal dry-run', async () => {
    const seen: string[] = [];
    const runner: Runner = {
      capture: async (program, args) => {
        seen.push([program, ...args].join(' '));
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async (program, args) => {
        seen.push(`interactive: ${[program, ...args].join(' ')}`);
        return 0;
      },
    };
    const step = createTlsStep({ domain: 'acme.cezar.example.com', email: 'ops@acme.example.com', vhostPath: '/v', role: 'org' });
    await step.run(ctxWith({ runner, ui: EMAIL_UI }));

    const install = seen.findIndex((s) => s.includes(CERTBOT_INSTALL_COMMAND));
    const issue = seen.findIndex((s) => s.includes('certbot --nginx -d'));
    const dryRun = seen.findIndex((s) => s.includes('certbot renew') && s.includes('--dry-run'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(issue).toBeGreaterThan(install);
    expect(dryRun).toBeGreaterThan(issue);
  });

  it('a failed renewal dry-run warns but does not fail the step', async () => {
    const warn = vi.fn();
    const runner: Runner = {
      capture: async (program, args) => {
        if (args.join(' ').includes('--dry-run')) return { code: 1, stdout: '', stderr: 'boom' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    const ui = { ...EMAIL_UI, warn } as Ui;
    const step = createTlsStep({ domain: 'acme.cezar.example.com', email: 'ops@acme.example.com', vhostPath: '/v', role: 'org' });
    await expect(step.run(ctxWith({ runner, ui }))).resolves.toBeTruthy();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('renewal dry-run'))).toBe(true);
  });

  it('records the cert (and, if newly installed, the package) as shared artifacts', async () => {
    const step = createTlsStep({ domain: 'acme.cezar.example.com', email: 'ops@acme.example.com', vhostPath: '/v', role: 'org' });
    const created = await step.run(ctxWith({ ui: EMAIL_UI }));
    const cert = created?.artifacts.find((a) => a.type === 'cert');
    expect(cert?.kind).toBe('shared');
    expect(cert?.name).toBe('acme.cezar.example.com');
  });

  it('sets ctx.state.publicUrl for BOTH roles (display-only for org)', async () => {
    for (const role of ['supervisor', 'org'] as const) {
      const ctx = ctxWith({ ui: EMAIL_UI });
      const step = createTlsStep({ domain: 'acme.cezar.example.com', email: 'ops@acme.example.com', vhostPath: '/v', role });
      await step.run(ctx);
      expect(ctx.state.publicUrl).toBe('https://acme.cezar.example.com');
    }
  });

  it('role=org never surfaces a CEZ_PUBLIC_URL drift warning, even across a domain change', async () => {
    const error = vi.fn();
    const ui = { ...EMAIL_UI, error } as Ui;
    const ctx = ctxWith({ ui, state: { publicUrl: 'https://old-org.cezar.example.com' } });
    const step = createTlsStep({ domain: 'new-org.cezar.example.com', email: 'ops@acme.example.com', vhostPath: '/v', role: 'org' });
    await step.run(ctx);
    expect(error).not.toHaveBeenCalled();
  });

  it('role=supervisor surfaces the drift loudly when the domain changes across runs', async () => {
    const error = vi.fn();
    const ui = { ...EMAIL_UI, error } as Ui;
    const ctx = ctxWith({ ui, state: { publicUrl: 'https://old-login.cezar.example.com' } });
    const step = createTlsStep({
      domain: 'new-login.cezar.example.com',
      email: 'ops@acme.example.com',
      vhostPath: '/v',
      role: 'supervisor',
    });
    await step.run(ctx);
    expect(error).toHaveBeenCalledOnce();
    const msg = String(error.mock.calls[0]?.[0]);
    expect(msg).toContain('https://old-login.cezar.example.com');
    expect(msg).toContain('https://new-login.cezar.example.com');
  });

  it('role=supervisor stays silent on a first (fresh) provision — nothing to compare against', async () => {
    const error = vi.fn();
    const ui = { ...EMAIL_UI, error } as Ui;
    const ctx = ctxWith({ ui }); // no prior publicUrl
    const step = createTlsStep({ domain: 'login.cezar.example.com', email: 'ops@acme.example.com', vhostPath: '/v', role: 'supervisor' });
    await step.run(ctx);
    expect(error).not.toHaveBeenCalled();
  });

  it('writes the renewal guard hook only for role=supervisor WITH a publicUrlConfigFile', async () => {
    const written: Record<string, string> = {};
    const runner: Runner = {
      capture: async () => ({ code: 0, stdout: '', stderr: '' }),
      interactive: async (_program, args) => {
        // sudoStep runs `sudo bash -lc <command>` via interactive (assumeYes + passwordless
        // sudo picks 'sudo' mode automatically, no prompt) — decode the base64 write so the
        // test can assert on real file content, not just "a write happened".
        const command = args[args.length - 1] ?? '';
        const match = /printf %s '([A-Za-z0-9+/=]*)' \| base64 --decode > '([^']+)'/.exec(command);
        if (match) written[match[2]!] = Buffer.from(match[1]!, 'base64').toString('utf8');
        return 0;
      },
    };
    const ctx = ctxWith({ runner, ui: EMAIL_UI, state: {} });
    const step = createTlsStep({
      domain: 'login.cezar.example.com',
      email: 'ops@acme.example.com',
      vhostPath: '/v',
      role: 'supervisor',
      publicUrlConfigFile: '/etc/systemd/system/cezar-supervisor.service',
    });
    const created = await step.run(ctx);
    expect(written[RENEWAL_GUARD_HOOK_PATH]).toContain('CEZ_PUBLIC_URL=https://login.cezar.example.com');
    expect(created?.artifacts.some((a) => a.type === 'file' && a.path === RENEWAL_GUARD_HOOK_PATH)).toBe(true);
  });

  it('installs no hook for role=org, or for role=supervisor with no publicUrlConfigFile', async () => {
    const runner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

    const orgStep = createTlsStep({ domain: 'acme.cezar.example.com', email: 'ops@acme.example.com', vhostPath: '/v', role: 'org' });
    const orgCreated = await orgStep.run(ctxWith({ runner, ui: EMAIL_UI }));
    expect(orgCreated?.artifacts.some((a) => a.type === 'file')).toBe(false);

    const supStep = createTlsStep({ domain: 'login.cezar.example.com', email: 'ops@acme.example.com', vhostPath: '/v', role: 'supervisor' });
    const supCreated = await supStep.run(ctxWith({ runner, ui: EMAIL_UI }));
    expect(supCreated?.artifacts.some((a) => a.type === 'file')).toBe(false);
  });

  it('dry-run touches nothing real but still previews publicUrl and the drift warning', async () => {
    const error = vi.fn();
    const capture = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const runner: Runner = { capture, interactive: async () => 0 };
    const ui = { ...EMAIL_UI, error } as Ui;
    const ctx = ctxWith({ dryRun: true, runner, ui, state: { publicUrl: 'https://old.example.com' } });
    const step = createTlsStep({
      domain: 'new.example.com',
      email: 'ops@acme.example.com',
      vhostPath: '/v',
      role: 'supervisor',
      publicUrlConfigFile: '/etc/systemd/system/cezar-supervisor.service',
    });
    const created = await step.run(ctx);
    expect(ctx.state.publicUrl).toBe('https://new.example.com');
    expect(error).toHaveBeenCalledOnce(); // the preview still shows what WOULD go wrong
    expect(capture).not.toHaveBeenCalled(); // the renewal dry-run probe never actually ran
    expect(created?.artifacts.find((a) => a.type === 'cert')?.name).toBe('new.example.com');
  });

  it('undo lists (never deletes) the cert/package, and removes the owned hook file', async () => {
    const note = vi.fn();
    const seenCommands: string[] = [];
    const ui = { ...createAutoUi(), note } as Ui;
    const runner: Runner = {
      capture: async () => ({ code: 0, stdout: '', stderr: '' }),
      interactive: async (_program, args) => {
        seenCommands.push(args[args.length - 1] ?? '');
        return 0;
      },
    };
    const step = createTlsStep({ domain: 'login.cezar.example.com', vhostPath: '/v', role: 'supervisor' });
    await step.undo(ctxWith({ ui, runner }), {
      artifacts: [
        { kind: 'shared', type: 'cert', name: 'login.cezar.example.com', removeHint: 'sudo certbot delete --cert-name login.cezar.example.com' },
        { kind: 'shared', type: 'package', name: 'certbot + python3-certbot-nginx', removeHint: 'sudo apt-get remove -y certbot python3-certbot-nginx' },
        { kind: 'owned', type: 'file', path: RENEWAL_GUARD_HOOK_PATH },
      ],
    });
    expect(note.mock.calls.some((c) => String(c[0]).includes('certbot delete'))).toBe(true);
    expect(note.mock.calls.some((c) => String(c[0]).includes('apt-get remove'))).toBe(true);
    expect(seenCommands.some((c) => c.includes(`rm -f '${RENEWAL_GUARD_HOOK_PATH}'`))).toBe(true);
  });
});

describe('the CEZ_PUBLIC_URL <-> real OIDC config agreement (D9)', () => {
  // Mirrors ubuntu-vps.test.ts's "the gate agrees" test: feed this module's OWN output into the
  // real, already-landed resolveOidcConfig (auth/oidc.ts) rather than hand-asserting a shape that
  // could drift from what that function actually does with CEZ_PUBLIC_URL.
  function envFor(publicUrl: string): NodeJS.ProcessEnv {
    return {
      CEZ_PUBLIC_URL: publicUrl,
      CEZ_OIDC_CLIENT_ID: 'cezar',
      CEZ_OIDC_CLIENT_SECRET: 'secret',
      CEZ_OIDC_ISSUER: 'https://idp.example.com/realms/main',
    };
  }

  it('publicUrlForDomain\'s output resolves to the exact redirect_uri the IdP must register', () => {
    const domain = 'login.cezar.example.com';
    const result = resolveOidcConfig('oidc', envFor(publicUrlForDomain(domain)));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.config.redirectUri).toBe(new URL(AUTH_CALLBACK_PATH, publicUrlForDomain(domain)).toString());
    expect(result.config.redirectUri).toBe('https://login.cezar.example.com/auth/callback');
  });

  it('a domain drift this module flags is EXACTLY the case that changes the resolved redirect_uri', () => {
    const before = publicUrlForDomain('old-login.cezar.example.com');
    const after = publicUrlForDomain('new-login.cezar.example.com');
    expect(describePublicUrlDrift(before, 'new-login.cezar.example.com')).not.toBeNull();

    const beforeResult = resolveOidcConfig('oidc', envFor(before));
    const afterResult = resolveOidcConfig('oidc', envFor(after));
    if (!beforeResult.ok || !afterResult.ok) throw new Error('unreachable');
    expect(beforeResult.config.redirectUri).not.toBe(afterResult.config.redirectUri);
  });

  it('no drift ⇒ the real resolver agrees the redirect_uri is unchanged', () => {
    const url = publicUrlForDomain('login.cezar.example.com');
    expect(describePublicUrlDrift(url, 'login.cezar.example.com')).toBeNull();
    const a = resolveOidcConfig('oidc', envFor(url));
    const b = resolveOidcConfig('oidc', envFor(url));
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(a.config.redirectUri).toBe(b.config.redirectUri);
  });
});
