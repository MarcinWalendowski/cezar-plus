import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { ProjectListEntry } from '../workspace/projects.ts';
import { createWorkspaceRunMutationRoutes } from './workspace-run-mutations-routes.ts';

/**
 * `POST /api/v1/workspace/runs/:projectId/:runId/{archive,read,unread}` —
 * `.ai/specs/2026-08-14-cross-project-run-mutations.md`.
 *
 * The point of the family is a NEGATIVE: it must mutate a row in any registered project **without
 * building that project's context**, because a build prunes orphans, reclaims (deletes) worktrees
 * and calls `manager.recover()`, which resumes every interrupted run in that project. So the
 * assertions here are mostly about what did NOT happen, and each one names the mutation that
 * makes it fire.
 */

const dirs: string[] = [];

async function projectRoot(runs: Record<string, unknown>[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cez-wrm-'));
  dirs.push(root);
  await mkdir(join(root, '.ai', 'cezar', 'runs'), { recursive: true });
  await writeFile(join(root, '.ai', 'cezar', 'runs.json'), JSON.stringify(runs, null, 2), 'utf8');
  return root;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Every field `runRecordSchema` requires, written straight to `runs.json` — deliberately not
 *  through `RunStore`, so the fixture cannot inherit the behaviour under test. */
function runJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    title: 'do the thing',
    workflow: 'quick-task',
    task: 'do the thing',
    status: 'done',
    createdAt: '2026-08-01T00:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...overrides,
  };
}

function entry(root: string, id = 'shop'): ProjectListEntry {
  return {
    id,
    root,
    name: id,
    addedAt: '2026-08-01T00:00:00.000Z',
    lastOpenedAt: '2026-08-01T00:00:00.000Z',
    source: 'local',
    status: 'ok',
  } as ProjectListEntry;
}

/**
 * A `contexts` double that RECORDS every peek and would make a build observable if one happened.
 *
 * `peek` is the only method the real dep type exposes, which is the structural half of the
 * guarantee; this counts calls so a test can also assert the handler asked for the live context
 * before opening its own store.
 */
function contextsWith(live?: { store: RunStore }) {
  const peeked: string[] = [];
  return {
    peeked,
    contexts: {
      peek(projectId: string) {
        peeked.push(projectId);
        return live;
      },
    },
  };
}

function app(root: string, opts: { live?: { store: RunStore }; id?: string } = {}) {
  const { contexts, peeked } = contextsWith(opts.live);
  const routes = createWorkspaceRunMutationRoutes({
    contexts,
    listProjects: async () => [entry(root, opts.id ?? 'shop')],
  });
  return { routes, peeked };
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  ...(body === undefined
    ? {}
    : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
});

async function storedRuns(root: string): Promise<Record<string, unknown>[]> {
  return JSON.parse(await readFile(join(root, '.ai', 'cezar', 'runs.json'), 'utf8'));
}

describe('workspace run mutations', () => {
  it('archives a row in a project whose context was never built', async () => {
    const root = await projectRoot([runJson()]);
    const { routes, peeked } = app(root);

    const res = await routes.request('/workspace/runs/shop/run-1/archive', post({ archived: true }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archived: boolean }).archived).toBe(true);

    // Peeked, not built — the whole reason this family exists.
    expect(peeked).toEqual(['shop']);
    // Flushed synchronously: a standalone store has no live save cadence to rely on.
    expect((await storedRuns(root))[0]!.archived).toBe(true);
  });

  it('stamps and clears a read receipt', async () => {
    const root = await projectRoot([runJson()]);
    const { routes } = app(root);

    await routes.request('/workspace/runs/shop/run-1/read', post());
    expect(typeof (await storedRuns(root))[0]!.seenAt).toBe('string');

    await routes.request('/workspace/runs/shop/run-1/unread', post());
    expect((await storedRuns(root))[0]!.seenAt).toBeUndefined();
  });

  /**
   * D3. Without `keepLive: true`, `RunStore.open` runs `reconcileLoadedRun`, which rewrites every
   * `running`/`queued`/`waiting` row as `failed` with "interrupted — cezar process exited during
   * the run" — and this path flushes, so the receipt would PERSIST that verdict over a run that is
   * alive in another process.
   *
   * Two rows on purpose: one to act on, one live bystander. Asserting only the acted-on row would
   * miss it entirely, since that row is `done`.
   */
  it('leaves a live row in the same project untouched — the receipt is not a reconciliation', async () => {
    const root = await projectRoot([runJson(), runJson({ id: 'run-2', status: 'running' })]);
    const { routes } = app(root);

    await routes.request('/workspace/runs/shop/run-1/read', post());

    const live = (await storedRuns(root)).find((run) => run.id === 'run-2')!;
    expect(live.status).toBe('running');
    expect(live.error).toBeUndefined();
  });

  /**
   * D2. A live context's store is the ONLY store allowed to write: `RunStore.open` returns a new
   * instance per call with no singleton, and `saveNow` rewrites the whole file from that
   * instance's map, so a second store would drop whatever the live one had learned.
   */
  it('mutates the live context’s own store when one is already built', async () => {
    const root = await projectRoot([runJson({ id: 'live-1' })]);
    // Stands in for the context's store: the same call `project-context.ts` makes, opened once and
    // then held. Its in-memory map is what a second `RunStore.open` would later clobber.
    const store = RunStore.open(join(root, '.ai', 'cezar'), { keepLive: true });

    const { routes, peeked } = app(root, { live: { store } });
    const res = await routes.request('/workspace/runs/shop/live-1/archive', post({ archived: true }));

    expect(res.status).toBe(200);
    expect(peeked).toEqual(['shop']);
    // Visible on the LIVE instance without reopening anything — which is only true if the handler
    // wrote through that store rather than through one of its own.
    expect(store.listRuns().find((run) => run.id === 'live-1')?.archived).toBe(true);
  });

  it('answers 404 for an unknown project and for an unknown run', async () => {
    const root = await projectRoot([runJson()]);
    const { routes } = app(root);

    expect((await routes.request('/workspace/runs/nope/run-1/read', post())).status).toBe(404);
    expect((await routes.request('/workspace/runs/shop/nope/read', post())).status).toBe(404);
  });

  /**
   * D4. `RunStore.open` starts with `mkdirSync(…, { recursive: true })`, so opening a project whose
   * folder is gone would recreate the deleted repo's skeleton. The directory assertion is the real
   * one — a 409 with the tree recreated would still be a bug.
   */
  it('answers 409 for a registered project whose folder is gone, and creates nothing', async () => {
    const root = await projectRoot([runJson()]);
    await rm(root, { recursive: true, force: true });
    const { routes } = app(root);

    const res = await routes.request('/workspace/runs/shop/run-1/read', post());
    expect(res.status).toBe(409);
    expect(existsSync(root)).toBe(false);
  });

  /**
   * The reported bug, 2026-08-16. `~/cezar/cockpit-boot` is a deliberately UNREGISTERED scaffold,
   * so `allocateProjectSlug` invents `cockpit-boot` for a root `listProjects()` has never heard
   * of — and the boot context, by an explicit decision in `server.ts`, "never lives in the lazy
   * map" either. Both roads therefore missed, and every boot row the board had just started
   * listing answered `404 unknown project: cockpit-boot` from its Read and Archive buttons.
   *
   * `listProjects` returns EMPTY here on purpose: that is the real shape of an unregistered boot
   * repo, and a fixture that registered it would agree with the bug.
   *
   * Mutation: delete the `bootProject`/`bootStore` branch in `resolveStore` — this 404s, which is
   * exactly what the user saw.
   */
  it('acts on a row in an UNREGISTERED boot project', async () => {
    const root = await projectRoot([runJson()]);
    const store = RunStore.open(join(root, '.ai', 'cezar'), { keepLive: true });
    const { contexts } = contextsWith(undefined);
    const routes = createWorkspaceRunMutationRoutes({
      contexts,
      listProjects: async () => [],
      bootProject: async () => 'cockpit-boot',
      bootStore: () => store,
    });

    const archive = await routes.request(
      '/workspace/runs/cockpit-boot/run-1/archive',
      post({ archived: true }),
    );
    expect(archive.status).toBe(200);
    expect(((await archive.json()) as { archived: boolean }).archived).toBe(true);

    const read = await routes.request('/workspace/runs/cockpit-boot/run-1/read', post());
    expect(read.status).toBe(200);
    expect(typeof ((await read.json()) as { seenAt?: string }).seenAt).toBe('string');
  });

  /**
   * The reason boot is resolved to its LIVE store rather than to a synthetic registry row (the
   * shape the two cross-project INDEXES use — they only read, so it costs them nothing).
   *
   * `RunStore.open` returns a NEW instance per call and `saveNow` rewrites the whole file from
   * that instance's own map. A second store opened over a root that already has a live one would
   * therefore flush away everything the live one had learned since it opened. This asserts the
   * handler wrote through the injected store and did NOT flush — the live store owns its own save
   * cadence (a 300ms debounce), so disk staying stale for this tick is the observable proof that
   * no standalone store was opened and flushed over it.
   *
   * Mutation: return `live: false` from the boot branch — `persist` then flushes and the disk
   * assertion fires. Or resolve boot via a synthetic `listProjects` row instead, which opens a
   * second store and fires it the same way.
   */
  it('writes through the boot project LIVE store and does not flush over it', async () => {
    const root = await projectRoot([runJson()]);
    const store = RunStore.open(join(root, '.ai', 'cezar'), { keepLive: true });
    const { contexts } = contextsWith(undefined);
    const routes = createWorkspaceRunMutationRoutes({
      contexts,
      listProjects: async () => [],
      bootProject: async () => 'cockpit-boot',
      bootStore: () => store,
    });

    await routes.request('/workspace/runs/cockpit-boot/run-1/archive', post({ archived: true }));

    // The injected instance saw it...
    expect(store.getRun('run-1')?.archived).toBe(true);
    // ...and the file did not, because this handler never flushed it.
    expect((await storedRuns(root))[0]!.archived).toBe(false);
  });

  /**
   * The boot road is a road for ONE id, not a catch-all. It sits between `peek` and the registry,
   * and a registered project must still be answered by the registry — otherwise the widening that
   * fixed the boot repo would quietly redirect every other project's row into the boot store.
   *
   * Mutation: drop the `projectId === await deps.bootProject()` condition so the boot branch
   * answers unconditionally — `shop`'s write lands in the boot store, its own file stays at
   * `archived: false`, and this fires. (Verified red.)
   */
  it('leaves a registered project to the registry, boot id notwithstanding', async () => {
    const bootRootDir = await projectRoot([runJson({ id: 'boot-run' })]);
    const shopRoot = await projectRoot([runJson()]);
    const bootStore = RunStore.open(join(bootRootDir, '.ai', 'cezar'), { keepLive: true });
    const { contexts } = contextsWith(undefined);
    const routes = createWorkspaceRunMutationRoutes({
      contexts,
      listProjects: async () => [entry(shopRoot, 'shop')],
      bootProject: async () => 'cockpit-boot',
      bootStore: () => bootStore,
    });

    const res = await routes.request('/workspace/runs/shop/run-1/archive', post({ archived: true }));
    expect(res.status).toBe(200);
    // Written to the registered project's own file, not the boot store's.
    expect((await storedRuns(shopRoot))[0]!.archived).toBe(true);
    expect(bootStore.getRun('run-1')).toBeUndefined();
  });

  it('rejects a malformed archive body rather than guessing', async () => {
    const root = await projectRoot([runJson()]);
    const { routes } = app(root);
    const res = await routes.request('/workspace/runs/shop/run-1/archive', post({ archived: 'yes' }));
    expect(res.status).toBe(400);
  });

  /**
   * The structural half, mirroring `run-index.test.ts`'s C2. `contexts` arrives as an injected dep
   * precisely so this can hold: the module has no way to reach the building accessor, whatever a
   * future edit to the handler body does.
   *
   * `runs/store.ts` is NOT forbidden here (unlike the read family) — this family's whole job is to
   * write, and the store is how. What must stay unreachable is the context builder.
   */
  it('never imports the context builder or the run manager', async () => {
    const source = await readFile(new URL('./workspace-run-mutations-routes.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"][^'"]*project-context(\.ts)?['"]/);
    expect(source).not.toMatch(/from\s+['"][^'"]*workflows\/run(\.ts)?['"]/);
    // The floor: without this the two assertions above would also pass on an empty file.
    expect(source).toMatch(/from\s+['"][^'"]*runs\/store(\.ts)?['"]/);
    // A `toMatch(/keepLive:\s*true/)` was here and has been removed: this module's docblock
    // explains `keepLive` in prose, so the assertion matched the COMMENT and stayed green with the
    // real option deleted. The live-row test above is the guard for that, and it is behavioural.
  });
});
