import { parseArgs } from 'node:util';
import { basename, join, resolve } from 'node:path';
import { createTodoInputSchema, type TodoKnowledgeRef } from '@loki-labs/better-cezar-contract';
import { createTodo, readTodos, type CreateTodoInput } from './todos.ts';
import { loadWorkspaceConfig } from './workspace/config.ts';
import { normalizeRoot } from './workspace/projects.ts';

/**
 * `cezar todo add|list` (Phase 1 of `.ai/specs/2026-08-19-file-tasks-from-a-running-task.md`).
 *
 * Writes straight to the target project's `.ai/cezar/todos.json` on the FILESYSTEM, exactly as
 * `cezar kb write` does for the knowledge base — never over HTTP, which sits behind the `/api/v1`
 * principal perimeter and 401s a headless caller (the loopback API host-metrics hit is the same
 * wall). This is what makes "file a task from a running task" real: a running agent already has a
 * repo checkout and a `Bash` tool, no cockpit session.
 *
 * `add` reuses the exact `todos.ts` store helpers (`createTodo`) and the exact wire schema
 * (`createTodoInputSchema`) the composer's `POST /:projectId/todos` validates against, so a
 * CLI-filed todo is byte-identical in shape to a composer-filed one — same Filed board, same
 * `/workspace/todos`, no restart required (both read `todos.json` per request).
 */

export interface TodoCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface TodoCliOptions {
  /** Repo root `--project` defaults to — resolved by the caller the same way `index.ts` resolves
   *  it for every other subcommand (git toplevel, falling back to cwd). */
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  io?: TodoCliIo;
}

const defaultIo: TodoCliIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

const USAGE = `usage:
  cezar todo add "<summary>" [--project <id|path>] [--context "..."] [--acceptance "..." ...]
                              [--priority low|medium|high] [--skill <name>] [--spec <path>]
                              [--start] [--json]
  cezar todo list [--project <id|path>] [--json]`;

const KNOWN_SUBCOMMANDS = new Set(['add', 'list']);

/**
 * `cez todo ...` entry point. Returns the process exit code, matching `runKnowledgeCommand`'s /
 * `runProjectsCommand`'s convention: 0 on success, 1 on a usage error or a genuine failure.
 */
export async function runTodoCommand(args: string[], opts: TodoCliOptions): Promise<number> {
  const io = opts.io ?? defaultIo;
  const [sub, ...rest] = args;

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    io.log(USAGE);
    return 0;
  }

  if (!KNOWN_SUBCOMMANDS.has(sub)) {
    io.error(`unknown todo subcommand: ${sub}`);
    io.error(USAGE);
    return 1;
  }

  try {
    return sub === 'add' ? await handleAdd(rest, opts.repoRoot, io) : await handleList(rest, opts.repoRoot, io);
  } catch (err) {
    io.error(`todo ${sub}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// ---- project resolution ------------------------------------------------------------------------

/**
 * `--project <id|path>`, resolved the same way the Risks section requires ("keep it within the
 * registered set and honor the same containment as `fs/browse`"): omitted means the caller's own
 * repo (no registry lookup at all, matching `cezar run`); given means EITHER a registered
 * project's id OR a path that resolves (by realpath) to a registered project's root — never an
 * arbitrary directory, registered or not.
 */
async function resolveProjectRoot(
  projectArg: string | undefined,
  defaultRoot: string,
): Promise<{ root: string } | { error: string }> {
  if (!projectArg) return { root: defaultRoot };
  const { projects } = await loadWorkspaceConfig();
  const byId = projects.find((p) => p.id === projectArg);
  if (byId) return { root: byId.root };
  const normalized = await normalizeRoot(resolve(projectArg));
  const byRoot = projects.find((p) => p.root === normalized);
  if (byRoot) return { root: byRoot.root };
  return { error: `unknown project: ${projectArg} (not a registered id or path — see: cezar projects)` };
}

/** The registered id of `root`, or its basename when `root` carries no registry entry (the boot
 *  repo itself, most commonly) — used only to fill `knowledgeRefs[].project` below, which is
 *  informational (rendered verbatim by the Filed detail dialog, never re-resolved). */
async function projectLabel(root: string): Promise<string> {
  const { projects } = await loadWorkspaceConfig();
  return projects.find((p) => p.root === root)?.id ?? basename(root);
}

// ---- add ----------------------------------------------------------------------------------------

const ADD_USAGE =
  'usage: cezar todo add "<summary>" [--project <id|path>] [--context "..."] [--acceptance "..." ...] ' +
  '[--priority low|medium|high] [--skill <name>] [--spec <path>] [--start] [--json]';

const PRIORITIES = new Set(['low', 'medium', 'high']);

/** `--spec <path>` becomes a `knowledgeRefs[]` entry (`todoKnowledgeRefSchema`: project/slug/title
 *  only, never a body). There is no live knowledge-store lookup in this CLI-only path, so the
 *  fields are built from what the caller already gave us: the path itself as `slug`, its basename
 *  (extension stripped) as `title`, and the FILING repo's own project label — the spec named on
 *  the command line lives in the run's own checkout, not necessarily the (possibly different)
 *  `--project` the todo is being filed into. */
async function buildSpecKnowledgeRef(specPath: string, filingRepoRoot: string): Promise<TodoKnowledgeRef> {
  return {
    project: await projectLabel(filingRepoRoot),
    slug: specPath,
    title: basename(specPath).replace(/\.[^./]+$/, '') || specPath,
  };
}

async function handleAdd(rest: string[], defaultRoot: string, io: TodoCliIo): Promise<number> {
  let values: {
    project?: string;
    context?: string;
    acceptance?: string[];
    priority?: string;
    skill?: string;
    spec?: string;
    start?: boolean;
    json?: boolean;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: {
        project: { type: 'string' },
        context: { type: 'string' },
        acceptance: { type: 'string', multiple: true },
        priority: { type: 'string' },
        skill: { type: 'string' },
        spec: { type: 'string' },
        start: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    }));
  } catch {
    io.error(ADD_USAGE);
    return 1;
  }

  const summary = positionals.join(' ').trim();
  if (!summary) {
    io.error(ADD_USAGE);
    return 1;
  }
  if (values.priority !== undefined && !PRIORITIES.has(values.priority)) {
    io.error(`cezar todo add: --priority must be one of low, medium, high (got "${values.priority}")`);
    return 1;
  }

  const resolved = await resolveProjectRoot(values.project, defaultRoot);
  if ('error' in resolved) {
    io.error(`cezar todo add: ${resolved.error}`);
    return 1;
  }

  const input: CreateTodoInput = {
    summary,
    origin: 'agent',
    status: 'todo',
    ...(values.context ? { context: values.context } : {}),
    ...(values.acceptance?.length ? { acceptanceCriteria: values.acceptance } : {}),
    ...(values.priority ? { priority: values.priority as 'low' | 'medium' | 'high' } : {}),
    ...(values.skill ? { suggestedSkill: values.skill } : {}),
    ...(values.start ? { autostart: true } : {}),
    ...(values.spec ? { knowledgeRefs: [await buildSpecKnowledgeRef(values.spec, defaultRoot)] } : {}),
  };

  const parsed = createTodoInputSchema.safeParse(input);
  if (!parsed.success) {
    io.error(`cezar todo add: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    return 1;
  }

  const dataDir = join(resolved.root, '.ai/cezar');
  const todo = await createTodo(dataDir, parsed.data);
  // TODO(analytics): emit `todo.filed` (origin, project, hasSpec) here once an event sink exists
  // — no analytics/telemetry mechanism exists anywhere in this codebase today (checked), so this
  // is left as a TODO rather than inventing one.

  if (values.json) {
    io.log(JSON.stringify({ todo }, null, 2));
    return 0;
  }
  io.log(`filed ${todo.id}  ${todo.summary}${values.start ? '  (auto-start)' : ''}`);
  return 0;
}

// ---- list -----------------------------------------------------------------------------------

const LIST_USAGE = 'usage: cezar todo list [--project <id|path>] [--json]';

async function handleList(rest: string[], defaultRoot: string, io: TodoCliIo): Promise<number> {
  let values: { project?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { project: { type: 'string' }, json: { type: 'boolean', default: false } },
      allowPositionals: true,
    }));
  } catch {
    io.error(LIST_USAGE);
    return 1;
  }

  const resolved = await resolveProjectRoot(values.project, defaultRoot);
  if ('error' in resolved) {
    io.error(`cezar todo list: ${resolved.error}`);
    return 1;
  }

  const dataDir = join(resolved.root, '.ai/cezar');
  const todos = await readTodos(dataDir);

  if (values.json) {
    io.log(JSON.stringify({ todos }, null, 2));
    return 0;
  }
  if (todos.length === 0) {
    io.log('no todos filed');
    return 0;
  }
  for (const todo of todos) {
    const flags = [todo.status ?? 'todo', todo.priority, todo.autostart ? 'autostart' : undefined, todo.startedTaskId ? 'started' : undefined]
      .filter((flag): flag is string => Boolean(flag))
      .join(', ');
    io.log(`${todo.id}  [${flags}]  ${todo.summary}`);
  }
  return 0;
}
