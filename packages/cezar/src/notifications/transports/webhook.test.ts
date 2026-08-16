import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WebhookConfig } from '../config.ts';
import type { Notification, TransportCapabilities } from '../types.ts';
import {
  createWebhookTransport,
  validateWebhookTemplate,
  WebhookTemplateError,
  WEBHOOK_TEMPLATE_PLACEHOLDERS,
  type WebhookTransportOptions,
} from './webhook.ts';

/**
 * W2.4 (spec `.ai/specs/2026-08-06-pluggable-notification-transports.md`, "Phases" table row
 * `W2.4`). Every negative control below names what must FAIL when its mechanism is disabled,
 * per the spec's own Verification discipline.
 *
 * No test performs a real network call: `fetch` is always the injected `fakeFetch` below.
 */

const CAPABILITIES: TransportCapabilities = {
  maxTitleChars: 80,
  maxBodyChars: 1_200,
  links: 'inline',
  markdown: false,
  batch: true,
  idempotencyKey: true,
};

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    event: 'run.failed',
    severity: 'urgent',
    projectId: 'proj-1',
    runIds: ['run-1'],
    title: 'Build broke',
    body: 'Failed.',
    url: 'https://cockpit.example.test/runs/run-1',
    dedupeKey: 'proj-1:run-1:run.failed',
    createdAt: '2026-08-06T12:00:00.000Z',
    ...overrides,
  };
}

function webhookConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    url: 'https://notify.example.test/notify/v1/events',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    payload: 'envelope',
    timeoutMs: 10_000,
    successStatuses: [200, 202],
    ...overrides,
  };
}

interface FakeFetchCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

interface FakeFetchBehavior {
  status?: number;
  headers?: Record<string, string>;
  bodyText?: string;
  throwError?: Error;
  /** Never settles on its own; only rejects once the request's own `signal` aborts, mirroring
   *  what a real hung `fetch` does under an `AbortSignal`. */
  hang?: boolean;
}

/** A `typeof fetch` double that records every call and answers however the test configures it —
 *  the seam that keeps every test in this file off the real network (W2.4 acceptance). */
function fakeFetch(calls: FakeFetchCall[], behavior: FakeFetchBehavior = {}): NonNullable<WebhookTransportOptions['fetch']> {
  return (async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const signal = init?.signal ?? undefined;
    calls.push({ url: String(input), method: init?.method, headers, body: init?.body as string | undefined, signal });
    if (behavior.throwError) throw behavior.throwError;
    if (behavior.hang) {
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return; // never resolves - every call in this file passes a signal
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')), {
          once: true,
        });
      });
    }
    return new Response(behavior.bodyText ?? '', { status: behavior.status ?? 200, headers: behavior.headers });
  }) as NonNullable<WebhookTransportOptions['fetch']>;
}

describe('webhook transport: the upstream acceptance (JSON config alone -> a SPEC-417-shaped request)', () => {
  // A generic host and a `lok_`-prefixed bearer token stand in for a real production
  // notification ingress shaped like SPEC-417's, without spelling any product name here — see
  // the "upstream purity" describe block below, which asserts `webhook.ts`/`testkit.ts` never do.
  const template =
    '{"event":"{{event}}","title":"{{title}}","body":"{{body}}","deepLink":"{{url}}","dedupeKey":"{{dedupeKey}}","transports":["imessage"]}';

  it('produces the exact expected request from config alone', async () => {
    const calls: FakeFetchCall[] = [];
    const transport = createWebhookTransport(
      {
        id: 'ingress-1',
        capabilities: CAPABILITIES,
        webhook: webhookConfig({
          payload: 'template',
          template,
          auth: { scheme: 'bearer', header: 'authorization', envVar: 'CEZ_NOTIFY_TEST_TOKEN' },
        }),
      },
      { fetch: fakeFetch(calls, { status: 202 }), env: { CEZ_NOTIFY_TEST_TOKEN: 'lok_test1234567890' } },
    );

    const result = await transport.send(notification(), new AbortController().signal);

    expect(result).toEqual({ ok: true, httpStatus: 202, durationMs: expect.any(Number) });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://notify.example.test/notify/v1/events');
    expect(call.method).toBe('POST');
    expect(call.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer lok_test1234567890' });
    expect(JSON.parse(call.body!)).toEqual({
      event: 'run.failed',
      title: 'Build broke',
      body: 'Failed.',
      deepLink: 'https://cockpit.example.test/runs/run-1',
      dedupeKey: 'proj-1:run-1:run.failed',
      transports: ['imessage'],
    });
  });

  it('adding a channel to the transports array changes the request in exactly that one field', async () => {
    const build = (transports: string[]) =>
      webhookConfig({
        payload: 'template',
        template: template.replace('["imessage"]', JSON.stringify(transports)),
      });

    const callsA: FakeFetchCall[] = [];
    const transportA = createWebhookTransport(
      { id: 'ingress-1', capabilities: CAPABILITIES, webhook: build(['imessage']) },
      { fetch: fakeFetch(callsA, { status: 202 }) },
    );
    await transportA.send(notification(), new AbortController().signal);

    const callsB: FakeFetchCall[] = [];
    const transportB = createWebhookTransport(
      { id: 'ingress-1', capabilities: CAPABILITIES, webhook: build(['imessage', 'telegram']) },
      { fetch: fakeFetch(callsB, { status: 202 }) },
    );
    await transportB.send(notification(), new AbortController().signal);

    const bodyA = JSON.parse(callsA[0]!.body!) as Record<string, unknown>;
    const bodyB = JSON.parse(callsB[0]!.body!) as Record<string, unknown>;
    const { transports: transportsA, ...restA } = bodyA;
    const { transports: transportsB, ...restB } = bodyB;
    expect(restA).toEqual(restB);
    expect(transportsA).toEqual(['imessage']);
    expect(transportsB).toEqual(['imessage', 'telegram']);
  });
});

describe('webhook transport: closed placeholder set (Data Models "The template contract")', () => {
  it('accepts every member of the closed set, including dedupeKey', () => {
    const template = `{${WEBHOOK_TEMPLATE_PLACEHOLDERS.map((p) => `"${p}":"{{${p}}}"`).join(',')}}`;
    expect(() => validateWebhookTemplate(template)).not.toThrow();
  });

  it('rejects an unknown placeholder at load time, named', () => {
    expect(() => validateWebhookTemplate('{"k":"{{bogus}}"}')).toThrow(WebhookTemplateError);
  });

  it('negative control: removing dedupeKey from the known set makes a template that uses it FAIL to load, with a named error, rather than sending a literal placeholder', () => {
    const withoutDedupeKey = WEBHOOK_TEMPLATE_PLACEHOLDERS.filter((p) => p !== 'dedupeKey');
    expect(() => validateWebhookTemplate('{"k":"{{dedupeKey}}"}', withoutDedupeKey)).toThrow(WebhookTemplateError);
    // The identical template loads clean once dedupeKey is back in the set - proving the failure
    // above came from the set, not from the template itself.
    expect(() => validateWebhookTemplate('{"k":"{{dedupeKey}}"}', WEBHOOK_TEMPLATE_PLACEHOLDERS)).not.toThrow();
  });

  it('a template that does not produce valid JSON after substitution fails to load, named', () => {
    // An unquoted placeholder ({"k": {{title}}}) substitutes to {"k": probe} - invalid JSON.
    expect(() => validateWebhookTemplate('{"k": {{title}}}')).toThrow(WebhookTemplateError);
  });

  it('negative control: the same shape WITH quotes around the placeholder loads clean', () => {
    expect(() => validateWebhookTemplate('{"k": "{{title}}"}')).not.toThrow();
  });

  it('payload "template" with no template configured fails to load, named', () => {
    expect(() =>
      createWebhookTransport({
        id: 'x',
        capabilities: CAPABILITIES,
        webhook: webhookConfig({ payload: 'template', template: undefined }),
      }),
    ).toThrow(WebhookTemplateError);
  });

  it('template injection: quotes, braces, a backslash and a newline round-trip as one JSON string value with no extra keys', async () => {
    const calls: FakeFetchCall[] = [];
    const transport = createWebhookTransport(
      { id: 'x', capabilities: CAPABILITIES, webhook: webhookConfig({ payload: 'template', template: '{"title":"{{title}}"}' }) },
      { fetch: fakeFetch(calls, { status: 200 }) },
    );
    const dangerousTitle = 'He said "hi" {ok} \\ trouble\nmore';

    await transport.send(notification({ title: dangerousTitle }), new AbortController().signal);

    const parsed = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['title']);
    expect(parsed.title).toBe(dangerousTitle);
  });

  it('negative control: unescaped substitution would have broken the JSON above', () => {
    const naive = `{"title":"${'He said "hi" {ok} \\ trouble\nmore'}"}`;
    expect(() => JSON.parse(naive)).toThrow();
  });
});

describe('webhook transport: envelope payload mode', () => {
  it('links:"field" carries the deep link as its own field', async () => {
    const calls: FakeFetchCall[] = [];
    const transport = createWebhookTransport(
      { id: 'x', capabilities: { ...CAPABILITIES, links: 'field' }, webhook: webhookConfig({ payload: 'envelope' }) },
      { fetch: fakeFetch(calls, { status: 200 }) },
    );
    await transport.send(notification(), new AbortController().signal);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      title: 'Build broke',
      body: 'Failed.',
      url: 'https://cockpit.example.test/runs/run-1',
    });
  });

  it('links:"inline" appends the link to the body text instead of a separate field', async () => {
    const calls: FakeFetchCall[] = [];
    const transport = createWebhookTransport(
      { id: 'x', capabilities: { ...CAPABILITIES, links: 'inline' }, webhook: webhookConfig({ payload: 'envelope' }) },
      { fetch: fakeFetch(calls, { status: 200 }) },
    );
    await transport.send(notification(), new AbortController().signal);
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(body).toEqual({ title: 'Build broke', body: 'Failed.\nhttps://cockpit.example.test/runs/run-1' });
  });

  it('links:"none" drops the link entirely', async () => {
    const calls: FakeFetchCall[] = [];
    const transport = createWebhookTransport(
      { id: 'x', capabilities: { ...CAPABILITIES, links: 'none' }, webhook: webhookConfig({ payload: 'envelope' }) },
      { fetch: fakeFetch(calls, { status: 200 }) },
    );
    await transport.send(notification(), new AbortController().signal);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ title: 'Build broke', body: 'Failed.' });
  });

  it('truncates title and body to the transport capabilities', async () => {
    const calls: FakeFetchCall[] = [];
    const transport = createWebhookTransport(
      { id: 'x', capabilities: { ...CAPABILITIES, maxTitleChars: 5, maxBodyChars: 6, links: 'none' }, webhook: webhookConfig() },
      { fetch: fakeFetch(calls, { status: 200 }) },
    );
    await transport.send(notification({ title: 'A very long title indeed', body: 'A very long body indeed' }), new AbortController().signal);
    const body = JSON.parse(calls[0]!.body!) as { title: string; body: string };
    expect(body.title).toBe('A ver');
    expect(body.body).toBe('A very');
  });
});

describe('webhook transport: auth reference resolution', () => {
  it('resolves an env-var credential at send time and never persists it', async () => {
    const calls: FakeFetchCall[] = [];
    const transport = createWebhookTransport(
      { id: 'x', capabilities: CAPABILITIES, webhook: webhookConfig({ auth: { scheme: 'bearer', header: 'authorization', envVar: 'CEZ_NOTIFY_X_TOKEN' } }) },
      { fetch: fakeFetch(calls, { status: 200 }), env: { CEZ_NOTIFY_X_TOKEN: 'lok_env1234567890' } },
    );
    await transport.send(notification(), new AbortController().signal);
    expect(calls[0]!.headers?.authorization).toBe('Bearer lok_env1234567890');
  });

  it('an unset env var sends no auth header rather than "Bearer undefined"', async () => {
    const calls: FakeFetchCall[] = [];
    const transport = createWebhookTransport(
      { id: 'x', capabilities: CAPABILITIES, webhook: webhookConfig({ auth: { scheme: 'bearer', header: 'authorization', envVar: 'CEZ_NOTIFY_UNSET' } }) },
      { fetch: fakeFetch(calls, { status: 200 }), env: {} },
    );
    await transport.send(notification(), new AbortController().signal);
    expect(calls[0]!.headers).not.toHaveProperty('authorization');
  });

  it('resolves an inline credential', async () => {
    const calls: FakeFetchCall[] = [];
    const transport = createWebhookTransport(
      { id: 'x', capabilities: CAPABILITIES, webhook: webhookConfig({ auth: { scheme: 'bearer', header: 'x-webhook-token', inline: 'inline-secret-value' } }) },
      { fetch: fakeFetch(calls, { status: 200 }) },
    );
    await transport.send(notification(), new AbortController().signal);
    expect(calls[0]!.headers?.['x-webhook-token']).toBe('Bearer inline-secret-value');
  });
});

describe('webhook transport: DeliveryResult classification (send() never throws)', () => {
  it('a successStatuses status is ok:true', async () => {
    const transport = createWebhookTransport(
      { id: 'x', capabilities: CAPABILITIES, webhook: webhookConfig({ successStatuses: [200, 202] }) },
      { fetch: fakeFetch([], { status: 202 }) },
    );
    await expect(transport.send(notification(), new AbortController().signal)).resolves.toEqual({
      ok: true,
      httpStatus: 202,
      durationMs: expect.any(Number),
    });
  });

  it('a 4xx outside 408/429 is retryable:false', async () => {
    const transport = createWebhookTransport(
      { id: 'x', capabilities: CAPABILITIES, webhook: webhookConfig() },
      { fetch: fakeFetch([], { status: 400, bodyText: 'bad request' }) },
    );
    const result = await transport.send(notification(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, retryable: false, httpStatus: 400 });
  });

  it.each([500, 503, 408, 429])('%s is retryable:true and reads Retry-After', async (status) => {
    const transport = createWebhookTransport(
      { id: 'x', capabilities: CAPABILITIES, webhook: webhookConfig() },
      { fetch: fakeFetch([], { status, headers: { 'retry-after': '30' } }) },
    );
    const result = await transport.send(notification(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, retryable: true, httpStatus: status, retryAfterMs: 30_000 });
  });

  it('a network-level fetch rejection is retryable:true', async () => {
    const transport = createWebhookTransport(
      { id: 'x', capabilities: CAPABILITIES, webhook: webhookConfig() },
      { fetch: fakeFetch([], { throwError: new TypeError('fetch failed: ENOTFOUND') }) },
    );
    const result = await transport.send(notification(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, retryable: true, error: expect.stringContaining('ENOTFOUND') });
  });

  it('a hanging endpoint is aborted by the transport\'s own configured timeoutMs and reported retryable:true', async () => {
    const transport = createWebhookTransport(
      { id: 'x', capabilities: CAPABILITIES, webhook: webhookConfig({ timeoutMs: 15 }) },
      { fetch: fakeFetch([], { hang: true }) },
    );
    const result = await transport.send(notification(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, retryable: true });
  }, 2_000);

  it('the caller\'s own signal aborting also ends the send retryable:true, without an unbounded await', async () => {
    const controller = new AbortController();
    const transport = createWebhookTransport(
      { id: 'x', capabilities: CAPABILITIES, webhook: webhookConfig({ timeoutMs: 60_000 }) },
      { fetch: fakeFetch([], { hang: true }) },
    );
    const pending = transport.send(notification(), controller.signal);
    controller.abort(new Error('caller cancelled'));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, retryable: true });
  });
});

describe('webhook transport: healthcheck', () => {
  it('any completed HTTP round trip is ok:true, regardless of status code', async () => {
    const transport = createWebhookTransport(
      { id: 'x', capabilities: CAPABILITIES, webhook: webhookConfig() },
      { fetch: fakeFetch([], { status: 404 }) },
    );
    await expect(transport.healthcheck(new AbortController().signal)).resolves.toMatchObject({ ok: true });
  });

  it('a network failure is ok:false', async () => {
    const transport = createWebhookTransport(
      { id: 'x', capabilities: CAPABILITIES, webhook: webhookConfig() },
      { fetch: fakeFetch([], { throwError: new Error('connection refused') }) },
    );
    await expect(transport.healthcheck(new AbortController().signal)).resolves.toMatchObject({ ok: false });
  });
});

describe('upstream purity (spec Verification #10, whole tree)', () => {
  // Widened 2026-08-06 from "webhook.ts and testkit.ts" to BOTH published source trees. The
  // original narrowing was not a scoping preference, it was a finding: doc-comment prose in
  // `notifications/{config,secrets}.ts`, `knowledge/adapters.ts` and several test fixtures still
  // named a downstream workspace's products, which W2.4 could not edit under its own file
  // ownership. Those are gone now, so the claim this file can make truthfully is the whole
  // invariant, and making it here is what stops the next fixture from reintroducing one.
  //
  // NARROWED 2026-08-16 (`.ai/specs/2026-08-16-remove-open-mercato-coupling.md`). The rule used to
  // be D2 of `2026-08-06-knowledge-base-mounts-search.md` — "no Loki string ever enters cezar
  // `src/`" — whose stated reason was that a workspace-named thing "is not upstreamable". That
  // reason is spent: this fork renamed its packages to `@loki-labs/better-cezar*` and will not be
  // contributed upstream again. So the ONE permitted spelling is the fork's own package specifier,
  // stripped before the scan.
  //
  // The rest of the rule is untouched and still load-bearing, because it protects a DIFFERENT
  // hazard from the one D2 named: `lokimessages` and `imsg` are the messaging product, and a
  // coding cockpit that starts quoting its URLs or its internals has leaked a neighbour's domain
  // into a tool that knows nothing about it. Stripping (rather than loosening the pattern) is what
  // keeps `loki` itself forbidden everywhere else — a bare "loki" in prose still fails.
  /** The fork's own scope. The only spelling exempted, and exempted by removal, not by pattern. */
  const OWN_PACKAGE_RE = /@loki-labs\/better-cezar(?:-[a-z-]+)?/g;
  const FORBIDDEN_RE = /loki|lokimessages|imsg/i;
  const scannable = (text: string): string => text.replace(OWN_PACKAGE_RE, '');
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..', '..');
  const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|css|html|json|ndjson|md|txt|svg)$/i;
  /** This file, and only this file: a rule that names what it forbids cannot pass its own scan. */
  const SELF = join(import.meta.dirname, 'webhook.test.ts');

  function listFiles(dir: string): string[] {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && TEXT_EXT.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name));
  }

  it('no file under packages/{cezar,web}/src spells loki, lokimessages or imsg outside the package name', () => {
    const files = [
      ...listFiles(join(repoRoot, 'packages', 'cezar', 'src')),
      ...listFiles(join(repoRoot, 'packages', 'web', 'src')),
    ].filter((file) => file !== SELF);
    // A walk that found nothing would pass this vacuously — the scan has to be shown to have run.
    expect(files.length).toBeGreaterThan(500);
    const offenders = files.filter((file) => FORBIDDEN_RE.test(scannable(readFileSync(file, 'utf8'))));
    expect(offenders.map((file) => file.slice(repoRoot.length + 1))).toEqual([]);
  });

  /** The exemption is the part most likely to rot into a blindfold, so it gets its own control:
   *  stripping the package specifier must not stop the scan seeing anything else on the line. */
  it('negative control: the package-name exemption does not blind the scan', () => {
    expect(FORBIDDEN_RE.test(scannable("import x from '@loki-labs/better-cezar-contract'"))).toBe(false);
    expect(FORBIDDEN_RE.test(scannable("import x from '@loki-labs/better-cezar'"))).toBe(false);
    // Same line, one extra word: the strip must not swallow it.
    expect(FORBIDDEN_RE.test(scannable("'@loki-labs/better-cezar' posts to lokimessages.com"))).toBe(true);
    // A bare workspace name is still forbidden — only the full specifier is exempt.
    expect(FORBIDDEN_RE.test(scannable('the loki workspace'))).toBe(true);
    expect(FORBIDDEN_RE.test(scannable('@loki-labs/some-other-package'))).toBe(true);
  });

  it('negative control: the scan actually catches the words when present, and ignores unrelated prose', () => {
    expect(FORBIDDEN_RE.test('posting to lokimessages.com')).toBe(true);
    expect(FORBIDDEN_RE.test('the imsg agent handles delivery')).toBe(true);
    expect(FORBIDDEN_RE.test('a generic webhook notifier for ntfy and Slack')).toBe(false);
  });
});
