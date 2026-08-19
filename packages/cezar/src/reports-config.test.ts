import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readWorkspaceReportsConfig } from './reports-config.ts';

/**
 * `reports-config.ts` — the `reports` key of `~/.cezar/config.json`
 * (`.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`, "Reports is a workspace tab"
 * amendment).
 *
 * The contract under test is the one `knowledge/paths.ts`'s `readWorkspaceKnowledgeMountConfig`
 * sets and this reader copies: **never throws, every failure degrades to `{}`**. That matters
 * because this reader sits on a MAIN path — the queue calls it on every request — so a config the
 * schema refuses must leave the tab readable with the family's defaults rather than taking it down.
 * Degradation is only safe if it is total, which is why every failure mode below is asserted
 * individually rather than by one happy-path test plus a shrug.
 */

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(config?: unknown): Promise<NodeJS.ProcessEnv> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, 'cez-reports-config-'));
  dirs.push(dir);
  const home = join(dir, '.cezar');
  await mkdir(home, { recursive: true });
  if (config !== undefined) {
    await writeFile(join(home, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config), 'utf8');
  }
  return { ...process.env, CEZ_HOME: home };
}

describe('readWorkspaceReportsConfig — the happy path', () => {
  it('reads every key off the operator’s config.json', async () => {
    const env = await tempHome({
      // Deliberately alongside other keys: this reader owns ONE key and must ignore the rest of a
      // file it shares with the project registry, the knowledge mounts and everything else.
      projects: [{ id: 'apex', root: '/somewhere' }],
      knowledge: { mounts: [{ id: 'reports', path: '~/corpus' }] },
      reports: {
        tags: ['user-report'],
        handledTags: [],
        auto: true,
        routeByDomain: { beside: 'chat', predicts: 'chat' },
      },
    });
    await expect(readWorkspaceReportsConfig(env)).resolves.toEqual({
      tags: ['user-report'],
      handledTags: [],
      auto: true,
      routeByDomain: { beside: 'chat', predicts: 'chat' },
    });
  });

  it('an explicit empty handledTags survives as [] rather than collapsing to absent', async () => {
    // `[]` is the documented opt-out ("put every report back in the queue"), so the difference
    // between it and an absent key is a behaviour difference, not a formatting one. A reader that
    // dropped empty arrays would silently turn the opt-out back into the default.
    const env = await tempHome({ reports: { handledTags: [] } });
    const config = await readWorkspaceReportsConfig(env);
    expect(config.handledTags).toEqual([]);
    expect(config.tags).toBeUndefined();
  });
});

describe('readWorkspaceReportsConfig — every failure degrades to defaults', () => {
  it('no config file at all', async () => {
    await expect(readWorkspaceReportsConfig(await tempHome())).resolves.toEqual({});
  });

  it('a config file with no reports key', async () => {
    const env = await tempHome({ projects: [] });
    await expect(readWorkspaceReportsConfig(env)).resolves.toEqual({});
  });

  it('unparseable JSON', async () => {
    await expect(readWorkspaceReportsConfig(await tempHome('{ not json'))).resolves.toEqual({});
  });

  it('a JSON scalar where an object belongs', async () => {
    await expect(readWorkspaceReportsConfig(await tempHome('42'))).resolves.toEqual({});
    await expect(readWorkspaceReportsConfig(await tempHome('null'))).resolves.toEqual({});
  });

  it('a reports block the schema refuses', async () => {
    // Not just "some malformed thing": each of these is a plausible hand-edit, and each must cost
    // the whole block rather than throwing on a request.
    for (const reports of [
      'not-an-object',
      { tags: 'user-report' }, // a string where an array belongs
      { auto: 'yes' }, // a string where a boolean belongs
      { routeByDomain: { beside: '' } }, // an empty project id
      { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, // over the cap
    ]) {
      await expect(readWorkspaceReportsConfig(await tempHome({ reports })), JSON.stringify(reports)).resolves.toEqual(
        {},
      );
    }
  });

  it('NEGATIVE CONTROL: the refusals above are about the value, not about the reader', async () => {
    // Without this, every assertion in the block above would pass on a reader that always answered
    // `{}` — the classic vacuous-degradation trap. A well-formed neighbour of each refused value
    // must still come back.
    for (const [reports, expected] of [
      [{ tags: ['user-report'] }, { tags: ['user-report'] }],
      [{ auto: true }, { auto: true }],
      [{ routeByDomain: { beside: 'chat' } }, { routeByDomain: { beside: 'chat' } }],
    ] as const) {
      await expect(readWorkspaceReportsConfig(await tempHome({ reports }))).resolves.toEqual(expected);
    }
  });
});
