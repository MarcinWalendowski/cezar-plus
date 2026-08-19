import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerProject } from './workspace/projects.ts';
import { runTodoCommand, type TodoCliIo } from './todo-cli.ts';

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
});
