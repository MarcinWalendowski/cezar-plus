import { describe, expect, it } from 'vitest';
import { classify, type BackupScope } from './paths.ts';

/**
 * N5 — the scope classification is **total and fail-closed**. Every filename any cezar store can
 * emit under `~/.cezar/` or `<root>/.ai/cezar/` must classify as `include` or `exclude`; a path
 * matching neither is `null`, which the engine refuses on. This is the negative control that keeps
 * a store added upstream later from silently falling out of (or into) the backup.
 *
 * The two enumerations below are drawn from a grep of every `join(cezarHomeDir(), …)` /
 * `<root>/.ai/cezar/…` filename in `src/` plus the `.ai/cezar/.gitignore` `wanted` list. When a
 * new store lands, its filename joins the right list here (or the guard fails), and `classify`
 * grows to match — that is the whole point.
 */

/** Every basename/relpath a store writes under `~/.cezar/`. */
const HOME_EMITS: Array<[relPath: string, expected: 'include' | 'exclude']> = [
  ['config.json', 'include'],
  ['config.json.bak', 'exclude'],
  ['agent-accounts.json', 'include'],
  ['ui-state.json', 'include'],
  ['notes.json', 'include'],
  ['notes-log.ndjson', 'include'],
  ['notifications.json', 'include'],
  ['identity/identity.json', 'include'],
  ['identity/identity.json.bak-20260815-162021', 'exclude'],
  ['identity/identity.lock', 'exclude'],
  ['notifications/outbox.ndjson', 'exclude'],
  ['notifications/outbox.lock', 'exclude'],
  ['server.json', 'exclude'],
  ['server.install.lock', 'exclude'],
  ['server-instances/example-com.json', 'exclude'],
  ['supervisor/state.json', 'exclude'],
  // the atomic-write temp suffix that momentarily exists beside any home file
  ['config.json.12345.deadbeef.tmp', 'exclude'],
];

/** Every basename/relpath a store writes under `<root>/.ai/cezar/`. */
const PROJECT_EMITS: Array<[relPath: string, expected: 'include' | 'exclude']> = [
  ['config.json', 'include'],
  ['sources.json', 'include'],
  ['sources.json.tmp', 'exclude'],
  ['source-state.json', 'exclude'],
  ['source-state.json.tmp', 'exclude'],
  ['source-log.ndjson', 'exclude'],
  ['source-comments.ndjson', 'exclude'],
  ['sources-poll.lock', 'exclude'],
  ['sources/notion/page-1.md', 'include'],
  ['automations.json', 'include'],
  ['automations.json.tmp', 'exclude'],
  ['automation-state.json', 'exclude'],
  ['automation-receipts.ndjson', 'exclude'],
  ['automation-log.ndjson', 'exclude'],
  ['automation-poll.lock', 'exclude'],
  ['runs.json', 'exclude'],
  ['runs.json.tmp', 'exclude'],
  ['runs/run-abc/events.ndjson', 'exclude'],
  ['todos.json', 'include'],
  ['todos.json.tmp', 'exclude'],
  ['todos.lock', 'exclude'],
  ['ui-state.json', 'include'],
  ['launch-key', 'exclude'],
  ['knowledge/architecture.md', 'include'],
  ['knowledge-index/catalog.ndjson', 'exclude'],
  ['knowledge-index/manifest.json', 'exclude'],
  ['worktrees/task-1/README.md', 'exclude'],
  ['tmp/scratch.json', 'exclude'],
];

describe('backup scope classification is total and fail-closed', () => {
  for (const [scope, emits] of [
    ['home', HOME_EMITS],
    ['project', PROJECT_EMITS],
  ] as Array<[BackupScope, typeof HOME_EMITS]>) {
    describe(`${scope} scope`, () => {
      for (const [relPath, expected] of emits) {
        it(`classifies ${relPath} as ${expected}`, () => {
          // Non-null is the load-bearing half: an emitted path that classifies to `null` is the
          // silent-drop / silent-ship bug this control exists to catch.
          const result = classify(scope, relPath);
          expect(result, `${relPath} must be classified, never unclassified`).not.toBeNull();
          expect(result).toBe(expected);
        });
      }
    });
  }

  it('fails closed: an unknown path classifies as null in both scopes', () => {
    // A secret or a lockfile a future store adds under a name nobody has seen must NOT default
    // into (or silently out of) the backup — it lands as `null`, which the engine refuses on.
    expect(classify('home', 'id_rsa')).toBeNull();
    expect(classify('home', 'oauth-tokens.secret')).toBeNull();
    expect(classify('project', 'future-store.json')).toBeNull();
    expect(classify('project', 'credentials/api.key')).toBeNull();
  });

  it('asserts the scope decision explicitly (N5)', () => {
    // The files the scope decision names, pinned so a refactor of `classify` cannot quietly move
    // them across the line.
    expect(classify('project', 'runs.json')).toBe('exclude');
    expect(classify('project', 'runs/x/events.ndjson')).toBe('exclude');
    expect(classify('project', 'knowledge-index/manifest.json')).toBe('exclude');
    expect(classify('project', 'launch-key')).toBe('exclude');
    expect(classify('home', 'config.json.bak')).toBe('exclude');
    expect(classify('project', 'knowledge/doc.md')).toBe('include');
    expect(classify('project', 'config.json')).toBe('include');
    expect(classify('home', 'config.json')).toBe('include');
    expect(classify('home', 'identity/identity.json')).toBe('include');
  });
});
