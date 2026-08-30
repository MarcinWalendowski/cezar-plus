import { statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLUSTER_CORPUS_DEFAULT_SCOPE } from '@loki-labs/cezar-plus-contract';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildManifest,
  isPathInScope,
  readDoc,
  readDocs,
  resolveCorpusRoot,
  scopeForNode,
  type CorpusStoreOptions,
} from './corpus-store.ts';

/**
 * `cluster/corpus-store.ts` (D8a, handoff item 56, package 3b.2's store half). Every fixture below
 * is a real temp directory on disk — no mocked fs — matching `sources/cezar-hub/provider.test.ts`'s
 * own house rule for this cluster package.
 */

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cez-corpus-store-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

/** Standard fixture: `<projects>/notion-export` as the corpus root (via `CEZ_PROJECTS_DIR`, the
 *  first candidate `resolveCorpusRoot` tries), `<home>/.cezar` as `CEZ_HOME` — so the state file
 *  (`<home>/.cezar/cluster/corpus-state.json`) and the corpus root are both pinned to this one
 *  fixture's temp dirs, never the real machine's. */
async function fixture(): Promise<{ env: CorpusStoreOptions['env']; corpusRoot: string }> {
  const home = await directory();
  const projects = await directory();
  const corpusRoot = join(projects, 'notion-export');
  await mkdir(corpusRoot, { recursive: true });
  return { env: { CEZ_HOME: join(home, '.cezar'), CEZ_PROJECTS_DIR: projects }, corpusRoot };
}

async function write(root: string, relPath: string, content: string): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

// ---- resolveCorpusRoot ---------------------------------------------------------------------

describe('resolveCorpusRoot', () => {
  it('resolves <CEZ_PROJECTS_DIR>/notion-export when it exists', async () => {
    const { env, corpusRoot } = await fixture();
    expect(resolveCorpusRoot({ env })).toBe(corpusRoot);
  });

  it('scans <home>/*/notion-export when CEZ_PROJECTS_DIR is unset — the workspace name is never hardcoded', async () => {
    const home = await directory();
    // Deliberately NOT the name this repo's own operator uses: the resolver must find a corpus
    // beside ANY workspace, which is the whole point of the 2026-08-24 correction.
    const workspaceCorpus = join(home, 'some-other-workspace', 'notion-export');
    await mkdir(workspaceCorpus, { recursive: true });
    const env = { CEZ_HOME: join(home, '.cezar') };
    expect(resolveCorpusRoot({ env })).toBe(workspaceCorpus);
  });

  it('scans deterministically — with two candidate workspaces the sorted-first one wins, on every call', async () => {
    const home = await directory();
    const first = join(home, 'aaa-workspace', 'notion-export');
    const second = join(home, 'zzz-workspace', 'notion-export');
    await mkdir(second, { recursive: true });
    await mkdir(first, { recursive: true });
    const env = { CEZ_HOME: join(home, '.cezar') };
    // Called repeatedly: a readdir-order-dependent resolver would eventually disagree with itself.
    expect(resolveCorpusRoot({ env })).toBe(first);
    expect(resolveCorpusRoot({ env })).toBe(first);
    expect(resolveCorpusRoot({ env })).toBe(first);
  });

  it('CEZ_CORPUS_ROOT names the corpus directly and outranks every derived candidate', async () => {
    const home = await directory();
    const derived = join(home, 'aaa-workspace', 'notion-export');
    await mkdir(derived, { recursive: true });
    const projects = await directory();
    await mkdir(join(projects, 'notion-export'), { recursive: true });
    const explicit = await directory();
    const env = {
      CEZ_HOME: join(home, '.cezar'),
      CEZ_PROJECTS_DIR: projects,
      CEZ_CORPUS_ROOT: explicit,
    };
    expect(resolveCorpusRoot({ env })).toBe(explicit);
  });

  it('ignores CEZ_CORPUS_ROOT when it does not exist, rather than resolving to a missing path', async () => {
    const home = await directory();
    const derived = join(home, 'aaa-workspace', 'notion-export');
    await mkdir(derived, { recursive: true });
    const env = { CEZ_HOME: join(home, '.cezar'), CEZ_CORPUS_ROOT: join(home, 'no-such-corpus') };
    expect(resolveCorpusRoot({ env })).toBe(derived);
  });

  it('prefers CEZ_PROJECTS_DIR over the scanned fallback when both exist', async () => {
    const home = await directory();
    const workspaceCorpus = join(home, 'some-other-workspace', 'notion-export');
    await mkdir(workspaceCorpus, { recursive: true });
    const projects = await directory();
    const projectsCorpus = join(projects, 'notion-export');
    await mkdir(projectsCorpus, { recursive: true });
    const env = { CEZ_HOME: join(home, '.cezar'), CEZ_PROJECTS_DIR: projects };
    expect(resolveCorpusRoot({ env })).toBe(projectsCorpus);
  });

  it('returns undefined when neither candidate exists on disk', async () => {
    const home = await directory(); // exists, but nothing named notion-export under it or CEZ_PROJECTS_DIR
    const env = { CEZ_HOME: join(home, '.cezar'), CEZ_PROJECTS_DIR: join(home, 'nonexistent-projects') };
    expect(resolveCorpusRoot({ env })).toBeUndefined();
  });
});

// ---- scopeForNode ---------------------------------------------------------------------------

describe('scopeForNode', () => {
  it('falls back to CLUSTER_CORPUS_DEFAULT_SCOPE (all six) for an undefined node', () => {
    expect(scopeForNode(undefined)).toEqual(CLUSTER_CORPUS_DEFAULT_SCOPE);
  });

  it('falls back to the default when the node carries no mirrorScope', () => {
    expect(scopeForNode({})).toEqual(CLUSTER_CORPUS_DEFAULT_SCOPE);
  });

  it('falls back to the default for an explicitly empty mirrorScope (not treated as "mirror nothing")', () => {
    expect(scopeForNode({ mirrorScope: [] })).toEqual(CLUSTER_CORPUS_DEFAULT_SCOPE);
  });

  it('honours an explicit, non-empty mirrorScope', () => {
    expect(scopeForNode({ mirrorScope: ['knowledge', 'domains'] })).toEqual(['knowledge', 'domains']);
  });
});

// ---- isPathInScope: scope + traversal safety (the single scope+safety rule) -----------------

describe('isPathInScope', () => {
  it('accepts a legitimate nested path inside the default scope', () => {
    expect(isPathInScope('knowledge/a/b/c.md', CLUSTER_CORPUS_DEFAULT_SCOPE)).toBe(true);
  });

  it('reports/ is IN scope by default (the 2026-08-24 default-scope change)', () => {
    expect(isPathInScope('reports/x.md', CLUSTER_CORPUS_DEFAULT_SCOPE)).toBe(true);
  });

  it('reports/ is OUT of scope for a node whose mirrorScope excludes it', () => {
    const narrowed = scopeForNode({ mirrorScope: ['knowledge', 'domains'] });
    expect(isPathInScope('reports/x.md', narrowed)).toBe(false);
  });

  it('refuses ../ escapes', () => {
    expect(isPathInScope('../etc/passwd', CLUSTER_CORPUS_DEFAULT_SCOPE)).toBe(false);
  });

  it('refuses an absolute path', () => {
    expect(isPathInScope('/etc/passwd', CLUSTER_CORPUS_DEFAULT_SCOPE)).toBe(false);
  });

  it('refuses a path whose ..-resolved form escapes the root even though it starts inside scope', () => {
    expect(isPathInScope('knowledge/../../x', CLUSTER_CORPUS_DEFAULT_SCOPE)).toBe(false);
  });

  it('refuses a NUL byte', () => {
    expect(isPathInScope('knowledge/a\0.md', CLUSTER_CORPUS_DEFAULT_SCOPE)).toBe(false);
  });

  it('refuses any backslash path outright, not just a `\\..\\` traversal', () => {
    expect(isPathInScope('knowledge\\a.md', CLUSTER_CORPUS_DEFAULT_SCOPE)).toBe(false);
    expect(isPathInScope('knowledge\\..\\..\\etc\\passwd', CLUSTER_CORPUS_DEFAULT_SCOPE)).toBe(false);
  });

  it('scopes by the RESOLVED top segment, not the literal first one', () => {
    // "knowledge/../reports/x.md" never escapes the root - it resolves to "reports/x.md" - so it
    // must be judged against scope by "reports", not "knowledge".
    expect(isPathInScope('knowledge/../reports/x.md', ['reports'])).toBe(true);
    expect(isPathInScope('knowledge/../reports/x.md', ['knowledge'])).toBe(false);
  });
});

// ---- buildManifest: scope filtering, since/tombstones, change-gated write -------------------

describe('buildManifest', () => {
  it('lists docs with hash/size/mtime, filtered to the requested scope', async () => {
    const { env, corpusRoot } = await fixture();
    await write(corpusRoot, 'knowledge/a.md', 'hello knowledge');
    await write(corpusRoot, 'reports/secret.md', 'phone: 555-0100');

    const manifest = await buildManifest(['knowledge'], undefined, { env });
    expect(manifest.docs.map((d) => d.path)).toEqual(['knowledge/a.md']);
    const [doc] = manifest.docs;
    expect(doc).toBeDefined();
    expect(doc!.size).toBe(Buffer.byteLength('hello knowledge', 'utf8'));
    expect(typeof doc!.hash).toBe('string');
    expect(doc!.hash.length).toBeGreaterThan(0);
    expect(typeof doc!.mtime).toBe('string');
    expect(manifest.complete).toBe(true);
  });

  it('since: a doc changed after the watermark appears, an unchanged one does not, and a deletion is an explicit tombstone', async () => {
    const { env, corpusRoot } = await fixture();
    await write(corpusRoot, 'knowledge/a.md', 'version one');
    await write(corpusRoot, 'knowledge/c.md', 'to be deleted');
    await write(corpusRoot, 'knowledge/d.md', 'never touched');

    const v1 = await buildManifest(CLUSTER_CORPUS_DEFAULT_SCOPE, undefined, { env });
    expect(new Set(v1.docs.map((d) => d.path))).toEqual(new Set(['knowledge/a.md', 'knowledge/c.md', 'knowledge/d.md']));

    // A real content change (size differs, so this is not a mere mtime touch), a brand-new file,
    // and a deletion - 'd.md' is left completely alone.
    await write(corpusRoot, 'knowledge/a.md', 'version two, now longer');
    await write(corpusRoot, 'knowledge/b.md', 'brand new');
    await rm(join(corpusRoot, 'knowledge/c.md'));

    const delta = await buildManifest(CLUSTER_CORPUS_DEFAULT_SCOPE, v1.corpusVersion, { env });

    // Changed/new docs appear...
    expect(new Set(delta.docs.map((d) => d.path))).toEqual(new Set(['knowledge/a.md', 'knowledge/b.md']));
    // ...the untouched doc does NOT (negative half: a version-blind implementation would include it).
    expect(delta.docs.some((d) => d.path === 'knowledge/d.md')).toBe(false);
    // ...and the deletion is an EXPLICIT tombstone, never mere absence from `docs`.
    expect(delta.tombstones.map((t) => t.path)).toEqual(['knowledge/c.md']);
    expect(delta.docs.some((d) => d.path === 'knowledge/c.md')).toBe(false);

    // A full (no-`since`) manifest reports the corpus as it now stands: a.md/b.md/d.md present,
    // c.md gone from docs - and carries no tombstones (module header: nothing to reconcile against).
    const v2Full = await buildManifest(CLUSTER_CORPUS_DEFAULT_SCOPE, undefined, { env });
    expect(new Set(v2Full.docs.map((d) => d.path))).toEqual(new Set(['knowledge/a.md', 'knowledge/b.md', 'knowledge/d.md']));
    expect(v2Full.tombstones).toEqual([]);
  });

  it('a no-change re-scan does not rewrite the state file; a real change does', async () => {
    const { env, corpusRoot } = await fixture();
    await write(corpusRoot, 'knowledge/a.md', 'content');
    await buildManifest(CLUSTER_CORPUS_DEFAULT_SCOPE, undefined, { env });

    const statePath = join(env!.CEZ_HOME!, 'cluster', 'corpus-state.json');
    const mtimeAfterFirstBuild = statSync(statePath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 30));
    await buildManifest(CLUSTER_CORPUS_DEFAULT_SCOPE, undefined, { env }); // nothing on disk changed
    expect(statSync(statePath).mtimeMs).toBe(mtimeAfterFirstBuild); // negative half: no write happened

    await new Promise((resolve) => setTimeout(resolve, 30));
    await write(corpusRoot, 'knowledge/a.md', 'content, but different now');
    await buildManifest(CLUSTER_CORPUS_DEFAULT_SCOPE, undefined, { env }); // a real change this time
    expect(statSync(statePath).mtimeMs).not.toBe(mtimeAfterFirstBuild); // positive half: it does write when there is one
  });

  it('answers an honestly-empty manifest (never throws) when the corpus root does not exist', async () => {
    const home = await directory();
    const env = { CEZ_HOME: join(home, '.cezar'), CEZ_PROJECTS_DIR: join(home, 'nonexistent') };
    const manifest = await buildManifest(CLUSTER_CORPUS_DEFAULT_SCOPE, undefined, { env });
    expect(manifest.docs).toEqual([]);
    expect(manifest.tombstones).toEqual([]);
    expect(manifest.complete).toBe(true);
  });
});

// ---- readDoc / readDocs ------------------------------------------------------------------------

describe('readDoc', () => {
  it('returns the body + hash for an in-scope, present document', async () => {
    const { env, corpusRoot } = await fixture();
    await write(corpusRoot, 'knowledge/a.md', 'the body');
    const result = await readDoc('knowledge/a.md', CLUSTER_CORPUS_DEFAULT_SCOPE, { env });
    expect(result).toEqual({ path: 'knowledge/a.md', hash: result?.hash, body: 'the body' });
  });

  it('returns undefined for an out-of-scope path and for an absent one - not distinguishable', async () => {
    const { env, corpusRoot } = await fixture();
    await write(corpusRoot, 'reports/secret.md', 'phone: 555-0100');
    const outOfScope = await readDoc('reports/secret.md', ['knowledge'], { env });
    const absent = await readDoc('knowledge/ghost.md', ['knowledge'], { env });
    expect(outOfScope).toBeUndefined();
    expect(absent).toBeUndefined();
  });
});

describe('readDocs', () => {
  it('missing: an absent path and an out-of-scope path both land in missing, indistinguishably', async () => {
    const { env, corpusRoot } = await fixture();
    await write(corpusRoot, 'reports/secret.md', 'phone: 555-0100');

    const result = await readDocs(['knowledge/ghost.md', 'reports/secret.md'], ['knowledge'], { env });
    expect(result.docs).toEqual([]);
    expect([...result.missing].sort()).toEqual(['knowledge/ghost.md', 'reports/secret.md']);
    expect(result.truncated).toBe(false);
  });

  it('truncation: honours CLUSTER_CORPUS_BATCH_MAX_BYTES with a prefix-complete subset, and the rest is fetchable on a follow-up call', async () => {
    const { env, corpusRoot } = await fixture();
    // CLUSTER_CORPUS_BATCH_MAX_BYTES is 4_000_000. a + b fit (3_800_000); a + b + c does not
    // (5_700_000), so the batch must stop after b, whole, with c never attempted.
    const a = 'a'.repeat(1_900_000);
    const b = 'b'.repeat(1_900_000);
    const c = 'c'.repeat(1_900_000);
    await write(corpusRoot, 'knowledge/a.md', a);
    await write(corpusRoot, 'knowledge/b.md', b);
    await write(corpusRoot, 'knowledge/c.md', c);

    const batch = await readDocs(
      ['knowledge/a.md', 'knowledge/b.md', 'knowledge/c.md'],
      CLUSTER_CORPUS_DEFAULT_SCOPE,
      { env },
    );
    expect(batch.truncated).toBe(true);
    expect(batch.docs.map((d) => d.path)).toEqual(['knowledge/a.md', 'knowledge/b.md']); // prefix, in order
    // Each returned body is WHOLE - never a partial file (negative half: a byte-sliced
    // implementation would still pass a length-only assertion, so this compares full content).
    expect(batch.docs.find((d) => d.path === 'knowledge/a.md')?.body).toBe(a);
    expect(batch.docs.find((d) => d.path === 'knowledge/b.md')?.body).toBe(b);
    expect(batch.missing).toEqual([]); // c was never attempted - it is not "missing", just not yet fetched

    // The caller gets the rest by asking again.
    const rest = await readDocs(['knowledge/c.md'], CLUSTER_CORPUS_DEFAULT_SCOPE, { env });
    expect(rest.truncated).toBe(false);
    expect(rest.docs).toEqual([{ path: 'knowledge/c.md', hash: rest.docs[0]?.hash, body: c }]);
  });

  it('never returns docs for out-of-scope paths, via the same isPathInScope check readDoc uses', async () => {
    const { env, corpusRoot } = await fixture();
    await write(corpusRoot, 'reports/secret.md', 'phone: 555-0100');
    const result = await readDocs(['reports/secret.md'], ['knowledge'], { env });
    expect(result.docs).toEqual([]);
    expect(result.missing).toEqual(['reports/secret.md']);
  });

  it('answers everything as missing (never throws) when the corpus root does not exist', async () => {
    const home = await directory();
    const env = { CEZ_HOME: join(home, '.cezar'), CEZ_PROJECTS_DIR: join(home, 'nonexistent') };
    const result = await readDocs(['knowledge/a.md'], CLUSTER_CORPUS_DEFAULT_SCOPE, { env });
    expect(result.docs).toEqual([]);
    expect(result.missing).toEqual(['knowledge/a.md']);
    expect(result.truncated).toBe(false);
  });
});
