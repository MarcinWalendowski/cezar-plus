import { basename, resolve } from 'node:path';
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import { z } from 'zod';
import {
  runRecordSchema,
  type RunStatus,
  type WorkspaceProjectHealth,
  type WorkspaceRunSummary,
} from '@open-mercato/cezar-contract';

/**
 * `WorkspaceRunIndex` (W1.11) — the shared foundation both F3 features build on. See
 * `.ai/specs/2026-08-06-workspace-notes-cross-project.md` ("Architecture" ->
 * "`WorkspaceRunIndex`") and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D19.
 *
 * **READ never instantiates.** This module is a read-only PARSER over each project's
 * `<root>/.ai/cezar/runs.json` and nothing else. It deliberately imports NEITHER
 * `../runs/store.ts` (`RunStore.open` `mkdirSync`s a `runs/` directory and, without
 * `keepLive`, rewrites a live-looking `running`/`queued`/`waiting` status to `failed`) NOR
 * `../server/project-context.ts` (`ProjectContexts.context()` recovers and RESUMES
 * interrupted agent runs — the exact hazard the spec's "read-path hazard" section names)
 * NOR `../workflows/run.ts`. A structural test on this file's own source text is what keeps
 * that invariant from rotting into a comment (`run-index.test.ts`).
 *
 * **Dependency-injected, not import-wired** (the `ProjectContextDeps` /
 * `AutomationCoordinatorOptions` precedent): the registry lookup is a function the caller
 * supplies, so tests stay hermetic and never touch `~/.cezar`.
 *
 * **Cached per root on `mtimeMs` plus `size`.** Every call `stat()`s the file (cheap) and
 * only pays for `readFile` + `JSON.parse` + the zod parse when the pair differs from what is
 * cached — so an unchanged file is never re-parsed, and a CHANGED one is never served stale
 * even from the very next call (there is no time-boxed staleness window: correctness comes
 * from comparing the stat every time, not from a TTL that would have to expire first). Both
 * `mtimeMs` and `size` are required in the key on purpose: a same-second rewrite can leave
 * `mtimeMs` unchanged on filesystems with coarse timestamp resolution, and a same-length edit
 * (rare, but a status flip alone will not change a JSON file's byte count) can leave `size`
 * unchanged — either alone is beatable, the pair is not.
 *
 * **Per-project degradation, rendered rather than swallowed.** A missing root, an
 * unreadable or unparseable `runs.json` yields `{ok: false, reason}` and zero rows for that
 * project — never a throw, never dropped silently.
 */

// ---- inputs ------------------------------------------------------------------------------

/** One project this index may read from. Structurally a subset of
 *  `workspace/projects.ts`'s `ProjectListEntry` (id, root, status, name) — injected rather
 *  than imported so a unit test never has to touch the real registry file. `missing` is only
 *  ever *listed*: this index never stats or reads a missing project's `runs.json`. */
export interface WorkspaceRunProjectSource {
  /** Canonical registry slug. Never the reserved `'default'` boot alias when this row came
   *  from the registry itself (`RESERVED_PROJECT_IDS` forbids allocating it) — a `'default'`
   *  id can only appear here if a CALLER hands in a synthetic boot-project row under that
   *  alias, which `dedupeByRoot` below exists to absorb without a duplicate. */
  id: string;
  /** Realpath'd repo root. */
  root: string;
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  name: string;
}

export interface WorkspaceRunIndexDeps {
  /** The registry lookup, e.g. `workspace/projects.ts`'s `listProjects()` — injected so
   *  tests never read `~/.cezar`. A rejected promise degrades to an empty index rather than
   *  throwing (the "an unreadable registry degrades to `projects: []`" doctrine). */
  listProjects: () => Promise<readonly WorkspaceRunProjectSource[]>;
  /** Test seam for the cache-correctness controls: override the two fs calls this module
   *  makes. Both default to the real `node:fs/promises` functions. */
  readFile?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<{ mtimeMs: number; size: number }>;
}

export interface WorkspaceRunListOptions {
  /** Registry ids to include. **Absent means ALL projects, never none** — an empty array is
   *  a deliberate request for zero projects and is honored as such (distinct from absent). */
  projects?: readonly string[];
  /** Default `'active'` (`archived !== true`). `'archived'` returns only `archived === true`. */
  view?: 'active' | 'archived';
  /** Cap on the merged, cross-project result. Default 200. Bounds validation (1..500) is the
   *  route's job (`queryZodValidator`); this module only guards against a non-positive value. */
  limit?: number;
}

export interface WorkspaceRunListResult {
  /** Newest-first across every considered project, each row stamped with its project's id. */
  runs: WorkspaceRunSummary[];
  /** One entry per considered project — including a dead one, with `ok: false` and a reason. */
  projects: WorkspaceProjectHealth[];
  /** True when the merged result exceeds `limit` and was cut off. */
  truncated: boolean;
}

export interface WorkspaceRunDigestEntry {
  id: string;
  title: string;
  status: RunStatus;
  createdAt: string;
}

export interface WorkspaceRunDigestProject {
  ok: boolean;
  reason?: string;
  entries: WorkspaceRunDigestEntry[];
}

// ---- internals -----------------------------------------------------------------------------

/** The fields a `WorkspaceRunSummary` needs, parsed straight off the stored record and kept
 *  in the store's own newest-first order. `project` is stamped on in `list()`, right where the
 *  merged rows are built. `noteId` is never set here at all: joining the note store is a
 *  P2.2/P2.3 concern this module has no notion of (Q5). */
type TrimmedRun = Omit<WorkspaceRunSummary, 'project' | 'noteId'>;

/** Mirrors `runs/store.ts`'s private `MAX_RUNS_KEPT` / `MAX_ARCHIVED_KEPT` (not exported, so
 *  re-declared here). Defensive only — the store's own pruning already keeps `runs.json` at
 *  or under this size, so these caps exist for a hand-edited or externally grown file, not
 *  for normal operation. Applied AFTER splitting by view: a flat cap on the raw (mixed)
 *  array would risk starving the archived view whenever enough newer active runs exist,
 *  since `createdAt` order has no relationship to archive status. */
const MAX_ACTIVE_PER_PROJECT = 300;
const MAX_ARCHIVED_PER_PROJECT = 500;

function toSummary(run: z.infer<typeof runRecordSchema>): TrimmedRun {
  return {
    id: run.id,
    title: run.title,
    titleSummary: run.titleSummary,
    workflow: run.workflow,
    status: run.status,
    activity: run.activity,
    stopReason: run.stopReason,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    diffStat: run.diffStat,
    branch: run.branch,
    groupId: run.groupId,
    variant: run.variant,
    archived: run.archived,
    seenAt: run.seenAt,
    tokensUsed: run.tokensUsed,
    costUsd: run.costUsd,
    pullRequestUrl: run.pullRequestUrl,
    prNumber: run.prNumber,
    issueNumber: run.issueNumber,
    error: run.error,
    autoResumeAt: run.autoResumeAt,
    monitoringWakeAt: run.monitoringWakeAt,
  };
}

function describeError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied reading runs.json';
  if (code) return `${code} reading runs.json`;
  return err instanceof Error ? err.message : String(err);
}

/** Dedupe project rows by realpath'd root, preferring the row whose id is NOT the reserved
 *  `'default'` boot alias. This is what keeps the boot project from appearing twice: once
 *  under its own registered slug (from the ordinary registry list) and once under `'default'`
 *  (if a caller also hands in a synthetic boot-project row for the case where boot itself is
 *  unregistered). First-wins on any other collision — the registry itself never produces one
 *  (`registerProject` dedupes by realpath at write time), so this is belt-and-braces. */
function dedupeByRoot(sources: readonly WorkspaceRunProjectSource[]): WorkspaceRunProjectSource[] {
  const byRoot = new Map<string, WorkspaceRunProjectSource>();
  for (const source of sources) {
    const key = resolve(source.root);
    const existing = byRoot.get(key);
    if (!existing) {
      byRoot.set(key, source);
      continue;
    }
    if (existing.id === 'default' && source.id !== 'default') byRoot.set(key, source);
  }
  return [...byRoot.values()];
}

/** A simple k-way merge of already-sorted (newest-first) per-project lists — "merge, do not
 *  sort" (the spec's own words): `runs.json` is saved from `RunStore.listRuns()`, which is
 *  already `createdAt`-descending, so re-sorting the merged whole would throw that invariant
 *  away for no benefit. Linear scan over group heads rather than a heap: project counts are
 *  small (registered repos on one machine), so the O(n * projects) cost is negligible. */
function mergeDescendingByCreatedAt(
  groups: ReadonlyArray<{ project: string; runs: readonly TrimmedRun[] }>,
): Array<{ project: string; run: TrimmedRun }> {
  // Indexed access below is `!`-asserted at each site rather than left to infer, matching the
  // repo's own convention for a bounds-checked read under `noUncheckedIndexedAccess`
  // (e.g. `workflows/run.ts:1724`, `sources/notion/markdown.ts:81`): every `!` here sits right
  // after an explicit `i < groups.length` / `idx < group.runs.length` check on the SAME index.
  const cursors = groups.map(() => 0);
  const out: Array<{ project: string; run: TrimmedRun }> = [];
  for (;;) {
    let bestGroup = -1;
    let bestCreatedAt = '';
    for (let i = 0; i < groups.length; i++) {
      const idx = cursors[i]!;
      const group = groups[i]!;
      if (idx >= group.runs.length) continue;
      const createdAt = group.runs[idx]!.createdAt;
      if (bestGroup === -1 || createdAt > bestCreatedAt) {
        bestGroup = i;
        bestCreatedAt = createdAt;
      }
    }
    if (bestGroup === -1) break;
    const group = groups[bestGroup]!;
    const idx = cursors[bestGroup]!;
    out.push({ project: group.project, run: group.runs[idx]! });
    cursors[bestGroup] = idx + 1;
  }
  return out;
}

type ReadResult = { ok: true; runs: readonly TrimmedRun[] } | { ok: false; reason: string };

interface CacheEntry {
  mtimeMs: number;
  size: number;
  runs: readonly TrimmedRun[];
}

// ---- the index -----------------------------------------------------------------------------

export class WorkspaceRunIndex {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly readFileFn: (path: string) => Promise<string>;
  private readonly statFn: (path: string) => Promise<{ mtimeMs: number; size: number }>;

  constructor(private readonly deps: WorkspaceRunIndexDeps) {
    this.readFileFn = deps.readFile ?? ((path) => fsReadFile(path, 'utf8'));
    this.statFn = deps.stat ?? (async (path) => {
      const s = await fsStat(path);
      return { mtimeMs: s.mtimeMs, size: s.size };
    });
  }

  /** One project's runs, newest-first, no view filter and no cap applied yet (both are the
   *  caller's job below — the cache stays maximally reusable across `list()`'s two views and
   *  `digest()`). Never `mkdirSync`s, never touches `RunStore`: a missing `runs.json` (no
   *  task has ever run there) is `ok: true` with zero rows, not an error. */
  private async readProjectRuns(root: string): Promise<ReadResult> {
    const path = `${root}/.ai/cezar/runs.json`;
    let st: { mtimeMs: number; size: number };
    try {
      st = await this.statFn(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { ok: true, runs: [] };
      return { ok: false, reason: describeError(err) };
    }
    const cached = this.cache.get(root);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return { ok: true, runs: cached.runs };
    }
    let raw: string;
    try {
      raw = await this.readFileFn(path);
    } catch (err) {
      return { ok: false, reason: describeError(err) };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'runs.json is not valid JSON' };
    }
    const parsed = z.array(runRecordSchema).safeParse(parsedJson);
    if (!parsed.success) return { ok: false, reason: 'runs.json failed schema validation' };
    const runs = parsed.data.map(toSummary);
    this.cache.set(root, { mtimeMs: st.mtimeMs, size: st.size, runs });
    return { ok: true, runs };
  }

  private async resolveSources(): Promise<WorkspaceRunProjectSource[]> {
    try {
      return dedupeByRoot(await this.deps.listProjects());
    } catch {
      return [];
    }
  }

  /** `{runs, projects, truncated}` — deliberately not `bootProject`: naming the boot project's
   *  canonical slug needs `resolveBootProject()`, a `server.ts` closure this module must not
   *  import (see the header). That stamp is the route layer's job (W4.10); this index only
   *  ever emits the ids its caller's `listProjects()` already handed it. */
  async list(options: WorkspaceRunListOptions = {}): Promise<WorkspaceRunListResult> {
    const view = options.view ?? 'active';
    const limit = Math.max(0, options.limit ?? 200);
    const requested = options.projects ? new Set(options.projects) : undefined;

    const sources = await this.resolveSources();
    const considered = requested ? sources.filter((s) => requested.has(s.id)) : sources;

    const projects: WorkspaceProjectHealth[] = [];
    const groups: Array<{ project: string; runs: readonly TrimmedRun[] }> = [];

    for (const source of considered) {
      if (source.status === 'missing') {
        projects.push({
          id: source.id,
          name: source.name || basename(source.root),
          status: 'missing',
          ok: false,
          reason: 'project root is missing',
          total: 0,
        });
        continue;
      }
      const result = await this.readProjectRuns(source.root);
      if (!result.ok) {
        projects.push({
          id: source.id,
          name: source.name || basename(source.root),
          status: source.status,
          ok: false,
          reason: result.reason,
          total: 0,
        });
        continue;
      }
      const cap = view === 'archived' ? MAX_ARCHIVED_PER_PROJECT : MAX_ACTIVE_PER_PROJECT;
      const filtered = result.runs
        .filter((r) => (view === 'archived' ? r.archived === true : r.archived !== true))
        .slice(0, cap);
      projects.push({
        id: source.id,
        name: source.name || basename(source.root),
        status: source.status,
        ok: true,
        total: filtered.length,
      });
      groups.push({ project: source.id, runs: filtered });
    }

    const merged = mergeDescendingByCreatedAt(groups);
    const truncated = merged.length > limit;
    const runs: WorkspaceRunSummary[] = merged
      .slice(0, limit)
      .map(({ project, run }) => ({ ...run, project }));

    return { runs, projects, truncated };
  }

  /** Per-project board digest for the note pass (P2.2) to dedupe proposals against: each
   *  project's live (non-archived) runs, newest-first, capped at `perProject`. An id absent
   *  from the registry, a missing root, or an unreadable `runs.json` degrades to
   *  `{ok: false, reason, entries: []}` for that id — the pass still runs for every OTHER
   *  considered project (Risk: "Prompt explosion and cost" / "One unreadable project blanks
   *  or 500s the board" apply here exactly as they do to `list()`). */
  async digest(
    projectIds: readonly string[],
    perProject: number,
  ): Promise<Record<string, WorkspaceRunDigestProject>> {
    const cap = Math.max(0, perProject);
    const sources = await this.resolveSources();
    const byId = new Map(sources.map((s) => [s.id, s] as const));
    const out: Record<string, WorkspaceRunDigestProject> = {};

    for (const id of projectIds) {
      const source = byId.get(id);
      if (!source) {
        out[id] = { ok: false, reason: 'unknown project', entries: [] };
        continue;
      }
      if (source.status === 'missing') {
        out[id] = { ok: false, reason: 'project root is missing', entries: [] };
        continue;
      }
      const result = await this.readProjectRuns(source.root);
      if (!result.ok) {
        out[id] = { ok: false, reason: result.reason, entries: [] };
        continue;
      }
      const entries = result.runs
        .filter((r) => r.archived !== true)
        .slice(0, cap)
        .map((r) => ({ id: r.id, title: r.titleSummary ?? r.title, status: r.status, createdAt: r.createdAt }));
      out[id] = { ok: true, entries };
    }

    return out;
  }
}
