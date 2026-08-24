import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCodexResumeModel } from './codex-resume-model.ts';
import type { ModelOption } from './runner-model-catalog.ts';

/** Lets exactly one test force `readAgentModelSettings` to throw, the same
 *  `vi.hoisted` + `importOriginal` shape `codex-app-server-runner.test.ts` uses for its own
 *  single-test override — every other test in this file passes straight through to the real
 *  reader. */
const modelsMock = vi.hoisted(() => ({ throwOnce: false }));

vi.mock('../agent-config/models.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-config/models.ts')>();
  return {
    ...actual,
    readAgentModelSettings: async (...args: Parameters<typeof actual.readAgentModelSettings>) => {
      if (modelsMock.throwOnce) {
        modelsMock.throwOnce = false;
        throw new Error('injected readAgentModelSettings failure');
      }
      return actual.readAgentModelSettings(...args);
    },
  };
});

const NO_CATALOG = async (): Promise<ModelOption[]> => [];
const THROWING_CATALOG = async (): Promise<ModelOption[]> => {
  throw new Error('catalog discovery failed');
};

function preset(id: string): ModelOption {
  return { id, label: id, description: '' };
}

describe('resolveCodexResumeModel', () => {
  const roots: string[] = [];

  afterEach(() => {
    modelsMock.throwOnce = false;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function emptyRepoRoot(): { repoRoot: string; env: NodeJS.ProcessEnv } {
    const repoRoot = mkdtempSync(join(tmpdir(), 'cez-resume-model-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-resume-model-home-'));
    roots.push(repoRoot, home);
    return { repoRoot, env: { HOME: home } };
  }

  it('a servable pinned model wins over everything else', async () => {
    const { repoRoot, env } = emptyRepoRoot();
    mkdirSync(join(repoRoot, '.codex'), { recursive: true });
    writeFileSync(join(repoRoot, '.codex', 'config.toml'), 'model = "gpt-5.4"\n');

    await expect(
      resolveCodexResumeModel({ pinned: 'gpt-5.6-terra', discover: NO_CATALOG, repoRoot, env }),
    ).resolves.toEqual({ model: 'gpt-5.6-terra', source: 'pinned' });
  });

  it('R4 — a pinned model that conflicts with codex is rejected and falls through to config', async () => {
    const { repoRoot, env } = emptyRepoRoot();
    mkdirSync(join(repoRoot, '.codex'), { recursive: true });
    writeFileSync(join(repoRoot, '.codex', 'config.toml'), 'model = "gpt-5.4"\n');

    // 'sonnet' is a claude preset (KNOWN_PRESETS_BY_RUNNER.claude), so it conflicts with codex —
    // this is the exact class of record that made runs 9cd43b1b/0f59fcd0's continuation path
    // unsafe, per the spec's Solution section.
    await expect(
      resolveCodexResumeModel({ pinned: 'sonnet', discover: NO_CATALOG, repoRoot, env }),
    ).resolves.toEqual({ model: 'gpt-5.4', source: 'config' });
  });

  it('the configured default wins over the catalog', async () => {
    const { repoRoot, env } = emptyRepoRoot();
    mkdirSync(join(repoRoot, '.codex'), { recursive: true });
    writeFileSync(join(repoRoot, '.codex', 'config.toml'), 'model = "gpt-5.4"\n');
    const discover = vi.fn(async () => [preset('gpt-5.6-sol')]);

    await expect(
      resolveCodexResumeModel({ discover, repoRoot, env }),
    ).resolves.toEqual({ model: 'gpt-5.4', source: 'config' });
    expect(discover).not.toHaveBeenCalled();
  });

  it('the wire-form control: a non-openai model_provider resolves to the bare model id', async () => {
    const { repoRoot, env } = emptyRepoRoot();
    mkdirSync(join(repoRoot, '.codex'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.codex', 'config.toml'),
      'model = "deepseek-chat"\nmodel_provider = "deepseek"\n',
    );

    await expect(
      resolveCodexResumeModel({ discover: NO_CATALOG, repoRoot, env }),
    ).resolves.toEqual({ model: 'deepseek-chat', source: 'config' });
  });

  it('an unresolvable provider pairing (ModelIdentityError) falls through to the catalog', async () => {
    const { repoRoot, env } = emptyRepoRoot();
    mkdirSync(join(repoRoot, '.codex'), { recursive: true });
    // A literal `provider/model` value with no matching `model_provider` — `normalizeModelForBackend`
    // throws `ModelIdentityError` for this on codex (foreign provider, no configured pairing).
    writeFileSync(join(repoRoot, '.codex', 'config.toml'), 'model = "anthropic/claude-sonnet-5"\n');

    await expect(
      resolveCodexResumeModel({ discover: async () => [preset('gpt-5.6-sol')], repoRoot, env }),
    ).resolves.toEqual({ model: 'gpt-5.6-sol', source: 'catalog' });
  });

  it('a throwing readAgentModelSettings degrades to the catalog rather than rejecting the resume', async () => {
    const { repoRoot, env } = emptyRepoRoot();
    modelsMock.throwOnce = true;

    await expect(
      resolveCodexResumeModel({ discover: async () => [preset('gpt-5.6-sol')], repoRoot, env }),
    ).resolves.toEqual({ model: 'gpt-5.6-sol', source: 'catalog' });
  });

  it('picks the first catalog entry that is in KNOWN_PRESETS_BY_RUNNER.codex, not the plain first', async () => {
    const { repoRoot, env } = emptyRepoRoot();
    const discover = async () => [preset('gpt-5.5'), preset('gpt-5.6-sol'), preset('gpt-5.6-terra')];

    await expect(
      resolveCodexResumeModel({ discover, repoRoot, env }),
    ).resolves.toEqual({ model: 'gpt-5.6-sol', source: 'catalog' });
  });

  it('falls back to the plain first catalog entry when none of it is in the 5.6 family', async () => {
    const { repoRoot, env } = emptyRepoRoot();
    const discover = async () => [preset('gpt-5.4'), preset('gpt-5.4-mini')];

    await expect(
      resolveCodexResumeModel({ discover, repoRoot, env }),
    ).resolves.toEqual({ model: 'gpt-5.4', source: 'catalog' });
  });

  it('is unavailable, with no model, when the catalog throws', async () => {
    const { repoRoot, env } = emptyRepoRoot();

    await expect(
      resolveCodexResumeModel({ discover: THROWING_CATALOG, repoRoot, env }),
    ).resolves.toEqual({ source: 'unavailable' });
  });

  it('is unavailable, with no model, when the catalog is empty', async () => {
    const { repoRoot, env } = emptyRepoRoot();

    await expect(
      resolveCodexResumeModel({ discover: NO_CATALOG, repoRoot, env }),
    ).resolves.toEqual({ source: 'unavailable' });
  });
});
