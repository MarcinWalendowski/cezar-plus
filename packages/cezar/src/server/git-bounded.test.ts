import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getStatus } from './git.ts';

/**
 * The bound on `git.ts#git` exists for a child that does NOT die on the signal `execFile`'s own
 * `timeout` sends. That distinction is the whole point, so the fixture has to be genuinely
 * SIGTERM-deaf: a shim named `git`, earlier on PATH, that traps TERM and sleeps well past any
 * deadline here. `execFile('git', ...)` resolves the binary through PATH, so this exercises the real
 * production path rather than a mock of it.
 *
 * The load-bearing assertion is the MESSAGE, not the rejection. A rejection alone cannot tell
 * "execFile's timeout rejected us" from "we hit our own deadline and abandoned the child" — those
 * are different code paths and only the second is the fix. `execFile`'s own error says nothing about
 * being abandoned, so matching /abandoned/ is what separates them.
 */
describe('git.ts is bounded even when git ignores SIGTERM', () => {
  let shimDir: string;
  let workDir: string;
  let realPath: string | undefined;
  let realTimeout: string | undefined;

  beforeEach(() => {
    shimDir = mkdtempSync(join(tmpdir(), 'cez-git-shim-'));
    workDir = mkdtempSync(join(tmpdir(), 'cez-git-work-'));
    realPath = process.env.PATH;
    realTimeout = process.env.CEZ_GIT_TIMEOUT_MS;
  });

  afterEach(() => {
    if (realPath === undefined) delete process.env.PATH;
    else process.env.PATH = realPath;
    if (realTimeout === undefined) delete process.env.CEZ_GIT_TIMEOUT_MS;
    else process.env.CEZ_GIT_TIMEOUT_MS = realTimeout;
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  function installShim(body: string): void {
    const shim = join(shimDir, 'git');
    writeFileSync(shim, `#!/bin/sh\n${body}\n`);
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;
  }

  it('abandons a SIGTERM-deaf git instead of waiting on it forever', async () => {
    installShim("trap '' TERM\nsleep 30");
    process.env.CEZ_GIT_TIMEOUT_MS = '300';

    const started = Date.now();
    const err = await getStatus(workDir).then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;

    // (1) It rejected rather than hanging. Without the bound this sits for the shim's full 30s.
    expect(err).toBeInstanceOf(Error);
    // (2) THE DISCRIMINATOR: it took the abandonment path, not execFile's own timeout rejection.
    expect((err as Error).message).toMatch(/abandoned/);
    // (3) It waited the grace before escalating — proof the SIGTERM step happened first rather than
    //     the call being rejected outright, which is the behaviour git needs to unwind its locks.
    expect(elapsed).toBeGreaterThanOrEqual(300);
    // (4) And it did NOT wait for the child. 30s is the shim's sleep; anything near it means the
    //     abandonment did not actually release the caller.
    expect(elapsed).toBeLessThan(8_000);
  }, 20_000);

  it('still returns the real answer when git behaves — the bound is not a blanket failure', async () => {
    // POSITIVE CONTROL. Without this, assertion (1) above passes for a `git.ts` that rejects
    // unconditionally, which is not a bound, it is an outage.
    installShim('echo " M some/file.ts"');
    process.env.CEZ_GIT_TIMEOUT_MS = '5000';

    await expect(getStatus(workDir)).resolves.toEqual([{ status: 'M', path: 'some/file.ts' }]);
  }, 20_000);

  it('a git that exits non-zero still rejects with ITS error, not the abandonment one', async () => {
    // Separates the two failure modes from the other side: an ordinary git failure must NOT be
    // reported as an abandonment, or the message stops being diagnostic.
    installShim('echo "fatal: not a git repository" >&2\nexit 128');
    process.env.CEZ_GIT_TIMEOUT_MS = '5000';

    const err = await getStatus(workDir).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/abandoned/);
  }, 20_000);
});
