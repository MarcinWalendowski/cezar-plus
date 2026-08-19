import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  reportApproveResponseSchema,
  reportDetailResponseSchema,
  reportDismissResponseSchema,
  reportProcessPendingResponseSchema,
  reportReopenResponseSchema,
  reportsResponseSchema,
} from '@loki-labs/better-cezar-contract';
import { KnowledgeStore } from '../knowledge/store.ts';
import { readReportTriage, reportsTriagePath } from '../reports-triage.ts';
import { readTodos } from '../todos.ts';
import { WorkspaceReportsIndex } from '../workspace/reports-index.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createWorkspaceReportsRoutes, type ReportsConfig } from './workspace-reports-routes.ts';
import type { Principal, ProjectApiEnv } from './server.ts';

/**
 * `workspace-reports-routes.ts` — the REPORTS family
 * (`.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`, "Reports is a workspace tab"
 * amendment). Ported from the deleted `reports-api.test.ts`, plus the assertions the move itself
 * needs.
 *
 * **Real `KnowledgeStore`s over real fixture repos, one per project.** The mount-sharing this whole
 * change is about only exists in the interaction between several projects and one corpus, so the
 * fixture builds it for real (`sharedMount`) rather than faking a store that returns whatever the
 * test wants. Unit-level store faking lives in `../workspace/reports-index.test.ts`.
 *
 * **`CEZ_HOME` and `CEZ_KB` are pinned in `process.env`, not injected.** The routes read the
 * capability and the triage store off the real process env, exactly as they do in production — a
 * test that injected them would be checking a code path the server never takes.
 *
 * **Every response is parsed through its contract schema, not eyeballed.** `contract-parity` is a
 * compile-time check that the TYPES agree; it cannot see a handler that omits a key at runtime, and
 * `toMatchObject` would not either. Parsing is what closes that gap.
 */

const dirs: string[] = [];
const openStores: KnowledgeStore[] = [];
let envBackup: NodeJS.ProcessEnv;

beforeEach(async () => {
  envBackup = { ...process.env };
  const base = await realpath(tmpdir());
  const home = await mkdtemp(join(base, 'cez-wsreports-home-'));
  dirs.push(home);
  process.env.CEZ_HOME = home;
  process.env.CEZ_KB = '1';
  delete process.env.CEZ_SINGLE_PROJECT;
  delete process.env.CEZ_REPORTS_AUTO;
});

afterEach(async () => {
  process.env = envBackup;
  for (const store of openStores.splice(0)) store.dispose();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  // `realpath(tmpdir())` first, for the reason `knowledge-api.test.ts` documents: macOS `/tmp` is a
  // symlink and the knowledge store realpaths every write target.
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, prefix));
  dirs.push(dir);
  return dir;
}

interface ReportSeed {
  path: string;
  title: string;
  identifier?: string;
  tags?: string[];
  domain?: string;
  updatedAt?: string;
  body?: string;
}

function reportMarkdown(seed: ReportSeed): string {
  return [
    '---',
    `title: ${seed.title}`,
    'type: reference',
    `tags: [${(seed.tags ?? ['user-report']).join(', ')}]`,
    ...(seed.identifier ? [`identifiers: [${seed.identifier}]`] : []),
    ...(seed.domain ? [`domain: ${seed.domain}`] : []),
    ...(seed.updatedAt ? [`updatedAt: ${seed.updatedAt}`] : []),
    '---',
    '',
    seed.body ?? 'The daily digest fires twice.',
    '',
  ].join('\n');
}

interface Fixture {
  app: Hono<ProjectApiEnv>;
  /** Registry id → that project's `.ai/cezar`, for asserting where a todo landed. */
  dataDirs: Record<string, string>;
  appAs(principal: Principal | undefined): Hono<ProjectApiEnv>;
}

/**
 * Build `projectIds.length` fixture repos. When `sharedMount` is true (the default), the report
 * documents are written ONCE into a directory outside every repo and every project mounts it —
 * which is the production shape: the mount is declared in the operator's `~/.cezar/config.json`, so
 * one corpus is resolved by every project. With it false each project gets its own copy under its
 * own knowledge root, which is how a test builds genuinely distinct per-project reports.
 */
async function build(
  options: {
    projectIds?: string[];
    reports?: ReportSeed[];
    sharedMount?: boolean;
    config?: Partial<ReportsConfig>;
    /** Omit the knowledge capability entirely — the flag-off case. */
    knowledgeOff?: boolean;
    principal?: Principal;
  } = {},
): Promise<Fixture> {
  const projectIds = options.projectIds ?? ['proj'];
  const shared = options.sharedMount ?? true;

  let mountPath: string | undefined;
  if (shared) {
    mountPath = join(await tempDir('cez-wsreports-mount-'), 'reports');
    await mkdir(mountPath, { recursive: true });
    for (const seed of options.reports ?? []) {
      await writeFile(join(mountPath, seed.path), reportMarkdown(seed), 'utf8');
    }
  }

  const dataDirs: Record<string, string> = {};
  const sources: { id: string; root: string; status: 'ok'; name: string }[] = [];
  const stores: Record<string, KnowledgeStore> = {};

  for (const id of projectIds) {
    const repoRoot = await tempDir(`cez-wsreports-${id}-`);
    const dataDir = join(repoRoot, '.ai/cezar');
    await mkdir(dataDir, { recursive: true });
    dataDirs[id] = dataDir;
    sources.push({ id, root: repoRoot, status: 'ok', name: id });

    if (shared) {
      // A repo-local mount pointing at the one shared directory. Equivalent, for what this family
      // reads, to the workspace mount production uses — and it keeps the fixture from having to
      // write a `~/.cezar/config.json` that the knowledge layer would then resolve relative to a
      // home this test also uses for the triage store.
      await writeFile(
        join(dataDir, 'config.json'),
        JSON.stringify({ knowledge: { mounts: [{ id: 'reports', path: mountPath }] } }),
        'utf8',
      );
    } else {
      const knowledgeRoot = join(dataDir, 'knowledge', 'reports');
      await mkdir(knowledgeRoot, { recursive: true });
      for (const seed of options.reports ?? []) {
        await writeFile(join(knowledgeRoot, seed.path), reportMarkdown(seed), 'utf8');
      }
    }

    const store = KnowledgeStore.create(repoRoot, dataDir, { disableWatchers: true });
    openStores.push(store);
    await store.initialize();
    stores[id] = store;
  }

  const index = new WorkspaceReportsIndex({
    listProjects: async () => sources,
    contexts: { peek: (id) => (id in stores ? { knowledgeStore: stores[id] } : undefined) },
  });

  const appAs = (principal: Principal | undefined): Hono<ProjectApiEnv> =>
    new Hono<ProjectApiEnv>()
      .use('*', async (c, next) => {
        // Same cast `server.ts` uses to publish the principal, so what the handler reads here is
        // what it reads in the real app rather than a second, friendlier shape.
        if (principal) {
          (c as unknown as Context<{ Variables: { principal: Principal } }>).set('principal', principal);
        }
        await next();
      })
      .route(
        '/api/v1',
        createWorkspaceReportsRoutes({
          contexts: { peek: (id) => (id in stores ? { knowledgeStore: stores[id] } : undefined) },
          reportsIndex: index,
          listProjects: async () => sources,
          reportsConfig: async () => ({
            tags: ['user-report'],
            handledTags: ['status/processed'],
            auto: false,
            routeByDomain: {},
            ...options.config,
          }),
        }),
      ) as unknown as Hono<ProjectApiEnv>;

  if (options.knowledgeOff) delete process.env.CEZ_KB;

  return { app: appAs(options.principal), dataDirs, appAs };
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Parse through the wire schema — a handler that drops a key fails here, which `toMatchObject`
 *  would not catch. */
async function parsed<T>(res: Response, schema: { parse(v: unknown): T }): Promise<T> {
  return schema.parse(await res.json());
}

const SESSION_PRINCIPAL: Principal = {
  kind: 'session',
  userId: 'user-alice',
  orgId: 'org-1',
  teamId: 'team-1',
  role: 'owner',
};

const DIGEST: ReportSeed = {
  path: 'digest.md',
  title: 'Daily digest still fires at 08:00',
  identifier: 'report-2026-08-18-digest',
  updatedAt: '2026-08-18T21:04:00.000Z',
  body: 'I asked to stop the 08:00 digest and keep the 21:00 one.',
};
const DIGEST_KEY = DIGEST.identifier!;

const BASE = '/api/v1/workspace/reports';

// ---------------------------------------------------------------------------------------------
// The move itself
// ---------------------------------------------------------------------------------------------

describe('workspace reports — one corpus, one queue, one decision', () => {
  it('a document resolved by twelve projects is ONE row naming all twelve', async () => {
    const projectIds = Array.from({ length: 12 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const { app } = await build({ projectIds, reports: [DIGEST] });

    const body = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    // The measured bug: 196 reports × 12 projects = 2352 rows, the same questions asked twelve
    // times. `counts.total` is asserted alongside `items` because a dedupe applied only to the page
    // would leave the badges saying 12.
    expect(body.items).toHaveLength(1);
    expect(body.counts.total).toBe(1);
    expect(body.items[0]!.projects).toEqual([...projectIds].sort());
    expect(body.items[0]!.project).toBe('p00');

    // Every project is a health row, and each reports its OWN pre-dedupe count — so these sum to
    // twelve while the queue shows one. That is the fact, not an inconsistency to hide.
    expect(body.projects).toHaveLength(12);
    expect(body.projects.every((p) => p.ok && p.total === 1)).toBe(true);
  });

  it('a decision made once is the decision everywhere, and writes no per-project file', async () => {
    const { app, dataDirs } = await build({ projectIds: ['apex', 'chat', 'cezar'], reports: [DIGEST] });

    await apiRequest(app, `${BASE}/${DIGEST_KEY}/dismiss`, json({ reason: 'duplicate' }));

    // The regression this change exists to prevent. Before the move, this same corpus answered
    // "dismissed" from one project's tab and "pending" from the other eleven, and a second person
    // was asked the same question again — which is what produced two contradicting stores on the
    // box, the second one re-dismissing two reports with reason "test".
    const after = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    expect(after.counts).toEqual({ pending: 0, approved: 0, dismissed: 1, total: 1 });
    expect(after.items[0]!.triage?.reason).toBe('duplicate');

    // One store, and it is the workspace one. Asserted on the FILESYSTEM: a per-project file
    // recreated anywhere is the bug coming back, and nothing about the response would show it.
    expect(JSON.parse(await readFile(reportsTriagePath(process.env), 'utf8'))).toHaveLength(1);
    for (const dataDir of Object.values(dataDirs)) {
      expect(await readdir(dataDir)).not.toContain('reports-triage.json');
    }
  });

  it('the project filter is MEMBERSHIP, so a shared report is visible from every project', async () => {
    const { app } = await build({ projectIds: ['a', 'b', 'c'], reports: [DIGEST] });

    for (const id of ['a', 'b', 'c']) {
      const view = await parsed(await apiRequest(app, `${BASE}?project=${id}`), reportsResponseSchema);
      // Filtering on the CANONICAL project alone would show this to `a` and hide it from `b` and
      // `c` — reintroducing exactly the per-project blindness the tab moved to escape. `a` passing
      // is not evidence; `b` and `c` are.
      expect(view.items.map((i) => i.key), id).toEqual([DIGEST_KEY]);
    }
    const none = await parsed(await apiRequest(app, `${BASE}?project=nope`), reportsResponseSchema);
    expect(none.items).toEqual([]);
    // …and the badge counts survive the project filter, like every other filter.
    expect(none.counts.total).toBe(1);
  });

  it('genuinely different reports in different projects are separate rows', async () => {
    // The negative control for the dedupe: with `sharedMount: false` each project has its own copy
    // of the corpus, so the SAME identifiers appear twice — and they still collapse to one row per
    // report, never one row for everything.
    const { app } = await build({
      projectIds: ['a', 'b'],
      sharedMount: false,
      reports: [DIGEST, { path: 'b.md', title: 'Second report', identifier: 'r-b' }],
    });
    const body = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    expect(body.items.map((i) => i.key).sort()).toEqual(['r-b', DIGEST_KEY].sort());
    expect(body.items.every((i) => i.projects.length === 2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The gate — knowledge only, deliberately NOT workspaceViews
// ---------------------------------------------------------------------------------------------

describe('workspace reports — the capability gate', () => {
  it('CEZ_KB off: both GETs answer 200 with the schema-valid empty payload, never 404', async () => {
    const { app } = await build({ reports: [DIGEST], knowledgeOff: true });

    const list = await apiRequest(app, BASE);
    expect(list.status).toBe(200);
    expect(await parsed(list, reportsResponseSchema)).toEqual({
      enabled: false,
      items: [],
      counts: { pending: 0, approved: 0, dismissed: 0, total: 0 },
      truncated: false,
      projects: [],
    });

    const detail = await apiRequest(app, `${BASE}/anything`);
    expect(detail.status).toBe(200);
    expect(await parsed(detail, reportDetailResponseSchema)).toEqual({ enabled: false, item: null, body: '' });
  });

  it('CEZ_KB off: every mutator answers 409 naming the flag, never 404', async () => {
    const { app } = await build({ reports: [DIGEST], knowledgeOff: true });
    for (const [path, init] of [
      [`${BASE}/k/approve`, json({})],
      [`${BASE}/k/dismiss`, json({ reason: 'no' })],
      [`${BASE}/k/reopen`, { method: 'POST' } as RequestInit],
      [`${BASE}/process-pending`, { method: 'POST' } as RequestInit],
    ] as const) {
      const res = await apiRequest(app, path, init);
      expect(res.status, path).toBe(409);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('CEZ_KB=1') });
    }
  });

  it('CEZ_SINGLE_PROJECT=1 (workspaceViews false) still serves the real queue', async () => {
    const { app } = await build({ reports: [DIGEST] });
    process.env.CEZ_SINGLE_PROJECT = '1';

    // The regression this family is deliberately designed around. Its workspace-KNOWLEDGE sibling
    // ANDs `workspaceViews` into the gate, which is false here — copying that would delete reports
    // outright on a single-project install, since this is now the ONLY reports surface. A main path
    // gated on a flag nobody sets fails as silence rather than as an error.
    const body = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    expect(body.enabled).toBe(true);
    expect(body.items.map((i) => i.key)).toEqual([DIGEST_KEY]);

    // Mutators too — a read-only "works" would still leave the tab unusable.
    const res = await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, json({}));
    expect(res.status).toBe(200);
  });

  it('CEZ_WORKSPACE_VIEWS=0 still serves the real queue', async () => {
    const { app } = await build({ reports: [DIGEST] });
    process.env.CEZ_WORKSPACE_VIEWS = '0';
    const body = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    expect(body.enabled).toBe(true);
    expect(body.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The list is a join over the knowledge base (ported)
// ---------------------------------------------------------------------------------------------

describe('workspace reports — the list is a join over the knowledge base', () => {
  it('a tagged document with no triage row reads as pending, with no write anywhere', async () => {
    const { app, dataDirs } = await build({ reports: [DIGEST] });
    const body = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    expect(body.enabled).toBe(true);
    expect(body.counts).toEqual({ pending: 1, approved: 0, dismissed: 0, total: 1 });
    expect(body.items[0]).toMatchObject({
      key: DIGEST_KEY,
      title: 'Daily digest still fires at 08:00',
      status: 'pending',
      filedAt: '2026-08-18T21:04:00.000Z',
      project: 'proj',
      projects: ['proj'],
    });
    expect(body.items[0]?.triage).toBeUndefined();
    // The whole point of deriving pending: listing reports creates no triage file and no todos.
    await expect(readFile(reportsTriagePath(process.env), 'utf8')).rejects.toThrow();
    expect(await readTodos(dataDirs.proj!)).toEqual([]);
  });

  it('NEGATIVE CONTROL: an untagged document is not a report — invisible, 404 to every mutator', async () => {
    const { app } = await build({
      reports: [DIGEST, { path: 'note.md', title: 'An ordinary note', identifier: 'note-1', tags: ['decision'] }],
    });
    const body = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    // If the tag filter were absent this would be 2 — and every assertion in this file about
    // counts, approve and dismiss would still pass, which is exactly why this control exists.
    expect(body.counts.total).toBe(1);
    expect(body.items.map((i) => i.key)).toEqual([DIGEST_KEY]);

    for (const [path, init] of [
      [`${BASE}/note-1`, undefined],
      [`${BASE}/note-1/approve`, json({})],
      [`${BASE}/note-1/dismiss`, json({ reason: 'x' })],
      [`${BASE}/note-1/reopen`, { method: 'POST' } as RequestInit],
    ] as const) {
      expect((await apiRequest(app, path, init)).status, path).toBe(404);
    }
  });

  it('NEGATIVE CONTROL: a triage row filed under a DIFFERENT key leaves the report pending', async () => {
    const { app } = await build({ reports: [DIGEST] });
    await writeFile(
      reportsTriagePath(process.env),
      JSON.stringify([
        { key: 'some-other-report', keyKind: 'identifier', status: 'approved', at: '2026-08-19T00:00:00.000Z' },
      ]),
      'utf8',
    );
    const body = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    // A join that keyed on "does the store hold any row" rather than on THIS report's key would
    // read approved here. The store is not empty, so this cannot pass by the file being missing.
    expect(body.items[0]?.status).toBe('pending');
    expect(body.counts).toEqual({ pending: 1, approved: 0, dismissed: 0, total: 1 });
  });

  it('a report whose own document says it was already handled opens as approved, not pending', async () => {
    const { app } = await build({
      reports: [
        DIGEST,
        { path: 'old.md', title: 'Handled by the old tracker', identifier: 'r-old', tags: ['user-report', 'status/processed'] },
      ],
    });
    const body = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    // The reason this exists: 191 of the 193 reports in the real corpus carry `status/processed`,
    // and without it the queue opens on all 193.
    expect(body.counts).toEqual({ pending: 1, approved: 1, dismissed: 0, total: 2 });
    const old = body.items.find((i) => i.key === 'r-old')!;
    expect(old.status).toBe('approved');
    // …and it is NOT presented as somebody's decision: no row, and the source says where it came
    // from. A client showing "approved by" here would be inventing a person.
    expect(old.statusSource).toBe('document');
    expect(old.triage).toBeUndefined();
    expect(body.items.find((i) => i.key === DIGEST_KEY)?.statusSource).toBe('default');
    await expect(readFile(reportsTriagePath(process.env), 'utf8')).rejects.toThrow();
  });

  it('an automatic pass never converts a document-handled report', async () => {
    const { app, dataDirs } = await build({
      reports: [
        DIGEST,
        { path: 'old.md', title: 'Handled by the old tracker', identifier: 'r-old', tags: ['user-report', 'status/processed'] },
      ],
      config: { auto: true },
    });
    const body = await parsed(
      await apiRequest(app, `${BASE}/process-pending`, { method: 'POST' }),
      reportProcessPendingResponseSchema,
    );
    // One todo, not two. `process-pending` shares the list's derivation rather than keying on
    // "has no triage row", which is exactly the 191-task difference on the real corpus.
    expect(body.outcomes.map((o) => o.key)).toEqual([DIGEST_KEY]);
    expect(await readTodos(dataDirs.proj!)).toHaveLength(1);
    expect((await readReportTriage()).has('r-old')).toBe(false);
  });

  it('a triage decision overrides the document, and reopen falls back to it', async () => {
    const { app } = await build({
      reports: [{ path: 'old.md', title: 'Handled', identifier: 'r-old', tags: ['user-report', 'status/processed'] }],
    });
    const dismissed = await parsed(
      await apiRequest(app, `${BASE}/r-old/dismiss`, json({ reason: 'not worth it' })),
      reportDismissResponseSchema,
    );
    expect(dismissed.item.status).toBe('dismissed');
    expect(dismissed.item.statusSource).toBe('triage');

    const reopened = await parsed(
      await apiRequest(app, `${BASE}/r-old/reopen`, { method: 'POST' }),
      reportReopenResponseSchema,
    );
    // Reopen deletes the ROW, so the derivation falls back to the document — which still says
    // handled. It does not go to pending, and claiming it did would be a lie about the corpus.
    expect(reopened.item.status).toBe('approved');
    expect(reopened.item.statusSource).toBe('document');
  });

  it('an explicit empty handledTags puts every report back in the queue', async () => {
    const { app } = await build({
      reports: [{ path: 'old.md', title: 'Handled', identifier: 'r-old', tags: ['user-report', 'status/processed'] }],
      config: { handledTags: [] },
    });
    const body = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    // The opt-out is respected as the opt-out it reads like, not quietly replaced by the default.
    expect(body.items[0]).toMatchObject({ status: 'pending', statusSource: 'default' });
  });

  it('a report with no identifier is keyed on the catalog id, and the row says so', async () => {
    const { app } = await build({ reports: [{ path: 'anon.md', title: 'No identifier here' }] });
    const list = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    const key = list.items[0]!.key;
    expect(key).toBe(list.items[0]!.docId);

    const approved = await parsed(
      await apiRequest(app, `${BASE}/${key}/approve`, json({})),
      reportApproveResponseSchema,
    );
    // `keyKind` is what makes the weaker key visible instead of assumed — and it matters MORE now
    // that one store spans every project.
    expect(approved.item.triage?.keyKind).toBe('catalog-id');
    expect((await readReportTriage()).get(key)?.keyKind).toBe('catalog-id');
  });

  it('GET /workspace/reports/:key carries the document body; an unknown key 404s', async () => {
    const { app } = await build({ reports: [DIGEST] });
    const detail = await parsed(await apiRequest(app, `${BASE}/${DIGEST_KEY}`), reportDetailResponseSchema);
    expect(detail.enabled).toBe(true);
    expect(detail.body).toContain('I asked to stop the 08:00 digest');
    expect((await apiRequest(app, `${BASE}/nope`)).status).toBe(404);
  });

  it('counts describe the whole set and are unchanged by any filter', async () => {
    const { app } = await build({
      reports: [
        DIGEST,
        { path: 'b.md', title: 'B', identifier: 'r-b', updatedAt: '2026-08-17T00:00:00.000Z' },
        { path: 'c.md', title: 'C', identifier: 'r-c', updatedAt: '2026-08-16T00:00:00.000Z' },
      ],
    });
    await apiRequest(app, `${BASE}/r-b/approve`, json({}));
    await apiRequest(app, `${BASE}/r-c/dismiss`, json({ reason: 'duplicate' }));

    const all = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    expect(all.counts).toEqual({ pending: 1, approved: 1, dismissed: 1, total: 3 });
    // Pending sorts first regardless of filed date — this is a queue, not a catalog.
    expect(all.items[0]?.status).toBe('pending');

    // A filtered count would make the tab badges disagree with the tabs. `?status=pending` alone
    // cannot show that: a `pending` count that wrongly honoured the filter would STILL be 1 there,
    // so that assertion passes on the bug. Asking for a DIFFERENT status than the one being counted
    // is what makes the claim testable — every count must survive every filter.
    for (const status of ['pending', 'approved', 'dismissed'] as const) {
      const view = await parsed(await apiRequest(app, `${BASE}?status=${status}`), reportsResponseSchema);
      expect(view.counts, status).toEqual({ pending: 1, approved: 1, dismissed: 1, total: 3 });
      expect(view.items.map((i) => i.status), status).toEqual([status]);
    }
    const byDomain = await parsed(await apiRequest(app, `${BASE}?domain=nothing`), reportsResponseSchema);
    expect(byDomain.items).toEqual([]);
    expect(byDomain.counts).toEqual({ pending: 1, approved: 1, dismissed: 1, total: 3 });

    const paged = await parsed(await apiRequest(app, `${BASE}?limit=1`), reportsResponseSchema);
    expect(paged.items).toHaveLength(1);
    expect(paged.truncated).toBe(true);
    expect((await parsed(await apiRequest(app, `${BASE}?limit=9`), reportsResponseSchema)).truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Approve / dismiss / reopen / process-pending (ported)
// ---------------------------------------------------------------------------------------------

describe('workspace reports — approve mints exactly one todo', () => {
  it('approve writes a todo and a triage row, and the report leaves the pending queue', async () => {
    const { app, dataDirs } = await build({ reports: [DIGEST] });
    const res = await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, json({ priority: 'high' }));
    expect(res.status).toBe(200);
    const body = await parsed(res, reportApproveResponseSchema);

    expect(body.alreadyApproved).toBe(false);
    expect(body.item.status).toBe('approved');
    expect(body.todo.summary).toBe('Daily digest still fires at 08:00');
    expect(body.todo.priority).toBe('high');
    expect(body.todo.whatToDo).toContain('I asked to stop the 08:00 digest');
    // The todo carries the report key, which is what makes a second approve idempotent.
    expect(body.todo.context).toContain(`report-key: ${DIGEST_KEY}`);

    const todos = await readTodos(dataDirs.proj!);
    expect(todos).toHaveLength(1);
    expect(todos[0]?.status).toBe('todo');

    expect((await readReportTriage()).get(DIGEST_KEY)).toMatchObject({
      status: 'approved',
      todoId: body.todo.id,
      todoProjectId: 'proj',
    });

    const list = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    expect(list.counts).toEqual({ pending: 0, approved: 1, dismissed: 0, total: 1 });
  });

  it('a second approve returns the SAME todo and keeps the first approval timestamp', async () => {
    const { app, dataDirs } = await build({ reports: [DIGEST] });
    const first = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, json({})),
      reportApproveResponseSchema,
    );
    const second = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, json({})),
      reportApproveResponseSchema,
    );

    expect(second.alreadyApproved).toBe(true);
    expect(second.todo.id).toBe(first.todo.id);
    expect(second.item.triage?.at).toBe(first.item.triage?.at);
    // One report, one todo — the property the whole idempotency argument is about.
    expect(await readTodos(dataDirs.proj!)).toHaveLength(1);
  });

  it('the routing map decides which project’s inbox an approval mints into', async () => {
    const { app, dataDirs } = await build({
      projectIds: ['first', 'beside-repo'],
      reports: [{ ...DIGEST, domain: 'beside' }],
      config: { routeByDomain: { beside: 'beside-repo' } },
    });
    const body = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, { method: 'POST' }),
      reportApproveResponseSchema,
    );
    // The cross-project answer the per-project design claimed did not exist. `first` is the
    // canonical project (registry order), so a fallback-only implementation would file it there —
    // asserting BOTH inboxes is what tells the two apart.
    expect(body.item.triage?.todoProjectId).toBe('beside-repo');
    expect(await readTodos(dataDirs['beside-repo']!)).toHaveLength(1);
    expect(await readTodos(dataDirs.first!)).toEqual([]);
  });

  it('an unmapped domain mints into the row’s canonical project', async () => {
    const { app, dataDirs } = await build({
      projectIds: ['first', 'second'],
      reports: [{ ...DIGEST, domain: 'grocey' }],
      config: { routeByDomain: { beside: 'elsewhere' } },
    });
    const body = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, json({})),
      reportApproveResponseSchema,
    );
    expect(body.item.triage?.todoProjectId).toBe('first');
    expect(await readTodos(dataDirs.second!)).toEqual([]);
  });

  it('a routing target that resolves to nothing is refused, and writes nothing', async () => {
    const { app, dataDirs } = await build({
      reports: [{ ...DIGEST, domain: 'beside' }],
      config: { routeByDomain: { beside: 'some-other-project' } },
    });
    const refused = await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, { method: 'POST' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining('some-other-project') });
    // Refused means refused: no todo, no triage row.
    expect(await readTodos(dataDirs.proj!)).toEqual([]);
    expect(await readReportTriage()).toEqual(new Map());
  });

  it('an explicit todoProjectId overrides the routing map', async () => {
    const { app, dataDirs } = await build({
      projectIds: ['first', 'second'],
      reports: [{ ...DIGEST, domain: 'beside' }],
      config: { routeByDomain: { beside: 'first' } },
    });
    const body = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, json({ todoProjectId: 'second' })),
      reportApproveResponseSchema,
    );
    expect(body.item.triage?.todoProjectId).toBe('second');
    expect(await readTodos(dataDirs.first!)).toEqual([]);
  });
});

describe('workspace reports — dismiss requires a reason', () => {
  it('a bodyless or empty-reason dismiss is 400 and writes nothing', async () => {
    const { app } = await build({ reports: [DIGEST] });
    const path = `${BASE}/${DIGEST_KEY}/dismiss`;

    expect((await apiRequest(app, path, { method: 'POST' })).status).toBe(400);
    expect((await apiRequest(app, path, json({}))).status).toBe(400);
    expect((await apiRequest(app, path, json({ reason: '   ' }))).status).toBe(400);
    // A dismissal with no reason is a report quietly lost, so nothing may be recorded.
    expect(await readReportTriage()).toEqual(new Map());
  });

  it('a dismissal records the reason and leaves the pending queue', async () => {
    const { app, dataDirs } = await build({ reports: [DIGEST] });
    const body = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/dismiss`, json({ reason: 'already fixed' })),
      reportDismissResponseSchema,
    );
    expect(body.item.status).toBe('dismissed');
    expect(body.item.triage?.reason).toBe('already fixed');
    expect((await readReportTriage()).get(DIGEST_KEY)?.reason).toBe('already fixed');
    // Dismissing never mints work.
    expect(await readTodos(dataDirs.proj!)).toEqual([]);
  });

  it('dismissing an approved report keeps the todo pointer', async () => {
    const { app, dataDirs } = await build({ reports: [DIGEST] });
    const approved = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, json({})),
      reportApproveResponseSchema,
    );
    const dismissed = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/dismiss`, json({ reason: 'wont fix' })),
      reportDismissResponseSchema,
    );
    // The work exists; losing the link would make that todo unattributable.
    expect(dismissed.item.triage?.todoId).toBe(approved.todo.id);
    expect(await readTodos(dataDirs.proj!)).toHaveLength(1);
  });
});

describe('workspace reports — reopen returns a report to pending', () => {
  it('reopen deletes the row, names the orphaned todo, and does NOT delete it', async () => {
    const { app, dataDirs } = await build({ reports: [DIGEST] });
    const approved = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, json({})),
      reportApproveResponseSchema,
    );
    const body = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/reopen`, { method: 'POST' }),
      reportReopenResponseSchema,
    );

    expect(body.item.status).toBe('pending');
    expect(body.item.triage).toBeUndefined();
    expect(body.orphanedTodoId).toBe(approved.todo.id);
    expect(body.orphanedTodoProjectId).toBe('proj');
    // By now the todo may be started or done — deleting it silently is not reopen's call.
    expect(await readTodos(dataDirs.proj!)).toHaveLength(1);
    expect(await readReportTriage()).toEqual(new Map());
  });

  it('reopening a never-triaged report is a no-op with no orphan named', async () => {
    const { app } = await build({ reports: [DIGEST] });
    const body = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/reopen`, { method: 'POST' }),
      reportReopenResponseSchema,
    );
    expect(body.item.status).toBe('pending');
    expect(body.orphanedTodoId).toBeUndefined();
  });

  it('a reopened report can be approved again, and reuses the todo the first approve minted', async () => {
    const { app, dataDirs } = await build({ reports: [DIGEST] });
    const first = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, json({})),
      reportApproveResponseSchema,
    );
    await apiRequest(app, `${BASE}/${DIGEST_KEY}/reopen`, { method: 'POST' });
    const again = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, json({})),
      reportApproveResponseSchema,
    );
    // The idempotency is anchored on the TODO, not on the triage row — so a reopen/re-approve round
    // trip still leaves exactly one todo rather than a duplicate.
    expect(again.todo.id).toBe(first.todo.id);
    expect(again.alreadyApproved).toBe(true);
    expect(await readTodos(dataDirs.proj!)).toHaveLength(1);
  });
});

describe('workspace reports — automatic processing', () => {
  it('process-pending is 409 unless auto mode is explicitly on', async () => {
    const { app, dataDirs } = await build({ reports: [DIGEST] });
    const res = await apiRequest(app, `${BASE}/process-pending`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('CEZ_REPORTS_AUTO=1') });
    expect(await readTodos(dataDirs.proj!)).toEqual([]);
  });

  it('with auto on it converts every pending report, reports each outcome, and is idempotent', async () => {
    const { app, dataDirs } = await build({
      reports: [DIGEST, { path: 'b.md', title: 'B', identifier: 'r-b' }, { path: 'c.md', title: 'C', identifier: 'r-c' }],
      config: { auto: true },
    });
    // One is already dismissed by hand: auto mode converts PENDING reports, and must not overrule a
    // decision a person already made.
    await apiRequest(app, `${BASE}/r-c/dismiss`, json({ reason: 'noise' }));

    const first = await parsed(
      await apiRequest(app, `${BASE}/process-pending`, { method: 'POST' }),
      reportProcessPendingResponseSchema,
    );
    expect(first.converted).toBe(2);
    expect(first.failed).toBe(0);
    expect(first.outcomes.map((o) => o.key).sort()).toEqual(['r-b', DIGEST_KEY].sort());
    expect(first.outcomes.every((o) => o.ok && o.todoId)).toBe(true);

    const rows = await readReportTriage();
    expect(rows.get('r-b')?.auto).toBe(true);
    // The hand dismissal survived untouched — no `auto` flag, reason intact.
    expect(rows.get('r-c')).toMatchObject({ status: 'dismissed', reason: 'noise' });
    expect(rows.get('r-c')?.auto).toBeUndefined();
    expect(await readTodos(dataDirs.proj!)).toHaveLength(2);

    const second = await parsed(
      await apiRequest(app, `${BASE}/process-pending`, { method: 'POST' }),
      reportProcessPendingResponseSchema,
    );
    // Nothing is pending any more, so a second pass converts nothing and mints nothing.
    expect(second).toEqual({ outcomes: [], converted: 0, failed: 0 });
    expect(await readTodos(dataDirs.proj!)).toHaveLength(2);
  });

  it('a report whose routing target cannot be resolved is reported as failed, not dropped', async () => {
    const { app } = await build({
      reports: [{ ...DIGEST, domain: 'beside' }, { path: 'b.md', title: 'B', identifier: 'r-b' }],
      config: { auto: true, routeByDomain: { beside: 'nowhere' } },
    });
    const body = await parsed(
      await apiRequest(app, `${BASE}/process-pending`, { method: 'POST' }),
      reportProcessPendingResponseSchema,
    );
    expect(body.converted).toBe(1);
    expect(body.failed).toBe(1);
    // A batch must never let a caller infer completeness from a count: the failure is named.
    const failed = body.outcomes.find((o) => !o.ok);
    expect(failed?.key).toBe(DIGEST_KEY);
    expect(failed?.error).toContain('nowhere');
    // The failed one stays pending, so a later pass (or a person) still sees it.
    expect((await readReportTriage()).has(DIGEST_KEY)).toBe(false);
    const list = await parsed(await apiRequest(app, BASE), reportsResponseSchema);
    expect(list.counts).toEqual({ pending: 1, approved: 1, dismissed: 0, total: 2 });
  });

  it('every converted todo carries the body, so one pass does not lose them', async () => {
    // The regression guard for the single-fan-out body resolver: `process-pending` serves bodies
    // from the list it already built rather than re-scanning per report. An implementation that
    // wired that up wrongly would mint todos with the TITLE as `whatToDo` and every other assertion
    // in this block would still pass.
    const { app, dataDirs } = await build({
      reports: [
        { path: 'a.md', title: 'A', identifier: 'r-a', body: 'the first body' },
        { path: 'b.md', title: 'B', identifier: 'r-b', body: 'the second body' },
      ],
      config: { auto: true },
    });
    await apiRequest(app, `${BASE}/process-pending`, { method: 'POST' });
    const todos = await readTodos(dataDirs.proj!);
    expect(todos.map((t) => t.whatToDo).sort()).toEqual(['the first body', 'the second body']);
  });
});

// ---------------------------------------------------------------------------------------------
// `by` (ported)
// ---------------------------------------------------------------------------------------------

describe('workspace reports — `by`: who triaged, when there is a signed-in user to name', () => {
  it('a signed-in approval and dismissal are attributed', async () => {
    const { app } = await build({ reports: [DIGEST], principal: SESSION_PRINCIPAL });

    const approved = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, json({})),
      reportApproveResponseSchema,
    );
    // On the WIRE, not only in the store: a client that wants to show an author must be able to.
    expect(approved.item.triage?.by).toBe('user-alice');
    expect((await readReportTriage()).get(DIGEST_KEY)?.by).toBe('user-alice');

    const dismissed = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/dismiss`, json({ reason: 'duplicate' })),
      reportDismissResponseSchema,
    );
    expect(dismissed.item.triage?.by).toBe('user-alice');
  });

  it('an unauthenticated deployment stamps NOBODY — the machine is not a person', async () => {
    // The negative control that matters: `local` is a real principal on the context, so a handler
    // that stamped `principal.userId` unconditionally would pass the test above and fail here.
    const { app } = await build({
      reports: [DIGEST],
      principal: { kind: 'local', userId: 'local-user', orgId: null, teamId: null, role: 'owner' },
    });
    const body = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, json({})),
      reportApproveResponseSchema,
    );
    expect(body.item.triage?.by).toBeUndefined();
    expect((await readReportTriage()).get(DIGEST_KEY)?.by).toBeUndefined();
    // The rest of the row is unaffected — this is about the author field only.
    expect(body.item.triage).toMatchObject({ status: 'approved', todoProjectId: 'proj' });
  });

  it('no principal on the context at all leaves `by` absent rather than throwing', async () => {
    const { app } = await build({ reports: [DIGEST] });
    const body = await parsed(
      await apiRequest(app, `${BASE}/${DIGEST_KEY}/approve`, json({})),
      reportApproveResponseSchema,
    );
    expect(body.item.triage?.by).toBeUndefined();
  });

  it('re-approving keeps the FIRST approver; dismissing overwrites with the one who dismissed', async () => {
    // Two apps over ONE workspace store, so the second request is a different signed-in user
    // against the same file — which is the only way to tell "kept" from "never written twice", and
    // is now also the two-cockpit-tabs case that produced the contradiction on the box.
    const { appAs } = await build({ reports: [DIGEST] });
    const alice = appAs(SESSION_PRINCIPAL);
    const bob = appAs({ ...SESSION_PRINCIPAL, userId: 'user-bob' });

    const first = await parsed(
      await apiRequest(alice, `${BASE}/${DIGEST_KEY}/approve`, json({})),
      reportApproveResponseSchema,
    );
    expect(first.item.triage?.by).toBe('user-alice');
    const firstAt = first.item.triage?.at;

    const again = await parsed(
      await apiRequest(bob, `${BASE}/${DIGEST_KEY}/approve`, json({})),
      reportApproveResponseSchema,
    );
    expect(again.alreadyApproved).toBe(true);
    // Bob clicking approve does not rewrite the record of who approved it, or when.
    expect(again.item.triage?.by).toBe('user-alice');
    expect(again.item.triage?.at).toBe(firstAt);

    const dropped = await parsed(
      await apiRequest(bob, `${BASE}/${DIGEST_KEY}/dismiss`, json({ reason: 'not a bug' })),
      reportDismissResponseSchema,
    );
    // A dismissal IS a fresh decision, so its owner is Bob — and the todo pointer survives.
    expect(dropped.item.triage?.by).toBe('user-bob');
    expect(dropped.item.triage?.todoId).toBe(first.todo.id);
    expect((await readReportTriage()).get(DIGEST_KEY)?.by).toBe('user-bob');
  });

  it('an automatic pass records who ran it AND that it was automatic', async () => {
    const { app } = await build({ reports: [DIGEST], config: { auto: true }, principal: SESSION_PRINCIPAL });
    const body = await parsed(
      await apiRequest(app, `${BASE}/process-pending`, { method: 'POST' }),
      reportProcessPendingResponseSchema,
    );
    expect(body.converted).toBe(1);
    const row = (await readReportTriage()).get(DIGEST_KEY);
    // Both, not either: `by` alone would read as a hand decision, `auto` alone loses who asked.
    expect(row?.by).toBe('user-alice');
    expect(row?.auto).toBe(true);
  });
});
