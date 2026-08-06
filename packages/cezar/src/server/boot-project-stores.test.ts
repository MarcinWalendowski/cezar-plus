import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * The BOOT project must carry the same flag-gated stores every other project
 * carries.
 *
 * It did not. `ProjectContexts.build()` activated `knowledgeStore` and
 * `sourceStore`; `createApp` hand-built its `bootContext` from the deps
 * `serveCommand` already had and activated neither. `resolveProjectScope`
 * hands that boot context to THREE of the four ways to name the boot project —
 * unscoped `/api/v1/...`, `/p/default/...`, and `/p/<bootId>/...` — so with
 * `CEZ_KB=1` the cockpit's Knowledge tab was empty on the only project the
 * user was looking at, while the store underneath held a fully indexed corpus.
 *
 * Why nothing caught it: `knowledge-api.test.ts` mounts the KNOWLEDGE family
 * behind a hand-set `c.get('project')` and its header recorded the divergence
 * as a fixture constraint ("the boot project `createApp` seeds directly from
 * `deps.{store,manager}` never carries a `knowledgeStore`") rather than as the
 * bug it was. A test that documents the defect it is standing next to cannot
 * fail on it. This file is the missing integration assertion, and it goes
 * through `createApp` deliberately.
 *
 * Written against the FLAG-ON shape, because flag-off and
 * store-missing-by-accident are the same 409 (D19) — asserting the off shape
 * would have passed with the bug present.
 */
describe('boot project carries the flag-gated stores (CEZ_KB=1)', () => {
  const saved = {
    home: process.env.CEZ_HOME,
    kb: process.env.CEZ_KB,
    dryRun: process.env.CEZ_DRY_RUN,
  };
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let app: Hono;
  let bootId: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-boot-kb-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-boot-kb-root-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_KB = '1';
    process.env.CEZ_DRY_RUN = '1';
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    contexts = new ProjectContexts({ listProjects });
    bootId = (await registerProject(repoRoot)).id;
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
    });
  });

  afterEach(() => {
    contexts.disposeAll();
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries({
      CEZ_HOME: saved.home,
      CEZ_KB: saved.kb,
      CEZ_DRY_RUN: saved.dryRun,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // The mutator is the discriminating probe, not the GET: with the store
  // absent, `GET /knowledge` answers 200-with-an-empty-list (D19) — which is
  // also what a genuinely empty corpus returns, so it cannot tell the two
  // apart. Every mutator answers 409 when the store is missing, and 409 is
  // reachable ONLY that way once `CEZ_KB=1`.
  // Two traps here, both found by running this file against the bug:
  //
  // 1. The body must SATISFY `createKnowledgeDocumentInputSchema`. A malformed
  //    one 400s in the zod validator ahead of the handler, so the probe passes
  //    whether or not the store is there.
  // 2. 409 is OVERLOADED on `POST /knowledge` — "knowledge base disabled" and
  //    "a document already exists at that path" share it. Iterating three
  //    spellings means spelling #1 creates the document that makes #2 conflict,
  //    which reads exactly like the defect. So each spelling writes its own
  //    path, and the assertion names the disabled MESSAGE rather than the
  //    status it happens to share.
  // `string`, not `BodyInit`: the server tsconfig carries no DOM lib.
  const mutators: [string, string, (slug: string) => string | undefined][] = [
    [
      'POST',
      '/knowledge',
      (slug) => JSON.stringify({ scope: 'project', path: `kb/${slug}.md`, content: '# A\n' }),
    ],
    ['POST', '/knowledge/reindex', () => undefined],
  ];

  // All three boot spellings, because they are separate entries into
  // `resolveProjectScope` and only the `raw === undefined` arm was ever
  // exercised elsewhere.
  const spellings = (path: string) => [
    `/api/v1${path}`,
    `/api/v1/p/default${path}`,
    `/api/v1/p/${bootId}${path}`,
  ];

  for (const [method, path, bodyFor] of mutators) {
    it(`${method} ${path} is not "knowledge base disabled" on any boot spelling`, async () => {
      for (const [index, url] of spellings(path).entries()) {
        const body = bodyFor(`s${index}`);
        const res = await apiRequest(app, url, {
          method,
          ...(body ? { headers: { 'content-type': 'application/json' }, body } : {}),
        });
        const text = await res.text();
        expect(
          text,
          `${method} ${url} answered ${res.status} ${text} — the boot context lost its knowledgeStore`,
        ).not.toContain('set CEZ_KB=1');
      }
    });
  }

  // A non-boot project builds through `ProjectContexts.build()`, the path that
  // always worked. Pinning it alongside is what makes this file a parity
  // assertion rather than a single-path one: the bug was the two paths
  // disagreeing, so a regression in EITHER direction has to be visible here.
  it('a lazily built project agrees with the boot project', async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'cez-boot-kb-other-'));
    try {
      mkdirSync(join(otherRoot, '.ai/cezar'), { recursive: true });
      writeFileSync(join(otherRoot, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
      clearProjectProbeCache();
      const other = await registerProject(otherRoot);
      const boot = await apiRequest(app, '/api/v1/knowledge/reindex', { method: 'POST' });
      const lazy = await apiRequest(app, `/api/v1/p/${other.id}/knowledge/reindex`, {
        method: 'POST',
      });
      expect(boot.status).toBe(lazy.status);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
