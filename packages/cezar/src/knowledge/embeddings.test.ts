import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildEmbeddingsIndex,
  cosineSimilarity,
  embeddingsBlobPath,
  embeddingsSidecarPath,
  fuseReciprocalRank,
  loadEmbeddingsIndex,
  rankByEmbeddings,
  resolveEmbeddingsConfig,
  type EmbeddableDocument,
} from './embeddings.ts';

/**
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` (Q5, Q6, C15, C16) and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D10. No test here performs live network I/O -
 * every call below passes an explicit `fetchImpl` reading a queued in-memory `Response`, the same
 * discipline `sources/notion/client.test.ts` uses.
 */

const dirs: string[] = [];

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-kb-embeddings-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function doc(id: string, title: string, body = ''): EmbeddableDocument {
  return { id, title, body };
}

const ENV_ON = { CEZ_KB_EMBEDDINGS: '1', CEZ_KB_EMBEDDINGS_API_KEY: 'sk-test-key' };

/** Deterministic 3-dim "embedding": which basis vector a chunk of text gets is decided by which
 *  document title it was prefixed with, so a built index has a known, checkable geometry. */
function fakeVectorFor(text: string): number[] {
  if (text.includes('Doc A')) return [1, 0, 0];
  if (text.includes('Doc B')) return [0, 1, 0];
  if (text.includes('Doc C')) return [0, 0, 1];
  return [0, 0, 0];
}

/** A fetchImpl that answers the OpenAI-shaped embeddings response for whatever `input` array the
 *  caller sent, via `fakeVectorFor`. Records every call's texts in `calls` for batching assertions. */
function fakeEmbeddingsFetch(calls: string[][] = []): typeof fetch {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    calls.push(body.input);
    return jsonResponse({ data: body.input.map((t, i) => ({ embedding: fakeVectorFor(t), index: i })) });
  }) as unknown as typeof fetch;
}

describe('resolveEmbeddingsConfig', () => {
  it('is enabled only by the exact string "1" (D4, C15)', () => {
    for (const value of ['true', 'yes', '0', '', 'TRUE', '1 ', undefined]) {
      expect(resolveEmbeddingsConfig({ CEZ_KB_EMBEDDINGS: value }).enabled).toBe(false);
    }
    expect(resolveEmbeddingsConfig({ CEZ_KB_EMBEDDINGS: '1' }).enabled).toBe(true);
  });

  it('defaults the URL and model, both overridable', () => {
    const defaults = resolveEmbeddingsConfig({});
    expect(defaults.url).toBe('https://api.openai.com/v1/embeddings');
    expect(defaults.model).toBe('text-embedding-3-small');

    const overridden = resolveEmbeddingsConfig({
      CEZ_KB_EMBEDDINGS_URL: 'https://stub.test/v1/embeddings',
      CEZ_KB_EMBEDDINGS_MODEL: 'stub-model',
    });
    expect(overridden.url).toBe('https://stub.test/v1/embeddings');
    expect(overridden.model).toBe('stub-model');
  });

  it('trims the API key and treats an empty/whitespace value as absent', () => {
    expect(resolveEmbeddingsConfig({ CEZ_KB_EMBEDDINGS_API_KEY: '  sk-abc  ' }).apiKey).toBe('sk-abc');
    expect(resolveEmbeddingsConfig({ CEZ_KB_EMBEDDINGS_API_KEY: '   ' }).apiKey).toBeUndefined();
    expect(resolveEmbeddingsConfig({}).apiKey).toBeUndefined();
  });
});

describe('buildEmbeddingsIndex: degrade paths never throw and never touch the network (C15)', () => {
  it('CEZ_KB_EMBEDDINGS unset or any spelling other than "1" builds nothing', async () => {
    const dir = await directory();
    for (const value of ['true', 'yes', '0', '']) {
      const fetchImpl = vi.fn();
      const result = await buildEmbeddingsIndex([doc('a', 'Doc A', 'body')], dir, {
        env: { CEZ_KB_EMBEDDINGS: value, CEZ_KB_EMBEDDINGS_API_KEY: 'sk-test' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result).toEqual({ built: false, reason: expect.stringContaining('CEZ_KB_EMBEDDINGS') });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('an absent API key builds nothing and never touches the network', async () => {
    const dir = await directory();
    const fetchImpl = vi.fn();
    const result = await buildEmbeddingsIndex([doc('a', 'Doc A', 'body')], dir, {
      env: { CEZ_KB_EMBEDDINGS: '1' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ built: false, reason: expect.stringContaining('CEZ_KB_EMBEDDINGS_API_KEY') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no documents to embed (every doc has empty title and body) builds nothing', async () => {
    const dir = await directory();
    const result = await buildEmbeddingsIndex([doc('a', ''), doc('b', '', '   ')], dir, { env: ENV_ON });
    expect(result).toEqual({ built: false, reason: expect.stringContaining('no documents') });
  });

  it('a failed fetch degrades to {built:false, reason}, and writes nothing to disk', async () => {
    const dir = await directory();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network unreachable');
    });
    const result = await buildEmbeddingsIndex([doc('a', 'Doc A', 'body text')], dir, {
      env: ENV_ON,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.built).toBe(false);
    expect(result.reason).toMatch(/network unreachable/);
    expect(existsSync(embeddingsBlobPath(dir))).toBe(false);
  });

  it('a non-2xx response degrades to {built:false, reason}', async () => {
    const dir = await directory();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, { status: 401 })) as unknown as typeof fetch;
    const result = await buildEmbeddingsIndex([doc('a', 'Doc A', 'body')], dir, { env: ENV_ON, fetchImpl });
    expect(result).toEqual({ built: false, reason: expect.stringContaining('401') });
  });
});

describe('buildEmbeddingsIndex + loadEmbeddingsIndex: the happy path and C16', () => {
  it('writes the blob and sidecar under <dataDir>/knowledge-index/, and they round-trip', async () => {
    const dir = await directory();
    const calls: string[][] = [];
    const fetchImpl = fakeEmbeddingsFetch(calls);

    const result = await buildEmbeddingsIndex(
      [doc('a', 'Doc A', 'Alpha content.'), doc('b', 'Doc B', 'Beta content.')],
      dir,
      { env: ENV_ON, fetchImpl },
    );
    expect(result.built).toBe(true);
    expect(result.chunkCount).toBe(2);
    expect(result.dims).toBe(3);

    // C16: the resolved paths are inside <dataDir>/knowledge-index/, never anywhere else.
    const indexDir = join(dir, 'knowledge-index');
    expect(embeddingsBlobPath(dir).startsWith(indexDir + '/') || embeddingsBlobPath(dir).startsWith(indexDir + '\\')).toBe(
      true,
    );
    expect(embeddingsSidecarPath(dir)).toBe(join(indexDir, 'embeddings.ndjson'));
    expect(existsSync(embeddingsBlobPath(dir))).toBe(true);
    expect(existsSync(embeddingsSidecarPath(dir))).toBe(true);

    const loaded = await loadEmbeddingsIndex(dir);
    expect(loaded).not.toBeNull();
    expect(loaded?.chunkCount).toBe(2);
    expect(loaded?.dims).toBe(3);
    expect(loaded?.model).toBe('text-embedding-3-small');
    expect(loaded?.chunks.map((c) => c.docId)).toEqual(['a', 'b']);
    // chunk 0 ("Doc A") -> [1,0,0]; chunk 1 ("Doc B") -> [0,1,0], chunk-major layout.
    expect(Array.from(loaded!.vectors.slice(0, 3))).toEqual([1, 0, 0]);
    expect(Array.from(loaded!.vectors.slice(3, 6))).toEqual([0, 1, 0]);
  });

  it('every chunk is prefixed with its document title, and an empty body still yields a title-only chunk', async () => {
    const calls: string[][] = [];
    const fetchImpl = fakeEmbeddingsFetch(calls);
    const dir = await directory();
    await buildEmbeddingsIndex([doc('a', 'Doc A', ''), doc('b', 'Doc B', 'Beta content.')], dir, {
      env: ENV_ON,
      fetchImpl,
    });
    const sentTexts = calls.flat();
    expect(sentTexts).toEqual(['Doc A', 'Doc B\n\nBeta content.']);
  });

  it('batches requests when the corpus exceeds one batch, and aggregates results in order', async () => {
    const calls: string[][] = [];
    const fetchImpl = fakeEmbeddingsFetch(calls);
    const dir = await directory();
    const docs = Array.from({ length: 130 }, (_, i) => doc(`doc-${i}`, `Doc ${i}`, `body ${i}`));
    const result = await buildEmbeddingsIndex(docs, dir, { env: ENV_ON, fetchImpl });
    expect(result.built).toBe(true);
    expect(result.chunkCount).toBe(130);
    expect(calls.length).toBe(2); // 96 + 34, EMBEDDING_BATCH_SIZE's boundary
    expect(calls[0]!.length).toBe(96);
    expect(calls[1]!.length).toBe(34);

    const loaded = await loadEmbeddingsIndex(dir);
    expect(loaded?.chunkCount).toBe(130);
    expect(loaded?.chunks[0]?.docId).toBe('doc-0');
    expect(loaded?.chunks[129]?.docId).toBe('doc-129');
  });
});

describe('loadEmbeddingsIndex: any corruption degrades to null, never throws (C15)', () => {
  it('no index built yet', async () => {
    const dir = await directory();
    expect(await loadEmbeddingsIndex(dir)).toBeNull();
  });

  it('sidecar present but blob missing (or vice versa)', async () => {
    const dir = await directory();
    const fetchImpl = fakeEmbeddingsFetch();
    await buildEmbeddingsIndex([doc('a', 'Doc A', 'x')], dir, { env: ENV_ON, fetchImpl });
    await rm(embeddingsBlobPath(dir));
    expect(await loadEmbeddingsIndex(dir)).toBeNull();
  });

  it('an unreadable sidecar header', async () => {
    const dir = await directory();
    const fetchImpl = fakeEmbeddingsFetch();
    await buildEmbeddingsIndex([doc('a', 'Doc A', 'x')], dir, { env: ENV_ON, fetchImpl });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(embeddingsSidecarPath(dir), 'not json at all\n{"docId":"a","chunkIndex":0}\n');
    expect(await loadEmbeddingsIndex(dir)).toBeNull();
  });

  it('a chunk-count mismatch between the header and the actual sidecar lines', async () => {
    const dir = await directory();
    const fetchImpl = fakeEmbeddingsFetch();
    await buildEmbeddingsIndex([doc('a', 'Doc A', 'x'), doc('b', 'Doc B', 'y')], dir, { env: ENV_ON, fetchImpl });
    const { writeFile } = await import('node:fs/promises');
    const header = JSON.stringify({ model: 'm', dims: 3, chunkCount: 2, createdAt: new Date().toISOString() });
    // Only one chunk line for a header that claims two.
    await writeFile(embeddingsSidecarPath(dir), `${header}\n{"docId":"a","chunkIndex":0}\n`);
    expect(await loadEmbeddingsIndex(dir)).toBeNull();
  });

  it('a blob whose byte length does not match chunkCount * dims * 4 (a truncated or corrupt file)', async () => {
    const dir = await directory();
    const fetchImpl = fakeEmbeddingsFetch();
    await buildEmbeddingsIndex([doc('a', 'Doc A', 'x'), doc('b', 'Doc B', 'y')], dir, { env: ENV_ON, fetchImpl });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(embeddingsBlobPath(dir), Buffer.from([1, 2, 3])); // nowhere near 2*3*4 bytes
    expect(await loadEmbeddingsIndex(dir)).toBeNull();
  });
});

describe('rankByEmbeddings: the degrade matrix (C15) and the happy path', () => {
  it('CEZ_KB_EMBEDDINGS off (any non-"1" spelling) returns null and never touches the network', async () => {
    const dir = await directory();
    for (const value of ['true', 'yes', '0', '']) {
      const fetchImpl = vi.fn();
      const result = await rankByEmbeddings('anything', dir, {
        env: { CEZ_KB_EMBEDDINGS: value, CEZ_KB_EMBEDDINGS_API_KEY: 'sk-test' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('an absent API key returns null and never touches the network', async () => {
    const dir = await directory();
    const fetchImpl = vi.fn();
    const result = await rankByEmbeddings('anything', dir, {
      env: { CEZ_KB_EMBEDDINGS: '1' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no index built yet returns null and never touches the network (cheap checks before the fetch)', async () => {
    const dir = await directory();
    const fetchImpl = vi.fn();
    const result = await rankByEmbeddings('anything', dir, { env: ENV_ON, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a failed query-embedding fetch returns null rather than throwing', async () => {
    const dir = await directory();
    await buildEmbeddingsIndex([doc('a', 'Doc A', 'x')], dir, { env: ENV_ON, fetchImpl: fakeEmbeddingsFetch() });
    const failingFetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const result = await rankByEmbeddings('query', dir, { env: ENV_ON, fetchImpl: failingFetch });
    expect(result).toBeNull();
  });

  it('a corrupt blob short-circuits before the query is ever embedded', async () => {
    const dir = await directory();
    await buildEmbeddingsIndex([doc('a', 'Doc A', 'x')], dir, { env: ENV_ON, fetchImpl: fakeEmbeddingsFetch() });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(embeddingsBlobPath(dir), Buffer.from([9, 9])); // corrupt
    const fetchImpl = vi.fn();
    const result = await rankByEmbeddings('query', dir, { env: ENV_ON, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a dimension mismatch (the model changed since the blob was built) degrades to null, never a wrong score', async () => {
    const dir = await directory();
    // Built with 3-dim fake vectors.
    await buildEmbeddingsIndex([doc('a', 'Doc A', 'x'), doc('b', 'Doc B', 'y')], dir, {
      env: ENV_ON,
      fetchImpl: fakeEmbeddingsFetch(),
    });
    // The query embedding comes back 4-dimensional - a different model.
    const mismatchedFetch = vi.fn(async () => jsonResponse({ data: [{ embedding: [1, 0, 0, 0], index: 0 }] })) as unknown as typeof fetch;
    const result = await rankByEmbeddings('query', dir, { env: ENV_ON, fetchImpl: mismatchedFetch });
    expect(result).toBeNull();
  });

  it('ranks documents by their best chunk\'s cosine similarity to the query, descending', async () => {
    const dir = await directory();
    await buildEmbeddingsIndex(
      [doc('a', 'Doc A', 'Alpha content.'), doc('b', 'Doc B', 'Beta content.'), doc('c', 'Doc C', 'Gamma content.')],
      dir,
      { env: ENV_ON, fetchImpl: fakeEmbeddingsFetch() },
    );
    // The query embeds to something very close to Doc A's [1,0,0], with a small Doc-B component.
    const queryFetch = vi.fn(async () => jsonResponse({ data: [{ embedding: [0.9, 0.1, 0], index: 0 }] })) as unknown as typeof fetch;
    const result = await rankByEmbeddings('query', dir, { env: ENV_ON, fetchImpl: queryFetch });
    expect(result).not.toBeNull();
    expect(result!.map((h) => h.docId)).toEqual(['a', 'b', 'c']);
    expect(result![0]!.score).toBeGreaterThan(result![1]!.score);
    expect(result![1]!.score).toBeGreaterThan(result![2]!.score);
  });

  it('respects the limit option', async () => {
    const dir = await directory();
    await buildEmbeddingsIndex(
      [doc('a', 'Doc A', 'x'), doc('b', 'Doc B', 'y'), doc('c', 'Doc C', 'z')],
      dir,
      { env: ENV_ON, fetchImpl: fakeEmbeddingsFetch() },
    );
    const queryFetch = vi.fn(async () => jsonResponse({ data: [{ embedding: [1, 0, 0], index: 0 }] })) as unknown as typeof fetch;
    const result = await rankByEmbeddings('query', dir, { env: ENV_ON, fetchImpl: queryFetch, limit: 1 });
    expect(result).toHaveLength(1);
  });
});

describe('cosineSimilarity (pure)', () => {
  it('is 1 for identical vectors, 0 for orthogonal, -1 for opposite', () => {
    const blob = new Float32Array([1, 0, 0, 0, 1, 0, -1, 0, 0]);
    expect(cosineSimilarity([1, 0, 0], blob, 0, 3)).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], blob, 3, 3)).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0, 0], blob, 6, 3)).toBeCloseTo(-1);
  });

  it('never divides by zero: a zero-length side scores 0, not NaN', () => {
    const blob = new Float32Array([0, 0, 0]);
    expect(cosineSimilarity([1, 0, 0], blob, 0, 3)).toBe(0);
    expect(cosineSimilarity([0, 0, 0], blob, 0, 3)).toBe(0);
  });
});

describe('fuseReciprocalRank (pure)', () => {
  it('preserves order for a single list', () => {
    expect(fuseReciprocalRank([['a', 'b', 'c']])).toEqual(['a', 'b', 'c']);
  });

  it('an id ranked near the top of two lists outranks one appearing in only one list', () => {
    const bm25 = ['x', 'a', 'y'];
    const embeddings = ['a', 'z', 'w'];
    const fused = fuseReciprocalRank([bm25, embeddings]);
    expect(fused[0]).toBe('a'); // present, and near the top, in both lists
  });

  it('is deterministic on a score tie, breaking by id', () => {
    expect(fuseReciprocalRank([['b'], ['a']])).toEqual(['a', 'b']);
  });

  it('empty lists fuse to an empty result', () => {
    expect(fuseReciprocalRank([[], []])).toEqual([]);
  });
});
