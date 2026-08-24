import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * STEP POST-CONDITIONS (`.ai/specs/2026-08-20-steps-green-only-when-verified.md`).
 *
 * A step's status has to be a claim about the WORLD, not about the agent. Before this module the
 * step loop settled `done` whenever the runner reported no error, so an agent that ran, said
 * nothing useful and exited 0 was indistinguishable from one that did the job. Two observed
 * false greens this exists to make impossible:
 *
 *  - run `23221162` — `commit-push` reported `status=done` leaving 7 modified and 5 untracked
 *    files and no commit at all;
 *  - a cezar deploy is TWO services (the UI tree and the backend service), and shipping either
 *    one alone ended the step green — "delivery is not activation".
 *
 * Each built-in answers ONE question with a sentence, not an exit code, so the verdict can name
 * the files or the target that failed. They are pure functions of a directory, which is what
 * makes them testable against a real `mkdtemp` git repo instead of through a bash string.
 *
 * Every helper here DEGRADES rather than throws: a post-condition that explodes would fail a step
 * for a reason that has nothing to do with the step.
 */

/** How long one deploy probe may run before it counts as a failure (R4: a hanging health check
 *  must fail the deploy, never hang the run). */
export const PROBE_TIMEOUT_MS = 60_000;

/** Per-probe output kept for the verdict; matches `run.ts`'s own check-output cap in spirit. */
const PROBE_OUTPUT_CAP = 4_000;

/** How many offending paths a verdict names before it summarizes the rest. */
const NAMED_FILES_CAP = 20;

export interface PostconditionResult {
  ok: boolean;
  /** The verdict, in a sentence. Stored as the step's `error` when red and shown in the
   *  cockpit's check card either way, so it has to read as an explanation on its own. */
  detail: string;
  handoff?: {
    kind: 'manual-deploy' | 'manual-merge';
    reason: string;
    targets?: string[];
  };
  retryMax?: number;
}

/** The built-ins a workflow step can name in `verify.builtin`. */
export const POSTCONDITION_IDS = [
  'everything-committed',
  'all-services-deployed',
  'tested-revision-shipped',
  'merged-into-base',
] as const;
export type PostconditionId = (typeof POSTCONDITION_IDS)[number];

export interface PostconditionContext {
  /** Where the step ran — the task worktree, or the repo root. */
  cwd: string;
  /**
   * A WORKSPACE run. Its per-project worktrees are applied back to the real checkouts
   * **unstaged, on purpose** (`workspace/workspace-worktrees.ts` — `applyOne` diffs the worktree
   * into the real root so the user's in-progress edits survive), and its agents are told not to
   * commit. So a workspace run is SUPPOSED to leave nothing committed, and asserting the
   * opposite would fail every one of them (R3).
   */
  workspaceRun?: boolean;
  /** Per-probe bound. Defaults to `PROBE_TIMEOUT_MS`; injectable so the timeout behaviour can be
   *  tested in milliseconds instead of by waiting a minute. */
  probeTimeoutMs?: number;
  /**
   * A DRY RUN (`CEZ_DRY_RUN=1`). Defaults to reading the environment; injectable so both branches
   * are testable without mutating `process.env`. See `dryRunVerdict` for why it passes.
   */
  dryRun?: boolean;
  /** Step identity and test attestation used by the shipping gates. */
  stepId?: string;
  attestation?: {
    stepId: string;
    treeSha: string;
    headSha?: string;
    shippedSha?: string;
    at: string;
  };
  /** Whether the merge stage is allowed to land a protected base automatically. */
  autoMerge?: boolean;
  /** Resolved base branch for merge postconditions. */
  baseBranch?: string;
}

/**
 * Under `CEZ_DRY_RUN=1` every agent CLI is replaced by its bundled mock, which emits a scripted
 * transcript and performs no real work: it never commits and it never deploys. Asking
 * "did the agent really commit / really deploy?" of a mock therefore asks a question the mode is
 * defined to answer no to, and a post-condition that can only ever be red makes a dry run
 * structurally unable to finish — which is what it did between `57fc8807` (the commit that
 * introduced `verify`) and this fix: `npm run test:package`'s `run mock:done` died at
 * `commit-push`, and so did every `npm run test:e2e` boot, both of which run with `CEZ_DRY_RUN=1`.
 *
 * Passing here is the same call the rest of the codebase already makes for the same reason — dry
 * run simulates the push, the PR and the `gh` availability probe rather than performing them
 * (`server/forge/github.ts`). The post-condition LOGIC keeps its real coverage in
 * `postconditions.test.ts`, which drives these built-ins against real `mkdtemp` git repos and real
 * probes, so nothing this module exists to catch is weakened outside dry run.
 */
function dryRunVerdict(id: string): PostconditionResult {
  return {
    ok: true,
    detail: `dry run (CEZ_DRY_RUN=1) — the agent is a mock that performs no real work, so "${id}" is simulated, not verified`,
  };
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git, never throw — degradation is the caller's policy (mirrors `git-worktree.ts`). */
function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

/** `n file(s)`, with the plural right — these verdicts are read by a human under time pressure. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function nameThem(paths: string[]): string {
  const shown = paths.slice(0, NAMED_FILES_CAP);
  const rest = paths.length - shown.length;
  return shown.map((p) => `  ${p}`).join('\n') + (rest > 0 ? `\n  … and ${plural(rest, 'more')}` : '');
}

/**
 * "Is everything this step was supposed to commit actually committed — and, where a remote is
 * reachable, pushed?"
 *
 * Green is scoped generously wherever the step's OWN prompt permits the weaker outcome. The
 * `commit-push` prompt says, verbatim, that when pushing is not possible ("no remote, protected
 * branch, no credentials") the step should commit locally and report it — so a clean tree with no
 * upstream is a success, and only an upstream that EXISTS and is behind is a false green.
 */
export async function everythingCommitted(ctx: PostconditionContext): Promise<PostconditionResult> {
  if (ctx.workspaceRun) {
    return {
      ok: true,
      detail:
        'workspace run — its per-project worktrees are applied back to the real checkouts UNSTAGED by design, so this run commits nothing itself',
    };
  }

  const inside = await git(ctx.cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ok: true, detail: `${ctx.cwd} is not a git working tree — there was nothing to commit` };
  }

  const status = await git(ctx.cwd, ['status', '--porcelain']);
  if (!status.ok) {
    return { ok: false, detail: `\`git status\` failed: ${status.stderr.trim() || 'unknown error'}` };
  }
  // `--porcelain` already honours .gitignore, so this is the real "unfinished work" set —
  // modified AND untracked, which is exactly what run 23221162 left behind.
  const dirty = status.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (dirty.length > 0) {
    return {
      ok: false,
      detail: `${plural(dirty.length, 'file')} still uncommitted — the step's job was to commit everything:\n${nameThem(dirty)}`,
    };
  }

  const head = await git(ctx.cwd, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    return { ok: false, detail: 'the repository has no commit on HEAD — nothing was ever committed' };
  }
  const sha = head.stdout.trim().slice(0, 8);

  const upstream = await git(ctx.cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) {
    return {
      ok: true,
      detail: `working tree clean at ${sha}; no upstream is configured for this branch, so the commits are local only`,
    };
  }
  const tracking = upstream.stdout.trim();

  const ahead = await git(ctx.cwd, ['rev-list', '--count', `${tracking}..HEAD`]);
  const unpushed = Number(ahead.stdout.trim());
  if (ahead.ok && Number.isFinite(unpushed) && unpushed > 0) {
    return {
      ok: false,
      detail: `working tree is clean, but ${plural(unpushed, 'commit')} on HEAD (${sha}) ${unpushed === 1 ? 'is' : 'are'} not pushed to ${tracking}`,
    };
  }

  return { ok: true, detail: `working tree clean and in sync with ${tracking} at ${sha}` };
}

/**
 * Repo-relative home of a project's declaration of what "deployed" means for it.
 *
 * `.ai/`, NOT `.ai/cezar/`: that directory is gitignored local runtime state (runs, worktrees,
 * launch key), so a targets file there would never be committed AND would not exist inside the
 * task worktree the deploy step actually runs in — the probe would fail for the wrong reason.
 * This is repo content: every checkout needs the same answer.
 */
export const DEPLOY_TARGETS_FILE = '.ai/deploy-targets.json';

/**
 * One deployable service and the shell command that proves it is live. `probe` runs in the step's
 * cwd; exit 0 is the only pass.
 */
export const deployTargetsSchema = z.object({
  targets: z.array(
    z.object({
      name: z.string().min(1),
      probe: z.string().min(1),
      manual: z.boolean().optional(),
      manualReason: z.string().min(1).max(2_000).optional(),
    }),
  ),
});
export type DeployTargets = z.infer<typeof deployTargetsSchema>;

const HEX_REF = /^[0-9a-f]{7,40}$/i;

/** Resolve the branch a merge stage targets without ever switching branches. */
export async function deriveBaseBranch(
  cwd: string,
  runBaseBranch?: string,
  configBaseBranch?: string,
): Promise<string> {
  for (const candidate of [runBaseBranch, configBaseBranch]) {
    const normalized = candidate?.trim().replace(/^origin\//, '');
    if (normalized && !HEX_REF.test(normalized)) return normalized;
  }
  const remoteHead = await git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  const match = remoteHead.stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
  return match?.[1] ?? 'main';
}

interface ProbeOutcome {
  ok: boolean;
  output: string;
}

/** Run one probe under a hard timeout. Never throws; a spawn failure is a failed probe. */
function runProbe(cwd: string, command: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd, env: process.env });
    let output = '';
    let settled = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, output: `${output.trim()}\n(timed out after ${Math.round(timeoutMs / 1000)}s)`.trim() });
    }, timeoutMs);
    timer.unref?.();

    const collect = (chunk: Buffer) => {
      if (output.length < PROBE_OUTPUT_CAP) {
        output += chunk.toString('utf8');
        if (output.length >= PROBE_OUTPUT_CAP) output += '\n… (output truncated)';
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => finish({ ok: false, output: `failed to spawn: ${err.message}` }));
    child.on('close', (code) => finish({ ok: code === 0, output: output.trim() || '(no output)' }));
  });
}

/**
 * "Were ALL of this repo's services deployed?" — the literal ask. Every declared probe must pass;
 * one green service and one red one is a red deploy, and the verdict names which.
 *
 * A MISSING `deploy-targets.json` is RED (R2, the load-bearing judgement call in the spec):
 * "nobody ever declared what this repo deploys" is not evidence of a successful deploy, and it is
 * precisely the silence that let a half-deploy read as a whole one. A repo that genuinely does not
 * deploy says so explicitly with `{"targets": []}` — an empty list is a statement, an absent file
 * is not.
 */
export async function allServicesDeployed(ctx: PostconditionContext): Promise<PostconditionResult> {
  if (ctx.workspaceRun) {
    // Consistent with `everythingCommitted`, and for the same structural reason: a workspace run
    // commits NOTHING — its per-project worktrees are applied back to the real checkouts unstaged
    // after the run ends — so there is no commit to deploy and deploying is not part of its
    // contract. Failing it would fail every workspace run's last step on principle.
    return {
      ok: true,
      detail:
        'workspace run — it commits nothing (its worktrees apply back unstaged after the run), so there is nothing deployed and nothing to deploy',
    };
  }

  const path = join(ctx.cwd, DEPLOY_TARGETS_FILE);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {
      ok: false,
      detail:
        `this repo does not declare what it deploys, so the deploy cannot be verified — and an unverified deploy is not a green one.\n` +
        `Create ${DEPLOY_TARGETS_FILE} naming every service and a shell probe that proves it is live:\n` +
        `  {"targets": [{"name": "api", "probe": "curl -fsS http://127.0.0.1:8080/health"}]}\n` +
        `If this repo genuinely does not deploy, say so explicitly with {"targets": []}.`,
    };
  }

  let parsed: DeployTargets;
  try {
    parsed = deployTargetsSchema.parse(JSON.parse(raw));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${DEPLOY_TARGETS_FILE} could not be read as a target list: ${message}` };
  }

  if (parsed.targets.length === 0) {
    return { ok: true, detail: `${DEPLOY_TARGETS_FILE} declares no deploy targets — this repo does not deploy` };
  }

  // Sequential on purpose: a handful of probes, and a deterministic report order is worth more
  // here than the wall-clock a parallel fan-out would save.
  const lines: string[] = [];
  const failed: string[] = [];
  // The card (handoff.reason) needs each manual target's own probe OUTPUT, not just its name:
  // that text is otherwise folded into `lines` (source included) and discarded. Carry the target
  // object itself, not its name: `deployTargetsSchema` has no uniqueness constraint on `name`, so
  // a name-keyed lookup can cross-render one target's reason onto another's.
  type ManualFailure = { target: DeployTargets['targets'][number]; outcome: ProbeOutcome };
  const manualFailed: ManualFailure[] = [];
  for (const target of parsed.targets) {
    const outcome = await runProbe(ctx.cwd, target.probe, ctx.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
    lines.push(`${outcome.ok ? 'OK  ' : 'FAIL'} ${target.name} — \`${target.probe}\`${outcome.ok ? '' : `\n${outcome.output}`}`);
    if (!outcome.ok) {
      if (target.manual) manualFailed.push({ target, outcome });
      else failed.push(target.name);
    }
  }

  if (failed.length > 0) {
    return {
      ok: false,
      detail: `${failed.length} of ${parsed.targets.length} service(s) are NOT deployed: ${failed.join(', ')}\n${lines.join('\n')}`,
    };
  }
  if (manualFailed.length > 0) {
    const names = manualFailed.map(({ target }) => target.name);
    const detail = `manual deployment required for ${names.join(', ')}; ${lines.join('\n')}`;
    // Unlike `detail`, `reason` is what the handoff card renders: no probe SOURCE, and no target
    // that PASSED. Only the failing manual targets' own name, manualReason and probe OUTPUT.
    const reason = `manual deployment required for ${names.join(', ')}:\n${manualFailed
      .map(({ target, outcome }) => `${target.name}${target.manualReason ? `: ${target.manualReason}` : ''}\n${outcome.output}`)
      .join('\n\n')}`;
    return {
      ok: false,
      detail,
      handoff: { kind: 'manual-deploy', reason, targets: names },
    };
  }
  return { ok: true, detail: `all ${plural(parsed.targets.length, 'service')} deployed:\n${lines.join('\n')}` };
}

const SHIPPED_PATH_PREFIXES = ['.ai/specs/', '.ai/cezar/knowledge/', 'docs/', 'CHANGELOG.md'];

function pathIsShippingRecord(path: string): boolean {
  return SHIPPED_PATH_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix,
  );
}

/** Verify that the tests attested the revision the shipping step is acting on. */
export async function testedRevisionShipped(ctx: PostconditionContext): Promise<PostconditionResult> {
  const attestation = ctx.attestation;
  if (!attestation) return { ok: true, detail: 'no test attestation was recorded, so no earlier revision can be contradicted' };
  if (!attestation.treeSha) return { ok: false, detail: 'the test attestation has no tree SHA' };

  if (ctx.stepId === 'merge') {
    const shippedSha = attestation.shippedSha;
    if (!shippedSha) return { ok: true, detail: 'the commit stage did not record a shipped SHA, so merge verification is local-only' };
    const head = await git(ctx.cwd, ['rev-parse', 'HEAD']);
    if (!head.ok) return { ok: false, detail: `cannot resolve HEAD while checking shipped revision: ${head.stderr.trim()}` };
    const inHead = await git(ctx.cwd, ['merge-base', '--is-ancestor', shippedSha, 'HEAD']);
    if (!inHead.ok) {
      return { ok: false, detail: `shipped revision ${shippedSha} is not an ancestor of current HEAD ${head.stdout.trim()}` };
    }
    const base = ctx.baseBranch ?? 'main';
    const remote = await git(ctx.cwd, ['rev-parse', '--verify', `refs/remotes/origin/${base}`]);
    if (!remote.ok) return { ok: true, detail: `origin/${base} is unavailable, so the shipped revision is verified locally` };
    const remoteRef = `origin/${base}`;
    const onRemoteBase = await git(ctx.cwd, ['merge-base', '--is-ancestor', shippedSha, remoteRef]);
    if (onRemoteBase.ok) return { ok: true, detail: `shipped revision ${shippedSha} is an ancestor of ${remoteRef}` };
    const anchor = attestation.headSha ?? shippedSha;
    const count = await git(ctx.cwd, ['rev-list', '--count', `${anchor}..${remoteRef}`]);
    return {
      ok: false,
      detail: `base ${remoteRef} moved by ${count.ok ? count.stdout.trim() : 'an unknown number of'} commit(s) since the tested revision; re-run the tests on the merged tree`,
      retryMax: 1,
    };
  }

  const tree = await git(ctx.cwd, ['cat-file', '-e', `${attestation.treeSha}^{tree}`]);
  if (!tree.ok) return { ok: false, detail: `test attestation tree ${attestation.treeSha} cannot be resolved` };
  const headTree = await git(ctx.cwd, ['rev-parse', 'HEAD^{tree}']);
  if (!headTree.ok) return { ok: false, detail: `cannot resolve HEAD tree: ${headTree.stderr.trim()}` };
  const changed = await git(ctx.cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', attestation.treeSha, headTree.stdout.trim()]);
  if (!changed.ok) return { ok: false, detail: `could not compare the tested tree with HEAD: ${changed.stderr.trim()}` };
  const paths = changed.stdout.split('\n').map((path) => path.trim()).filter(Boolean);
  const outside = paths.filter((path) => !pathIsShippingRecord(path));
  if (outside.length > 0) {
    return { ok: false, detail: `HEAD changed outside the tested revision in ${outside.join(', ')}` };
  }
  return { ok: true, detail: `HEAD preserves the tested tree; only record paths changed after the test attestation` };
}

/** Verify that the current revision has landed on the configured base when auto-merge is on. */
export async function mergedIntoBase(ctx: PostconditionContext): Promise<PostconditionResult> {
  if (!ctx.autoMerge) return { ok: true, detail: 'automatic merge is disabled, so manual landing remains allowed' };
  const base = ctx.baseBranch ?? 'main';
  const remote = await git(ctx.cwd, ['rev-parse', '--verify', `refs/remotes/origin/${base}`]);
  if (!remote.ok) return { ok: true, detail: `origin/${base} is unavailable, so merge verification is local-only` };
  const ancestor = await git(ctx.cwd, ['merge-base', '--is-ancestor', 'HEAD', `origin/${base}`]);
  if (ancestor.ok) return { ok: true, detail: `HEAD is merged into origin/${base}` };
  const reason = `manual merge required: HEAD is not merged into origin/${base}`;
  return { ok: false, detail: reason, handoff: { kind: 'manual-merge', reason } };
}

const BUILTINS: Record<PostconditionId, (ctx: PostconditionContext) => Promise<PostconditionResult>> = {
  'everything-committed': everythingCommitted,
  'all-services-deployed': allServicesDeployed,
  'tested-revision-shipped': testedRevisionShipped,
  'merged-into-base': mergedIntoBase,
};

/**
 * Evaluate a named built-in. An unknown id is RED rather than ignored: a workflow that names a
 * post-condition cezar cannot evaluate has not been verified, and silently passing it would
 * recreate the very false green this module exists to remove.
 */
export async function evaluatePostcondition(
  id: string,
  ctx: PostconditionContext,
): Promise<PostconditionResult> {
  const builtin = BUILTINS[id as PostconditionId];
  if (!builtin) {
    return { ok: false, detail: `unknown post-condition "${id}" — cannot verify this step` };
  }
  // AFTER the unknown-id check on purpose: a typo in a workflow definition is a fact about the
  // WORKFLOW, not about the world, so a dry run — the cheapest way to exercise a workflow end to
  // end — must still catch it. Only the world-observing part is skipped.
  if (ctx.dryRun ?? process.env.CEZ_DRY_RUN === '1') return dryRunVerdict(id);
  try {
    return await builtin(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `post-condition "${id}" could not be evaluated: ${message}` };
  }
}
