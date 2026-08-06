import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runKnowledgeCommand, type KnowledgeCliIo } from './cli.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRepo(prefix: string): Promise<string> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, prefix));
  dirs.push(dir);
  return dir;
}

function collectIo(): { io: KnowledgeCliIo; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { io: { log: (line) => logs.push(line), error: (line) => errors.push(line) }, logs, errors };
}

function envOn(): NodeJS.ProcessEnv {
  return { ...process.env, CEZ_KB: '1' };
}

async function seedProjectDoc(repoRoot: string, relPath: string, content: string): Promise<void> {
  const target = join(repoRoot, '.ai/cezar/knowledge', relPath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content, 'utf8');
}

describe('cez kb, CEZ_KB off (D4/D19/C5)', () => {
  it('every subcommand answers {available:false, reason} and exits 0, no store built', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-off-');
    for (const sub of ['search', 'show', 'write', 'reindex', 'roots', 'proposals']) {
      const { io, logs } = collectIo();
      const code = await runKnowledgeCommand([sub, 'x', '--json'], { repoRoot, env: { ...process.env, CEZ_KB: '0' }, io });
      expect(code).toBe(0);
      const parsed = JSON.parse(logs[0]!);
      expect(parsed).toMatchObject({ available: false });
      expect(typeof parsed.reason).toBe('string');
    }
  });

  it('unset CEZ_KB (not just "0") is also off', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-unset-');
    const { io, logs } = collectIo();
    const env = { ...process.env };
    delete env.CEZ_KB;
    const code = await runKnowledgeCommand(['search', 'anything'], { repoRoot, env, io });
    expect(code).toBe(0);
    expect(logs[0]).toContain('CEZ_KB=1');
  });

  it('never builds a store when off: a knowledge/ directory full of docs stays unreported', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-off-noio-');
    await seedProjectDoc(repoRoot, 'a.md', '# A\n\nBody about apples.');
    const { io, logs } = collectIo();
    const code = await runKnowledgeCommand(['search', 'apples', '--json'], { repoRoot, env: { ...process.env, CEZ_KB: '0' }, io });
    expect(code).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({ available: false });
  });
});

describe('cez kb, usage', () => {
  it('no subcommand prints usage and exits 0', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-help-');
    const { io, logs } = collectIo();
    const code = await runKnowledgeCommand([], { repoRoot, env: envOn(), io });
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('cez kb search');
  });

  it('an unknown subcommand exits 1 with usage, regardless of CEZ_KB', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-unknown-');
    const { io, errors } = collectIo();
    const code = await runKnowledgeCommand(['bogus'], { repoRoot, env: { ...process.env, CEZ_KB: '0' }, io });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('unknown kb subcommand');
  });
});

describe('cez kb search, C1/C14', () => {
  it('finds a seeded document by keyword and exits 0', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-search-');
    await seedProjectDoc(repoRoot, 'apples.md', '# Apples\n\nA note about growing apples in the orchard.');
    const { io, logs } = collectIo();
    const code = await runKnowledgeCommand(['search', 'apples', '--json'], { repoRoot, env: envOn(), io });
    expect(code).toBe(0);
    const body = JSON.parse(logs[0]!);
    expect(body.total).toBeGreaterThan(0);
    expect(body.results[0].title).toBe('Apples');
    expect(body.fallback).toBeUndefined();
  });

  it('C14: a zero-result --json search carries fallback with roots and a literal grep command, never a bare empty result', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-search-empty-');
    await seedProjectDoc(repoRoot, 'apples.md', '# Apples\n\nA note about growing apples.');
    const { io, logs } = collectIo();
    const code = await runKnowledgeCommand(['search', 'zzz-nomatch-zzz', '--json'], { repoRoot, env: envOn(), io });
    expect(code).toBe(0);
    const body = JSON.parse(logs[0]!);
    expect(body.results).toEqual([]);
    expect(body.fallback).toBeDefined();
    expect(typeof body.fallback.note).toBe('string');
    expect(body.fallback.note.length).toBeGreaterThan(0);
    expect(Array.isArray(body.fallback.roots)).toBe(true);
    expect(body.fallback.roots.some((r: { id: string }) => r.id === 'project')).toBe(true);
    expect(body.fallback.grep).toContain('grep -rIl');
    expect(body.fallback.grep).toContain('zzz-nomatch-zzz');
  });

  it('fallback is present exactly when results is empty (mechanical check both ways)', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-search-both-');
    await seedProjectDoc(repoRoot, 'apples.md', '# Apples\n\nGrowing apples.');
    const { io: io1, logs: logs1 } = collectIo();
    await runKnowledgeCommand(['search', 'apples', '--json'], { repoRoot, env: envOn(), io: io1 });
    const hit = JSON.parse(logs1[0]!);
    expect(hit.results.length > 0).toBe(true);
    expect('fallback' in hit).toBe(false);

    const { io: io2, logs: logs2 } = collectIo();
    await runKnowledgeCommand(['search', 'no-such-token-anywhere', '--json'], { repoRoot, env: envOn(), io: io2 });
    const miss = JSON.parse(logs2[0]!);
    expect(miss.results.length === 0).toBe(true);
    expect('fallback' in miss).toBe(true);
  });

  it('a zero-result search in TEXT mode is never a bare empty line either', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-search-text-empty-');
    const { io, logs } = collectIo();
    const code = await runKnowledgeCommand(['search', 'no-such-token-anywhere'], { repoRoot, env: envOn(), io });
    expect(code).toBe(0);
    const printed = logs.join('\n');
    expect(printed).toContain('grep -rIl');
    expect(printed.trim().length).toBeGreaterThan(0);
  });

  it('an empty query is a usage error, exit 1', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-search-noquery-');
    const { io, errors } = collectIo();
    const code = await runKnowledgeCommand(['search'], { repoRoot, env: envOn(), io });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('usage');
  });
});

describe('cez kb show', () => {
  it('shows a document by id, including its body', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-show-');
    await seedProjectDoc(repoRoot, 'doc.md', '# Doc Title\n\nThe body text.');
    const { io: searchIo, logs: searchLogs } = collectIo();
    await runKnowledgeCommand(['search', 'Doc Title', '--json'], { repoRoot, env: envOn(), io: searchIo });
    const id = JSON.parse(searchLogs[0]!).results[0].id as string;

    const { io, logs } = collectIo();
    const code = await runKnowledgeCommand(['show', id, '--json'], { repoRoot, env: envOn(), io });
    expect(code).toBe(0);
    const body = JSON.parse(logs[0]!);
    expect(body.document.id).toBe(id);
    expect(body.document.body).toContain('The body text.');
  });

  it('an unknown id exits 1', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-show-404-');
    const { io, errors } = collectIo();
    const code = await runKnowledgeCommand(['show', 'project-doesnotexist000'], { repoRoot, env: envOn(), io });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('no such document');
  });

  it('an unknown id in --json mode still exits 1 and reports document:null', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-show-404-json-');
    const { io, logs } = collectIo();
    const code = await runKnowledgeCommand(['show', 'project-doesnotexist000', '--json'], { repoRoot, env: envOn(), io });
    expect(code).toBe(1);
    expect(JSON.parse(logs[0]!).document).toBeNull();
  });
});

describe('cez kb write', () => {
  it('creates a document under the project root via --content, findable afterwards', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-write-');
    const { io, logs } = collectIo();
    const code = await runKnowledgeCommand(
      ['write', 'project', 'decisions/one.md', '--content', '# One\n\nA written decision.', '--json'],
      { repoRoot, env: envOn(), io },
    );
    expect(code).toBe(0);
    const body = JSON.parse(logs[0]!);
    expect(body.ok).toBe(true);
    expect(body.document.root).toBe('project');

    const { io: searchIo, logs: searchLogs } = collectIo();
    await runKnowledgeCommand(['search', 'written decision', '--json'], { repoRoot, env: envOn(), io: searchIo });
    expect(JSON.parse(searchLogs[0]!).total).toBeGreaterThan(0);
  });

  it('reads content from stdin when --content is omitted', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-write-stdin-');
    const { io, logs } = collectIo();
    const code = await runKnowledgeCommand(['write', 'project', 'from-stdin.md', '--json'], {
      repoRoot,
      env: envOn(),
      io,
      readStdin: async () => '# From Stdin\n\nPiped body.',
    });
    expect(code).toBe(0);
    expect(JSON.parse(logs[0]!).document.title).toBe('From Stdin');
  });

  it('refuses a path that escapes the writable root, exit 1', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-write-escape-');
    const { io, errors } = collectIo();
    const code = await runKnowledgeCommand(['write', 'project', '../../etc/evil.md', '--content', 'nope'], {
      repoRoot,
      env: envOn(),
      io,
    });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('cez kb write:');
  });

  it('refuses to overwrite an existing document, exit 1, on the second write', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-write-exists-');
    const first = await runKnowledgeCommand(['write', 'project', 'a.md', '--content', '# A'], { repoRoot, env: envOn() });
    expect(first).toBe(0);
    const { io, errors } = collectIo();
    const code = await runKnowledgeCommand(['write', 'project', 'a.md', '--content', '# A again'], { repoRoot, env: envOn(), io });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('cez kb write:');
  });

  it('an invalid scope is a usage error, exit 1', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-write-badscope-');
    const { io, errors } = collectIo();
    const code = await runKnowledgeCommand(['write', 'bogus-scope', 'a.md', '--content', 'x'], { repoRoot, env: envOn(), io });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('usage');
  });
});

describe('cez kb reindex', () => {
  it('reports formatVersion and scan stats', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-reindex-');
    await seedProjectDoc(repoRoot, 'a.md', '# A');
    const { io, logs } = collectIo();
    const code = await runKnowledgeCommand(['reindex', '--json'], { repoRoot, env: envOn(), io });
    expect(code).toBe(0);
    const body = JSON.parse(logs[0]!);
    expect(typeof body.formatVersion).toBe('number');
    expect(body.scan).toMatchObject({ truncated: false });
  });
});

describe('cez kb roots', () => {
  it('lists the project and workspace roots as indexed', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-roots-');
    const { io, logs } = collectIo();
    const code = await runKnowledgeCommand(['roots', '--json'], { repoRoot, env: envOn(), io });
    expect(code).toBe(0);
    const body = JSON.parse(logs[0]!);
    const byId = Object.fromEntries(body.roots.map((r: { id: string }) => [r.id, r]));
    expect(byId.project).toMatchObject({ writable: true, indexed: true });
    expect(byId.workspace).toMatchObject({ writable: true, indexed: true });
  });
});

describe('cez kb proposals', () => {
  it('reports no pending proposals when the runs directory does not exist', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-proposals-none-');
    const { io, logs } = collectIo();
    const code = await runKnowledgeCommand(['proposals', '--json'], { repoRoot, env: envOn(), io });
    expect(code).toBe(0);
    expect(JSON.parse(logs[0]!).proposals).toEqual([]);
  });

  it('lists valid proposal lines and drops a malformed trailing line with a warning', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-proposals-');
    const runsDir = join(repoRoot, '.ai/cezar/runs');
    await mkdir(runsDir, { recursive: true });
    const lines = [
      JSON.stringify({ op: 'upsert', scope: 'project', path: 'decisions/x.md', title: 'X', body: 'body' }),
      JSON.stringify({ op: 'supersede', target: 'old-doc', by: 'x', date: '2026-08-06' }),
      '{not valid json',
    ].join('\n');
    await writeFile(join(runsDir, 'run-abc.knowledge.ndjson'), `${lines}\n`, 'utf8');

    const { io, logs } = collectIo();
    const code = await runKnowledgeCommand(['proposals', '--json'], { repoRoot, env: envOn(), io });
    expect(code).toBe(0);
    const body = JSON.parse(logs[0]!);
    expect(body.proposals).toHaveLength(2);
    expect(body.proposals[0]).toMatchObject({ runId: 'run-abc', seq: 1 });
    expect(body.proposals[0].proposal).toMatchObject({ op: 'upsert', path: 'decisions/x.md' });
    expect(body.proposals[1].proposal).toMatchObject({ op: 'supersede', target: 'old-doc' });
    expect(body.warnings.some((w: string) => w.includes(':3:'))).toBe(true);
  });

  it('the same malformed-line fixture in text mode surfaces the warning on stderr, not silently', async () => {
    const repoRoot = await tempRepo('cez-kb-cli-proposals-text-');
    const runsDir = join(repoRoot, '.ai/cezar/runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, 'run-xyz.knowledge.ndjson'), '{not valid json\n', 'utf8');

    const { io, logs, errors } = collectIo();
    const code = await runKnowledgeCommand(['proposals'], { repoRoot, env: envOn(), io });
    expect(code).toBe(0);
    expect(errors.some((e) => e.includes('malformed JSON'))).toBe(true);
    expect(logs.join('\n')).toContain('no pending proposals');
  });
});
