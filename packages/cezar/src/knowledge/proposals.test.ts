import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeCatalog } from './catalog.ts';
import type { CatalogEntry } from './types.ts';
import { applyKnowledgeProposals, knowledgeWriteFilePath, readRunProposals } from './proposals.ts';

/**
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` ("Correction in place: the supersede
 * operation", "Agent read path and write back") and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D1..D25 (outranks the spec on conflict).
 * Controls C2, C3, C4 live here (see the Verification table).
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempRepo(): Promise<{ repoRoot: string; dataDir: string }> {
  const base = await realpath(tmpdir());
  const repoRoot = await mkdtemp(join(base, 'cez-kb-proposals-'));
  dirs.push(repoRoot);
  return { repoRoot, dataDir: join(repoRoot, '.ai/cezar') };
}

function makeEntry(overrides: Partial<CatalogEntry> & { id: string; root: string; path: string; slug: string; title: string }): CatalogEntry {
  return {
    type: 'decision',
    tags: [],
    status: 'current',
    identifiers: [],
    updatedAt: new Date(0).toISOString(),
    hash: 'h',
    bytes: 1,
    headings: [],
    excerpt: '',
    links: [],
    backlinkCount: 0,
    ...overrides,
  };
}

async function writeProposalLines(dataDir: string, runId: string, lines: unknown[]): Promise<void> {
  const file = knowledgeWriteFilePath(dataDir, runId);
  await mkdir(join(dataDir, 'runs'), { recursive: true });
  await writeFile(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf8');
}

describe('readRunProposals', () => {
  it('returns [] for a run that never wrote a proposal file', async () => {
    const { dataDir } = await tempRepo();
    expect(await readRunProposals(dataDir, 'no-such-run')).toEqual([]);
  });

  it('drops a malformed trailing line, keeping every complete line above it, ordered by seq', async () => {
    const { dataDir } = await tempRepo();
    await writeProposalLines(dataDir, 'r1', [
      { op: 'upsert', scope: 'project', path: 'a.md', body: 'A', seq: 1, runId: 'r1', createdAt: 'x' },
      { op: 'upsert', scope: 'project', path: 'b.md', body: 'B', seq: 0, runId: 'r1', createdAt: 'x' },
      '{"op":"upsert","scope":"project","path":"c.md"', // truncated mid-write — malformed JSON
    ]);
    const proposals = await readRunProposals(dataDir, 'r1');
    expect(proposals.map((p) => p.seq)).toEqual([0, 1]);
  });

  it('drops a line that parses as JSON but fails the proposal schema (e.g. missing seq/runId/createdAt)', async () => {
    const { dataDir } = await tempRepo();
    await writeProposalLines(dataDir, 'r1', [{ op: 'upsert', scope: 'project', path: 'a.md', body: 'A' }]);
    expect(await readRunProposals(dataDir, 'r1')).toEqual([]);
  });
});

describe('applyKnowledgeProposals — op: upsert', () => {
  it('writes a new document with YAML frontmatter built from the proposal fields', async () => {
    const { dataDir } = await tempRepo();
    await writeProposalLines(dataDir, 'r1', [
      {
        op: 'upsert',
        scope: 'project',
        path: 'decisions/product-split.md',
        title: 'Product capability split',
        type: 'decision',
        tags: ['architecture'],
        supersedes: ['actors-over-personas'],
        body: 'MCP servers attach per agent, so an actor could never scope a tool surface.',
        seq: 0,
        runId: 'r1',
        createdAt: 'x',
      },
    ]);

    const result = await applyKnowledgeProposals(dataDir, 'r1', [0]);
    expect(result).toEqual({ applied: [0], refused: [] });

    const written = await readFile(join(dataDir, 'knowledge/decisions/product-split.md'), 'utf8');
    expect(written).toContain('title: Product capability split');
    expect(written).toContain('type: decision');
    expect(written).toContain('MCP servers attach per agent');
  });

  it('writes the body verbatim, with no frontmatter block, when no metadata fields are given', async () => {
    const { dataDir } = await tempRepo();
    await writeProposalLines(dataDir, 'r1', [
      { op: 'upsert', scope: 'project', path: 'bare.md', body: 'just a note', seq: 0, runId: 'r1', createdAt: 'x' },
    ]);
    await applyKnowledgeProposals(dataDir, 'r1', [0]);
    const written = await readFile(join(dataDir, 'knowledge/bare.md'), 'utf8');
    expect(written).toBe('just a note');
  });

  it('refuses a path that escapes the writable root, and writes nothing', async () => {
    const { dataDir } = await tempRepo();
    await writeProposalLines(dataDir, 'r1', [
      { op: 'upsert', scope: 'project', path: '../../etc/passwd', body: 'pwned', seq: 0, runId: 'r1', createdAt: 'x' },
    ]);
    const result = await applyKnowledgeProposals(dataDir, 'r1', [0]);
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([{ seq: 0, reason: expect.stringContaining('outside the writable root') }]);
  });

  it('refuses an unknown seq without touching anything else in the batch', async () => {
    const { dataDir } = await tempRepo();
    await writeProposalLines(dataDir, 'r1', [
      { op: 'upsert', scope: 'project', path: 'a.md', body: 'A', seq: 0, runId: 'r1', createdAt: 'x' },
    ]);
    const result = await applyKnowledgeProposals(dataDir, 'r1', [0, 7]);
    expect(result.applied).toEqual([0]);
    expect(result.refused).toEqual([{ seq: 7, reason: 'no such proposal' }]);
  });

  it('writes to the workspace root, not the project root, for scope: "workspace"', async () => {
    const { dataDir } = await tempRepo();
    const home = await mkdtemp(join(await realpath(tmpdir()), 'cez-kb-proposals-home-'));
    dirs.push(home);
    await writeProposalLines(dataDir, 'r1', [
      { op: 'upsert', scope: 'workspace', path: 'note.md', body: 'workspace note', seq: 0, runId: 'r1', createdAt: 'x' },
    ]);
    const result = await applyKnowledgeProposals(dataDir, 'r1', [0], { CEZ_HOME: home });
    expect(result).toEqual({ applied: [0], refused: [] });
    const written = await readFile(join(home, 'knowledge/note.md'), 'utf8');
    expect(written).toBe('workspace note');
  });
});

describe('applyKnowledgeProposals — op: supersede (correction in place)', () => {
  const ORIGINAL_BODY = '# Actors over Personas\n\nEvery consumer product is a persona the base agent plays.\n';
  const ORIGINAL = `---\ntitle: Actors over Personas\nstatus: current\n---\n${ORIGINAL_BODY}`;

  async function seedTarget(dataDir: string): Promise<string> {
    const targetPath = join(dataDir, 'knowledge/actors-over-personas.md');
    await mkdir(join(dataDir, 'knowledge'), { recursive: true });
    await writeFile(targetPath, ORIGINAL, 'utf8');
    await writeCatalog(dataDir, [
      makeEntry({
        id: 'project-target1',
        slug: 'actors-over-personas',
        root: 'project',
        path: targetPath,
        title: 'Actors over Personas',
      }),
      makeEntry({
        id: 'project-by1',
        slug: 'product-capability-split',
        root: 'project',
        path: join(dataDir, 'knowledge/product-split.md'),
        title: 'Product Capability Split',
      }),
    ]);
    return targetPath;
  }

  it('C2: sets status/supersededBy/supersededAt on the target', async () => {
    const { dataDir } = await tempRepo();
    const targetPath = await seedTarget(dataDir);
    await writeProposalLines(dataDir, 'r1', [
      {
        op: 'supersede',
        target: 'actors-over-personas',
        by: 'product-capability-split',
        date: '2026-08-06',
        note: 'MCP servers attach per agent',
        seq: 0,
        runId: 'r1',
        createdAt: 'x',
      },
    ]);
    const result = await applyKnowledgeProposals(dataDir, 'r1', [0]);
    expect(result).toEqual({ applied: [0], refused: [] });

    const written = await readFile(targetPath, 'utf8');
    expect(written).toContain('status: superseded');
    expect(written).toContain('supersededBy: product-capability-split');
    expect(written).toContain('supersededAt: 2026-08-06');
    expect(written).toContain('**Superseded 2026-08-06 by Product Capability Split (project-by1).** MCP servers attach per agent');
  });

  it('C3: result.endsWith(originalBodyAfterFrontmatter) — nothing below the frontmatter is reflowed, re-serialized or truncated', async () => {
    const { dataDir } = await tempRepo();
    const targetPath = await seedTarget(dataDir);
    await writeProposalLines(dataDir, 'r1', [
      { op: 'supersede', target: 'actors-over-personas', by: 'product-capability-split', date: '2026-08-06', seq: 0, runId: 'r1', createdAt: 'x' },
    ]);
    await applyKnowledgeProposals(dataDir, 'r1', [0]);
    const written = await readFile(targetPath, 'utf8');
    expect(written.endsWith(ORIGINAL_BODY)).toBe(true);
  });

  it('C4: applying the same supersede (same "by") twice is byte-identical — idempotent, no-op the second time', async () => {
    const { dataDir } = await tempRepo();
    const targetPath = await seedTarget(dataDir);
    await writeProposalLines(dataDir, 'r1', [
      { op: 'supersede', target: 'actors-over-personas', by: 'product-capability-split', date: '2026-08-06', seq: 0, runId: 'r1', createdAt: 'x' },
    ]);
    await applyKnowledgeProposals(dataDir, 'r1', [0]);
    const afterFirst = await readFile(targetPath, 'utf8');

    const secondResult = await applyKnowledgeProposals(dataDir, 'r1', [0]);
    const afterSecond = await readFile(targetPath, 'utf8');

    expect(secondResult).toEqual({ applied: [0], refused: [] });
    expect(afterSecond).toBe(afterFirst);
  });

  it('re-applying with a DIFFERENT "by" prepends a second lead-in above the first — a correction trail, never an overwrite', async () => {
    const { dataDir } = await tempRepo();
    const targetPath = await seedTarget(dataDir);
    await writeCatalog(dataDir, [
      makeEntry({ id: 'project-target1', slug: 'actors-over-personas', root: 'project', path: targetPath, title: 'Actors over Personas' }),
      makeEntry({ id: 'project-by1', slug: 'product-capability-split', root: 'project', path: '/x', title: 'Product Capability Split' }),
      makeEntry({ id: 'project-by2', slug: 'a-later-correction', root: 'project', path: '/y', title: 'A Later Correction' }),
    ]);
    await writeProposalLines(dataDir, 'r1', [
      { op: 'supersede', target: 'actors-over-personas', by: 'product-capability-split', date: '2026-08-06', seq: 0, runId: 'r1', createdAt: 'x' },
      { op: 'supersede', target: 'actors-over-personas', by: 'a-later-correction', date: '2026-09-01', seq: 1, runId: 'r1', createdAt: 'x' },
    ]);
    await applyKnowledgeProposals(dataDir, 'r1', [0]);
    await applyKnowledgeProposals(dataDir, 'r1', [1]);

    const written = await readFile(targetPath, 'utf8');
    const firstLeadIn = written.indexOf('**Superseded 2026-08-06 by Product Capability Split');
    const secondLeadIn = written.indexOf('**Superseded 2026-09-01 by A Later Correction');
    expect(firstLeadIn).toBeGreaterThan(-1);
    expect(secondLeadIn).toBeGreaterThan(-1);
    expect(secondLeadIn).toBeLessThan(firstLeadIn); // the newer correction sits ABOVE the older one
    expect(written.endsWith(ORIGINAL_BODY)).toBe(true); // the original body is still, unconditionally, the tail
    expect(written).toContain('supersededBy: a-later-correction'); // the frontmatter reflects the LATEST correction
  });

  it('creates a fresh 4-key frontmatter block (status/supersededBy/supersededAt + derived title) when the target had none', async () => {
    const { dataDir } = await tempRepo();
    const targetPath = join(dataDir, 'knowledge/bare.md');
    await mkdir(join(dataDir, 'knowledge'), { recursive: true });
    const bareBody = '# Bare Note\n\nNo frontmatter here at all.\n';
    await writeFile(targetPath, bareBody, 'utf8');
    await writeCatalog(dataDir, [
      makeEntry({ id: 'project-bare1', slug: 'bare', root: 'project', path: targetPath, title: 'Bare Note' }),
      makeEntry({ id: 'project-by1', slug: 'by-doc', root: 'project', path: '/x', title: 'By Doc' }),
    ]);
    await writeProposalLines(dataDir, 'r1', [
      { op: 'supersede', target: 'bare', by: 'by-doc', date: '2026-08-06', seq: 0, runId: 'r1', createdAt: 'x' },
    ]);
    await applyKnowledgeProposals(dataDir, 'r1', [0]);

    const written = await readFile(targetPath, 'utf8');
    expect(written).toContain('title: Bare Note');
    expect(written).toContain('status: superseded');
    expect(written.endsWith(bareBody)).toBe(true);
  });

  it('amends the first H1 only when amendHeading is true, preserving the original text', async () => {
    const { dataDir } = await tempRepo();
    const targetPath = await seedTarget(dataDir);
    await writeProposalLines(dataDir, 'r1', [
      { op: 'supersede', target: 'actors-over-personas', by: 'product-capability-split', date: '2026-08-06', amendHeading: true, seq: 0, runId: 'r1', createdAt: 'x' },
    ]);
    await applyKnowledgeProposals(dataDir, 'r1', [0]);
    const written = await readFile(targetPath, 'utf8');
    expect(written).toContain('# Actors over Personas (superseded)');
  });

  it('refuses an ambiguous target (two documents sharing a slug)', async () => {
    const { dataDir } = await tempRepo();
    await writeCatalog(dataDir, [
      makeEntry({ id: 'project-dup1', slug: 'dup', root: 'project', path: '/a', title: 'A' }),
      makeEntry({ id: 'project-dup2', slug: 'dup', root: 'project', path: '/b', title: 'B' }),
    ]);
    await writeProposalLines(dataDir, 'r1', [
      { op: 'supersede', target: 'dup', by: 'x', date: '2026-08-06', seq: 0, runId: 'r1', createdAt: 'x' },
    ]);
    const result = await applyKnowledgeProposals(dataDir, 'r1', [0]);
    expect(result).toEqual({ applied: [], refused: [{ seq: 0, reason: 'ambiguous target' }] });
  });

  it('refuses an unresolvable target', async () => {
    const { dataDir } = await tempRepo();
    await writeProposalLines(dataDir, 'r1', [
      { op: 'supersede', target: 'nope', by: 'x', date: '2026-08-06', seq: 0, runId: 'r1', createdAt: 'x' },
    ]);
    const result = await applyKnowledgeProposals(dataDir, 'r1', [0]);
    expect(result).toEqual({ applied: [], refused: [{ seq: 0, reason: 'unknown target document' }] });
  });

  it('a target on a read-only mount stays pending — visible, unapplied, not lost', async () => {
    const { dataDir } = await tempRepo();
    await writeCatalog(dataDir, [
      makeEntry({ id: 'specs-x1', slug: 'mounted-spec', root: 'specs', path: '/abs/specs/x.md', title: 'X' }),
    ]);
    await writeProposalLines(dataDir, 'r1', [
      { op: 'supersede', target: 'mounted-spec', by: 'y', date: '2026-08-06', seq: 0, runId: 'r1', createdAt: 'x' },
    ]);
    const result = await applyKnowledgeProposals(dataDir, 'r1', [0]);
    expect(result).toEqual({ applied: [], refused: [{ seq: 0, reason: 'target is on a read-only mount' }] });
  });
});
