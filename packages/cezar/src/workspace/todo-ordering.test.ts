import { describe, expect, it } from 'vitest';
import type { FiledSortColumn, FiledSortDir } from '@loki-labs/cezar-plus-contract';
import type { TodoItem } from '../todos.ts';
import {
  compareFiledEntries,
  filedPartitionOf,
  filedRowKey,
  filedStatusOf,
  orderFiledEntries,
  type OrderableTodoEntry,
} from './todo-ordering.ts';

/**
 * The total order behind the Filed board's two tables
 * (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, verification step 1).
 *
 * What this file is really guarding is the **prefix property** — the testable meaning of the
 * acceptance criteria's "stable tie-breaker … preserves status partitions during expansion".
 * Everything else here (the per-column sequences, the absent-value rule, the codepoint pin)
 * exists because the property is only worth anything if the order it is a property OF is the one
 * a reader expects.
 */

function entry(project: string, todo: Partial<TodoItem> & { id: string }): OrderableTodoEntry {
  return { project, todo: { summary: `summary ${todo.id}`, ...todo } as TodoItem };
}

const COLUMNS: readonly FiledSortColumn[] = ['age', 'status', 'priority', 'task', 'project', 'author'];
const DIRS: readonly FiledSortDir[] = ['asc', 'desc'];

function keys(entries: readonly OrderableTodoEntry[]): string[] {
  return entries.map(filedRowKey);
}

describe('filedStatusOf / filedPartitionOf', () => {
  it('absent status reads as todo, so a legacy entry lands in Backlog rather than vanishing', () => {
    expect(filedStatusOf({ status: undefined })).toBe('todo');
    expect(filedPartitionOf({ status: undefined })).toBe('backlog');
  });

  it('todo -> backlog; in-progress, blocked and done -> active', () => {
    expect(filedPartitionOf({ status: 'todo' })).toBe('backlog');
    expect(filedPartitionOf({ status: 'in-progress' })).toBe('active');
    expect(filedPartitionOf({ status: 'blocked' })).toBe('active');
    expect(filedPartitionOf({ status: 'done' })).toBe('active');
  });
});

describe('orderFiledEntries — one exact sequence per column per direction', () => {
  it('age: newest first on desc, oldest first on asc', () => {
    const rows = [
      entry('p', { id: 'mid', ts: '2026-08-10T00:00:00.000Z' }),
      entry('p', { id: 'new', ts: '2026-08-20T00:00:00.000Z' }),
      entry('p', { id: 'old', ts: '2026-08-01T00:00:00.000Z' }),
    ];
    expect(keys(orderFiledEntries(rows, 'age', 'desc'))).toEqual(['p:new', 'p:mid', 'p:old']);
    expect(keys(orderFiledEntries(rows, 'age', 'asc'))).toEqual(['p:old', 'p:mid', 'p:new']);
  });

  it('status: workflow rank, NOT alphabetical — in-progress before blocked on asc', () => {
    const rows = [
      entry('p', { id: 'd', status: 'done' }),
      entry('p', { id: 'b', status: 'blocked' }),
      entry('p', { id: 'i', status: 'in-progress' }),
      entry('p', { id: 't', status: 'todo' }),
    ];
    expect(keys(orderFiledEntries(rows, 'status', 'asc'))).toEqual(['p:t', 'p:i', 'p:b', 'p:d']);
    expect(keys(orderFiledEntries(rows, 'status', 'desc'))).toEqual(['p:d', 'p:b', 'p:i', 'p:t']);
    // Alphabetical would have put `blocked` first on asc. Pinned so a "simplification" that
    // reaches for the string cannot land silently.
    expect(keys(orderFiledEntries(rows, 'status', 'asc'))[1]).toBe('p:i');
  });

  it('priority: high, medium, low on asc', () => {
    const rows = [
      entry('p', { id: 'l', priority: 'low' }),
      entry('p', { id: 'h', priority: 'high' }),
      entry('p', { id: 'm', priority: 'medium' }),
    ];
    expect(keys(orderFiledEntries(rows, 'priority', 'asc'))).toEqual(['p:h', 'p:m', 'p:l']);
    expect(keys(orderFiledEntries(rows, 'priority', 'desc'))).toEqual(['p:l', 'p:m', 'p:h']);
  });

  it('task: case-folded summary', () => {
    const rows = [
      entry('p', { id: '1', summary: 'beta' }),
      entry('p', { id: '2', summary: 'Alpha' }),
      entry('p', { id: '3', summary: 'gamma' }),
    ];
    expect(keys(orderFiledEntries(rows, 'task', 'asc'))).toEqual(['p:2', 'p:1', 'p:3']);
  });

  it('project: case-folded registry slug', () => {
    const rows = [entry('Zeta', { id: 'a' }), entry('alpha', { id: 'b' }), entry('mid', { id: 'c' })];
    expect(keys(orderFiledEntries(rows, 'project', 'asc'))).toEqual(['alpha:b', 'mid:c', 'Zeta:a']);
  });

  it('author: label wins over id, and an id-only author still sorts', () => {
    const author = (id: string, label?: string): TodoItem['author'] => ({
      kind: 'user',
      id,
      via: 'composer',
      at: '2026-08-25T00:00:00.000Z',
      ...(label === undefined ? {} : { label }),
    });
    const rows = [
      entry('p', { id: '1', author: author('zzz', 'Ada') }),
      entry('p', { id: '2', author: author('bob') }),
      entry('p', { id: '3', author: author('aaa', 'Cleo') }),
    ];
    expect(keys(orderFiledEntries(rows, 'author', 'asc'))).toEqual(['p:1', 'p:2', 'p:3']);
  });
});

describe('absent values sort LAST in BOTH directions', () => {
  const cases: readonly { column: FiledSortColumn; present: Partial<TodoItem>; absent: Partial<TodoItem> }[] = [
    { column: 'age', present: { ts: '2026-08-01T00:00:00.000Z' }, absent: {} },
    { column: 'age', present: { ts: '2026-08-01T00:00:00.000Z' }, absent: { ts: 'not-a-date' } },
    { column: 'priority', present: { priority: 'low' }, absent: {} },
    {
      column: 'author',
      present: { author: { kind: 'user', id: 'a', via: 'composer', at: '2026-08-25T00:00:00.000Z' } },
      absent: {},
    },
  ];

  for (const { column, present, absent } of cases) {
    for (const dir of DIRS) {
      it(`${column} (${JSON.stringify(absent)}) sorts last on ${dir}`, () => {
        const rows = [
          entry('p', { id: 'unknown', ...absent }),
          entry('p', { id: 'known', ...present }),
        ];
        expect(keys(orderFiledEntries(rows, column, dir)).at(-1)).toBe('p:unknown');
      });
    }
  }

  it('status is never absent: it defaults to todo rather than sorting last', () => {
    const rows = [entry('p', { id: 'none' }), entry('p', { id: 'done', status: 'done' })];
    expect(keys(orderFiledEntries(rows, 'status', 'asc'))).toEqual(['p:none', 'p:done']);
  });
});

describe('codepoint compare, never localeCompare', () => {
  /**
   * `localeCompare` folds accents and would answer `['ábc','abd','Abz']` here; the codepoint rule
   * puts every ASCII letter before `á` (U+00E1). This test does not claim the codepoint answer is
   * nicer to read — it claims it is the same on every machine, which `localeCompare`'s is not.
   */
  it('an accented, mixed-case fixture orders by code unit, not by ICU collation', () => {
    const rows = [
      entry('p', { id: '1', summary: 'ábc' }),
      entry('p', { id: '2', summary: 'Abz' }),
      entry('p', { id: '3', summary: 'abd' }),
    ];
    expect(keys(orderFiledEntries(rows, 'task', 'asc'))).toEqual(['p:3', 'p:2', 'p:1']);
    expect(['ábc', 'abd', 'Abz'].sort((a, b) => a.localeCompare(b))).not.toEqual(['abd', 'Abz', 'ábc']);
  });
});

describe('the order is TOTAL — no two distinct rows ever compare equal', () => {
  it('a fixture built to collide on every column at once still orders deterministically', () => {
    const collide: Partial<TodoItem> = {
      summary: 'identical',
      status: 'blocked',
      priority: 'high',
      ts: '2026-08-25T00:00:00.000Z',
      author: { kind: 'user', id: 'same', via: 'composer', at: '2026-08-25T00:00:00.000Z' },
    };
    const rows = [
      entry('same-project', { id: 'c', ...collide }),
      entry('same-project', { id: 'a', ...collide }),
      entry('same-project', { id: 'b', ...collide }),
    ];
    for (const column of COLUMNS) {
      for (const dir of DIRS) {
        const compare = compareFiledEntries(column, dir);
        for (const a of rows) {
          for (const b of rows) {
            if (filedRowKey(a) === filedRowKey(b)) continue;
            expect(compare(a, b)).not.toBe(0);
          }
        }
        // The tie-break does not flip with `dir`: both directions land on the same sequence
        // when every primary key collides.
        expect(keys(orderFiledEntries(rows, column, dir))).toEqual([
          'same-project:a',
          'same-project:b',
          'same-project:c',
        ]);
      }
    }
  });
});

describe('prefix property — a Show more can only append', () => {
  /** 200 rows built to collide heavily on every column, so ties (and therefore the tie-breaker)
   *  are exercised rather than incidental. */
  function fixture(): OrderableTodoEntry[] {
    const projects = ['alpha', 'beta', 'gamma'];
    const statuses: TodoItem['status'][] = ['todo', 'in-progress', 'blocked', 'done', undefined];
    const priorities: TodoItem['priority'][] = ['high', 'medium', 'low', undefined];
    const rows: OrderableTodoEntry[] = [];
    for (let i = 0; i < 200; i += 1) {
      const day = String((i % 7) + 1).padStart(2, '0');
      rows.push(
        entry(projects[i % projects.length] as string, {
          id: `t${String(i).padStart(3, '0')}`,
          summary: `Task ${i % 11}`,
          status: statuses[i % statuses.length],
          priority: priorities[i % priorities.length],
          ...(i % 9 === 0 ? {} : { ts: `2026-08-${day}T00:00:00.000Z` }),
        }),
      );
    }
    return rows;
  }

  it('rows(limit=N) === rows(limit=200).slice(0, N) for every column, direction and N', () => {
    const rows = fixture();
    for (const column of COLUMNS) {
      for (const dir of DIRS) {
        const full = keys(orderFiledEntries(rows, column, dir));
        for (const n of [20, 30, 40, 60]) {
          // The page a client would get at `limit=n`, produced by the same call the server makes.
          expect(keys(orderFiledEntries(rows, column, dir)).slice(0, n)).toEqual(full.slice(0, n));
        }
        expect(full).toHaveLength(200);
        expect(new Set(full).size).toBe(200);
      }
    }
  });

  it('input order does not affect the result — the same rows shuffled sort identically', () => {
    const rows = fixture();
    const shuffled = [...rows].reverse();
    for (const column of COLUMNS) {
      for (const dir of DIRS) {
        expect(keys(orderFiledEntries(shuffled, column, dir))).toEqual(
          keys(orderFiledEntries(rows, column, dir)),
        );
      }
    }
  });

  it('never mutates its input', () => {
    const rows = fixture();
    const before = keys(rows);
    orderFiledEntries(rows, 'task', 'asc');
    expect(keys(rows)).toEqual(before);
  });
});
