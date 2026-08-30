import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentAccountDetailsResponse,
  AgentProfilesResponse,
  DiscoveredAgentAccountsResponse,
} from '@loki-labs/cezar-plus-contract';
import { claudeStateFilePath } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';

/**
 * `GET /api/v1/workspace/agent-profiles/discovered` — the Claude logins already on this machine
 * (spec `.ai/specs/2026-08-14-claude-subscription-autodetect.md`).
 *
 * The `oauthAccount` bodies below are TRIMMED CAPTURES of the real files on the machine this was
 * built on (`~/.claude.json`, `~/.claude-bis/.claude.json`, read 2026-08-14) — field names, nesting
 * and the tier spelling are the vendor's, not invented.
 */
describe('discovered agent accounts API', () => {
  const saved = {
    home: process.env.CEZ_HOME,
    userHome: process.env.HOME,
    remote: process.env.CEZ_REMOTE,
    dryRun: process.env.CEZ_DRY_RUN,
    claudeDir: process.env.CLAUDE_CONFIG_DIR,
    codexDir: process.env.CODEX_HOME,
  };
  let home: string;
  let cezHome: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-discovered-home-'));
    // A SIBLING of the fake home, not `<home>/.cezar`. This suite fakes `HOME`, so
    // `assertCezarHomeWriteIsSandboxed` computes the "real" cezar home as `<home>/.cezar` — pinning
    // CEZ_HOME there would look exactly like a leaked test writing the developer's own registry,
    // and every write into it would be refused.
    cezHome = mkdtempSync(join(realpathSync(tmpdir()), 'cez-discovered-cezhome-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-discovered-repo-'));
    process.env.CEZ_HOME = cezHome;
    // The machine's home is what discovery walks. Pointed at a temp dir so the suite never depends
    // on — or reports — the developer's own logins.
    process.env.HOME = home;
    delete process.env.CEZ_REMOTE;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    process.env.CEZ_DRY_RUN = '1';
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    clearProjectProbeCache();
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, cezHome, repoRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [
      ['CEZ_HOME', saved.home],
      ['HOME', saved.userHome],
      ['CEZ_REMOTE', saved.remote],
      ['CEZ_DRY_RUN', saved.dryRun],
      ['CLAUDE_CONFIG_DIR', saved.claudeDir],
      ['CODEX_HOME', saved.codexDir],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  /** A config dir the CLI would recognize, with its state file WHERE THE CLI PUTS IT — the sibling
   *  `<home>/.claude.json` for the DEFAULT dir, inside for an override (`claudeStateFilePath`). */
  const claudeDir = (name: string, email?: string): string => {
    const dir = join(home, name);
    mkdirSync(join(dir, 'projects'), { recursive: true });
    if (email !== undefined) {
      writeFileSync(
        claudeStateFilePath(dir, { HOME: home }),
        JSON.stringify({
          oauthAccount: {
            emailAddress: email,
            displayName: 'M',
            organizationName: `${email}'s Organization`,
            organizationType: 'claude_max',
            organizationRateLimitTier: 'default_claude_max_20x',
          },
        }),
      );
    }
    return dir;
  };

  const discovered = async (app = makeApp()): Promise<DiscoveredAgentAccountsResponse> => {
    const res = await apiRequest(app, '/api/v1/workspace/agent-profiles/discovered');
    expect(res.status).toBe(200);
    return (await res.json()) as DiscoveredAgentAccountsResponse;
  };

  it('names each Claude dir on the machine by the account it is signed in as', async () => {
    claudeDir('.claude', 'first@example.com');
    claudeDir('.claude-bis', 'second@example.com');

    const { accounts } = await discovered();

    expect(accounts).toEqual([
      {
        provider: 'claude',
        configDir: join(home, '.claude'),
        identity: { email: 'first@example.com', plan: 'Max 20x' },
        // The discovered default is ALREADY an account — it is the first row of the listing above
        // this block — so it is offered as added rather than as something to add again.
        added: true,
      },
      {
        provider: 'claude',
        configDir: join(home, '.claude-bis'),
        identity: { email: 'second@example.com', plan: 'Max 20x' },
        added: false,
      },
    ]);
  });

  /** An unreadable identity is an ABSENT key, not `null` on the wire — the same spread discipline
   *  `status` follows on the listing, and what `contract-parity` exists to keep honest. */
  it('omits the identity key entirely for a dir that records no login', async () => {
    claudeDir('.claude');

    const [account] = (await discovered()).accounts;

    expect(account?.configDir).toBe(join(home, '.claude'));
    expect(account && 'identity' in account).toBe(false);
  });

  /**
   * `added` is a realpath comparison, and this is the negative control for it: the stored account
   * names a SYMLINK to the dir discovery found. A string compare answers `added: false` and the
   * pane offers an account cezar already has, under a second spelling, as if it were a new one.
   */
  it('computes added by realpath, so a second spelling of a stored dir is not offered again', async () => {
    claudeDir('.claude', 'first@example.com');
    const real = claudeDir('.claude-bis', 'second@example.com');
    symlinkSync(real, join(home, 'claude-link'));

    const added = await apiRequest(makeApp(), '/api/v1/workspace/agent-profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', configDir: join(home, 'claude-link'), label: 'work' }),
    });
    expect(added.status).toBe(201);

    const { accounts } = await discovered();

    expect(accounts.map((a) => [a.configDir, a.added])).toEqual([
      [join(home, '.claude'), true], // the discovered default, always already an account
      [join(home, '.claude-bis'), true], // stored under its symlinked spelling — realpath, not strcmp
    ]);
  });

  /** Hosted mode withholds it on the terms the rest of the family is withheld on: these are
   *  absolute paths on the host, and an empty list is the only honest hosted answer. */
  it('answers an empty list in hosted mode', async () => {
    claudeDir('.claude', 'first@example.com');
    process.env.CEZ_REMOTE = '1';

    expect((await discovered()).accounts).toEqual([]);
  });

  /**
   * D5's regression guard: the accounts LISTING carries no identity, ever.
   *
   * The `…/:id/details` assertion is what stops this from passing vacuously — without it the test
   * would be satisfied by a fixture whose identity is simply unreadable everywhere. Here the very
   * same dir answers an email on demand and answers nothing at all on the listing, which is the
   * distinction the rule is about.
   */
  it('keeps identity off the accounts listing while the details route still answers it', async () => {
    claudeDir('.claude', 'first@example.com');

    const listing = await apiRequest(makeApp(), '/api/v1/workspace/agent-profiles');
    const { profiles } = (await listing.json()) as AgentProfilesResponse;
    const claude = profiles.find((profile) => profile.provider === 'claude' && profile.isDefault);

    expect(claude?.path).toBe(join(home, '.claude'));
    expect(JSON.stringify(profiles)).not.toContain('first@example.com');
    expect(claude && 'identity' in claude).toBe(false);

    const details = await apiRequest(makeApp(), '/api/v1/workspace/agent-profiles/default:claude/details');
    expect(details.status).toBe(200);
    const identity = (await details.json()) as AgentAccountDetailsResponse;
    expect(identity.available).toBe(true);
    expect(identity.fields).toContainEqual({ label: 'Email', value: 'first@example.com' });
  });
});
