import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskFanoutResponse } from '@open-mercato/cezar-contract';
import { createTaskFanoutRoutes, type TaskFanoutRouteDeps, type TaskFanoutProjectSource } from './task-fanout-routes.ts';
import type { TaskFanoutResult } from '../fanout/engine.ts';
import { readTodos } from '../todos.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import type { ProjectApiEnv } from './server.ts';

/**
 * `POST /api/v1/workspace/task-fanout` — the route layer only
 * (`.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`, D1/D3/D5/D7). The analysis itself is
 * covered by `../fanout/engine.test.ts` against the same injected seams, so `deps.fanout` here is
 * a stub: what this file proves is what the ROUTE owns —
 *
 *  - it is **ungated** (D7): every capability flag unset is the default install, and the one this
 *    path must work on;
 *  - each returned item is **written as a real todo** in that project's own `.ai/cezar`, which is
 *    where `GET /workspace/todos` and the project inbox then read it from;
 *  - work that was named and could not be filed lands in `unassigned` with a reason rather than
 *    being dropped — a silent drop reads as "covered everything";
 *  - **nothing is started** (D5): no `RunManager` is reachable from this file at all, which the
 *    import-graph assertion at the bottom pins structurally rather than politely.
 */

const ENV_KEYS = [
  'CEZ_FOLLOWUPS',
  'CEZ_WORKSPACE_VIEWS',
  'CEZ_SINGLE_PROJECT',
  'CEZ_KB',
  'CEZ_NOTES',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

const tmpRoots: string[] = [];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

/** The default install: none of the flags this feature's neighbours gate on. */
function clearAll(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function tmpProject(id: string): TaskFanoutProjectSource {
  const root = mkdtempSync(join(tmpdir(), `cez-fanout-${id}-`));
  tmpRoots.push(root);
  return { id, root, name: id, status: 'ok' };
}

function appWith(over: Partial<TaskFanoutRouteDeps> & { fanout: TaskFanoutRouteDeps['fanout'] }) {
  const deps: TaskFanoutRouteDeps = {
    contexts: { peek: () => undefined },
    runIndex: { digest: async () => [] } as unknown as TaskFanoutRouteDeps['runIndex'],
    bootRoot: '/nonexistent-boot-root',
    listProjects: async () => [],
    // Neither may ever be reached: `fanout` is stubbed in every test, so a call here means the
    // route wired production machinery into a test.
    knowledgeSearch: () => {
      throw new Error('the real knowledge index must not be reached');
    },
    ask: () => {
      throw new Error('the real runner must not be reached');
    },
    warn: () => {},
    ...over,
  };
  return new Hono<ProjectApiEnv>().route('/api/v1', createTaskFanoutRoutes(deps));
}

const post = (app: Hono<ProjectApiEnv>, body: unknown) =>
  apiRequest(app, '/api/v1/workspace/task-fanout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const EMPTY: TaskFanoutResult = { items: [], unassigned: [], truncated: false };

describe('POST /api/v1/workspace/task-fanout', () => {
  it('files every returned item as a todo in that project — with no capability flags set', async () => {
    clearAll();
    const alpha = tmpProject('alpha');
    const beta = tmpProject('beta');
    const app = appWith({
      listProjects: async () => [alpha, beta],
      fanout: async () => ({
        items: [
          {
            projectId: 'alpha',
            projectName: 'alpha',
            title: 'Add the retry ladder',
            context: 'extends the queue work',
            whatToDo: 'wrap the publish call',
            acceptanceCriteria: ['a dropped message is retried'],
            knowledgeRefs: [{ project: 'alpha', slug: 'queues', title: 'Queues' }],
          },
          {
            projectId: 'beta',
            projectName: 'beta',
            title: 'Mirror the retry ladder',
            context: '',
            whatToDo: 'same, on the consumer',
            acceptanceCriteria: [],
            knowledgeRefs: [],
          },
        ],
        unassigned: [],
        truncated: false,
      }),
    });

    const res = await post(app, { input: 'make the queue reliable' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskFanoutResponse;

    expect(body.items.map((item) => item.projectId)).toEqual(['alpha', 'beta']);
    expect(body.unassigned).toEqual([]);
    expect(body.truncated).toBe(false);
    // Every item names the todo it became — a response that reported success without an id would
    // leave a caller unable to find, start or delete what it just created.
    expect(body.items.every((item) => item.todoId.length > 0)).toBe(true);

    const alphaTodos = await readTodos(join(alpha.root, '.ai', 'cezar'));
    expect(alphaTodos).toHaveLength(1);
    expect(alphaTodos[0]).toMatchObject({
      id: body.items[0]!.todoId,
      summary: 'Add the retry ladder',
      context: 'extends the queue work',
      whatToDo: 'wrap the publish call',
      acceptanceCriteria: ['a dropped message is retried'],
      knowledgeRefs: [{ project: 'alpha', slug: 'queues', title: 'Queues' }],
      origin: 'composer',
      runnable: true,
    });

    const betaTodos = await readTodos(join(beta.root, '.ai', 'cezar'));
    expect(betaTodos).toHaveLength(1);
    // Empty strings and empty arrays are OMITTED, not stored: absent means "the pass produced
    // none", where `''` would read as "it produced an empty one".
    expect(betaTodos[0]).not.toHaveProperty('context');
    expect(betaTodos[0]).not.toHaveProperty('acceptanceCriteria');
    expect(betaTodos[0]).not.toHaveProperty('knowledgeRefs');
  });

  it('an ungrounded item still ships — knowledgeRefs is empty, never absent', async () => {
    clearAll();
    const alpha = tmpProject('alpha');
    const app = appWith({
      listProjects: async () => [alpha],
      fanout: async () => ({
        items: [
          {
            projectId: 'alpha',
            projectName: 'alpha',
            title: 'Nothing to cite',
            context: '',
            whatToDo: 'do it anyway',
            acceptanceCriteria: [],
            knowledgeRefs: [],
          },
        ],
        unassigned: [],
        truncated: false,
      }),
    });
    const body = (await (await post(app, { input: 'x' })).json()) as TaskFanoutResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.knowledgeRefs).toEqual([]);
  });

  it('passes the engine `targets` through, defaulting to omitted (the engine owns "auto")', async () => {
    clearAll();
    const seen: unknown[] = [];
    const app = appWith({
      fanout: async (input) => {
        seen.push(input.targets);
        return EMPTY;
      },
    });
    await post(app, { input: 'a' });
    await post(app, { input: 'b', targets: 'all' });
    await post(app, { input: 'c', targets: ['alpha'] });
    expect(seen).toEqual([undefined, 'all', ['alpha']]);
  });

  it('carries the engine\'s own unassigned + truncated through untouched', async () => {
    clearAll();
    const app = appWith({
      fanout: async () => ({
        items: [],
        unassigned: [{ title: 'unclear', reason: 'no project matched' }],
        truncated: true,
      }),
    });
    const body = (await (await post(app, { input: 'x' })).json()) as TaskFanoutResponse;
    expect(body.unassigned).toEqual([{ title: 'unclear', reason: 'no project matched' }]);
    expect(body.truncated).toBe(true);
  });

  it('names an item whose project is no longer registered instead of dropping it', async () => {
    clearAll();
    const app = appWith({
      // The registry no longer holds the project the analysis routed to — the window between
      // Phase A and the write is real, and a removed project must not swallow the work.
      listProjects: async () => [],
      fanout: async () => ({
        items: [
          {
            projectId: 'gone',
            projectName: 'gone',
            title: 'Work with nowhere to live',
            context: '',
            whatToDo: 'x',
            acceptanceCriteria: [],
            knowledgeRefs: [],
          },
        ],
        unassigned: [],
        truncated: false,
      }),
    });
    const body = (await (await post(app, { input: 'x' })).json()) as TaskFanoutResponse;
    expect(body.items).toEqual([]);
    expect(body.unassigned).toHaveLength(1);
    expect(body.unassigned[0]!.title).toBe('Work with nowhere to live');
    expect(body.unassigned[0]!.reason).toContain('gone');
  });

  it('names an item whose todo write failed instead of reporting it filed', async () => {
    clearAll();
    const alpha = tmpProject('alpha');
    const app = appWith({
      listProjects: async () => [alpha],
      createTodo: async () => {
        throw new Error('disk is full');
      },
      fanout: async () => ({
        items: [
          {
            projectId: 'alpha',
            projectName: 'alpha',
            title: 'Never landed',
            context: '',
            whatToDo: 'x',
            acceptanceCriteria: [],
            knowledgeRefs: [],
          },
        ],
        unassigned: [],
        truncated: false,
      }),
    });
    const res = await post(app, { input: 'x' });
    // Still a 200: a partial fan-out is the normal case, and a 4xx over one failed write would
    // hide the items that DID land. The failure is in the payload, named.
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskFanoutResponse;
    expect(body.items).toEqual([]);
    expect(body.unassigned[0]!.reason).toContain('disk is full');
  });

  it('rejects an empty input with a 400 and never calls the engine', async () => {
    clearAll();
    let called = false;
    const app = appWith({
      fanout: async () => {
        called = true;
        return EMPTY;
      },
    });
    expect((await post(app, { input: '' })).status).toBe(400);
    expect((await post(app, {})).status).toBe(400);
    expect(called).toBe(false);
  });

  it('runs identically with every capability flag ON — this route reads no flags at all', async () => {
    clearAll();
    for (const key of ENV_KEYS) process.env[key] = '1';
    const alpha = tmpProject('alpha');
    const app = appWith({
      listProjects: async () => [alpha],
      fanout: async () => ({
        items: [
          {
            projectId: 'alpha',
            projectName: 'alpha',
            title: 'Same either way',
            context: '',
            whatToDo: 'x',
            acceptanceCriteria: [],
            knowledgeRefs: [],
          },
        ],
        unassigned: [],
        truncated: false,
      }),
    });
    const body = (await (await post(app, { input: 'x' })).json()) as TaskFanoutResponse;
    expect(body.items).toHaveLength(1);
    expect(await readTodos(join(alpha.root, '.ai', 'cezar'))).toHaveLength(1);
  });
});

/**
 * D5 as a structural guard, not a promise: this module must have no RUNTIME import path to the
 * run machinery or to `project-context.ts`. Filing a task cannot start a run if a `RunManager` is
 * not reachable from here at all — and building a `ProjectContext` recovers and resumes that
 * project's interrupted runs, so typing into a composer must not be able to reach one.
 *
 * Walked transitively, like `notes/processor.test.ts`'s guard, because one layer of indirection
 * silences a one-file grep. It differs from that one in exactly one way, and the difference is
 * load-bearing: **`import type` statements are not followed.** Every route family in this
 * directory takes its Hono env from `./server.ts` — a type that is erased at build and emits no
 * `require`/`import` at all — so following type-only edges would report `server.ts` (and through
 * it everything cezar has) as reachable from every route file, and the guard would be unusable
 * rather than merely noisy. The exemption is narrow on purpose: only the explicit `import type`
 * form is skipped, so a value import that happens to carry inline `type` specifiers is still
 * followed, and the second test below pins that `./server.ts` is reached ONLY that way.
 */
describe('D5/READ-never-instantiates — the runtime import graph', () => {
  const ENTRY = join(import.meta.dirname, 'task-fanout-routes.ts');
  /** `import type ... from '<relative>'` / `export type ... from '<relative>'` — group 1 present
   *  means the edge is erased at build and is not walked. */
  const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+['"](\.[^'"]+)['"]/g;

  function walk(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    let source: string;
    try {
      source = readFileSync(entry, 'utf8');
    } catch {
      return seen;
    }
    for (const match of source.matchAll(IMPORT_RE)) {
      if (match[1]) continue; // type-only edge: erased at build, cannot instantiate anything
      walk(join(entry, '..', match[2]!), seen);
    }
    return seen;
  }

  const graph = walk(ENTRY);

  it('never reaches project-context.ts or workflows/run.ts, at any depth', () => {
    const offenders = [...graph].filter(
      (file) => /server\/project-context\.ts$/.test(file) || /workflows\/run\.ts$/.test(file),
    );
    expect(offenders).toEqual([]);
  });

  it('reaches ./server.ts only as a type — the one edge the exemption covers', () => {
    const source = readFileSync(ENTRY, 'utf8');
    const edges = [...source.matchAll(IMPORT_RE)].filter((m) => m[2]!.endsWith('./server.ts'));
    // If this file ever imports a VALUE from server.ts, the exemption stops covering it and the
    // assertion above starts seeing the whole server graph — which is the correct outcome, and
    // this test says so out loud rather than letting it look like a regression in the walker.
    expect(edges).toHaveLength(1);
    expect(edges[0]![1]).toBe('type ');
  });

  /**
   * The walker itself, pinned — the same floor `notes/processor.test.ts` puts under its own. A
   * `walk` that silently returned a one-element set (a bad regex, an over-broad exemption) would
   * make both assertions above pass forever while proving nothing.
   */
  it('really does follow imports more than one level deep', () => {
    expect(graph.size).toBeGreaterThan(5);
    // `fanout/engine.ts` is a direct import; `fanout/prompt.ts` is reached only THROUGH it.
    expect([...graph].some((file) => /fanout\/prompt\.ts$/.test(file))).toBe(true);
  });
});
