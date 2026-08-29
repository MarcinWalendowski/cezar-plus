import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testedRevisionShipped } from './postconditions.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const git = async (cwd: string, args: string[]): Promise<void> => {
  await run('git', [...GIT_ID, ...args], { cwd });
};
const gitText = async (cwd: string, args: string[]): Promise<string> => {
  const result = await run('git', [...GIT_ID, ...args], { cwd });
  return result.stdout.trim();
};

/**
 * `tested-revision-shipped` must tell "the base moved under me" apart from "I edited code after
 * the tests ran". The two look identical in a tree diff and have OPPOSITE remedies.
 *
 * MEASURED on prod-host, run `872b396a` (2026-08-29). Six runs were landing on `main` at
 * once. `commit-push` merged `origin/main` — which is not optional when shipping onto a base that
 * is moving — and the gate read the 38 files the merge brought in as untested edits. It then spent
 * its one retry re-running `commit-push`, which recomputes the identical diff by construction, and
 * killed the run. The work was ALREADY on `origin/main` at that moment (`git log origin/main..HEAD`
 * empty), so the run died after succeeding, and its `merge`, `document` and `deploy` steps never
 * ran — which is why a feature sat on `main`, undeployed, looking to its owner like nothing had
 * happened.
 *
 * The fix does not weaken the gate: every case below is still `ok: false`, and the merged tree
 * still has to be tested before anything ships. What changes is WHICH step is asked to fix it.
 *
 * | Guard | Mutation that must turn it red |
 * |---|---|
 * | Base drift asks for a re-test | make `baseMovedUnderTest` always return `undefined` |
 * | Base drift spends no retry here | drop `retryMax: 0` from the drift verdict |
 * | Drift is still a FAILURE | return `ok: true` on the drift branch |
 * | A post-test edit is NOT drift | make `baseMovedUnderTest` always return a phrase |
 * | The asymmetry is the signal | delete the `wasAlreadyTested` early return |
 */
describe('tested-revision-shipped, when the base moves under a run that is shipping', () => {
  let origin: string;
  let work: string;

  beforeEach(async () => {
    origin = mkdtempSync(join(tmpdir(), 'cez-drift-origin-'));
    work = mkdtempSync(join(tmpdir(), 'cez-drift-work-'));
    await git(origin, ['init', '-b', 'main', '--bare']);

    const seed = mkdtempSync(join(tmpdir(), 'cez-drift-seed-'));
    try {
      await git(seed, ['init', '-b', 'main']);
      writeFileSync(join(seed, 'app.ts'), 'export const app = 1;\n');
      writeFileSync(join(seed, 'other.ts'), 'export const other = 1;\n');
      await git(seed, ['add', '.']);
      await git(seed, ['commit', '-m', 'seed']);
      await git(seed, ['remote', 'add', 'origin', origin]);
      await git(seed, ['push', 'origin', 'main']);
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }

    await git(work, ['clone', origin, '.']);
    await git(work, ['checkout', '-b', 'cez/task']);
  });

  afterEach(() => {
    rmSync(origin, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  /** Commit the run's own feature and attest it, exactly as `run-tests` does. */
  const attestHere = async (): Promise<{ stepId: string; treeSha: string; headSha: string; at: string }> => {
    writeFileSync(join(work, 'app.ts'), 'export const app = 2; // the feature\n');
    await git(work, ['add', '.']);
    await git(work, ['commit', '-m', 'feat: the feature']);
    return {
      stepId: 'run-tests',
      treeSha: await gitText(work, ['rev-parse', 'HEAD^{tree}']),
      headSha: await gitText(work, ['rev-parse', 'HEAD']),
      at: new Date().toISOString(),
    };
  };

  /** Another run lands on `main` while this one is mid-flight. */
  const advanceMain = async (marker: string): Promise<void> => {
    const other = mkdtempSync(join(tmpdir(), 'cez-drift-other-'));
    try {
      await git(other, ['clone', origin, '.']);
      writeFileSync(join(other, 'other.ts'), `export const other = 2; // ${marker}\n`);
      await git(other, ['add', '.']);
      await git(other, ['commit', '-m', `feat: another run's work (${marker})`]);
      await git(other, ['push', 'origin', 'main']);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  };

  const verdict = (attestation: { stepId: string; treeSha: string; headSha: string; at: string }) =>
    testedRevisionShipped({ cwd: work, stepId: 'commit-push', attestation, baseBranch: 'main' });

  it('asks for a re-test on the MERGED tree, and spends no retry on this step', async () => {
    const attestation = await attestHere();
    await advanceMain('a');
    await advanceMain('b');
    await git(work, ['fetch', 'origin']);
    await git(work, ['merge', '--no-edit', 'origin/main']);

    const result = await verdict(attestation);

    // Still a failure — the merged tree genuinely has not been tested.
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Re-run the tests on the MERGED tree');
    expect(result.detail).toContain('2 origin/main commits');
    // Re-entering `commit-push` recomputes the same diff by construction, so an attempt here is
    // arithmetically unable to pass. Without this the run burns an agent turn to learn nothing.
    expect(result.retryMax).toBe(0);
    // It must not read like tampering — that verdict sends a reader hunting for an edit that
    // nobody made.
    expect(result.detail).not.toContain('HEAD changed outside the tested revision');
  });

  it('still calls a genuine post-test edit what it is, and leaves the retry budget alone', async () => {
    const attestation = await attestHere();
    // No base movement at all. The agent simply changed a file after the suite ran.
    writeFileSync(join(work, 'other.ts'), 'export const other = 99; // untested edit\n');
    await git(work, ['add', '.']);
    await git(work, ['commit', '-m', 'chore: an edit the tests never saw']);

    const result = await verdict(attestation);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('HEAD changed outside the tested revision');
    expect(result.detail).toContain('other.ts');
    expect(result.detail).not.toContain('Re-run the tests on the MERGED tree');
    // Silent, so the workflow's own `max` still governs — re-running CAN fix this one.
    expect(result.retryMax).toBeUndefined();
  });

  it('reads an edit made after an ALREADY-merged base as an edit, not as drift', async () => {
    // The asymmetry is the entire signal: `origin/main` reachable from HEAD is not enough, because
    // it is also true of every run that merged BEFORE testing. Without the `wasAlreadyTested`
    // check, this case would be excused as drift and a real untested edit would ship on a re-test
    // that never questioned it.
    await attestHere();
    await advanceMain('a');
    await git(work, ['fetch', 'origin']);
    await git(work, ['merge', '--no-edit', 'origin/main']);
    // Tests run HERE — after the merge — so the attested revision already contains origin/main.
    const attestation = {
      stepId: 'run-tests',
      treeSha: await gitText(work, ['rev-parse', 'HEAD^{tree}']),
      headSha: await gitText(work, ['rev-parse', 'HEAD']),
      at: new Date().toISOString(),
    };
    writeFileSync(join(work, 'other.ts'), 'export const other = 99; // untested edit\n');
    await git(work, ['add', '.']);
    await git(work, ['commit', '-m', 'chore: an edit the tests never saw']);

    const result = await verdict(attestation);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('HEAD changed outside the tested revision');
    expect(result.detail).not.toContain('Re-run the tests on the MERGED tree');
  });

  it('leaves a record-only merge green rather than re-testing for a spec file', async () => {
    const attestation = await attestHere();
    const other = mkdtempSync(join(tmpdir(), 'cez-drift-doc-'));
    try {
      await git(other, ['clone', origin, '.']);
      await run('mkdir', ['-p', join(other, '.ai/specs')]);
      writeFileSync(join(other, '.ai/specs/note.md'), '# a record\n');
      await git(other, ['add', '.']);
      await git(other, ['commit', '-m', 'docs: a record-only change']);
      await git(other, ['push', 'origin', 'main']);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    await git(work, ['fetch', 'origin']);
    await git(work, ['merge', '--no-edit', 'origin/main']);

    await expect(verdict(attestation)).resolves.toMatchObject({ ok: true });
  });
});
