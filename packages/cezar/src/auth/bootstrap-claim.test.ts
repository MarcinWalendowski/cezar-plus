import { describe, expect, it } from 'vitest';
import { bootstrapClaimBanner, matchesBootstrapClaim, resolveBootstrapClaim } from './bootstrap-claim.ts';

/**
 * `auth-boot-gate.test.ts`'s sibling, and deliberately the same shape: a pure resolver plus its
 * messages, walked row by row, with no filesystem and no server. The reason is the same one that
 * module's doc comment gives — the *decision* is the thing that must not be quietly disabled, and
 * a decision that only exists inline in a handler is one a mutation can turn into `if (false && …)`
 * with every gate green.
 */

const authOn = { CEZ_AUTH: 'oidc' } as NodeJS.ProcessEnv;
const mint = () => 'MINTED';

describe('resolveBootstrapClaim', () => {
  it('is inert when CEZ_AUTH is unset — no code drawn, nothing required (D1: unset means zero I/O)', () => {
    const claim = resolveBootstrapClaim({} as NodeJS.ProcessEnv, () => {
      throw new Error('must not mint a code on the auth-off path');
    });
    expect(claim).toEqual({ required: false, mode: 'open' });
  });

  it('is inert for an unrecognised CEZ_AUTH value, exactly as resolveAuthProvider treats it', () => {
    const claim = resolveBootstrapClaim({ CEZ_AUTH: 'okta-ish-typo' } as NodeJS.ProcessEnv, mint);
    expect(claim).toEqual({ required: false, mode: 'open' });
  });

  it('mints and requires a code by default once CEZ_AUTH names a provider — the SAFE default', () => {
    expect(resolveBootstrapClaim(authOn, mint)).toEqual({ required: true, mode: 'generated', token: 'MINTED' });
    expect(resolveBootstrapClaim({ CEZ_AUTH: 'google' } as NodeJS.ProcessEnv, mint)).toEqual({
      required: true,
      mode: 'generated',
      token: 'MINTED',
    });
  });

  it('draws real entropy by default — the shipped mint is not a constant', () => {
    const a = resolveBootstrapClaim(authOn).token;
    const b = resolveBootstrapClaim(authOn).token;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).not.toBe(a);
  });

  it('honours an operator-set CEZ_AUTH_BOOTSTRAP_TOKEN instead of minting one', () => {
    const claim = resolveBootstrapClaim({ ...authOn, CEZ_AUTH_BOOTSTRAP_TOKEN: '  hunter2  ' }, mint);
    expect(claim).toEqual({ required: true, mode: 'preset', token: 'hunter2' });
  });

  it('treats a blank CEZ_AUTH_BOOTSTRAP_TOKEN as unset rather than as an empty secret', () => {
    expect(resolveBootstrapClaim({ ...authOn, CEZ_AUTH_BOOTSTRAP_TOKEN: '   ' }, mint).mode).toBe('generated');
  });

  it('CEZ_AUTH_BOOTSTRAP_OPEN=1 restores "whoever signs in first" — opt-out, and it must be said', () => {
    expect(resolveBootstrapClaim({ ...authOn, CEZ_AUTH_BOOTSTRAP_OPEN: '1' }, mint)).toEqual({
      required: false,
      mode: 'open',
    });
    // Only the exact `1`, matching CEZ_ALLOW_UNAUTHENTICATED's own discipline: a truthy-looking
    // value that is not the documented one must not silently disable a security control.
    expect(resolveBootstrapClaim({ ...authOn, CEZ_AUTH_BOOTSTRAP_OPEN: 'true' }, mint).required).toBe(true);
    expect(resolveBootstrapClaim({ ...authOn, CEZ_AUTH_BOOTSTRAP_OPEN: 'yes' }, mint).required).toBe(true);
  });

  it('lets the open opt-out win over a preset token — the operator said both, the looser one is explicit', () => {
    const claim = resolveBootstrapClaim(
      { ...authOn, CEZ_AUTH_BOOTSTRAP_OPEN: '1', CEZ_AUTH_BOOTSTRAP_TOKEN: 'hunter2' },
      mint,
    );
    expect(claim.required).toBe(false);
  });
});

describe('matchesBootstrapClaim', () => {
  const claim = resolveBootstrapClaim({ ...authOn, CEZ_AUTH_BOOTSTRAP_TOKEN: 'right' }, mint);

  it('accepts the exact code', () => {
    expect(matchesBootstrapClaim(claim, 'right')).toBe(true);
  });

  it('rejects absent, empty, wrong, prefix and suffix codes', () => {
    for (const supplied of [undefined, '', 'wrong', 'righ', 'rights', 'RIGHT', ' right']) {
      expect(matchesBootstrapClaim(claim, supplied)).toBe(false);
    }
  });

  it('accepts anything when no code is required — that is what `open` means', () => {
    const open = resolveBootstrapClaim({} as NodeJS.ProcessEnv, mint);
    expect(matchesBootstrapClaim(open, undefined)).toBe(true);
    expect(matchesBootstrapClaim(open, 'nonsense')).toBe(true);
  });

  it('fails closed on a malformed claim that requires a code but carries none', () => {
    expect(matchesBootstrapClaim({ required: true, mode: 'generated' }, 'anything')).toBe(false);
  });
});

describe('bootstrapClaimBanner', () => {
  it('prints the generated code, and says how to change the policy', () => {
    const banner = bootstrapClaimBanner(resolveBootstrapClaim(authOn, mint), false);
    expect(banner).toContain('MINTED');
    expect(banner).toContain('CEZ_AUTH_BOOTSTRAP_TOKEN');
    expect(banner).toContain('CEZ_AUTH_BOOTSTRAP_OPEN=1');
  });

  it('says nothing once the deployment has an org — the window is closed, the code grants nothing', () => {
    expect(bootstrapClaimBanner(resolveBootstrapClaim(authOn, mint), true)).toBeUndefined();
    expect(bootstrapClaimBanner(resolveBootstrapClaim({ ...authOn, CEZ_AUTH_BOOTSTRAP_OPEN: '1' }, mint), true)).toBeUndefined();
  });

  it('warns rather than reassures when the claim is open and un-onboarded, naming the actual consequence', () => {
    const banner = bootstrapClaimBanner(resolveBootstrapClaim({ ...authOn, CEZ_AUTH_BOOTSTRAP_OPEN: '1' }, mint), false);
    // The same standard D1's refusal is held to: name what is at stake, not "auth required".
    expect(banner).toContain('spawn bash');
  });

  it('says nothing for a preset code — the operator chose the value and printing it would only leak it to the journal', () => {
    const claim = resolveBootstrapClaim({ ...authOn, CEZ_AUTH_BOOTSTRAP_TOKEN: 'hunter2' }, mint);
    expect(bootstrapClaimBanner(claim, false)).toBeUndefined();
  });
});
