import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The step loop's write path for the spec/review feed (`.ai/specs/2026-08-29-spec-tab-review-
 * feed.md`, P1 Verification items 8, 9, 10, 10c, 10d). Driven end to end on the bundled
 * `CEZ_DRY_RUN=1` mock (`scripts/mock-claude.mjs`), which this spec taught two new testability
 * triggers: `mock:spec-path[-declare]=`/`mock:spec-body=` and `mock:review[-check]=` — see that
 * file's own doc comments for exactly what each does and why `mock:review-check` exists (a
 * stateless mock process re-entered on a loop-back has no counter of its own; it reads the real
 * file the `spec` step just wrote instead).
 *
 * `appendSpecReviewEntry` is mocked with `vi.fn(actual)` — calls through to the real
 * implementation by default, so tests 8/9/10 exercise the genuine write path; 10c/10d override ONE
 * call with a throwing implementation to prove the surrounding run is fail-open.
 */
vi.mock('../runs/spec-review-log.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runs/spec-review-log.ts')>();
  return { ...actual, appendSpecReviewEntry: vi.fn(actual.appendSpecReviewEntry) };
});

const { appendSpecReviewEntry, readSpecReviewEntries, specReviewLogPath } = await import('../runs/spec-review-log.ts');
const { RunStore } = await import('../runs/store.ts');
const { RunManager } = await import('./run.ts');
const { localCliAuthor } = await import('../runs/task-author.ts');
type WorkflowDef = import('./types.ts').WorkflowDef;

const runGit = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const SPEC_PATH = '.ai/specs/x.md';

/** `reviewExpects` is what `mock:review-check` looks for in the real file on disk — set to
 *  revision 1's own body to make the FIRST review pass immediately (test 9), or to revision 2's
 *  body to force one `revise` loop-back first (test 8). */
function twoStepChain(reviewExpects: 'REVISION_1_TEXT' | 'REVISION_2_TEXT'): WorkflowDef {
  return {
    name: 'spec-review-probe',
    source: 'built-in',
    steps: [
      {
        id: 'spec',
        name: 'spec',
        prompt: `mock:spec-path=${SPEC_PATH} mock:spec-body=REVISION_1_TEXT write the spec`,
      },
      {
        id: 'review-spec',
        name: 'review-spec',
        prompt: `mock:review-check=${SPEC_PATH}=${reviewExpects} review the draft`,
        onFail: { retry: 'spec', max: 2 },
      },
      { id: 'implement', name: 'implement', prompt: 'mock:done implement it' },
    ],
  };
}

let realAppendSpecReviewEntry: typeof appendSpecReviewEntry;

describe('the spec/review feed is recorded end to end (spec 2026-08-29-spec-tab-review-feed, P1)', () => {
  let repoRoot: string;
  let store: ReturnType<typeof RunStore.open>;
  let manager: InstanceType<typeof RunManager>;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    const actual = await vi.importActual<typeof import('../runs/spec-review-log.ts')>('../runs/spec-review-log.ts');
    realAppendSpecReviewEntry = actual.appendSpecReviewEntry;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const setUp = async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-specreview-e2e-'));
    await runGit('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await runGit('git', ['add', '-A'], { cwd: repoRoot });
    await runGit('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  };

  const tearDown = () => {
    manager?.dispose();
    store?.flush();
    vi.mocked(appendSpecReviewEntry).mockImplementation(realAppendSpecReviewEntry);
    if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
  };

  const waitForTerminal = async (id: string, ms = 20_000) => {
    const deadline = Date.now() + ms;
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    while (!terminal.has(store.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not reach a terminal status in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const dataDir = () => join(repoRoot, '.ai/cezar');

  it('8. records spec(v1) -> review(revise) -> spec(v2) -> review(pass), with entry 1 unchanged after the real file is overwritten', async () => {
    await setUp();
    try {
      const record = manager.startRun(twoStepChain('REVISION_2_TEXT'), {
        author: localCliAuthor(),
        task: 'do the thing',
        worktree: false,
      });
      await waitForTerminal(record.id);

      expect(store.getRun(record.id)?.status).toBe('done');
      const entries = readSpecReviewEntries(dataDir(), record.id);
      expect(entries.map((e) => e.kind)).toEqual(['spec', 'review', 'spec', 'review']);

      const [spec1, review1, spec2, review2] = entries;
      expect(spec1).toMatchObject({ kind: 'spec', revision: 1, source: 'recorded', stepId: 'spec' });
      expect(review1).toMatchObject({ kind: 'review', revision: 1, actor: 'agent', verdict: 'revise', stepId: 'review-spec' });
      expect(spec2).toMatchObject({ kind: 'spec', revision: 2, source: 'recorded', stepId: 'spec' });
      expect(review2).toMatchObject({ kind: 'review', revision: 2, actor: 'agent', verdict: 'pass', stepId: 'review-spec' });

      if (spec1?.kind !== 'spec' || spec2?.kind !== 'spec') throw new Error('unreachable');
      expect(spec1.text).toContain('REVISION_1_TEXT');
      expect(spec2.text).toContain('REVISION_2_TEXT');
      // The real file was overwritten by the second attempt — the whole point of the feature is
      // that entry 1 still holds v1's text even though the file on disk no longer does.
      const onDisk = readFileSync(join(repoRoot, SPEC_PATH), 'utf8');
      expect(onDisk).toContain('REVISION_2_TEXT');
      expect(onDisk).not.toContain('REVISION_1_TEXT');
      expect(spec1.text).not.toBe(spec2.text);

      expect(store.getRun(record.id)?.specReview).toEqual({ revisions: 2, reviews: 2, latestVerdict: 'pass' });
    } finally {
      tearDown();
    }
  }, 30_000);

  it('9. a clean first-time pass records exactly spec -> review(pass)', async () => {
    await setUp();
    try {
      const record = manager.startRun(twoStepChain('REVISION_1_TEXT'), {
        author: localCliAuthor(),
        task: 'do the thing',
        worktree: false,
      });
      await waitForTerminal(record.id);

      expect(store.getRun(record.id)?.status).toBe('done');
      const entries = readSpecReviewEntries(dataDir(), record.id);
      expect(entries.map((e) => e.kind)).toEqual(['spec', 'review']);
      expect(entries[1]).toMatchObject({ verdict: 'pass' });
      expect(store.getRun(record.id)?.specReview).toEqual({ revisions: 1, reviews: 1, latestVerdict: 'pass' });
    } finally {
      tearDown();
    }
  }, 30_000);

  it('10. a declared path that never resolves records one entry with missing:true, no text, and the run still reaches done', async () => {
    await setUp();
    try {
      const singleStep: WorkflowDef = {
        name: 'spec-missing-probe',
        source: 'built-in',
        steps: [
          {
            id: 'spec',
            name: 'spec',
            prompt: `mock:spec-path-declare=${SPEC_PATH} mock:done — never actually write the file`,
          },
        ],
      };
      const record = manager.startRun(singleStep, { author: localCliAuthor(), task: 'do the thing', worktree: false });
      await waitForTerminal(record.id);

      expect(store.getRun(record.id)?.status).toBe('done');
      const entries = readSpecReviewEntries(dataDir(), record.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'spec', missing: true });
      if (entries[0]?.kind !== 'spec') throw new Error('unreachable');
      expect(entries[0].text).toBeUndefined();
    } finally {
      tearDown();
    }
  }, 30_000);

  it('10c. fail-open: the spec-snapshot append throws — the run finishes identically to an uninjected control, with a redacted note and no path/message leaked', async () => {
    await setUp();
    try {
      const controlRecord = manager.startRun(twoStepChain('REVISION_2_TEXT'), {
        author: localCliAuthor(),
        task: 'do the thing',
        worktree: false,
      });
      await waitForTerminal(controlRecord.id);
      const control = store.getRun(controlRecord.id);

      vi.mocked(appendSpecReviewEntry).mockImplementationOnce(() => {
        throw Object.assign(new Error('no space left on device: /secret/path/leaked'), { code: 'ENOSPC' });
      });
      const injectedRecord = manager.startRun(twoStepChain('REVISION_2_TEXT'), {
        author: localCliAuthor(),
        task: 'do the thing',
        worktree: false,
      });
      await waitForTerminal(injectedRecord.id);
      const injected = store.getRun(injectedRecord.id);

      // Same verdict/shape as the control run — the injected failure never changed the outcome:
      // same terminal status, same per-step status, and the SAME number of `spec` attempts (the
      // loop-back still fired exactly once).
      expect(injected?.status).toBe(control?.status);
      expect(injected?.steps.map((s) => s.status)).toEqual(control?.steps.map((s) => s.status));
      expect(injected?.steps.find((s) => s.id === 'spec')?.iterations).toBe(
        control?.steps.find((s) => s.id === 'spec')?.iterations,
      );

      const notes = store.readEvents(injectedRecord.id).filter((e) => e.type === 'note');
      const failureNote = notes.find((n) => String(n.message).includes('spec-review log unavailable'));
      expect(failureNote?.message).toBe('spec-review log unavailable (ENOSPC)');
      // Never the message, never the path — both can carry file text or host layout.
      expect(String(failureNote?.message)).not.toContain('/secret/path/leaked');
      expect(String(failureNote?.message)).not.toContain(SPEC_PATH);

      // The one injected attempt produced no entry; the rest of the loop (review, spec v2,
      // review v2) still wrote normally once the mock's implementation reverted.
      const entries = readSpecReviewEntries(dataDir(), injectedRecord.id);
      expect(entries.map((e) => e.kind)).toEqual(['review', 'spec', 'review']);
    } finally {
      tearDown();
    }
  }, 45_000);

  it('10d. fail-open: the agent-review append throws — revise still loops the chain back to spec, bounded by onFail.max', async () => {
    await setUp();
    try {
      const controlRecord = manager.startRun(twoStepChain('REVISION_2_TEXT'), {
        author: localCliAuthor(),
        task: 'do the thing',
        worktree: false,
      });
      await waitForTerminal(controlRecord.id);
      const control = store.getRun(controlRecord.id);

      let thrown = false;
      vi.mocked(appendSpecReviewEntry).mockImplementation((targetDataDir, runId, input) => {
        if (input.kind === 'review' && !thrown) {
          thrown = true;
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return realAppendSpecReviewEntry(targetDataDir, runId, input);
      });

      const record = manager.startRun(twoStepChain('REVISION_2_TEXT'), {
        author: localCliAuthor(),
        task: 'do the thing',
        worktree: false,
      });
      await waitForTerminal(record.id);

      // The loop-back still happened (revision 2 exists) and the run still finished 'done' — the
      // display feature's write failure never blocked the retry decision, which is driven purely
      // from `state.reviewVerdict`. Same shape as the control, same number of `spec` attempts.
      expect(store.getRun(record.id)?.status).toBe(control?.status);
      expect(store.getRun(record.id)?.steps.map((s) => s.status)).toEqual(control?.steps.map((s) => s.status));
      expect(store.getRun(record.id)?.steps.find((s) => s.id === 'spec')?.iterations).toBe(
        control?.steps.find((s) => s.id === 'spec')?.iterations,
      );
      const onDisk = readFileSync(join(repoRoot, SPEC_PATH), 'utf8');
      expect(onDisk).toContain('REVISION_2_TEXT');

      const notes = store.readEvents(record.id).filter((e) => e.type === 'note');
      expect(notes.some((n) => String(n.message) === 'spec-review log unavailable (ENOSPC)')).toBe(true);

      // The revise verdict's own entry is the one that was lost; the spec snapshots and the final
      // pass still made it onto the log.
      const entries = readSpecReviewEntries(dataDir(), record.id);
      expect(entries.map((e) => e.kind)).toEqual(['spec', 'spec', 'review']);
    } finally {
      tearDown();
    }
  }, 45_000);
});

/**
 * P1 Verification item 10b: a hostile `CEZ:SPEC_PATH` declaration persists no host-file content.
 * Calls `recordSpecSnapshot` directly (the same private-method-harness pattern `run.test.ts`'s
 * `AttestationHarness` uses) rather than driving a whole mock-CLI run — the thing under test is
 * `readWorktreePath`'s containment check reaching the log writer correctly, which needs no agent
 * turn at all, only a real `state.cwd` with real hostile fixtures on disk.
 */
describe('10b. a hostile CEZ:SPEC_PATH declaration persists no host-file content', () => {
  let repoRoot: string;
  let store: ReturnType<typeof RunStore.open>;
  let manager: InstanceType<typeof RunManager>;
  let outside: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-specreview-hostile-'));
    outside = mkdtempSync(join(tmpdir(), 'cez-specreview-hostile-outside-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const harness = () =>
    manager as unknown as {
      recordSpecSnapshot(runId: string, state: { cwd: string; stepSpecPath?: string }, stepId: string): Promise<void>;
    };

  const dataDir = () => join(repoRoot, '.ai/cezar');

  const runFixture = () =>
    store.createRun({ author: localCliAuthor(), title: 't', workflow: 'w', task: 'task', steps: [] });

  /** Runs the snapshot against `hostilePath`, then asserts the ONE thing every hostile case must
   *  produce: one `missing`/`rejected` entry with no `text`, and — on the RAW file bytes, not the
   *  parsed object — that none of `secretContent` reached the log. */
  async function expectRefused(hostilePath: string, secretContent: string) {
    const run = runFixture();
    const state = { cwd: repoRoot, stepSpecPath: hostilePath };
    await harness().recordSpecSnapshot(run.id, state, 'spec');

    expect(state.stepSpecPath).toBeUndefined(); // spent regardless of outcome

    const entries = readSpecReviewEntries(dataDir(), run.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'spec', missing: true, rejected: true });
    if (entries[0]?.kind !== 'spec') throw new Error('unreachable');
    expect(entries[0].text).toBeUndefined();

    const rawLogBytes = readFileSync(specReviewLogPath(dataDir(), run.id), 'utf8');
    if (secretContent.length > 0) expect(rawLogBytes).not.toContain(secretContent);
  }

  it('a dot-segment traversal (../../etc/passwd) is refused', async () => {
    const secret = existsSync('/etc/passwd') ? readFileSync('/etc/passwd', 'utf8') : '';
    // Two levels up from a single-segment mkdtemp dir resolves to the real filesystem root, the
    // same convention `open-in-file.test.ts` uses for this exact traversal case.
    await expectRefused('../../etc/passwd', secret);
  });

  it('an absolute path outside the worktree (/etc/passwd) is refused', async () => {
    const secret = existsSync('/etc/passwd') ? readFileSync('/etc/passwd', 'utf8') : '';
    await expectRefused('/etc/passwd', secret);
  });

  it('.git internals (.git/config) are refused', async () => {
    mkdirSync(join(repoRoot, '.git'), { recursive: true });
    writeFileSync(join(repoRoot, '.git', 'config'), '[core]\n\tSECRET_MARKER_GIT_CONFIG = true\n');
    await expectRefused('.git/config', 'SECRET_MARKER_GIT_CONFIG');
  });

  it('a final path component that is a symlink to a file outside the worktree is refused', async () => {
    writeFileSync(join(outside, 'real.md'), 'SECRET_MARKER_SYMLINK_FILE\n');
    symlinkSync(join(outside, 'real.md'), join(repoRoot, 'link.md'));
    await expectRefused('link.md', 'SECRET_MARKER_SYMLINK_FILE');
  });

  it('a path through an intermediate symlinked directory is refused (#blocker-symlink-traversal)', async () => {
    writeFileSync(join(outside, 'secret.txt'), 'SECRET_MARKER_SYMLINK_DIR\n');
    symlinkSync(outside, join(repoRoot, 'linked-dir'));
    await expectRefused('linked-dir/secret.txt', 'SECRET_MARKER_SYMLINK_DIR');
  });
});
