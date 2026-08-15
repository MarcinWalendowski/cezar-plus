import { join } from 'node:path';
import { Hono } from 'hono';
import { taskFanoutInputSchema, type TaskFanoutResponse } from '@open-mercato/cezar-contract';
import { jsonZodValidator } from './validators.ts';
import type { ProjectApiEnv } from './server.ts';
import { runTaskFanout, type FanoutAsk, type TaskFanoutItem as EngineItem } from '../fanout/engine.ts';
import { NoteCoordinator, type NoteCoordinatorProject } from '../notes/coordinator.ts';
import { WorkspaceKnowledgeIndex, type WorkspaceKnowledgeContexts } from '../workspace/knowledge-index.ts';
import type { WorkspaceRunIndex } from '../workspace/run-index.ts';
import { listProjects } from '../workspace/projects.ts';
import { createTodo } from '../todos.ts';
import { createRunner } from '../core/runner-factory.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import { loadConfig } from '../config.ts';

/**
 * `POST /api/v1/workspace/task-fanout` — the composer's All / Auto submit path
 * (`.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`, D1/D3/D5).
 *
 * One typed request in; N fully-specified todos out, each aimed at one project and grounded in
 * that project's own knowledge base. The analysis is `../fanout/engine.ts` (a pure seam — it
 * writes nothing); this file is the route plus the two things a route owns: wiring the engine's
 * deps to real machinery, and PERSISTING what came back.
 *
 * **Nothing is started (D5).** Every item becomes a todo and the response names it. Turning one
 * into a run stays the existing explicit step (`POST /todos/:id/start`, a human on a board) —
 * this route never calls a `RunManager`, and never imports one.
 *
 * **Ungated, deliberately (D7).** No `capabilities()` check anywhere in this file. `followups`,
 * `workspaceViews`, `notes` and `knowledge` are all off on a default install (measured on the
 * owner's own cockpit), and this is the composer's default submit path, not an optional side
 * view. Gating a main path on a flag nobody sets makes it fail as silence.
 *
 * **Grounding degrades, it never gates.** `CEZ_KB` governs the knowledge UI surface, not this
 * retrieval: the index is built and searched regardless, and an item that retrieved nothing
 * ships with an empty `knowledgeRefs`, which the UI renders as "not grounded" (D4). A project
 * with no knowledge base is a weaker answer, never a refusal.
 *
 * **READ never instantiates.** Like every sibling workspace family, this file does not import
 * `./project-context.ts`: `contexts` arrives as the narrow `peek`-only interface the knowledge
 * index takes, and todos are written through `createTodo()` on a derived `dataDir` — a plain fs
 * path — so filing a task can never build a `ProjectContext` and thereby resume that project's
 * interrupted runs.
 *
 * Workspace-level and single-mount, never mirrored under `/api/v1/p/:projectId`
 * (`BACKWARD_COMPATIBILITY.md` §2): the whole point is deciding WHICH projects before anything
 * is scoped to one.
 */

/** Wall clock for one phase's model call. Matches `NOTE_PASS_TIMEOUT_MS` — the same shape of
 *  call (no tools, JSON out) against the same runner, so the same budget. */
export const FANOUT_CALL_TIMEOUT_MS = 120_000;

/** What this route needs from the registry to file a todo: the id the engine routes to, and the
 *  root whose `.ai/cezar` receives it. */
export interface TaskFanoutProjectSource {
  id: string;
  root: string;
  name: string;
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  tags?: string[];
  lastOpenedAt?: string;
  repoUrl?: string;
}

export interface TaskFanoutRouteDeps {
  /** Passed to the knowledge index, which only ever calls `peek` — see the module doc. */
  contexts: WorkspaceKnowledgeContexts;
  /** The live-board digest Phase A routes against. The context map already owns one; reusing it
   *  means one parse of each project's `runs.json`, not two. */
  runIndex: Pick<WorkspaceRunIndex, 'digest'>;
  /** Where the analysis call is configured from — runner, planner model, agent account. The BOOT
   *  repo, exactly like `NoteProcessor.bootRoot`: a workspace-level pass has no project of its
   *  own, and the boot repo is the one whose config the operator actually set. */
  bootRoot: string;
  /** Test seams. Each defaults to the real thing; injected so the route's own tests never read
   *  `~/.cezar`, never shell out to a runner, and never write outside a tmpdir. */
  listProjects?: () => Promise<readonly TaskFanoutProjectSource[]>;
  knowledgeSearch?: WorkspaceKnowledgeIndex['search'];
  ask?: FanoutAsk;
  fanout?: typeof runTaskFanout;
  createTodo?: typeof createTodo;
  warn?: (message: string) => void;
}

function toCoordinatorProject(project: TaskFanoutProjectSource): NoteCoordinatorProject {
  return {
    id: project.id,
    root: project.root,
    name: project.name || '',
    status: project.status,
    ...(project.tags ? { tags: project.tags } : {}),
    ...(project.lastOpenedAt ? { lastOpenedAt: project.lastOpenedAt } : {}),
    ...(project.repoUrl ? { repoUrl: project.repoUrl } : {}),
  };
}

/**
 * The production model call: one runner invocation, text in / text out. Retries and parsing
 * belong to the engine (`askStructured`), so this stays the thinnest possible adapter — the same
 * split `NoteProcessor.ask` uses, minus the retry loop it owns itself.
 *
 * `allowedTools: []` is the ASK, not a guarantee: `--allowedTools` grants and never restricts on
 * the Claude backend (`core/claude-cli-runner.ts`, corrected 2026-08-15). What actually keeps
 * this pass away from a target repository is `cwd` — the boot root, never the project being
 * written about.
 */
function productionAsk(bootRoot: string): FanoutAsk {
  return async ({ systemPrompt, userPrompt }) => {
    const config = await loadConfig(bootRoot);
    const runnerId = config.defaultRunner;
    const runner = createRunner(runnerId);
    // Claude-only alias, same reason as `planChain` and the note pass: the other backends pick
    // their own default model.
    const model = runnerId === 'claude' ? config.plannerModel : undefined;
    // Under the same agent account this workspace's tasks run on — otherwise the composer
    // quietly bills a personal subscription for a workspace pointed at a work account.
    const { env } = await resolveProfileEnvForRoot(bootRoot, runnerId);
    const result = await runner.run({
      systemPrompt,
      userPrompt,
      cwd: bootRoot,
      allowedTools: [],
      ...(Object.keys(env).length > 0 ? { env } : {}),
      model,
      timeoutMs: FANOUT_CALL_TIMEOUT_MS,
    });
    return result.text;
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTaskFanoutRoutes(deps: TaskFanoutRouteDeps) {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const listProjectsFn: () => Promise<readonly TaskFanoutProjectSource[]> =
    deps.listProjects ??
    (async () =>
      (await listProjects()).map((project) => ({
        id: project.id,
        root: project.root,
        name: project.name || '',
        status: project.status,
        ...(project.tags ? { tags: project.tags } : {}),
        ...(project.lastOpenedAt ? { lastOpenedAt: project.lastOpenedAt } : {}),
        ...(project.repoUrl ? { repoUrl: project.repoUrl } : {}),
      })));

  const coordinator = new NoteCoordinator({
    listProjects: async () => (await listProjectsFn()).map(toCoordinatorProject),
    warn,
  });
  const knowledgeIndex = new WorkspaceKnowledgeIndex({
    contexts: deps.contexts,
    listProjects: async () =>
      (await listProjectsFn()).map((project) => ({
        id: project.id,
        root: project.root,
        status: project.status,
        name: project.name || '',
      })),
  });
  const knowledgeSearch = deps.knowledgeSearch ?? knowledgeIndex.search.bind(knowledgeIndex);
  const ask = deps.ask ?? productionAsk(deps.bootRoot);
  const fanout = deps.fanout ?? runTaskFanout;
  const writeTodo = deps.createTodo ?? createTodo;

  return new Hono<ProjectApiEnv>().post(
    '/workspace/task-fanout',
    jsonZodValidator(taskFanoutInputSchema),
    async (c) => {
      const body = c.req.valid('json');
      const result = await fanout(
        { text: body.input, ...(body.targets === undefined ? {} : { targets: body.targets }) },
        { coordinator, runIndex: deps.runIndex, knowledgeSearch, ask, warn },
      );

      const roots = new Map((await listProjectsFn()).map((project) => [project.id, project.root]));
      const items: TaskFanoutResponse['items'] = [];
      // Starts as whatever the engine could not route, and grows with anything this route could
      // not FILE. Both are "work that was named and did not become a task", and a caller that
      // renders one must render the other — dropping a write failure silently would be the exact
      // "covered everything" lie the spec's Risks section calls out for the item cap.
      const unassigned = [...result.unassigned];

      // Sequentially, not in parallel: two items routed to the SAME project write the same
      // `todos.json`, and while `createTodo` holds a cross-process write lease (Phase 1), a
      // serial write costs nothing at this scale (N is capped at 25) and keeps file order equal
      // to response order.
      for (const item of result.items) {
        const root = roots.get(item.projectId);
        if (!root) {
          unassigned.push({
            title: item.title,
            reason: `project "${item.projectId}" is not registered in this workspace`,
          });
          continue;
        }
        try {
          const todo = await writeTodo(join(root, '.ai', 'cezar'), todoInputFor(item));
          items.push({
            projectId: item.projectId,
            projectName: item.projectName,
            todoId: todo.id,
            title: item.title,
            knowledgeRefs: item.knowledgeRefs,
          });
        } catch (error) {
          warn(`Task fan-out: could not file "${item.title}" in ${item.projectId}: ${describeError(error)}`);
          unassigned.push({
            title: item.title,
            reason: `could not be filed in ${item.projectName || item.projectId}: ${describeError(error)}`,
          });
        }
      }

      const response: TaskFanoutResponse = { items, unassigned, truncated: result.truncated };
      return c.json(response);
    },
  );
}

/** The engine's item as the todo store takes it. Empty strings and empty arrays are OMITTED
 *  rather than stored: `todoItemSchema` makes every spec field optional, and an absent field
 *  reads as "this pass produced none", where `""` reads as "it produced an empty one". */
function todoInputFor(item: EngineItem) {
  return {
    summary: item.title,
    ...(item.context ? { context: item.context } : {}),
    ...(item.whatToDo ? { whatToDo: item.whatToDo } : {}),
    ...(item.acceptanceCriteria.length > 0 ? { acceptanceCriteria: item.acceptanceCriteria } : {}),
    ...(item.knowledgeRefs.length > 0 ? { knowledgeRefs: item.knowledgeRefs } : {}),
    origin: 'composer' as const,
    // Every fan-out task is meant to be startable from the board — that is the whole flow. An
    // agent's plain append leaves this unset and infers; a composer-filed task states it.
    runnable: true,
  };
}
