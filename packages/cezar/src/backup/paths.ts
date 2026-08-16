/**
 * The backup set — an explicit, fail-closed **include manifest** for the durable, cezar-owned
 * corpus (spec `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`). It is an allowlist,
 * like `ensureDataGitignore`'s `wanted` array, and for the same reason: a denylist would silently
 * ship the next secret or lockfile a future store adds. The classification is **total** — every
 * filename any store can emit is either included or excluded, and a path matching neither is an
 * `unclassified` result, which is a failure the engine refuses on rather than a default. The N5
 * negative-control test (`./paths.test.ts`) is what keeps it total: a new store added upstream
 * later cannot silently fall out of, or into, the backup.
 *
 * Backup ≠ gitignore. `<root>/.ai/cezar/.gitignore` ignores `sources/`, `todos.json` and others as
 * machine-local, but backup *includes* them: they are durable cezar-owned state worth restoring.
 * The two answer different questions.
 *
 * Two scopes:
 *  - `home` — paths relative to `~/.cezar/` (`cezarHomeDir()`): the registry, identity, notes,
 *    agent accounts, workspace UI state and notification config.
 *  - `project` — paths relative to a registered project's `<root>/.ai/cezar/`: the writable
 *    knowledge content, mirrored sources, and the sources/automations/todos config.
 *
 * Excluded everywhere: the mounted read-only corpora (`.ai/specs`, `docs` — already in the user's
 * own git repos), run history/transcripts (per the scope decision), derived/rebuildable indexes,
 * per-machine install/runtime state, and every secret and lockfile.
 */

export type BackupScope = 'home' | 'project';
export type Classification = 'include' | 'exclude';

/** `~/.cezar/`-relative paths that ARE backed up. */
export const HOME_INCLUDE: readonly string[] = [
  'config.json', // the project registry + global defaults
  'identity/identity.json', // orgs / teams / users / memberships / sessions / invites
  'notes.json', // the workspace capture inbox
  'notes-log.ndjson', // its pass-receipt log
  'agent-accounts.json', // second logins + per-project agent selection
  'ui-state.json', // cross-project GUI prefs
  // `backup.json` is the backup subsystem's OWN config (provider/cadence/retention/include set);
  // every secret is in env and only its VAR NAME appears here, so the file is durable and
  // non-secret. Restoring it means a recovered machine keeps its backup settings, so it is
  // INCLUDED — it is `config.json`'s sibling under `~/.cezar/`. Leaving it unclassified silently
  // dropped it from every backup (and, once the walk fails closed, would have refused every run).
  'backup.json',
  // `notifications.json` is durable, non-secret transport config (the S3/webhook secrets live in
  // env, resolved at use time — `notifications/secrets.ts`). Restoring a machine's notification
  // setup is wanted, so it is INCLUDED. This refines the spec's representative home-include list,
  // which did not name it; N5's total-classification requirement forced the call.
  'notifications.json',
];

/** `<root>/.ai/cezar/`-relative FILES that ARE backed up (directory trees handled separately). */
export const PROJECT_INCLUDE_FILES: readonly string[] = [
  'config.json',
  'sources.json',
  'automations.json',
  'todos.json',
  'ui-state.json',
];

/** `<root>/.ai/cezar/`-relative directory prefixes whose whole subtree is backed up. */
export const PROJECT_INCLUDE_DIRS: readonly string[] = [
  'knowledge/', // the writable KB content (NOT `knowledge-index/`, which is derived)
  'sources/', // mirrored external content
];

/** A basename that is a backup/lock/temp artefact, in EITHER scope — never backed up. */
function isTransientArtefact(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  // Backup/lock/temp artefacts: `.bak`, `.bak-20260815-162021`; `*.lock`; the atomic-write temp
  // suffix `*.tmp`. Plus filesystem junk that can appear in any directory — macOS `.DS_Store` and
  // AppleDouble `._*` sidecars (created on non-native volumes). Excluding OS detritus keeps the
  // engine's fail-closed walk refusing only on a genuinely-unclassified *cezar* file, never on
  // stray junk that would otherwise brick every scheduled run.
  return (
    /\.bak(-|$)/.test(base) ||
    base.endsWith('.lock') ||
    base.endsWith('.tmp') ||
    base === '.DS_Store' ||
    base.startsWith('._')
  );
}

function classifyHome(relPath: string): Classification | null {
  if (HOME_INCLUDE.includes(relPath)) return 'include';
  if (isTransientArtefact(relPath)) return 'exclude';
  if (relPath === 'server.json') return 'exclude'; // host-level install state, machine-pinned
  if (relPath.startsWith('server-instances/')) return 'exclude'; // per-domain install state
  if (relPath.startsWith('supervisor/')) return 'exclude'; // runtime
  if (relPath === 'notifications/outbox.ndjson') return 'exclude'; // transient outbox
  return null; // unclassified ⇒ fail-closed
}

function classifyProject(relPath: string): Classification | null {
  // Include wins first: `ui-state.json` ends in `-state.json`, which the runtime-state exclude
  // below would otherwise swallow.
  if (PROJECT_INCLUDE_FILES.includes(relPath)) return 'include';
  if (PROJECT_INCLUDE_DIRS.some((dir) => relPath.startsWith(dir))) return 'include';
  if (isTransientArtefact(relPath)) return 'exclude';
  if (relPath === 'runs.json' || relPath.startsWith('runs/')) return 'exclude'; // run logs (scope decision)
  if (relPath.startsWith('knowledge-index/')) return 'exclude'; // derived/rebuildable (incl. embeddings blob)
  if (relPath === 'launch-key') return 'exclude'; // per-repo secret
  if (relPath.startsWith('worktrees/')) return 'exclude'; // transient git worktrees
  if (relPath.startsWith('tmp/')) return 'exclude'; // scratch
  if (relPath.endsWith('-state.json')) return 'exclude'; // automation-state.json, source-state.json
  if (relPath.endsWith('-receipts.ndjson')) return 'exclude'; // automation-receipts.ndjson
  if (relPath.endsWith('-log.ndjson')) return 'exclude'; // automation-log.ndjson, source-log.ndjson
  if (relPath === 'source-comments.ndjson') return 'exclude'; // runtime source-sync bookkeeping
  return null; // unclassified ⇒ fail-closed
}

/**
 * Classify one corpus path (relative to its scope root). `'include'` / `'exclude'` are the two
 * live answers; `null` means the path matched neither list — the engine must **fail closed** on it
 * (refuse the run and surface the path), never silently skip or ship it. Config-supplied extra
 * absolute include paths bypass this classifier (they are opt-in by the user); everything under
 * `~/.cezar/` and `<root>/.ai/cezar/` goes through it.
 */
export function classify(scope: BackupScope, relPath: string): Classification | null {
  return scope === 'home' ? classifyHome(relPath) : classifyProject(relPath);
}
