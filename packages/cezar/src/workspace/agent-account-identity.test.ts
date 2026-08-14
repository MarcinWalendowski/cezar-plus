import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeStateFilePath } from '../paths.ts';
import {
  discoverClaudeAccounts,
  planLabel,
  readClaudeAccountIdentity,
} from './agent-account-identity.ts';

/**
 * Claude account identity + discovery (spec
 * `.ai/specs/2026-08-14-claude-subscription-autodetect.md`).
 *
 * The `.claude.json` bodies below are TRIMMED CAPTURES of the two real files on the machine this
 * was built on (`~/.claude.json` and `~/.claude-bis/.claude.json`, read 2026-08-14) — field names,
 * nesting and the tier spelling are the vendor's, not invented. Every credential-shaped key is
 * absent because there is none in that file to begin with, which is the whole reason this feature
 * reads it (see the module doc comment).
 */

/** Exactly the `oauthAccount` shape the CLI writes, minus fields nothing here reads. */
const OAUTH_ACCOUNT = {
  accountUuid: '00000000-0000-4000-8000-000000000000',
  emailAddress: 'someone@example.com',
  organizationUuid: '00000000-0000-4000-8000-000000000001',
  billingType: 'stripe_subscription',
  organizationName: "someone@example.com's Organization",
  organizationType: 'claude_max',
  organizationRateLimitTier: 'default_claude_max_20x',
  displayName: 'M',
};

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-identity-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * A config dir the CLI would recognize: marker files plus the state file WHERE THE CLI PUTS IT.
 *
 * That location is the rule under test, so the fixture obeys it rather than assuming one branch:
 * a dir named `.claude` under the env's HOME is the DEFAULT, whose state file is the SIBLING
 * `<home>/.claude.json`; anything else is an override and keeps its state file inside. A fixture
 * that wrote inside unconditionally would agree with the wrong branch and prove nothing about the
 * default account — the case every machine has.
 */
function claudeDir(name: string, state: unknown, markers = ['projects']): string {
  const dir = join(home, name);
  for (const marker of markers) mkdirSync(join(dir, marker), { recursive: true });
  if (state !== undefined) {
    writeFileSync(claudeStateFilePath(dir, { HOME: home }), JSON.stringify(state));
  }
  return dir;
}

describe('planLabel', () => {
  it('reads the multiplier out of the vendor tier string', () => {
    expect(planLabel({ organizationRateLimitTier: 'default_claude_max_20x' })).toBe('Max 20x');
    expect(planLabel({ organizationRateLimitTier: 'default_claude_max_5x' })).toBe('Max 5x');
  });

  /** The tier is what carries the multiplier, and it must win: `organizationType` is `claude_max`
   *  for a 5x and a 20x alike, so preferring it would render both as plain "Max". */
  it('prefers the tier over the coarser organizationType', () => {
    expect(planLabel({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' }))
      .toBe('Max 20x');
  });

  /** No lookup table of plan names: an unrecognized plan echoes the vendor's own string rather than
   *  a guess. A guessed plan name renders exactly as confidently as a correct one. */
  it('falls back to the vendor string, de-snake-cased, for a shape it does not know', () => {
    expect(planLabel({ organizationType: 'claude_enterprise' })).toBe('Enterprise');
    expect(planLabel({ organizationRateLimitTier: 'default_something_new' })).toBe('Something new');
  });

  it('is undefined when the vendor said nothing', () => {
    expect(planLabel({})).toBeUndefined();
    expect(planLabel({ organizationType: 42, organizationRateLimitTier: null })).toBeUndefined();
  });
});

describe('readClaudeAccountIdentity', () => {
  it('reads the account the dir is signed in as', async () => {
    const dir = claudeDir('.claude-work', { oauthAccount: OAUTH_ACCOUNT });

    expect(await readClaudeAccountIdentity(dir, { HOME: home })).toEqual({
      email: 'someone@example.com',
      plan: 'Max 20x',
    });
  });

  /** A personal account's `organizationName` is the email in longer words. Dropped, so the field
   *  means "a real organization" wherever it survives. */
  it('keeps a real organization name and drops the restated-email one', async () => {
    const dir = claudeDir('.claude-team', {
      oauthAccount: { ...OAUTH_ACCOUNT, organizationName: 'Acme Robotics' },
    });

    expect((await readClaudeAccountIdentity(dir, { HOME: home }))?.organization).toBe('Acme Robotics');
    expect(
      (await readClaudeAccountIdentity(claudeDir('.claude-solo', { oauthAccount: OAUTH_ACCOUNT }), { HOME: home }))
        ?.organization,
    ).toBeUndefined();
  });

  it('answers null — never throws — for a dir with no readable identity', async () => {
    expect(await readClaudeAccountIdentity(join(home, 'nope'), { HOME: home })).toBeNull();
    expect(await readClaudeAccountIdentity(claudeDir('.claude-empty', undefined), { HOME: home })).toBeNull();
    expect(await readClaudeAccountIdentity(claudeDir('.claude-broken', '{ not json'), { HOME: home })).toBeNull();
    // Created by the CLI but never logged in: a real state file with no `oauthAccount` in it.
    expect(await readClaudeAccountIdentity(claudeDir('.claude-fresh', { numStartups: 3 }), { HOME: home })).toBeNull();
  });

  /**
   * THE failure this feature must not have: labelling a second account with the FIRST account's
   * email. `claudeStateFilePath` puts the state file inside an overridden dir and beside the
   * default one, and reading `dirname(configDir)/.claude.json` unconditionally — which this repo
   * did once — lands on `~/.claude.json` for every profile.
   */
  it('reads each dir its OWN file, never the neighbouring account\'s', async () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { ...OAUTH_ACCOUNT, emailAddress: 'default@example.com' } }),
    );
    const second = claudeDir('.claude-bis', {
      oauthAccount: { ...OAUTH_ACCOUNT, emailAddress: 'second@example.com' },
    });

    expect((await readClaudeAccountIdentity(second, { HOME: home }))?.email).toBe('second@example.com');
  });

  /**
   * The other half of that rule, and the case EVERY machine has: `~/.claude` is the default, whose
   * state file is the sibling `~/.claude.json` — not one inside the dir.
   *
   * Written directly rather than through `claudeDir` so the fixture cannot quietly agree with the
   * implementation: the sibling carries the real account, a decoy sits INSIDE the dir, and reading
   * the wrong branch returns the decoy instead of nothing. This is what a `.claude`-named fixture
   * under a temp HOME did not exercise before — with `HOME` left alone the dir looked like an
   * override to `claudeStateFilePath`, so the default branch had no test at all.
   */
  it('reads the DEFAULT dir from the sibling file, not from inside it', async () => {
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { ...OAUTH_ACCOUNT, emailAddress: 'default@example.com' } }),
    );
    writeFileSync(
      join(home, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: { ...OAUTH_ACCOUNT, emailAddress: 'decoy@example.com' } }),
    );

    expect((await readClaudeAccountIdentity(join(home, '.claude'), { HOME: home }))?.email).toBe(
      'default@example.com',
    );
  });
});

describe('discoverClaudeAccounts', () => {
  const env = (): NodeJS.ProcessEnv => ({ HOME: home });

  it('finds the default dir and every ~/.claude* sibling that is really a Claude home', async () => {
    claudeDir('.claude', { oauthAccount: { ...OAUTH_ACCOUNT, emailAddress: 'first@example.com' } });
    claudeDir('.claude-bis', { oauthAccount: { ...OAUTH_ACCOUNT, emailAddress: 'second@example.com' } });

    const found = await discoverClaudeAccounts(env());

    expect(found.map((row) => row.path)).toEqual([join(home, '.claude'), join(home, '.claude-bis')]);
    expect(found.map((row) => row.identity?.email)).toEqual(['first@example.com', 'second@example.com']);
    expect(found.every((row) => row.provider === 'claude')).toBe(true);
  });

  /** NEGATIVE CONTROL: the name prefix alone is not the recognizer. A folder called `.claude-notes`
   *  with nothing of the CLI's in it is not a login, and offering it would produce an "account"
   *  that can never authenticate. */
  it('does not offer a ~/.claude* folder that carries none of the CLI\'s markers', async () => {
    claudeDir('.claude', { oauthAccount: OAUTH_ACCOUNT });
    mkdirSync(join(home, '.claude-notes', 'drafts'), { recursive: true });

    expect((await discoverClaudeAccounts(env())).map((row) => row.path)).toEqual([join(home, '.claude')]);
  });

  /** With `CLAUDE_CONFIG_DIR` set on the cezar process, the DEFAULT account is not `~/.claude` —
   *  the pane must name the dir cezar actually spawns agents with, or the row labelled "default"
   *  is a different account from the one that runs. */
  it('follows CLAUDE_CONFIG_DIR for the default dir', async () => {
    const overridden = claudeDir('.claude-work', { oauthAccount: OAUTH_ACCOUNT });
    claudeDir('.claude', { oauthAccount: OAUTH_ACCOUNT });

    const found = await discoverClaudeAccounts({ HOME: home, CLAUDE_CONFIG_DIR: overridden });

    expect(found[0]?.path).toBe(overridden);
    // …and it is listed ONCE, not again as its own `~/.claude*` sibling.
    expect(found.filter((row) => row.path === overridden)).toHaveLength(1);
  });

  it('lists a dir whose identity cannot be read, rather than dropping it', async () => {
    claudeDir('.claude', undefined);

    const found = await discoverClaudeAccounts(env());

    expect(found.map((row) => row.path)).toEqual([join(home, '.claude')]);
    expect(found[0]?.identity).toBeNull();
  });

  it('answers an empty list on a machine with no Claude home at all', async () => {
    expect(await discoverClaudeAccounts(env())).toEqual([]);
  });
});
