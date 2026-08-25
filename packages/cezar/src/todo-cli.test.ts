import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerProject } from './workspace/projects.ts';
import { runTodoCommand, type TodoCliIo } from './todo-cli.ts';
import { todoSchema } from './todos.ts';

/**
 * `cezar todo add|list` (Phase 1, `.ai/specs/2026-08-19-file-tasks-from-a-running-task.md`).
 * Every case pins `CEZ_HOME` to a temp dir — `--project` resolution reads the real project
 * registry, and this suite must never touch the developer's own `~/.cezar`, matching
 * `workspace/projects-cli.test.ts`'s own convention.
 */
describe('cezar todo add/list', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let io: TodoCliIo & { out: string[]; err: string[] };
  const cleanups: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-todo-cli-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-todo-cli-repo-'));
    process.env.CEZ_HOME = home;
    const out: string[] = [];
    const err: string[] = [];
    io = { out, err, log: (l) => out.push(l), error: (l) => err.push(l) };
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const run = (...args: string[]): Promise<number> => runTodoCommand(args, { repoRoot, io });
  /** The same call with an AGENT's environment — what a `cezar todo add` from inside a run sees. */
  const runAsAgent = (env: NodeJS.ProcessEnv, ...args: string[]): Promise<number> =>
    runTodoCommand(args, { repoRoot, io, env });
  const readTodosFile = (root: string): unknown[] =>
    JSON.parse(readFileSync(join(root, '.ai/cezar/todos.json'), 'utf8'));

  it('no subcommand prints usage and exits 0', async () => {
    expect(await run()).toBe(0);
    expect(io.out.join('\n')).toContain('cezar todo add');
  });

  it('an unknown subcommand exits 1 with usage', async () => {
    expect(await run('bogus')).toBe(1);
    expect(io.err.join('\n')).toContain('unknown todo subcommand');
  });

  describe('add', () => {
    it('summary-only writes a schema-valid, origin:agent todo into the current repo', async () => {
      expect(await run('add', 'Fix the thing')).toBe(0);
      const todos = readTodosFile(repoRoot);
      expect(todos).toHaveLength(1);
      expect(todos[0]).toMatchObject({ summary: 'Fix the thing', origin: 'agent', status: 'todo' });
      expect((todos[0] as Record<string, unknown>).autostart).toBeUndefined();
    });

    it('an agent env stamps the filing task AND session as the author', async () => {
      // The owner's third requirement, end to end: a task filed from inside a run names the parent
      // task and the agent session inside it (spec 2026-08-21-task-author-provenance).
      expect(
        await runAsAgent(
          { CEZ_TASK_ID: 'run_parent', CEZ_SESSION_ID: 'sess_1', CEZ_STEP_ID: 'implement' },
          'add',
          'Fix the thing',
        ),
      ).toBe(0);
      const todo = readTodosFile(repoRoot)[0] as Record<string, unknown>;
      expect(todo.author).toMatchObject({
        kind: 'agent',
        id: 'run_parent',
        via: 'cli-todo-add',
        parentTaskId: 'run_parent',
        agentSessionId: 'sess_1',
        parentStepId: 'implement',
      });
      // `origin` is unchanged and is NOT this field: it says 'agent' whoever the caller is.
      expect(todo.origin).toBe('agent');
    });

    it('a person in their own terminal is the local user, not an agent', async () => {
      // The distinction `origin: 'agent'` — hard-coded on every call — structurally cannot make.
      expect(await runAsAgent({}, 'add', 'Fix the thing')).toBe(0);
      const todo = readTodosFile(repoRoot)[0] as Record<string, unknown>;
      expect(todo.author).toMatchObject({ kind: 'user', id: 'local', via: 'cli-todo-add' });
      expect(todo.origin).toBe('agent');
    });

    it('a parent task with no session never claims `agent` — and the todo still validates', async () => {
      expect(await runAsAgent({ CEZ_TASK_ID: 'run_parent' }, 'add', 'Fix the thing')).toBe(0);
      const todo = readTodosFile(repoRoot)[0] as Record<string, unknown>;
      expect((todo.author as Record<string, unknown>).kind).not.toBe('agent');
      expect(todoSchema.safeParse(todo).success).toBe(true);
    });

    it('a multi-word positional summary is joined with spaces', async () => {
      expect(await run('add', 'Fix', 'the', 'thing')).toBe(0);
      expect(readTodosFile(repoRoot)[0]).toMatchObject({ summary: 'Fix the thing' });
    });

    it('fully-specified: context, acceptance criteria, priority, skill, spec and --start all land', async () => {
      expect(
        await run(
          'add',
          'Implement the spec',
          '--context',
          'because reasons',
          '--acceptance',
          'a',
          '--acceptance',
          'b',
          '--priority',
          'high',
          '--skill',
          'my-skill',
          '--spec',
          '.ai/specs/2026-08-19-file-tasks-from-a-running-task.md',
          '--start',
        ),
      ).toBe(0);
      const [todo] = readTodosFile(repoRoot) as Array<Record<string, unknown>>;
      expect(todo).toMatchObject({
        summary: 'Implement the spec',
        context: 'because reasons',
        acceptanceCriteria: ['a', 'b'],
        priority: 'high',
        suggestedSkill: 'my-skill',
        autostart: true,
      });
      expect(todo!.knowledgeRefs).toEqual([
        {
          project: expect.any(String),
          slug: '.ai/specs/2026-08-19-file-tasks-from-a-running-task.md',
          title: '2026-08-19-file-tasks-from-a-running-task',
        },
      ]);
    });

    it('--json prints the stored todo', async () => {
      expect(await run('add', 'Ship it', '--json')).toBe(0);
      const parsed = JSON.parse(io.out.join('\n'));
      expect(parsed.todo.summary).toBe('Ship it');
    });

    it('rejects a missing summary with usage and exit 1, no file written', async () => {
      expect(await run('add')).toBe(1);
      expect(io.err.join('\n')).toContain('usage:');
    });

    it('rejects an invalid --priority', async () => {
      expect(await run('add', 'x', '--priority', 'urgent')).toBe(1);
      expect(io.err.join('\n')).toContain('--priority');
    });

    it('--project resolves a registered project by id and writes there, not the current repo', async () => {
      const other = mkdtempSync(join(realpathSync(tmpdir()), 'cez-todo-cli-other-'));
      cleanups.push(other);
      const entry = await registerProject(other);
      expect(await run('add', 'For the other repo', '--project', entry.id)).toBe(0);
      expect(readTodosFile(other)).toHaveLength(1);
    });

    it('--project also accepts a registered project by path', async () => {
      const other = mkdtempSync(join(realpathSync(tmpdir()), 'cez-todo-cli-other-path-'));
      cleanups.push(other);
      await registerProject(other);
      expect(await run('add', 'For the other repo', '--project', other)).toBe(0);
      expect(readTodosFile(other)).toHaveLength(1);
    });

    it('an unregistered --project is rejected outright, never silently written', async () => {
      const stray = mkdtempSync(join(realpathSync(tmpdir()), 'cez-todo-cli-stray-'));
      cleanups.push(stray);
      expect(await run('add', 'x', '--project', stray)).toBe(1);
      expect(io.err.join('\n')).toContain('unknown project');
    });

    it('autostart is set only with --start', async () => {
      expect(await run('add', 'Backlog only')).toBe(0);
      expect((readTodosFile(repoRoot)[0] as Record<string, unknown>).autostart).toBeUndefined();
    });
  });

  describe('list', () => {
    it('reports no todos filed for an empty inbox', async () => {
      expect(await run('list')).toBe(0);
      expect(io.out.join('\n')).toContain('no todos filed');
    });

    it('prints a filed todo', async () => {
      await run('add', 'Ship it');
      expect(await run('list')).toBe(0);
      expect(io.out.join('\n')).toContain('Ship it');
    });

    it('--json prints the array', async () => {
      await run('add', 'Ship it');
      expect(await run('list', '--json')).toBe(0);
      const parsed = JSON.parse(io.out[io.out.length - 1]!);
      expect(parsed.todos).toHaveLength(1);
    });
  });

  /**
   * `cezar todo start <id>` (`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md`, Phase 2) —
   * the flip that `input-to-tasks`'s optional `dispatch` step performs on a todo its own `file`
   * step already filed WITHOUT `--start`.
   */
  describe('start', () => {
    /** File one todo and return its id, without going near `--start`. */
    const fileOne = async (summary = 'Ship it'): Promise<string> => {
      await run('add', summary, '--json');
      const parsed = JSON.parse(io.out[io.out.length - 1]!);
      io.out.length = 0;
      return parsed.todo.id as string;
    };

    it('sets autostart on an already-filed todo', async () => {
      const id = await fileOne();
      // The precondition is the point: `add` without `--start` must NOT have set it, or this
      // test would pass against a `start` that does nothing at all.
      expect((readTodosFile(repoRoot)[0] as { autostart?: boolean }).autostart).toBeUndefined();

      expect(await run('start', id)).toBe(0);
      expect((readTodosFile(repoRoot)[0] as { autostart?: boolean }).autostart).toBe(true);
    });

    it('accepts an id prefix, because that is what a transcript quotes', async () => {
      const id = await fileOne();
      expect(await run('start', id.slice(0, 8))).toBe(0);
      expect((readTodosFile(repoRoot)[0] as { autostart?: boolean }).autostart).toBe(true);
    });

    it('refuses an ambiguous prefix rather than picking one', async () => {
      await fileOne('first');
      await fileOne('second');
      // Rewrite both ids to a KNOWN shared prefix. Generated uuids only collide on a short prefix
      // by luck, and a test that asserts nothing when the luck runs out is a test that reports
      // green for a `start` with no ambiguity check at all.
      const path = join(repoRoot, '.ai/cezar/todos.json');
      const items = readTodosFile(repoRoot) as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      items[0]!.id = 'aaaaaaaa-1111-4111-8111-111111111111';
      items[1]!.id = 'aaaaaaaa-2222-4222-8222-222222222222';
      writeFileSync(path, JSON.stringify(items, null, 2));

      expect(await run('start', 'aaaaaaaa')).toBe(1);
      expect(io.err.join('\n')).toContain('ambiguous');
      // And nothing was flipped on the way to refusing.
      const after = readTodosFile(repoRoot) as Array<{ autostart?: boolean }>;
      expect(after.every((t) => t.autostart === undefined)).toBe(true);
    });

    it('exits 1 for an unknown id', async () => {
      await fileOne();
      expect(await run('start', 'ffffffff-0000-0000-0000-000000000000')).toBe(1);
      expect(io.err.join('\n')).toContain('no todo with id');
    });

    it('refuses a todo the cockpit already picked up', async () => {
      const id = await fileOne();
      const path = join(repoRoot, '.ai/cezar/todos.json');
      const items = readTodosFile(repoRoot) as Array<Record<string, unknown>>;
      items[0]!.startedTaskId = 'run-1';
      writeFileSync(path, JSON.stringify(items, null, 2));

      expect(await run('start', id)).toBe(1);
      expect(io.err.join('\n')).toContain('already started');
    });

    it('needs an id', async () => {
      expect(await run('start')).toBe(1);
      expect(io.err.join('\n')).toContain('cezar todo start');
    });
  });
});
