import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  reportApproveResponseSchema,
  reportDetailResponseSchema,
  reportDismissResponseSchema,
  reportProcessPendingResponseSchema,
  reportReopenResponseSchema,
  reportsResponseSchema,
} from '@loki-labs/better-cezar-contract';
import type { AutomationStore } from '../automations/store.ts';
import { KnowledgeStore } from '../knowledge/store.ts';
import { RunStore } from '../runs/store.ts';
import { readTodos } from '../todos.ts';
import { readReportTriage } from '../reports-triage.ts';
import type { RunManager } from '../workflows/run.ts';
import { createReportsRoutes, type ReportsConfig } from './reports-routes.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import type { Principal, ProjectApiEnv, ProjectContext } from './server.ts';

/**
 * `reports-routes.ts` — the REPORTS family
 * (`.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`, Verification).
 *
 * Mounts the family behind a fixed `c.get('project')` rather than going through `createApp()`, the
 * same choice `knowledge-api.test.ts` makes and for the same reason: these handlers read everything
 * off the project context, so a workspace registry adds nothing but setup.
 *
 * **Every response is parsed through its contract schema, not eyeballed.** `contract-parity` is a
 * compile-time check that the TYPES agree; it cannot see a handler that omits a key at runtime, and
 * `toMatchObject` would not either. Parsing is what closes that gap.
 */

const dirs: string[] = [];
const openKnowledgeStores: KnowledgeStore[] = [];
const openRunStores: RunStore[] = [];

afterEach(async () => {
  for (const store of openKnowledgeStores.splice(0)) store.dispose();
  for (const store of openRunStores.splice(0)) store.flush();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// `realpath(tmpdir())` first, for the reason `knowledge-api.test.ts` documents: macOS `/tmp` is a
// symlink and the knowledge store realpaths every write target.
async function tempDir(prefix: string): Promise<string> {
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
  const lines = [
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
  ];
  return lines.join('\n');
}

async function buildProject(
  options: {
    withKnowledge?: boolean;
    reports?: ReportSeed[];
    config?: Partial<ReportsConfig>;
    /** Set on the context the way `server.ts`'s `/api/*` middleware does, for the `by` tests.
     *  Omitted in every other test — which is itself the "no middleware, no author" case. */
    principal?: Principal;
  } = {},
): Promise<{ project: ProjectContext; app: Hono<ProjectApiEnv>; dataDir: string }> {
  const repoRoot = await tempDir('cez-reports-api-');
  const dataDir = join(repoRoot, '.ai/cezar');
  await mkdir(dataDir, { recursive: true });
  const runStore = RunStore.open(dataDir);
  openRunStores.push(runStore);

  let knowledgeStore: KnowledgeStore | undefined;
  if (options.withKnowledge ?? true) {
    const knowledgeRoot = join(dataDir, 'knowledge', 'reports');
    await mkdir(knowledgeRoot, { recursive: true });
    for (const seed of options.reports ?? []) {
      await writeFile(join(knowledgeRoot, seed.path), reportMarkdown(seed), 'utf8');
    }
    knowledgeStore = KnowledgeStore.create(repoRoot, dataDir, { disableWatchers: true });
    openKnowledgeStores.push(knowledgeStore);
    await knowledgeStore.initialize();
  }

  const project: ProjectContext = {
    id: 'proj',
    root: repoRoot,
    dataDir,
    store: runStore,
    manager: {} as RunManager,
    automationStore: {} as AutomationStore,
    knowledgeStore,
    launchKey: 'test-launch-key',
  };

  const app = new Hono<ProjectApiEnv>()
    .use('*', async (c, next) => {
      c.set('project', project);
      // Same cast `server.ts` uses to publish the principal, so what the handler reads here is what
      // it reads in the real app rather than a second, friendlier shape.
      if (options.principal) {
        (c as unknown as Context<{ Variables: { principal: Principal } }>).set('principal', options.principal);
      }
      await next();
    })
    .route(
      '/api/v1',
      createReportsRoutes({
        reportsConfig: async () => ({
          tags: ['user-report'],
          handledTags: ['status/processed'],
          auto: false,
          routeByDomain: {},
          ...options.config,
        }),
      }),
    ) as unknown as Hono<ProjectApiEnv>;

  return { project, app, dataDir };
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

describe('reports routes — flag off (no knowledgeStore on the project context)', () => {
  it('both GETs answer 200 with the schema-valid empty payload, never 404', async () => {
    const { app } = await buildProject({ withKnowledge: false });

    const list = await apiRequest(app, '/api/v1/reports');
    expect(list.status).toBe(200);
    expect(await parsed(list, reportsResponseSchema)).toEqual({
      enabled: false,
      items: [],
      counts: { pending: 0, approved: 0, dismissed: 0, total: 0 },
      truncated: false,
    });

    const detail = await apiRequest(app, '/api/v1/reports/anything');
    expect(detail.status).toBe(200);
    expect(await parsed(detail, reportDetailResponseSchema)).toEqual({ enabled: false, item: null, body: '' });
  });

  it('every mutator answers 409 naming the flag, never 404', async () => {
    const { app } = await buildProject({ withKnowledge: false });
    for (const [path, init] of [
      ['/api/v1/reports/k/approve', json({})],
      ['/api/v1/reports/k/dismiss', json({ reason: 'no' })],
      ['/api/v1/reports/k/reopen', { method: 'POST' } as RequestInit],
      ['/api/v1/reports/process-pending', { method: 'POST' } as RequestInit],
    ] as const) {
      const res = await apiRequest(app, path, init);
      expect(res.status, path).toBe(409);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('CEZ_KB=1') });
    }
  });
});

describe('reports routes — the list is a join over the knowledge base', () => {
  it('a tagged document with no triage row reads as pending, with no write anywhere', async () => {
    const { app, dataDir } = await buildProject({ reports: [DIGEST] });
    const body = await parsed(await apiRequest(app, '/api/v1/reports'), reportsResponseSchema);
    expect(body.enabled).toBe(true);
    expect(body.counts).toEqual({ pending: 1, approved: 0, dismissed: 0, total: 1 });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      key: 'report-2026-08-18-digest',
      title: 'Daily digest still fires at 08:00',
      status: 'pending',
      filedAt: '2026-08-18T21:04:00.000Z',
    });
    expect(body.items[0]?.triage).toBeUndefined();
    // The whole point of deriving pending: listing reports creates no triage file and no todos.
    await expect(readFile(join(dataDir, 'reports-triage.json'), 'utf8')).rejects.toThrow();
    expect(await readTodos(dataDir)).toEqual([]);
  });

  it('NEGATIVE CONTROL: an untagged document is not a report — invisible to the list, 404 to every mutator', async () => {
    const { app } = await buildProject({
      reports: [
        DIGEST,
        { path: 'note.md', title: 'An ordinary note', identifier: 'note-1', tags: ['decision'] },
      ],
    });
    const body = await parsed(await apiRequest(app, '/api/v1/reports'), reportsResponseSchema);
    // If the tag filter were absent this would be 2 — and every assertion in this file about
    // counts, approve and dismiss would still pass, which is exactly why this control exists.
    expect(body.counts.total).toBe(1);
    expect(body.items.map((i) => i.key)).toEqual(['report-2026-08-18-digest']);

    for (const [path, init] of [
      ['/api/v1/reports/note-1', undefined],
      ['/api/v1/reports/note-1/approve', json({})],
      ['/api/v1/reports/note-1/dismiss', json({ reason: 'x' })],
      ['/api/v1/reports/note-1/reopen', { method: 'POST' } as RequestInit],
    ] as const) {
      const res = await apiRequest(app, path, init);
      expect(res.status, path).toBe(404);
    }
  });

  it('NEGATIVE CONTROL: a triage row filed under a DIFFERENT key leaves the report pending', async () => {
    const { app, dataDir } = await buildProject({ reports: [DIGEST] });
    await writeFile(
      join(dataDir, 'reports-triage.json'),
      JSON.stringify([
        { key: 'some-other-report', keyKind: 'identifier', status: 'approved', at: '2026-08-19T00:00:00.000Z' },
      ]),
      'utf8',
    );
    const body = await parsed(await apiRequest(app, '/api/v1/reports'), reportsResponseSchema);
    // A join that keyed on "does the store hold any row" rather than on THIS report's key would
    // read approved here. The store is not empty, so this cannot pass by the file being missing.
    expect(body.items[0]?.status).toBe('pending');
    expect(body.counts).toEqual({ pending: 1, approved: 0, dismissed: 0, total: 1 });
  });

  it('a report whose own document says it was already handled opens as approved, not pending', async () => {
    const { app, dataDir } = await buildProject({
      reports: [
        DIGEST,
        { path: 'old.md', title: 'Handled by the old tracker', identifier: 'r-old', tags: ['user-report', 'status/processed'] },
      ],
    });
    const body = await parsed(await apiRequest(app, '/api/v1/reports'), reportsResponseSchema);
    // The reason this exists: 191 of the 193 reports in the real corpus carry `status/processed`,
    // and without it the queue opens on all 193.
    expect(body.counts).toEqual({ pending: 1, approved: 1, dismissed: 0, total: 2 });
    const old = body.items.find((i) => i.key === 'r-old')!;
    expect(old.status).toBe('approved');
    // …and it is NOT presented as somebody's decision: no row, and the source says where it came
    // from. A client showing "approved by" here would be inventing a person.
    expect(old.statusSource).toBe('document');
    expect(old.triage).toBeUndefined();
    expect(body.items.find((i) => i.key === DIGEST.identifier)?.statusSource).toBe('default');
    // Nothing was written to make that happen.
    await expect(readFile(join(dataDir, 'reports-triage.json'), 'utf8')).rejects.toThrow();
  });

  it('an automatic pass never converts a document-handled report', async () => {
    const { app, dataDir } = await buildProject({
      reports: [
        DIGEST,
        { path: 'old.md', title: 'Handled by the old tracker', identifier: 'r-old', tags: ['user-report', 'status/processed'] },
      ],
      config: { auto: true },
    });
    const body = await parsed(
      await apiRequest(app, '/api/v1/reports/process-pending', { method: 'POST' }),
      reportProcessPendingResponseSchema,
    );
    // One todo, not two. `process-pending` shares the list's derivation rather than keying on
    // "has no triage row", which is exactly the 191-task difference on the real corpus.
    expect(body.outcomes.map((o) => o.key)).toEqual([DIGEST.identifier]);
    expect(await readTodos(dataDir)).toHaveLength(1);
    expect((await readReportTriage(dataDir)).has('r-old')).toBe(false);
  });

  it('a triage decision overrides the document, and reopen falls back to it', async () => {
    const { app } = await buildProject({
      reports: [{ path: 'old.md', title: 'Handled', identifier: 'r-old', tags: ['user-report', 'status/processed'] }],
    });
    const dismissed = await parsed(
      await apiRequest(app, '/api/v1/reports/r-old/dismiss', json({ reason: 'not worth it' })),
      reportDismissResponseSchema,
    );
    expect(dismissed.item.status).toBe('dismissed');
    expect(dismissed.item.statusSource).toBe('triage');

    const reopened = await parsed(
      await apiRequest(app, '/api/v1/reports/r-old/reopen', { method: 'POST' }),
      reportReopenResponseSchema,
    );
    // Reopen deletes the ROW, so the derivation falls back to the document — which still says
    // handled. It does not go to pending, and claiming it did would be a lie about the corpus.
    expect(reopened.item.status).toBe('approved');
    expect(reopened.item.statusSource).toBe('document');
  });

  it('an explicit empty handledTags puts every report back in the queue', async () => {
    const { app } = await buildProject({
      reports: [{ path: 'old.md', title: 'Handled', identifier: 'r-old', tags: ['user-report', 'status/processed'] }],
      config: { handledTags: [] },
    });
    const body = await parsed(await apiRequest(app, '/api/v1/reports'), reportsResponseSchema);
    // The opt-out is respected as the opt-out it reads like, not quietly replaced by the default.
    expect(body.items[0]).toMatchObject({ status: 'pending', statusSource: 'default' });
  });

  it('a report with no identifier is keyed on the catalog id, and the row says so', async () => {
    const { app, dataDir } = await buildProject({
      reports: [{ path: 'anon.md', title: 'No identifier here' }],
    });
    const list = await parsed(await apiRequest(app, '/api/v1/reports'), reportsResponseSchema);
    const key = list.items[0]!.key;
    expect(key).toBe(list.items[0]!.docId);

    const approved = await parsed(
      await apiRequest(app, `/api/v1/reports/${key}/approve`, json({})),
      reportApproveResponseSchema,
    );
    // `keyKind` is what makes the weaker key visible instead of assumed.
    expect(approved.item.triage?.keyKind).toBe('catalog-id');
    expect((await readReportTriage(dataDir)).get(key)?.keyKind).toBe('catalog-id');
  });

  it('GET /reports/:key carries the document body; an unknown key 404s', async () => {
    const { app } = await buildProject({ reports: [DIGEST] });
    const detail = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest'),
      reportDetailResponseSchema,
    );
    expect(detail.enabled).toBe(true);
    expect(detail.body).toContain('I asked to stop the 08:00 digest');
    expect((await apiRequest(app, '/api/v1/reports/nope')).status).toBe(404);
  });

  it('counts describe the whole set and are unchanged by the status filter', async () => {
    const { app } = await buildProject({
      reports: [
        DIGEST,
        { path: 'b.md', title: 'B', identifier: 'r-b', updatedAt: '2026-08-17T00:00:00.000Z' },
        { path: 'c.md', title: 'C', identifier: 'r-c', updatedAt: '2026-08-16T00:00:00.000Z' },
      ],
    });
    await apiRequest(app, '/api/v1/reports/r-b/approve', json({}));
    await apiRequest(app, '/api/v1/reports/r-c/dismiss', json({ reason: 'duplicate' }));

    const all = await parsed(await apiRequest(app, '/api/v1/reports'), reportsResponseSchema);
    expect(all.counts).toEqual({ pending: 1, approved: 1, dismissed: 1, total: 3 });
    // Pending sorts first regardless of filed date — this is a queue, not a catalog.
    expect(all.items[0]?.status).toBe('pending');

    const pendingOnly = await parsed(
      await apiRequest(app, '/api/v1/reports?status=pending'),
      reportsResponseSchema,
    );
    expect(pendingOnly.items.map((i) => i.key)).toEqual(['report-2026-08-18-digest']);
    expect(pendingOnly.counts).toEqual(all.counts);

    // A filtered count would make the tab badges disagree with the tabs. `?status=pending` alone
    // cannot show that: a `pending` count that wrongly honoured the filter would STILL be 1 there,
    // so the assertion above passes on the bug. Asking for a DIFFERENT status than the one being
    // counted is what makes the claim testable — every count must survive every filter.
    for (const status of ['pending', 'approved', 'dismissed'] as const) {
      const view = await parsed(await apiRequest(app, `/api/v1/reports?status=${status}`), reportsResponseSchema);
      expect(view.counts, status).toEqual({ pending: 1, approved: 1, dismissed: 1, total: 3 });
      expect(view.items.map((i) => i.status), status).toEqual([status]);
    }
    const byDomain = await parsed(await apiRequest(app, '/api/v1/reports?domain=nothing'), reportsResponseSchema);
    expect(byDomain.items).toEqual([]);
    expect(byDomain.counts).toEqual({ pending: 1, approved: 1, dismissed: 1, total: 3 });

    const paged = await parsed(await apiRequest(app, '/api/v1/reports?limit=1'), reportsResponseSchema);
    expect(paged.items).toHaveLength(1);
    expect(paged.truncated).toBe(true);
    expect((await parsed(await apiRequest(app, '/api/v1/reports?limit=9'), reportsResponseSchema)).truncated).toBe(
      false,
    );
  });
});

describe('reports routes — approve mints exactly one todo', () => {
  it('approve writes a todo and a triage row, and the report leaves the pending queue', async () => {
    const { app, dataDir } = await buildProject({ reports: [DIGEST] });
    const res = await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/approve', json({ priority: 'high' }));
    expect(res.status).toBe(200);
    const body = await parsed(res, reportApproveResponseSchema);

    expect(body.alreadyApproved).toBe(false);
    expect(body.item.status).toBe('approved');
    expect(body.todo.summary).toBe('Daily digest still fires at 08:00');
    expect(body.todo.priority).toBe('high');
    expect(body.todo.whatToDo).toContain('I asked to stop the 08:00 digest');
    // The todo carries the report key, which is what makes a second approve idempotent.
    expect(body.todo.context).toContain('report-key: report-2026-08-18-digest');

    const todos = await readTodos(dataDir);
    expect(todos).toHaveLength(1);
    expect(todos[0]?.status).toBe('todo');

    const row = (await readReportTriage(dataDir)).get('report-2026-08-18-digest');
    expect(row).toMatchObject({ status: 'approved', todoId: body.todo.id, todoProjectId: 'proj' });

    const list = await parsed(await apiRequest(app, '/api/v1/reports'), reportsResponseSchema);
    expect(list.counts).toEqual({ pending: 0, approved: 1, dismissed: 0, total: 1 });
  });

  it('a second approve returns the SAME todo and keeps the first approval timestamp', async () => {
    const { app, dataDir } = await buildProject({ reports: [DIGEST] });
    const first = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/approve', json({})),
      reportApproveResponseSchema,
    );
    const second = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/approve', json({})),
      reportApproveResponseSchema,
    );

    expect(second.alreadyApproved).toBe(true);
    expect(second.todo.id).toBe(first.todo.id);
    expect(second.item.triage?.at).toBe(first.item.triage?.at);
    // One report, one todo — the property the whole idempotency argument is about.
    expect(await readTodos(dataDir)).toHaveLength(1);
  });

  it('a bodyless approve succeeds (every field is optional) and routes by domain when configured', async () => {
    const { app, dataDir } = await buildProject({
      reports: [{ ...DIGEST, domain: 'beside' }],
      // The domain maps to a project id this fixture cannot resolve — no registry was injected, so
      // the family must say so rather than silently minting into the wrong inbox.
      config: { routeByDomain: { beside: 'some-other-project' } },
    });
    const refused = await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/approve', { method: 'POST' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining('some-other-project') });
    // Refused means refused: no todo, no triage row.
    expect(await readTodos(dataDir)).toEqual([]);
    expect(await readReportTriage(dataDir)).toEqual(new Map());

    const { app: plain } = await buildProject({ reports: [DIGEST] });
    const ok = await apiRequest(plain, '/api/v1/reports/report-2026-08-18-digest/approve', { method: 'POST' });
    expect(ok.status).toBe(200);
  });

  it('an unmapped domain mints into the report’s own project', async () => {
    const { app } = await buildProject({
      reports: [{ ...DIGEST, domain: 'grocey' }],
      config: { routeByDomain: { beside: 'elsewhere' } },
    });
    const body = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/approve', json({})),
      reportApproveResponseSchema,
    );
    expect(body.item.triage?.todoProjectId).toBe('proj');
  });
});

describe('reports routes — dismiss requires a reason', () => {
  it('a bodyless or empty-reason dismiss is 400 and writes nothing', async () => {
    const { app, dataDir } = await buildProject({ reports: [DIGEST] });
    const path = '/api/v1/reports/report-2026-08-18-digest/dismiss';

    expect((await apiRequest(app, path, { method: 'POST' })).status).toBe(400);
    expect((await apiRequest(app, path, json({}))).status).toBe(400);
    expect((await apiRequest(app, path, json({ reason: '   ' }))).status).toBe(400);
    // A dismissal with no reason is a report quietly lost, so nothing may be recorded.
    expect(await readReportTriage(dataDir)).toEqual(new Map());
  });

  it('a dismissal records the reason and leaves the pending queue', async () => {
    const { app, dataDir } = await buildProject({ reports: [DIGEST] });
    const body = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/dismiss', json({ reason: 'already fixed' })),
      reportDismissResponseSchema,
    );
    expect(body.item.status).toBe('dismissed');
    expect(body.item.triage?.reason).toBe('already fixed');
    expect((await readReportTriage(dataDir)).get('report-2026-08-18-digest')?.reason).toBe('already fixed');
    // Dismissing never mints work.
    expect(await readTodos(dataDir)).toEqual([]);
  });

  it('dismissing an approved report keeps the todo pointer', async () => {
    const { app, dataDir } = await buildProject({ reports: [DIGEST] });
    const approved = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/approve', json({})),
      reportApproveResponseSchema,
    );
    const dismissed = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/dismiss', json({ reason: 'wont fix' })),
      reportDismissResponseSchema,
    );
    // The work exists; losing the link would make that todo unattributable.
    expect(dismissed.item.triage?.todoId).toBe(approved.todo.id);
    expect(await readTodos(dataDir)).toHaveLength(1);
  });
});

describe('reports routes — reopen returns a report to pending', () => {
  it('reopen deletes the row, names the orphaned todo, and does NOT delete it', async () => {
    const { app, dataDir } = await buildProject({ reports: [DIGEST] });
    const approved = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/approve', json({})),
      reportApproveResponseSchema,
    );
    const body = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/reopen', { method: 'POST' }),
      reportReopenResponseSchema,
    );

    expect(body.item.status).toBe('pending');
    expect(body.item.triage).toBeUndefined();
    expect(body.orphanedTodoId).toBe(approved.todo.id);
    expect(body.orphanedTodoProjectId).toBe('proj');
    // By now the todo may be started or done — deleting it silently is not reopen's call.
    expect(await readTodos(dataDir)).toHaveLength(1);
    expect(await readReportTriage(dataDir)).toEqual(new Map());
  });

  it('reopening a never-triaged report is a no-op with no orphan named', async () => {
    const { app } = await buildProject({ reports: [DIGEST] });
    const body = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/reopen', { method: 'POST' }),
      reportReopenResponseSchema,
    );
    expect(body.item.status).toBe('pending');
    expect(body.orphanedTodoId).toBeUndefined();
  });

  it('a reopened report can be approved again, and reuses the todo the first approve minted', async () => {
    const { app, dataDir } = await buildProject({ reports: [DIGEST] });
    const path = '/api/v1/reports/report-2026-08-18-digest';
    const first = await parsed(await apiRequest(app, `${path}/approve`, json({})), reportApproveResponseSchema);
    await apiRequest(app, `${path}/reopen`, { method: 'POST' });
    const again = await parsed(await apiRequest(app, `${path}/approve`, json({})), reportApproveResponseSchema);
    // The idempotency is anchored on the TODO, not on the triage row — so a reopen/re-approve round
    // trip still leaves exactly one todo rather than a duplicate.
    expect(again.todo.id).toBe(first.todo.id);
    expect(again.alreadyApproved).toBe(true);
    expect(await readTodos(dataDir)).toHaveLength(1);
  });
});

describe('reports routes — automatic processing', () => {
  it('process-pending is 409 unless auto mode is explicitly on', async () => {
    const { app, dataDir } = await buildProject({ reports: [DIGEST] });
    const res = await apiRequest(app, '/api/v1/reports/process-pending', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('CEZ_REPORTS_AUTO=1') });
    expect(await readTodos(dataDir)).toEqual([]);
  });

  it('with auto on it converts every pending report, reports each outcome, and is idempotent', async () => {
    const { app, dataDir } = await buildProject({
      reports: [
        DIGEST,
        { path: 'b.md', title: 'B', identifier: 'r-b' },
        { path: 'c.md', title: 'C', identifier: 'r-c' },
      ],
      config: { auto: true },
    });
    // One is already dismissed by hand: auto mode converts PENDING reports, and must not overrule a
    // decision a person already made.
    await apiRequest(app, '/api/v1/reports/r-c/dismiss', json({ reason: 'noise' }));

    const first = await parsed(
      await apiRequest(app, '/api/v1/reports/process-pending', { method: 'POST' }),
      reportProcessPendingResponseSchema,
    );
    expect(first.converted).toBe(2);
    expect(first.failed).toBe(0);
    expect(first.outcomes.map((o) => o.key).sort()).toEqual(['r-b', 'report-2026-08-18-digest']);
    expect(first.outcomes.every((o) => o.ok && o.todoId)).toBe(true);

    const rows = await readReportTriage(dataDir);
    expect(rows.get('r-b')?.auto).toBe(true);
    // The hand dismissal survived untouched — no `auto` flag, reason intact.
    expect(rows.get('r-c')).toMatchObject({ status: 'dismissed', reason: 'noise' });
    expect(rows.get('r-c')?.auto).toBeUndefined();
    expect(await readTodos(dataDir)).toHaveLength(2);

    const second = await parsed(
      await apiRequest(app, '/api/v1/reports/process-pending', { method: 'POST' }),
      reportProcessPendingResponseSchema,
    );
    // Nothing is pending any more, so a second pass converts nothing and mints nothing.
    expect(second).toEqual({ outcomes: [], converted: 0, failed: 0 });
    expect(await readTodos(dataDir)).toHaveLength(2);
  });

  it('a report whose routing target cannot be resolved is reported as failed, not dropped', async () => {
    const { app, dataDir } = await buildProject({
      reports: [{ ...DIGEST, domain: 'beside' }, { path: 'b.md', title: 'B', identifier: 'r-b' }],
      config: { auto: true, routeByDomain: { beside: 'nowhere' } },
    });
    const body = await parsed(
      await apiRequest(app, '/api/v1/reports/process-pending', { method: 'POST' }),
      reportProcessPendingResponseSchema,
    );
    expect(body.converted).toBe(1);
    expect(body.failed).toBe(1);
    // A batch must never let a caller infer completeness from a count: the failure is named.
    const failed = body.outcomes.find((o) => !o.ok);
    expect(failed?.key).toBe('report-2026-08-18-digest');
    expect(failed?.error).toContain('nowhere');
    // The failed one stays pending, so a later pass (or a person) still sees it.
    expect((await readReportTriage(dataDir)).has('report-2026-08-18-digest')).toBe(false);
    const list = await parsed(await apiRequest(app, '/api/v1/reports'), reportsResponseSchema);
    expect(list.counts).toEqual({ pending: 1, approved: 1, dismissed: 0, total: 2 });
  });
});

describe('reports routes — `by`: who triaged, when there is a signed-in user to name', () => {
  it('a signed-in approval and dismissal are attributed; nothing else changes', async () => {
    const { app, dataDir } = await buildProject({ reports: [DIGEST], principal: SESSION_PRINCIPAL });

    const approved = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/approve', json({})),
      reportApproveResponseSchema,
    );
    // On the WIRE, not only in the store: a client that wants to show an author must be able to.
    expect(approved.item.triage?.by).toBe('user-alice');
    expect((await readReportTriage(dataDir)).get('report-2026-08-18-digest')?.by).toBe('user-alice');

    const dismissed = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/dismiss', json({ reason: 'duplicate' })),
      reportDismissResponseSchema,
    );
    expect(dismissed.item.triage?.by).toBe('user-alice');
  });

  it('an unauthenticated deployment stamps NOBODY — the machine is not a person', async () => {
    // The negative control that matters: `local` is a real principal on the context, so a handler
    // that stamped `principal.userId` unconditionally would pass the test above and fail here.
    const { app, dataDir } = await buildProject({
      reports: [DIGEST],
      principal: { kind: 'local', userId: 'local-user', orgId: null, teamId: null, role: 'owner' },
    });
    const body = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/approve', json({})),
      reportApproveResponseSchema,
    );
    expect(body.item.triage?.by).toBeUndefined();
    expect((await readReportTriage(dataDir)).get('report-2026-08-18-digest')?.by).toBeUndefined();
    // The rest of the row is unaffected — this is about the author field only.
    expect(body.item.triage).toMatchObject({ status: 'approved', todoProjectId: 'proj' });
  });

  it('no principal on the context at all leaves `by` absent rather than throwing', async () => {
    const { app } = await buildProject({ reports: [DIGEST] });
    const body = await parsed(
      await apiRequest(app, '/api/v1/reports/report-2026-08-18-digest/approve', json({})),
      reportApproveResponseSchema,
    );
    expect(body.item.triage?.by).toBeUndefined();
  });

  it('re-approving keeps the FIRST approver; dismissing overwrites with the one who dismissed', async () => {
    const { project, dataDir } = await buildProject({ reports: [DIGEST], principal: SESSION_PRINCIPAL });
    // Two apps over ONE project, so the second request is a different signed-in user against the
    // same store — which is the only way to tell "kept" from "never written twice".
    const appFor = (principal: Principal): Hono<ProjectApiEnv> =>
      new Hono<ProjectApiEnv>()
        .use('*', async (c, next) => {
          c.set('project', project);
          (c as unknown as Context<{ Variables: { principal: Principal } }>).set('principal', principal);
          await next();
        })
        .route(
          '/api/v1',
          createReportsRoutes({
            reportsConfig: async () => ({
              tags: ['user-report'],
              handledTags: ['status/processed'],
              auto: false,
              routeByDomain: {},
            }),
          }),
        ) as unknown as Hono<ProjectApiEnv>;

    const alice = appFor(SESSION_PRINCIPAL);
    const bob = appFor({ ...SESSION_PRINCIPAL, userId: 'user-bob' });

    const first = await parsed(
      await apiRequest(alice, '/api/v1/reports/report-2026-08-18-digest/approve', json({})),
      reportApproveResponseSchema,
    );
    expect(first.item.triage?.by).toBe('user-alice');
    const firstAt = first.item.triage?.at;

    const again = await parsed(
      await apiRequest(bob, '/api/v1/reports/report-2026-08-18-digest/approve', json({})),
      reportApproveResponseSchema,
    );
    expect(again.alreadyApproved).toBe(true);
    // Bob clicking approve does not rewrite the record of who approved it, or when.
    expect(again.item.triage?.by).toBe('user-alice');
    expect(again.item.triage?.at).toBe(firstAt);

    const dropped = await parsed(
      await apiRequest(bob, '/api/v1/reports/report-2026-08-18-digest/dismiss', json({ reason: 'not a bug' })),
      reportDismissResponseSchema,
    );
    // A dismissal IS a fresh decision, so its owner is Bob — and the todo pointer survives.
    expect(dropped.item.triage?.by).toBe('user-bob');
    expect(dropped.item.triage?.todoId).toBe(first.todo.id);
    expect((await readReportTriage(dataDir)).get('report-2026-08-18-digest')?.by).toBe('user-bob');
  });

  it('an automatic pass records who ran it AND that it was automatic', async () => {
    const { app, dataDir } = await buildProject({
      reports: [DIGEST],
      config: { auto: true },
      principal: SESSION_PRINCIPAL,
    });
    const body = await parsed(
      await apiRequest(app, '/api/v1/reports/process-pending', { method: 'POST' }),
      reportProcessPendingResponseSchema,
    );
    expect(body.converted).toBe(1);
    const row = (await readReportTriage(dataDir)).get('report-2026-08-18-digest');
    // Both, not either: `by` alone would read as a hand decision, `auto` alone loses who asked.
    expect(row?.by).toBe('user-alice');
    expect(row?.auto).toBe(true);
  });
});
