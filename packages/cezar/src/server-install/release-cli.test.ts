import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateReleasesCommand, releaseDeployCommand, socketUnitName, unexpectedEntries } from './release-cli.ts';
import { activate, freshLedger, loadLedger, recordBuilt, saveLedger } from './releases.ts';
import type { ProbeResult } from './deploy-strategy.ts';
import type { ReleaseDeployHost } from './release-deploy.ts';

/**
 * `cezar server-migrate-releases` — the one-shot that turns a hand-provisioned box into the
 * release layout P1 needs, and installs the socket/slice units P3/P4 need.
 *
 * It is a separate command rather than a `server-install` step because the live `cezar.service` on
 * `prod-host` is hand-written (its Description is one no generator in this repo emits) and
 * carries three operator drop-ins holding the Cloudflare token, the 1Password service-account
 * token and the agent env passthrough. So the migration may only ADD, must be idempotent, and must
 * refuse rather than guess when it finds something it does not recognise — because everything it
 * moves ends up in a release directory, and release directories get pruned.
 */
describe('server-migrate-releases', () => {
  let root: string;
  let linkPath: string;
  let releasesDir: string;
  let etc: string;
  const logs: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-migrate-'));
    linkPath = join(root, 'opt-cezar');
    releasesDir = join(root, 'opt-cezar-releases');
    etc = join(root, 'etc');
    mkdirSync(join(linkPath, 'packages'), { recursive: true });
    writeFileSync(join(linkPath, 'package.json'), '{"name":"cezar"}');
    writeFileSync(join(linkPath, '.deployed-commit'), '37a9a978 (on-box worktree build)\n');
    logs.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  // `systemdDir` is a test seam — production never passes it. The unit TEXT is asserted in
  // `socket-unit.test.ts`; these assert the layout move and idempotence.
  const migrate = (apply: boolean) =>
    migrateReleasesCommand({ linkPath, releasesDir, systemdDir: etc, apply });

  it('plans without changing anything until --yes', async () => {
    const code = await migrateReleasesCommand({ linkPath, releasesDir, apply: false });
    expect(code).toBe(0);
    // A directory is still a directory: the plan is a plan.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(logs.join('\n')).toContain('Nothing was changed');
  });

  it('refuses when the install path holds something a build would not have put there', async () => {
    // Anything unaccounted for might be state someone relies on, and it would be moved into a
    // release directory — which is pruned. Refusing is the only safe answer.
    writeFileSync(join(linkPath, 'operator-notes.txt'), 'do not delete');
    const code = await migrateReleasesCommand({ linkPath, releasesDir, apply: true });
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('operator-notes.txt');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
  });

  it('tolerates the build leftovers the spec names, and nothing else', () => {
    // `.ai/` is a build-time leftover nothing reads at runtime (the unit's WorkingDirectory is
    // elsewhere) and `.deployed-commit` becomes a derived ledger field.
    const entries = unexpectedEntries(linkPath, () => ['.ai', '.deployed-commit', 'packages', 'node_modules', 'weird']);
    expect(entries).toEqual(['weird']);
  });

  it('makes the install path a SYMLINK and records the release in the ledger', async () => {
    const code = await migrate(true);
    expect(code).toBe(0);

    // The spec's P1 decision, load-bearing: `/opt/cezar` itself becomes the symlink, because the
    // unit's ExecStart and all three /usr/local/bin wrappers already point THROUGH it. Nothing
    // else on the box has to change.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    const target = readlinkSync(linkPath);
    expect(target.startsWith(releasesDir)).toBe(true);
    // The moved tree is intact at the far end of the link.
    expect(readFileSync(join(linkPath, 'package.json'), 'utf8')).toBe('{"name":"cezar"}');

    const ledger = loadLedger(releasesDir);
    expect(ledger.current).toBe(target.slice(releasesDir.length + 1));
    // The free-text `.deployed-commit` becomes a real field: the sha is parsed out of it.
    expect(ledger.releases[0]?.id).toContain('37a9a97');
  });

  it('writes the socket unit, the numbered drop-in and the slice — adding only', async () => {
    await migrate(true);
    expect(readFileSync(join(etc, 'cezar.socket'), 'utf8')).toContain('ListenStream=127.0.0.1:4321');
    // 40-, so it sorts AFTER the three operator drop-ins on this box and never replaces one.
    const dropIn = readFileSync(join(etc, 'cezar.service.d', '40-non-disruptive.conf'), 'utf8');
    expect(dropIn).toContain('Sockets=cezar.socket');
    // The directive that actually saves in-flight runs: with the default `control-group`,
    // `systemctl restart` SIGKILLs every agent cezar has spawned.
    expect(dropIn).toContain('KillMode=process');
    expect(readFileSync(join(etc, 'cezar-runs.slice'), 'utf8')).toContain('[Slice]');
  });

  it('is idempotent — running it twice changes nothing the second time', async () => {
    await migrate(true);
    const target = readlinkSync(linkPath);
    const ledgerBefore = readFileSync(join(releasesDir, 'deploy.json'), 'utf8');

    logs.length = 0;
    const code = await migrate(true);

    expect(code).toBe(0);
    expect(readlinkSync(linkPath)).toBe(target);
    expect(readFileSync(join(releasesDir, 'deploy.json'), 'utf8')).toBe(ledgerBefore);
    expect(logs.join('\n')).toContain('already a symlink');
    expect(logs.join('\n')).toContain('is already current');
  });

  it('fails loudly when there is nothing installed to migrate', async () => {
    const code = await migrateReleasesCommand({ linkPath: join(root, 'nope'), releasesDir, apply: true });
    expect(code).toBe(1);
  });

  describe('runAsUid ordering hardening (Phase 0.3 of the broker-scope-isolation spec)', () => {
    // Real uid 0 (root) always resolves — no useradd/id fixture needed to exercise the happy path.
    it('reads the base unit\'s User= line and orders the drop-in after that user manager', async () => {
      mkdirSync(etc, { recursive: true });
      writeFileSync(join(etc, 'cezar.service'), '[Unit]\nDescription=x\n\n[Service]\nUser=root\nExecStart=/bin/true\n');
      await migrate(true);
      const dropIn = readFileSync(join(etc, 'cezar.service.d', '40-non-disruptive.conf'), 'utf8');
      expect(dropIn).toContain('[Unit]');
      expect(dropIn).toContain('After=user@0.service');
      expect(dropIn).toContain('Wants=user@0.service');
    });

    it('skips the [Unit] section, without failing, when the base unit has no User= line', async () => {
      mkdirSync(etc, { recursive: true });
      writeFileSync(join(etc, 'cezar.service'), '[Unit]\nDescription=x\n\n[Service]\nExecStart=/bin/true\n');
      const code = await migrate(true);
      expect(code).toBe(0);
      const dropIn = readFileSync(join(etc, 'cezar.service.d', '40-non-disruptive.conf'), 'utf8');
      expect(dropIn).not.toContain('[Unit]');
      expect(logs.join('\n')).toContain('no User= line');
    });

    it('skips the [Unit] section, without failing, when the base unit does not exist', async () => {
      // `etc` is created lazily by the migration itself, so the base unit genuinely isn't there yet.
      const code = await migrate(true);
      expect(code).toBe(0);
      const dropIn = readFileSync(join(etc, 'cezar.service.d', '40-non-disruptive.conf'), 'utf8');
      expect(dropIn).not.toContain('[Unit]');
      expect(logs.join('\n')).toContain('could not read');
    });
  });
});

describe('server-deploy (releaseDeployCommand) --dry-run', () => {
  /**
   * `.ai/specs/2026-08-22-server-deploy-dry-run-flag.md` Phase 4: none of the CLI-level wiring for
   * `--dry-run` had a regression test before this — `release-deploy.test.ts:198-205` only calls
   * `runReleaseDeploy` directly, never `releaseDeployCommand`. The exit-code-0 assertion alone
   * would pass against the "Deploy complete." regression this same spec's plumbing would otherwise
   * introduce (see the spec's Solution), so this asserts on the printed text too.
   */
  let root: string;
  let linkPath: string;
  let releasesDir: string;
  let source: string;
  const logs: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-deploy-cli-'));
    releasesDir = join(root, 'releases');
    const seed = join(releasesDir, '20260101T000000Z-old');
    mkdirSync(seed, { recursive: true });
    linkPath = join(root, 'cezar');
    symlinkSync(seed, linkPath);
    source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    logs.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function fakeHost(): ReleaseDeployHost {
    return {
      async stage() {
        throw new Error('a dry run must never stage');
      },
      async smokeBoot(): Promise<ProbeResult> {
        throw new Error('a dry run must never smoke-boot');
      },
      async restart() {
        throw new Error('a dry run must never restart');
      },
      async probeReady(): Promise<ProbeResult> {
        throw new Error('a dry run must never probe');
      },
      async waitReady(): Promise<ProbeResult> {
        throw new Error('a dry run must never probe');
      },
      freeBytes: () => Number.POSITIVE_INFINITY,
      now: () => '2026-08-22T09:00:00.000Z',
      spawnDetached: () => {
        throw new Error('a dry run must never hand off to a transient unit');
      },
      systemdRunAvailable: () => false,
      cgroup: () => '0::/user.slice/session-1.scope',
      killMode: () => 'process',
    };
  }

  it('exits 0 and reports a dry run, not a completed deploy', async () => {
    const code = await releaseDeployCommand(
      { strategy: 'blue-green', source, linkPath, releasesDir, dryRun: true },
      fakeHost(),
    );

    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('Dry run complete');
    expect(out).not.toContain('Deploy complete.');
  });
});

describe('socketUnitName', () => {
  it('derives the socket unit from the service unit', () => {
    expect(socketUnitName('cezar.service')).toBe('cezar.socket');
    expect(socketUnitName('cezar-org.service')).toBe('cezar-org.socket');
  });
});

describe('unexpectedEntries — derived from the source checkout (corrected 2026-08-21)', () => {
  /**
   * The regression this locks: a hardcoded allowlist refused a HEALTHY build tree on the real box,
   * because it had never heard of AGENT_PROTOCOL.md / CODE_REVIEW.md / SDLC.md / .env.example /
   * .github / alias-cezar. The operator's very first command failed on a correct install.
   */
  const REAL_BOX = [
    '.ai',
    '.deployed-commit',
    '.env.example',
    '.github',
    '.gitignore',
    'AGENTS.md',
    'AGENT_PROTOCOL.md',
    'BACKWARD_COMPATIBILITY.md',
    'CHANGELOG.md',
    'CODE_REVIEW.md',
    'LICENSE',
    'README.md',
    'SDLC.md',
    'alias-cezar',
    'docs',
    'node_modules',
    'package-lock.json',
    'package.json',
    'packages',
    'scripts',
    'vitest.config.ts',
  ];
  const SOURCE = REAL_BOX.filter((e) => !['.ai', '.deployed-commit', 'node_modules'].includes(e));

  const read = (p: string) => (p === '/src' ? SOURCE : REAL_BOX);

  it('accepts a healthy build tree once the source defines what belongs', () => {
    expect(unexpectedEntries('/opt/cezar', read, '/src')).toEqual([]);
  });

  it('still flags the cruft a hand-run deploy leaves behind', () => {
    const withCruft = (p: string) =>
      p === '/src'
        ? SOURCE
        : [
            ...REAL_BOX,
            '.deployed-commit.bak.20260821-134917',
            'AGENTS.md.bak.20260820-131525',
            '.deploy-verify-f53f5a58.log',
            '.deployed-notes.md',
          ];
    expect(unexpectedEntries('/opt/cezar', withCruft, '/src')).toEqual([
      '.deployed-commit.bak.20260821-134917',
      'AGENTS.md.bak.20260820-131525',
      '.deploy-verify-f53f5a58.log',
      '.deployed-notes.md',
    ]);
  });

  it('without a source it falls back to the static core — refusing too much, never too little', () => {
    // Deleting an operator's file is unrecoverable; refusing by hand is not. So the no-source
    // path must NOT pass everything through.
    const stray = unexpectedEntries('/opt/cezar', read);
    expect(stray).toContain('AGENT_PROTOCOL.md');
    expect(stray).not.toContain('packages');
  });

  it('an unreadable source degrades to the static core rather than throwing', () => {
    const boom = (p: string) => {
      if (p === '/src') throw new Error('ENOENT');
      return REAL_BOX;
    };
    expect(() => unexpectedEntries('/opt/cezar', boom, '/src')).not.toThrow();
    expect(unexpectedEntries('/opt/cezar', boom, '/src')).toContain('AGENT_PROTOCOL.md');
  });
});

describe('releaseDeployCommand rollback', () => {
  let root: string;
  let linkPath: string;
  let releasesDir: string;
  let source: string;
  const output: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-rollback-cli-'));
    releasesDir = join(root, 'releases');
    linkPath = join(root, 'cezar');
    source = join(root, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'package.json'), '{"version":"0.0.0"}');
    for (const id of ['r1', 'r2']) mkdirSync(join(releasesDir, id), { recursive: true });
    let ledger = recordBuilt(freshLedger(), { id: 'r1', builtAt: '2026-08-22T00:00:00.000Z', healthy: true });
    ledger = activate(ledger, 'r1', '2026-08-22T00:00:01.000Z');
    ledger = recordBuilt(ledger, { id: 'r2', builtAt: '2026-08-22T00:00:02.000Z', healthy: true });
    ledger = activate(ledger, 'r2', '2026-08-22T00:00:03.000Z');
    saveLedger(releasesDir, ledger);
    symlinkSync(join(releasesDir, 'r2'), linkPath);
    output.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => output.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => output.push(args.join(' ')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function host(results: ProbeResult[]): ReleaseDeployHost {
    let probe = 0;
    return {
      async stage() {},
      async smokeBoot() { return { ok: true }; },
      async restart() {},
      async probeReady() { return { ok: true }; },
      async waitReady() { return results[probe++] ?? { ok: true }; },
      freeBytes: () => Number.POSITIVE_INFINITY,
      now: () => '2026-08-22T00:00:04.000Z',
      spawnDetached: () => ({ ok: true }),
      systemdRunAvailable: () => false,
      cgroup: () => '0::/user.slice/cezar-runs.slice',
      killMode: () => 'process',
    };
  }

  const runRollbackCli = (results: ProbeResult[]) => releaseDeployCommand({
    strategy: 'blue-green',
    rollback: '',
    source,
    linkPath,
    releasesDir,
    sha: 'abcdef0',
  }, host(results));

  it('reports a proven rollback without the generic deploy-complete claim', async () => {
    expect(await runRollbackCli([{ ok: true }])).toBe(0);
    expect(output.join('\n')).toContain('Rolled back to r1: /api/v1/ready passed.');
    expect(output.join('\n')).not.toContain('Deploy complete.');
  });

  it('reports a dead rollback target distinctly and never claims the previous release is serving', async () => {
    const ledger = loadLedger(releasesDir);
    saveLedger(releasesDir, { ...ledger, releases: ledger.releases.map((release) => release.id === 'r2' ? { ...release, healthy: false } : release) });

    expect(await runRollbackCli([{ ok: false, detail: 'probe boom' }])).toBe(1);
    expect(output.join('\n')).toContain('Rollback FAILED: r1 did not become ready: probe boom');
    expect(output.join('\n')).not.toContain('the previous release is serving');
  });

  it('reports a failed target and the prior release restored and proven ready', async () => {
    expect(await runRollbackCli([{ ok: false, detail: 'r1 dead' }, { ok: true }])).toBe(1);
    expect(output.join('\n')).toContain('Rollback FAILED: r1 did not become ready: r1 dead');
    expect(output.join('\n')).toContain('Restored r2, which probed ready');
  });
});
