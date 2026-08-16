import { parseArgs } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { knowledgeSupersedeProposalSchema, knowledgeUpsertProposalSchema } from '@loki-labs/better-cezar-contract';
import { KnowledgeStore } from './store.ts';
import type { SearchFilters } from './search.ts';

/**
 * `cez kb search|show|write|reindex|roots|proposals` (F1, W4.3). See
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` ("CLI", "Verification" C14) and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` (D1..D25, outranks the spec on conflict).
 *
 * This is a command an agent already knows how to run through Bash (`DEFAULT_ALLOWED_TOOLS`
 * carries no MCP client), which is what lets it work identically on all three backends without
 * a new protocol.
 *
 * Scope note, stated rather than silently omitted: the spec describes this command as preferring
 * an already-running cockpit over HTTP and falling back to an in-process index build. This file
 * implements the in-process build only. Reason: at the time this package was written,
 * `server/knowledge-routes.ts` (W4.1) is still the inert D19 scaffold registered by W1.1, so
 * `GET /knowledge/search` answers the flag-off empty shape unconditionally, whether or not
 * `CEZ_KB=1` and whether or not documents exist. Preferring HTTP today would mean: a developer
 * with a cockpit running gets silently WRONG (empty) results, and a developer with no cockpit
 * running gets correct results from the fallback, an inversion of "prefer the fast path" into
 * "prefer the broken path when it happens to be reachable". There is also no existing precedent
 * anywhere in this package for a CLI subcommand discovering and calling its own locally running
 * server (checked: no pidfile, no per-repo port record, no bearer auth). Building that discovery
 * mechanism is a real design decision, not a detail to guess inside a leaf file, so it is left for
 * a follow-up once W4.1 ships the real handlers. The in-process build is explicitly sanctioned by
 * the spec as correct and "acceptable for a one shot" (measured ~146ms cold), so every behaviour
 * this file promises holds regardless of whether that follow-up ever lands.
 */

export interface KnowledgeCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface KnowledgeCliOptions {
  /** Repo root to operate on, resolved by the caller the same way `index.ts` resolves it for
   *  every other subcommand (git toplevel, falling back to cwd). */
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  io?: KnowledgeCliIo;
  /** Testing/embedding seam for `write` when `--content` is not given. Defaults to reading
   *  `process.stdin` to completion. */
  readStdin?: () => Promise<string>;
}

const defaultIo: KnowledgeCliIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const USAGE = `usage:
  cez kb search "<query>" [--json] [--type T] [--tag T] [--status S] [--root R] [--limit N] [--offset N]
  cez kb show <id> [--json]
  cez kb write <project|workspace> <path> [--content "..."] [--json]
                                (reads stdin when --content is omitted)
  cez kb reindex [--json]
  cez kb roots [--json]
  cez kb proposals [--json]

  every subcommand needs CEZ_KB=1`;

/** No em dash on purpose (house style for this file); matches the wording of the fixed 409
 *  message `knowledge-routes.ts` answers with (`KNOWLEDGE_OFF`), restated here because that
 *  constant is private to the HTTP route family. */
const KB_OFF_REASON = 'the knowledge base is disabled; set CEZ_KB=1 to enable it';

const KNOWN_SUBCOMMANDS = new Set(['search', 'show', 'write', 'reindex', 'roots', 'proposals']);

/**
 * `cez kb ...` entry point. Returns the process exit code, matching `runProjectsCommand`'s
 * convention: 0 on success (including the deliberately-off `{available:false}` shape, per
 * `AGENTS.md`, "an absent capability is not an error"), 1 on a usage error or a genuine failure.
 */
export async function runKnowledgeCommand(args: string[], opts: KnowledgeCliOptions): Promise<number> {
  const io = opts.io ?? defaultIo;
  const env = opts.env ?? process.env;
  const [sub, ...rest] = args;

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    io.log(USAGE);
    return 0;
  }

  if (!KNOWN_SUBCOMMANDS.has(sub)) {
    io.error(`unknown kb subcommand: ${sub}`);
    io.error(USAGE);
    return 1;
  }

  // The flag-off shape is checked here, before ANY store is built: D4 means zero I/O when
  // `CEZ_KB` is unset, and building a `KnowledgeStore` at all would scan the filesystem.
  if (env.CEZ_KB !== '1') {
    const json = rest.includes('--json');
    if (json) io.log(JSON.stringify({ available: false, reason: KB_OFF_REASON }, null, 2));
    else io.log(`kb ${sub}: ${KB_OFF_REASON}`);
    return 0;
  }

  const dataDir = join(opts.repoRoot, '.ai/cezar');
  // `disableWatchers`: this is a one-shot process that builds, answers, and exits; there is no
  // live session for an `fs.watch` handle to serve, so skipping watcher setup avoids paying for
  // it. The store is always built fresh per invocation (never reused across calls), matching the
  // spec's own framing ("falls back to an in process index build, measured at 146ms cold, which
  // is acceptable for a one shot").
  const store = KnowledgeStore.create(opts.repoRoot, dataDir, { env, disableWatchers: true });
  try {
    await store.initialize();
    switch (sub) {
      case 'search':
        return handleSearch(store, rest, io);
      case 'show':
        return handleShow(store, rest, io);
      case 'write':
        // Awaited, not just returned: `store.createDocument` does NOT wrap its own
        // `mkdir`/`writeFile`/`rename` in try/catch, so a real IO failure rejects here, and only
        // an awaited call inside this try lets the surrounding `catch` turn that into the same
        // `kb write: <message>` shape every other failure gets, instead of an unhandled rejection.
        return await handleWrite(store, rest, io, opts.readStdin ?? defaultReadStdin);
      case 'reindex':
        return await handleReindex(store, rest, io);
      case 'roots':
        return handleRoots(store, rest, io);
      case 'proposals':
        return await handleProposals(dataDir, rest, io);
      default:
        return 1; // unreachable: guarded by KNOWN_SUBCOMMANDS above
    }
  } catch (err) {
    io.error(`kb ${sub}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    store.dispose();
  }
}

// ---- search ----------------------------------------------------------------------------------

const SEARCH_USAGE = 'usage: cez kb search "<query>" [--json] [--type T] [--tag T] [--status S] [--root R] [--limit N] [--offset N]';

function asSearchStatus(value: string | undefined): SearchFilters['status'] {
  return value === 'current' || value === 'superseded' || value === 'draft' ? value : undefined;
}

interface SearchFallback {
  note: string;
  roots: Array<{ id: string; path: string; documentCount: number }>;
  grep: string;
}

function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The empty-result contract (spec "CLI"): `cez kb search` never prints a bare empty result.
 * `fallback` is present exactly when `results` is empty (C14) and names what was actually
 * searched (indexed roots only, with their document counts), states plainly that this was a
 * lexical match only, and gives a literal grep command to run instead.
 */
function buildSearchFallback(store: KnowledgeStore, query: string): SearchFallback {
  const roots = store
    .getRoots()
    .filter((root) => root.indexed)
    .map((root) => ({ id: root.id, path: root.path, documentCount: root.documentCount ?? 0 }));
  const grepTargets = roots.map((root) => shellQuoteSingle(root.path)).join(' ');
  // `project` and `workspace` are always indexed:true (paths.ts: a writable root is "present"
  // even before its first write), so `grepTargets` is empty only in the pathological case of
  // every root having been reported unavailable; that is still reported honestly rather than
  // shown as a runnable command with nothing to point it at.
  return {
    note:
      'no lexical match; this is BM25 keyword search only, not proof that nothing exists ' +
      '(a paraphrase using different words than the document can miss it entirely)',
    roots,
    grep: grepTargets ? `grep -rIl ${shellQuoteSingle(query)} ${grepTargets}` : 'no indexed root to grep',
  };
}

function handleSearch(store: KnowledgeStore, rest: string[], io: KnowledgeCliIo): number {
  let values: { json?: boolean; type?: string; tag?: string; status?: string; root?: string; limit?: string; offset?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: {
        json: { type: 'boolean', default: false },
        type: { type: 'string' },
        tag: { type: 'string' },
        status: { type: 'string' },
        root: { type: 'string' },
        limit: { type: 'string' },
        offset: { type: 'string' },
      },
      allowPositionals: true,
    }));
  } catch {
    io.error(SEARCH_USAGE);
    return 1;
  }

  const query = positionals.join(' ').trim();
  if (!query) {
    io.error(SEARCH_USAGE);
    return 1;
  }

  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  const offset = values.offset !== undefined ? Number(values.offset) : undefined;
  const result = store.search(query, {
    type: values.type,
    tag: values.tag,
    status: asSearchStatus(values.status),
    root: values.root,
    limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
    offset: offset !== undefined && Number.isFinite(offset) ? offset : undefined,
  });

  const fallback = result.results.length === 0 ? buildSearchFallback(store, query) : undefined;

  if (values.json) {
    io.log(
      JSON.stringify(
        {
          query: result.query,
          total: result.total,
          truncated: result.truncated,
          results: result.results,
          ...(fallback ? { fallback } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!fallback) {
    io.log(`${result.total} result(s)${result.truncated ? ' (truncated)' : ''} for "${query}"`);
    for (const doc of result.results) {
      io.log('');
      io.log(`${doc.id}  ${doc.title}`);
      const identifiers = doc.identifiers.length > 0 ? `  identifiers: ${doc.identifiers.join(', ')}` : '';
      io.log(`  root: ${doc.root}  type: ${doc.type}  status: ${doc.status}${identifiers}`);
      if (doc.headings.length > 0) io.log(`  headings: ${doc.headings.slice(0, 5).join(' / ')}`);
      if (doc.excerpt) io.log(`  ${doc.excerpt}`);
    }
    return 0;
  }

  io.log(`no lexical match for "${query}"`);
  io.log(fallback.note);
  io.log('');
  io.log('roots searched:');
  if (fallback.roots.length === 0) io.log('  (none indexed)');
  for (const root of fallback.roots) io.log(`  ${root.id}  ${root.path}  (${root.documentCount} docs)`);
  io.log('');
  io.log('try instead:');
  io.log(`  ${fallback.grep}`);
  return 0;
}

// ---- show -------------------------------------------------------------------------------------

const SHOW_USAGE = 'usage: cez kb show <id> [--json]';

function handleShow(store: KnowledgeStore, rest: string[], io: KnowledgeCliIo): number {
  let values: { json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: { json: { type: 'boolean', default: false } },
      allowPositionals: true,
    }));
  } catch {
    io.error(SHOW_USAGE);
    return 1;
  }

  const id = positionals[0];
  if (!id) {
    io.error(SHOW_USAGE);
    return 1;
  }

  const document = store.getDocument(id);
  if (!document) {
    if (values.json) io.log(JSON.stringify({ document: null, error: `no such document: ${id}` }, null, 2));
    else io.error(`no such document: ${id}`);
    return 1;
  }

  if (values.json) {
    io.log(JSON.stringify({ document }, null, 2));
    return 0;
  }

  io.log(`${document.title}  (${document.id})`);
  const supersede = document.status === 'superseded' && document.supersededBy ? `, superseded by ${document.supersededBy}` : '';
  io.log(`root: ${document.root}  type: ${document.type}  status: ${document.status}${supersede}`);
  io.log(`path: ${document.path}`);
  if (document.tags.length > 0) io.log(`tags: ${document.tags.join(', ')}`);
  io.log(`updated: ${document.updatedAt}`);
  io.log('');
  io.log(document.body ?? '');
  return 0;
}

// ---- write --------------------------------------------------------------------------------

const WRITE_USAGE = 'usage: cez kb write <project|workspace> <path> [--content "..."] [--json]';

async function handleWrite(
  store: KnowledgeStore,
  rest: string[],
  io: KnowledgeCliIo,
  readStdin: () => Promise<string>,
): Promise<number> {
  let values: { json?: boolean; content?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: { json: { type: 'boolean', default: false }, content: { type: 'string' } },
      allowPositionals: true,
    }));
  } catch {
    io.error(WRITE_USAGE);
    return 1;
  }

  const [scope, path] = positionals;
  if (scope !== 'project' && scope !== 'workspace') {
    io.error(WRITE_USAGE);
    return 1;
  }
  if (!path) {
    io.error(WRITE_USAGE);
    return 1;
  }

  const content = values.content !== undefined ? values.content : await readStdin();
  if (!content) {
    io.error('cez kb write: no content given; pass --content "..." or pipe it on stdin');
    return 1;
  }

  const result = await store.createDocument({ scope, path, content });
  if (!result.ok) {
    if (values.json) io.log(JSON.stringify({ ok: false, error: result.error }, null, 2));
    else io.error(`cez kb write: ${result.error}`);
    return 1;
  }

  if (values.json) {
    io.log(JSON.stringify({ ok: true, document: result.document }, null, 2));
  } else {
    io.log(`created ${result.document.id}  ${result.document.path}`);
  }
  return 0;
}

// ---- reindex ------------------------------------------------------------------------------

async function handleReindex(store: KnowledgeStore, rest: string[], io: KnowledgeCliIo): Promise<number> {
  const json = rest.includes('--json');
  const result = await store.reindexNow();
  if (json) {
    io.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const capNote = result.scan.truncated ? ` (TRUNCATED: ${result.scan.capHit ?? 'cap hit'})` : '';
  io.log(
    `reindexed; formatVersion ${result.formatVersion}; ${result.scan.filesScanned} files scanned, ` +
      `${result.scan.bytesScanned} bytes, ${result.scan.skipped} skipped${capNote}`,
  );
  return 0;
}

// ---- roots ----------------------------------------------------------------------------------

function handleRoots(store: KnowledgeStore, rest: string[], io: KnowledgeCliIo): number {
  const json = rest.includes('--json');
  const roots = store.getRoots();
  if (json) {
    io.log(JSON.stringify({ roots }, null, 2));
    return 0;
  }
  if (roots.length === 0) {
    io.log('no knowledge roots resolved');
    return 0;
  }
  for (const root of roots) {
    const mark = root.indexed ? 'indexed' : 'not indexed';
    const kind = root.writable ? 'writable' : 'read-only';
    const reason = root.reason ? `  (${root.reason})` : '';
    io.log(`  ${root.id}  [${mark}, ${kind}]  ${root.documentCount ?? 0} docs  ${root.path}${reason}`);
  }
  return 0;
}

// ---- proposals ------------------------------------------------------------------------------

/**
 * The raw NDJSON shape an agent appends to `<dataDir>/runs/<runId>.knowledge.ndjson` (spec "Data
 * Models" -> "Write back proposal"). It is narrower than `knowledgeProposalSchema` (contract):
 * the wire response the future `GET /knowledge/proposals` route answers with decorates each raw
 * line with `seq` / `runId` / `createdAt`, which the raw file itself does not carry (the spec's
 * own fixture lines omit them). Building here by `.omit()`-ing the same three fields off the
 * canonical per-op schemas reuses the one place each op's field list is defined rather than
 * restating it, without guessing at the pending-state storage `knowledge/proposals.ts` (W4.2, not
 * yet built) will own.
 */
const rawUpsertProposalSchema = knowledgeUpsertProposalSchema.omit({ seq: true, runId: true, createdAt: true });
const rawSupersedeProposalSchema = knowledgeSupersedeProposalSchema.omit({ seq: true, runId: true, createdAt: true });
const rawProposalSchema = z.discriminatedUnion('op', [rawUpsertProposalSchema, rawSupersedeProposalSchema]);
type RawProposal = z.infer<typeof rawProposalSchema>;

interface CliProposal {
  runId: string;
  /** 1-indexed position of the line within its run's NDJSON file. */
  seq: number;
  proposal: RawProposal;
}

const PROPOSAL_FILE_SUFFIX = '.knowledge.ndjson';

/**
 * Each line is parsed independently (spec "Edge Cases": "a malformed trailing line is dropped
 * with a warning and every complete line above it still applies"); this reads leniently at any
 * position, not only the tail, since a reader has no way to tell where in the file a kill landed.
 */
async function readPendingProposals(dataDir: string, warn: (message: string) => void): Promise<CliProposal[]> {
  const runsDir = join(dataDir, 'runs');
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }

  const proposals: CliProposal[] = [];
  for (const entry of entries.filter((name) => name.endsWith(PROPOSAL_FILE_SUFFIX))) {
    const runId = entry.slice(0, -PROPOSAL_FILE_SUFFIX.length);
    let raw: string;
    try {
      raw = await readFile(join(runsDir, entry), 'utf8');
    } catch {
      continue;
    }
    raw.split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        warn(`${entry}:${index + 1}: malformed JSON, skipped`);
        return;
      }
      const result = rawProposalSchema.safeParse(parsed);
      if (!result.success) {
        warn(`${entry}:${index + 1}: not a known proposal shape, skipped`);
        return;
      }
      proposals.push({ runId, seq: index + 1, proposal: result.data });
    });
  }
  return proposals;
}

function handleProposals(dataDir: string, rest: string[], io: KnowledgeCliIo): Promise<number> {
  const json = rest.includes('--json');
  const warnings: string[] = [];
  return readPendingProposals(dataDir, (message) => warnings.push(message)).then((proposals) => {
    if (json) {
      io.log(JSON.stringify({ proposals, warnings }, null, 2));
      return 0;
    }
    for (const warning of warnings) io.error(`warning: ${warning}`);
    if (proposals.length === 0) {
      io.log('no pending proposals');
      return 0;
    }
    for (const entry of proposals) {
      if (entry.proposal.op === 'upsert') {
        const title = entry.proposal.title ? `  "${entry.proposal.title}"` : '';
        io.log(`#${entry.seq} [${entry.runId}] upsert  ${entry.proposal.scope}:${entry.proposal.path}${title}`);
      } else {
        io.log(`#${entry.seq} [${entry.runId}] supersede  ${entry.proposal.target} -> ${entry.proposal.by} (${entry.proposal.date})`);
      }
    }
    return 0;
  });
}
