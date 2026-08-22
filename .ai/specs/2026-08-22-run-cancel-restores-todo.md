# Cancelling a run un-hides its originating todo

## TLDR

13 runs in `cezar`'s own project queue on `prod-host` are stuck `status: "queued"`
(created 2026-08-21 21:16 through 2026-08-22 06:51, `maxParallel: 5`, 0 runs currently running —
the dispatcher itself looks stalled, a separate issue not addressed here). All 13 were started
from an already-filed todo in that project's `todos.json`. Starting a todo stamps
`startedTaskId` (`markStarted`), and the Filed board hides any todo carrying that field
(`isVisibleFiledEntry`) permanently — nothing today ever clears it. So these 13 backlog items are
currently invisible on both sides: not running, and not filed either.

This spec adds the missing lifecycle edge: **cancelling a run clears `startedTaskId` on the todo
it was started from**, so the todo reappears on the Filed board with its original
`status`/`priority`/body untouched. Server-only change, no wire-shape change. Once shipped,
cancelling each of the 13 stuck runs in production is the actual fix for the immediate problem.

## Problem

`markStarted` (`packages/cezar/src/todos.ts:399`) is the only writer of `startedTaskId`, and it is
one-directional: "Started → done" is the only path a todo has ever had off the hidden state.
"Started → cancelled" has no way back — a run that never does the work, or is abandoned
mid-flight, leaves its originating todo permanently invisible: not on the Filed board
(`isVisibleFiledEntry`, `packages/web/src/lib/filed-tasks.ts:76`, `!entry.todo.startedTaskId`)
and not running either. This is not hypothetical: it is the exact state 13 real todos are in
right now in cezar's own project.

## Solution

Add the inverse of `markStarted` and call it from the cancel route, best-effort, the same shape
`noteTodoStarted` already uses on the start side.

### `packages/cezar/src/todos.ts` — new `clearStartedTaskId`

Beside `markStarted`, add a function that looks the todo up **by `startedTaskId`** (the cancel
route only has the run id, never the todo id) and deletes the key:

```ts
export async function clearStartedTaskId(dataDir: string, taskId: string): Promise<TodoItem | undefined> {
  return withTodosLease(dataDir, async () => {
    const { items } = await readRaw(dataDir);
    const item = items.find((t) => t.startedTaskId === taskId);
    if (!item) return undefined;
    delete item.startedTaskId;
    await writeAtomic(dataDir, items);
    return item;
  });
}
```

Uses the same `withTodosLease`/`readRaw`/`writeAtomic` helpers `markStarted`/`updateTodo` already
use — no new locking code. No-op (`undefined`) when no todo references the given run id, mirroring
`markStarted`'s own best-effort contract (`if (!item || item.startedTaskId) return false;`).

### `packages/cezar/src/server/server.ts` — hook into `POST /runs/:id/cancel`

Current handler (`server.ts:4975`):

```ts
.post('/runs/:id/cancel', (c) => {
  const { store, manager } = c.get('project');
  const id = c.req.param('id');
  if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
  const cancelled = manager.cancel(id);
  return c.json({ cancelled });
})
```

Becomes async, destructuring `dataDir` off `c.get('project')` (already used the same way at
`server.ts:4362`, `4830`, `4910`, `4928`):

```ts
.post('/runs/:id/cancel', async (c) => {
  const { store, manager, dataDir } = c.get('project');
  const id = c.req.param('id');
  if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
  const cancelled = manager.cancel(id);
  if (cancelled) {
    try {
      await clearStartedTaskId(dataDir, id);
    } catch (err) {
      console.warn(`[cezar] could not clear started-todo link for cancelled run ${id}: ${String(err)}`);
    }
  }
  return c.json({ cancelled });
})
```

Best-effort and never blocks or fails the cancel itself — the same shape as `noteTodoStarted`
(`server.ts:4768`) on the start side: bookkeeping must never cost the user the action they asked
for. Applies uniformly regardless of the run's prior state (queued / actively running /
idle-parked waiting on approval) — cancelled always means this run is no longer doing the work, so
the backlog item should stop being hidden on its account. `manager.cancel(id)` already answers
`false` for a run that cannot be cancelled (e.g. already terminal), so the todo link is only
cleared when the cancel actually took effect.

### Why lookup is keyed on `startedTaskId`, not a stored todo id on the run

The run record has no `todoId` field today, and adding one is out of scope — `clearStartedTaskId`
does an O(n) scan of `todos.json` (bounded by inbox size, same cost `markStarted`'s own lookup by
`id` already pays on every start) rather than a second write path threading the todo id through
`RunManager`/`RunRecord`.

## Architecture

No new components. One new pure-data function in `todos.ts` (same module, same lease, same file
shape as every other todos.json writer); one new call site in the existing cancel route. No
change to `contract/src/skills.ts` (the wire twin) — the cancel response shape stays `{cancelled:
boolean}`, unchanged. No CLI change. No web change: `isVisibleFiledEntry` already keys on the
field's *absence*, so it needs nothing beyond the field actually being gone from disk.

```
POST /runs/:id/cancel
        |
        v
  manager.cancel(id) -> cancelled: boolean
        |
        v (cancelled === true)
  clearStartedTaskId(dataDir, id)   // best-effort, try/catch, never blocks the response
        |
        v
  find todo where todo.startedTaskId === id
        |
        v (found)
  delete todo.startedTaskId  -> writeAtomic(todos.json)
        |
        v
  isVisibleFiledEntry(todo) === true again -> todo reappears on Filed board
```

## Phases

1. `todos.ts`: add `clearStartedTaskId`.
2. `server.ts`: make the cancel route async, wire in `clearStartedTaskId` behind the existing
   `cancelled` check.
3. Tests: `todos.test.ts` unit coverage for `clearStartedTaskId`; a route-level test for
   `POST /runs/:id/cancel` covering the linked/unlinked/unknown-run cases.
4. Gates, commit, push to `origin`, deploy to `prod-host`.
5. Runtime E2E: cancel each of the 13 stuck queued runs in production via the route, verify per-id
   that the run's status becomes `cancelled` and the matching todo's `startedTaskId` is gone.
6. Corpus sync: changelog entry in the production cezar corpus.

## Data models

No schema change. `TodoItem.startedTaskId` (`todos.ts:50`, already `z.string().optional()`) goes
from write-once to write-then-clearable; no new field, no change to `todoSchema` or its wire twin
`todoItemSchema` (`contract/src/skills.ts`).

## API / interface contracts

`POST /api/v1/p/:project/runs/:id/cancel`

- Request: unchanged — no body.
- Response: unchanged — `{ cancelled: boolean }`.
- Side effect (new, not reflected in the response shape, matching how `noteTodoStarted`'s side
  effect on `POST /runs` is likewise invisible on the wire): when `cancelled` is `true`, any todo
  whose `startedTaskId` equals this run's id has that field removed from `todos.json`.
- 404 (unknown run id) and the `cancelled: false` case (run not cancellable) are both unchanged
  and never touch `todos.json`.

No new endpoint. No change to `contract/src/skills.ts` or any generated client type.

## Risks

- **Lease contention.** `clearStartedTaskId` takes the same `todos.lock` lease as every other
  todos.json writer, so a cancel racing a concurrent `POST /runs` (start) or a `PATCH /todos/:id`
  blocks briefly rather than corrupting the file — the existing, already-tested lease behaviour,
  not new risk.
- **Best-effort failure is silent by design.** A `todos.json` write failure during cancel only
  logs (`console.warn`), matching `noteTodoStarted`'s own contract on the start side — deliberate,
  so a filesystem hiccup never turns a successful cancel into a failed one. The tradeoff: a rare
  write failure here leaves a todo hidden despite its run being cancelled, recoverable by re-running
  the same cleanup this spec's E2E step performs.
- **No `todoId` on the run record.** `clearStartedTaskId` looks up by scanning for a matching
  `startedTaskId` rather than a direct id. Fine at current inbox scale (same cost `markStarted`
  already pays); would need revisiting if `todos.json` ever grows into the thousands of live
  entries.
- **One-off production cleanup is a separate, manual step** (this spec ships the mechanism; the 13
  stuck runs are fixed by calling the now-fixed route against production once deployed) — not
  automated, not retried if a specific id fails; failures are reported, not silently swallowed.

## Verification

- **Automated:**
  - `todos.test.ts`: `clearStartedTaskId` finds the todo by `startedTaskId` and deletes the key
    (assert `'startedTaskId' in item === false`, mirroring this file's existing
    `archivedAt`-restore assertion style); returns `undefined` when no todo references the given
    run id; a write blocked on a held lease waits then applies once the lease frees (mirroring the
    existing `updateTodo` lease test).
  - A route-level test for `POST /runs/:id/cancel`: cancelling a run started from a todo clears
    that todo's `startedTaskId` on disk; cancelling a run with no linked todo still 200s with
    `{cancelled: true}` and touches no todo file; cancelling an unknown run id still 404s,
    unchanged.
  - Full gate suite: `npm run typecheck && npm test && npm run test:unit && npm run build && npm
    run test:package` — must be green.
- **Runtime, on production (the actual fix):** mint a short-TTL session the doctrine's way
  (`createSession` from the built `dist/auth/session.js`, as the `cezar` user with
  `HOME=/var/lib/cezar`, destroyed after use), then `POST /api/v1/p/cezar/runs/:id/cancel` for
  each of the 13 queued run ids already identified. Verify per-id: the run's stored status becomes
  `cancelled`, and the matching todo's `startedTaskId` is gone from `todos.json`. Confirm the Filed
  board (`GET /api/v1/p/cezar/todos` / the cockpit) lists all 13 afterward as `todo`. This is a
  server-only, non-visual change, so no further browser E2E is needed beyond that board check.
  The dispatcher-looks-stalled observation (0 running against `maxParallel: 5` while things sat
  queued 12+ hours) is noted for the owner as a follow-up, not investigated or fixed here.
