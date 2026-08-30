import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { runRecordSchema } from './store.ts';
import { todoSchema, type CreateTodoInput } from '../todos.ts';
import {
  agentAuthor,
  authorFromAgentEnv,
  authorFromRequest,
  automationAuthor,
  inheritAuthor,
  localCliAuthor,
  systemAuthor,
  taskAuthorSchema,
  type TaskAuthor,
} from './task-author.ts';
import { createTodoInputSchema } from '@loki-labs/cezar-plus-contract';

/**
 * `author` — spec `.ai/specs/2026-08-21-task-author-provenance.md`.
 *
 * | Guard | Mutation that must turn it red |
 * |---|---|
 * | `kind: 'agent'` REQUIRES parentTaskId AND agentSessionId | drop the `.refine` |
 * | A pre-2026-08-21 record still parses | make `author` required on either record schema |
 * | A signed-in principal is a `user`, a scripted call is `api` | key the discriminator on the principal alone |
 * | `inheritAuthor` copies `at` verbatim | re-stamp it to `now` on the autostart hop |
 * | An agent env without a session id never claims `kind: 'agent'` | let `authorFromAgentEnv` fall through to `agent` |
 *
 * The first row is the owner's word "require", executable: *"if different agent sessions, require
 * what was parent task + agent session"*.
 */

const AT = '2026-08-21T10:00:00.000Z';

describe("taskAuthorSchema — kind 'agent' requires the parent task AND the session", () => {
  it('rejects an agent author carrying neither', () => {
    const result = taskAuthorSchema.safeParse({ kind: 'agent', id: 'r1', via: 'cli-todo-add', at: AT });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['parentTaskId']);
    expect(result.error.issues[0]?.message).toContain('parentTaskId and agentSessionId');
  });

  it('rejects an agent author carrying only the parent task', () => {
    expect(
      taskAuthorSchema.safeParse({ kind: 'agent', id: 'r1', via: 'cli-todo-add', at: AT, parentTaskId: 'r1' })
        .success,
    ).toBe(false);
  });

  it('rejects an agent author carrying only the session', () => {
    expect(
      taskAuthorSchema.safeParse({ kind: 'agent', id: 'r1', via: 'cli-todo-add', at: AT, agentSessionId: 's1' })
        .success,
    ).toBe(false);
  });

  it('accepts an agent author carrying both', () => {
    expect(
      taskAuthorSchema.safeParse({
        kind: 'agent',
        id: 'r1',
        via: 'cli-todo-add',
        at: AT,
        parentTaskId: 'r1',
        agentSessionId: 's1',
        parentStepId: 'implement',
      }).success,
    ).toBe(true);
  });

  it('leaves every other kind free of the requirement — the rule is about agents, not about parents', () => {
    for (const kind of ['user', 'api', 'automation', 'system'] as const) {
      expect(taskAuthorSchema.safeParse({ kind, id: 'x', via: 'composer', at: AT }).success).toBe(true);
    }
  });

  it('refuses an unknown `via` — a new creation path must add an enum value, which is the review moment', () => {
    expect(taskAuthorSchema.safeParse({ kind: 'user', id: 'local', via: 'other', at: AT }).success).toBe(false);
    expect(taskAuthorSchema.safeParse({ kind: 'user', id: 'local', via: 'unknown', at: AT }).success).toBe(false);
  });
});

describe('the field is additive — records written before 2026-08-21 still parse', () => {
  it('a run record with no `author` at all', () => {
    const legacy = {
      id: '11111111-2222-3333-4444-555555555555',
      title: 'fix the login bug',
      workflow: 'quick-task',
      task: 'fix the login bug',
      status: 'done',
      createdAt: AT,
      tokensUsed: 1234,
      archived: false,
      steps: [{ id: 'work', name: 'work', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 1234 }],
    };
    const parsed = runRecordSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.author).toBeUndefined();
  });

  it('a todos.json entry with no `author` — including a bare agent append', () => {
    expect(todoSchema.safeParse({ summary: 'ship the thing' }).success).toBe(true);
    expect(
      todoSchema.safeParse({ id: 't1', ts: AT, summary: 'ship it', origin: 'agent', status: 'todo' }).success,
    ).toBe(true);
  });

  it('a todos.json entry whose `author` is INVALID is rejected as one bad entry, not tolerated', () => {
    // `readTodos` skips a malformed entry with a warning rather than failing the file — the point
    // here is that a half-named agent author is malformed, so it can never masquerade as complete.
    expect(
      todoSchema.safeParse({ summary: 'x', author: { kind: 'agent', id: 'r1', via: 'cli-todo-add', at: AT } })
        .success,
    ).toBe(false);
  });
});

describe('authorFromRequest — telling a person from a program', () => {
  const noHeaders = () => undefined;

  it('a signed-in principal is a user, whatever the request looks like', () => {
    expect(
      authorFromRequest({ principal: { kind: 'session', userId: 'u_42' }, header: noHeaders }, 'composer'),
    ).toMatchObject({ kind: 'user', id: 'u_42', via: 'composer' });
  });

  it('no fetch metadata and a local principal is `api` — curl, a script, the api-client', () => {
    expect(
      authorFromRequest({ principal: { kind: 'local', userId: 'local' }, header: noHeaders }, 'composer'),
    ).toMatchObject({ kind: 'api', id: 'local' });
  });

  it('`Sec-Fetch-Site: same-origin` and a local principal is the cockpit, i.e. a user', () => {
    expect(
      authorFromRequest(
        {
          principal: { kind: 'local', userId: 'local' },
          header: (name) => (name === 'sec-fetch-site' ? 'same-origin' : undefined),
        },
        'composer',
      ),
    ).toMatchObject({ kind: 'user', id: 'local' });
  });

  it('an `Origin` the guard already accepted is a browser too', () => {
    expect(
      authorFromRequest(
        {
          principal: { kind: 'local', userId: 'local' },
          header: (name) => (name === 'origin' ? 'http://127.0.0.1:4317' : undefined),
        },
        'composer',
      ).kind,
    ).toBe('user');
  });

  it('`Sec-Fetch-Site: cross-site` is not the cockpit', () => {
    // The origin guard rejects these before a handler ever runs; if one somehow arrives, it is
    // certainly not "a person clicking in the cockpit".
    expect(
      authorFromRequest(
        {
          principal: { kind: 'local', userId: 'local' },
          header: (name) => (name === 'sec-fetch-site' ? 'cross-site' : undefined),
        },
        'composer',
      ).kind,
    ).toBe('api');
  });

  it('no principal at all still produces a valid author', () => {
    const author = authorFromRequest({ header: noHeaders }, 'workspace-composer');
    expect(taskAuthorSchema.safeParse(author).success).toBe(true);
    expect(author).toMatchObject({ kind: 'api', id: 'local', via: 'workspace-composer' });
  });
});

describe('authorFromAgentEnv — the parent task and the session, from a child process', () => {
  it('names both ids when the agent env carries them', () => {
    const author = authorFromAgentEnv(
      { CEZ_TASK_ID: 'run_parent', CEZ_SESSION_ID: 'sess_1', CEZ_STEP_ID: 'implement' },
      'cli-todo-add',
    );
    expect(author).toMatchObject({
      kind: 'agent',
      id: 'run_parent',
      via: 'cli-todo-add',
      parentTaskId: 'run_parent',
      agentSessionId: 'sess_1',
      parentStepId: 'implement',
    });
    expect(taskAuthorSchema.safeParse(author).success).toBe(true);
  });

  it('a person in their own terminal is the local user', () => {
    expect(authorFromAgentEnv({}, 'cli-todo-add')).toMatchObject({ kind: 'user', id: 'local' });
  });

  it('EMPTY env values read as absent — a nested cezar must not inherit a stale session', () => {
    expect(authorFromAgentEnv({ CEZ_TASK_ID: '', CEZ_SESSION_ID: '' }, 'cli-todo-add')).toMatchObject({
      kind: 'user',
      id: 'local',
    });
  });

  it('a task id without a session never claims `agent` — but the id it does have is kept', () => {
    const author = authorFromAgentEnv({ CEZ_TASK_ID: 'run_parent' }, 'cli-todo-add');
    expect(author.kind).not.toBe('agent');
    expect(author).toMatchObject({ kind: 'user', id: 'local', parentTaskId: 'run_parent' });
    expect(taskAuthorSchema.safeParse(author).success).toBe(true);
  });
});

describe('inheritAuthor — the autostart hop', () => {
  const filed: TaskAuthor = {
    kind: 'agent',
    id: 'run_parent',
    via: 'cli-todo-add',
    at: AT,
    parentTaskId: 'run_parent',
    agentSessionId: 'sess_1',
  };

  it('copies the author verbatim and only changes `via`', () => {
    expect(inheritAuthor(filed, 'todo-autostart')).toEqual({ ...filed, via: 'todo-autostart' });
  });

  it('keeps `at` — it names when the AGENT acted, not when the machinery noticed', () => {
    expect(inheritAuthor(filed, 'todo-autostart').at).toBe(AT);
  });

  it('a legacy todo with no author degrades to `system`, never to a guess', () => {
    expect(inheritAuthor(undefined, 'todo-autostart')).toMatchObject({ kind: 'system', id: 'cezar' });
  });
});

describe('the remaining constructors', () => {
  it('agentAuthor names the parent run as both `id` and `parentTaskId`', () => {
    expect(agentAuthor({ taskId: 'run_spec', sessionId: 's1', stepId: 'spec' }, 'note-continuation')).toMatchObject({
      kind: 'agent',
      id: 'run_spec',
      parentTaskId: 'run_spec',
      agentSessionId: 's1',
      parentStepId: 'spec',
    });
  });

  it('agentAuthor without a session yields `system` that STILL names the parent — never an invalid agent', () => {
    const author = agentAuthor({ taskId: 'run_spec' }, 'note-continuation');
    expect(author).toMatchObject({ kind: 'system', parentTaskId: 'run_spec' });
    expect(taskAuthorSchema.safeParse(author).success).toBe(true);
  });

  it('automationAuthor carries the automation id', () => {
    expect(automationAuthor('auto_7')).toMatchObject({ kind: 'automation', id: 'auto_7', via: 'automation' });
  });

  it('localCliAuthor is a person at a terminal', () => {
    expect(localCliAuthor()).toMatchObject({ kind: 'user', id: 'local', via: 'cli-run' });
  });

  it('every constructor produces a schema-valid author with an ISO `at`', () => {
    const authors = [
      authorFromRequest({ header: () => undefined }, 'composer'),
      authorFromAgentEnv({ CEZ_TASK_ID: 'r', CEZ_SESSION_ID: 's' }, 'cli-todo-add'),
      inheritAuthor(undefined, 'todo-autostart'),
      agentAuthor({ taskId: 'r', sessionId: 's' }, 'note-continuation'),
      automationAuthor('a'),
      systemAuthor('todo-autostart'),
      localCliAuthor(),
    ];
    for (const author of authors) {
      expect(taskAuthorSchema.safeParse(author).success).toBe(true);
      expect(Number.isNaN(Date.parse(author.at))).toBe(false);
    }
  });
});

/**
 * `taskAuthorSchema` exists TWICE — persisted (`runs/task-author.ts`) and wire
 * (`contract/src/task-author.ts`) — exactly the way `runRecordSchema` and `todoItemSchema`
 * already do. `AGENTS.md`'s "two handlers, one guard, is the same bug at rest" is the standing
 * warning, and the runs pair's compile-time parity suite cannot see this one: `author` is
 * OPTIONAL on both records, and an extra optional property is assignable in both directions, so
 * `Exact<>` stays green on real drift here.
 *
 * So this guard reads BOTH FILES AS TEXT. Not through an import: a specifier resolves through
 * `node_modules`, which pins whichever copy of the contract package happens to be installed —
 * in a git worktree, a different checkout entirely — and a drift guard that can silently check
 * the wrong file is worse than none.
 *
 * Each extraction is asserted NON-EMPTY first. That is the positive control, and it is the whole
 * reason this is trustworthy: a regex that quietly matches nothing compares `[]` to `[]` and
 * passes forever.
 */
describe('the two taskAuthorSchema twins say the same thing', () => {
  const HERE = import.meta.dirname;
  const persisted = readFileSync(join(HERE, 'task-author.ts'), 'utf8');
  const wire = readFileSync(join(HERE, '../../../contract/src/task-author.ts'), 'utf8');

  /** The string members of `z.enum([...])` assigned to `name`. */
  const enumMembers = (source: string, name: string): string[] => {
    const start = source.indexOf(`${name} = z.enum([`);
    if (start < 0) return [];
    const end = source.indexOf(']);', start);
    if (end < 0) return [];
    return [...source.slice(start, end).matchAll(/'([a-z-]+)'/g)].map((m) => m[1] as string);
  };

  /** The keys of the `taskAuthorSchema` object literal, in declaration order. */
  const authorKeys = (source: string): string[] => {
    const start = source.indexOf('taskAuthorSchema = z');
    if (start < 0) return [];
    const end = source.indexOf('.refine(', start);
    if (end < 0) return [];
    return [...source.slice(start, end).matchAll(/^ {4}([a-zA-Z]+):/gm)].map((m) => m[1] as string);
  };

  it('the `via` enum has the same members, in the same order', () => {
    const mine = enumMembers(persisted, 'taskAuthorViaSchema');
    expect(mine.length).toBeGreaterThan(5); // positive control: the regex found something real
    expect(mine).toContain('cli-todo-add');
    expect(enumMembers(wire, 'taskAuthorViaSchema')).toEqual(mine);
  });

  it('the `kind` enum has the same members, in the same order', () => {
    const mine = enumMembers(persisted, 'taskAuthorKindSchema');
    expect(mine).toEqual(['user', 'api', 'agent', 'automation', 'system']);
    expect(enumMembers(wire, 'taskAuthorKindSchema')).toEqual(mine);
  });

  it('the object carries the same fields, in the same order', () => {
    const mine = authorKeys(persisted);
    expect(mine).toEqual([
      'kind',
      'id',
      'label',
      'via',
      'at',
      'parentTaskId',
      'agentSessionId',
      'parentStepId',
    ]);
    expect(authorKeys(wire)).toEqual(mine);
  });

  it('both carry the `agent` refinement, naming the same two fields', () => {
    for (const source of [persisted, wire]) {
      expect(source).toContain("a.kind !== 'agent' || (Boolean(a.parentTaskId) && Boolean(a.agentSessionId))");
      expect(source).toContain("path: ['parentTaskId']");
    }
  });

  it('both todo twins carry `author`, and BOTH withhold it from the create input', () => {
    const persistedTodos = readFileSync(join(HERE, '../todos.ts'), 'utf8');
    const wireTodos = readFileSync(join(HERE, '../../../contract/src/skills.ts'), 'utf8');
    expect(persistedTodos).toContain('author: taskAuthorSchema.optional()');
    expect(wireTodos).toContain('author: taskAuthorSchema.optional()');
    // Server-stamped on both sides: the wire schema `.omit()`s it, the persisted `CreateTodoInput`
    // `Omit<>`s it. Neither route can set an author, so neither can rewrite one.
    expect(wireTodos).toContain('author: true,');
  });

  /**
   * **Rewritten 2026-08-23. This assertion used to be `expect(persistedTodos).toContain("|
   * 'archivedAt' | 'author'")` and it broke on FORMATTING, not on a regression.** The cluster work
   * took `CreateTodoInput`'s `Omit<>` from five members to eleven, which wrapped it across lines,
   * and the single-line literal stopped matching while every property it was guarding still held.
   *
   * A string search over source is the weakest form this check can take: it goes red when nobody
   * broke anything, and — the worse half — it goes green for a match inside a comment or an
   * unrelated identifier. Both directions are wrong, so the fix is not a better string.
   *
   * Each twin gets the strongest check its own nature allows:
   *  - the **wire** side is a zod object, so its shape is real at runtime and `expect` can read it;
   *  - the **persisted** side is a TypeScript `Omit<>` that does not exist at runtime, which is why
   *    the original reached for source text at all. `expectTypeOf` is the right instrument: it is
   *    inert when the suite runs, and the assertion is checked by `tsc -p tsconfig.test.json` —
   *    this repo's actual typecheck gate, which these test files are already inside.
   *
   * Neither version can be broken by reformatting, and neither can be satisfied by a comment.
   */
  it('neither create input admits `author` — checked structurally, not by reading source', () => {
    // Wire side: a real runtime read of the schema's shape.
    expect(Object.keys(createTodoInputSchema.shape)).not.toContain('author');
    // Floor: the key is genuinely absent, not the whole shape empty or the import wrong.
    expect(Object.keys(createTodoInputSchema.shape)).toContain('summary');

    // Persisted side: a compile-time assertion, enforced by tsc rather than at run time.
    //
    // **Its failure signature is cryptic, so recognise it here rather than debugging it there.**
    // Verified by mutation (dropping `| 'author'` from `CreateTodoInput`'s `Omit<>`): tsc reports
    // `error TS2554: Expected 2 arguments, but got 1` on THIS line, because vitest's typed API
    // changes the assertion's arity when the type does not hold. That message says nothing about
    // `author`. If you see it here, it means `author` leaked back into the create input — go look
    // at the `Omit<>` in `todos.ts`, not at this call's argument count.
    expectTypeOf<CreateTodoInput>().not.toHaveProperty('author');
    // Same floor, so a `CreateTodoInput` that had collapsed to `never`/`unknown` — which would
    // satisfy every `not.toHaveProperty` above — still fails here.
    expectTypeOf<CreateTodoInput>().toHaveProperty('summary');
  });
});
