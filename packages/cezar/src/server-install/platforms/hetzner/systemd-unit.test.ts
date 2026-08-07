import { describe, expect, it } from 'vitest';
import { orgSystemdUnit, supervisorSystemdUnit } from './systemd-unit.ts';
import { orgCezHome, orgHomeDir, orgProjectRoot, orgUnixUsername } from './provision-user.ts';
import { resolveAuthBootGate } from '../../../auth-boot-gate.ts';
import { createForwardedSessionResolver, resolveSupervisorModeGate } from '../../../supervisor/forwarded-session.ts';
import { signForwardedPrincipal } from '../../../supervisor/forwarded-principal.ts';
import { sessionCookieDomainAttribute } from '../../../auth/session.ts';

const orgOpts = {
  workingDirectory: '/home/cez-acme/workspace',
  execStart: '/usr/bin/node /srv/cezar/dist/index.js',
  port: 4001,
  unixUser: 'cez-acme',
  cezHome: '/home/cez-acme/.cezar',
  environmentFile: '/etc/cezar/acme.env',
};

const supervisorOpts = {
  workingDirectory: '/home/cez-supervisor',
  execStart: '/usr/bin/node /srv/cezar/dist/index.js',
  port: 4000,
  unixUser: 'cez-supervisor',
  cezHome: '/home/cez-supervisor/.cezar',
  publicUrl: 'https://login.cezar.example.com',
  authProvider: 'oidc' as const,
  sessionCookieDomain: '.login.cezar.example.com',
  environmentFile: '/etc/cezar/supervisor.env',
};

/** Reads a unit's own `Environment=` lines into an env object the way `ubuntu-vps.test.ts` does,
 *  so the pairing test runs the REAL `resolveAuthBootGate` over exactly what the unit carries —
 *  never a hand-written stand-in that could silently drift from what this generator emits. */
function envFromUnit(unit: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    unit
      .split('\n')
      .filter((line) => line.startsWith('Environment='))
      .map((line) => {
        const [key, ...rest] = line.slice('Environment='.length).split('=');
        return [key!, rest.join('=')];
      }),
  ) as NodeJS.ProcessEnv;
}

describe('orgSystemdUnit', () => {
  it('runs cezar serve as the org unix user, in the org CEZ_HOME, on the hard-bound port', () => {
    const unit = orgSystemdUnit(orgOpts);
    expect(unit).toContain('User=cez-acme');
    expect(unit).toContain('WorkingDirectory=/home/cez-acme/workspace');
    expect(unit).toContain('Environment=CEZ_HOME=/home/cez-acme/.cezar');
    expect(unit).toContain('EnvironmentFile=/etc/cezar/acme.env');
    expect(unit).toContain('ExecStart=/usr/bin/node /srv/cezar/dist/index.js serve --no-open --port 4001');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('carries CEZ_REMOTE=1 (hosted) and CEZ_AUTH=supervisor, never CEZ_ALLOW_UNAUTHENTICATED', () => {
    const unit = orgSystemdUnit(orgOpts);
    expect(unit).toContain('Environment=CEZ_REMOTE=1');
    expect(unit).toContain('Environment=CEZ_AUTH=supervisor');
    // The supervisor's auth_request IS this process's perimeter — writing the opt-out too would
    // assert "there is no auth" right next to a real auth channel, which is false (D10).
    expect(unit).not.toContain('CEZ_ALLOW_UNAUTHENTICATED');
  });

  it('carries CEZ_PORT_STRICT=1 so nginx\'s static proxy_pass can never silently drift (D10)', () => {
    const unit = orgSystemdUnit(orgOpts);
    expect(unit).toContain('Environment=CEZ_PORT_STRICT=1');
  });

  it('never binds anywhere but loopback — no --bind-host, unlike ubuntu-vps external-proxy mode', () => {
    const unit = orgSystemdUnit(orgOpts);
    expect(unit).not.toContain('--bind-host');
  });

  it('the secret never appears in Environment= — only the EnvironmentFile path does', () => {
    const unit = orgSystemdUnit(orgOpts);
    expect(unit).not.toContain('CEZ_SUPERVISOR_SECRET');
    expect(unit).toContain('EnvironmentFile=/etc/cezar/acme.env');
  });

  it('escapes % so systemd specifier expansion cannot corrupt PATH/ExecStart', () => {
    const oldPath = process.env.PATH;
    process.env.PATH = `/weird%dir/bin:${oldPath ?? ''}`;
    try {
      const unit = orgSystemdUnit(orgOpts);
      expect(unit).toContain('/weird%%dir/bin');
      expect(unit).not.toMatch(/Environment=PATH=[^\n]*\/weird%dir/);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  /**
   * D4's phase-6 verification row — "two orgs ⇒ two unix users, two `CEZ_HOME`s, NO SHARED PATH".
   *
   * Generated from the real `provision-user.ts` derivations for two different slugs, so the
   * assertion cannot pass by two hand-written fixtures happening to differ. Run history lives at
   * `<WorkingDirectory>/.ai/cezar` (`index.ts`: `openStore(repoRoot)`), and `RunStore` takes no
   * lease, so a shared `WorkingDirectory` is silent cross-org history loss — which is exactly what
   * this generator emitted before the repair (it took `repoRoot`, and its own doc said "the same
   * value on every org's unit on one host").
   */
  it('gives two orgs three disjoint paths: unix user, CEZ_HOME and WorkingDirectory (D4)', () => {
    const build = (slug: string) => {
      const user = orgUnixUsername(slug);
      return orgSystemdUnit({
        ...orgOpts,
        unixUser: user,
        cezHome: orgCezHome(user),
        workingDirectory: orgProjectRoot(user),
        environmentFile: `/etc/cezar/hetzner-${slug}.env`,
      });
    };
    const readDirective = (unit: string, prefix: string): string =>
      unit.split('\n').find((line) => line.startsWith(prefix))!;

    const acme = build('acme');
    const beta = build('beta');

    for (const prefix of ['User=', 'WorkingDirectory=', 'Environment=CEZ_HOME=']) {
      expect(readDirective(acme, prefix)).not.toEqual(readDirective(beta, prefix));
    }
    // And every org's state path is under its own 0700 home, not a shared checkout.
    expect(readDirective(acme, 'WorkingDirectory=')).toContain(orgHomeDir(orgUnixUsername('acme')));
    expect(readDirective(beta, 'WorkingDirectory=')).toContain(orgHomeDir(orgUnixUsername('beta')));
  });

  it('hardens the sandbox — PrivateTmp keeps /tmp from being a cross-org channel', () => {
    const unit = orgSystemdUnit(orgOpts);
    // `server/git-changes.ts` writes a scratch git index into /tmp under a predictable name, so a
    // shared /tmp is a cross-org read (index contents) and a cross-org DoS (a pre-created lock).
    expect(unit).toContain('PrivateTmp=yes');
    expect(unit).toContain('NoNewPrivileges=yes');
  });

  // The pairing discipline `ubuntu-vps.test.ts` applies to its own unit ("the gate agrees: this
  // exact environment boots, and dropping the flag refuses") — applied here to the org unit.
  it('the gate agrees this unit boots (CEZ_AUTH=supervisor is a recognised provider)', () => {
    const unit = orgSystemdUnit(orgOpts);
    const env = envFromUnit(unit);
    expect(resolveAuthBootGate(env).proceed).toBe(true);
  });

  it('the gate refuses if CEZ_AUTH were dropped entirely (hosted, no provider, no opt-out)', () => {
    const unit = orgSystemdUnit(orgOpts);
    const env = envFromUnit(unit);
    const { CEZ_AUTH: _dropped, ...withoutAuth } = env;
    expect(resolveAuthBootGate(withoutAuth).proceed).toBe(false);
  });

  /**
   * The SECOND half of the pairing discipline, and the one whose absence let phase 6 ship a
   * deployment that 401'd every request forever: feed the unit's own environment into the real
   * code that has to CONSUME it, not only into the boot gate that has to tolerate it.
   *
   * `Environment=CEZ_AUTH=supervisor` is a promise that this process verifies a supervisor-signed
   * principal. Before the repair nothing did — `index.ts` wired the cookie resolver — and every
   * gate stayed green because the only test of the seam injected a hand-written cookie resolver.
   */
  it("the unit's own CEZ_AUTH=supervisor is honoured by the real resolver that value names", () => {
    const unit = orgSystemdUnit(orgOpts);
    const env = { ...envFromUnit(unit), CEZ_SUPERVISOR_SECRET: 'secret-for-acme', CEZ_SUPERVISOR_PORT: '4000' };
    // The EnvironmentFile half is not in `Environment=` lines by design (D10: never a secret
    // there), so the gate that refuses a unit whose EnvironmentFile never landed must see it.
    expect(resolveSupervisorModeGate(envFromUnit(unit)).proceed).toBe(false);
    expect(resolveSupervisorModeGate(env).proceed).toBe(true);

    const resolver = createForwardedSessionResolver({ secret: env.CEZ_SUPERVISOR_SECRET });
    const signed = signForwardedPrincipal(
      { userId: 'u1', orgId: 'org_acme', teamId: 't1', role: 'owner', issuedAt: new Date().toISOString() },
      'secret-for-acme',
    );
    expect(
      resolver.resolveFromCookieHeader(undefined, {
        principal: signed.principalHeader,
        signature: signed.signatureHeader,
      }),
    ).toEqual({ kind: 'session', userId: 'u1', orgId: 'org_acme', teamId: 't1', role: 'owner' });

    // A sibling org's signature must not pass at this org's process — that is the whole reason
    // the secret is per-org rather than deployment-wide.
    const forged = signForwardedPrincipal(
      { userId: 'u1', orgId: 'org_beta', teamId: 't1', role: 'owner', issuedAt: new Date().toISOString() },
      'secret-for-beta',
    );
    expect(
      resolver.resolveFromCookieHeader(undefined, {
        principal: forged.principalHeader,
        signature: forged.signatureHeader,
      }),
    ).toBeNull();
  });
});

describe('supervisorSystemdUnit', () => {
  it('runs cezar supervisor as its own dedicated unix user, in its own CEZ_HOME', () => {
    const unit = supervisorSystemdUnit(supervisorOpts);
    expect(unit).toContain('User=cez-supervisor');
    expect(unit).toContain('WorkingDirectory=/home/cez-supervisor');
    expect(unit).toContain('Environment=CEZ_HOME=/home/cez-supervisor/.cezar');
    expect(unit).toContain('ExecStart=/usr/bin/node /srv/cezar/dist/index.js supervisor --no-open --port 4000');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('carries a real CEZ_AUTH provider (never supervisor) plus CEZ_PUBLIC_URL and the cookie domain', () => {
    const unit = supervisorSystemdUnit(supervisorOpts);
    expect(unit).toContain('Environment=CEZ_AUTH=oidc');
    expect(unit).toContain('Environment=CEZ_PUBLIC_URL=https://login.cezar.example.com');
    expect(unit).toContain('Environment=CEZ_SESSION_COOKIE_DOMAIN=.login.cezar.example.com');
    expect(unit).not.toContain('CEZ_AUTH=supervisor');
  });

  it('accepts google as the other real provider', () => {
    const unit = supervisorSystemdUnit({ ...supervisorOpts, authProvider: 'google' });
    expect(unit).toContain('Environment=CEZ_AUTH=google');
  });

  it('the secret file path is referenced, never a client secret value', () => {
    const unit = supervisorSystemdUnit(supervisorOpts);
    expect(unit).toContain('EnvironmentFile=/etc/cezar/supervisor.env');
    expect(unit).not.toContain('CEZ_OIDC_CLIENT_SECRET');
    expect(unit).not.toContain('CEZ_AUTH_BOOTSTRAP_TOKEN');
    expect(unit).not.toContain('CEZ_SUPERVISOR_ADMIN_TOKEN');
  });

  it('hardens the sandbox like the org unit does', () => {
    const unit = supervisorSystemdUnit(supervisorOpts);
    expect(unit).toContain('PrivateTmp=yes');
    expect(unit).toContain('NoNewPrivileges=yes');
  });

  it('the gate agrees: this exact environment boots (a real provider needs no opt-out)', () => {
    const unit = supervisorSystemdUnit(supervisorOpts);
    const env = envFromUnit(unit);
    expect(resolveAuthBootGate(env).proceed).toBe(true);
  });

  /**
   * The consumer-pairing half for `CEZ_SESSION_COOKIE_DOMAIN`, which shipped generated-and-unread.
   *
   * D10 makes it load-bearing: the `auth_request` subrequest from an org host only carries the
   * browser's cookie when the login host set it with `Domain=.<base>`. `auth/session.ts` emitted no
   * `Domain=` at all and read no env, so the cookie was host-only and every org host 401'd — a
   * second, independent cause of the same total outage as the missing resolver. This feeds the
   * unit's OWN generated line into the real cookie serializer rather than asserting the line
   * against a hand-written string, which is what the previous test did and why it proved nothing.
   */
  it("the unit's CEZ_SESSION_COOKIE_DOMAIN actually reaches the Set-Cookie the login host sends", () => {
    const unit = supervisorSystemdUnit(supervisorOpts);
    const env = envFromUnit(unit);
    expect(sessionCookieDomainAttribute(env)).toBe('; Domain=.login.cezar.example.com');
    // Absent ⇒ host-only, byte-identical to the phase 1-5 single-process deployment.
    expect(sessionCookieDomainAttribute({})).toBe('');
  });
});
