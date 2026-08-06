import { describe, expect, it } from 'vitest';
import { resolveAuthBootGate, runAuthBootGate, type AuthBootGateIo } from './auth-boot-gate.ts';

/**
 * D1's boot-gate table, all five rows (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`):
 *
 * | Bind     | CEZ_AUTH     | Result                                               |
 * |----------|--------------|------------------------------------------------------|
 * | loopback | unset        | today's behaviour, unchanged — the npm default        |
 * | loopback | oidc/google  | login required locally                               |
 * | hosted   | oidc/google  | login required                                       |
 * | hosted   | unset + flag | boots, warns, names the risk                         |
 * | hosted   | unset        | REFUSES to boot, naming the reason                   |
 *
 * The gate lived inline in `serveCommand` first, where nothing could reach it: `src/index.ts` is
 * the CLI entry, so importing it runs the CLI, and the only alternative — spawning `cezar serve`
 * — would start a real server inside the suite on any run where the gate was broken. A mutation
 * turning the refusal into `if (false && …)` therefore passed vitest, `test:unit`, `test:package`
 * and `typecheck` alike. Extracting the decision (and its two messages, and its exit code) into
 * `auth-boot-gate.ts` is what makes the table above assertable; `serveCommand` keeps only
 * `if (!gate.proceed) return;`.
 *
 * `env` is a parameter on both functions, so nothing here mutates `process.env` — no cross-file
 * leakage into the `CEZ_AUTH`-sensitive suites, and no ordering dependence.
 */

/** Non-loopback bind ⇒ hosted, via the same `resolveCapabilities().localHandoff` predicate the
 *  request-origin guard reads. `CEZ_REMOTE=1` is the other spelling and is covered below. */
const HOSTED_BIND = '0.0.0.0';

function recordingIo(): AuthBootGateIo & { warns: string[]; errors: string[]; exits: number[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  return {
    warns,
    errors,
    exits,
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    exit: (c) => exits.push(c),
  };
}

describe('resolveAuthBootGate — D1 table', () => {
  it('loopback + unset: proceeds silently, which is the npm zero-config product', () => {
    const gate = resolveAuthBootGate({});
    expect(gate).toEqual({ proceed: true, provider: 'none' });
    // No `message` key at all: the default path must print nothing it did not print before.
    expect(gate.message).toBeUndefined();
  });

  it.each(['oidc', 'google'] as const)('loopback + CEZ_AUTH=%s: proceeds and asks for the auth tree', (provider) => {
    // The D1 table's second row — login required even locally, which is how the flow gets tested
    // without a VPS. `provider !== 'none'` is what tells `serveCommand` to load `src/auth/*`.
    expect(resolveAuthBootGate({ CEZ_AUTH: provider })).toEqual({ proceed: true, provider });
  });

  it.each(['oidc', 'google'] as const)('hosted + CEZ_AUTH=%s: proceeds, no warning', (provider) => {
    expect(resolveAuthBootGate({ CEZ_AUTH: provider }, HOSTED_BIND)).toEqual({ proceed: true, provider });
    expect(resolveAuthBootGate({ CEZ_AUTH: provider, CEZ_REMOTE: '1' })).toEqual({ proceed: true, provider });
  });

  it('hosted + unset + CEZ_ALLOW_UNAUTHENTICATED=1: boots, warning names the actual risk', () => {
    const gate = resolveAuthBootGate({ CEZ_ALLOW_UNAUTHENTICATED: '1' }, HOSTED_BIND);
    expect(gate.proceed).toBe(true);
    expect(gate.severity).toBe('warn');
    // "auth is off" would be useless to an operator. The message has to say what is exposed.
    expect(gate.message).toContain('shell');
    expect(gate.message).toContain('POST /api/v1/workflows');
    expect(gate.message).toContain('CEZ_ALLOW_UNAUTHENTICATED=1');
  });

  it('hosted + unset + no flag: REFUSES, naming the consequence and both ways out', () => {
    const gate = resolveAuthBootGate({}, HOSTED_BIND);
    expect(gate.proceed).toBe(false);
    expect(gate.severity).toBe('error');
    expect(gate.message).toContain('refuses to boot');
    expect(gate.message).toContain('spawn bash');
    expect(gate.message).toContain('Set CEZ_AUTH');
    expect(gate.message).toContain('CEZ_ALLOW_UNAUTHENTICATED=1');
  });

  it('refuses on CEZ_REMOTE=1 too — hosted is a predicate, not just a bind address', () => {
    // `cezar server-install --platform ubuntu-vps` writes `Environment=CEZ_REMOTE=1` and binds
    // loopback behind nginx, so this spelling is the one real deployments actually hit.
    expect(resolveAuthBootGate({ CEZ_REMOTE: '1' }).proceed).toBe(false);
  });

  it.each(['0', '', 'true', 'yes', 'YES'])(
    'does not accept %j as the opt-out — exactly "1", like every other flag in this codebase',
    (value) => {
      expect(resolveAuthBootGate({ CEZ_ALLOW_UNAUTHENTICATED: value }, HOSTED_BIND).proceed).toBe(false);
    },
  );

  it('a CEZ_AUTH typo refuses rather than half-enabling auth', () => {
    // `resolveAuthProvider` maps anything but the two exact spellings to `'none'`. The dangerous
    // reading would be "something is set, so the operator meant to secure it" — an operator who
    // typed `CEZ_AUTH=OIDC` on a public box must hit the refusal, not a silent unauthenticated boot.
    expect(resolveAuthBootGate({ CEZ_AUTH: 'OIDC' }, HOSTED_BIND).proceed).toBe(false);
    expect(resolveAuthBootGate({ CEZ_AUTH: 'oauth' }, HOSTED_BIND).provider).toBe('none');
  });

  it('the flag alone does not change a loopback boot', () => {
    // Nothing to opt out of locally; the flag must not become a second way to say anything.
    expect(resolveAuthBootGate({ CEZ_ALLOW_UNAUTHENTICATED: '1' })).toEqual({ proceed: true, provider: 'none' });
  });
});

describe('runAuthBootGate — the side effects the CLI depends on', () => {
  it('prints the refusal on the ERROR sink and asks for a non-zero exit', () => {
    const io = recordingIo();
    const gate = runAuthBootGate({}, HOSTED_BIND, io);
    expect(gate.proceed).toBe(false);
    expect(io.errors).toHaveLength(1);
    expect(io.errors[0]).toContain('refuses to boot');
    expect(io.warns).toEqual([]);
    // The exit code is the thing systemd reads. A refusal that exits 0 is indistinguishable from
    // a successful boot to a supervisor, which is the whole reason it is asserted here.
    expect(io.exits).toEqual([1]);
  });

  it('prints the opt-out on the WARN sink and does NOT exit', () => {
    const io = recordingIo();
    expect(runAuthBootGate({ CEZ_ALLOW_UNAUTHENTICATED: '1' }, HOSTED_BIND, io).proceed).toBe(true);
    expect(io.warns).toHaveLength(1);
    expect(io.errors).toEqual([]);
    expect(io.exits).toEqual([]);
  });

  it('says and does nothing at all on the npm default path', () => {
    const io = recordingIo();
    expect(runAuthBootGate({}, undefined, io).proceed).toBe(true);
    expect([...io.warns, ...io.errors]).toEqual([]);
    expect(io.exits).toEqual([]);
  });
});
