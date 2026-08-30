import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STEP_BUDGET,
  DEFAULT_WORKTREE_RETENTION,
  gatedSkillsRepos,
  loadConfig,
  ownConfigKeys,
  resolveWorktreeRetention,
} from './config.ts';
import { liveTitleUpdatesEnabled } from './runs/auto-name.ts';
import { reviewGateEnabled } from './runs/review-gate.ts';

/**
 * `config.json` schema roundtrips (R2 2.3: `systemPrompt?`). The invariants
 * under test: the key is additive (old files keep loading exactly as before),
 * a bad value degrades per-key instead of discarding the whole config, and
 * the value is trimmed with blank treated as unset.
 */
describe('loadConfig systemPrompt', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-config-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const write = (value: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');

  it('is undefined when no config file exists (zero-config default)', async () => {
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
  });

  it('old config files without the key still load unchanged (additive proof)', async () => {
    write({ maxParallel: 5, defaultRunner: 'codex', baseBranch: 'develop' });
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(5);
    expect(config.defaultRunner).toBe('codex');
    expect(config.baseBranch).toBe('develop');
  });

  it('roundtrips a configured prompt, trimmed', async () => {
    write({ systemPrompt: '  Always answer in Polish.  ' });
    expect((await loadConfig(repoRoot)).systemPrompt).toBe('Always answer in Polish.');
  });

  it('treats a whitespace-only prompt as unset without touching other keys', async () => {
    write({ systemPrompt: '   ', maxParallel: 3 });
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(3);
  });

  it('degrades an over-long prompt (>20k) to unset per-key, keeping the rest', async () => {
    write({ systemPrompt: 'x'.repeat(20_001), maxParallel: 4 });
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(4);
  });

  it('accepts a prompt at exactly the 20k cap', async () => {
    write({ systemPrompt: 'x'.repeat(20_000) });
    expect((await loadConfig(repoRoot)).systemPrompt).toHaveLength(20_000);
  });

  it('degrades a wrong-typed prompt to unset per-key, keeping the rest', async () => {
    write({ systemPrompt: 42, maxParallel: 6 });
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(6);
  });

  it('malformed JSON degrades to the full default (never throws)', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{not json', 'utf8');
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.maxParallel).toBe(2);
  });

  /** `defaultModels?` (R6 1.5) rides the same additive-key rules as `systemPrompt`. */
  describe('defaultModels', () => {
    it('is undefined when absent — old config files load unchanged', async () => {
      write({ maxParallel: 5 });
      const config = await loadConfig(repoRoot);
      expect(config.defaultModels).toBeUndefined();
      expect(config.maxParallel).toBe(5);
    });

    it('round-trips per-runner presets, trimmed', async () => {
      write({ defaultModels: { claude: ' opus ', opencode: 'openai/gpt-5.1' } });
      expect((await loadConfig(repoRoot)).defaultModels).toEqual({
        claude: 'opus',
        opencode: 'openai/gpt-5.1',
      });
    });

    it('degrades a bad value to unset per-key, keeping the rest of the config', async () => {
      write({ defaultModels: { claude: 42 }, maxParallel: 6 });
      const config = await loadConfig(repoRoot);
      expect(config.defaultModels).toBeUndefined();
      expect(config.maxParallel).toBe(6);
    });
  });

  describe('modelsLocked', () => {
    it('is optional and preserves only boolean values', async () => {
      expect((await loadConfig(repoRoot)).modelsLocked).toBeUndefined();

      write({ modelsLocked: true });
      expect((await loadConfig(repoRoot)).modelsLocked).toBe(true);

      write({ modelsLocked: 'yes', defaultRunner: 'codex' });
      const config = await loadConfig(repoRoot);
      expect(config.modelsLocked).toBeUndefined();
      expect(config.defaultRunner).toBe('codex');
    });
  });

  /** `worktreeRetention` (#483): count-based, always materialized (default `DEFAULT_WORKTREE_RETENTION`),
   *  `.catch(10)` so a bad value degrades to the default. `0` = unlimited. */
  describe('worktreeRetention', () => {
    it('defaults to 10 when absent (old config files load unchanged)', async () => {
      write({ maxParallel: 5 });
      const config = await loadConfig(repoRoot);
      expect(config.worktreeRetention).toBe(DEFAULT_WORKTREE_RETENTION);
      expect(config.maxParallel).toBe(5);
    });

    it('round-trips a configured count', async () => {
      write({ worktreeRetention: 3 });
      expect((await loadConfig(repoRoot)).worktreeRetention).toBe(3);
    });

    it('keeps 0 as a meaningful value (unlimited)', async () => {
      write({ worktreeRetention: 0 });
      expect((await loadConfig(repoRoot)).worktreeRetention).toBe(0);
    });

    it('degrades a bad value to the default (10) via .catch', async () => {
      write({ worktreeRetention: -4, maxParallel: 6 });
      const config = await loadConfig(repoRoot);
      expect(config.worktreeRetention).toBe(DEFAULT_WORKTREE_RETENTION);
      expect(config.maxParallel).toBe(6);
    });

    it('degrades a wrong-typed value to the default (10)', async () => {
      write({ worktreeRetention: 'lots' });
      expect((await loadConfig(repoRoot)).worktreeRetention).toBe(DEFAULT_WORKTREE_RETENTION);
    });
  });
});

/**
 * `resolveWorktreeRetention` — what every enforcement site (boot sweeps,
 * terminal transitions, the reclaim route) asks instead of reading the parsed
 * `worktreeRetention`. The workspace's `resources.worktreeRetentionDefault`
 * only *seeds* repos that set none, which is exactly what Settings → Worktrees
 * tells the user, so the precedence is the contract under test here.
 */
describe('resolveWorktreeRetention', () => {
  let repoRoot: string;
  let cezHome: string;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-retention-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    // Pinned so the suite never reads (or writes) the developer's real ~/.cezar.
    cezHome = mkdtempSync(join(tmpdir(), 'cez-home-'));
    process.env.CEZ_HOME = cezHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(cezHome, { recursive: true, force: true });
  });

  const writeRepo = (value: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');
  const writeWorkspace = (value: unknown) =>
    writeFileSync(join(cezHome, 'config.json'), JSON.stringify(value), 'utf8');

  it('inherits the workspace default when the repo sets nothing', async () => {
    writeWorkspace({ resources: { worktreeRetentionDefault: 4 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(4);
  });

  it('inherits it when the repo has no config file at all', async () => {
    rmSync(join(repoRoot, '.ai/cezar'), { recursive: true, force: true });
    writeWorkspace({ resources: { worktreeRetentionDefault: 7 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(7);
  });

  it('inherits 0 (unlimited) — the workspace default is a value, not a truthiness test', async () => {
    writeWorkspace({ resources: { worktreeRetentionDefault: 0 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(0);
  });

  it("keeps the repo's own value, workspace default ignored", async () => {
    writeRepo({ worktreeRetention: 3 });
    writeWorkspace({ resources: { worktreeRetentionDefault: 99 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(3);
  });

  it('keeps a repo value that happens to equal the historical default (10 is not a sentinel)', async () => {
    writeRepo({ worktreeRetention: 10 });
    writeWorkspace({ resources: { worktreeRetentionDefault: 2 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(10);
  });

  it("keeps the repo's explicit 0 over the workspace default", async () => {
    writeRepo({ worktreeRetention: 0 });
    writeWorkspace({ resources: { worktreeRetentionDefault: 5 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(0);
  });

  it('falls back to the built-in default when the workspace config is absent', async () => {
    writeRepo({ maxParallel: 5 });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(DEFAULT_WORKTREE_RETENTION);
  });

  it('falls back to the built-in default when the workspace config is corrupt (unreadable)', async () => {
    writeFileSync(join(cezHome, 'config.json'), '{ not json', 'utf8');
    expect(await resolveWorktreeRetention(repoRoot)).toBe(DEFAULT_WORKTREE_RETENTION);
  });

  it('falls back to the built-in default when the workspace default itself is out of bounds', async () => {
    writeWorkspace({ resources: { worktreeRetentionDefault: -1 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(DEFAULT_WORKTREE_RETENTION);
  });

  it('treats a repo value the schema would refuse as unset, so the workspace seeds it', async () => {
    writeRepo({ worktreeRetention: 'lots' });
    writeWorkspace({ resources: { worktreeRetentionDefault: 6 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(6);
  });

  it('treats a malformed repo config as unset', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{ nope', 'utf8');
    writeWorkspace({ resources: { worktreeRetentionDefault: 8 } });
    expect(await resolveWorktreeRetention(repoRoot)).toBe(8);
  });
});

/**
 * `gatedSkillsRepos` decides which repos are opt-in per skill (the "Import skills" flow). The
 * invariant: the repos listed in the EFFECTIVE `skillsRepos` are gated (opt-out per skill) —
 * curation applies to whatever team repos an operator has configured. There is no separate
 * raw-file probe: `loadConfig`'s own degradation (a missing file, malformed JSON, or a
 * non-object root all fall back to the schema default, `[]`) is what this function relies on.
 */
describe('gatedSkillsRepos', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-gate-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const configPath = () => join(repoRoot, '.ai/cezar', 'config.json');
  const write = (value: unknown) => writeFileSync(configPath(), JSON.stringify(value), 'utf8');

  it('gates a configured repo (anti-vacuity: proves the gate can return non-empty)', async () => {
    write({ skillsRepos: [{ repo: 'acme/team-skills', ref: 'main' }] });
    expect([...(await gatedSkillsRepos(repoRoot))]).toEqual(['acme/team-skills']);
  });

  it('gates every configured repo, not just the first', async () => {
    write({ skillsRepos: [{ repo: 'a/one' }, { repo: 'b/two' }] });
    expect([...(await gatedSkillsRepos(repoRoot))]).toEqual(['a/one', 'b/two']);
  });

  it('gates nothing even when skillsRepos is set to empty (an explicit opt-out)', async () => {
    write({ skillsRepos: [] });
    expect((await gatedSkillsRepos(repoRoot)).size).toBe(0);
  });

  it('gates nothing when the config omits skillsRepos (no repos configured)', async () => {
    write({ maxParallel: 4 });
    expect((await gatedSkillsRepos(repoRoot)).size).toBe(0);
  });

  it('gates nothing when there is no config file at all (zero-config)', async () => {
    expect((await gatedSkillsRepos(repoRoot)).size).toBe(0);
  });

  it('degrades malformed JSON to no repos gated, via loadConfig', async () => {
    writeFileSync(configPath(), '{ nope', 'utf8');
    expect((await gatedSkillsRepos(repoRoot)).size).toBe(0);
  });

  it('degrades a non-object root to no repos gated, via loadConfig', async () => {
    writeFileSync(configPath(), '[]', 'utf8');
    expect((await gatedSkillsRepos(repoRoot)).size).toBe(0);
  });
});

/**
 * Machine-wide agent defaults (spec 2026-07-29-agent-profiles): what a repo that has set none of
 * its own runs, so a second login and a model preference are configured once instead of per
 * checkout.
 *
 * The load-bearing property is that these are DEFAULTS. A repo key always wins, and the fallback is
 * applied to the RAW object before parsing — `defaultRunner`'s `.default('claude')` materializes the
 * key, so after a parse there is no telling "the user chose claude" from "the user said nothing".
 */
describe('loadConfig machine-wide agent defaults', () => {
  let repoRoot: string;
  let cezHome: string;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-machine-defaults-'));
    cezHome = mkdtempSync(join(tmpdir(), 'cez-machine-home-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    process.env.CEZ_HOME = cezHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    for (const dir of [repoRoot, cezHome]) rmSync(dir, { recursive: true, force: true });
  });

  const writeRepo = (value: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');
  const writeMachine = (agentDefaults: unknown) =>
    writeFileSync(join(cezHome, 'config.json'), JSON.stringify({ agentDefaults }), 'utf8');

  it('fills a repo that has no config file at all', async () => {
    writeMachine({ runner: 'codex', models: { codex: 'gpt-5' } });
    const config = await loadConfig(repoRoot);
    expect(config.defaultRunner).toBe('codex');
    expect(config.defaultModels?.codex).toBe('gpt-5');
  });

  it('fills a repo whose config says nothing about the runner', async () => {
    writeMachine({ runner: 'codex' });
    writeRepo({ systemPrompt: 'be brief' });
    expect((await loadConfig(repoRoot)).defaultRunner).toBe('codex');
  });

  it('NEVER overrules a repo that chose — that is what makes it a default', async () => {
    writeMachine({ runner: 'codex' });
    writeRepo({ defaultRunner: 'claude' });
    expect((await loadConfig(repoRoot)).defaultRunner).toBe('claude');
  });

  it('merges models per RUNNER, so pinning one does not discard the others', async () => {
    // Whole-object precedence would silently drop the machine's codex preset the moment a repo
    // pinned claude's — a loss nobody asked for and nothing would report.
    writeMachine({ models: { claude: 'machine-claude', codex: 'machine-codex' } });
    writeRepo({ defaultModels: { claude: 'repo-claude' } });
    const config = await loadConfig(repoRoot);
    expect(config.defaultModels).toEqual({ claude: 'repo-claude', codex: 'machine-codex' });
  });

  it('changes nothing when the machine has no opinion — the zero-config path', async () => {
    writeRepo({ systemPrompt: 'be brief' });
    const config = await loadConfig(repoRoot);
    expect(config.defaultRunner).toBe('claude');
    expect(config.defaultModels).toBeUndefined();
  });

  it('degrades to the built-in default when the machine file is corrupt', async () => {
    writeFileSync(join(cezHome, 'config.json'), '{not json', 'utf8');
    expect((await loadConfig(repoRoot)).defaultRunner).toBe('claude');
  });

  it('ignores a machine runner the schema refuses, rather than failing the load', async () => {
    writeMachine({ runner: 'not-an-agent' });
    writeRepo({ systemPrompt: 'be brief' });
    const config = await loadConfig(repoRoot);
    expect(config.defaultRunner).toBe('claude');
    expect(config.systemPrompt).toBe('be brief');
  });
});

/**
 * The machine tier for the four per-repo run knobs that have one
 * (`.ai/specs/2026-08-21-one-settings-area.md`, Phase 3): `projectDefaults` in
 * `~/.cezar/config.json`.
 *
 * The load-bearing properties, in the order the spec's Risks list them:
 *  - **the repo always wins** — this is a DEFAULT, not an override, and a page that says
 *    "Overridden" beside a field is lying the moment that stops being true;
 *  - **an empty tier is indistinguishable from before the tier existed**, `liveTitleUpdates`'
 *    env-default-ON and `reviewGate`'s env-default-OFF included. Those two resolve through
 *    mirror-image functions with opposite defaults, so both directions are pinned;
 *  - **`stepBudget` carries a `.default(0)`**, so seeding it must happen on the RAW object before
 *    the parse or "the user chose 0" and "the user said nothing" collapse into one answer.
 */
describe('loadConfig projectDefaults (the machine tier)', () => {
  let repoRoot: string;
  let cezHome: string;
  const savedHome = process.env.CEZ_HOME;
  const savedTitles = process.env.CEZ_TITLE_UPDATES;
  const savedGate = process.env.CEZ_REVIEW_GATE;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-project-defaults-'));
    cezHome = mkdtempSync(join(tmpdir(), 'cez-project-defaults-home-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    process.env.CEZ_HOME = cezHome;
    // No env opinion, so the built-in fallbacks are what answer — the zero-config baseline this
    // whole block is measured against.
    delete process.env.CEZ_TITLE_UPDATES;
    delete process.env.CEZ_REVIEW_GATE;
  });

  afterEach(() => {
    for (const [name, saved] of [
      ['CEZ_HOME', savedHome],
      ['CEZ_TITLE_UPDATES', savedTitles],
      ['CEZ_REVIEW_GATE', savedGate],
    ] as const) {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
    for (const dir of [repoRoot, cezHome]) rmSync(dir, { recursive: true, force: true });
  });

  const writeRepo = (value: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');
  const writeMachine = (projectDefaults: unknown) =>
    writeFileSync(join(cezHome, 'config.json'), JSON.stringify({ projectDefaults }), 'utf8');

  it('seeds a repo that is silent — the whole point of the tier', async () => {
    writeMachine({ reviewGate: true, systemPrompt: 'be brief', stepBudget: 12 });
    const config = await loadConfig(repoRoot);
    expect(config.reviewGate).toBe(true);
    expect(config.systemPrompt).toBe('be brief');
    expect(config.stepBudget).toBe(12);
  });

  it('seeds a repo whose config file exists but says nothing about the key', async () => {
    writeMachine({ liveTitleUpdates: false });
    writeRepo({ maxParallel: 5 });
    const config = await loadConfig(repoRoot);
    expect(config.liveTitleUpdates).toBe(false);
    expect(config.maxParallel).toBe(5);
  });

  it('NEVER overrules a repo that chose — including a repo choosing FALSE', async () => {
    // `false` is the case a naive `??` gets wrong, and it is the common one: a repo deliberately
    // turning the gate off must not be re-enabled by the machine.
    writeMachine({ reviewGate: true });
    writeRepo({ reviewGate: false });
    expect((await loadConfig(repoRoot)).reviewGate).toBe(false);

    // …and it stays false when the machine changes its mind again.
    writeMachine({ reviewGate: false });
    expect((await loadConfig(repoRoot)).reviewGate).toBe(false);
    writeMachine({ reviewGate: true });
    expect((await loadConfig(repoRoot)).reviewGate).toBe(false);
  });

  it('a repo `stepBudget: 0` beats a machine budget — 0 is a choice, not an absence', async () => {
    writeMachine({ stepBudget: 25 });
    writeRepo({ stepBudget: 0 });
    expect((await loadConfig(repoRoot)).stepBudget).toBe(0);
  });

  it('an EMPTY tier reproduces the pre-change behaviour byte for byte', async () => {
    writeMachine({});
    const config = await loadConfig(repoRoot);
    expect(config.systemPrompt).toBeUndefined();
    expect(config.liveTitleUpdates).toBeUndefined();
    expect(config.reviewGate).toBeUndefined();
    expect(config.stepBudget).toBe(DEFAULT_STEP_BUDGET);
    // The two env fallbacks have OPPOSITE defaults, and both must be untouched: an unset
    // `liveTitleUpdates` still resolves ON, an unset `reviewGate` still resolves OFF.
    expect(liveTitleUpdatesEnabled(config, {})).toBe(true);
    expect(reviewGateEnabled(config, {})).toBe(false);
  });

  it('no machine file at all is the same as an empty tier', async () => {
    const config = await loadConfig(repoRoot);
    expect(config.liveTitleUpdates).toBeUndefined();
    expect(config.reviewGate).toBeUndefined();
    expect(liveTitleUpdatesEnabled(config, {})).toBe(true);
    expect(reviewGateEnabled(config, {})).toBe(false);
  });

  it('sits ABOVE the env, so the order is repo → machine → env → hardcoded', async () => {
    // The env says OFF; the machine says ON; nobody in the repo said anything. The machine wins,
    // because seeding happens before `reviewGateEnabled` ever consults the env.
    writeMachine({ reviewGate: true });
    expect(reviewGateEnabled(await loadConfig(repoRoot), { CEZ_REVIEW_GATE: '' })).toBe(true);
    // With the machine silent the env is back in charge, unchanged.
    writeMachine({});
    expect(reviewGateEnabled(await loadConfig(repoRoot), { CEZ_REVIEW_GATE: '1' })).toBe(true);
    expect(reviewGateEnabled(await loadConfig(repoRoot), {})).toBe(false);
  });

  it('degrades a bad machine value per key instead of discarding the tier', async () => {
    writeMachine({ reviewGate: 'yes', liveTitleUpdates: false });
    const config = await loadConfig(repoRoot);
    expect(config.reviewGate).toBeUndefined();
    expect(config.liveTitleUpdates).toBe(false);
  });

  it('keeps agentDefaults working beside it — one file, two tiers', async () => {
    writeFileSync(
      join(cezHome, 'config.json'),
      JSON.stringify({ agentDefaults: { runner: 'codex' }, projectDefaults: { reviewGate: true } }),
      'utf8',
    );
    const config = await loadConfig(repoRoot);
    expect(config.defaultRunner).toBe('codex');
    expect(config.reviewGate).toBe(true);
  });
});

/**
 * `ownConfigKeys` — what `GET /api/v1/config`'s `overridden` list is built from
 * (`.ai/specs/2026-08-21-one-settings-area.md`, Phase 3).
 *
 * It exists because `loadConfig` CANNOT answer this: schema defaults and the machine tier both
 * materialize keys, so the parsed config cannot tell a value this repo chose from one something
 * else supplied. A field labelled "Overridden" off a parsed config would be wrong for every
 * defaulted key in the file.
 */
describe('ownConfigKeys', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-own-keys-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  });

  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  const write = (value: unknown) =>
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value), 'utf8');

  it('is empty when there is no config file', async () => {
    expect(await ownConfigKeys(repoRoot)).toEqual([]);
  });

  it('lists only keys the RAW file sets, never a defaulted one', async () => {
    write({ reviewGate: false, baseBranch: 'develop' });
    expect(await ownConfigKeys(repoRoot)).toEqual(['baseBranch', 'reviewGate']);
    // `worktreeRetention`, `stepBudget`, `maxParallel` and `defaultRunner` all carry schema
    // defaults and are absent from the file — so they are absent here too.
    const config = await loadConfig(repoRoot);
    expect(config.worktreeRetention).toBe(DEFAULT_WORKTREE_RETENTION);
    expect(await ownConfigKeys(repoRoot)).not.toContain('worktreeRetention');
  });

  it('reports a user key the schema knows nothing about — the file is the authority', async () => {
    write({ skillsRepos: [], somethingHandAdded: 1 });
    expect(await ownConfigKeys(repoRoot)).toEqual(['skillsRepos', 'somethingHandAdded']);
  });

  it('treats malformed JSON as unset, exactly as loadConfig does', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{not json', 'utf8');
    expect(await ownConfigKeys(repoRoot)).toEqual([]);
  });
});
