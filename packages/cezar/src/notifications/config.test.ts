import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EVENT_MATRIX,
  ENV_BOOTSTRAP_TRANSPORT_ID,
  defaultNotificationsConfig,
  envBootstrapTransport,
  loadNotificationsConfig,
  mergeWriteNotificationsConfig,
  notificationsConfigPath,
} from './config.ts';

/**
 * `~/.cezar/notifications.json` (W1.8, spec `2026-08-06-pluggable-notification-transports.md`).
 * Structure mirrors `workspace/agent-accounts.test.ts` — the file this store's house rules are
 * copied from verbatim.
 */
describe('notifications config store', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-notifications-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    chmodSync(home, 0o700); // undo any read-only test below so cleanup can unlink inside it
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const write = (value: unknown) =>
    writeFileSync(notificationsConfigPath(), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

  const validRow = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: 'webhook',
    label: id,
    enabled: true,
    webhook: { url: `https://example.com/${id}`, payload: 'envelope' },
    ...over,
  });

  it('resolves the path under CEZ_HOME, beside agent-accounts.json and notes.json', () => {
    expect(notificationsConfigPath()).toBe(join(home, 'notifications.json'));
  });

  describe('house rules', () => {
    it('a missing file yields {version: 1, transports: []}, silently, with no file created', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = await loadNotificationsConfig();
      expect(config.version).toBe(1);
      expect(config.transports).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(existsSync(notificationsConfigPath())).toBe(false);
    });

    it('the in-memory default matches what a missing file behaves like', () => {
      expect(defaultNotificationsConfig()).toEqual({ version: 1, transports: [], defaults: expect.any(Object) });
    });

    it('a corrupt file warns ONCE and is left on disk untouched, for the user to repair', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      write('{ not json');
      const config = await loadNotificationsConfig();
      expect(config.transports).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(readFileSync(notificationsConfigPath(), 'utf8')).toBe('{ not json');
    });

    it('a read-only home never fails boot — load performs no write at all', async () => {
      // Nothing exists under `home` yet; make it unwritable before the very first load.
      chmodSync(home, 0o500);
      await expect(loadNotificationsConfig()).resolves.toMatchObject({ transports: [] });
      expect(existsSync(notificationsConfigPath())).toBe(false); // never even attempted
    });

    it('drops a malformed row (bad id) but keeps the rest — per-entry salvage', async () => {
      write({ transports: [validRow('ok-one'), { id: 'BAD ID', kind: 'webhook', webhook: { url: 'https://x' } }, validRow('ok-two')] });
      const config = await loadNotificationsConfig();
      expect(config.transports.map((t) => t.id)).toEqual(['ok-one', 'ok-two']);
    });

    it('drops a row with no webhook.url — load-bearing, unusable transport', async () => {
      write({ transports: [validRow('ok'), { id: 'no-url', kind: 'webhook', webhook: {} }] });
      expect((await loadNotificationsConfig()).transports.map((t) => t.id)).toEqual(['ok']);
    });

    it('drops a row of an unknown kind', async () => {
      write({ transports: [validRow('ok'), validRow('other-kind', { kind: 'ntfy' })] });
      expect((await loadNotificationsConfig()).transports.map((t) => t.id)).toEqual(['ok']);
    });

    it('drops a row whose webhook.url carries userinfo — never stored, self-healed on load', async () => {
      write({
        transports: [
          validRow('ok'),
          validRow('leaky', { webhook: { url: 'https://user:hunter2@example.com/notify', payload: 'envelope' } }),
        ],
      });
      expect((await loadNotificationsConfig()).transports.map((t) => t.id)).toEqual(['ok']);
    });

    it('first-wins on a duplicated id', async () => {
      write({ transports: [validRow('dup', { label: 'first' }), validRow('dup', { label: 'second' })] });
      const config = await loadNotificationsConfig();
      expect(config.transports).toHaveLength(1);
      expect(config.transports[0]!.label).toBe('first');
    });

    it('a malformed capabilities object degrades to the default rather than dropping the row', async () => {
      write({ transports: [validRow('ok', { capabilities: 'not-an-object' })] });
      const [row] = (await loadNotificationsConfig()).transports;
      expect(row!.capabilities).toEqual({
        maxTitleChars: 200,
        maxBodyChars: 2000,
        links: 'inline',
        markdown: false,
        batch: true,
        idempotencyKey: false,
      });
    });

    it('a malformed rate degrades to null (inherit workspace defaults) rather than dropping the row', async () => {
      write({ transports: [validRow('ok', { rate: 'nonsense' })] });
      expect((await loadNotificationsConfig()).transports[0]!.rate).toBeNull();
    });

    it('a malformed auth degrades to no-auth rather than dropping the row', async () => {
      write({ transports: [validRow('ok', { webhook: { url: 'https://x/y', payload: 'envelope', auth: { scheme: 'basic' } } })] });
      expect((await loadNotificationsConfig()).transports[0]!.webhook.auth).toBeUndefined();
    });

    it('an absent `defaults` key still fills every default field (the .prefault control)', async () => {
      write({ transports: [] });
      const config = await loadNotificationsConfig();
      expect(config.defaults).toEqual({
        coalesceMs: 20_000,
        urgentCoalesceMs: 5_000,
        maxAgeMs: 21_600_000,
        cockpitUrl: null,
        quietHours: null,
        quietHoursAllowUrgent: true,
        rate: { perHour: 10, burst: 4, perMinute: 2 },
      });
    });

    it('a malformed `defaults` key also fills every default field, the same way', async () => {
      write({ transports: [], defaults: 'not-an-object' });
      expect((await loadNotificationsConfig()).defaults.rate).toEqual({ perHour: 10, burst: 4, perMinute: 2 });
    });
  });

  describe('mergeWriteNotificationsConfig', () => {
    it('writes atomically at 0600, and round-trips through loadNotificationsConfig', async () => {
      await mergeWriteNotificationsConfig((config) => {
        config.transports.push(validRow('acme') as never);
      });
      const stat = statSync(notificationsConfigPath());
      expect(stat.mode & 0o777).toBe(0o600);
      const reloaded = await loadNotificationsConfig();
      expect(reloaded.transports.map((t) => t.id)).toEqual(['acme']);
    });

    it('two sequential merge-writes converge rather than clobbering each other', async () => {
      await mergeWriteNotificationsConfig((config) => {
        config.transports.push(validRow('one') as never);
      });
      await mergeWriteNotificationsConfig((config) => {
        config.transports.push(validRow('two') as never);
      });
      expect((await loadNotificationsConfig()).transports.map((t) => t.id)).toEqual(['one', 'two']);
    });

    it('an inline auth value round-trips through the file (the documented escape hatch)', async () => {
      await mergeWriteNotificationsConfig((config) => {
        config.transports.push(
          validRow('inline-auth', {
            webhook: {
              url: 'https://example.com/notify',
              payload: 'envelope',
              auth: { scheme: 'bearer', header: 'authorization', inline: 'plain-inline-secret' },
            },
          }) as never,
        );
      });
      const reloaded = await loadNotificationsConfig();
      const auth = reloaded.transports[0]!.webhook.auth;
      expect(auth && 'inline' in auth ? auth.inline : undefined).toBe('plain-inline-secret');
    });
  });

  describe('envBootstrapTransport — the container case', () => {
    it('synthesises exactly one enabled transport when both vars are present', () => {
      const transport = envBootstrapTransport({
        CEZ_NOTIFY_WEBHOOK_URL: 'https://ntfy.sh/my-topic',
        CEZ_NOTIFY_WEBHOOK_TOKEN: 'xxx',
      });
      expect(transport).toBeDefined();
      expect(transport?.id).toBe(ENV_BOOTSTRAP_TRANSPORT_ID);
      expect(transport?.kind).toBe('webhook');
      expect(transport?.enabled).toBe(true);
      expect(transport?.webhook.url).toBe('https://ntfy.sh/my-topic');
      expect(transport?.events).toEqual(DEFAULT_EVENT_MATRIX);
      // The token's VALUE never appears anywhere in the synthesised row — only a reference to
      // the env var that carries it.
      expect(JSON.stringify(transport)).not.toContain('xxx');
    });

    it('yields nothing when the URL is absent', () => {
      expect(envBootstrapTransport({ CEZ_NOTIFY_WEBHOOK_TOKEN: 'xxx' })).toBeUndefined();
    });

    it('yields nothing when the token is absent', () => {
      expect(envBootstrapTransport({ CEZ_NOTIFY_WEBHOOK_URL: 'https://ntfy.sh/my-topic' })).toBeUndefined();
    });

    it('yields nothing when neither is set', () => {
      expect(envBootstrapTransport({})).toBeUndefined();
    });

    it('writes no file — the whole point of the container case', () => {
      envBootstrapTransport({ CEZ_NOTIFY_WEBHOOK_URL: 'https://ntfy.sh/x', CEZ_NOTIFY_WEBHOOK_TOKEN: 'xxx' });
      expect(existsSync(notificationsConfigPath())).toBe(false);
    });
  });
});
