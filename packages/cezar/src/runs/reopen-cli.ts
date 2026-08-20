import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { basename, join, resolve } from 'node:path';
import { appendReopenRequests, selectDoneUnarchived, type NewReopenRequest } from '../reopen-requests.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { isRegisteredRoot, normalizeRoot } from '../workspace/projects.ts';
import { readRunIndexFromDisk } from './run-index.ts';
import type { RunRecord } from './store.ts';

/**
 * `cezar runs reopen` (Phase 3 of `.ai/specs/2026-08-20-reopen-finished-tasks-merge-audit.md`).
 *
 * Writes reopen requests straight to each project's `.ai/cezar/reopen-requests.json` on the
 * FILESYSTEM, exactly as `cezar todo add` writes `todos.json` and `cezar kb write` writes the
 * knowledge inbox — never over HTTP, which sits behind the `/api/v1` principal perimeter and 401s
 * a headless caller on loopback (production runs `CEZ_AUTH=oidc` behind Cloudflare Access). The
 * running cockpit is what turns a request into a continuation (`reopen-watch.ts`).
 *
 * **Read-only against `runs.json`.** Selection goes through `readRunIndexFromDisk`, the reader
 * that exists precisely so a caller can enumerate a project's runs WITHOUT opening a `RunStore`
 * (which `mkdir`s, rewrites live-looking statuses, and — via a `ProjectContext` — would recover
 * and RESUME interrupted runs). Enumerating tasks must never restart agents.
 */

export interface ReopenCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface ReopenCliOptions {
  /** Repo root the "boot project" defaults to — resolved by the caller the same way `index.ts`
   *  resolves it for every other subcommand (git toplevel, falling back to cwd). */
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  io?: ReopenCliIo;
}

const defaultIo: ReopenCliIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

const USAGE = `usage:
  cezar runs reopen --all-done [--project <id|path|all>] [--prompt "<text>"]
                               [--dry-run] [--limit <n>] [--exclude <runId>]...
  cezar runs reopen <runId>...  [--project <id|path>] [--prompt "<text>"] [--dry-run]

  --all-done   every run with status 'done' that is NOT archived — the Active tab's own
               predicate. Defaults to every registered project PLUS this repo.
  --dry-run    print the selection and write nothing. Preview the sweep before firing it.
  --limit <n>  cap how many requests are written, oldest-finished first.
  --exclude    skip a run id (e.g. the run that is firing the sweep).`;

const KNOWN_SUBCOMMANDS = new Set(['reopen']);

/**
 * `cez runs ...` entry point. Returns the process exit code, matching `runTodoCommand`'s /
 * `runKnowledgeCommand`'s convention: 0 on success, 1 on a usage error or a genuine failure.
 */
export async function runRunsCommand(args: string[], opts: ReopenCliOptions): Promise<number> {
  const io = opts.io ?? defaultIo;
  const [sub, ...rest] = args;

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    io.log(USAGE);
    return 0;
  }

  if (!KNOWN_SUBCOMMANDS.has(sub)) {
    io.error(`unknown runs subcommand: ${sub}`);
    io.error(USAGE);
    return 1;
  }

  try {
    return await handleReopen(rest, opts, io);
  } catch (err) {
    io.error(`runs ${sub}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// ---- project resolution -------------------------------------------------------------------

/** One project the sweep may reach. */
interface ProjectTarget {
  id: string;
  root: string;
  dataDir: string;
}

function targetFor(id: string, root: string): ProjectTarget {
  return { id, root, dataDir: join(root, '.ai/cezar') };
}

/**
 * The default target set: **every registered project plus the boot project**.
 *
 * The boot project is included deliberately and is not redundant. Every WORKSPACE run's record
 * lives in the boot repo's `runs.json` (`.ai/specs/2026-08-15-cross-project-workspace-run.md`,
 * D1), and a boot repo is not necessarily in `~/.cezar/config.json` — on the production box it is
 * the service's `WorkingDirectory` and carries no registry row at all, while holding the large
 * majority of the finished runs. `isRegisteredRoot` is the same guard both cross-project indexes
 * use to keep a REGISTERED boot repo from being listed twice.
 *
 * "The boot project" here means the repo THIS CLI was invoked from — the CLI has no way to read
 * another process's `WorkingDirectory`, so a sweep meant to cover the cockpit's boot repo must be
 * run from it (or name it with `--project <path>`).
 */
async function allTargets(defaultRoot: string): Promise<ProjectTarget[]> {
  const { projects } = await loadWorkspaceConfig();
  const targets = projects.map((project) => targetFor(project.id, project.root));
  if (!(await isRegisteredRoot(projects, defaultRoot))) {
    targets.push(targetFor(basename(defaultRoot), await normalizeRoot(defaultRoot)));
  }
  return targets;
}

/**
 * `--project <id|path|all>`. Omitted or `all` means every target above; otherwise a registered
 * project's id, a path resolving (by realpath) to a registered root, or a path resolving to the
 * invoking repo itself — never an arbitrary directory.
 */
async function resolveTargets(
  projectArg: string | undefined,
  defaultRoot: string,
): Promise<{ targets: ProjectTarget[] } | { error: string }> {
  const targets = await allTargets(defaultRoot);
  if (!projectArg || projectArg === 'all') return { targets };
  const byId = targets.find((t) => t.id === projectArg);
  if (byId) return { targets: [byId] };
  const normalized = await normalizeRoot(resolve(projectArg));
  const byRoot = targets.find((t) => t.root === normalized);
  if (byRoot) return { targets: [byRoot] };
  return { error: `unknown project: ${projectArg} (not a registered id or path — see: cezar projects)` };
}

// ---- selection ----------------------------------------------------------------------------

interface Selected {
  target: ProjectTarget;
  run: RunRecord;
}

/** Oldest-finished-first, the order `--limit` truncates in: a partial sweep should clear the
 *  oldest backlog rather than an arbitrary slice. A run with no `finishedAt` (there should be
 *  none among `done` rows, but the field is optional on the record) sorts by `createdAt`. */
function sortKey(run: RunRecord): string {
  return run.finishedAt ?? run.createdAt ?? '';
}

/** A project that has never run anything has no `runs.json` at all — a perfectly normal state,
 *  reported as skipped and never an error. Distinguished from an empty/corrupt index, which
 *  `readRunIndexFromDisk` also renders as zero rows. */
function hasRunIndex(target: ProjectTarget): boolean {
  return existsSync(join(target.dataDir, 'runs.json'));
}

// ---- reopen -------------------------------------------------------------------------------

function formatRow(entry: Selected): string {
  const { target, run } = entry;
  const title = run.titleSummary ?? run.title;
  return `  ${target.id.padEnd(14)} ${run.id}  ${run.status.padEnd(6)} ${run.finishedAt ?? '-'}  ${title}`;
}

async function handleReopen(rest: string[], opts: ReopenCliOptions, io: ReopenCliIo): Promise<number> {
  let values: {
    project?: string;
    prompt?: string;
    'all-done'?: boolean;
    'dry-run'?: boolean;
    limit?: string;
    exclude?: string[];
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: {
        project: { type: 'string' },
        prompt: { type: 'string' },
        'all-done': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        limit: { type: 'string' },
        exclude: { type: 'string', multiple: true },
      },
      allowPositionals: true,
    }));
  } catch {
    io.error(USAGE);
    return 1;
  }

  const allDone = Boolean(values['all-done']);
  const runIds = positionals.filter((p) => p.trim());
  if (allDone && runIds.length > 0) {
    io.error('cezar runs reopen: --all-done selects the runs itself — do not also name run ids');
    return 1;
  }
  if (!allDone && runIds.length === 0) {
    io.error(USAGE);
    return 1;
  }

  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 0) {
      io.error(`cezar runs reopen: --limit must be a non-negative integer (got "${values.limit}")`);
      return 1;
    }
  }

  const resolved = await resolveTargets(values.project, opts.repoRoot);
  if ('error' in resolved) {
    io.error(`cezar runs reopen: ${resolved.error}`);
    return 1;
  }

  const excluded = new Set(values.exclude ?? []);
  const skipped: string[] = [];
  let selected: Selected[] = [];

  for (const target of resolved.targets) {
    if (!hasRunIndex(target)) {
      skipped.push(target.id);
      continue;
    }
    const runs = readRunIndexFromDisk(target.dataDir);
    const picked = allDone
      ? selectDoneUnarchived(runs)
      : runs.filter((run) => runIds.includes(run.id));
    for (const run of picked) {
      if (excluded.has(run.id)) continue;
      selected.push({ target, run });
    }
  }

  if (!allDone) {
    const found = new Set(selected.map((entry) => entry.run.id));
    const missing = runIds.filter((id) => !found.has(id) && !excluded.has(id));
    if (missing.length > 0) {
      io.error(`cezar runs reopen: no such run in any selected project: ${missing.join(', ')}`);
      return 1;
    }
  }

  selected.sort((a, b) => sortKey(a.run).localeCompare(sortKey(b.run)));
  const total = selected.length;
  if (limit !== undefined) selected = selected.slice(0, limit);

  if (selected.length === 0) {
    io.log('no matching runs');
    if (skipped.length > 0) io.log(`skipped (no runs.json): ${skipped.join(', ')}`);
    return 0;
  }

  for (const entry of selected) io.log(formatRow(entry));
  if (limit !== undefined && total > selected.length) {
    io.log(`(--limit ${limit} of ${total} selected — oldest finished first)`);
  }

  if (values['dry-run']) {
    io.log(`dry run — ${selected.length} run(s) would be reopened, nothing written`);
    if (skipped.length > 0) io.log(`skipped (no runs.json): ${skipped.join(', ')}`);
    return 0;
  }

  const env = opts.env ?? process.env;
  const taskId = env.CEZ_TASK_ID?.trim();
  const source = taskId ? `cli:${taskId}` : 'cli';
  const prompt = values.prompt?.trim() || undefined;

  const byDataDir = new Map<string, { target: ProjectTarget; requests: NewReopenRequest[] }>();
  for (const entry of selected) {
    const bucket = byDataDir.get(entry.target.dataDir) ?? { target: entry.target, requests: [] };
    bucket.requests.push({ runId: entry.run.id, ...(prompt ? { prompt } : {}), source });
    byDataDir.set(entry.target.dataDir, bucket);
  }

  for (const { target, requests } of byDataDir.values()) {
    await appendReopenRequests(target.dataDir, requests);
    io.log(`${target.id}: filed ${requests.length} reopen request(s)`);
  }
  if (skipped.length > 0) io.log(`skipped (no runs.json): ${skipped.join(', ')}`);
  io.log('the running cockpit picks these up and continues each run (queued behind maxParallel)');
  return 0;
}
