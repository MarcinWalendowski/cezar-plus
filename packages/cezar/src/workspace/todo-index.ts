import { basename, join } from 'node:path';
import type { WorkspaceProjectHealth } from '@loki-labs/better-cezar-contract';
import { readTodos, type TodoItem } from '../todos.ts';

/**
 * `WorkspaceTodoIndex` — the read path behind `GET /api/v1/workspace/todos` (D2 of
 * `.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`, Phase 1): the cross-project todo
 * board, so a fan-out that wrote into several projects is visible in one place.
 *
 * **READ never instantiates**, the same invariant `WorkspaceRunIndex`/`WorkspaceKnowledgeIndex`
 * hold: this module never imports `../server/project-context.ts`. It does not even need its own
 * fs/zod parsing — `readTodos()` (`../todos.ts`) is already a plain reader keyed on a `dataDir`
 * path, with no `ProjectContext` in sight, so listing every registered project's todos is just
 * deriving each one's `<root>/.ai/cezar` (the same hardcoded join `../workspace/run-index.ts`
 * uses for `runs.json`) and calling it.
 *
 * **`readTodos()` never `mkdirSync`s or writes on a plain read** (see its own doc comment): a
 * project that has never run cezar at all is read here without creating so much as an empty
 * `.ai/cezar` directory. That is what makes calling it, unmodified, safe for a board that walks
 * every registered project on every open.
 *
 * **Per-project degradation matches `readTodos()`'s own contract, not `WorkspaceRunIndex`'s.**
 * `readTodos()` never throws and never distinguishes "empty inbox" from "todos.json failed to
 * parse" — a malformed file degrades to `[]` with a `console.warn`, by design (`todos.ts`'s own
 * doc comment: "malformed ones are skipped with a warning, never fatal"). So `ok: false` here is
 * reported only for a `missing` project root — the one failure this index can see without
 * reading. An unreadable or corrupt `todos.json` still reports `ok: true, total: 0`,
 * indistinguishable from a project with nothing in its inbox; that is the existing contract
 * `readTodos()` gives every caller, not a new one invented for this board.
 *
 * Dependency-injected, not import-wired (the `WorkspaceRunIndex`/`WorkspaceKnowledgeIndex`
 * precedent): the registry lookup is a function the caller supplies, so tests stay hermetic and
 * never touch the real `~/.cezar` registry.
 */

/** One project this index may read from. Structurally a subset of `workspace/projects.ts`'s
 *  `ProjectListEntry` — injected rather than imported so a unit test never has to touch the real
 *  registry file. Mirrors `WorkspaceRunProjectSource`/`WorkspaceKnowledgeProjectSource`. */
export interface WorkspaceTodoProjectSource {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  name: string;
}

export interface WorkspaceTodoIndexDeps {
  /** The registry lookup, e.g. `workspace/projects.ts`'s `listProjects()` — injected so tests
   *  never read `~/.cezar`. A rejected promise degrades to an empty index rather than throwing. */
  listProjects: () => Promise<readonly WorkspaceTodoProjectSource[]>;
  /** Test seam: override the todos reader. Defaults to the real `readTodos()`. */
  readTodos?: (dataDir: string) => Promise<TodoItem[]>;
}

/** One todo, stamped with the registry slug of the project it lives in. */
export interface WorkspaceTodoEntry {
  project: string;
  todo: TodoItem;
}

export interface WorkspaceTodoListResult {
  todos: WorkspaceTodoEntry[];
  projects: WorkspaceProjectHealth[];
}

export class WorkspaceTodoIndex {
  private readonly readTodosFn: (dataDir: string) => Promise<TodoItem[]>;

  constructor(private readonly deps: WorkspaceTodoIndexDeps) {
    this.readTodosFn = deps.readTodos ?? readTodos;
  }

  private async resolveSources(): Promise<WorkspaceTodoProjectSource[]> {
    try {
      return [...(await this.deps.listProjects())];
    } catch {
      return [];
    }
  }

  /** Every registered project's todos, each stamped with its project id, plus one health row per
   *  considered project. No cap, no truncation: unlike the runs board this is not a growing event
   *  log — the inbox is a small, human-curated list a person is expected to clear. */
  async list(): Promise<WorkspaceTodoListResult> {
    const sources = await this.resolveSources();
    const projects: WorkspaceProjectHealth[] = [];
    const todos: WorkspaceTodoEntry[] = [];

    for (const source of sources) {
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
      const dataDir = join(source.root, '.ai', 'cezar');
      const items = await this.readTodosFn(dataDir);
      for (const todo of items) todos.push({ project: source.id, todo });
      projects.push({
        id: source.id,
        name: source.name || basename(source.root),
        status: source.status,
        ok: true,
        total: items.length,
      });
    }

    return { todos, projects };
  }
}
