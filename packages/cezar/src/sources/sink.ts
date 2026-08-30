import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { mirroredDocumentSchema, type MirroredDocument, type MirroredDocumentMeta, type SourceSink } from './types.ts';

/**
 * `FileSourceSink` (W1.5) — the default, standalone `SourceSink`: one `<docId>.md` per document,
 * YAML frontmatter carrying F1's nested `source` object (D17), under the mirror root F1 registers
 * as a knowledge mount (D3). Adoption moves bytes into F1's writable knowledge root
 * (`.ai/cezar/knowledge/`, D16) — there is **no directory named `adopted` anywhere in this file**.
 *
 * Bound to ONE `(dataDir, connectionId)` pair at construction. The `SourceSink` port's other
 * methods (`readMeta`, `read`, `quarantine`, `tombstone`, `adopt`) take a bare `docId` with no
 * `connectionId` — this implementation keeps no second index mapping `docId → connectionId` (the
 * spec's "no second copy of the provenance" rule), so it can only resolve a `docId` within the one
 * connection it was constructed for. `list(connectionId)` asserts its argument matches, rather than
 * silently ignoring a caller's mismatched id.
 */
export class FileSourceSink implements SourceSink {
  private readonly now: () => Date;

  constructor(
    private readonly dataDir: string,
    private readonly connectionId: string,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private get mirrorDir(): string {
    return join(this.dataDir, 'sources', this.connectionId);
  }

  private get conflictsDir(): string {
    return join(this.mirrorDir, 'conflicts');
  }

  private get deletedDir(): string {
    return join(this.mirrorDir, 'deleted');
  }

  /** F1's ONE writable knowledge root (D16), shared across every connection — never
   *  connection-scoped, and never a subdirectory named `adopted`. */
  private get knowledgeDir(): string {
    return join(this.dataDir, 'knowledge');
  }

  async upsert(doc: MirroredDocument, body: string): Promise<{ localVersion: string; changed: boolean }> {
    const parsed = mirroredDocumentSchema.parse(doc);
    if (parsed.source.connectionId !== this.connectionId) {
      throw new Error(
        `sink is bound to connection "${this.connectionId}", got a document for "${parsed.source.connectionId}"`,
      );
    }
    const localVersion = hashBytes(body);
    const withVersion: MirroredDocument = { ...parsed, localVersion };
    const content = serialize(withVersion, body);
    const path = join(this.mirrorDir, `${parsed.docId}.md`);
    const existing = await tryRead(path);
    if (existing === content) return { localVersion, changed: false };
    await atomicWrite(path, content);
    return { localVersion, changed: true };
  }

  async readMeta(docId: string): Promise<MirroredDocumentMeta | null> {
    const raw = await tryRead(join(this.mirrorDir, `${docId}.md`));
    if (raw === null) return null;
    const { frontmatter } = splitFrontmatter(raw, docId);
    return mirroredDocumentSchema.parse(frontmatter);
  }

  async read(docId: string): Promise<{ body: string; localVersion: string } | null> {
    const raw = await tryRead(join(this.mirrorDir, `${docId}.md`));
    if (raw === null) return null;
    const { body } = splitFrontmatter(raw, docId);
    return { body, localVersion: hashBytes(body) };
  }

  async list(connectionId: string): Promise<MirroredDocumentMeta[]> {
    if (connectionId !== this.connectionId) {
      throw new Error(`sink is bound to connection "${this.connectionId}", not "${connectionId}"`);
    }
    let entries: Dirent[];
    try {
      entries = await readdir(this.mirrorDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const metas: MirroredDocumentMeta[] = [];
    for (const entry of entries) {
      // `conflicts/` and `deleted/` are directories here, never `.md` files, so this loop
      // never surfaces them (D18 is F1's exclusion list; this is just a natural consequence).
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const meta = await this.readMeta(entry.name.slice(0, -3));
      if (meta) metas.push(meta);
    }
    return metas;
  }

  /**
   * The incoming body is quarantined to `conflicts/<docId>.remote-<shortVersion>.md`. The local
   * document is left with its body byte-identical, and only its own `source.state` flips to
   * `'conflict'` (Q14) — there is no separate "mark conflict" method on the port, so this is the
   * one call that does both.
   */
  async quarantine(docId: string, remoteVersion: string, body: string): Promise<void> {
    const shortVersion = shortHash(remoteVersion);
    await atomicWrite(join(this.conflictsDir, `${docId}.remote-${shortVersion}.md`), body);

    const localPath = join(this.mirrorDir, `${docId}.md`);
    const raw = await tryRead(localPath);
    if (raw === null) return; // nothing local to mark; the conflict artifact still lands
    const { frontmatter, body: localBody } = splitFrontmatter(raw, docId);
    const parsed = mirroredDocumentSchema.parse(frontmatter);
    const updated: MirroredDocument = { ...parsed, source: { ...parsed.source, state: 'conflict' } };
    await atomicWrite(localPath, serialize(updated, localBody));
  }

  async backupLocal(docId: string, localVersion: string, body: string): Promise<void> {
    await atomicWrite(join(this.conflictsDir, `${docId}.local-${localVersion.slice(0, 8)}.md`), body);
  }

  async tombstone(docId: string, _at: string): Promise<void> {
    const localPath = join(this.mirrorDir, `${docId}.md`);
    const raw = await tryRead(localPath);
    if (raw === null) return;
    const { frontmatter, body } = splitFrontmatter(raw, docId);
    const parsed = mirroredDocumentSchema.parse(frontmatter);
    const updated: MirroredDocument = { ...parsed, source: { ...parsed.source, state: 'tombstoned' } };
    await atomicWrite(join(this.deletedDir, `${docId}.md`), serialize(updated, body));
    await rm(localPath, { force: true });
  }

  async adopt(docId: string): Promise<{ path: string; adoptedAt: string }> {
    const localPath = join(this.mirrorDir, `${docId}.md`);
    const raw = await tryRead(localPath);
    if (raw === null) throw new Error(`cannot adopt "${docId}": not found in the mirror`);
    const { frontmatter, body } = splitFrontmatter(raw, docId);
    const parsed = mirroredDocumentSchema.parse(frontmatter);
    const adoptedAt = this.now().toISOString();
    const updated: MirroredDocument = {
      ...parsed,
      source: { ...parsed.source, origin: 'local', adoptedAt },
    };
    const knowledgePath = join(this.knowledgeDir, `${docId}.md`);
    await atomicWrite(knowledgePath, serialize(updated, body));
    await rm(localPath, { force: true });
    return { path: knowledgePath, adoptedAt };
  }

  /** No-op standalone: with `CEZ_KB` unset there is no index to notify. F1 supplies its own sink
   *  at `ProjectContext` build time (W3.1) that forwards this to its real `notifyChanged`. */
  notifyChanged(_root: string, _docIds?: readonly string[]): void {
    // Intentionally empty — see the doc comment.
  }
}

// ---- frontmatter ----------------------------------------------------------------------------

const DELIM = '---';

function serialize(meta: MirroredDocument, body: string): string {
  const front = stringifyYaml(meta).trimEnd();
  return `${DELIM}\n${front}\n${DELIM}\n\n${body}`;
}

function splitFrontmatter(raw: string, docId: string): { frontmatter: unknown; body: string } {
  const openMarker = `${DELIM}\n`;
  if (!raw.startsWith(openMarker)) {
    throw new Error(`mirrored document "${docId}" is missing its YAML frontmatter block`);
  }
  const closeMarker = `\n${DELIM}\n`;
  const closeIndex = raw.indexOf(closeMarker, openMarker.length);
  if (closeIndex === -1) {
    throw new Error(`mirrored document "${docId}" has an unterminated frontmatter block`);
  }
  const frontmatterText = raw.slice(openMarker.length, closeIndex);
  const rest = raw.slice(closeIndex + closeMarker.length);
  const body = rest.startsWith('\n') ? rest.slice(1) : rest;
  return { frontmatter: parseYaml(frontmatterText), body };
}

// ---- io helpers -----------------------------------------------------------------------------

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** tmp plus rename at 0600 (`agent-config/files.ts:17-19`'s idiom), unique per write so two
 *  concurrent writes to the same path can't tear each other's bytes. */
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

function hashBytes(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}
