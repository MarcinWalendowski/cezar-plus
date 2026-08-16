import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { KnowledgeDocument } from '@loki-labs/better-cezar-contract';
import { createWorkspaceKnowledgeRoutes, type WorkspaceKnowledgeRouteDeps } from './workspace-knowledge-routes.ts';
import { WorkspaceKnowledgeIndex, type WorkspaceKnowledgeProjectSource } from '../workspace/knowledge-index.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import type { ProjectApiEnv } from './server.ts';

/**
 * `workspace-knowledge-routes.ts` (D3/D5/D6, `.ai/specs/2026-08-14-knowledge-domains-and-
 * changelog.md` "Verification"). `deps.knowledgeIndex` is injected with a fake
 * `WorkspaceKnowledgeIndex` built from hermetic fakes (`../workspace/knowledge-index.test.ts`
 * covers the index itself, including `changelog()`'s projection/sort/`since` logic), so this file
 * only proves the ROUTE layer: capability gating (both directions, all three routes), wire shape,
 * and that a live request reaches the injected index unchanged.
 *
 * The env var mutations below restore `process.env` in `afterEach` — `resolveCapabilities` reads
 * `process.env` directly (matching `./workspace-git-routes.ts`'s own precedent), so this is the
 * only way to drive the gate from a test.
 */

const ENV_KEYS = ['CEZ_KB', 'CEZ_WORKSPACE_VIEWS', 'CEZ_SINGLE_PROJECT'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function enableBoth(): void {
  process.env.CEZ_KB = '1';
  process.env.CEZ_WORKSPACE_VIEWS = '1';
  delete process.env.CEZ_SINGLE_PROJECT;
}

function doc(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: 'd1',
    slug: 'doc',
    root: 'project',
    path: '/fake/proj/doc.md',
    title: 'Doc',
    type: 'note',
    tags: [],
    status: 'current',
    identifiers: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    hash: 'h',
    bytes: 1,
    headings: [],
    excerpt: '',
    links: [],
    backlinkCount: 0,
    ...overrides,
  };
}

function appWith(deps: WorkspaceKnowledgeRouteDeps) {
  return new Hono<ProjectApiEnv>().route('/api/v1', createWorkspaceKnowledgeRoutes(deps));
}

/** A fake index that never touches the real registry — the route's own default construction
 *  (`defaultKnowledgeIndex`) is exercised separately by giving it `contexts: {peek: () => undefined}`
 *  and a `listProjects` fake through the constructor directly, matching `knowledge-index.test.ts`. */
function fakeIndex(overrides: {
  search?: WorkspaceKnowledgeIndex['search'];
  domains?: WorkspaceKnowledgeIndex['domains'];
  changelog?: WorkspaceKnowledgeIndex['changelog'];
} = {}): WorkspaceKnowledgeIndex {
  const index = new WorkspaceKnowledgeIndex({
    listProjects: async () => [] as WorkspaceKnowledgeProjectSource[],
    contexts: { peek: () => undefined },
  });
  if (overrides.search) index.search = overrides.search;
  if (overrides.domains) index.domains = overrides.domains;
  if (overrides.changelog) index.changelog = overrides.changelog;
  return index;
}

describe('workspace knowledge routes — the two-flag capability gate (D6)', () => {
  it('CEZ_KB off, CEZ_WORKSPACE_VIEWS on -> disabledReason names "knowledge"', async () => {
    process.env.CEZ_WORKSPACE_VIEWS = '1';
    delete process.env.CEZ_KB;
    delete process.env.CEZ_SINGLE_PROJECT;
    const app = appWith({ contexts: { peek: () => undefined }, knowledgeIndex: fakeIndex() });

    const search = await apiRequest(app, '/api/v1/workspace/knowledge/search?q=x');
    expect(search.status).toBe(200);
    expect(await search.json()).toEqual({ query: 'x', total: 0, truncated: false, results: [], projects: [], disabledReason: 'knowledge' });

    const domains = await apiRequest(app, '/api/v1/workspace/knowledge/domains');
    expect(domains.status).toBe(200);
    expect(await domains.json()).toEqual({ domains: [], projects: [], disabledReason: 'knowledge' });

    const changelog = await apiRequest(app, '/api/v1/workspace/knowledge/changelog');
    expect(changelog.status).toBe(200);
    expect(await changelog.json()).toEqual({ entries: [], projects: [], disabledReason: 'knowledge' });
  });

  it('CEZ_KB on, CEZ_WORKSPACE_VIEWS off -> disabledReason names "workspaceViews", the reverse direction', async () => {
    process.env.CEZ_KB = '1';
    delete process.env.CEZ_WORKSPACE_VIEWS;
    delete process.env.CEZ_SINGLE_PROJECT;
    const app = appWith({ contexts: { peek: () => undefined }, knowledgeIndex: fakeIndex() });

    const search = await apiRequest(app, '/api/v1/workspace/knowledge/search?q=x');
    expect(await search.json()).toMatchObject({ disabledReason: 'workspaceViews' });

    const domains = await apiRequest(app, '/api/v1/workspace/knowledge/domains');
    expect(await domains.json()).toMatchObject({ disabledReason: 'workspaceViews' });

    const changelog = await apiRequest(app, '/api/v1/workspace/knowledge/changelog');
    expect(await changelog.json()).toMatchObject({ disabledReason: 'workspaceViews' });
  });

  it('both on -> no disabledReason, and the index is actually called', async () => {
    enableBoth();
    let searchCalled = false;
    let domainsCalled = false;
    let changelogCalled = false;
    const app = appWith({
      contexts: { peek: () => undefined },
      knowledgeIndex: fakeIndex({
        search: async (query) => {
          searchCalled = true;
          return { query, total: 0, truncated: false, results: [], projects: [] };
        },
        domains: async () => {
          domainsCalled = true;
          return { domains: [], projects: [] };
        },
        changelog: async () => {
          changelogCalled = true;
          return { entries: [], projects: [] };
        },
      }),
    });

    const search = await apiRequest(app, '/api/v1/workspace/knowledge/search?q=x');
    const searchBody = (await search.json()) as { disabledReason?: string };
    expect(searchBody.disabledReason).toBeUndefined();
    expect(searchCalled).toBe(true);

    const domains = await apiRequest(app, '/api/v1/workspace/knowledge/domains');
    const domainsBody = (await domains.json()) as { disabledReason?: string };
    expect(domainsBody.disabledReason).toBeUndefined();
    expect(domainsCalled).toBe(true);

    const changelog = await apiRequest(app, '/api/v1/workspace/knowledge/changelog');
    const changelogBody = (await changelog.json()) as { disabledReason?: string };
    expect(changelogBody.disabledReason).toBeUndefined();
    expect(changelogCalled).toBe(true);
  });

  it('CEZ_SINGLE_PROJECT=1 reports workspaceViews false, so it answers the same as the flag being off', async () => {
    process.env.CEZ_KB = '1';
    process.env.CEZ_WORKSPACE_VIEWS = '1';
    process.env.CEZ_SINGLE_PROJECT = '1';
    const app = appWith({ contexts: { peek: () => undefined }, knowledgeIndex: fakeIndex() });
    const res = await apiRequest(app, '/api/v1/workspace/knowledge/search?q=x');
    expect(await res.json()).toMatchObject({ disabledReason: 'workspaceViews' });
  });
});

describe('workspace knowledge routes — wire shape, both flags on', () => {
  it('GET /workspace/knowledge/search forwards q/domain/project/type/status/limit/offset and returns the index result', async () => {
    enableBoth();
    let received: unknown;
    const app = appWith({
      contexts: { peek: () => undefined },
      knowledgeIndex: fakeIndex({
        search: async (query, options) => {
          received = { query, options };
          return {
            query,
            total: 1,
            truncated: false,
            results: [{ project: 'p1', document: doc() }],
            projects: [{ id: 'p1', name: 'p1', ok: true }],
          };
        },
      }),
    });

    const res = await apiRequest(
      app,
      '/api/v1/workspace/knowledge/search?q=billing&domain=finance&project=p1&type=decision&status=current&limit=5&offset=1',
    );
    expect(res.status).toBe(200);
    expect(received).toMatchObject({
      query: 'billing',
      options: { projects: ['p1'], domain: 'finance', type: 'decision', status: 'current', limit: 5, offset: 1 },
    });
    const body = await res.json();
    expect(body).toEqual({
      query: 'billing',
      total: 1,
      truncated: false,
      results: [{ project: 'p1', document: doc() }],
      projects: [{ id: 'p1', name: 'p1', ok: true }],
    });
  });

  it('GET /workspace/knowledge/search with no q at all still answers 200 with an empty query string', async () => {
    enableBoth();
    const app = appWith({
      contexts: { peek: () => undefined },
      knowledgeIndex: fakeIndex({
        search: async (query) => ({ query, total: 0, truncated: false, results: [], projects: [] }),
      }),
    });
    const res = await apiRequest(app, '/api/v1/workspace/knowledge/search');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ query: '' });
  });

  it('GET /workspace/knowledge/domains returns the index result unchanged', async () => {
    enableBoth();
    const app = appWith({
      contexts: { peek: () => undefined },
      knowledgeIndex: fakeIndex({
        domains: async () => ({
          domains: [{ domain: 'billing', docCount: 3, projects: ['a', 'b'], indexDocId: 'idx1' }],
          projects: [{ id: 'a', name: 'a', ok: true }, { id: 'b', name: 'b', ok: true }],
        }),
      }),
    });
    const res = await apiRequest(app, '/api/v1/workspace/knowledge/domains');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      domains: [{ domain: 'billing', docCount: 3, projects: ['a', 'b'], indexDocId: 'idx1' }],
      projects: [{ id: 'a', name: 'a', ok: true }, { id: 'b', name: 'b', ok: true }],
    });
  });

  it('two consecutive GET /workspace/knowledge/search bodies are byte identical (D8)', async () => {
    enableBoth();
    const app = appWith({
      contexts: { peek: () => undefined },
      knowledgeIndex: fakeIndex({
        search: async (query) => ({ query, total: 0, truncated: false, results: [], projects: [] }),
      }),
    });
    const first = await (await apiRequest(app, '/api/v1/workspace/knowledge/search?q=x')).text();
    const second = await (await apiRequest(app, '/api/v1/workspace/knowledge/search?q=x')).text();
    expect(first).toBe(second);
  });

  it('GET /workspace/knowledge/changelog forwards domain/project/since/limit and returns the index result', async () => {
    enableBoth();
    let received: unknown;
    const app = appWith({
      contexts: { peek: () => undefined },
      knowledgeIndex: fakeIndex({
        changelog: async (options) => {
          received = options;
          return {
            entries: [{ project: 'p1', document: doc({ changeType: 'Fixed' }) }],
            projects: [{ id: 'p1', name: 'p1', ok: true }],
          };
        },
      }),
    });

    const res = await apiRequest(
      app,
      '/api/v1/workspace/knowledge/changelog?domain=finance&project=p1&since=2026-01-01T00:00:00.000Z&limit=5',
    );
    expect(res.status).toBe(200);
    expect(received).toMatchObject({ projects: ['p1'], domain: 'finance', since: '2026-01-01T00:00:00.000Z', limit: 5 });
    expect(await res.json()).toEqual({
      entries: [{ project: 'p1', document: doc({ changeType: 'Fixed' }) }],
      projects: [{ id: 'p1', name: 'p1', ok: true }],
    });
  });

  it('GET /workspace/knowledge/changelog with no query at all still answers 200, no project filter forwarded', async () => {
    enableBoth();
    let received: unknown;
    const app = appWith({
      contexts: { peek: () => undefined },
      knowledgeIndex: fakeIndex({
        changelog: async (options) => {
          received = options;
          return { entries: [], projects: [] };
        },
      }),
    });
    const res = await apiRequest(app, '/api/v1/workspace/knowledge/changelog');
    expect(res.status).toBe(200);
    expect(received).toMatchObject({ projects: undefined });
  });

  it('GET /workspace/knowledge/changelog surfaces sinceExcludedAll unchanged from the index', async () => {
    enableBoth();
    const app = appWith({
      contexts: { peek: () => undefined },
      knowledgeIndex: fakeIndex({
        changelog: async () => ({ entries: [], projects: [], sinceExcludedAll: true }),
      }),
    });
    const res = await apiRequest(app, '/api/v1/workspace/knowledge/changelog?since=2027-01-01T00:00:00.000Z');
    expect(await res.json()).toMatchObject({ entries: [], sinceExcludedAll: true });
  });
});
