import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentAccountsPath } from '../paths.ts';
import { autoAccountsEnabled, autoRegisterDiscoveredAccounts } from './agent-accounts-auto.ts';
import { loadAgentAccounts } from './agent-accounts.ts';

/**
 * Auto-registration of detected logins (spec
 * `.ai/specs/2026-08-24-second-codex-account-balancing.md`, D5).
 *
 * This module WRITES state nobody clicked for, so the load-bearing tests here are the ones about
 * what it declines to write: with the flag unset it must do nothing at all, a dir with no identity
 * must never become an account, and a second sweep must be a no-op. The happy path is one test;
 * the refusals are five, and that ratio is the point.
 *
 * `CEZ_HOME` and `HOME` are BOTH relocated per test — the store lives under the first and the
 * discovery scan reads the second — and they are relocated to SIBLING temp dirs rather than one
 * inside the other. That is not tidiness: `assertCezarHomeWriteIsSandboxed` refuses any write
 * under `homedir()/.cezar` while `VITEST` is set, so a store nested inside the fake HOME is
 * refused, `autoRegisterDiscoveredAccounts` swallows the throw, and every assertion of the form
 * "nothing was added" passes for the wrong reason. Two of these tests assert exactly that, and one
 * of them was silently vacuous until this was found.
 */
describe('autoRegisterDiscoveredAccounts', () => {
  const originalCezHome = process.env.CEZ_HOME;
  let home: string;
  let cezHome: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-auto-home-'));
    cezHome = mkdtempSync(join(tmpdir(), 'cez-auto-store-'));
    process.env.CEZ_HOME = cezHome;
  });

  afterEach(() => {
    if (originalCezHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalCezHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cezHome, { recursive: true, force: true });
  });

  /** The env a sweep sees: a relocated HOME, and the flag unless a test says otherwise. */
  const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME: home,
    CEZ_AUTO_ACCOUNTS: '1',
    ...over,
  });

  function jwt(claims: Record<string, unknown>): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'RS256' })}.${part(claims)}.not-a-signature`;
  }

  /** A signed-in codex home. `signedIn: false` gives a dir the CLI made but was never logged into —
   *  a `config.toml` and nothing else, which is a real state and the one that must not register. */
  function codexHome(name: string, options: { email?: string; signedIn?: boolean } = {}): string {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    if (options.signedIn === false) {
      writeFileSync(join(dir, 'config.toml'), 'model = "gpt-5"');
      return dir;
    }
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          id_token: jwt({
            email: options.email ?? 'someone@example.com',
            'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
          }),
          access_token: 'ACCESS',
          refresh_token: 'REFRESH',
        },
      }),
    );
    return dir;
  }

  const stored = async () => (await loadAgentAccounts()).accounts;

  it('is off unless the flag is exactly "1"', () => {
    expect(autoAccountsEnabled({})).toBe(false);
    expect(autoAccountsEnabled({ CEZ_AUTO_ACCOUNTS: 'true' })).toBe(false);
    expect(autoAccountsEnabled({ CEZ_AUTO_ACCOUNTS: '0' })).toBe(false);
    expect(autoAccountsEnabled({ CEZ_AUTO_ACCOUNTS: '1' })).toBe(true);
  });

  it('registers a second codex home it finds', async () => {
    codexHome('.codex');
    codexHome('.codex-secondary', { email: 'second@example.com' });

    const { added } = await autoRegisterDiscoveredAccounts(env());

    expect(added.map((row) => [row.provider, row.configDir, row.label])).toEqual([
      ['codex', join(home, '.codex-secondary'), 'second@example.com'],
    ]);
    expect((await stored()).map((row) => row.id)).toEqual(['second-example-com']);
  });

  it('writes NOTHING with the flag unset, given the same discoverable dir', async () => {
    // NEGATIVE CONTROL, and the one that matters most: it proves the flag is the gate rather than
    // the discovery. Without it, a sweep that found nothing on this machine would pass too.
    codexHome('.codex');
    codexHome('.codex-secondary', { email: 'second@example.com' });

    expect(await autoRegisterDiscoveredAccounts(env({ CEZ_AUTO_ACCOUNTS: undefined }))).toEqual({ added: [] });
    expect(existsSync(agentAccountsPath())).toBe(false);
  });

  it('never registers the provider default itself', async () => {
    // `~/.codex` IS the discovered default. Registering it would put one login in the pool twice,
    // and every fairness signal counts it twice with it.
    codexHome('.codex');
    expect((await autoRegisterDiscoveredAccounts(env())).added).toEqual([]);
  });

  it('never registers a dir the CLI made but was never signed into', async () => {
    // A `config.toml` alone is enough for DISCOVERY to list the dir (it is a real codex home) and
    // must not be enough to register it: a login that cannot run still takes its turn in the
    // rotation, and its turn is a failed task.
    codexHome('.codex');
    codexHome('.codex-fresh', { signedIn: false });

    expect((await autoRegisterDiscoveredAccounts(env())).added).toEqual([]);
  });

  it('is a no-op on the second sweep', async () => {
    codexHome('.codex');
    codexHome('.codex-secondary', { email: 'second@example.com' });

    expect((await autoRegisterDiscoveredAccounts(env())).added).toHaveLength(1);
    expect((await autoRegisterDiscoveredAccounts(env())).added).toEqual([]);
    expect(await stored()).toHaveLength(1);
  });

  it('leaves an existing row alone rather than relabelling or repointing it', async () => {
    // Append-only. A user who renamed an auto-registered account keeps that name; the sweep is not
    // a second opinion about rows that already exist.
    codexHome('.codex');
    const secondary = codexHome('.codex-secondary', { email: 'second@example.com' });
    writeFileSync(
      agentAccountsPath(),
      JSON.stringify({
        version: 1,
        accounts: [{ id: 'work', provider: 'codex', configDir: secondary, label: 'Work', addedAt: '' }],
        defaults: {},
        selections: {},
      }),
    );

    expect((await autoRegisterDiscoveredAccounts(env())).added).toEqual([]);
    expect((await stored()).map((row) => [row.id, row.label])).toEqual([['work', 'Work']]);
  });

  it('matches a stored dir written with a tilde', async () => {
    // The store keeps `configDir` AS WRITTEN, so a hand-edited `~/.codex-secondary` is the same
    // directory as discovery's absolute path. Without expansion this registers a duplicate on
    // every sweep — and on this repo's own production box every stored row was hand-edited.
    codexHome('.codex');
    codexHome('.codex-secondary', { email: 'second@example.com' });
    writeFileSync(
      agentAccountsPath(),
      JSON.stringify({
        version: 1,
        accounts: [{ id: 'work', provider: 'codex', configDir: '~/.codex-secondary', label: 'Work', addedAt: '' }],
        defaults: {},
        selections: {},
      }),
    );

    // `expandTilde` goes through `os.homedir()`, which on POSIX answers `$HOME` — so the process
    // env has to move too, not just the env handed to the sweep. Restored in `finally`: leaving it
    // pointed at a deleted temp dir would break every later test in the file, and the failure would
    // look like anything but this one.
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect((await autoRegisterDiscoveredAccounts(env())).added).toEqual([]);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('registers a claude home too — the flag is not codex-specific', async () => {
    codexHome('.codex');
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(join(home, '.claude-work', 'projects'), { recursive: true });
    writeFileSync(
      join(home, '.claude-work', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com', organizationType: 'claude_max' } }),
    );

    const { added } = await autoRegisterDiscoveredAccounts(env());
    expect(added.map((row) => [row.provider, row.label])).toEqual([['claude', 'work@example.com']]);
  });

  it('survives an unreadable accounts file without throwing', async () => {
    codexHome('.codex');
    codexHome('.codex-secondary', { email: 'second@example.com' });
    writeFileSync(agentAccountsPath(), '{not json');

    // `loadAgentAccounts` degrades a corrupt file to an empty store with one warning, so the sweep
    // proceeds and the write replaces the garbage. What must NOT happen is a throw out of a boot
    // hook that nothing awaits.
    await expect(autoRegisterDiscoveredAccounts(env())).resolves.toBeDefined();
    expect(readFileSync(agentAccountsPath(), 'utf8')).toContain('second@example.com');
  });
});
