import { describe, expect, it } from 'vitest';
import { collectSecretValues } from '../core/secret-redaction.ts';
import {
  assertWebhookUrlHasNoUserinfo,
  collectNotificationSecretValues,
  describeAuth,
  resolveAuth,
  WebhookUrlCredentialError,
  type WebhookAuth,
} from './secrets.ts';

describe('resolveAuth', () => {
  it('reads an envVar reference from the given env at call time, never persisting it', () => {
    const auth: WebhookAuth = { scheme: 'bearer', header: 'authorization', envVar: 'CEZ_NOTIFY_TOKEN' };
    expect(resolveAuth(auth, { CEZ_NOTIFY_TOKEN: 'lok_abc123' })).toEqual({
      header: 'authorization',
      value: 'lok_abc123',
    });
  });

  it('returns undefined when the referenced env var is unset — not-yet-configured, not an error', () => {
    const auth: WebhookAuth = { scheme: 'bearer', header: 'authorization', envVar: 'CEZ_NOTIFY_TOKEN' };
    expect(resolveAuth(auth, {})).toBeUndefined();
  });

  it('returns an inline value directly, for the caller with nothing to point an env var at', () => {
    const auth: WebhookAuth = { scheme: 'bearer', header: 'x-api-key', inline: 'sekrit-value' };
    expect(resolveAuth(auth, {})).toEqual({ header: 'x-api-key', value: 'sekrit-value' });
  });

  it('returns undefined when there is no auth at all', () => {
    expect(resolveAuth(undefined, { CEZ_NOTIFY_TOKEN: 'x' })).toBeUndefined();
  });
});

describe('describeAuth — the structural redaction control', () => {
  it('an env reference reports only the var NAME and presence, never the value', () => {
    const auth: WebhookAuth = { scheme: 'bearer', header: 'authorization', envVar: 'CEZ_NOTIFY_TOKEN' };
    const view = describeAuth(auth, { CEZ_NOTIFY_TOKEN: 'lok_thisisareal40charactertokenvalue' });
    expect(view).toEqual({ source: 'env', envVar: 'CEZ_NOTIFY_TOKEN', present: true });
    expect(JSON.stringify(view)).not.toContain('lok_thisisareal40charactertokenvalue');
  });

  it('an unset env reference reports present: false', () => {
    const auth: WebhookAuth = { scheme: 'bearer', header: 'authorization', envVar: 'CEZ_NOTIFY_TOKEN' };
    expect(describeAuth(auth, {})).toEqual({ source: 'env', envVar: 'CEZ_NOTIFY_TOKEN', present: false });
  });

  it('no auth at all reports source: none', () => {
    expect(describeAuth(undefined)).toEqual({ source: 'none' });
  });

  it('an inline secret below the length floor (12) gets no hint at all', () => {
    const auth: WebhookAuth = { scheme: 'bearer', header: 'authorization', inline: 'short11chr' }; // 10 chars
    expect(describeAuth(auth, {})).toEqual({ source: 'inline', present: true });
  });

  it('an inline secret at exactly the length floor gets a last-4 hint', () => {
    const auth: WebhookAuth = { scheme: 'bearer', header: 'authorization', inline: '123456789012' }; // 12 chars
    expect(describeAuth(auth, {})).toEqual({ source: 'inline', present: true, hint: '9012' });
  });

  it('the CONTROL: JSON.stringify of describeAuth output never contains the resolved secret', () => {
    // Longer than the hint window, so only 4 of its 30 characters may legitimately reappear.
    const secret = 'zzzzzzzzzzzzzzzzzzzzzzzzzz9012';
    const auth: WebhookAuth = { scheme: 'bearer', header: 'authorization', inline: secret };
    const serialized = JSON.stringify(describeAuth(auth, {}));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(secret.slice(0, -4)); // not even the secret minus its hint
  });
});

describe('assertWebhookUrlHasNoUserinfo', () => {
  it('throws the named error for a URL carrying userinfo', () => {
    expect(() => assertWebhookUrlHasNoUserinfo('https://user:hunter2@example.com/notify')).toThrow(
      WebhookUrlCredentialError,
    );
  });

  it('the thrown message never repeats the credential itself', () => {
    try {
      assertWebhookUrlHasNoUserinfo('https://user:hunter2@example.com/notify');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookUrlCredentialError);
      expect((err as Error).message).not.toContain('hunter2');
      expect((err as Error).message).not.toContain('user:hunter2');
    }
  });

  it('a username with no password still counts as userinfo', () => {
    expect(() => assertWebhookUrlHasNoUserinfo('https://svc@example.com/notify')).toThrow(WebhookUrlCredentialError);
  });

  it('a clean URL passes', () => {
    expect(() => assertWebhookUrlHasNoUserinfo('https://example.com/notify/v1/events')).not.toThrow();
  });

  it('an unparseable string is a DIFFERENT failure and is let through here', () => {
    expect(() => assertWebhookUrlHasNoUserinfo('not a url at all')).not.toThrow();
  });
});

describe('collectNotificationSecretValues — structural, not best-effort', () => {
  const transports = (auth: WebhookAuth | undefined) => [{ webhook: { auth } }];

  it('includes an env-referenced value even when the var NAME does not match SECRET_NAME_RE', () => {
    // The negative control this test exists to demonstrate: the generic, name-pattern-based
    // collector in core/secret-redaction.ts cannot see this value at all, because "CEZ_ACME_CRED"
    // matches none of TOKEN/SECRET/PASSWORD/etc. A caller relying on collectSecretValues() alone
    // would fail to redact it from the outbox.
    const env = { CEZ_ACME_CRED: 'this-is-a-real-credential-value-123' };
    expect(collectSecretValues(env)).not.toContain(env.CEZ_ACME_CRED); // the trigger: the gap is real
    const auth: WebhookAuth = { scheme: 'bearer', header: 'authorization', envVar: 'CEZ_ACME_CRED' };
    expect(collectNotificationSecretValues(transports(auth), env)).toContain(env.CEZ_ACME_CRED);
  });

  it('includes an inline secret, which never lived in process.env at all', () => {
    const auth: WebhookAuth = { scheme: 'bearer', header: 'authorization', inline: 'an-inline-secret-value-here' };
    expect(collectNotificationSecretValues(transports(auth), {})).toContain('an-inline-secret-value-here');
  });

  it('still includes everything core collectSecretValues() would, for a name that DOES match', () => {
    const env = { GITHUB_TOKEN: 'gho_averylongtokenvalue1234567890' };
    expect(collectNotificationSecretValues([], env)).toContain(env.GITHUB_TOKEN);
  });

  it('an unset envVar reference and no auth contribute nothing extra', () => {
    const env = { OTHER: 'irrelevant' };
    expect(collectNotificationSecretValues([...transports(undefined), ...transports({
      scheme: 'bearer',
      header: 'authorization',
      envVar: 'CEZ_UNSET',
    })], env)).toEqual(collectSecretValues(env));
  });
});
