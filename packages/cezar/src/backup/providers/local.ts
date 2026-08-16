import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import type { BackupProvider, LocalProviderConfig } from '../provider-types.ts';

/**
 * The `local` backup provider (Phase 2) — a `BackupProvider` over a filesystem directory
 * (`LocalProviderConfig.path`), `node:fs`/`node:path` only (D7, no new runtime dependency). It is
 * both a real backend (a mounted/external drive) and the self-serve smoke test for the whole
 * engine, since it needs no credentials or signing.
 *
 * Every write goes through the same atomic tmp-sibling-then-rename idiom
 * `workspace/config.ts#atomicWriteJsonSync` already uses for cezar's own JSON stores: write to
 * `${dest}.tmp-<random hex>` beside the destination, then `rename` onto the final path. `rename`
 * within one filesystem is atomic, so a concurrent `get`/`head` always sees either the complete old
 * object or the complete new one — never a torn write, matching the engine's "off the hot path,
 * never a torn read" guarantee (spec Architecture).
 *
 * Keys are provider-relative and may contain `/`, which `put` turns into nested directories under
 * `path`. Reads (`get`/`head`) answer `null` for a missing key rather than throwing (the seam's
 * contract — "not there" is a normal, expected answer). `delete` is idempotent.
 */
export function createLocalBackupProvider(config: LocalProviderConfig): BackupProvider {
  const root = config.path;

  function resolve(key: string): string {
    return join(root, key);
  }

  return {
    kind: 'local',

    async put(key, bytes) {
      const dest = resolve(key);
      mkdirSync(dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp-${randomBytes(8).toString('hex')}`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, dest);
    },

    async get(key) {
      try {
        return readFileSync(resolve(key));
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    },

    async head(key) {
      try {
        const stats = statSync(resolve(key));
        return { size: stats.size };
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    },

    async list(prefix) {
      const keys: string[] = [];
      walk(resolve(prefix), root, keys);
      return keys;
    },

    async delete(key) {
      try {
        unlinkSync(resolve(key));
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
    },
  };
}

/**
 * Recursively collects every file under `dir` as a `root`-relative, POSIX-separated key —
 * relative to the provider root, never to `dir` itself, so `list('blobs')` returns
 * `'blobs/ab/cd'`, not `'ab/cd'`. A missing `dir` (nothing was ever written under this prefix) is
 * not an error: it contributes no keys, matching `list`'s "absent prefix ⇒ `[]`" contract.
 */
function walk(dir: string, root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, root, out);
    } else if (entry.isFile()) {
      out.push(relative(root, full).split(sep).join('/'));
    }
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
